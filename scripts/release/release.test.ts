import { expect, test } from 'bun:test';
import { config, assertPublicationAllowed, assertDeploymentAllowed } from './config.mjs';
import { assertSha, assertVersion, requireDigest } from './version.mjs';
import { Komodo } from './komodo.mjs';
import { manifestFrom, prepareArtifacts } from './artifacts.mjs';
import { schemaInfo } from './schema.mjs';
import { assertSource } from './runner.mjs';
import { executorEnvironment } from './inputs.mjs';
import { signingFlags, verificationFlags } from './cosign.mjs';
const sha = 'a'.repeat(40),
	digest = `sha256:${'b'.repeat(64)}`;
const disabled = { ...config, publicationEnabled: false, deploymentEnabled: false };
const enabled = { ...disabled, publicationEnabled: true, gitProvider: `agents-release-${'a'.repeat(32)}:9418` };
const manifest = {
	version: '0.0.1-beta',
	sha,
	platform: 'linux/amd64',
	schema: schemaInfo(),
	images: Object.fromEntries(
		['agents', 'agents-sandbox'].map((n) => [n, { digest, ref: `${config.registry}/${n}@${digest}`, verified: true }]),
	),
};
const record = (m = manifest) => ({ logs: [{ stdout: `AGENTS_RELEASE_MANIFEST ${JSON.stringify(m)}` }] });
test('publication/deployment are disabled and even enabled publication cannot grant deployment', () => {
	expect(() => assertPublicationAllowed(disabled)).toThrow('bloqueada');
	expect(() => assertDeploymentAllowed(disabled)).toThrow('bloque');
	expect(() => assertDeploymentAllowed(enabled)).toThrow('bloque');
	expect(() => assertPublicationAllowed({ ...enabled, platform: 'linux/arm64' })).toThrow('linux/amd64');
});
test('versions, full commits and digests are validated without interpolating shell input', () => {
	for (const version of ['0.0.1-beta', '0.0.1-beta.1', '0.1.0-beta.2']) expect(assertVersion(version)).toBe(version);
	for (const version of ['1.0.0', '0.1.0', '0.01.0-beta', '0.0.1-beta;rm', '0.0.1-beta.01'])
		expect(() => assertVersion(version)).toThrow();
	expect(assertSha(sha)).toBe(sha);
	expect(requireDigest(digest)).toBe(digest);
	expect(() => assertSha('c655568')).toThrow();
	expect(() => requireDigest('latest')).toThrow();
});
test('manifest requires exact SHA/version/platform, both immutable refs and successful verification', () => {
	expect(manifestFrom(record(), '0.0.1-beta', sha)).toEqual(manifest);
	for (const patch of [
		{ sha: 'c'.repeat(40) },
		{ version: '0.1.0-beta' },
		{ platform: 'linux/arm64' },
		{ images: {} },
		{ schema: { files: [], sha256: 'c'.repeat(64) } },
	])
		expect(() => manifestFrom(record({ ...manifest, ...patch }), '0.0.1-beta', sha)).toThrow();
	const bad = structuredClone(manifest);
	bad.images.agents.verified = false;
	expect(() => manifestFrom(record(bad), '0.0.1-beta', sha)).toThrow('Firma');
	expect(() => manifestFrom({ logs: [] }, '0.0.1-beta', sha)).toThrow('exactamente');
	expect(() => manifestFrom({ logs: [...record().logs, ...record().logs] }, '0.0.1-beta', sha)).toThrow('exactamente');
});
test('publication gate runs before any Komodo request', async () => {
	const calls: unknown[] = [];
	await expect(
		prepareArtifacts({ request: (...a: unknown[]) => calls.push(a) }, '0.0.1-beta', sha, disabled),
	).rejects.toThrow('bloqueada');
	expect(calls).toEqual([]);
});
test('first failed build prevents sandbox, signing, publishing and deployment', async () => {
	const calls: string[] = [];
	const client = {
		request: async (_route: string, type: string) => {
			calls.push(type);
		},
		execute: async (type: string) => {
			calls.push(type);
			throw new Error('build failed');
		},
	};
	await expect(prepareArtifacts(client, '0.0.1-beta', sha, enabled)).rejects.toThrow('build failed');
	expect(calls).toEqual(['UpdateBuild', 'RunBuild']);
});
test('builds pin full SHA/amd64 and explicit tags; only verified executor returns manifest; never deploys', async () => {
	const calls: { type: string; params: any }[] = [];
	const client = {
		request: async (_route: string, type: string, params: any) => {
			calls.push({ type, params });
		},
		execute: async (type: string, params: any) => {
			calls.push({ type, params });
			return type === 'RunBuild'
				? { commit_hash: sha.slice(0, 7), logs: [{ stdout: `AGENTS_RELEASE_SOURCE_SHA ${sha}` }] }
				: record();
		},
	};
	expect(await prepareArtifacts(client, '0.0.1-beta', sha, enabled)).toEqual(manifest);
	const builds = calls.filter((c) => c.type === 'UpdateBuild');
	expect(builds).toHaveLength(2);
	for (const c of builds) {
		expect(c.params.config.commit).toBe(sha);
		expect(c.params.config.extra_args).toEqual(['--platform', 'linux/amd64']);
		expect(c.params.config.auto_increment_version).toBe(false);
		expect(c.params.config.build_path).toBe(c.params.id === enabled.komodo.sandboxBuild ? 'sandbox' : '.');
		expect(c.params.config.dockerfile_path).toBe('Dockerfile');
		expect(c.params.config.pre_build.path).toBe(c.params.id === enabled.komodo.sandboxBuild ? '..' : '');
		expect(c.params.config.image_tag).toBe(sha);
		expect(c.params.config.include_commit_tag).toBe(false);
		expect(c.params.config.pre_build.command).toContain(sha);
	}
	expect(calls.filter((c) => c.type === 'CloneRepo')).toHaveLength(2);
	expect(calls.some((c) => /Deploy|Stack|Variable/.test(c.type))).toBe(false);
});
test('Git snapshots only use the private ephemeral runner; verify receives no private signing references', () => {
	const origin = `agents-release-${'c'.repeat(32)}:9418`;
	expect(assertSource(origin)).toBe(origin);
	for (const value of ['github.com', '127.0.0.1:22', `${origin};curl`, 'https://outside.invalid'])
		expect(() => assertSource(value)).toThrow();
	const verify = executorEnvironment('0.0.1-beta', sha, 'verify');
	expect(verify).not.toContain('COSIGN_PRIVATE');
	expect(verify).not.toContain('COSIGN_PASSWORD');
	expect(executorEnvironment('0.0.1-beta', sha, 'sign')).toContain('COSIGN_PRIVATE_KEY_B64=[[COSIGN_PRIVATE_KEY_B64]]');
});
test('Cosign 3 private signing disables new default config explicitly, without dropping signature validation', () => {
	expect(signingFlags(false)).toContain('--use-signing-config=false');
	expect(signingFlags(false)).toContain('--tlog-upload=false');
	expect(signingFlags(true)).toContain('--tlog-upload=true');
	expect(verificationFlags(false)).toContain('--insecure-ignore-tlog=true');
	expect(verificationFlags(false)).not.toContain('--registry-referrers-mode=legacy');
	expect(verificationFlags(true)).not.toContain('--insecure-ignore-tlog=true');
	expect(() => signingFlags(null)).toThrow('Rekor');
});
test('Komodo short hash is not sufficient without one clean full-source proof', async () => {
	for (const logs of [
		[],
		[{ stdout: `AGENTS_RELEASE_SOURCE_SHA ${'c'.repeat(40)}` }],
		[{ stdout: `AGENTS_RELEASE_SOURCE_SHA ${sha}\nAGENTS_RELEASE_SOURCE_SHA ${sha}` }],
	]) {
		const client = { request: async () => {}, execute: async () => ({ commit_hash: sha.slice(0, 7), logs }) };
		await expect(prepareArtifacts(client, '0.0.1-beta', sha, enabled)).rejects.toThrow('SHA completo');
	}
});
test('Komodo authenticates with key AND secret headers, polls completion, logs and redacts', async () => {
	const messages: string[] = [],
		requests: any[] = [];
	const replies = [
		{ _id: 'op', status: 'InProgress' },
		{ _id: 'op', status: 'InProgress' },
		{ _id: 'op', status: 'Complete', success: true, logs: [{ stdout: 'key-test secret-test done' }] },
	];
	const client = new Komodo({
		url: 'https://example.test',
		key: 'key-test',
		secret: 'secret-test',
		sleep: async () => {},
		emit: (s: string) => messages.push(s),
		fetcher: async (_url: string, options: any) => {
			requests.push(options);
			return Response.json(replies.shift());
		},
	});
	expect((await client.execute('RunBuild', { build: 'candidate' })).success).toBe(true);
	expect(requests[0].headers['X-Api-Key']).toBe('key-test');
	expect(requests[0].headers['X-Api-Secret']).toBe('secret-test');
	expect(messages.join('')).not.toContain('key-test');
	expect(messages.join('')).not.toContain('secret-test');
});
test('Komodo rejects failed, unknown, malformed and timed-out operations; never assumes success', async () => {
	for (const reply of [
		{ _id: 'op', status: 'Complete', success: false },
		{ _id: 'op', status: 'Complete' },
		{ _id: 'op', status: 'Mystery' },
		{},
	]) {
		const c = new Komodo({
			url: 'https://example.test',
			key: 'key-test',
			secret: 'secret-test',
			emit: () => {},
			fetcher: async () => Response.json(reply),
		});
		await expect(c.execute('RunBuild', {})).rejects.toThrow();
	}
	let time = 0;
	const c = new Komodo({
		url: 'https://example.test',
		key: 'key-test',
		secret: 'secret-test',
		emit: () => {},
		now: () => time,
		sleep: async () => {
			time += 100;
		},
		fetcher: async () => Response.json({ _id: 'op', status: 'InProgress' }),
	});
	await expect(c.execute('RunBuild', {}, { timeoutMs: 150, pollMs: 1 })).rejects.toThrow('puede seguir');
	expect(() => new Komodo({ url: 'http://example.test', key: 'x', secret: 'y' })).toThrow('HTTPS');
});
