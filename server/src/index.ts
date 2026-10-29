// Agents' backend: login, agents, tasks, the vault, the LLM gateway and two WebSockets
// (/ws for browsers, /sandbox/ws for the supervisor inside each task's container).
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { upgradeWebSocket, websocket, serveStatic } from 'hono/bun';
import { existsSync } from 'node:fs';
import { migrate, row } from './db';
import { startDbos } from './dbos';
import * as people from './people';
import * as agents from './agents';
import * as designs from './designs';
import * as tasks from './tasks';
import * as conversations from './conversations';
import * as vault from './vault';
import * as hub from './hub';
import { settings, saveSettings, loadSettings } from './settings';
import {
	keysOf, setKey, deleteKey, writeProxyConfig, PROVIDERS, type Provider,
	proxyOf, proxyCredentials, normalizeProxyUrl, proxyModels, setProxy, deleteProxy
} from './providers';
import { checkMasterKey, open } from './crypto';
import { gateway } from './llm';
import * as channels from './channels';
import * as inbox from './inbox';
import * as monitor from './monitor';
import * as whatsapp from './whatsapp';
import * as secrets from './secrets';
import { verify, checkLink } from './sign';
import { artifactHeaders, readPreview } from './artifact-preview';

checkMasterKey();
await migrate();
await loadSettings();
await writeProxyConfig();
await startDbos();
await agents.loadShares();
await tasks.recover();
await inbox.startRouter();
monitor.startMonitor();

// Prometheus scrapes this on its own port, never through Traefik (it names people and agents).
const METRICS_PORT = Number(process.env.AGENTS_METRICS_PORT ?? 9464);
Bun.serve({
	port: METRICS_PORT,
	fetch: async (req) =>
		new URL(req.url).pathname === '/metrics'
			? new Response(await monitor.metricsText(), { headers: { 'content-type': 'text/plain; version=0.0.4' } })
			: new Response('not here', { status: 404 })
});

type Env = { Variables: { me: people.Person } };
const app = new Hono<Env>();
const PORT = Number(process.env.PORT ?? 8787);
const SECURE = process.env.AGENTS_COOKIE_SECURE !== '0';

const fail = (c: Context, err: unknown, status = 400) => c.json({ error: (err as Error).message ?? String(err) }, status as 400);

// ---------- the sandbox side (reached from the agents-sandbox network) ----------

app.post('/llm/*', gateway);

app.get(
	'/sandbox/ws',
	upgradeWebSocket((c) => {
		const cred = { token: c.req.query('token') || undefined, session: c.req.query('session') || undefined };
		let ready: ReturnType<typeof tasks.attach> = Promise.resolve(null);
		return {
			onOpen(_e, ws) {
				// Messages and close wait for the attach, in order, by chaining on it.
				ready = tasks.attach(cred, { send: (d) => ws.send(d), close: () => ws.close() }).catch((err) => {
					console.error('sandbox attach:', (err as Error).message);
					return null;
				});
				void ready.then((h) => {
					if (!h) ws.close(4401, 'bad token');
				});
			},
			onMessage(e) {
				if (typeof e.data === 'string') {
					const data = e.data;
					void ready.then((h) => h?.message(data));
				}
			},
			onClose() {
				void ready.then((h) => h?.close());
			}
		};
	})
);

// ---------- channels: an agent's inbound webhook ----------
// The contract (body, signature, answers) is documented in Bubble: project agents, docs/canales.md.

const MAX_HOOK_BYTES = 20 * 1024 * 1024;

app.post('/hooks/:token', async (c) => {
	const hook = await channels.agentByToken(c.req.param('token'));
	if (!hook) return c.json({ error: 'unknown or rotated hook' }, 401);
	if (Number(c.req.header('content-length') ?? 0) > MAX_HOOK_BYTES) return c.json({ error: 'body too large' }, 413);
	const raw = await c.req.text();
	if (raw.length > MAX_HOOK_BYTES) return c.json({ error: 'body too large' }, 413);
	if (!verify(c.req.header('x-agents-signature'), open(hook.in_secret_enc), raw)) return c.json({ error: 'bad signature' }, 401);
	let body: any;
	try {
		body = JSON.parse(raw);
	} catch {
		return c.json({ error: 'invalid JSON' }, 400);
	}
	if (typeof body !== 'object' || body === null) return c.json({ error: 'the body must be a JSON object' }, 400);
	if (body.new_conversation !== undefined && body.new_conversation !== false) return c.json({ error: 'No se puede reiniciar la conversación del agente.' }, 400);
	try {
		const r = await inbox.receive({
			agentId: hook.agent_id,
			source: 'hook',
			text: typeof body.text === 'string' ? body.text : '',
			sender: typeof body.from === 'string' ? body.from.slice(0, 200) : null,
			context: body.context,
			attachments: Array.isArray(body.attachments) ? body.attachments : [],
			dedupeKey: c.req.header('idempotency-key')?.slice(0, 200) || null
		});
		return c.json(r, r.duplicate ? 200 : 202);
	} catch (err) {
		return fail(c, err);
	}
});

