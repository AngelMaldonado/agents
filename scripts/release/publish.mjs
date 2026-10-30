// Trusted release runner only. No deployment or migration is performed by this publisher.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import semanticRelease from 'semantic-release';
import { config, assertPublicationAllowed } from './config.mjs';
import { assertSha } from './version.mjs';
import { Komodo } from './komodo.mjs';
import { prepareArtifacts } from './artifacts.mjs';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assertPublicationAllowed();
if (git('branch', '--show-current') !== config.releaseBranch)
	throw new Error('Publicación sólo desde main; no se admite un checkout de trabajo.');
const sha = assertSha(git('rev-parse', 'HEAD'));
if (sha !== process.env.GITHUB_SHA) throw new Error('El runner no está en el SHA integrado que disparó el workflow.');
if (git('status', '--porcelain')) throw new Error('Checkout sucio: no se publica.');
if (!process.env.GITHUB_TOKEN) throw new Error('Falta GITHUB_TOKEN del workflow.');
const tag = `v${config.baseline}`;
const tags = git('tag', '--list', 'v*').split('\n').filter(Boolean);
if (tags.length === 0) {
	console.log(`Bootstrap controlado: ${tag} (${sha}). Primero build, firma y verificación; después tag/release.`);
	const client = new Komodo({
		url: config.komodo.url,
		key: process.env.AGENTS_RELEASE_KOMODO_KEY,
		secret: process.env.AGENTS_RELEASE_KOMODO_SECRET,
	});
	const manifest = await prepareArtifacts(client, config.baseline, sha);
	mkdirSync('.release', { recursive: true });
	writeFileSync('.release/release-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
	const api = async (path, body) => {
		const response = await fetch(`https://api.github.com/repos/${config.repository}/${path}`, {
			method: 'POST',
			signal: AbortSignal.timeout(30000),
			headers: {
				Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
				Accept: 'application/vnd.github+json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});
		if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}; revisa el estado antes de reintentar.`);
		return response.json();
	};
	// Bootstrap release metadata is written to git notes before creating the remote release.
	git('-c', 'user.name=agents-release', '-c', 'user.email=release@cuby.local', 'tag', '-a', tag, sha, '-m', tag);
	git(
		'-c',
		'user.name=agents-release',
		'-c',
		'user.email=release@cuby.local',
		'notes',
		'--ref=semantic-release',
		'add',
		'-m',
		'{"channels":["beta"]}',
		tag,
	);
	git('push', 'origin', tag, 'refs/notes/semantic-release');
	const release = await api('releases', {
		tag_name: tag,
		target_commitish: sha,
		name: tag,
		prerelease: true,
		generate_release_notes: true,
	});
	const upload = await fetch(`${release.upload_url.split('{')[0]}?name=release-manifest.json`, {
		method: 'POST',
		signal: AbortSignal.timeout(30000),
		headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(manifest),
	});
	if (!upload.ok)
		throw new Error(
			`Baseline publicado pero manifiesto no adjuntado: HTTP ${upload.status}. No repitas bootstrap sin revisar.`,
		);
} else {
	if (!tags.includes(tag))
		throw new Error(`Existe historial sin ${tag}. Requiere conciliación manual, no se inventa otro baseline.`);
	const published = git('rev-list', '-n', '1', tag);
	if (published === sha)
		throw new Error('Este SHA ya tiene baseline. Revisa la release existente en lugar de duplicarla.');
	const result = await semanticRelease();
	if (!result) console.log('Sin cambios publicables; no se crean tags ni artefactos.');
}
console.log('Publicación finalizada. Despliegue NO ejecutado: el corte queda para una autorización posterior.');
