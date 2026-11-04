// Giving an agent to someone else: a transfer moves it with its accesses (as the new owner's own copies,
// their same-named one used instead); a copy is a new agent with its configuration and no credentials.
// Against the throwaway database, like the other DB tests.
import { beforeAll, expect, test } from 'bun:test';

const url = process.env.AGENTS_TEST_DATABASE_URL;
const run = url ? test : test.skip;
process.env.AGENTS_DATA ??= '/tmp';
process.env.AGENTS_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
const db = url ? await import('./db') : null;
const tag = crypto.randomUUID().slice(0, 8);
let ana = 0,
	beto = 0,
	model = '';

beforeAll(async () => {
	if (!db || !url) return;
	const { assertTestDatabase } = await import('./test-database');
	assertTestDatabase(url, db.DATABASE_URL);
	await db.migrate();
	model = (await import('./settings')).settings().models[0].id;
	const person = async (n: string) =>
		(await db.row<{ id: number }>('insert into people (name, key, avatar_seed) values ($1, $2, $3) returning id', [
			`${n}-${tag}`,
			`tr-${n}-${tag}`,
			's',
		]))!.id;
	ana = await person('ana');
	beto = await person('beto');
});

run('transfer: the agent, its accesses as the new owner’s copies (a same-named one wins), shares gone', async () => {
	const agents = await import('./agents');
	const a = await import('./accesses');
	const vault = await import('./vault');
	const { transfer } = await import('./transfers');
	const agent = await agents.create(ana, { name: `t-${tag}`, model });
	// Ana grants it a key, an MCP server and a site login; Beto already has a key with that name.
	const key = (await a.saveKey(ana, { name: 'GH_TOKEN', value: 'ghp_ana', domains: 'api.github.com' })).find(
		(k) => k.name === 'GH_TOKEN',
	)!;
	await a.grantKey(ana, key.id, [agent.id]);
	await a.saveKey(beto, { name: 'GH_TOKEN', value: 'ghp_beto', domains: 'api.github.com' });
	const mcp = (
		await a.saveMcp(ana, { name: 'linear', description: 'Tickets', url: 'https://mcp.linear.app/mcp' })
	).find((m) => m.name === 'linear')!;
	await a.grantMcp(ana, mcp.id, [agent.id]);
	await vault.save(ana, {
		name: 'portal',
		loginUrl: 'https://portal.example.com/login',
		username: 'ana@x.mx',
		password: 's',
	});
	const site = (await vault.list(ana)).find((c) => c.name === 'portal')!;
	await vault.grant(ana, site.id, [agent.id]);
	const someone = (await db!.row<{ id: number }>(
		'insert into people (name, key, avatar_seed) values ($1, $2, $3) returning id',
		[`carla-${tag}`, `tr-carla-${tag}`, 's'],
	))!.id;
	await agents.setShares(agent, [someone]);

	await expect(transfer(agent, ana, ana)).rejects.toThrow(/tuyo/);
	await expect(transfer(agent, beto, beto)).rejects.toThrow(/dueño/);
	const r = await transfer(agent, beto, ana);
	expect(r.moved).toEqual({ keys: 1, mcp: 1, sites: 1 });
	expect(r.clashes).toEqual([{ kind: 'key', name: 'GH_TOKEN' }]);

	const moved = (await agents.get(agent.id))!;
	expect(moved.person_id).toBe(beto);
	expect(moved.shares).toEqual([]);
	const granted = await a.grantedTo(agent.id);
	expect(granted.keys.map((k) => k.name)).toEqual(['GH_TOKEN']);
	expect(granted.mcp.map((m) => m.name)).toEqual(['linear']);
	// What it gets now is Beto's: his own key (the clash) and copies of the MCP server and the site.
	const env = (await a.forRun(agent.id, null, {})).env;
	expect(env).toEqual({}); // with domains and no proxy nothing is handed over: placeholders only
	const owners = await db!.rows<{ person_id: number }>(
		`select k.person_id from person_keys k join person_key_grants g on g.key_id = k.id where g.agent_id = $1
		 union all select m.person_id from person_mcp m join person_mcp_grants g on g.mcp_id = m.id where g.agent_id = $1
		 union all select c.person_id from credentials c join credential_grants g on g.credential_id = c.id where g.agent_id = $1`,
		[agent.id],
	);
	expect(owners.every((o) => o.person_id === beto)).toBe(true);
	// Ana keeps hers, just no longer granted to it.
	expect((await a.listKeys(ana)).find((k) => k.name === 'GH_TOKEN')!.agents).toEqual([]);
	const log = await db!.row<{ kind: string; from_person: number; to_person: number }>(
		'select kind, from_person, to_person from agent_transfers where agent_id = $1',
		[agent.id],
	);
	expect(log).toEqual({ kind: 'transfer', from_person: ana, to_person: beto });
});

run('transfer: not while its computer is on', async () => {
	const agents = await import('./agents');
	const { transfer } = await import('./transfers');
	const agent = await agents.create(ana, { name: `busy-${tag}`, model });
	const conv = (await db!.row<{ id: number }>('select id from conversations where agent_id = $1', [agent.id]))!;
	await db!.exec(
		`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status, kind)
		 values ($1, $2, $3, $4, 'openai/x', 'running', 'browser')`,
		[agent.id, ana, conv.id, `tr-${crypto.randomUUID()}`],
	);
	await expect(transfer(agent, beto, ana)).rejects.toThrow(/computadora/);
	expect((await agents.get(agent.id))!.person_id).toBe(ana);
});

run('copy: a new agent for them with its configuration and none of its credentials', async () => {
	const agents = await import('./agents');
	const a = await import('./accesses');
	const { copy } = await import('./transfers');
	const { defaultHarness } = await import('./harnesses');
	const harness = {
		...defaultHarness(),
		restrictions: { ...defaultHarness().restrictions, guidelines: ['Sé breve.'] },
	};
	const original = await agents.create(ana, { name: `c-${tag}`, role: 'Cotiza envíos.', model, harness });
	const key = (await a.saveKey(ana, { name: 'SHIP_KEY', value: 'k', exposeReal: true })).find(
		(k) => k.name === 'SHIP_KEY',
	)!;
	await a.grantKey(ana, key.id, [original.id]);

	const forBeto = await copy(original, beto, ana);
	const made = (await agents.get(forBeto.agent.id))!;
	expect(made.person_id).toBe(beto);
	expect(made.name).toBe(original.name);
	expect(made.role).toBe('Cotiza envíos.');
	expect(made.harness).toEqual(original.harness);
	expect(await a.grantedTo(made.id)).toEqual({ keys: [], mcp: [] });
	// The original keeps everything; a copy for oneself is named so.
	expect((await a.grantedTo(original.id)).keys.map((k) => k.name)).toEqual(['SHIP_KEY']);
	expect((await copy(original, ana, ana)).agent.name).toBe(`${original.name} (copia)`);
	await expect(copy(original, beto, beto)).rejects.toThrow(/dueño/);
});
