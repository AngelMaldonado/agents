// Buyer's backend: login, agents, tasks, the vault, the LLM gateway and two WebSockets
// (/ws for browsers, /sandbox/ws for the supervisor inside each task's container).
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { upgradeWebSocket, websocket, serveStatic } from 'hono/bun';
import { existsSync } from 'node:fs';
import { db } from './db';
import * as people from './people';
import * as agents from './agents';
import * as tasks from './tasks';
import * as vault from './vault';
import * as hub from './hub';
import { settings, saveSettings } from './settings';
import {
	keysOf, setKey, deleteKey, writeProxyConfig, PROVIDERS, type Provider,
	proxyOf, proxyCredentials, normalizeProxyUrl, proxyModels, setProxy, deleteProxy
} from './providers';
import { checkMasterKey } from './crypto';
import { gateway } from './llm';

checkMasterKey();
writeProxyConfig();

type Env = { Variables: { me: people.Person } };
const app = new Hono<Env>();
const PORT = Number(process.env.PORT ?? 8787);
const SECURE = process.env.BUYER_COOKIE_SECURE !== '0';

const fail = (c: Context, err: unknown, status = 400) => c.json({ error: (err as Error).message ?? String(err) }, status as 400);

// ---------- the sandbox side (reached from the buyer-sandbox network) ----------

app.post('/llm/*', gateway);

app.get(
	'/sandbox/ws',
	upgradeWebSocket((c) => {
		const token = c.req.query('token') ?? '';
		let handlers: ReturnType<typeof tasks.attach> = null;
		return {
			onOpen(_e, ws) {
				handlers = tasks.attach(token, { send: (d) => ws.send(d), close: () => ws.close() });
				if (!handlers) ws.close(4401, 'bad token');
			},
			onMessage(e) {
				if (typeof e.data === 'string') handlers?.message(e.data);
			},
			onClose() {
				handlers?.close();
			}
		};
	})
);

// ---------- session ----------

app.use('/api/*', async (c, next) => {
	const open = ['/api/me', '/api/join', '/api/invite'];
	const me = people.whoIs(getCookie(c, people.COOKIE));
	if (me) c.set('me', me);
	if (!me && !open.some((p) => c.req.path.startsWith(p))) return c.json({ error: 'Entra con tu nombre.' }, 401);
	await next();
});

function login(c: Context, token: string) {
	setCookie(c, people.COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: SECURE, path: '/', maxAge: 400 * 86400 });
}

const adminOnly = (c: Context<Env>) => (c.get('me').admin ? null : c.json({ error: 'Sólo admin.' }, 403));

app.get('/api/me', (c) => {
	const me = c.get('me');
	return c.json({ me: me ?? null, pinIsSet: people.pinIsSet(), settings: me ? publicSettings() : null });
});

function publicSettings() {
	const s = settings();
	return { models: s.models, maxConcurrent: s.maxConcurrent, maxMinutes: s.maxMinutes, maxCostUsd: s.maxCostUsd, blockedWaitMinutes: s.blockedWaitMinutes, sandboxImage: s.sandboxImage };
}

app.post('/api/join', async (c) => {
	const { name } = await c.req.json();
	const r = people.join(String(name ?? ''));
	if (!r) return c.json({ error: 'Ese nombre ya existe o está vacío. Si eres tú, pídele a un admin un link.' }, 409);
	login(c, r.token);
	return c.json({ me: r.person });
});

app.get('/api/invite/:code', (c) => c.json({ person: people.invited(c.req.param('code')) }));
app.post('/api/invite/:code', (c) => {
	const token = people.redeem(c.req.param('code'));
	if (!token) return c.json({ error: 'El link ya se usó o expiró.' }, 410);
	login(c, token);
	return c.json({ ok: true });
});

app.post('/api/logout', (c) => {
	deleteCookie(c, people.COOKIE, { path: '/' });
	return c.json({ ok: true });
});

app.post('/api/admin/unlock', async (c) => {
	const { pin } = await c.req.json();
	if (!people.unlock(getCookie(c, people.COOKIE)!, String(pin ?? ''))) return c.json({ error: 'PIN incorrecto.' }, 403);
	return c.json({ ok: true });
});
app.post('/api/admin/lock', (c) => {
	people.lock(getCookie(c, people.COOKIE)!);
	return c.json({ ok: true });
});

// ---------- provider keys (each person's own; never shown back) ----------

app.get('/api/keys', (c) => c.json({ keys: keysOf(c.get('me').id), proxy: proxyOf(c.get('me').id) }));