// ---------- the WhatsApp bridge (internal network, shared secret; no login) ----------

app.post('/internal/whatsapp/inbound', async (c) => {
	if (!whatsapp.checkSecret(c.req.header('x-agents-secret'))) return c.json({ error: 'forbidden' }, 403);
	try {
		return c.json(await whatsapp.inbound(await c.req.json()));
	} catch (err) {
		return fail(c, err);
	}
});

// ---------- signed links (sent in outbound webhooks; no login) ----------

app.get('/api/public/runs/:id', async (c) => {
	if (!checkLink(c.req.path, c.req.query('exp'), c.req.query('sig'))) return c.json({ error: 'expired or invalid link' }, 403);
	const t = await tasks.getTask(Number(c.req.param('id')));
	if (!t) return c.json({ error: 'not found' }, 404);
	const { prompt, ...run } = tasks.publicTask(t);
	return c.json({ run, files: await tasks.artifacts(t.id) });
});

app.get('/api/public/runs/:id/files/:name', async (c) => {
	if (!checkLink(c.req.path, c.req.query('exp'), c.req.query('sig'))) return c.json({ error: 'expired or invalid link' }, 403);
	const f = await tasks.file(Number(c.req.param('id')), decodeURIComponent(c.req.param('name')));
	if (!f) return c.json({ error: 'not found' }, 404);
	return new Response(Bun.file(f.path), { headers: artifactHeaders(c.req.param('name'), true) });
});

// ---------- session ----------

app.use('/api/*', async (c, next) => {
	const open = ['/api/me', '/api/join', '/api/invite', '/api/public/'];
	const me = await people.whoIs(getCookie(c, people.COOKIE));
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
	const r = await people.join(String(name ?? ''));
	if (!r) return c.json({ error: 'Ese nombre ya existe o está vacío. Si eres tú, pídele a un admin un link.' }, 409);
	login(c, r.token);
	return c.json({ me: r.person });
});

app.get('/api/invite/:code', async (c) => c.json({ person: await people.invited(c.req.param('code')) }));
app.post('/api/invite/:code', async (c) => {
	const token = await people.redeem(c.req.param('code'));
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
	if (!(await people.unlock(getCookie(c, people.COOKIE)!, String(pin ?? '')))) return c.json({ error: 'PIN incorrecto.' }, 403);
	return c.json({ ok: true });
});
app.post('/api/admin/lock', async (c) => {
	await people.lock(getCookie(c, people.COOKIE)!);
	return c.json({ ok: true });
});

// ---------- provider keys (each person's own; never shown back) ----------

app.get('/api/keys', async (c) => c.json({ keys: await keysOf(c.get('me').id), proxy: await proxyOf(c.get('me').id) }));

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
		await setProxy(c.get('me').id, u, k);
		return c.json({ proxy: await proxyOf(c.get('me').id), check: catalogCheck(ids) });
	} catch (err) {
		return fail(c, err);
	}
});

app.post('/api/proxy/test', async (c) => {
	const p = await proxyCredentials(c.get('me').id);
	if (!p) return c.json({ error: 'No tienes un CLIProxyAPI guardado.' }, 404);
	try {
		return c.json({ check: catalogCheck(await proxyModels(p.url, p.key)) });
	} catch (err) {
		return fail(c, err);
	}
});

