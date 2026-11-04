import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installAuthorized } from './self-maintenance.mjs';
import { prepareHarness } from './harness-runtime.mjs';
import { defaultHarness } from './harness';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
	const p = await mkdtemp(join(tmpdir(), 'self-install-test-'));
	roots.push(p);
	return p;
}
test('the main process advertises maintenance explicitly to pi even without bash; delegated children do not', async () => {
	const h = { ...defaultHarness(), tools: ['read', 'request_help'] };
	const main = prepareHarness(h, await root()),
		child = prepareHarness(h, await root(), [], false);
	const selected = (args: string[]) => args[args.indexOf('--tools') + 1].split(',');
	expect(selected(main.args)).toContain('self_maintenance');
	expect(selected(main.args)).not.toContain('bash');
	expect(selected(child.args)).not.toContain('self_maintenance');
	expect(main.digest).toBe(child.digest);
});
test('managed npm installation is local, has no lifecycle scripts/secrets, verifies version, and replays its marker', async () => {
	const work = await root(),
		calls: { bin: string; args: string[]; options: any }[] = [];
	const run = async (bin: string, args: string[], options: any) => {
		calls.push({ bin, args, options });
		const pkg = join(options.cwd, 'node_modules', 'csv-parse');
		await mkdir(pkg, { recursive: true });
		await writeFile(join(pkg, 'package.json'), JSON.stringify({ version: '6.1.0' }));
	};
	const plan = {
		id: randomUUID(),
		automatic: true,
		packages: [{ kind: 'npm', spec: 'csv-parse@6.1.0', name: null, sha256: null }],
	};
	const result = await installAuthorized(plan, {
		work,
		env: { HOME: work, PATH: '/bin', GITHUB_TOKEN: 'secret', OPENAI_API_KEY: 'secret' },
		run,
	});
	expect(result.ok).toBe(true);
	expect(calls).toHaveLength(1);
	expect(calls[0].bin).toBe('npm');
	expect(calls[0].args).toContain('--ignore-scripts');
	expect(calls[0].options.env.npm_config_userconfig).not.toBe(calls[0].options.env.npm_config_globalconfig);
	expect(calls[0].options.env.GITHUB_TOKEN).toBeUndefined();
	expect(calls[0].options.env.OPENAI_API_KEY).toBeUndefined();
	expect(calls[0].options.cwd.startsWith(work)).toBe(true);
	expect(JSON.parse(await readFile(join(result.path!, 'installed.json'), 'utf8')).packages).toEqual(plan.packages);
	expect((await installAuthorized(plan, { work, env: { HOME: work, PATH: '/bin' }, run })).reused).toBe(true);
	expect(calls).toHaveLength(1);
});
test('an installation over the post-install size budget is removed and never certified', async () => {
	const work = await root(),
		plan = { id: randomUUID(), automatic: true, packages: [{ kind: 'npm', spec: 'csv-parse@6.1.0' }] };
	const result = await installAuthorized(plan, {
		work,
		env: { HOME: work, PATH: '/bin' },
		run: async (_bin: string, _args: string[], options: any) => {
			await writeFile(join(options.cwd, 'large'), '');
			await truncate(join(options.cwd, 'large'), 51 * 1024 * 1024);
		},
	});
	expect(result.ok).toBe(false);
	await expect(readFile(join(work, 'tools', '.agents-installs', plan.id, 'installed.json'))).rejects.toThrow();
});
test('Python tools use an isolated relocatable environment, wheels only, and dependency consistency check', async () => {
	const work = await root(),
		calls: string[][] = [];
	const result = await installAuthorized(
		{ id: randomUUID(), automatic: true, packages: [{ kind: 'uv', spec: 'packaging==25.0' }] },
		{
			work,
			env: { HOME: work, PATH: '/bin' },
			run: async (_bin: string, args: string[]) => {
				calls.push(args);
			},
		},
	);
	expect(result.ok).toBe(true);
	expect(calls[0]).toContain('--relocatable');
	expect(calls[1]).toContain('--only-binary');
	expect(calls[1]).toContain('--no-deps');
	expect(calls[2].slice(0, 2)).toEqual(['pip', 'check']);
});
