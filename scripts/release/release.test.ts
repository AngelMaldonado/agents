import { expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, assertPublicationAllowed, assertDeploymentAllowed } from './config.mjs';
import { sourceConfig, executorEnvironment, imageRepository } from './inputs.mjs';
import { prepareArtifacts, imageFrom } from './artifacts.mjs';
import { schemaInfo } from './schema.mjs';
import { Komodo } from './komodo.mjs';
import { signingFlags, verificationFlags } from './cosign.mjs';
import { assertSha, assertVersion, requireDigest } from './version.mjs';
const sha = 'a'.repeat(40),
	version = '0.0.1-beta',
	digest = `sha256:${'b'.repeat(64)}`;
const enabled = { ...config, publicationEnabled: true };
function result(component: string, rehearsal = false) {
	return {
		component,
		sha,
		version,
		platform: 'linux/amd64',
		schema: schemaInfo(),
		digest,
		ref: `${imageRepository(component, rehearsal)}@${digest}`,
		verified: true,
		rehearsal,
	};
}
function update(component: string, rehearsal = false) {
	return { logs: [{ stdout: `AGENTS_RELEASE_IMAGE ${JSON.stringify(result(component, rehearsal))}` }] };
}
test('publication stays gated independently of deployment', () => {
	expect(() => assertPublicationAllowed({ ...config, publicationEnabled: false })).toThrow();
	expect(() => assertPublicationAllowed(enabled)).not.toThrow();
	expect(() => assertDeploymentAllowed(enabled)).toThrow();
});
test('strict version, full SHA and immutable digest inputs', () => {
	expect(assertVersion(version)).toBe(version);
	expect(assertVersion('0.0.1-beta.1')).toBe('0.0.1-beta.1');
	for (const invalid of ['1.0.0', 'latest', '0.0.1;echo bad']) expect(() => assertVersion(invalid)).toThrow();
	expect(assertSha(sha)).toBe(sha);
	expect(() => assertSha('abc1234')).toThrow();
	expect(requireDigest(digest)).toBe(digest);
	expect(() => requireDigest('latest')).toThrow();
});
test('direct GitHub clone selects only approved existing account', () => {
	expect(sourceConfig()).toEqual({
		git_provider: 'github.com',
		git_https: true,
		git_account: 'AngelMaldonado',
		repo: 'AngelMaldonado/agents',
	});
	expect(() => sourceConfig({ ...config, komodo: { ...config.komodo, gitAccount: 'other' } })).toThrow();
	const env = executorEnvironment(version, sha, 'agents-app');
	expect(env).toContain('COSIGN_PRIVATE_KEY_B64=[[COSIGN_PRIVATE_KEY_B64]]');
	expect(env).toContain('AGENTS_RELEASE_REHEARSAL=false');
	expect(() => executorEnvironment(version, sha, 'other')).toThrow();
});
test('only two Repo executions, one hook each, no builds/stacks/procedures/runners', async () => {
	const calls: any[] = [];
	const client = {
		request: async (category: string, type: string, params: any) => {
			calls.push({ category, type, params });
		},
		execute: async (type: string, params: any) => {
			calls.push({ type, params });
			return update(params.repo);
		},
	};
	const manifest = await prepareArtifacts(client, version, sha, enabled);
	expect(Object.keys(manifest.images)).toEqual(['agents-app', 'agents-sandbox']);
	expect(calls.map((c) => c.type)).toEqual(['UpdateRepo', 'CloneRepo', 'UpdateRepo', 'CloneRepo']);
	for (const operation of calls.filter((c) => c.type === 'UpdateRepo')) {
		expect(operation.params.config.commit).toBe(sha);
		expect(operation.params.config.git_account).toBe('AngelMaldonado');
		expect(operation.params.config.on_clone.command).toBe('');
		expect(operation.params.config.on_pull.command).toBe('bash scripts/release/komodo-job.sh');
	}
});
test('first failed executor prevents the second and publication', async () => {
	let executions = 0;
	const client = {
		request: async () => {},
		execute: async () => {
			executions++;
			throw Error('failed');
		},
	};
	await expect(prepareArtifacts(client, version, sha, enabled)).rejects.toThrow('failed');
	expect(executions).toBe(1);
});
test('disabled publication stops before any remote request', async () => {
	let called = false;
	await expect(
		prepareArtifacts(
			{
				request: async () => {
					called = true;
				},
			},
			version,
			sha,
			{ ...config, publicationEnabled: false },
		),
	).rejects.toThrow();
	expect(called).toBe(false);
});
test('manifest rejects wrong SHA, version, platform, schema, digest and duplicate markers', () => {
	expect(imageFrom(update('agents-app'), 'agents-app', version, sha).verified).toBe(true);
	for (const override of [
		{ sha: 'c'.repeat(40) },
		{ version: '0.0.1-beta.1' },
		{ platform: 'linux/arm64' },
		{ schema: {} },
		{ digest: 'latest' },
		{ verified: false },
		{ rehearsal: true },
	]) {
		const bad = {
			logs: [{ stdout: `AGENTS_RELEASE_IMAGE ${JSON.stringify({ ...result('agents-app'), ...override })}` }],
		};
		expect(() => imageFrom(bad, 'agents-app', version, sha)).toThrow();
	}
	expect(() =>
		imageFrom({ logs: [...update('agents-app').logs, ...update('agents-app').logs] }, 'agents-app', version, sha),
	).toThrow();
});
test('rehearsal cannot pass as product artifact', () => {
	expect(imageFrom(update('agents-app', true), 'agents-app', version, sha, config, true).verified).toBe(true);
	expect(() => imageFrom(update('agents-app', true), 'agents-app', version, sha)).toThrow();
	expect(imageRepository('agents-app', true)).toEndWith('/agents-release-probe');
});
test('private values are forwarded only to the signing container; one job has three phases', () => {
	const shell = readFileSync(new URL('./komodo-job.sh', import.meta.url), 'utf8');
	expect(shell).toContain('for mode in build sign verify');
	expect(shell).toContain('if [[ "$mode" == sign ]]');
	expect(shell).toContain('phase_env+=(-e COSIGN_PRIVATE_KEY_B64 -e COSIGN_PASSWORD)');
	expect(shell).toContain("trap 'rm -f .git/agents-release.env' EXIT");
	const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
	expect(main).not.toContain('readline');
	expect(main).not.toContain('startRunner');
	expect(main).not.toContain('workflow_dispatch');
	expect(main).toContain('--match-head-commit');
});
test('real shell wrapper forwards secrets only to sign and always deletes its envfile', () => {
	for (const fail of [false, true]) {
		const directory = mkdtempSync(join(tmpdir(), 'agents-wrapper-'));
		try {
			mkdirSync(join(directory, '.git'));
			writeFileSync(
				join(directory, '.git/agents-release.env'),
				'AGENTS_RELEASE_COMPONENT=agents-app\nAGENTS_RELEASE_TOOLS_IMAGE=sha256:fixture\nCOSIGN_PRIVATE_KEY_B64=synthetic\nCOSIGN_PASSWORD=synthetic\n',
			);
			writeFileSync(
				join(directory, 'docker'),
				`#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(join(directory, 'calls'))},JSON.stringify(args)+'\\n');if(${fail}&&args.at(-1)==='sign')process.exit(1);`,
				{ mode: 0o755 },
			);
			const call = () =>
				execFileSync('bash', [new URL('./komodo-job.sh', import.meta.url).pathname], {
					cwd: directory,
					env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
					stdio: 'pipe',
				});
			if (fail) expect(call).toThrow();
			else call();
			const calls = readFileSync(join(directory, 'calls'), 'utf8')
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line));
			expect(calls.map((args) => args.at(-1))).toEqual(fail ? ['build', 'sign'] : ['build', 'sign', 'verify']);
			for (const args of calls) expect(args.includes('COSIGN_PRIVATE_KEY_B64')).toBe(args.at(-1) === 'sign');
			expect(() => readFileSync(join(directory, '.git/agents-release.env'))).toThrow();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
});
test('Cosign compatibility keeps cryptographic verification without Rekor', () => {
	expect(signingFlags(false)).toContain('--use-signing-config=false');
	expect(verificationFlags(false)).toContain('--insecure-ignore-tlog=true');
	expect(verificationFlags(false)).not.toContain('--registry-referrers-mode=legacy');
});
test('Komodo uses both headers, polls completion and redacts credentials', async () => {
	const logs: string[] = [],
		requests: any[] = [];
	let now = 0;
	const client = new Komodo({
		url: 'https://komodo.test',
		key: 'test-key',
		secret: 'test-secret',
		emit: (v: string) => logs.push(v),
		now: () => now,
		sleep: async () => {
			now += 10;
		},
		fetcher: async (url: any, options: any) => {
			requests.push({ url, options });
			const body = JSON.parse(options.body);
			return Response.json(
				body.type === 'GetUpdate'
					? { id: 'one', status: 'Complete', success: true, logs: [{ stdout: 'test-key test-secret' }] }
					: { id: 'one', status: 'InProgress' },
			);
		},
	});
	await client.execute('CloneRepo', { repo: 'agents-app' });
	expect(requests[0].options.headers['X-Api-Key']).toBe('test-key');
	expect(requests[0].options.headers['X-Api-Secret']).toBe('test-secret');
	expect(logs.join('')).not.toContain('test-secret');
	expect(logs.join('')).toContain('[REDACTED]');
});
test('Komodo rejects failed, malformed, unknown and timed out states', async () => {
	for (const state of [{ id: 'x', status: 'Complete', success: false }, { id: 'x', status: 'Unknown' }, {}]) {
		const client = new Komodo({
			url: 'https://komodo.test',
			key: 'key',
			secret: 'secret',
			emit: () => {},
			fetcher: async () => Response.json(state),
		});
		await expect(client.execute('CloneRepo', {})).rejects.toThrow();
	}
	let now = 0;
	const client = new Komodo({
		url: 'https://komodo.test',
		key: 'key',
		secret: 'secret',
		emit: () => {},
		now: () => now,
		sleep: async () => {
			now += 100;
		},
		fetcher: async () => Response.json({ id: 'x', status: 'InProgress' }),
	});
	await expect(client.execute('CloneRepo', {}, { timeoutMs: 50 })).rejects.toThrow('puede seguir activa');
});
