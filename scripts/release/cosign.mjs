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
	return [
		'--new-bundle-format=false',
		'--registry-referrers-mode=legacy',
		...(!transparencyLog ? ['--insecure-ignore-tlog=true'] : []),
	];
}
