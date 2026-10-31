export function assertVersion(version) {
	if (!/^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-beta(?:\.(?:0|[1-9]\d*))?$/.test(version))
		throw new Error(
			`Versión fuera de la beta 0.x: ${version}. Se requiere una decisión explícita antes de salir de esta etapa.`,
		);
	return version;
}
export function assertSha(sha) {
	if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Se requiere un SHA Git completo.');
	return sha;
}
export function requireDigest(value) {
	if (!/^sha256:[a-f0-9]{64}$/.test(value ?? '')) throw new Error('Falta un digest OCI verificable.');
	return value;
}
