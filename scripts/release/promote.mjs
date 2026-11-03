// `just release promote <version>`: points `:beta` (app and sandbox) at a release already published, from its
// GitHub manifest (a rollback, or a promotion that failed after publishing). The Komodo jobs verify the
// signatures again and run the current main's code. Never deploys: then Pull + Deploy in Komodo.
import { spawnSync } from 'node:child_process';
import { config, assertPublicationAllowed } from './config.mjs';
import { Komodo } from './komodo.mjs';
import { promoteArtifacts } from './artifacts.mjs';
import { assertVersion } from './version.mjs';

const run = (bin, args) => {
	const p = spawnSync(bin, args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
	if (p.status !== 0) throw new Error(`${bin} ${args.slice(0, 2).join(' ')} falló.`);
	return p.stdout.trim();
};

try {
	assertPublicationAllowed();
	const version = assertVersion(String(process.argv[2] ?? '').replace(/^v/, ''));
	const tag = `v${version}`;
	const manifest = JSON.parse(
		run('gh', [
			'release',
			'download',
			tag,
			'--repo',
			config.repository,
			'--pattern',
			'release-manifest.json',
			'--output',
			'-',
		]),
	);
	if (manifest.version !== version) throw new Error(`El manifiesto de ${tag} no es de esa versión.`);
	for (const c of ['agents-app', 'agents-sandbox', 'agents-proxy'])
		if (manifest.images?.[c] && manifest.images[c].verified !== true)
			throw new Error(`${tag}: ${c} no está verificado en su manifiesto.`);
	for (const c of ['agents-app', 'agents-sandbox'])
		if (!manifest.images?.[c]) throw new Error(`${tag}: su manifiesto no trae ${c}.`);
	const codeSha = run('git', ['ls-remote', 'origin', `refs/heads/${config.releaseBranch}`]).split(/\s/)[0];
	console.log(
		`:beta → ${tag} (${manifest.sha.slice(0, 7)}), con el código de ${config.releaseBranch} ${codeSha.slice(0, 7)}…`,
	);
	// Only the scoped API credential leaves 1Password, straight into memory.
	const item = JSON.parse(
		run('op', [
			'item',
			'get',
			config.komodo.credentialsItem,
			'--vault',
			config.komodo.credentialsVault,
			'--format=json',
		]),
	);
	const fields = Object.fromEntries(item.fields.map((f) => [f.label, f.value]));
	if (!fields.key || !fields.secret) throw new Error('Faltan key/secret de API Komodo en 1Password.');
	const client = new Komodo({ url: config.komodo.url, key: fields.key, secret: fields.secret });
	const promoted = await promoteArtifacts(client, manifest, codeSha);
	for (const p of Object.values(promoted)) console.log(`${p.tag} → ${p.digest}`);
	console.log('Listo. En Komodo, stack agents → Pull y Deploy para que producción lo use.');
} catch (err) {
	console.error(String(err.message ?? err));
	process.exit(1);
}