// A person's own CLIProxyAPI. Saving checks it answers /v1/models with that key.
function catalogCheck(ids: string[]) {
	return {
		total: ids.length,
		catalog: settings().models.map((m) => ({ id: m.id, label: m.label, served: ids.includes(m.id.split('/')[1]) }))
	};
}

app.put('/api/proxy', async (c) => {
	const { url, key } = await c.req.json();
	try {
		const k = String(key ?? '').trim();
		if (!k) throw new Error('Falta la API key.');
		const u = normalizeProxyUrl(url);
		const ids = await proxyModels(u, k);
		setProxy(c.get('me').id, u, k);
		return c.json({ proxy: proxyOf(c.get('me').id), check: catalogCheck(ids) });
	} catch (err) {
		return fail(c, err);
	}
});

app.post('/api/proxy/test', async (c) => {
	const p = proxyCredentials(c.get('me').id);
	if (!p) return c.json({ error: 'No tienes un CLIProxyAPI guardado.' }, 404);
	try {
		return c.json({ check: catalogCheck(await proxyModels(p.url, p.key)) });
	} catch (err) {
		return fail(c, err);
	}
});

app.delete('/api/proxy', (c) => {
	deleteProxy(c.get('me').id);
	return c.json({ proxy: null });
});
app.put('/api/keys/:provider', async (c) => {
	const provider = c.req.param('provider') as Provider;
	if (!PROVIDERS.includes(provider)) return c.json({ error: 'Proveedor desconocido.' }, 404);
	const { key } = await c.req.json();
	if (typeof key !== 'string' || key.trim().length < 20) return c.json({ error: 'Esa key no parece válida.' }, 400);
	setKey(c.get('me').id, provider, key);
	return c.json({ keys: keysOf(c.get('me').id) });
});
app.delete('/api/keys/:provider', (c) => {
	deleteKey(c.get('me').id, c.req.param('provider') as Provider);
	return c.json({ keys: keysOf(c.get('me').id) });
});

// ---------- agents and tasks ----------

app.get('/api/agents', (c) => c.json({ agents: agents.visible(c.get('me')) }));

app.post('/api/agents', async (c) => {
	try {
		return c.json({ agent: agents.create(c.get('me').id, await c.req.json()) });
	} catch (err) {
		return fail(c, err);
	}
});

function ownAgent(c: Context<Env>) {
	const a = agents.get(Number(c.req.param('id')));
	return a && a.person_id === c.get('me').id ? a : null;
}

app.patch('/api/agents/:id', async (c) => {
	const a = ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	try {
		return c.json({ agent: agents.edit(a, await c.req.json()) });
	} catch (err) {
		return fail(c, err);
	}
});

app.delete('/api/agents/:id', (c) => {
	const a = ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	agents.retire(a);
	return c.json({ ok: true });
});

app.get('/api/agents/:id/tasks', (c) => {
	const a = agents.seeable(c.get('me'), Number(c.req.param('id')));
	if (!a) return c.json({ error: 'No existe.' }, 404);
	return c.json({ tasks: agents.tasksOf(a.id) });
});

app.post('/api/agents/:id/tasks', async (c) => {
	const a = ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño lanza tareas con su agente.' }, 403);
	const { prompt } = await c.req.json();
	if (typeof prompt !== 'string' || !prompt.trim()) return c.json({ error: 'Describe la tarea.' }, 400);
	try {
		return c.json({ task: tasks.publicTask(tasks.enqueue(a, prompt)) });
	} catch (err) {
		return fail(c, err);
	}
});

function seeableTask(c: Context<Env>) {
	const t = tasks.getTask(Number(c.req.param('id')));
	const me = c.get('me');
	return t && (me.admin || t.person_id === me.id) ? t : null;
}

app.get('/api/tasks/:id', (c) => {
	const t = seeableTask(c);
	if (!t) return c.json({ error: 'No existe.' }, 404);
	return c.json({ task: tasks.publicTask(t), events: tasks.events(t.id, Number(c.req.query('after') ?? 0)), artifacts: tasks.artifacts(t.id) });
});

// Steer and follow-up: only the owner. The admin can watch and cancel, never steer.
app.post('/api/tasks/:id/steer', async (c) => {
	const t = tasks.getTask(Number(c.req.param('id')));
	if (!t || t.person_id !== c.get('me').id) return c.json({ error: 'Sólo el dueño de la tarea la dirige.' }, 403);
	const { text, kind } = await c.req.json();
	try {
		tasks.steer(t.id, String(text ?? ''), kind === 'follow_up' ? 'follow_up' : 'steer');
		return c.json({ ok: true });
	} catch (err) {
		return fail(c, err);
	}
});

