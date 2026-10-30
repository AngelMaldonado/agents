import { readFileSync } from 'node:fs';
export const config = JSON.parse(readFileSync(new URL('../../release/config.json', import.meta.url), 'utf8'));
export function assertPublicationAllowed(value = config) {
	if (!value.publicationEnabled)
		throw new Error(
			'Publicación bloqueada: el setup conserva intactos los entornos con usuarios. Autoriza el baseline y habilita release/config.json antes de publicar.',
		);
	if (value.platform !== 'linux/amd64') throw new Error('Esta beta sólo permite linux/amd64 (reko-3).');
}
export function assertDeploymentAllowed(value = config) {
	assertPublicationAllowed(value);
	if (!value.deploymentEnabled) throw new Error('Despliegue bloqueado hasta acordar el corte y la migración.');
}