app.delete('/api/proxy', async (c) => {
	await deleteProxy(c.get('me').id);
	return c.json({ proxy: null });
});
app.put('/api/keys/:provider', async (c) => {
	const provider = c.req.param('provider') as Provider;
	if (!PROVIDERS.includes(provider)) return c.json({ error: 'Proveedor desconocido.' }, 404);
	const { key } = await c.req.json();
	if (typeof key !== 'string' || key.trim().length < 20) return c.json({ error: 'Esa key no parece válida.' }, 400);
	await setKey(c.get('me').id, provider, key);
	return c.json({ keys: await keysOf(c.get('me').id) });
});
app.delete('/api/keys/:provider', async (c) => {
	await deleteKey(c.get('me').id, c.req.param('provider') as Provider);
	return c.json({ keys: await keysOf(c.get('me').id) });
});

// ---------- agents and tasks ----------

app.get('/api/agents', async (c) => c.json({ agents: (await agents.visible(c.get('me'))).map((a) => agents.forViewer(a, c.get('me'))) }));

// Creation is now an explicit approval of a stored contract, not a form bypass.
app.post('/api/agents', (c) => c.json({ error: 'Define y aprueba el contrato en Nuevo agente.' }, 409));

app.post('/api/designs', async (c) => {
	try { return c.json({ design: await designs.create(c.get('me').id, await c.req.json()) }); }
	catch (err) { return fail(c, err); }
});
app.get('/api/designs/:id', async (c) => {
	try { return c.json({ design: await designs.get(c.get('me').id, c.req.param('id')) }); }
	catch (err) { return fail(c, err, 404); }
});
app.post('/api/designs/:id/messages', async (c) => {
	try { return c.json({ design: await designs.message(c.get('me').id, c.req.param('id'), await c.req.json(), c.req.raw.signal) }); }
	catch (err) { return fail(c, err); }
});
app.get('/api/designs/:id/files/:file', async (c) => {
	try {
		const f = await designs.file(c.get('me').id, c.req.param('id'), c.req.param('file'));
		if (!f) return c.json({ error: 'No existe.' }, 404);
		return new Response(Bun.file(f.path), { headers: artifactHeaders(f.name, c.req.query('download') === '1') });
	} catch (err) { return fail(c, err, 404); }
});
app.post('/api/designs/:id/validate', async (c) => {
	try { return c.json({ design: await designs.testHarness(c.get('me').id, c.req.param('id'), (await c.req.json()).version) }); }
	catch (err) { return fail(c, err); }
});
app.post('/api/designs/:id/approve', async (c) => {
	try {
		let design = await designs.approve(c.get('me').id, c.req.param('id'), (await c.req.json()).version);
		if (!design.agent_id && !design.init_run_id && !design.last_error) design = await designs.initialize(c.get('me').id, design.id, c.get('me').admin, { retry: false });
		return c.json({ design });
	} catch (err) { return fail(c, err); }
});
app.post('/api/designs/:id/initialize', async (c) => {
	try { return c.json({ design: await designs.initialize(c.get('me').id, c.req.param('id'), c.get('me').admin, { previousRunId: (await c.req.json().catch(() => ({}))).runId }) }); }
	catch (err) { return fail(c, err); }
});
app.get('/api/agents/:id/configuration', async (c) => {
	try { return c.json(await designs.configuration(c.get('me'), Number(c.req.param('id')))); }
	catch (err) { return fail(c, err, 404); }
});

/** The owner or someone it is shared with: they run tasks; configuration stays the owner's. */
async function usableAgent(c: Context<Env>) {
	return agents.usable(c.get('me'), Number(c.req.param('id')));
}
/** The run's agent is the person's or shared with them. */
async function usableTask(c: Context<Env>) {
	const t = await tasks.getTask(Number(c.req.param('id')));
	return t && (await agents.usable(c.get('me'), t.agent_id)) ? t : null;
}

async function ownAgent(c: Context<Env>) {
	const a = await agents.get(Number(c.req.param('id')));
	return a && a.person_id === c.get('me').id ? a : null;
}

app.patch('/api/agents/:id', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	try {
		return c.json({ agent: await agents.edit(a, await c.req.json()) });
	} catch (err) {
		return fail(c, err);
	}
});

app.delete('/api/agents/:id', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	const input = await c.req.json().catch(() => null);
	if (input?.confirmName !== a.name) return c.json({ error: 'Escribe el nombre exacto del agente para confirmar el retiro.' }, 400);
	await agents.retire(a);
	// Its schedules would keep firing at a retired agent: they go too.
	for (const s of await channels.schedules(a.id)) await channels.deleteSchedule(a.id, s.name);
	return c.json({ ok: true });
});

