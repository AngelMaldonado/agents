// Runs exclusively inside Komodo's signing executor. No private key leaves that machine.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
		console.log(
			`AGENTS_RELEASE_PUBLIC_KEY ${JSON.stringify({ publicKey, sha256: createHash('sha256').update(publicKey).digest('hex') })}`,
		);
		writeFileSync('/tmp/cosign.pub', publicKey);
		const docker = (...args) => run('docker', ['--context', 'default', ...args]);
		if (docker('info', '--format', '{{.Name}}') !== 'reko-3') throw new Error('Executor equivocado.');
		const tag = `registry.cubytest.space/cuby/agents-release-probe:setup-${process.env.AGENTS_RELEASE_SHA.slice(0, 12)}`;
		run(
			'docker',
			['--context', 'default', 'build', '--platform', 'linux/amd64', '-t', tag, '-'],
			'FROM scratch\nLABEL purpose="agents-release-signature-probe"\n',
		);
		docker('push', tag);
		const manifest = JSON.parse(docker('buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest}}'));
		if (!/^sha256:[a-f0-9]{64}$/.test(manifest.digest)) throw new Error('Digest inválido.');
		const ref = `registry.cubytest.space/cuby/agents-release-probe@${manifest.digest}`;
		run('cosign', [
			'sign',
			'--yes',
			'--key',
			'env://COSIGN_PRIVATE_KEY',
			'--tlog-upload=false',
			'-a',
			'purpose=agents-release-probe',
			ref,
		]);
		const claims = JSON.parse(
			run('cosign', [
				'verify',
				'--key',
				'/tmp/cosign.pub',
				'--insecure-ignore-tlog=true',
				'-a',
				'purpose=agents-release-probe',
				ref,
			]),
		);
		if (!claims.some((claim) => claim.critical?.image?.['docker-manifest-digest'] === manifest.digest))
			throw new Error('Firma no corresponde al digest.');
		console.log(`AGENTS_RELEASE_PROBE ${JSON.stringify({ ref, verified: true, transparencyLog: false })}`);
	} catch (error) {
		// Do not stringify subprocess errors: they contain the entire environment / private buffers.
		throw new Error(`Ensayo de firma falló: ${error.message?.split('\n')[0]}. Sin publicar baseline ni desplegar.`);
	}
} else {
	await import('./sign-images.mjs');
}
