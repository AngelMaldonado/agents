// One-off setup rehearsal. Real builds only in test namespaces; no product tag/release, deployment or data access.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from './config.mjs';
import { assertSha } from './version.mjs';
import { Komodo } from './komodo.mjs';
import { sourceConfig, executorEnvironment } from './inputs.mjs';
const sha = assertSha(process.env.AGENTS_RELEASE_SETUP_SHA);
if (
	process.env.GITHUB_EVENT_NAME !== 'pull_request' ||
	execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== sha
)
	throw new Error('Ensayo no aprobado para este SHA.');
let rejection = '';
const client = new Komodo({
	url: config.komodo.url,
	key: process.env.AGENTS_RELEASE_KOMODO_KEY,
	secret: process.env.AGENTS_RELEASE_KOMODO_SECRET,
	fetcher: async (url, options) => {
		const response = await fetch(url, options);
		if (JSON.parse(options.body).type === 'GetStack' && !response.ok) rejection = await response.clone().text();
		return response;
	},
});
console.log('Komodo', (await client.request('read', 'GetVersion')).version);
await client.request('read', 'GetBuild', { build: config.komodo.appBuild });
let denied = false;
try {
	await client.request('read', 'GetStack', { stack: 'agents' });
} catch {
	denied = /permission/i.test(rejection);
}
if (!denied) throw new Error('La cuenta no demostró denegación de acceso al stack existente.');
console.log('Stack existente: acceso denegado por permisos.');
const sentinel = await client.request('read', 'GetVariable', { name: 'AGENTS_RELEASE_PERMISSION_PROBE' });
if (sentinel.is_secret !== true || !/^#+$/.test(sentinel.value ?? ''))
	throw new Error('El API no ocultó el secreto sintético de prueba.');
console.log('Secretos: el API oculta el valor del secreto sintético; no se consultó ninguna clave real.');
const builds = [];
for (const sandbox of [false, true]) {
	await client.request('write', 'UpdateBuild', {
		id: 'agents-release-probe',
		config: {
			...sourceConfig(),
			branch: 'approved',
			commit: sha,
			image_tag: sha,
			image_name: sandbox ? 'agents-release-probe-sandbox' : 'agents-release-probe',
			build_path: sandbox ? 'sandbox' : '.',
			dockerfile_path: 'Dockerfile',
			dockerfile: '',
			labels: `org.opencontainers.image.revision=${sha}\norg.opencontainers.image.version=setup`,
			pre_build: {
				path: sandbox ? '..' : '',
				command: `bash scripts/release/source-check.sh ${sha}`,
				shell_mode: false,
			},
		},
	});
	const build = await client.execute('RunBuild', { build: 'agents-release-probe' });
	if (!sha.startsWith(build.commit_hash ?? '!')) throw new Error('Build de prueba no corresponde al SHA.');
	builds.push(build._id);
	console.log(`Build real ${sandbox ? 'sandbox' : 'app'} completado con SHA fijado en namespace de ensayo.`);
}
await client.request('write', 'UpdateRepo', {
	id: config.komodo.signRepo,
	config: {
		...sourceConfig(),
		branch: 'approved',
		commit: sha,
		environment: executorEnvironment('setup', sha, 'probe'),
		on_clone: { path: '', command: '', shell_mode: false },
		on_pull: { path: '', command: 'bash scripts/release/komodo-job.sh probe', shell_mode: false },
	},
});
const result = await client.execute('CloneRepo', { repo: config.komodo.signRepo });
const lines = result.logs.flatMap((log) => (log.stdout ?? '').split(/\r?\n/));
const pick = (prefix) => {
	const values = lines.filter((line) => line.startsWith(prefix));
	if (values.length !== 1) throw new Error(`Marcador inválido: ${prefix}`);
	return JSON.parse(values[0].slice(prefix.length));
};
const publicKey = pick('AGENTS_RELEASE_PUBLIC_KEY '),
	proof = pick('AGENTS_RELEASE_PROBE ');
if (proof.verified !== true || proof.transparencyLog !== false) throw new Error('No hay firma/verificación real.');
mkdirSync('.release', { recursive: true });
writeFileSync('.release/public-key.json', JSON.stringify(publicKey, null, 2));
writeFileSync('.release/setup-proof.json', JSON.stringify({ sha, builds, ...proof }, null, 2));
console.log('SETUP_SIGNATURE_VERIFIED: clave pública y evidencia listas; cero releases y despliegues.');
