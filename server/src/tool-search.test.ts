import { afterEach, expect, test } from 'bun:test';
import { mcpSlug, searchMcp, searchCli } from './tool-search';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});
const serve = (body: unknown) => {
	globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch;
};

test('registry names become MCP server slugs', () => {
	expect(mcpSlug('io.github.acme/Docs_Server')).toBe('docs-server');
	expect(mcpSlug('ai.smithery/123-tool')).toBe('tool');
	expect(mcpSlug('x/' + 'a'.repeat(50)).length).toBe(31);
});

test('MCP registry: a remote keeps its secret header template; a package runs pinned, with its variables', async () => {
	serve({
		servers: [
			{
				server: {
					name: 'io.acme/remote',
					description: 'Remoto',
					version: '1.2.0',
					remotes: [
						{
							type: 'streamable-http',
							url: 'https://mcp.acme.dev/mcp',
							headers: [{ name: 'Authorization', value: 'Bearer {api_key}', isSecret: true, description: 'Key' }],
						},
					],
				},
				_meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true } },
			},
			{
				server: { name: 'io.acme/remote', version: '1.0.0' },
				_meta: { 'io.modelcontextprotocol.registry/official': { isLatest: false } },
			},
			{
				server: {
					name: 'io.acme/local',
					description: 'Local',
					version: '0.3.0',
					packages: [
						{
							registryType: 'npm',
							identifier: '@acme/mcp',
							version: '0.3.0',
							transport: { type: 'stdio' },
							environmentVariables: [
								{ name: 'ACME_TOKEN', isSecret: true, isRequired: true, description: 'Token' },
								{ name: 'ACME_REGION', isRequired: true, default: 'us' },
								{ name: 'OPTIONAL', isRequired: false },
							],
						},
					],
				},
			},
			{ server: { name: 'io.acme/docker-only', packages: [{ registryType: 'oci', identifier: 'x', version: '1' }] } },
		],
	});
	const found = await searchMcp('acme-test');
	expect(found.map((f) => f.name)).toEqual(['io.acme/remote', 'io.acme/local']);
	expect(found[0].mcp).toEqual({ transport: 'http', url: 'https://mcp.acme.dev/mcp', oauth: false });
	expect(found[0].fields).toEqual([
		{
			name: 'Authorization',
			description: 'Key',
			secret: true,
			target: 'header',
			template: 'Bearer {api_key}',
			value: null,
		},
	]);
	expect(found[1].mcp).toEqual({ transport: 'stdio', command: 'npx', args: ['-y', '@acme/mcp@0.3.0'] });
	expect(found[1].fields.map((f) => [f.name, f.secret, f.value])).toEqual([
		['ACME_TOKEN', true, null],
		['ACME_REGION', false, 'us'],
	]);
});

test('npm search: packages with their exact version', async () => {
	serve({
		objects: [
			{ package: { name: 'pdf-cli', version: '2.1.0', description: 'PDF', links: { npm: 'https://npm/pdf-cli' } } },
		],
	});
	expect(await searchCli('pdf-test')).toEqual([
		{
			id: 'cli:pdf-cli',
			kind: 'cli',
			name: 'pdf-cli',
			title: 'pdf-cli',
			description: 'PDF',
			version: '2.1.0',
			url: 'https://npm/pdf-cli',
			fields: [],
		},
	]);
});
