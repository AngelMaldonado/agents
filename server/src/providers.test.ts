import { afterAll, beforeAll, expect, test } from 'bun:test';

// Against a throwaway database (AGENTS_TEST_DATABASE_URL, never the dev one): `just dev test`
// runs this inside the dev server container. No real provider or Docker calls.
const url = process.env.AGENTS_TEST_DATABASE_URL;
const run = url ? test : test.skip;
if (!url) console.warn('AGENTS_TEST_DATABASE_URL is not set: skipping (run `just dev test`).');
process.env.AGENTS_DATABASE_URL = url ?? 'postgres://unused';
process.env.AGENTS_DATA = '/tmp';
process.env.AGENTS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const { pool, migrate, exec, row } = await import('./db');
const { setProxy, checkProxyModel } = await import('./providers');
const { enqueue } = await import('./tasks');
const { settings } = await import('./settings');

let status = 200;
let calls = 0;
const proxy = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	fetch(req) {
		calls++;
		if (new URL(req.url).pathname !== '/v1/models') return new Response(null, { status: 404 });
		if (req.headers.get('authorization') !== 'Bearer test-proxy-secret') return new Response(null, { status: 401 });
		return Response.json({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-sol' }] }, { status });
	}
});
let person = 0;
beforeAll(async () => {
	if (!url) return;
	await migrate();
	await exec('truncate people restart identity cascade');
	person = (await row<{ id: number }>("insert into people (name, key, avatar_seed) values ('Test', 'test', 'seed') returning id"))!.id;
	await setProxy(person, proxy.url.origin, 'test-proxy-secret');
});
afterAll(async () => {
	proxy.stop(true);
	await pool.end();
});

test('default catalog offers the two verified Sol model IDs', () => {
	expect(settings().models.filter((m) => m.id.startsWith('openai/')).map((m) => m.id)).toEqual([
		'openai/gpt-6.1-sol', 'openai/gpt-6-sol'
	]);
});

run('accepts both models advertised by the proxy', async () => {
	await checkProxyModel(person, 'openai/gpt-6.1-sol');
	await checkProxyModel(person, 'openai/gpt-6-sol');
});

run('unavailable model fails before inserting a run or contacting Docker', async () => {
	await expect(enqueue({ id: 99, person_id: person, model: 'openai/gpt-5.4' }, 'test', { admin: false })).rejects.toThrow(
		'Tu CLIProxyAPI no ofrece gpt-5.4. Cambia el modelo del agente. Disponibles: gpt-6.1-sol, gpt-6-sol.'
	);
	expect(await row('select count(*) as n from runs')).toEqual({ n: 0 });
});

run('rejects proxy authentication failure instead of creating a run', async () => {
	status = 401;
	try {
		await expect(checkProxyModel(person, 'openai/gpt-6.1-sol')).rejects.toThrow('El proxy rechazó la API key.');
	} finally { status = 200; }
});

run('direct-key accounts do not require a personal proxy', async () => {
	const before = calls;
	await checkProxyModel(person + 1, 'openai/gpt-6.1-sol');
	expect(calls).toBe(before);
});

run('one live run per agent, enforced by the database', async () => {
	const a = (await row<{ id: number }>(
		`insert into agents (person_id, name, model, seed, state_ref) values ($1, 'A', 'openai/gpt-6-sol', 's', 'v') returning id`,
		[person]
	))!.id;
	const conv = (await row<{ id: number }>("insert into conversations (agent_id, pi_session_id) values ($1, 'p') returning id", [a]))!.id;
	const insert = (wf: string, status: string) =>
		exec(`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status) values ($1, $2, $3, $4, 'm', $5)`, [a, person, conv, wf, status]);
	await insert('t-1', 'done');
	await insert('t-2', 'running');
	await expect(insert('t-3', 'queued')).rejects.toThrow('runs_one_live_per_agent');
});

run('GPT only: the database takes no other provider key', async () => {
	await expect(
		exec("insert into provider_keys (person_id, provider, key_enc, last4) values ($1, 'anthropic', 'x', 'xxxx')", [person])
	).rejects.toThrow('provider_keys_provider_check');
});

run('a new conversation archives the current one; one current per agent', async () => {
	const { create, newConversation, conversations } = await import('./agents');
	const a = await create(person, { name: 'Memoria', model: 'openai/gpt-6-sol' });
	const first = await conversations(a.id);
	expect(first.filter((c) => !c.archived_at).length).toBe(1);
	const after = await newConversation(a.id);
	expect(after.length).toBe(2);
	expect(after.filter((c) => !c.archived_at).length).toBe(1);
	expect(after.find((c) => !c.archived_at)!.id).not.toBe(first[0].id);
});