app.get('/api/agents/:id/tasks', async (c) => {
	const a = await agents.seeable(c.get('me'), Number(c.req.param('id')));
	if (!a) return c.json({ error: 'No existe.' }, 404);
	return c.json({ tasks: await agents.tasksOf(a.id) });
});

app.post('/api/agents/:id/tasks', async (c) => {
	const a = await usableAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño y quienes lo tienen compartido le dan tareas.' }, 403);
	const { prompt } = await c.req.json();
	if (typeof prompt !== 'string' || !prompt.trim()) return c.json({ error: 'Describe la tarea.' }, 400);
	try {
		return c.json({ task: tasks.publicTask(await tasks.enqueue(a, prompt, { admin: c.get('me').admin, sender: a.person_id === c.get('me').id ? null : c.get('me').name, personId: c.get('me').id })) });
	} catch (err) {
		return fail(c, err);
	}
});

async function seeableTask(c: Context<Env>) {
	const t = await tasks.getTask(Number(c.req.param('id')));
	return t && (await agents.seeable(c.get('me'), t.agent_id)) ? t : null;
}

app.get('/api/tasks/:id', async (c) => {
	const t = await seeableTask(c);
	if (!t) return c.json({ error: 'No existe.' }, 404);
	return c.json({
		task: tasks.publicTask(t),
		events: await tasks.events(t.id, Number(c.req.query('after') ?? 0)),
		artifacts: await tasks.artifacts(t.id)
	});
});

// Same ownership rules as task details/files; never expose a browser image publicly.
app.get('/api/tasks/:id/snapshot', async (c) => {
	const t = await seeableTask(c);
	if (!t) return c.json({ error: 'No existe.' }, 404);
	c.header('Cache-Control', 'private, no-store');
	return c.json({ snapshot: tasks.snapshot(t.id) });
});

// Steer and follow-up: only the owner. The admin can watch and cancel, never steer.
app.post('/api/tasks/:id/steer', async (c) => {
	const t = await usableTask(c);
	if (!t) return c.json({ error: 'Sólo quien puede usar el agente dirige la tarea.' }, 403);
	const { text, kind } = await c.req.json();
	try {
		await tasks.steer(t.id, String(text ?? ''), kind === 'follow_up' ? 'follow_up' : 'steer');
		return c.json({ ok: true });
	} catch (err) {
		return fail(c, err);
	}
});

app.post('/api/tasks/:id/help', async (c) => {
 const t = await usableTask(c);
 if (!t) return c.json({ error: 'Sólo quien puede usar el agente le responde.' }, 403);
 try { return c.json({ ok: true, ...await tasks.answerHelp(t.id, await c.req.json()) }); }
 catch (err) { return fail(c, err); }
});

// ---------- takeover: only the owner drives the agent's browser; the admin can only watch ----------

// Sharing: the owner picks who may use the agent. Everyone can see the names to pick from.
app.get('/api/people', async (c) => c.json({ people: await people.directory() }));
app.put('/api/agents/:id/shares', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño comparte su agente.' }, 403);
	try { return c.json({ shares: await agents.setShares(a, (await c.req.json()).people) }); }
	catch (err) { return fail(c, err); }
});

app.post('/api/agents/:id/browser', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño abre el navegador de su agente.' }, 403);
	try {
		const prompt = 'Abrí el navegador del agente para iniciar sesión o guardar métodos de pago.';
		return c.json({ task: tasks.publicTask(await tasks.enqueue(a, prompt, { admin: c.get('me').admin, kind: 'browser' })) });
	} catch (err) {
		return fail(c, err);
	}
});

app.post('/api/tasks/:id/control', async (c) => {
	// Only its owner: someone it is shared with runs tasks, never drives its browser.
	const t = await tasks.getTask(Number(c.req.param('id')));
	if (!t || t.person_id !== c.get('me').id) return c.json({ error: 'Sólo el dueño toma el control del navegador.' }, 403);
	try {
		await tasks.setControl(t.id, Boolean((await c.req.json()).on), c.get('me').id);
		return c.json({ ok: true });
	} catch (err) {
		return fail(c, err);
	}
});

app.post('/api/tasks/:id/navigate', async (c) => {
	const t = await tasks.getTask(Number(c.req.param('id')));
	if (!t || t.person_id !== c.get('me').id) return c.json({ error: 'Sólo el dueño maneja el navegador.' }, 403);
	try {
		const { action, url } = await c.req.json();
		await tasks.navigate(t.id, String(action ?? ''), url, c.get('me').id);
		return c.json({ ok: true });
	} catch (err) {
		return fail(c, err);
	}
});

