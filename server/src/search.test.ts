import { beforeAll, expect, test } from 'bun:test';
import { normalizeQuery, snippet } from './search';

test('queries: whitespace collapses, too short or empty does not search, long is capped', () => {
	expect(normalizeQuery('  hola   mundo ')).toBe('hola mundo');
	expect(normalizeQuery('a')).toBeNull();
	expect(normalizeQuery(undefined)).toBeNull();
	expect(normalizeQuery('x'.repeat(300))!.length).toBe(100);
});

test('snippets: the match with context on one line, cut with an ellipsis, accents and case ignored', () => {
	const text = `${'a'.repeat(100)} Cotiza la cámara\nSony ${'b'.repeat(100)}`;
	const s = snippet(text, 'CÁMARA sony');
	expect(s.startsWith('…')).toBe(true);
	expect(s.endsWith('…')).toBe(true);
	expect(s).toContain('cámara Sony');
	expect(s).not.toContain('\n');
	expect(snippet('corto', 'nada')).toBe('corto');
});

// Against the throwaway database (AGENTS_TEST_DATABASE_URL), like the other DB tests.
const url = process.env.AGENTS_TEST_DATABASE_URL;
const run = url ? test : test.skip;
process.env.AGENTS_DATA ??= '/tmp';
process.env.AGENTS_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
const db = url ? await import('./db') : null;
const people: Record<'ana' | 'beto' | 'carla' | 'admin', { id: number; name: string; admin: boolean }> = {} as never;
const agentIds: Record<'anas' | 'betos' | 'carlas', number> = {} as never;

beforeAll(async () => {
	if (!db || !url) return;
	const { assertTestDatabase } = await import('./test-database');
	assertTestDatabase(url, db.DATABASE_URL);
	assertTestDatabase(url, db.DATABASE_URL, (await db.row<{ name: string }>('select current_database() as name'))!.name);
	await db.migrate();
	const { create, setShares } = await import('./agents');
	const { settings } = await import('./settings');
	const model = settings().models[0].id;
	const tag = crypto.randomUUID().slice(0, 8);
	for (const key of ['ana', 'beto', 'carla', 'admin'] as const) {
		const p = (await db.row<{ id: number }>(
			'insert into people (name, key, avatar_seed) values ($1, $2, $3) returning id',
			[`${key}-${tag}`, `search-${key}-${tag}`, 's'],
		))!;
		people[key] = { id: p.id, name: key, admin: key === 'admin' };
	}
	for (const [owner, agent] of [
		['ana', 'anas'],
		['beto', 'betos'],
		['carla', 'carlas'],
	] as const) {
		const a = await create(people[owner].id, { name: `${agent}-${tag}`, model });
		agentIds[agent] = a.id;
		const conv = (await db.row<{ id: number }>('select id from conversations where agent_id = $1', [a.id]))!;
		await db.exec(
			`insert into messages (agent_id, conversation_id, source, person_id, text) values ($1, $2, 'web', $3, $4)`,
			[a.id, conv.id, people[owner].id, `Busca la palabra zafiro-${tag} para ${agent}`],
		);
		await db.exec(
			`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status, answer, ended_at)
			 values ($1, $2, $3, $4, $5, 'done', $6, now())`,
			[a.id, people[owner].id, conv.id, `search-${agent}-${tag}`, model, `Respuesta con zafiro-${tag} de ${agent}`],
		);
	}
	// Beto shares his agent with Ana; Carla's stays hers. The admin owns nothing and is shared nothing.
	const { get } = await import('./agents');
	await setShares((await get(agentIds.betos))!, [people.ana.id]);
	(globalThis as { searchTag?: string }).searchTag = tag;
});

run('search covers own and shared agents, messages and answers; never others, not even for an admin', async () => {
	const { search } = await import('./search');
	const tag = (globalThis as { searchTag?: string }).searchTag!;
	const ana = await search(people.ana as never, `zafiro-${tag}`);
	expect(new Set(ana.map((h) => h.agent_id))).toEqual(new Set([agentIds.anas, agentIds.betos]));
	expect(new Set(ana.map((h) => h.kind))).toEqual(new Set(['message', 'answer']));
	expect(ana.every((h) => h.snippet.toLowerCase().includes(`zafiro-${tag}`) && h.conversation_title)).toBe(true);
	expect((await search(people.carla as never, `zafiro-${tag}`)).map((h) => h.agent_id)).toEqual([
		agentIds.carlas,
		agentIds.carlas,
	]);
	expect(await search(people.admin as never, `zafiro-${tag}`)).toEqual([]);
	// LIKE wildcards are text, not patterns.
	expect(await search(people.ana as never, '%%')).toEqual([]);
});
