// The agent hub's data (Bubble agents #25): conversations ordered by their latest activity, a title
// of their own, and the agent's recent output files. Against the throwaway database
// (AGENTS_TEST_DATABASE_URL), like the other DB tests.
import { beforeAll, expect, test } from 'bun:test';

const url = process.env.AGENTS_TEST_DATABASE_URL;
const run = url ? test : test.skip;
process.env.AGENTS_DATA ??= '/tmp';
process.env.AGENTS_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
const db = url ? await import('./db') : null;
let agentId = 0,
	personId = 0,
	model = '';

beforeAll(async () => {
	if (!db || !url) return;
	const { assertTestDatabase } = await import('./test-database');
	assertTestDatabase(url, db.DATABASE_URL);
	assertTestDatabase(url, db.DATABASE_URL, (await db.row<{ name: string }>('select current_database() as name'))!.name);
	await db.migrate();
	const { create } = await import('./agents');
	const { settings } = await import('./settings');
	model = settings().models[0].id;
	const tag = crypto.randomUUID().slice(0, 8);
	personId = (await db.row<{ id: number }>(
		'insert into people (name, key, avatar_seed) values ($1, $2, $3) returning id',
		[`hub-${tag}`, `hub-${tag}`, 's'],
	))!.id;
	agentId = (await create(personId, { name: `hub-${tag}`, model })).id;
});

run('conversations carry last_at (their latest message or run) and can be renamed and reset', async () => {
	const conversations = await import('./conversations');
	const principal = (await conversations.list(agentId)).find((c) => c.is_default)!;
	const other = await conversations.create(agentId, crypto.randomUUID());
	expect(other.last_at).toBe(other.started_at);
	await db!.exec(
		`insert into messages (agent_id, conversation_id, source, person_id, text, received_at)
		 values ($1, $2, 'web', $3, 'Cotiza cajas', now() + interval '1 minute')`,
		[agentId, other.id, personId],
	);
	const after = (await conversations.get(agentId, other.id))!;
	expect(after.last_at).toBeGreaterThan(after.started_at);
	expect(after.title).toBe('Cotiza cajas');

	expect((await conversations.rename(agentId, other.id, '  Cajas   de cartón ')).title).toBe('Cajas de cartón');
	expect((await conversations.rename(agentId, other.id, '')).title).toBe('Cotiza cajas');
	expect((await conversations.rename(agentId, principal.id, '')).title).toBe('Principal');
	expect(conversations.rename(agentId, other.id, 'x'.repeat(81))).rejects.toThrow('80');
	expect(conversations.rename(agentId + 1_000_000, other.id, 'Ajeno')).rejects.toThrow();
});

run("recent files: the agent's outputs across runs, newest first, with their run", async () => {
	const { recentArtifacts } = await import('./tasks');
	const conv = (await db!.row<{ id: number }>('select id from conversations where agent_id = $1 and is_default', [
		agentId,
	]))!;
	const runIds: number[] = [];
	for (let i = 0; i < 2; i++)
		runIds.push(
			(await db!.row<{ id: number }>(
				`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status, ended_at)
				 values ($1, $2, $3, $4, $5, 'done', now()) returning id`,
				[agentId, personId, conv.id, `hub-${crypto.randomUUID()}`, model],
			))!.id,
		);
	for (const [i, runId] of runIds.entries())
		await db!.exec(
			`insert into files (direction, run_id, name, path, mime, size) values ('out', $1, $2, $3, 'text/markdown', 10)`,
			[runId, `informe-${i + 1}.md`, `hub/${runId}.md`],
		);
	const files = await recentArtifacts(agentId, 12);
	expect(files.map((f) => [f.name, f.run_id])).toEqual([
		['informe-2.md', runIds[1]],
		['informe-1.md', runIds[0]],
	]);
	expect((await recentArtifacts(agentId, 1)).length).toBe(1);
});

