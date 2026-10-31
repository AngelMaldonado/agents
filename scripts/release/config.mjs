import { readFileSync } from 'node:fs';
export const config = JSON.parse(readFileSync(new URL('../../release/config.json', import.meta.url), 'utf8'));
export function assertToolsImage(value = config) {
	const prefix = `${value.registry}/agents-release-tools@`;
	if (!value.toolsImage?.startsWith(prefix) || !/^sha256:[a-f0-9]{64}$/.test(value.toolsImage.slice(prefix.length)))
		throw new Error(
			'El executor requiere una imagen descargable del registry aprobado, fijada por digest; no un ID local ni un tag.',
		);
	return value.toolsImage;
}
export function assertPublicationAllowed(value = config) {
	if (!value.publicationEnabled)
		throw new Error(
			'Publicación bloqueada: falta completar la validación del setup. Consulta release/README.md antes de habilitar release/config.json.',
		);
	if (value.platform !== 'linux/amd64') throw new Error('Esta beta sólo permite linux/amd64 (reko-3).');
	assertToolsImage(value);
	if (!/^[a-f0-9]{64}$/.test(value.cosignPublicKeySha256 ?? '') || typeof value.transparencyLog !== 'boolean')
		throw new Error('Faltan la huella de firma o la política explícita de Rekor.');
}
export function assertDeploymentAllowed(value = config) {
	assertPublicationAllowed(value);
	if (!value.deploymentEnabled) throw new Error('Despliegue bloqueado hasta acordar el corte y la migración.');
}
