// Trusted Komodo executor only. Build/verify containers never receive the signing key.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { config, assertPublicationAllowed } from './config.mjs';
import { assertSha, assertVersion, requireDigest } from './version.mjs';
import { imageRepository } from './inputs.mjs';
import { schemaInfo } from './schema.mjs';
import { signingFlags, verificationFlags } from './cosign.mjs';
const mode = process.argv[2],
	component = process.env.AGENTS_RELEASE_COMPONENT;
// promote: points `<repository>:beta` at an image already built, signed and verified for this SHA (its
// digest given), after verifying it again. It runs with the current main code, also for an older version
// (a rollback), so it does not check that the checkout is that SHA.
if (!['build', 'sign', 'verify', 'promote'].includes(mode)) throw new Error('Modo inválido.');
const rehearsal = process.env.AGENTS_RELEASE_REHEARSAL === 'true';
if (!rehearsal) assertPublicationAllowed();
const sha = assertSha(process.env.AGENTS_RELEASE_SHA),
	version = assertVersion(process.env.AGENTS_RELEASE_VERSION);
const repository = imageRepository(component, rehearsal),
	tag = `${repository}:${sha}`;
const secrets = Object.entries(process.env)
	.filter(([key, value]) => /PRIVATE|SECRET|PASSWORD|TOKEN/.test(key) && value)
	.map(([, value]) => value);