run('pins: only what the person uses; recent conversations skip empty and closed ones unless pinned', async () => {
	const pins = await import('./pins');
	const conversations = await import('./conversations');
	const { create } = await import('./agents');
	const me = { id: personId, name: 'hub', admin: false } as never;
	const stranger = (await db!.row<{ id: number }>(
		'insert into people (name, key, avatar_seed) values ($1, $2, $3) returning id',
		[`hub-other-${crypto.randomUUID().slice(0, 8)}`, `hub-other-${crypto.randomUUID()}`, 's'],
	))!.id;
	const foreign = await create(stranger, { name: `ajeno-${crypto.randomUUID().slice(0, 8)}`, model });

	expect(pins.set(me, 'agent', foreign.id, true)).rejects.toThrow('no es tuyo');
	expect(pins.set(me, 'run', agentId, true)).rejects.toThrow();
	expect((await pins.set(me, 'agent', agentId, true)).map((p) => [p.kind, p.ref_id])).toEqual([['agent', agentId]]);
	await pins.set(me, 'agent', agentId, true); // twice: still one pin

	const empty = await conversations.create(agentId, crypto.randomUUID());
	const talked = await conversations.create(agentId, crypto.randomUUID());
	await db!.exec(
		`insert into messages (agent_id, conversation_id, source, person_id, text) values ($1, $2, 'web', $3, 'Hola')`,
		[agentId, talked.id, personId],
	);
	const ids = async () => (await pins.recentConversations(personId)).map((c) => c.id);
	expect(await ids()).toContain(talked.id);
	expect(await ids()).not.toContain(empty.id);

	await conversations.archive(agentId, talked.id, true);
	expect(await ids()).not.toContain(talked.id);
	await pins.set(me, 'conversation', talked.id, true);
	expect((await ids())[0]).toBe(talked.id); // pinned: listed first, even closed

	const left = await pins.set(me, 'agent', agentId, false);
	expect(left.map((p) => p.kind)).toEqual(['conversation']);
	expect((await pins.list(stranger)).length).toBe(0);
});

run('removing a conversation hides it everywhere and keeps its data; Principal and busy ones stay', async () => {
	const conversations = await import('./conversations');
	const pins = await import('./pins');
	const me = { id: personId, name: 'hub', admin: false } as never;
	const principal = (await conversations.list(agentId)).find((c) => c.is_default)!;
	expect(conversations.remove(agentId, principal.id)).rejects.toThrow('Principal');

	const chat = await conversations.create(agentId, crypto.randomUUID());
	await db!.exec(
		`insert into messages (agent_id, conversation_id, source, person_id, text) values ($1, $2, 'web', $3, 'Borrar')`,
		[agentId, chat.id, personId],
	);
	const busy = (await db!.row<{ id: number }>(
		`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status) values ($1, $2, $3, $4, $5, 'running') returning id`,
		[agentId, personId, chat.id, `hub-${crypto.randomUUID()}`, model],
	))!.id;
	expect(conversations.remove(agentId, chat.id)).rejects.toThrow('trabajando');
	await db!.exec(`update runs set status = 'done', ended_at = now() where id = $1`, [busy]);

	await pins.set(me, 'conversation', chat.id, true);
	await conversations.remove(agentId, chat.id);
	expect(await conversations.get(agentId, chat.id)).toBeNull();
	expect((await conversations.list(agentId)).some((c) => c.id === chat.id)).toBe(false);
	expect((await pins.recentConversations(personId)).some((c) => c.id === chat.id)).toBe(false);
	expect((await pins.list(personId)).some((p) => p.kind === 'conversation' && p.ref_id === chat.id)).toBe(false);
	expect(
		(await db!.row<{ n: number }>('select count(*)::int as n from messages where conversation_id = $1', [chat.id]))!.n,
	).toBe(1);
	expect(conversations.remove(agentId, chat.id)).rejects.toThrow();
});
