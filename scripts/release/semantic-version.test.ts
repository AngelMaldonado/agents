import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
test('semantic-release accepts main beta + dormant stable and the exact unnumbered bootstrap', () => {
	const dir = mkdtempSync(join(tmpdir(), 'agents-semver-'));
	const cwd = join(dir, 'repo'),
		remote = join(dir, 'remote.git');
	const git = (...args: string[]) =>
		execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	try {
		execFileSync('git', ['init', '--initial-branch=main', cwd], { stdio: 'pipe' });
		execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
		git('config', 'user.name', 'Fixture');
		git('config', 'user.email', 'fixture@example.test');
		git('commit', '--allow-empty', '-m', 'feat: initial fixture');
		git('branch', 'stable');
		git('remote', 'add', 'origin', remote);
		git('push', '--all', 'origin');
		git('tag', 'v0.0.1-beta');
		git('notes', '--ref=semantic-release', 'add', '-m', '{"channels":["beta"]}', 'v0.0.1-beta');
		git('push', 'origin', 'v0.0.1-beta', 'refs/notes/semantic-release');
		git('commit', '--allow-empty', '-m', 'fix: next beta');
		git('push', 'origin', 'main');
		const script = `import release from ${JSON.stringify(require.resolve('semantic-release'))};\nconst result = await release({ci:false,dryRun:true,repositoryUrl:${JSON.stringify(remote)},branches:['stable',{name:'main',prerelease:'beta',channel:'beta'}],tagFormat:'v\${version}',plugins:[${JSON.stringify(require.resolve('@semantic-release/commit-analyzer'))}]},{cwd:${JSON.stringify(cwd)}});\nconsole.log('FIXTURE_VERSION='+result.nextRelease.version);`;
		const result = execFileSync('node', ['--input-type=module', '-e', script], {
			cwd,
			encoding: 'utf8',
			timeout: 30000,
			env: { PATH: process.env.PATH!, HOME: process.env.HOME!, LANG: 'en_US.UTF-8', FORCE_COLOR: '0' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		expect(result).toContain('FIXTURE_VERSION=0.0.1-beta.1');
		expect(git('tag', '--list')).toBe('v0.0.1-beta'); // dry-run must not create a tag.
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 35000);
