import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	defaultHarness,
	validateHarness,
	runtimeToolNames,
	harnessInstructions,
	mcpAllowed,
	type DelegationTemplate,
} from '../../sandbox/harness';
import { fileDenial, textStats, jsonInfo } from '../../sandbox/harness-policy';
import { definition, proposalDigest, harnessHash } from './harnesses';
import { parseDesignReply } from './design-format';
test('manifest normalization is deterministic and preserves the legacy capability ceiling', () => {
	const h = defaultHarness();
	expect(validateHarness(h)).toEqual(h);
	expect(runtimeToolNames(h)).toEqual(['bash', 'browser', 'edit', 'login', 'read', 'request_help', 'write']);
	expect(harnessHash({ ...h, tools: [...h.tools].reverse() })).toBe(harnessHash(h));
	expect(defaultHarness()).not.toBe(h);
});
test('rejects unknown capabilities, platform permission changes, executable plugins and ambiguous versions', () => {
	const h = defaultHarness();
	for (const value of [
		{ ...h, network: '*' },
		{ ...h, credentials: ['new'] },
		{ ...h, tools: [...h.tools, 'codemode'] },
		{ ...h, tools: ['read'] },
		{ ...h, plugins: [{ id: 'text-utils', version: 'latest' }] },
		{ ...h, plugins: [{ id: 'npm:untrusted', version: '1.0.0' }] },
		{ ...h, plugins: [{ id: 'text-utils', version: '1.0.0', code: 'process.exit()' }] },
		{ ...h, restrictions: { ...h.restrictions, quota: 99 } },
	])
		expect(() => validateHarness(value)).toThrow();
});
test('rejects shell bypass of file restrictions and inconsistent read-only tools', () => {
	const h = defaultHarness();
	expect(() => validateHarness({ ...h, restrictions: { ...h.restrictions, workspaceFilesOnly: true } })).toThrow(
		'bash',
	);
	expect(() => validateHarness({ ...h, restrictions: { ...h.restrictions, readOnlyFiles: true } })).toThrow('bash');
	expect(() =>
		validateHarness({
			...h,
			tools: h.tools.filter((t) => t !== 'bash'),
			restrictions: { ...h.restrictions, readOnlyFiles: true },
		}),
	).toThrow('write');
	expect(
		validateHarness({
			...h,
			tools: ['read', 'request_help'],
			restrictions: { ...h.restrictions, workspaceFilesOnly: true, readOnlyFiles: true },
		}).restrictions.readOnlyFiles,
	).toBe(true);
});
test('skills and guidelines are bounded data with safe names, not code or package references', () => {
	const h = defaultHarness(),
		skill = { name: 'research', description: 'Revisar fuentes.', instructions: '## Pasos\nCompara citas.' };
	expect(validateHarness({ ...h, skills: [skill] }).skills).toEqual([skill]);
	for (const skills of [
		[{ ...skill, name: '../../escape' }],
		[skill, skill],
		[{ ...skill, instructions: 'x'.repeat(8001) }],
		Array.from({ length: 5 }, (_, i) => ({ ...skill, name: `skill-${i}` })),
		[{ ...skill, script: 'evil' }],
	])
		expect(() => validateHarness({ ...h, skills })).toThrow();
	expect(() => validateHarness({ ...h, restrictions: { ...h.restrictions, guidelines: ['x'.repeat(501)] } })).toThrow();
	expect(harnessInstructions({ ...h, skills: [skill] })).toContain(skill.instructions);
});
test('file policy resolves symlinks, dangling links and new parents, and rejects read-only screenshots', () => {
	const dir = mkdtempSync(join(tmpdir(), 'harness-policy-')),
		work = join(dir, 'work'),
		outside = join(dir, 'outside');
	mkdirSync(work);
	mkdirSync(outside);
	writeFileSync(join(outside, 'secret'), 'test');
	symlinkSync(outside, join(work, 'link'));
	symlinkSync(join(outside, 'missing'), join(work, 'dangling'));
	const h = validateHarness({
		...defaultHarness(),
		tools: ['read', 'write', 'request_help'],
		restrictions: { workspaceFilesOnly: true, readOnlyFiles: false, guidelines: [] },
	});
	try {
		for (const path of [
			'../outside/secret',
			join(work, 'link', 'secret'),
			join(work, 'link', 'new', 'file'),
			join(work, 'dangling'),
			join(work, 'dangling', 'child'),
		])
			expect(fileDenial(h, 'write', { path }, work, work)).not.toBeNull();
		expect(fileDenial(h, 'write', { path: 'nested/new.txt' }, work, work)).toBeNull();
		expect(fileDenial(h, 'ls', {}, outside, work)).not.toBeNull();
		const ro = validateHarness({
			...h,
			tools: ['read', 'request_help'],
			restrictions: { ...h.restrictions, readOnlyFiles: true },
		});
		for (const name of ['write', 'edit', 'browser_screenshot'])
			expect(fileDenial(ro, name, { path: 'out/x' }, work, work)).toContain('lectura');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
test('pinned pure plugins handle Unicode and invalid JSON without executing data', () => {
	expect(textStats('hola 👋\nmundo')).toEqual({ characters: 12, words: 3, lines: 2 });
	expect(jsonInfo('{"a":1}')).toEqual({ valid: true, type: 'object', count: 1 });
	expect(jsonInfo('process.exit()').valid).toBe(false);
	expect(jsonInfo('null').type).toBe('null');
	const h = validateHarness({
		...defaultHarness(),
		plugins: [
			{ id: 'text-utils', version: '1.0.0' },
			{ id: 'json-utils', version: '1.0.0' },
		],
	});
	expect(runtimeToolNames(h)).toContain('text_stats');
	expect(runtimeToolNames(h)).toContain('json_validate');
});
test('definition and approval digests bind model, contract, harness and the exact proposal revision', () => {
	const a = {
		config_revision: 3,
		name: 'A',
		role: 'Original',
		model: 'openai/gpt-6-sol',
		harness: defaultHarness(),
		harness_image: 'sha256:test',
	};
	const first = definition(a);
	a.role = 'Changed';
	a.harness.skills.push({ name: 'new', description: 'Nueva', instructions: 'Pasos' });
	expect(first.role).toBe('Original');
	expect(first.harness.skills).toEqual([]);
	expect(definition(a).digest).not.toBe(first.digest);
	const p = { version: 1, model: a.model, contract: { name: a.name, prompt: a.role }, harness: a.harness };
	expect(proposalDigest({ ...p, version: 2 })).not.toBe(proposalDigest(p));
	expect(proposalDigest({ ...p, model: 'openai/other' })).not.toBe(proposalDigest(p));
});
test('designer returns harness as validated data and cannot smuggle code or privileges into the proposal', () => {
	const reply = (h: unknown) => ({
		status: 'completed',
		output: [
			{
				type: 'message',
				role: 'assistant',
				content: [
					{
						type: 'output_text',
						text: JSON.stringify({
							message: 'Revisa',
							contract: { name: 'A', prompt: 'Rol' },
							harness: h,
							ready: true,
						}),
					},
				],
			},
		],
	});
	expect(parseDesignReply(reply(defaultHarness())).harness).toEqual(defaultHarness());
	expect(() => parseDesignReply(reply({ ...defaultHarness(), plugins: [{ id: 'evil', version: '1.0.0' }] }))).toThrow();
});
test('MCP servers and CLI installs are optional: without them the manifest and its digest do not change', () => {
	const base = validateHarness(defaultHarness());
	expect(validateHarness({ ...base, mcp: [], installs: [] })).toEqual(base);
	expect(harnessHash({ ...base, mcp: [], installs: [] })).toBe(harnessHash(base));
});
test('MCP servers: http with URL and headers, stdio with a bare command; only their prefixes pass', () => {
	const http = {
		name: 'linear',
		description: 'Tickets',
		transport: 'http',
		url: 'https://mcp.linear.app/mcp',
		command: null,
		args: [],
		headers: [],
		env: [],
		oauth: true,
	};
	const stdio = {
		name: 'git-hub',
		description: 'Repos',
		transport: 'stdio',
		url: null,
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-github'],
		headers: [],
		env: [{ name: 'GITHUB_TOKEN', value: '${GITHUB_TOKEN}' }],
		oauth: false,
	};
	const h = validateHarness({ ...defaultHarness(), mcp: [stdio, http] });
	expect(h.mcp!.map((s) => s.name)).toEqual(['git-hub', 'linear']);
	expect(mcpAllowed(h, 'mcp__git_hub__create_issue')).toBe(true);
	expect(mcpAllowed(h, 'mcp__other__x')).toBe(false);
	expect(mcpAllowed(h, 'bash')).toBe(false);
	expect(() => validateHarness({ ...defaultHarness(), mcp: [{ ...stdio, command: '/bin/sh' }] })).toThrow('sin ruta');
	expect(() =>
		validateHarness({
			...defaultHarness(),
			mcp: [{ ...http, headers: [{ name: 'Authorization', value: 'Bearer ${T}' }] }],
		}),
	).toThrow('OAuth o un token');
	expect(() => validateHarness({ ...defaultHarness(), tools: ['request_help', 'read'], mcp: [stdio] })).toThrow(
		'requiere bash',
	);
	expect(() => validateHarness({ ...defaultHarness(), mcp: [http, { ...http, name: 'linear' }] })).toThrow('repetidos');
});
test('CLI installs are pinned: npm name@version, uv name==version, binaries by https with sha256', () => {
	const ok = validateHarness({
		...defaultHarness(),
		installs: [
			{ kind: 'npm', spec: '@vercel/cli@39.1.0', name: null, sha256: null },
			{ kind: 'uv', spec: 'httpie==3.2.4', name: null, sha256: null },
			{ kind: 'binary', spec: 'https://example.com/gh', name: 'gh', sha256: 'a'.repeat(64) },
		],
	});
	expect(ok.installs!.length).toBe(3);
	for (const bad of [
		{ kind: 'npm', spec: 'vercel', name: null, sha256: null },
		{ kind: 'npm', spec: 'vercel@latest', name: null, sha256: null },
		{ kind: 'uv', spec: 'httpie', name: null, sha256: null },
		{ kind: 'binary', spec: 'http://x/gh', name: 'gh', sha256: 'a'.repeat(64) },
		{ kind: 'binary', spec: 'https://x/gh', name: 'gh', sha256: null },
	])
		expect(() => validateHarness({ ...defaultHarness(), installs: [bad] })).toThrow('instalación inválida');
});

test('encargos: templates validated and sorted, their tools named for pi, the tool needs a template', () => {
	const template: DelegationTemplate = {
		name: 'cotizar',
		description: 'Cotiza con un contacto externo.',
		objective: 'Cotiza {lista} con entrega el {fecha}.',
		intro: 'Buen día, le escribo de parte de {dueno}.',
		rules: ['No aceptes más de {tope} por kilo.'],
		collect: { list: true, fields: [{ name: 'precio_kg', description: 'Pesos por kilo', type: 'number' }] },
		escalate: ['Si pide anticipo.'],
		files: true,
		maxMessages: 10,
		maxHours: 48,
	};
	const base = { ...defaultHarness(), tools: [...defaultHarness().tools, 'delegations'] };
	const h = validateHarness({ ...base, delegations: [template] });
	expect(h.delegations).toEqual([template]);
	expect(runtimeToolNames(h)).toEqual(
		expect.arrayContaining(['delegation_cancel', 'delegation_message', 'delegation_start', 'delegation_status']),
	);
	expect(runtimeToolNames(h)).not.toContain('delegations');
	expect(harnessInstructions(h)).toContain(
		'- cotizar: Cotiza con un contacto externo. Parámetros: lista, fecha, dueno, tope.',
	);
	// Without a cap of messages (null): valid, its hours still bound it.
	expect(
		validateHarness({ ...base, delegations: [{ ...template, maxMessages: null }] }).delegations?.[0].maxMessages,
	).toBeNull();
	// Empty is omitted: an agent without encargos keeps its digest.
	expect('delegations' in validateHarness({ ...defaultHarness(), delegations: [] })).toBe(false);
	expect(() => validateHarness(base)).toThrow('al menos una plantilla');
	for (const bad of [
		{ ...template, name: 'Cotizar' },
		{ ...template, maxMessages: 0 },
		{ ...template, maxHours: 500 },
		{ ...template, collect: { list: false, fields: [] } },
		{ ...template, collect: { list: false, fields: [{ name: 'x', description: 'y', type: 'date' }] } },
		{ ...template, extra: true },
		{ ...template, files: 'sí' },
	])
		expect(() => validateHarness({ ...base, delegations: [bad] })).toThrow('Harness');
});

test('flujos: a recipe is checked against what the contract has, steps only depend on earlier ones', () => {
	const template: DelegationTemplate = {
		name: 'cotizar',
		description: 'Cotiza.',
		objective: 'Cotiza {lista}.',
		intro: 'Hola.',
		rules: [],
		collect: { list: false, fields: [{ name: 'precio', description: 'Pesos', type: 'number' }] },
		escalate: [],
		files: false,
		maxMessages: 5,
		maxHours: 24,
	};
	const step = (key: string, kind: string, depends: string[] = [], extra: Record<string, unknown> = {}) => ({
		key,
		title: key,
		kind,
		depends,
		instructions: kind === 'delegation' || kind === 'wait' ? '' : `Haz ${key}.`,
		optional: false,
		hours: kind === 'wait' ? 2 : null,
		delegation:
			kind === 'delegation'
				? { template: 'cotizar', contact: 'Carnicería', params: [{ name: 'lista', value: '{lista}' }] }
				: null,
		...extra,
	});
	const recipe = {
		name: 'carrito',
		description: 'El carrito de la semana.',
		objective: 'Arma el carrito de la semana {semana}.',
		produces: { list: true, fields: [{ name: 'producto', description: 'Qué', type: 'text' }] },
		steps: [
			step('heb', 'subagent'),
			step('carne', 'delegation'),
			step('armar', 'agent', ['heb', 'carne']),
			step('ok', 'question', ['armar']),
		],
		maxHours: 48,
		maxDelegations: 2,
		maxWakes: 10,
	};
	const base = {
		...defaultHarness(),
		tools: [...defaultHarness().tools, 'delegations', 'flows', 'subagents'],
		delegations: [template],
	};
	const h = validateHarness({ ...base, flows: [recipe] });
	expect(h.flows![0].steps.map((s) => s.key)).toEqual(['heb', 'carne', 'armar', 'ok']);
	// Recipes only preload a list: the task tools are the platform's, never the harness's.
	expect(runtimeToolNames(h).filter((n) => /^(flow|task)_/.test(n))).toEqual([]);
	expect(harnessInstructions(h)).toContain('### Recetas');
	// Up to 12 tasks, like any list.
	expect(() =>
		validateHarness({
			...base,
			flows: [{ ...recipe, steps: Array.from({ length: 13 }, (_, i) => step(`t${i}`, 'agent')) }],
		}),
	).toThrow('de 1 a 12 tareas');
	expect(harnessInstructions(h)).toContain('- carrito: El carrito de la semana. Parámetros: semana, lista.');
	expect(() => validateHarness({ ...base, flows: [] })).toThrow('al menos una receta');
	const bad: [unknown[], string][] = [
		[[step('a', 'agent', ['b']), step('b', 'agent')], 'pasos anteriores'], // a cycle cannot even be written
		[[step('a', 'agent'), step('a', 'agent')], 'repetido'],
		[
			[step('a', 'delegation', [], { delegation: { template: 'otra', contact: '', params: [] } })],
			'plantilla de encargo',
		],
		[[step('a', 'wait', [], { hours: 500 })], '1 a 168'],
		[
			[step('a', 'agent', [], { delegation: { template: 'cotizar', contact: '', params: [] } })],
			'sólo un paso delegation',
		],
		[[step('a', 'delegation'), step('b', 'delegation'), step('c', 'delegation')], 'tope'],
	];
	for (const [steps, message] of bad)
		expect(() => validateHarness({ ...base, flows: [{ ...recipe, steps }] })).toThrow(message);
	// A subagent step needs the subagents tool.
	expect(() =>
		validateHarness({ ...base, tools: base.tools.filter((t) => t !== 'subagents'), flows: [recipe] }),
	).toThrow('subagents');
});

test("encargos: the turn's schema uses JSON Schema types (a template's text is a string)", async () => {
	const { turnSchema } = await import('./delegations');
	const schema = turnSchema({
		name: 'x',
		description: 'x',
		objective: 'x',
		intro: 'x',
		rules: [],
		collect: {
			list: true,
			fields: [
				{ name: 'a', description: 'a', type: 'text' },
				{ name: 'b', description: 'b', type: 'number' },
				{ name: 'c', description: 'c', type: 'boolean' },
			],
		},
		escalate: [],
		files: false,
		maxMessages: 1,
		maxHours: 1,
	}) as { properties: { data: { items: { properties: Record<string, { type: string[] }> } } } };
	const types = Object.values(schema.properties.data.items.properties).map((p) => p.type[0]);
	expect(types).toEqual(['string', 'number', 'boolean']);
	// Every JSON Schema type GPT takes; «text» was the 400 of 5-nov-2026.
	for (const t of types) expect(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']).toContain(t);
});

test('rúbrica: the owner weighs the platform criteria, 0 turns one off, a default weight is not kept', async () => {
	const { RUBRIC, rubricOf } = await import('../../sandbox/harness');
	const h = validateHarness({
		...defaultHarness(),
		rubric: [
			{ key: 'cost', weight: 5 },
			{ key: 'third_parties', weight: 0 },
			{ key: 'correct', weight: 5 }, // its default: not kept
		],
	});
	expect(h.rubric).toEqual([
		{ key: 'cost', weight: 5 },
		{ key: 'third_parties', weight: 0 },
	]);
	const weights = Object.fromEntries(rubricOf(h).map((c) => [c.key, c.weight]));
	expect(weights).toMatchObject({ cost: 5, third_parties: 0, correct: 5, honesty: 5 });
	expect(rubricOf(h)).toHaveLength(RUBRIC.length);
	expect('rubric' in validateHarness({ ...defaultHarness(), rubric: [] })).toBe(false);
	for (const bad of [
		[{ key: 'nope', weight: 1 }],
		[{ key: 'cost', weight: 9 }],
		[
			{ key: 'cost', weight: 1 },
			{ key: 'cost', weight: 2 },
		],
	])
		expect(() => validateHarness({ ...defaultHarness(), rubric: bad })).toThrow('Harness');
});
