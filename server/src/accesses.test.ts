import { beforeAll, expect, test } from 'bun:test';
import { domainMatches, normalizeDomains, placeholder } from './accesses';
import { grantedSection } from './prompt';

test('domains: normalized from URLs, wildcards match subdomains only, bad hosts rejected', () => {
	expect(normalizeDomains('https://API.github.com/x, github.com  api.github.com')).toEqual([
		'api.github.com',
		'github.com',
	]);
	expect(normalizeDomains(['*.Example.com'])).toEqual(['*.example.com']);
	expect(() => normalizeDomains('localhost')).toThrow();
	expect(() => normalizeDomains('not a host!')).toThrow();
	expect(domainMatches('api.github.com', 'api.github.com')).toBe(true);
	expect(domainMatches('evil-api.github.com', 'api.github.com')).toBe(false);
	expect(domainMatches('a.b.example.com', '*.example.com')).toBe(true);
	expect(domainMatches('example.com', '*.example.com')).toBe(false);
	expect(domainMatches('badexample.com', '*.example.com')).toBe(false);
});

test('placeholders: stable per run and field, different across runs, never the value', () => {
	expect(placeholder('t1', 'key:1')).toBe(placeholder('t1', 'key:1'));
	expect(placeholder('t1', 'key:1')).not.toBe(placeholder('t2', 'key:1'));
	expect(placeholder('t1', 'key:1')).toMatch(/^agk_[0-9a-f]{40}$/);
});

test('the prompt names keys and domains, never values', () => {
	const text = grantedSection({
		keys: [
			{ name: 'GITHUB_TOKEN', domains: ['api.github.com'], expose_real: false },
			{ name: 'PGPASSWORD', domains: [], expose_real: true },
		],
		mcp: [{ name: 'linear', description: 'Tickets' }],
	});
	expect(text).toContain('`GITHUB_TOKEN` (sólo hacia api.github.com)');
	expect(text).toContain('`PGPASSWORD`');
	expect(text).toContain('`linear` (Tickets)');
	expect(grantedSection({ keys: [], mcp: [] })).toBe('');
});

// Against the throwaway database (AGENTS_TEST_DATABASE_URL), like the other DB tests.
const url = process.env.AGENTS_TEST_DATABASE_URL;
const run = url ? test : test.skip;
process.env.AGENTS_DATA ??= '/tmp';
process.env.AGENTS_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
const db = url ? await import('./db') : null;
let ana = 0,
	beto = 0,
	anaA = 0,
	anaB = 0,
	betoA = 0;
const tag = crypto.randomUUID().slice(0, 8);

beforeAll(async () => {
	if (!db || !url) return;
	const { assertTestDatabase } = await import('./test-database');
	assertTestDatabase(url, db.DATABASE_URL);
	assertTestDatabase(url, db.DATABASE_URL, (await db.row<{ name: string }>('select current_database() as name'))!.name);
	await db.migrate();
	const { create } = await import('./agents');
	const { settings } = await import('./settings');
	const model = settings().models[0].id;
	const person = async (n: string) =>
		(await db.row<{ id: number }>('insert into people (name, key, avatar_seed) values ($1, $2, $3) returning id', [
			`${n}-${tag}`,
			`acc-${n}-${tag}`,
			's',
		]))!.id;
	ana = await person('ana');
	beto = await person('beto');
	anaA = (await create(ana, { name: `a-${tag}`, model })).id;
	anaB = (await create(ana, { name: `b-${tag}`, model })).id;
	betoA = (await create(beto, { name: `c-${tag}`, model })).id;
});

async function liveRun(agentId: number, personId: number) {
	const conv = (await db!.row<{ id: number }>('select id from conversations where agent_id = $1', [agentId]))!;
	return (await db!.row<{ id: number }>(
		`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status)
		 values ($1, $2, $3, $4, 'openai/x', 'running') returning id`,
		[agentId, personId, conv.id, `acc-${crypto.randomUUID()}`],
	))!.id;
}

run('keys: domains or «valor real» required; grants only to the owner’s own agents', async () => {
	const a = await import('./accesses');
	await expect(a.saveKey(ana, { name: 'GH_TOKEN', value: 'ghp_x' })).rejects.toThrow(/dominios/);
	await expect(a.saveKey(ana, { name: 'PATH', value: 'x', exposeReal: true })).rejects.toThrow(/plataforma/);
	let keys = await a.saveKey(ana, { name: 'GH_TOKEN', value: 'ghp_real', domains: 'api.github.com' });
	const gh = keys.find((k) => k.name === 'GH_TOKEN')!;
	expect(gh.domains).toEqual(['api.github.com']);
	// Without a value, an existing key keeps its own; and only Ana's agents can be granted.
	keys = await a.saveKey(ana, { name: 'gh_token', domains: ['api.github.com', 'github.com'] });
	keys = await a.grantKey(ana, gh.id, [anaA, betoA]);
	expect(keys.find((k) => k.id === gh.id)!.agents).toEqual([anaA]);
	await expect(a.grantKey(beto, gh.id, [betoA])).rejects.toThrow(/No existe/);
	await a.saveKey(ana, { name: 'PGPASSWORD', value: 'pg_real', exposeReal: true });
	const pg = (await a.listKeys(ana)).find((k) => k.name === 'PGPASSWORD')!;
	await a.grantKey(ana, pg.id, [anaA]);
});