app.post('/api/tasks/:id/close', async (c) => {
	const t = await tasks.getTask(Number(c.req.param('id')));
	if (!t || t.person_id !== c.get('me').id) return c.json({ error: 'Sólo el dueño cierra su navegador.' }, 403);
	try {
		await tasks.closeBrowser(t.id);
		return c.json({ ok: true });
	} catch (err) {
		return fail(c, err);
	}
});

app.post('/api/tasks/:id/cancel', async (c) => {
	const t = await seeableTask(c);
	if (!t) return c.json({ error: 'No existe.' }, 404);
	try {
		await tasks.cancel(t.id);
		return c.json({ ok: true });
	} catch (err) {
		return fail(c, err);
	}
});

app.get('/api/tasks/:id/files/:name/preview', async (c) => {
 const t = await seeableTask(c);
 if (!t) return c.json({ error: 'No existe.' }, 404);
 c.header('Cache-Control', 'private, no-store');
 const name = c.req.param('name');
 const f = await tasks.file(t.id, name);
 if (!f) return c.json({ error: 'No existe.' }, 404);
 try { return c.json({ agentId: t.agent_id, runId: t.id, ...await readPreview(f.path, name), artifacts: await tasks.artifacts(t.id) }); }
 catch (err) { return fail(c, err); }
});

app.get('/api/tasks/:id/files/:name', async (c) => {
	const t = await seeableTask(c);
	if (!t) return c.json({ error: 'No existe.' }, 404);
	const f = await tasks.file(t.id, c.req.param('name'));
	if (!f) return c.json({ error: 'No existe.' }, 404);
	return new Response(Bun.file(f.path), { headers: artifactHeaders(c.req.param('name'), c.req.query('download') === '1') });
});

// ---------- an agent's channels (owner only: they hold its secrets) ----------

async function channelsView(agentId: number) {
	return { ...(await channels.view(agentId)), deliveries: await channels.deliveries(agentId), schedules: await channels.schedules(agentId), timezone: channels.TZ, whatsapp: await whatsapp.agentView(agentId) };
}

app.get('/api/agents/:id/channels', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño ve los canales de su agente.' }, 403);
	return c.json(await channelsView(a.id));
});

app.post('/api/agents/:id/channels/rotate', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 403);
	const { which } = await c.req.json();
	await channels.rotate(a.id, which === 'out' ? 'out' : 'in');
	return c.json(await channelsView(a.id));
});

// ---------- an agent's credentials and MCP sign-ins (owner only; values are never returned) ----------

app.get('/api/agents/:id/secrets', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño ve las credenciales de su agente.' }, 403);
	return c.json({ secrets: await secrets.list(a.id) });
});
app.put('/api/agents/:id/secrets/:name', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño cambia las credenciales de su agente.' }, 403);
	try { return c.json({ secrets: await secrets.set(a.id, c.req.param('name'), (await c.req.json()).value) }); }
	catch (err) { return fail(c, err); }
});
app.delete('/api/agents/:id/secrets/:name', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño cambia las credenciales de su agente.' }, 403);
	return c.json({ secrets: await secrets.remove(a.id, c.req.param('name')) });
});
// Opens the agent's browser with pi's sign-in for that server; the owner completes it there.
app.post('/api/agents/:id/mcp/:server/login', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño inicia sesión por su agente.' }, 403);
	const server = (a.harness?.mcp ?? []).find((s) => s.name === c.req.param('server') && s.oauth);
	if (!server) return c.json({ error: 'Ese servidor MCP no está aprobado para este agente o no usa inicio de sesión.' }, 404);
	try {
		const prompt = `Iniciar sesión en el servidor MCP «${server.name}».`;
		return c.json({ task: tasks.publicTask(await tasks.enqueue(a, prompt, { admin: c.get('me').admin, kind: 'browser', context: { mcpLogin: server.name } })) });
	} catch (err) {
		return fail(c, err);
	}
});

app.put('/api/agents/:id/channels/whatsapp', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño configura el WhatsApp de su agente.' }, 403);
	try {
		await whatsapp.setAgent(a.id, await c.req.json());
		return c.json(await channelsView(a.id));
	} catch (err) {
		return fail(c, err);
	}
});

