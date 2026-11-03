// The sandbox image follows the release unless an admin overrides it on purpose: saving the admin form
// (which always sends it) must not pin the image of that day. Against the throwaway database.
import { afterAll, beforeAll, expect, test } from 'bun:test';

const url = process.env.AGENTS_TEST_DATABASE_URL;
const run = url ? test : test.skip;
process.env.AGENTS_DATA ??= '/tmp';
const db = url ? await import('./db') : null;
let before: unknown = null;

beforeAll(async () => {
	if (!db || !url) return;
	const { assertTestDatabase } = await import('./test-database');
	assertTestDatabase(url, db.DATABASE_URL);
	await db.migrate();
	before = (await db.row<{ value: unknown }>("select value from settings where key = 'settings'"))?.value ?? null;
});
afterAll(async () => {
	if (!db) return;
	if (before) await db.exec("update settings set value = $1 where key = 'settings'", [JSON.stringify(before)]);
	else await db.exec("delete from settings where key = 'settings'");
	await (await import('./settings')).loadSettings();
});

run('saving the admin form stores the sandbox image only when it differs from the release one', async () => {
	const { loadSettings, saveSettings, settings } = await import('./settings');
	await db!.exec("delete from settings where key = 'settings'");
	await loadSettings();
	const release = settings().sandboxImage;
	const stored = async () =>
		(await db!.row<{ value: Record<string, unknown> }>("select value from settings where key = 'settings'"))!.value;
	// The form sends everything back, the release's image included: it is not stored.
	await saveSettings({ ...settings(), maxConcurrent: 3 });
	expect(await stored()).not.toHaveProperty('sandboxImage');
	expect((await stored()).maxConcurrent).toBe(3);
	// A different image is an override; an empty field goes back to the release's.
	await saveSettings({ sandboxImage: 'registry.example/agents-sandbox:pruebas' });
	expect((await stored()).sandboxImage).toBe('registry.example/agents-sandbox:pruebas');
	expect(settings().sandboxImage).toBe('registry.example/agents-sandbox:pruebas');
	await saveSettings({ sandboxImage: '' });
	expect(await stored()).not.toHaveProperty('sandboxImage');
	expect(settings().sandboxImage).toBe(release);
	expect((await stored()).maxConcurrent).toBe(3); // what else was changed stays
});