app.post('/api/tasks/:id/cancel', (c) => {
	const t = seeableTask(c);
	if (!t) return c.json({ error: 'No existe.' }, 404);
	try {
		tasks.cancel(t.id);
		return c.json({ ok: true });
	} catch (err) {
		return fail(c, err);
	}
});

app.get('/api/tasks/:id/files/:name', (c) => {
	const t = seeableTask(c);
	if (!t) return c.json({ error: 'No existe.' }, 404);
	const row = db.query('SELECT path, mime FROM artifacts WHERE task_id = ? AND name = ?').get(t.id, c.req.param('name')) as { path: string; mime: string } | null;
	if (!row) return c.json({ error: 'No existe.' }, 404);
	return new Response(Bun.file(row.path), { headers: { 'content-type': row.mime, 'cache-control': 'private, max-age=86400' } });
});

app.get('/api/tasks/:id/quote.csv', (c) => {
	const t = seeableTask(c);
	if (!t?.result) return c.json({ error: 'Sin cotización.' }, 404);
	const r = JSON.parse(t.result);
	const cols = ['product', 'vendor', 'price', 'currency', 'shipping', 'availability', 'url', 'screenshot', 'checked_at', 'notes'];
	const esc = (v: unknown) => {
		const s = v == null ? '' : String(v);
		return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	const lines = [cols.join(','), ...(Array.isArray(r.options) ? r.options : []).map((o: any) => cols.map((k) => esc(o?.[k])).join(','))];
	return new Response('\uFEFF' + lines.join('\r\n'), {
		headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="cotizacion-${t.id}.csv"` }
	});
});

// ---------- vault ----------

app.get('/api/vault', (c) => c.json({ credentials: vault.list(c.get('me').id), uses: vault.uses(c.get('me').id) }));
app.post('/api/vault', async (c) => {
	try {
		const b = await c.req.json();
		const name = vault.save(c.get('me').id, { name: b.name, loginUrl: b.loginUrl, username: b.username, password: b.password });
		return c.json({ name, credentials: vault.list(c.get('me').id) });
	} catch (err) {
		return fail(c, err);
	}
});
app.put('/api/vault/:id/grants', async (c) => {
	try {
		const { agents: ids } = await c.req.json();
		vault.grant(c.get('me').id, Number(c.req.param('id')), Array.isArray(ids) ? ids.map(Number) : []);
		return c.json({ credentials: vault.list(c.get('me').id) });
	} catch (err) {
		return fail(c, err);
	}
});
app.delete('/api/vault/:id', (c) => {
	vault.remove(c.get('me').id, Number(c.req.param('id')));
	return c.json({ credentials: vault.list(c.get('me').id) });
});

// ---------- admin (behind the PIN) ----------

app.get('/api/admin', (c) => adminOnly(c) ?? c.json({ settings: settings(), people: people.everyone(), uses: vault.uses(0, true) }));
app.put('/api/admin/settings', async (c) => adminOnly(c) ?? c.json({ settings: saveSettings(await c.req.json()) }));
app.post('/api/admin/people/:id/invite', (c) => adminOnly(c) ?? c.json({ code: people.invite(Number(c.req.param('id'))) }));
app.delete('/api/admin/people/:id', (c) => {
	const denied = adminOnly(c);
	if (denied) return denied;
	if (Number(c.req.param('id')) === c.get('me').id) return c.json({ error: 'No te puedes borrar a ti.' }, 400);
	people.remove(Number(c.req.param('id')));
	writeProxyConfig();
	return c.json({ ok: true });
});

// ---------- browsers' live feed ----------

app.get(
	'/ws',
	upgradeWebSocket((c) => {
		const me = people.whoIs(getCookie(c, people.COOKIE));
		let leave: (() => void) | null = null;
		return {
			onOpen(_e, ws) {
				if (!me) return ws.close(4401, 'login');
				const viewer = { person: me, send: (d: string) => ws.send(d) };
				leave = hub.join(viewer);
				hub.replayFrames(viewer, tasks.liveOwners());
			},
			onClose() {
				leave?.();
			}
		};
	})
);

// ---------- the web app (built) ----------

const WEB = process.env.BUYER_WEB_DIST ?? '../web/dist';
if (existsSync(WEB)) {
	app.use('/*', serveStatic({ root: WEB }));
	app.get('*', serveStatic({ path: `${WEB}/index.html` }));
}

await tasks.recover();
console.log(`buyer listening on :${PORT}`);

export default { port: PORT, fetch: app.fetch, websocket, idleTimeout: 120 };
