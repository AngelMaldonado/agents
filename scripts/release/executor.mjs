// Runs exclusively inside Komodo's signing executor. No private key leaves that machine.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { signingFlags, verificationFlags } from './cosign.mjs';
import { config } from './config.mjs';
const mode = process.argv[2];
if (!['sign', 'verify', 'probe'].includes(mode)) throw new Error('Modo de executor inválido.');
process.env.DOCKER_CONFIG = '/tmp/agents-docker';
mkdirSync(process.env.DOCKER_CONFIG, { mode: 0o700 });
const auth = Buffer.from(`${process.env.REGISTRY_USERNAME}:${process.env.REGISTRY_PASSWORD}`).toString('base64');
writeFileSync(
	`${process.env.DOCKER_CONFIG}/config.json`,
	JSON.stringify({ auths: { 'registry.cubytest.space': { auth } } }),
	{ mode: 0o600 },
);
if (mode !== 'verify') {
	if (!process.env.COSIGN_PRIVATE_KEY_B64) throw new Error('Falta la referencia de firma en Komodo.');
	process.env.COSIGN_PRIVATE_KEY = Buffer.from(process.env.COSIGN_PRIVATE_KEY_B64, 'base64').toString('utf8');
}
delete process.env.COSIGN_PRIVATE_KEY_B64;
if (mode === 'probe') {
	const run = (bin, args, input) =>
		execFileSync(bin, args, { input, encoding: 'utf8', timeout: 300000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
	try {
		const pub = run('cosign', ['public-key', '--key', 'env://COSIGN_PRIVATE_KEY']);
		const publicKey = `${pub}\n`;
		if (createHash('sha256').update(publicKey).digest('hex') !== config.cosignPublicKeySha256)
			throw new Error('Clave real distinta de la huella fijada.');
		console.log(
			`AGENTS_RELEASE_PUBLIC_KEY ${JSON.stringify({ publicKey, sha256: createHash('sha256').update(publicKey).digest('hex') })}`,
		);
		writeFileSync('/tmp/cosign.pub', publicKey);
		const docker = (...args) => run('docker', ['--context', 'default', ...args]);
		if (docker('info', '--format', '{{.Name}}') !== 'reko-3') throw new Error('Executor equivocado.');
		const images = [];
		// Sign exactly the real app + sandbox test builds pushed by Komodo; never rebuild here.
		for (const name of ['agents-release-probe', 'agents-release-probe-sandbox']) {
			const repository = `registry.cubytest.space/cuby/${name}`;
			const tag = `${repository}:${process.env.AGENTS_RELEASE_SHA}`;
			const manifest = JSON.parse(docker('buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest}}'));
			if (!/^sha256:[a-f0-9]{64}$/.test(manifest.digest)) throw new Error('Digest inválido.');
			const ref = `${repository}@${manifest.digest}`;
			docker('pull', '--platform', 'linux/amd64', ref);
			const [image] = JSON.parse(docker('image', 'inspect', ref));
			if (
				image.Os !== 'linux' ||
				image.Architecture !== 'amd64' ||
				image.Config.Labels?.['org.opencontainers.image.revision'] !== process.env.AGENTS_RELEASE_SHA ||
				image.Config.Labels?.['org.opencontainers.image.version'] !== 'setup'
			)
				throw new Error('Plataforma/labels incorrectos en el ensayo.');
			const annotations = ['-a', `git_sha=${process.env.AGENTS_RELEASE_SHA}`, '-a', 'version=setup'];
			run('cosign', [
				'sign',
				'--yes',
				'--key',
				'env://COSIGN_PRIVATE_KEY',
				...signingFlags(false),
				...annotations,
				ref,
			]);
			const claims = JSON.parse(
				run('cosign', ['verify', '--key', '/tmp/cosign.pub', ...verificationFlags(false), ...annotations, ref]),
			);
			if (!claims.some((claim) => claim.critical?.image?.['docker-manifest-digest'] === manifest.digest))
				throw new Error('Firma no corresponde al digest.');
			images.push({ name, ref, verified: true });
		}
		console.log(`AGENTS_RELEASE_PROBE ${JSON.stringify({ images, verified: true, transparencyLog: false })}`);
	} catch (error) {
		// Do not stringify subprocess errors: they contain the entire environment / private buffers.
		const secrets = [
			auth,
			...Object.entries(process.env)
				.filter(([key, value]) => /PRIVATE|SECRET|PASSWORD|TOKEN/.test(key) && value)
				.map(([, value]) => value),
		];
		const detail = secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(error.stderr ?? ''));
		throw new Error(
			`Ensayo de firma falló: ${error.message?.split('\n')[0]}. ${detail.slice(0, 4000)} Sin publicar baseline ni desplegar.`,
		);
	}
} else {
	await import('./sign-images.mjs');
}
