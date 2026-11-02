// Operator-controlled temporary main checkout. Builds/signatures run only in Komodo; never deploys.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { config, assertPublicationAllowed } from './config.mjs';
import { assertSha, assertVersion, nextBeta, releasable } from './version.mjs';
import { Komodo } from './komodo.mjs';
import { prepareArtifacts } from './artifacts.mjs';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assertPublicationAllowed();
if (git('branch', '--show-current') !== config.releaseBranch)
	throw new Error('Publicación sólo desde main; no se admite un checkout de trabajo.');
const sha = assertSha(git('rev-parse', 'HEAD'));
if (process.env.AGENTS_RELEASE_APPROVED_SHA !== sha || process.env.GITHUB_SHA !== sha)
	throw new Error('Publicación requiere el SHA integrado y validado por just release.');
if (git('ls-remote', 'origin', `refs/heads/${config.releaseBranch}`).split(/\s/)[0] !== sha)
	throw new Error('main avanzó antes de publicar; vuelve a validar el commit actual.');
const status = git('status', '--porcelain');
if (status) throw new Error(`Checkout sucio: no se publica.\n${status}`);
if (!process.env.GITHUB_TOKEN) throw new Error('Falta GITHUB_TOKEN del workflow.');
// One way to publish, for the baseline and every beta after it: build, sign and verify in Komodo first,
// then the annotated tag, its channel note and the GitHub prerelease with the manifest.
async function publish(version) {
	const tag = `v${assertVersion(version)}`;
	const client = new Komodo({
		url: config.komodo.url,
		key: process.env.AGENTS_RELEASE_KOMODO_KEY,
		secret: process.env.AGENTS_RELEASE_KOMODO_SECRET,
	});
	const manifest = await prepareArtifacts(client, version, sha);
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
	git('-c', 'user.name=agents-release', '-c', 'user.email=release@cuby.local', 'tag', '-a', tag, sha, '-m', tag);
	// The beta channel note on the commit (not the tag object), as semantic-release writes it: the history
	// stays readable by semantic-release if the versioning ever goes back to it.
	git(
		'-c',
		'user.name=agents-release',
		'-c',
		'user.email=release@cuby.local',
		'notes',
		'--ref=semantic-release',
		'add',
		'-f',
		'-m',
		'{"channels":["beta"]}',
		sha,
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
		throw new Error(`${tag} publicado pero manifiesto no adjuntado: HTTP ${upload.status}. No repitas sin revisar.`);
	return version;
}

let publishedVersion = null;
const baseline = `v${config.baseline}`;
const tags = git('tag', '--list', 'v*').split('\n').filter(Boolean);
if (tags.length === 0) {
	console.log(`Bootstrap controlado: ${baseline} (${sha}). Primero build, firma y verificación; después tag/release.`);
	publishedVersion = await publish(config.baseline);
} else {
	if (!tags.includes(baseline))
		throw new Error(`Existe historial sin ${baseline}. Requiere conciliación manual, no se inventa otro baseline.`);
	const beta = nextBeta(tags);
	if (!beta) throw new Error('No hay tags beta 0.x de las cuales seguir; requiere conciliación manual.');
	if (git('rev-list', '-n', '1', beta.latest) === sha)
		throw new Error(`Este SHA ya es ${beta.latest}. Revisa la release existente en lugar de duplicarla.`);
	const messages = git('log', '--format=%B%x1e', `${beta.latest}..${sha}`)
		.split('\x1e')
		.map((m) => m.trim())
		.filter(Boolean);
	if (!releasable(messages))
		console.log(`Sin cambios publicables desde ${beta.latest}; no se crean tags ni artefactos.`);
	else if (tags.includes(`v${beta.next}`)) throw new Error(`v${beta.next} ya existe; requiere conciliación manual.`);
	else {
		console.log(`Siguiente beta: v${beta.next} (después de ${beta.latest}, ${messages.length} commits).`);
		publishedVersion = await publish(beta.next);
	}
}
mkdirSync('.release', { recursive: true });
writeFileSync(
	'.release/outcome.json',
	JSON.stringify({ sha, state: publishedVersion ? 'published' : 'unchanged', version: publishedVersion }, null, 2) +
		'\n',
);
console.log(publishedVersion ? `Publicado v${publishedVersion} (${sha}).` : `Sin cambios publicables (${sha}).`);
console.log('Publicación finalizada. Despliegue NO ejecutado: el corte queda para una autorización posterior.');
