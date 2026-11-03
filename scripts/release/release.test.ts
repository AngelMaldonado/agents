import { expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, assertPublicationAllowed, assertDeploymentAllowed, assertToolsImage } from './config.mjs';
import { sourceConfig, executorEnvironment, imageRepository } from './inputs.mjs';
import { prepareArtifacts, imageFrom, promotedFrom, promoteArtifacts } from './artifacts.mjs';
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
	expect(() => assertDeploymentAllowed({ ...enabled, deploymentEnabled: false })).toThrow();
	expect(() => assertDeploymentAllowed({ ...enabled, deploymentEnabled: true })).not.toThrow();
	expect(() => assertDeploymentAllowed({ ...config, publicationEnabled: false, deploymentEnabled: true })).toThrow();
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
test('tools image must be pullable by digest from the approved repository, never a local image ID or tag', () => {
	expect(assertToolsImage()).toBe(config.toolsImage);
	for (const toolsImage of [
		digest,
		`${config.registry}/agents-release-tools:latest`,
		`other.example/tools@${digest}`,
		`${config.registry}/agents-app@${digest}`,
		`${config.registry}/agents-release-tools@sha256:bad`,
	]) {
		expect(() => assertToolsImage({ ...config, toolsImage })).toThrow();
		expect(() =>
			executorEnvironment(version, sha, 'agents-app', { ...config, publicationEnabled: false, toolsImage }, true),
		).toThrow();
	}
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
test('one Repo execution per image (app, sandbox, proxy), one hook each, no builds/stacks/procedures/runners', async () => {
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
	expect(Object.keys(manifest.images)).toEqual(['agents-app', 'agents-sandbox', 'agents-proxy']);
	expect(calls.map((c) => c.type)).toEqual([
		'UpdateRepo',
		'CloneRepo',
		'UpdateRepo',
		'CloneRepo',
		'UpdateRepo',
		'CloneRepo',
	]);
	expect(calls.filter((c) => c.type === 'CloneRepo').map((c) => c.params.repo)).toEqual([
		'agents-app',
		'agents-sandbox',
		'agents-proxy',
	]);
	for (const operation of calls.filter((c) => c.type === 'UpdateRepo')) {
		expect(operation.params.config.commit).toBe(sha);
		expect(operation.params.config.git_account).toBe('AngelMaldonado');
		expect(operation.params.config.on_clone.command).toBe('');
		expect(operation.params.config.on_pull.command).toBe('bash scripts/release/komodo-job.sh');
	}
});
test('promoting a release from before the proxy image moves only app and sandbox', async () => {
	const digest = (c: string) => `sha256:${c.repeat(64)}`;
	const release = {
		version,
		sha,
		images: { 'agents-app': { digest: digest('a') }, 'agents-sandbox': { digest: digest('b') } },
	};
	const cloned: string[] = [];
	const client = {
		request: async () => {},
		execute: async (_type: string, params: any) => {
			cloned.push(params.repo);
			const d = params.repo === 'agents-app' ? digest('a') : digest('b');
			return {
				logs: [
					{
						stdout: `AGENTS_RELEASE_PROMOTED ${JSON.stringify({ component: params.repo, sha, version, digest: d, tag: `${imageRepository(params.repo)}:beta`, rehearsal: false })}`,
					},
				],
			};
		},
	};
	const promoted = await promoteArtifacts(client, release, sha, enabled);
	expect(cloned).toEqual(['agents-app', 'agents-sandbox']);
	expect(Object.keys(promoted)).toEqual(['agents-app', 'agents-sandbox']);
	expect(imageRepository('agents-proxy', true)).toEndWith('/agents-release-probe-proxy');
	expect(imageRepository('agents-proxy')).toEndWith('/agents-proxy');
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
	expect(shell).toContain("'build sign verify') phases=(build sign verify)");
	expect(shell).toContain('promote) phases=(promote)');
	expect(shell).toContain('if [[ "$mode" == sign ]]');
	expect(shell).toContain('phase_env+=(-e COSIGN_PRIVATE_KEY_B64 -e COSIGN_PASSWORD)');
	expect(shell).toContain('trap cleanup EXIT');
	expect(shell).toContain('pull --platform linux/amd64');
	expect(shell).toContain('run --pull=never');
	const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
	expect(main).not.toContain('readline');
	expect(main).not.toContain('startRunner');
	expect(main).not.toContain('workflow_dispatch');
	expect(main).toContain('--match-head-commit');
});
test('real shell pulls the pinned tools image before phases and cleans registry auth on success or failure', () => {
	const sequence = ['login', 'pull', 'build', 'sign', 'verify'];
	for (const fail of [null, ...sequence]) {
		const directory = mkdtempSync(join(tmpdir(), 'agents-wrapper-'));
		const authPath = join(directory, 'auth-path');
		try {
			mkdirSync(join(directory, '.git'));
			writeFileSync(
				join(directory, '.git/agents-release.env'),
				`AGENTS_RELEASE_COMPONENT=agents-app\nAGENTS_RELEASE_TOOLS_IMAGE=${config.toolsImage}\nREGISTRY_USERNAME=synthetic-user\nREGISTRY_PASSWORD=synthetic-password\nCOSIGN_PRIVATE_KEY_B64=synthetic-private-key\nCOSIGN_PASSWORD=synthetic-signing-password\n`,
			);
			writeFileSync(
				join(directory, 'docker'),
				`#!/usr/bin/env node
const fs=require('node:fs');
if(fs.existsSync('.git/agents-release.env'))process.exit(23);
const args=process.argv.slice(2), action=args.includes('login')?'login':args.includes('pull')?'pull':args.at(-1);
if(action==='login') {
 const config=args[args.indexOf('--config')+1];
 if(fs.readFileSync(0,'utf8')!=='synthetic-password')process.exit(24);
 fs.writeFileSync(config+'/config.json','synthetic-registry-auth');
 fs.writeFileSync(${JSON.stringify(authPath)},config);
} else {
 const config=fs.readFileSync(${JSON.stringify(authPath)},'utf8');
 if(action==='pull'&&!fs.existsSync(config+'/config.json'))process.exit(25);
 if(action!=='pull'&&fs.existsSync(config))process.exit(26);
}
fs.appendFileSync(${JSON.stringify(join(directory, 'calls'))},JSON.stringify({action,args})+'\\n');
if(action===${JSON.stringify(fail)})process.exit(1);
`,
				{ mode: 0o755 },
			);
			const call = () =>
				execFileSync('bash', [new URL('./komodo-job.sh', import.meta.url).pathname], {
					cwd: directory,
					env: { PATH: `${directory}:${process.env.PATH}`, HOME: directory },
					stdio: 'pipe',
				});
			if (fail) expect(call).toThrow();
			else call();
			const calls = readFileSync(join(directory, 'calls'), 'utf8')
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line));
			expect(calls.map((call) => call.action)).toEqual(fail ? sequence.slice(0, sequence.indexOf(fail) + 1) : sequence);
			for (const { action, args } of calls) {
				expect(args.includes('COSIGN_PRIVATE_KEY_B64')).toBe(action === 'sign');
				expect(args.includes('COSIGN_PASSWORD')).toBe(action === 'sign');
				if (['build', 'sign', 'verify'].includes(action)) expect(args).toContain('--pull=never');
			}
			expect(JSON.stringify(calls)).not.toContain('synthetic-password');
			expect(JSON.stringify(calls)).not.toContain('synthetic-private-key');
			expect(existsSync(readFileSync(authPath, 'utf8'))).toBe(false);
			expect(existsSync(join(directory, '.git/agents-release.env'))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
}, 15000);
test('a promote job runs only promote, never sees signing material, and must report :beta on the digest', () => {
	const digest = `sha256:${'d'.repeat(64)}`;
	const env = executorEnvironment(version, sha, 'agents-app', config, false, { promote: { digest } });
	expect(env).toContain('AGENTS_RELEASE_PHASES=promote');
	expect(env).toContain(`AGENTS_RELEASE_DIGEST=${digest}`);
	expect(env).not.toContain('COSIGN');
	expect(executorEnvironment(version, sha, 'agents-app')).toContain(
		'COSIGN_PRIVATE_KEY_B64=[[COSIGN_PRIVATE_KEY_B64]]',
	);
	expect(() =>
		executorEnvironment(version, sha, 'agents-app', config, false, { promote: { digest: 'latest' } }),
	).toThrow();
	const marker = (over = {}) => ({
		logs: [
			{
				stdout: `AGENTS_RELEASE_PROMOTED ${JSON.stringify({ component: 'agents-app', sha, version, digest, tag: `${imageRepository('agents-app')}:beta`, rehearsal: false, ...over })}`,
			},
		],
	});
	expect(promotedFrom(marker(), 'agents-app', sha, digest)).toEqual({
		tag: `${imageRepository('agents-app')}:beta`,
		digest,
	});
	for (const bad of [
		{ digest: `sha256:${'e'.repeat(64)}` },
		{ component: 'agents-sandbox' },
		{ tag: 'x:latest' },
		{ rehearsal: true },
	])
		expect(() => promotedFrom(marker(bad), 'agents-app', sha, digest)).toThrow();
	expect(() => promotedFrom({ logs: [] }, 'agents-app', sha, digest)).toThrow('no confirmó');
	// The real shell: login, pull of the tools image, then only the promote container, without the signing key.
	const directory = mkdtempSync(join(tmpdir(), 'agents-promote-'));
	try {
		mkdirSync(join(directory, '.git'));
		writeFileSync(
			join(directory, '.git/agents-release.env'),
			`AGENTS_RELEASE_COMPONENT=agents-app\nAGENTS_RELEASE_TOOLS_IMAGE=${config.toolsImage}\nREGISTRY_USERNAME=synthetic-user\nREGISTRY_PASSWORD=synthetic-password\nAGENTS_RELEASE_PHASES=promote\nAGENTS_RELEASE_DIGEST=${digest}\n`,
		);
		writeFileSync(
			join(directory, 'docker'),
			`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2), action=args.includes('login')?'login':args.includes('pull')?'pull':args.at(-1);
if(action==='login')fs.readFileSync(0,'utf8');
fs.appendFileSync(${JSON.stringify(join(directory, 'calls'))},JSON.stringify({action,args})+'\\n');
`,
			{ mode: 0o755 },
		);
		execFileSync('bash', [new URL('./komodo-job.sh', import.meta.url).pathname], {
			cwd: directory,
			env: { PATH: `${directory}:${process.env.PATH}`, HOME: directory },
			stdio: 'pipe',
		});
		const calls = readFileSync(join(directory, 'calls'), 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(calls.map((c) => c.action)).toEqual(['login', 'pull', 'promote']);
		expect(calls[2].args).toContain('AGENTS_RELEASE_DIGEST');
		expect(calls[2].args.includes('COSIGN_PRIVATE_KEY_B64')).toBe(false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
test('failed input loading cannot leave a signing envfile behind', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agents-invalid-env-'));
	try {
		mkdirSync(join(directory, '.git'));
		writeFileSync(join(directory, '.git/agents-release.env'), 'return 2\n');
		expect(() =>
			execFileSync('bash', [new URL('./komodo-job.sh', import.meta.url).pathname], { cwd: directory, stdio: 'pipe' }),
		).toThrow();
		expect(() => readFileSync(join(directory, '.git/agents-release.env'))).toThrow();
	} finally {
		rmSync(directory, { recursive: true, force: true });
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
