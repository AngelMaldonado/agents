import { config, assertPublicationAllowed } from './config.mjs';
import { assertSha, assertVersion, requireDigest } from './version.mjs';
import { schemaInfo } from './schema.mjs';
import { components, sourceConfig, executorEnvironment, imageRepository } from './inputs.mjs';
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
		const name = component === 'agents-app' ? value.komodo.appRepo : value.komodo.sandboxRepo;
		if (name !== component) throw new Error('Sólo se permiten los dos recursos aprobados.');
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
