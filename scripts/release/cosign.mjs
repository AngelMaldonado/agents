// Explicit compatibility mode for the existing private registry and pinned Cosign 3.1.4.
// This does not disable signature, expected-key, digest or annotation validation.
export function signingFlags(transparencyLog) {
	if (typeof transparencyLog !== 'boolean') throw new Error('Política de Rekor no definida.');
	return [
		'--use-signing-config=false',
		'--new-bundle-format=false',
		'--registry-referrers-mode=legacy',
		`--tlog-upload=${transparencyLog}`,
	];
}
export function verificationFlags(transparencyLog) {
	if (typeof transparencyLog !== 'boolean') throw new Error('Política de Rekor no definida.');
	// 3.1.4 verify does not accept --registry-referrers-mode; the legacy bundle selector controls lookup.
	return ['--new-bundle-format=false', ...(!transparencyLog ? ['--insecure-ignore-tlog=true'] : [])];
}