const clean = (text) => secrets.reduce((out, secret) => out.split(secret).join('[REDACTED]'), String(text));
const run = (bin, args) => {
	try {
		return execFileSync(bin, args, {
			encoding: 'utf8',
			timeout: 1200000,
			maxBuffer: 16 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim();
	} catch (error) {
		throw new Error(clean(`${bin} falló (${error.status}): ${error.stdout ?? ''}${error.stderr ?? ''}`));
	}
};
if (
	mode === 'promote'
		? run('git', ['status', '--porcelain'])
		: run('git', ['rev-parse', 'HEAD']) !== sha || run('git', ['status', '--porcelain'])
)
	throw new Error('Fuente sucia o SHA incorrecto.');
const ctx = process.env.DOCKER_CONTEXT;
if (!ctx) throw new Error('DOCKER_CONTEXT explícito obligatorio.');
const docker = (...args) => run('docker', ['--context', ctx, ...args]);
if (docker('info', '--format', '{{.Name}}') !== config.executorHost) throw new Error('Host Docker incorrecto.');
const publicKey = '/repo/release/cosign.pub';
if (createHash('sha256').update(readFileSync(publicKey)).digest('hex') !== config.cosignPublicKeySha256)
	throw new Error('Clave pública distinta de la fijada.');
process.env.DOCKER_CONFIG = '/tmp/agents-docker';
mkdirSync(process.env.DOCKER_CONFIG, { mode: 0o700 });
const auth = Buffer.from(`${process.env.REGISTRY_USERNAME}:${process.env.REGISTRY_PASSWORD}`).toString('base64');
secrets.push(auth);
writeFileSync(
	`${process.env.DOCKER_CONFIG}/config.json`,
	JSON.stringify({ auths: { [config.registry.split('/')[0]]: { auth } } }),
	{ mode: 0o600 },
);
if (mode === 'build') {
	if (process.env.COSIGN_PRIVATE_KEY_B64 || process.env.COSIGN_PASSWORD)
		throw new Error('El build no debe recibir material de firma.');
	const context = component === 'agents-app' ? '.' : 'sandbox';
	console.log(`Build ${component}: ${sha} (${config.platform}); namespace ${repository}`);
	console.log(
		docker(
			'buildx',
			'build',
			'--platform',
			config.platform,
			'--label',
			`org.opencontainers.image.revision=${sha}`,
			'--label',
			`org.opencontainers.image.version=${version}`,
			// The app reports them in /healthz; the compose no longer sets them (it follows :beta).
			...(component === 'agents-app'
				? ['--build-arg', `AGENTS_RELEASE_VERSION=${version}`, '--build-arg', `AGENTS_RELEASE_SHA=${sha}`]
				: []),
			'--tag',
			tag,
			'--file',
			`${context}/Dockerfile`,
			'--push',
			context,
		),
	);
} else {
	const cv = JSON.parse(run('cosign', ['version', '--json']));
	if ((cv.gitVersion ?? cv.GitVersion) !== `v${config.cosignVersion}`)
		throw new Error('Cosign distinto de la versión fijada.');
	const descriptor = JSON.parse(docker('buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest}}'));
	const digest = requireDigest(descriptor.digest),
		ref = `${repository}@${digest}`;
	if (mode === 'promote' && digest !== requireDigest(process.env.AGENTS_RELEASE_DIGEST))
		throw new Error('El digest del SHA no es el publicado en la release.');
	const raw = JSON.parse(docker('buildx', 'imagetools', 'inspect', ref, '--raw'));
	if (raw.manifests) {
		const runtime = raw.manifests.filter(
			(m) => m.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest',
		);
		if (runtime.length !== 1 || runtime[0].platform?.os !== 'linux' || runtime[0].platform?.architecture !== 'amd64')
			throw new Error('Plataformas inesperadas.');
	}
	docker('pull', '--platform', config.platform, ref);
	const [image] = JSON.parse(docker('image', 'inspect', ref));
	if (
		image.Os !== 'linux' ||
		image.Architecture !== 'amd64' ||
		image.Config.Labels?.['org.opencontainers.image.revision'] !== sha ||
		image.Config.Labels?.['org.opencontainers.image.version'] !== version
	)
		throw new Error('Labels/plataforma incorrectos.');
	const annotations = ['-a', `git_sha=${sha}`, '-a', `version=${version}`];
	if (mode === 'sign') {
		if (!process.env.COSIGN_PRIVATE_KEY_B64) throw new Error('Falta clave de firma en Komodo.');
		process.env.COSIGN_PRIVATE_KEY = Buffer.from(process.env.COSIGN_PRIVATE_KEY_B64, 'base64').toString('utf8');
		secrets.push(process.env.COSIGN_PRIVATE_KEY);
		delete process.env.COSIGN_PRIVATE_KEY_B64;
		run('cosign', [
			'sign',
			'--yes',
			'--key',
			'env://COSIGN_PRIVATE_KEY',
			...signingFlags(config.transparencyLog),
			...annotations,
			ref,
		]);
	} else {
		if (process.env.COSIGN_PRIVATE_KEY_B64 || process.env.COSIGN_PRIVATE_KEY || process.env.COSIGN_PASSWORD)
			throw new Error('El verificador no debe recibir material privado.');
		const claims = JSON.parse(
			run('cosign', ['verify', '--key', publicKey, ...verificationFlags(config.transparencyLog), ...annotations, ref]),
		);
		if (!claims.some((claim) => claim.critical?.image?.['docker-manifest-digest'] === digest))
			throw new Error('Firma no corresponde al digest.');
		if (mode === 'promote') {
			// The same manifest under the moving tag (no rebuild): its signature stays valid by digest.
			const beta = `${repository}:beta`;
			docker('buildx', 'imagetools', 'create', '--tag', beta, ref);
			const moved = JSON.parse(docker('buildx', 'imagetools', 'inspect', beta, '--format', '{{json .Manifest}}'));
			if (moved.digest !== digest) throw new Error(`${beta} no quedó en ${digest}.`);
			console.log(
				`AGENTS_RELEASE_PROMOTED ${JSON.stringify({ component, sha, version, digest, tag: beta, rehearsal })}`,
			);
		} else
			console.log(
				`AGENTS_RELEASE_IMAGE ${JSON.stringify({ component, sha, version, platform: config.platform, schema: schemaInfo(), digest, ref, verified: true, rehearsal })}`,
			);
	}
}
