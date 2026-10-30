// Komodo-only, on reko-3. Signing credentials are injected there, NEVER on the Mac or in Docker builds.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { config, assertPublicationAllowed } from './config.mjs';
import { assertSha, assertVersion, requireDigest } from './version.mjs';
import { schemaInfo } from './schema.mjs';
assertPublicationAllowed();
const mode = process.argv[2];
if (!['sign', 'verify'].includes(mode)) throw new Error('Uso: sign-images.mjs sign|verify');
const sha = assertSha(process.env.AGENTS_RELEASE_SHA),
	version = assertVersion(process.env.AGENTS_RELEASE_VERSION);
const ctx = process.env.DOCKER_CONTEXT;
if (!ctx) throw new Error('DOCKER_CONTEXT explícito obligatorio en el executor de Komodo.');
if (typeof config.transparencyLog !== 'boolean')
	throw new Error('Autoriza explícitamente si se publican datos en Rekor; no se elige por defecto.');
const keyFile = process.env.COSIGN_PUBLIC_KEY_FILE;
if (!keyFile || createHash('sha256').update(readFileSync(keyFile)).digest('hex') !== config.cosignPublicKeySha256)
	throw new Error('La clave pública no coincide con la huella fijada en el repositorio.');
const privateValues = Object.entries(process.env)
	.filter(([k, v]) => /PRIVATE|SECRET|PASSWORD|TOKEN/.test(k) && v)
	.map(([, v]) => v);
const clean = (v) => privateValues.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(v));
const run = (bin, args) => {
	try {
		return execFileSync(bin, args, {
			encoding: 'utf8',
			timeout: 300000,
			maxBuffer: 10 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim();
	} catch (error) {
		throw new Error(clean(`${bin} falló (${error.status}): ${error.stdout ?? ''}${error.stderr ?? ''}`));
	}
};
if (run('git', ['rev-parse', 'HEAD']) !== sha) throw new Error('El verificador no está en el SHA aprobado.');
const docker = (...args) => run('docker', ['--context', ctx, ...args]);
if (docker('info', '--format', '{{.Name}}') !== config.executorHost) throw new Error('El Docker Engine no es reko-3.');
const cosignVersion = JSON.parse(run('cosign', ['version', '--json']));
if ((cosignVersion.gitVersion ?? cosignVersion.GitVersion) !== `v${config.cosignVersion}`)
	throw new Error('Versión de Cosign distinta de la fijada.');
const keyRef = process.env.COSIGN_KEY_REF;
if (
	mode === 'sign' &&
	!/^(?:env:\/\/[A-Z_][A-Z0-9_]*|\/[^\n]+|(?:awskms|gcpkms|azurekms|hashivault):\/\/[^\n]+)$/.test(keyRef ?? '')
)
	throw new Error('COSIGN_KEY_REF debe referenciar una clave privada en Komodo, no contenerla.');
const images = {};
for (const [name, env] of [
	['agents', 'AGENTS_RELEASE_APP_TAG'],
	['agents-sandbox', 'AGENTS_RELEASE_SANDBOX_TAG'],
]) {
	const tag = process.env[env];
	const repository = `${config.registry}/${name}`;
	if (
		!tag?.startsWith(repository + ':') ||
		!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(tag.slice(repository.length + 1))
	)
		throw new Error(`Falta tag explícito del build ${name}.`);
	const descriptor = JSON.parse(docker('buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest}}'));
	const digest = requireDigest(descriptor.digest),
		ref = `${repository}@${digest}`;
	const raw = JSON.parse(docker('buildx', 'imagetools', 'inspect', ref, '--raw'));
	if (raw.manifests) {
		const runtime = raw.manifests.filter(
			(m) => m.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest',
		);
		if (runtime.length !== 1 || runtime[0].platform?.os !== 'linux' || runtime[0].platform?.architecture !== 'amd64')
			throw new Error('La imagen contiene plataformas distintas de linux/amd64.');
	}
	docker('pull', '--platform', config.platform, ref);
	const [image] = JSON.parse(docker('image', 'inspect', ref));
	if (
		image.Os !== 'linux' ||
		image.Architecture !== 'amd64' ||
		image.Config.Labels?.['org.opencontainers.image.revision'] !== sha ||
		image.Config.Labels?.['org.opencontainers.image.version'] !== version
	)
		throw new Error(`Plataforma/labels no corresponden a ${sha} (${name}).`);
	if (mode === 'sign') {
		console.log(`Firmando ${ref}`);
		run('cosign', [
			'sign',
			'--yes',
			'--key',
			keyRef,
			`--tlog-upload=${config.transparencyLog}`,
			'-a',
			`git_sha=${sha}`,
			'-a',
			`version=${version}`,
			ref,
		]);
	}
	// Verify the resolved immutable digest, not the mutable discovery tag.
	const claims = JSON.parse(
		run('cosign', [
			'verify',
			'--key',
			keyFile,
			...(!config.transparencyLog ? ['--insecure-ignore-tlog=true'] : []),
			'-a',
			`git_sha=${sha}`,
			'-a',
			`version=${version}`,
			ref,
		]),
	);
	if (!claims.some((claim) => claim.critical?.image?.['docker-manifest-digest'] === digest))
		throw new Error('La firma no declara el digest verificado.');
	images[name] = { digest, ref, verified: true };
}
if (mode === 'verify')
	console.log(
		`AGENTS_RELEASE_MANIFEST ${JSON.stringify({ version, sha, platform: config.platform, schema: schemaInfo(), images })}`,
	);
