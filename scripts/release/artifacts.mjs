import { config, assertPublicationAllowed } from './config.mjs';
import { assertSha, assertVersion, requireDigest } from './version.mjs';
import { schemaInfo } from './schema.mjs';
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
	// These dedicated resources must never be attached to auto-redeploy of the live stack.
	for (const name of [value.komodo.appBuild, value.komodo.sandboxBuild]) {
		if (!name.startsWith('agents-release-')) throw new Error('Se requieren builds nuevos y exclusivos del release.');
		await client.request('write', 'UpdateBuild', {
			id: name,
			config: {
				commit: sha,
				branch: value.releaseBranch,
				auto_increment_version: false,
				include_latest_tag: false,
				include_version_tags: false,
				include_commit_tag: true,
				labels: `org.opencontainers.image.revision=${sha}\norg.opencontainers.image.version=${version}`,
				use_buildx: true,
				extra_args: ['--platform', value.platform],
			},
		});
		const update = await client.execute('RunBuild', { build: name });
		if (update.commit_hash !== sha) throw new Error(`Build ${name} no confirmó el SHA completo esperado.`);
	}
	// Only new, non-secret inputs for dedicated procedures. Existing secret values are never read.
	for (const [name, input] of [
		['AGENTS_RELEASE_SHA', sha],
		['AGENTS_RELEASE_VERSION', version],
	]) {
		await client.request('write', 'UpdateVariableValue', { name, value: input });
	}
	await client.execute('RunProcedure', { procedure: value.komodo.signProcedure });
	const verification = await client.execute('RunProcedure', { procedure: value.komodo.verifyProcedure });
	return manifestFrom(verification, version, sha, value);
}
