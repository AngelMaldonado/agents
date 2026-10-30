import { config, assertPublicationAllowed } from './config.mjs';
import { assertSha, assertVersion, requireDigest } from './version.mjs';
import { schemaInfo } from './schema.mjs';
import { sourceConfig, executorEnvironment } from './inputs.mjs';
export function manifestFrom(update, version, sha, value = config) {
	const markers = (update.logs ?? [])
		.flatMap((log) => (log.stdout ?? '').split(/\r?\n/))
		.filter((line) => line.startsWith('AGENTS_RELEASE_MANIFEST '));
	if (markers.length !== 1) throw new Error('Komodo debe emitir exactamente un AGENTS_RELEASE_MANIFEST verificado.');
	const result = JSON.parse(markers[0].slice('AGENTS_RELEASE_MANIFEST '.length));
	if (result.version !== version || result.sha !== sha || result.platform !== value.platform)
		throw new Error('Los artefactos no corresponden al commit, versión o arquitectura aprobados.');
	const expectedSchema = schemaInfo();
	if (
		result.schema?.sha256 !== expectedSchema.sha256 ||
		JSON.stringify(result.schema?.files) !== JSON.stringify(expectedSchema.files)
	)
		throw new Error('El manifiesto no corresponde al conjunto de migraciones del commit.');
	for (const name of ['agents', 'agents-sandbox']) {
		const image = result.images?.[name];
		requireDigest(image?.digest);
		if (image.ref !== `${value.registry}/${name}@${image.digest}` || image.verified !== true)
			throw new Error(`Firma/digest inválidos para ${name}.`);
	}
	return result;
}
export async function prepareArtifacts(client, version, sha, value = config) {
	assertPublicationAllowed(value);
	assertVersion(version);
	assertSha(sha);
	const source = sourceConfig(value);
	// These dedicated resources must never be attached to auto-redeploy of the live stack.
	for (const name of [value.komodo.appBuild, value.komodo.sandboxBuild]) {
		if (!name.startsWith('agents-release-')) throw new Error('Se requieren builds nuevos y exclusivos del release.');
		const sandbox = name === value.komodo.sandboxBuild;
		await client.request('write', 'UpdateBuild', {
			id: name,
			config: {
				...source,
				build_path: sandbox ? 'sandbox' : '.',
				dockerfile_path: 'Dockerfile',
				commit: sha,
				image_tag: sha,
				pre_build: {
					path: sandbox ? '..' : '',
					command: `bash scripts/release/source-check.sh ${sha}`,
					shell_mode: false,
				},
				branch: 'approved',
				auto_increment_version: false,
				include_latest_tag: false,
				include_version_tags: false,
				include_commit_tag: false,
				labels: `org.opencontainers.image.revision=${sha}\norg.opencontainers.image.version=${version}`,
				use_buildx: true,
				extra_args: ['--platform', value.platform],
			},
		});
		const update = await client.execute('RunBuild', { build: name });
		// Komodo 2.3.3 reports a short hash. Require the separately observed full, clean source proof.
		const observed = (update.logs ?? [])
			.flatMap((log) => (log.stdout ?? '').split(/\r?\n/))
			.filter((line) => line.startsWith('AGENTS_RELEASE_SOURCE_SHA '));
		if (
			!/^[a-f0-9]{7,40}$/.test(update.commit_hash ?? '') ||
			!sha.startsWith(update.commit_hash) ||
			observed.length !== 1 ||
			observed[0] !== `AGENTS_RELEASE_SOURCE_SHA ${sha}`
		)
			throw new Error(`Build ${name} no confirmó el SHA completo esperado y una fuente limpia.`);
	}
	// Only dedicated Repo resources receive inputs. Secret placeholders resolve on Komodo, never here.
	let verification;
	for (const [mode, name] of [
		['sign', value.komodo.signRepo],
		['verify', value.komodo.verifyRepo],
	]) {
		if (!name.startsWith('agents-release-')) throw new Error('Executor no exclusivo del release.');
		await client.request('write', 'UpdateRepo', {
			id: name,
			config: {
				...source,
				commit: sha,
				branch: 'approved',
				environment: executorEnvironment(version, sha, mode, value),
				on_clone: { path: '', command: `bash scripts/release/komodo-job.sh ${mode}`, shell_mode: false },
				on_pull: { path: '', command: `bash scripts/release/komodo-job.sh ${mode}`, shell_mode: false },
			},
		});
		verification = await client.execute('CloneRepo', { repo: name });
	}
	return manifestFrom(verification, version, sha, value);
}
