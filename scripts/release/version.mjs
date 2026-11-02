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

// Betas go up by one in the patch: v0.0.1-beta → v0.0.2-beta → v0.0.3-beta. «-beta» names the stage, not a
// candidate of an unreleased version (no -beta.N). Leaving 0.0.x is an explicit decision, not a commit type.
const BETA_TAG = /^v0\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta(?:\.(0|[1-9]\d*))?$/;
/** The latest 0.x beta tag and the version that follows it, or null without beta tags. */
export function nextBeta(tags) {
	const betas = tags
		.map((tag) => tag.match(BETA_TAG))
		.filter(Boolean)
		.map((m) => ({ tag: m[0], key: [Number(m[1]), Number(m[2]), m[3] === undefined ? -1 : Number(m[3])] }))
		.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
	const latest = betas.at(-1);
	if (!latest) return null;
	return { latest: latest.tag, next: assertVersion(`0.${latest.key[0]}.${latest.key[1] + 1}-beta`) };
}
// The commits that publish, as the Conventional Commits rules used so far: feat, fix, perf, build, ci,
// refactor, chore(release) or a breaking change. docs, test, style and other chores do not.
const RELEASING = /^(?:feat|fix|perf|build|ci|refactor)(?:\([^)]*\))?!?:|^chore\(release\)!?:/;
/** Whether any of these full commit messages (subject + body) is worth a release. */
export function releasable(messages) {
	return messages.some((m) => RELEASING.test(m.trimStart()) || /^BREAKING[ -]CHANGE:/m.test(m));
}