app.put('/api/agents/:id/channels/out', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 403);
	try {
		const { url } = await c.req.json();
		await channels.setOutUrl(a.id, url ?? null);
		return c.json(await channelsView(a.id));
	} catch (err) {
		return fail(c, err);
	}
});

app.post('/api/agents/:id/deliveries/:did/resend', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 403);
	try {
		await channels.resend(a.id, Number(c.req.param('did')));
		return c.json(await channelsView(a.id));
	} catch (err) {
		return fail(c, err);
	}
});

app.post('/api/agents/:id/schedules', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 403);
	try {
		const { cron, message } = await c.req.json();
		await channels.addSchedule(a.id, cron, message);
		return c.json(await channelsView(a.id));
	} catch (err) {
		return fail(c, err);
	}
});

app.post('/api/agents/:id/schedules/:name/:action', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 403);
	try {
		await channels.pauseSchedule(a.id, c.req.param('name'), c.req.param('action') === 'pause');
		return c.json(await channelsView(a.id));
	} catch (err) {
		return fail(c, err);
	}
});

app.delete('/api/agents/:id/schedules/:name', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 403);
	try {
		await channels.deleteSchedule(a.id, c.req.param('name'));
		return c.json(await channelsView(a.id));
	} catch (err) {
		return fail(c, err);
	}
});

// ---------- an agent's memory: conversations and browser profile ----------

app.get('/api/agents/:id/conversations', async (c) => {
	const a = await agents.seeable(c.get('me'), Number(c.req.param('id')));
	if (!a) return c.json({ error: 'No existe.' }, 404);
	c.header('Cache-Control','private, no-store');
	return c.json({ conversations: await agents.conversations(a.id), profileResetPending: await agents.pendingProfileReset(a.id) });
});

app.post('/api/agents/:id/conversations', async (c) => {
	const a = await usableAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño y quienes lo tienen compartido abren conversaciones.' }, 403);
	const body=await c.req.json().catch(()=>null);
	// The old empty POST was a destructive reset. It stays unavailable; new tabs require an explicit identity.
	if(!body?.requestId)return c.json({error:'No se reinicia la conversación. Abre una nueva explícitamente.'},410);
	try{return c.json({conversation:await conversations.create(a.id,body.requestId)});}catch(err){return fail(c,err);}
});

app.patch('/api/agents/:id/conversations/:conversation',async c=>{
 const a=await usableAgent(c);if(!a)return c.json({error:'Sólo su dueño y quienes lo tienen compartido administran las conversaciones.'},403);
 const body=await c.req.json().catch(()=>null);if(typeof body?.archived!=='boolean')return c.json({error:'Indica si quieres cerrar o reabrir el tab.'},400);
 try{return c.json({conversation:await conversations.archive(a.id,Number(c.req.param('conversation')),body.archived)});}catch(err){return fail(c,err);}
});
app.get('/api/agents/:id/conversations/:conversation',async c=>{
 const a=await agents.seeable(c.get('me'),Number(c.req.param('id')));if(!a)return c.json({error:'No existe.'},404);
 const id=Number(c.req.param('conversation'));if(!await conversations.get(a.id,id))return c.json({error:'No existe.'},404);
 const before=c.req.query('before')===undefined?undefined:Number(c.req.query('before'));
 if(before!==undefined&&(!Number.isSafeInteger(before)||before<=0))return c.json({error:'Página inválida.'},400);
 c.header('Cache-Control','private, no-store');return c.json(await conversations.transcript(a.id,id,before));
});
app.post('/api/agents/:id/conversations/:conversation/messages',async c=>{
 const a=await usableAgent(c);if(!a)return c.json({error:'Sólo su dueño y quienes lo tienen compartido escriben en esta conversación.'},403);
 const id=Number(c.req.param('conversation'));if(!await conversations.get(a.id,id))return c.json({error:'No existe.'},404);
 const body=await c.req.json().catch(()=>null);
 const attachments=Array.isArray(body?.attachments)?body.attachments:[];
 if(typeof body?.text!=='string'||body.text.length>4000||(!body.text.trim()&&!attachments.length))return c.json({error:'Escribe un mensaje de hasta 4000 caracteres o adjunta un archivo.'},400);
 try{
  const key=conversations.requestKey(body.requestId);
  if(body.replyTo!==undefined){
   if(attachments.length)throw new Error('Responde la pregunta sin adjuntos y manda los archivos en un mensaje aparte.');
   const {runId,round}=body.replyTo??{};
   if(!Number.isSafeInteger(runId)||!Number.isSafeInteger(round))throw new Error('La solicitud de ayuda cambió. Recarga antes de responder.');
   const t=await tasks.getTask(runId);if(!t||t.agent_id!==a.id||t.conversation_id!==id)throw new Error('La solicitud no pertenece a esta conversación.');
   return c.json({ok:true,...await tasks.answerHelpText(runId,round,body.text,key)});
  }
  // Someone it is shared with writes under their name, so the agent knows it is not its owner.
  const routing=await inbox.receive({agentId:a.id,personId:c.get('me').id,sender:a.person_id===c.get('me').id?null:c.get('me').name,source:'web',conversationId:id,text:body.text,attachments,dedupeKey:`chat:${key}`},{routeNow:false});
  return c.json({ok:true,...routing});
 }catch(err){return fail(c,err);}
});

