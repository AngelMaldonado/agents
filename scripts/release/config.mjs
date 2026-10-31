import { readFileSync } from 'node:fs';
export const config = JSON.parse(readFileSync(new URL('../../release/config.json', import.meta.url), 'utf8'));
export function assertPublicationAllowed(value = config) {
	if (!value.publicationEnabled)
		throw new Error(
			'Publicación bloqueada: falta completar la validación del setup. Consulta release/README.md antes de habilitar release/config.json.',
		);
	if (value.platform !== 'linux/amd64') throw new Error('Esta beta sólo permite linux/amd64 (reko-3).');
	if (!/^sha256:[a-f0-9]{64}$/.test(value.toolsImage ?? '')) throw new Error('Falta el ID inmutable del executor.');
	if (!/^[a-f0-9]{64}$/.test(value.cosignPublicKeySha256 ?? '') || typeof value.transparencyLog !== 'boolean')
		throw new Error('Faltan la huella de firma o la política explícita de Rekor.');
}
export function assertDeploymentAllowed(value = config) {
	assertPublicationAllowed(value);
	if (!value.deploymentEnabled) throw new Error('Despliegue bloqueado hasta acordar el corte y la migración.');
}