run('a run gets placeholders bound to domains, real values only when exposed, and its own secret wins', async () => {
	const a = await import('./accesses');
	const runId = await liveRun(anaA, ana);
	const token = await a.issueProxyToken(runId);
	const got = await a.forRun(anaA, token, { PGPASSWORD: 'own_wins' });
	expect(got.env.GH_TOKEN).toBe(
		placeholder(token, `key:${(await a.listKeys(ana)).find((k) => k.name === 'GH_TOKEN')!.id}`),
	);
	expect(got.env.PGPASSWORD).toBe('own_wins');
	expect(JSON.stringify(got)).not.toContain('ghp_real');
	// Without a proxy, a domain-bound key is not delivered at all (a placeholder would reach nobody).
	expect((await a.forRun(anaA, null, {})).env).toEqual({ PGPASSWORD: 'pg_real' });
	// The proxy, with the run's token: the value, only for its domains. A finished run gets nothing.
	const rules = (await a.rulesFor(token))!;
	expect(rules).toEqual([
		{ domains: ['api.github.com', 'github.com'], placeholder: got.env.GH_TOKEN, value: 'ghp_real' },
	]);
	await db!.exec("update runs set status = 'done' where id = $1", [runId]);
	expect(await a.rulesFor(token)).toBeNull();
	expect(await a.rulesFor('not-a-token')).toBeNull();
	// An agent it was not granted to gets nothing.
	expect((await a.forRun(anaB, token, {})).env).toEqual({});
});

run('MCP: secret header as a placeholder bound to its URL host; revoking signs the agent out', async () => {
	const a = await import('./accesses');
	await expect(a.saveMcp(ana, { name: 'Bad Name', transport: 'http', url: 'https://x.dev' })).rejects.toThrow();
	let list = await a.saveMcp(ana, {
		name: 'tickets',
		description: 'Tickets',
		transport: 'http',
		url: 'https://mcp.tickets.dev/mcp',
		headers: [
			{ name: 'Authorization', value: 'Bearer tk_real', secret: true },
			{ name: 'X-Team', value: 'cuby', secret: false },
		],
	});
	const m = list.find((x) => x.name === 'tickets')!;
	expect(m.domains).toEqual(['mcp.tickets.dev']);
	expect(m.headers).toEqual([
		{ name: 'Authorization', secret: true, value: null },
		{ name: 'X-Team', secret: false, value: 'cuby' },
	]);
	// Saving again without the secret's value keeps it.
	list = await a.saveMcp(ana, {
		name: 'tickets',
		description: 'Tickets v2',
		transport: 'http',
		url: 'https://mcp.tickets.dev/mcp',
		headers: [{ name: 'Authorization', secret: true }],
	});
	await a.grantMcp(ana, m.id, [anaB]);
	const runId = await liveRun(anaB, ana);
	const token = await a.issueProxyToken(runId);
	const got = await a.forRun(anaB, token, {});
	expect(got.grantedMcp).toHaveLength(1);
	const auth = got.grantedMcp[0].headers[0];
	expect(auth.value).toMatch(/^agk_/);
	expect((await a.rulesFor(token))!).toContainEqual({
		domains: ['mcp.tickets.dev'],
		placeholder: auth.value,
		value: 'Bearer tk_real',
	});
	expect((await a.grantedTo(anaB)).mcp).toEqual([{ name: 'tickets', description: 'Tickets v2' }]);
	await a.grantMcp(ana, m.id, []);
	expect((await a.pendingLogouts(anaB)).map((l) => l.server)).toEqual(['tickets']);
	await a.logoutsDone(
		anaB,
		(await a.pendingLogouts(anaB)).map((l) => l.id),
	);
	expect(await a.pendingLogouts(anaB)).toEqual([]);
});

run('migration: same value moves to the person, different values stay on the agents to resolve', async () => {
	const a = await import('./accesses');
	const { seal } = await import('./crypto');
	const put = (agent: number, name: string, value: string) =>
		db!.exec('insert into agent_secrets (agent_id, name, value_enc) values ($1, $2, $3)', [agent, name, seal(value)]);
	await put(anaA, `SAME_${tag.toUpperCase()}`, 'v1');
	await put(anaB, `SAME_${tag.toUpperCase()}`, 'v1');
	await put(anaA, `DIFF_${tag.toUpperCase()}`, 'one');
	await put(anaB, `DIFF_${tag.toUpperCase()}`, 'two');
	const moved = await a.migrateAgentSecrets();
	expect(moved.migrated).toBeGreaterThanOrEqual(1);
	expect(moved.conflicts).toBeGreaterThanOrEqual(1);
	const same = (await a.listKeys(ana)).find((k) => k.name === `SAME_${tag.toUpperCase()}`)!;
	expect(same.expose_real).toBe(true);
	expect(same.agents).toEqual([anaA, anaB].sort((x, y) => x - y));
	expect((await a.conflictsOf(anaA)).map((s) => s.name)).toEqual([`DIFF_${tag.toUpperCase()}`]);
	// Running it again changes nothing; then Ana keeps agent B's value.
	await a.migrateAgentSecrets();
	await a.resolveConflict(ana, `DIFF_${tag.toUpperCase()}`, anaB);
	expect(await a.conflictsOf(anaA)).toEqual([]);
	const diff = (await a.listKeys(ana)).find((k) => k.name === `DIFF_${tag.toUpperCase()}`)!;
	expect(diff.agents).toEqual([anaA, anaB].sort((x, y) => x - y));
	expect((await a.forRun(anaA, null, {})).env[`DIFF_${tag.toUpperCase()}`]).toBe('two');
});
