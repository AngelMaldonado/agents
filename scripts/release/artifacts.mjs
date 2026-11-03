import { config, assertPublicationAllowed } from './config.mjs';
import { assertSha, assertVersion, requireDigest } from './version.mjs';
import { schemaInfo } from './schema.mjs';
import { components, repoOf, sourceConfig, executorEnvironment, imageRepository } from './inputs.mjs';
export function imageFrom(update, component, version, sha, value = config, rehearsal = false) {
	const markers = (update.logs ?? [])
		.flatMap((log) => (log.stdout ?? '').split(/\r?\n/))
		.filter((line) => line.startsWith('AGENTS_RELEASE_IMAGE '));
	if (markers.length !== 1) throw new Error('Komodo debe emitir exactamente un resultado verificado por imagen.');
	const result = JSON.parse(markers[0].slice('AGENTS_RELEASE_IMAGE '.length));
	if (
		result.component !== component ||
		result.version !== version ||
		result.sha !== sha ||
		result.platform !== value.platform ||
		result.rehearsal !== rehearsal
	)
		throw new Error('Imagen ajena al SHA, versión, plataforma o namespace aprobado.');
	if (JSON.stringify(result.schema) !== JSON.stringify(schemaInfo())) throw new Error('Migraciones ajenas al commit.');
	requireDigest(result.digest);
	if (result.ref !== `${imageRepository(component, rehearsal, value)}@${result.digest}` || result.verified !== true)
		throw new Error('Firma/digest inválidos.');
	return { digest: result.digest, ref: result.ref, verified: true };
}
export async function prepareArtifacts(client, version, sha, value = config, { rehearsal = false } = {}) {
	if (!rehearsal) assertPublicationAllowed(value);
	assertVersion(version);
	assertSha(sha);
	const source = sourceConfig(value),
		images = {};
	for (const component of components) {
		const name = repoOf(component, value);
		if (name !== component) throw new Error('Sólo se permiten los recursos aprobados (uno por imagen).');
		await client.request('write', 'UpdateRepo', {
			id: name,
			config: {
				...source,
				commit: sha,
				branch: rehearsal ? value.workBranch : value.releaseBranch,
				webhook_enabled: false,
				environment: executorEnvironment(version, sha, component, value, rehearsal),
				on_clone: { path: '', command: '', shell_mode: false },
				on_pull: { path: '', command: 'bash scripts/release/komodo-job.sh', shell_mode: false },
			},
		});
		const update = await client.execute('CloneRepo', { repo: name });
		images[component] = imageFrom(update, component, version, sha, value, rehearsal);
	}
	return { version, sha, platform: value.platform, schema: schemaInfo(), images };
}

/** What a promote job left: `:beta` on the release's digest of that component, or it throws. */
export function promotedFrom(update, component, sha, digest, value = config, rehearsal = false) {
	const markers = (update.logs ?? [])
		.flatMap((log) => (log.stdout ?? '').split(/\r?\n/))
		.filter((line) => line.startsWith('AGENTS_RELEASE_PROMOTED '));
	if (markers.length !== 1) throw new Error(`Komodo no confirmó :beta de ${component}.`);
	const result = JSON.parse(markers[0].slice('AGENTS_RELEASE_PROMOTED '.length));
	if (
		result.component !== component ||
		result.sha !== sha ||
		result.digest !== digest ||
		result.rehearsal !== rehearsal ||
		result.tag !== `${imageRepository(component, rehearsal, value)}:beta`
	)
		throw new Error(`:beta de ${component} no quedó en la imagen de la release.`);
	return { tag: result.tag, digest };
}

/**
 * Points `:beta` of both images at a published release (after the jobs verify their signatures again):
 * production then only pulls and redeploys. The jobs run the code of `codeSha` (current main), so an older
 * release can be promoted back (a rollback) with today's executor. App and sandbox move together or the
 * error says which one did not.
 */
export async function promoteArtifacts(client, release, codeSha, value = config, { rehearsal = false } = {}) {
	if (!rehearsal) assertPublicationAllowed(value);
	const version = assertVersion(release.version),
		sha = assertSha(release.sha);
	assertSha(codeSha);
	const source = sourceConfig(value),
		promoted = {};
	for (const component of components) {
		// A release from before the proxy image (v0.0.5 and older) has none: its :beta stays as it is.
		if (component === 'agents-proxy' && !release.images?.[component]) continue;
		const digest = requireDigest(release.images?.[component]?.digest);
		const name = repoOf(component, value);
		if (name !== component) throw new Error('Sólo se permiten los recursos aprobados (uno por imagen).');
		await client.request('write', 'UpdateRepo', {
			id: name,
			config: {
				...source,
				commit: codeSha,
				branch: rehearsal ? value.workBranch : value.releaseBranch,
				webhook_enabled: false,
				environment: executorEnvironment(version, sha, component, value, rehearsal, { promote: { digest } }),
				on_clone: { path: '', command: '', shell_mode: false },
				on_pull: { path: '', command: 'bash scripts/release/komodo-job.sh', shell_mode: false },
			},
		});
		const update = await client.execute('CloneRepo', { repo: name });
		promoted[component] = promotedFrom(update, component, sha, digest, value, rehearsal);
	}
	return promoted;
}
