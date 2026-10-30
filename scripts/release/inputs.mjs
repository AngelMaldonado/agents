import { config } from './config.mjs';
import { assertSource } from './runner.mjs';
export function sourceConfig(value = config) {
	return {
		git_provider: assertSource(value.gitProvider ?? process.env.AGENTS_RELEASE_GIT_PROVIDER),
		git_https: false,
		git_account: '',
		repo: 'agents.git',
	};
}
export function executorEnvironment(version, sha, mode, value = config) {
	if (!['sign', 'verify', 'probe'].includes(mode)) throw new Error('Executor inválido.');
	return [
		`AGENTS_RELEASE_SHA=${sha}`,
		`AGENTS_RELEASE_VERSION=${version}`,
		`AGENTS_RELEASE_APP_TAG=${value.registry}/agents:${sha}`,
		`AGENTS_RELEASE_SANDBOX_TAG=${value.registry}/agents-sandbox:${sha}`,
		`AGENTS_RELEASE_TOOLS_IMAGE=${value.toolsImage}`,
		'REGISTRY_USERNAME=[[REGISTRY_USERNAME]]',
		'REGISTRY_PASSWORD=[[REGISTRY_PASSWORD]]',
		...(mode !== 'verify'
			? ['COSIGN_PRIVATE_KEY_B64=[[COSIGN_PRIVATE_KEY_B64]]', 'COSIGN_PASSWORD=[[COSIGN_PASSWORD]]']
			: []),
	].join('\n');
}
