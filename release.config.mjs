import { config } from './scripts/release/config.mjs';
export default {
	repositoryUrl: `https://github.com/${config.repository}.git`,
	branches: [config.stableBranch, { name: config.releaseBranch, prerelease: 'beta', channel: 'beta' }],
	tagFormat: 'v${version}',
	plugins: [
		[
			'@semantic-release/commit-analyzer',
			{
				releaseRules: [
					{ type: 'fix', release: 'patch' },
					{ type: 'feat', release: 'minor' },
					{ type: 'perf', release: 'patch' },
					{ type: 'build', release: 'patch' },
					{ type: 'ci', release: 'patch' },
					{ type: 'refactor', release: 'patch' },
					{ type: 'chore', scope: 'release', release: 'patch' },
				],
			},
		],
		'@semantic-release/release-notes-generator',
		'./scripts/release/plugin.mjs',
		[
			'@semantic-release/github',
			{ successComment: false, failComment: false, releasedLabels: false, assets: ['.release/release-manifest.json'] },
		],
	],
};
