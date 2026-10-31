import { config, assertToolsImage } from './config.mjs';
import { assertSha, assertVersion } from './version.mjs';
export const components = ['agents-app', 'agents-sandbox'];
export function sourceConfig(value = config) {
	if (value.komodo.gitAccount !== 'AngelMaldonado') throw new Error('Cuenta GitHub no aprobada.');
	return { git_provider: 'github.com', git_https: true, git_account: value.komodo.gitAccount, repo: value.repository };
}
export function imageRepository(component, rehearsal = false, value = config) {
	if (!components.includes(component)) throw new Error('Componente inválido.');
	return `${value.registry}/${rehearsal ? `agents-release-probe${component === 'agents-app' ? '' : '-sandbox'}` : component}`;
}
export function executorEnvironment(version, sha, component, value = config, rehearsal = false) {
	assertSha(sha);
	assertVersion(version);
	imageRepository(component, rehearsal, value);
	return [
		`AGENTS_RELEASE_SHA=${sha}`,
		`AGENTS_RELEASE_VERSION=${version}`,
		`AGENTS_RELEASE_COMPONENT=${component}`,
		`AGENTS_RELEASE_REHEARSAL=${rehearsal}`,
		`AGENTS_RELEASE_TOOLS_IMAGE=${assertToolsImage(value)}`,
		'REGISTRY_USERNAME=[[REGISTRY_USERNAME]]',
		'REGISTRY_PASSWORD=[[REGISTRY_PASSWORD]]',
		'COSIGN_PRIVATE_KEY_B64=[[COSIGN_PRIVATE_KEY_B64]]',
		'COSIGN_PASSWORD=[[COSIGN_PASSWORD]]',
	].join('\n');
}
