// One-off setup rehearsal. No product tag/release, app build, deployment or data access.
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
const client = new Komodo({
	url: config.komodo.url,
	key: process.env.AGENTS_RELEASE_KOMODO_KEY,
	secret: process.env.AGENTS_RELEASE_KOMODO_SECRET,
});
console.log('Komodo', (await client.request('read', 'GetVersion')).version);
for (const [type, params] of [
	['GetStack', { stack: 'agents' }],
	['GetVariable', { name: 'COSIGN_PRIVATE_KEY_B64' }],
]) {
	let denied = false;
	try {
		await client.request('read', type, params);
	} catch (error) {
		denied = /HTTP 403/.test(error.message);
	}
	if (!denied) throw new Error(`Cuenta de release obtuvo acceso inesperado: ${type}`);
	console.log(`Acceso denegado correctamente: ${type}`);
}
await client.request('write', 'UpdateBuild', {
	id: 'agents-release-probe',
	config: {
		...sourceConfig(),
		branch: 'approved',
		commit: sha,
		image_tag: sha,
		labels: `org.opencontainers.image.revision=${sha}\norg.opencontainers.image.version=setup`,
		pre_build: {
			path: '',
			command: `test "$(git rev-parse HEAD)" = ${sha} && printf 'AGENTS_RELEASE_SOURCE_SHA %s\\n' "$(git rev-parse HEAD)"`,
			shell_mode: false,
		},
	},
});
const build = await client.execute('RunBuild', { build: 'agents-release-probe' });
if (!sha.startsWith(build.commit_hash ?? '!')) throw new Error('Build de prueba no corresponde al SHA.');
console.log('Build de prueba completado con SHA fijado.');
await client.request('write', 'UpdateRepo', {
	id: config.komodo.signRepo,
	config: {
		...sourceConfig(),
		branch: 'approved',
		commit: sha,
		environment: executorEnvironment('setup', sha, 'probe'),
		on_clone: { path: '', command: 'bash scripts/release/komodo-job.sh probe', shell_mode: false },
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
writeFileSync('.release/setup-proof.json', JSON.stringify({ sha, build: build._id, ...proof }, null, 2));
console.log('SETUP_SIGNATURE_VERIFIED: clave pública y evidencia listas; cero releases y despliegues.');
