import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('temporary publisher checkout stays clean with dependency symlink but still rejects source changes', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agents-publish-fixture-'));
	const source = join(directory, 'source'),
		checkout = join(directory, 'checkout'),
		dependencies = join(directory, 'dependencies');
	// Do not inherit Git hook variables, credentials or the operator's Git configuration.
	const env = {
		PATH: process.env.PATH!,
		HOME: directory,
		LANG: 'en_US.UTF-8',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: '/dev/null',
		LEFTHOOK: '0',
	};
	const git = (cwd: string, ...args: string[]) =>
		execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
			cwd,
			env,
			encoding: 'utf8',
			stdio: 'pipe',
		}).trim();
	try {
		mkdirSync(source);
		mkdirSync(dependencies);
		git(source, 'init', '--initial-branch=main');
		expect(realpathSync(git(source, 'rev-parse', '--show-toplevel'))).toBe(realpathSync(source));
		writeFileSync(join(source, '.gitignore'), readFileSync(new URL('../../.gitignore', import.meta.url)));
		writeFileSync(join(source, 'tracked.txt'), 'original\n');
		git(source, 'add', '.gitignore', 'tracked.txt');
		git(
			source,
			'-c',
			'user.name=Fixture',
			'-c',
			'user.email=fixture@example.test',
			'commit',
			'-m',
			'test: publisher checkout fixture',
		);
		const sha = git(source, 'rev-parse', 'HEAD');
		git(directory, 'clone', '--no-hardlinks', '--no-checkout', source, checkout);
		git(checkout, 'checkout', '-B', 'main', sha);
		symlinkSync(dependencies, join(checkout, 'node_modules'), 'dir');
		expect(git(checkout, 'status', '--porcelain')).toBe('');
		writeFileSync(join(checkout, 'tracked.txt'), 'changed\n');
		expect(git(checkout, 'status', '--porcelain')).toContain('tracked.txt');
		git(checkout, 'restore', 'tracked.txt');
		writeFileSync(join(checkout, 'accidental.txt'), 'unexpected\n');
		expect(git(checkout, 'status', '--porcelain')).toBe('?? accidental.txt');
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
