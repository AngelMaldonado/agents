import { beforeAll, expect, test } from 'bun:test';

// Against the throwaway database (AGENTS_TEST_DATABASE_URL), like the other DB tests.
const url = process.env.AGENTS_TEST_DATABASE_URL;
const run = url ? test : test.skip;
process.env.AGENTS_DATA ??= '/tmp';
process.env.AGENTS_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
const db = url ? await import('./db') : null;

beforeAll(async () => {
	if (!db || !url) return;
	const { assertTestDatabase } = await import('./test-database');
	assertTestDatabase(url, db.DATABASE_URL);
	assertTestDatabase(url, db.DATABASE_URL, (await db.row<{ name: string }>('select current_database() as name'))!.name);
	await db.migrate();
});

run('logging out ends the session in the database, not only the cookie', async () => {
	const people = await import('./people');
	const joined = (await people.join(`Salida ${crypto.randomUUID().slice(0, 8)}`))!;
	expect((await people.whoIs(joined.token))?.id).toBe(joined.person.id);
	await people.endSession(joined.token);
	expect(await people.whoIs(joined.token)).toBeNull();
	await people.endSession(undefined); // no cookie: nothing to end, no error
});