// A file sent to the agent with a message (chat or webhook): whoever sees the agent sees its inbox.
app.get('/api/agents/:id/messages/:message/files/:name',async c=>{
 const a=await agents.seeable(c.get('me'),Number(c.req.param('id')));if(!a)return c.json({error:'No existe.'},404);
 const f=await inbox.inboundFile(a.id,Number(c.req.param('message')),decodeURIComponent(c.req.param('name')));
 if(!f)return c.json({error:'No existe.'},404);
 c.header('Cache-Control','private, no-store');
 return new Response(Bun.file(f.path),{headers:artifactHeaders(f.name,c.req.query('download')==='1')});
});

// The queue of messages sent while the agent works: send one now, or remove it.
async function queuedMessage(c: Context<Env>) {
	const a = await usableAgent(c);
	if (!a) throw new Error('Sólo su dueño y quienes lo tienen compartido manejan la cola.');
	const m = await row<{ run_id: number | null }>("select run_id from messages where id = $1 and agent_id = $2 and conversation_id = $3 and routed_as = 'queued'", [Number(c.req.param('message')), a.id, Number(c.req.param('conversation'))]);
	if (!m?.run_id) throw new Error('Ese mensaje ya no está en la cola.');
	return { runId: m.run_id, messageId: Number(c.req.param('message')) };
}
app.post('/api/agents/:id/conversations/:conversation/messages/:message/send', async (c) => {
	try { const q = await queuedMessage(c); await tasks.sendQueuedNow(q.runId, q.messageId); return c.json({ ok: true }); }
	catch (err) { return fail(c, err); }
});
app.delete('/api/agents/:id/conversations/:conversation/messages/:message', async (c) => {
	try { const q = await queuedMessage(c); await tasks.removeQueued(q.runId, q.messageId); return c.json({ ok: true }); }
	catch (err) { return fail(c, err); }
});

app.post('/api/agents/:id/profile/reset', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño borra el perfil del navegador.' }, 403);
	await agents.resetProfile(a.id, c.get('me').id);
	return c.json({ profileResetPending: true });
});

// ---------- vault ----------

app.get('/api/vault', async (c) => c.json({ credentials: await vault.list(c.get('me').id), uses: await vault.uses(c.get('me').id) }));
app.post('/api/vault', async (c) => {
	try {
		const b = await c.req.json();
		const name = await vault.save(c.get('me').id, { name: b.name, loginUrl: b.loginUrl, username: b.username, password: b.password });
		return c.json({ name, credentials: await vault.list(c.get('me').id) });
	} catch (err) {
		return fail(c, err);
	}
});
app.put('/api/vault/:id/grants', async (c) => {
	try {
		const { agents: ids } = await c.req.json();
		const lost = await vault.grant(c.get('me').id, Number(c.req.param('id')), Array.isArray(ids) ? ids.map(Number) : []);
		for (const a of lost) await tasks.purgeNow(a);
		return c.json({ credentials: await vault.list(c.get('me').id) });
	} catch (err) {
		return fail(c, err);
	}
});
app.delete('/api/vault/:id', async (c) => {
	const lost = await vault.remove(c.get('me').id, Number(c.req.param('id')));
	for (const a of lost) await tasks.purgeNow(a);
	return c.json({ credentials: await vault.list(c.get('me').id) });
});

// ---------- the monitor ----------

app.get('/api/monitor', (c) => c.json(monitor.view(c.get('me'))));

