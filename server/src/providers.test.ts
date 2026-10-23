import { afterAll, expect, test } from 'bun:test';

// Isolated from the dev database and credentials; no real provider or Docker calls.
process.env.BUYER_DB = ':memory:';
process.env.BUYER_DATA = '/tmp';
process.env.BUYER_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const { db } = await import('./db');
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
db.query('INSERT INTO people (id, name, key, avatar_seed, created_at) VALUES (1, ?, ?, ?, 0)').run('Test', 'test', 'seed');
setProxy(1, proxy.url.origin, 'test-proxy-secret');
afterAll(() => { proxy.stop(true); db.close(); });

test('default catalog offers the two verified Sol model IDs', () => {
	expect(settings().models.filter((m) => m.id.startsWith('openai/')).map((m) => m.id)).toEqual([
		'openai/gpt-6.1-sol', 'openai/gpt-6-sol'
	]);
});

test('accepts both models advertised by the proxy', async () => {
	await checkProxyModel(1, 'openai/gpt-6.1-sol');
	await checkProxyModel(1, 'openai/gpt-6-sol');
});

test('unavailable model fails before inserting a task or contacting Docker', async () => {
	await expect(enqueue({ id: 99, person_id: 1, model: 'openai/gpt-5.4' }, 'test')).rejects.toThrow(
		'Tu CLIProxyAPI no ofrece gpt-5.4. Cambia el modelo del agente. Disponibles: gpt-6.1-sol, gpt-6-sol.'
	);
	expect(db.query('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
});

test('rejects proxy authentication failure instead of creating a task', async () => {
	status = 401;
	try {
		await expect(checkProxyModel(1, 'openai/gpt-6.1-sol')).rejects.toThrow('El proxy rechazó la API key.');
	} finally { status = 200; }
});

test('direct-key accounts do not require a personal proxy', async () => {
	const before = calls;
	await checkProxyModel(2, 'openai/gpt-6.1-sol');
	expect(calls).toBe(before);
});