app.post('/api/admin/orphans/clean', async (c) => adminOnly(c) ?? c.json({ cleaned: await monitor.cleanOrphans() }));

// ---------- admin (behind the PIN) ----------

// WhatsApp: one number for every agent, linked here by an admin.
app.get('/api/admin/whatsapp', async (c) => adminOnly(c) ?? c.json(await whatsapp.status()));
app.post('/api/admin/whatsapp/pair', async (c) => {
	const denied = adminOnly(c);
	if (denied) return denied;
	try { await whatsapp.pair(); return c.json(await whatsapp.status()); }
	catch (err) { return fail(c, err); }
});
app.post('/api/admin/whatsapp/logout', async (c) => {
	const denied = adminOnly(c);
	if (denied) return denied;
	try { await whatsapp.logout(); return c.json(await whatsapp.status()); }
	catch (err) { return fail(c, err); }
});

app.get('/api/admin', async (c) =>
	adminOnly(c) ?? c.json({ settings: settings(), people: await people.everyone(), uses: await vault.uses(0, true) })
);
app.put('/api/admin/settings', async (c) => {
	const denied = adminOnly(c);
	if (denied) return denied;
	const s = await saveSettings(await c.req.json());
	await tasks.applyGlobalCap();
	return c.json({ settings: s });
});
app.put('/api/admin/people/:id/quota', async (c) => {
	const denied = adminOnly(c);
	if (denied) return denied;
	try {
		const id = Number(c.req.param('id'));
		const { quota } = await c.req.json();
		await people.setQuota(id, Number(quota));
		await tasks.applyQuota(id, Number(quota));
		return c.json({ people: await people.everyone() });
	} catch (err) {
		return fail(c, err);
	}
});
app.post('/api/admin/people/:id/invite', async (c) => adminOnly(c) ?? c.json({ code: await people.invite(Number(c.req.param('id'))) }));
app.delete('/api/admin/people/:id', async (c) => {
	const denied = adminOnly(c);
	if (denied) return denied;
	if (Number(c.req.param('id')) === c.get('me').id) return c.json({ error: 'No te puedes borrar a ti.' }, 400);
	await people.remove(Number(c.req.param('id')));
	await writeProxyConfig();
	return c.json({ ok: true });
});

// ---------- browsers' live feed ----------

// The browser says what it is looking at: {t:'watch'|'unwatch', agentId} and {t:'monitor', on};
// during a takeover it also sends {t:'input', agentId, e}.
app.get(
	'/ws',
	upgradeWebSocket((c) => {
		const me = people.whoIs(getCookie(c, people.COOKIE));
		let viewer: hub.Viewer | null = null;
		let closed = false;
		return {
			onOpen(_e, ws) {
				void me.then((person) => {
					if (closed) return;
					if (!person) return ws.close(4401, 'login');
					viewer = hub.join(person, (d: string) => ws.send(d), () => ((ws.raw as { getBufferedAmount?: () => number } | undefined)?.getBufferedAmount?.() ?? 0) > hub.BACKLOG_BYTES);
				});
			},
			async onMessage(e) {
				if (!viewer || typeof e.data !== 'string') return;
				let m: any;
				try {
					m = JSON.parse(e.data);
				} catch {
					return;
				}
				if (m.t === 'input') {
					// Takeover input; tasks.input drops it unless this person has control of that agent.
					tasks.input(viewer.person.id, Number(m.agentId), m.e);
				} else if (m.t === 'watch') {
					const a = await agents.seeable(viewer.person, Number(m.agentId));
					if (a && viewer) hub.watch(viewer, a.id, a.person_id);
				} else if (m.t === 'unwatch') {
					hub.unwatch(viewer, Number(m.agentId));
				} else if (m.t === 'monitor') {
					hub.setMonitor(viewer, Boolean(m.on));
					if (m.on) viewer.send(JSON.stringify(monitor.view(viewer.person)));
				}
			},
			onClose() {
				closed = true;
				if (viewer) hub.leave(viewer);
			}
		};
	})
);

// ---------- the web app (built) ----------

const WEB = process.env.AGENTS_WEB_DIST ?? '../web/dist';
if (existsSync(WEB)) {
	app.use('/*', serveStatic({ root: WEB }));
	app.get('*', serveStatic({ path: `${WEB}/index.html` }));
}

console.log(`agents listening on :${PORT}`);

export default { port: PORT, fetch: app.fetch, websocket, idleTimeout: 120 };
