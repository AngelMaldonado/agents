// Agents' backend: login, agents, tasks, the vault, the LLM gateway and two WebSockets
// (/ws for browsers, /sandbox/ws for the supervisor inside each task's container).
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { upgradeWebSocket, websocket, serveStatic } from 'hono/bun';
import { existsSync } from 'node:fs';
import { exec, migrate, row, rows } from './db';
import { startDbos } from './dbos';
import * as people from './people';
import * as agents from './agents';
import * as accesses from './accesses';
import { search } from './search';
import * as designs from './designs';
import * as tasks from './tasks';
import * as conversations from './conversations';
import * as pins from './pins';
import * as vault from './vault';
import * as hub from './hub';
import { settings, saveSettings, loadSettings } from './settings';
import {
	keysOf,
	setKey,
	deleteKey,
	writeProxyConfig,
	PROVIDERS,
	type Provider,
	proxyOf,
	proxyCredentials,
	normalizeProxyUrl,
	proxyModels,
	setProxy,
	deleteProxy,
} from './providers';
import { checkMasterKey, open } from './crypto';
import { gateway } from './llm';
import * as channels from './channels';
import * as inbox from './inbox';
import * as monitor from './monitor';
import * as whatsapp from './whatsapp';
import * as waSim from './whatsapp-sim';
import * as waActor from './whatsapp-actor';
import * as waLog from './whatsapp-log';
import * as simCard from './simulated-card';
import * as harnessTune from './harness-tune';
import * as lessons from './lessons';
import * as bundle from './agent-bundle';
import { cleanPersonality } from './personality';
import { SOUL_CHARS, STYLES } from '../../shared/souls';
import * as delegations from './delegations';
import * as flows from './flows';
import * as jobs from './jobs';
import * as evaluations from './evaluations';
import * as aliases from './aliases';
import * as transfers from './transfers';
import * as imageUpdates from './image-updates';
import * as computerUpdates from './computer-updates';
import * as selfMaintenance from './self-maintenance';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import * as cuby from './cuby-whatsapp';
import * as secrets from './secrets';
import { verify, checkLink } from './sign';
import { artifactHeaders, readPreview } from './artifact-preview';

checkMasterKey();
await migrate();
await loadSettings();
await writeProxyConfig();
await startDbos();
await agents.loadShares();
// Each agent's own secrets become its owner's keys (#24); conflicts stay on the agent to resolve.
{
	const moved = await accesses.migrateAgentSecrets();
	if (moved.migrated || moved.conflicts)
		console.log(`agent secrets -> person keys: ${moved.migrated} migrated, ${moved.conflicts} to resolve`);
}
await tasks.recover();
await computerUpdates.recover();
await harnessTune.recover();
computerUpdates.startReconciler();
await selfMaintenance.recoverRepairs();
selfMaintenance.startRepairReconciler();
tasks.startImageKeeper(); // a prune must not delete the images agents were validated on
tasks.startLostTurnWatch(); // a turn its pi lost in a restart is taken up
await inbox.startRouter();
whatsapp.startSleeper(); // WhatsApp groups follow lists, shares and agents; «escribiendo…» while one works
delegations.startSweeper(); // encargos: deadlines, turns a restart left and results that did not go back
flows.startSweeper(); // flujos: deadlines, waits that are over and steps nobody took
jobs.startSweeper(); // trabajos: the ones without activity for the agent's hours close
whatsapp.startDeferredSweeper(); // avisos held by the quiet hours go out at 7:00
waActor.startActors(); // the simulator's actors answer the agent as its contacts
evaluations.startSweeper(); // evaluations a restart left or that may try again
await cuby.load();
cuby.restart(); // the cuby-whatsapp consumer, when an admin turned it on
monitor.startMonitor();

// Prometheus scrapes this on its own port, never through Traefik (it names people and agents).
const METRICS_PORT = Number(process.env.AGENTS_METRICS_PORT ?? 9464);
Bun.serve({
	port: METRICS_PORT,
	fetch: async (req) =>
		new URL(req.url).pathname === '/metrics'
			? new Response(await monitor.metricsText(), { headers: { 'content-type': 'text/plain; version=0.0.4' } })
			: new Response('not here', { status: 404 }),
});

type Env = { Variables: { me: people.Person } };
const app = new Hono<Env>();
app.get('/healthz', (c) =>
	c.json({
		ready: true,
		// Empty in an image not built by a release (the Dockerfile's defaults).
		version: process.env.AGENTS_RELEASE_VERSION || 'development',
		sha: process.env.AGENTS_RELEASE_SHA || null,
	}),
);
const PORT = Number(process.env.PORT ?? 8787);
const SECURE = process.env.AGENTS_COOKIE_SECURE !== '0';

const fail = (c: Context, err: unknown, status = 400) =>
	c.json({ error: (err as Error).message ?? String(err) }, status as 400);

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
			},
		};
	}),
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
	if (!verify(c.req.header('x-agents-signature'), open(hook.in_secret_enc), raw))
		return c.json({ error: 'bad signature' }, 401);
	let body: any;
	try {
		body = JSON.parse(raw);
	} catch {
		return c.json({ error: 'invalid JSON' }, 400);
	}
	if (typeof body !== 'object' || body === null) return c.json({ error: 'the body must be a JSON object' }, 400);
	if (body.new_conversation !== undefined && body.new_conversation !== false)
		return c.json({ error: 'No se puede reiniciar la conversación del agente.' }, 400);
	try {
		const r = await inbox.receive({
			agentId: hook.agent_id,
			source: 'hook',
			text: typeof body.text === 'string' ? body.text : '',
			sender: typeof body.from === 'string' ? body.from.slice(0, 200) : null,
			context: body.context,
			attachments: Array.isArray(body.attachments) ? body.attachments : [],
			dedupeKey: c.req.header('idempotency-key')?.slice(0, 200) || null,
			// Each call is a trabajo of its own.
			job: { origin: 'hook', title: typeof body.text === 'string' ? body.text.slice(0, 80) : 'Webhook' },
		});
		return c.json(r, r.duplicate ? 200 : 202);
	} catch (err) {
		return fail(c, err);
	}
});

// ---------- the egress proxy (#24; sandbox network, shared secret + the run's token; no login) ----------

app.get('/internal/proxy/rules', async (c) => {
	if (!accesses.proxySecretOk(c.req.header('x-agents-proxy-secret'))) return c.json({ error: 'forbidden' }, 403);
	const token = c.req.header('x-agents-run-token') ?? '';
	const rules = token ? await accesses.rulesFor(token) : null;
	c.header('Cache-Control', 'no-store');
	return rules ? c.json({ rules }) : c.json({ error: 'not a live run' }, 404);
});

// ---------- the WhatsApp bridge (internal network, shared secret; no login) ----------

app.post('/internal/whatsapp/allowed', async (c) => {
	if (!whatsapp.checkSecret(c.req.header('x-agents-secret'))) return c.json({ error: 'forbidden' }, 403);
	return c.json(await whatsapp.allowed(await c.req.json()));
});
app.post('/internal/whatsapp/event', async (c) => {
	if (!whatsapp.checkSecret(c.req.header('x-agents-secret'))) return c.json({ error: 'forbidden' }, 403);
	try {
		return c.json(await whatsapp.event(await c.req.json()));
	} catch (err) {
		return fail(c, err);
	}
});

// ---------- signed links (sent in outbound webhooks; no login) ----------

app.get('/api/public/runs/:id', async (c) => {
	if (!checkLink(c.req.path, c.req.query('exp'), c.req.query('sig')))
		return c.json({ error: 'expired or invalid link' }, 403);
	const t = await tasks.getTask(Number(c.req.param('id')));
	if (!t) return c.json({ error: 'not found' }, 404);
	const { prompt, ...run } = tasks.publicTask(t);
	return c.json({ run, files: await tasks.artifacts(t.id) });
});

app.get('/api/public/runs/:id/files/:name', async (c) => {
	if (!checkLink(c.req.path, c.req.query('exp'), c.req.query('sig')))
		return c.json({ error: 'expired or invalid link' }, 403);
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
	setCookie(c, people.COOKIE, token, {
		httpOnly: true,
		sameSite: 'Lax',
		secure: SECURE,
		path: '/',
		maxAge: 400 * 86400,
	});
}

const adminOnly = (c: Context<Env>) => (c.get('me').admin ? null : c.json({ error: 'Sólo admin.' }, 403));

app.get('/api/me', (c) => {
	const me = c.get('me');
	return c.json({ me: me ?? null, pinIsSet: people.pinIsSet(), settings: me ? publicSettings() : null });
});

function publicSettings() {
	const s = settings();
	return {
		models: s.models,
		maxConcurrent: s.maxConcurrent,
		maxMinutes: s.maxMinutes,
		maxCostUsd: s.maxCostUsd,
		blockedWaitMinutes: s.blockedWaitMinutes,
		sandboxImage: s.sandboxImage,
	};
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

app.post('/api/logout', async (c) => {
	await people.endSession(getCookie(c, people.COOKIE));
	deleteCookie(c, people.COOKIE, { path: '/' });
	return c.json({ ok: true });
});

app.post('/api/admin/unlock', async (c) => {
	const { pin } = await c.req.json();
	if (!(await people.unlock(getCookie(c, people.COOKIE)!, String(pin ?? ''))))
		return c.json({ error: 'PIN incorrecto.' }, 403);
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
		catalog: settings().models.map((m) => ({ id: m.id, label: m.label, served: ids.includes(m.id.split('/')[1]) })),
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

app.get('/api/agents', async (c) => {
	const me = c.get('me');
	const mine = await aliases.of(me.id); // each viewer's own aliases, and every agent's handle
	return c.json({
		agents: (await agents.visible(me)).map((a) => ({
			...agents.forViewer(a, me),
			aliases: mine.get(a.id) ?? [],
			handle: aliases.handleOf(a.name),
			usable: a.person_id === me.id || a.shares.includes(me.id), // an admin sees others' agents but cannot use them
		})),
	});
});
// Your aliases for one agent you use (yours or shared with you): they replace the ones it had.
// .cubyagent (agent-bundle.ts): its owner downloads an agent as a file and mounts it on any instance.
app.get('/api/agents/:id/export', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	try {
		const file = await bundle.exportAgent(a, c.get('me'));
		return new Response(file.bytes as unknown as BodyInit, {
			headers: {
				'content-type': 'application/zip',
				'content-disposition': `attachment; filename="${file.name}"`,
			},
		});
	} catch (err) {
		return fail(c, err);
	}
});
const bundleBytes = async (c: Context<Env>) => {
	if (Number(c.req.header('content-length') ?? 0) > bundle.MAX_BYTES)
		throw new Error('El archivo es demasiado grande.');
	return new Uint8Array(await c.req.arrayBuffer());
};
app.post('/api/agents/import/inspect', async (c) => {
	try {
		return c.json({ preview: await bundle.inspect(await bundleBytes(c), c.get('me').id) });
	} catch (err) {
		return fail(c, err);
	}
});
app.post('/api/agents/import', async (c) => {
	try {
		return c.json(await bundle.importAgent(await bundleBytes(c), c.get('me')));
	} catch (err) {
		return fail(c, err);
	}
});
app.put('/api/agents/:id/aliases', async (c) => {
	try {
		const body = await c.req.json().catch(() => null);
		return c.json({ aliases: await aliases.set(c.get('me'), Number(c.req.param('id')), body?.aliases) });
	} catch (err) {
		return fail(c, err);
	}
});

// The sidebar's search over the person's own list: agents' conversations, what was said and answered.
app.get('/api/search', async (c) => {
	c.header('Cache-Control', 'private, no-store');
	return c.json({ hits: await search(c.get('me'), c.req.query('q')) });
});

// Creation is now an explicit approval of a stored contract, not a form bypass.
app.post('/api/agents', (c) => c.json({ error: 'Define y aprueba el contrato en Nuevo agente.' }, 409));

// Automejora → Historial: the owner's improvement chats of this agent.
app.get('/api/agents/:id/designs', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño ve las mejoras de su agente.' }, 403);
	return c.json({ designs: await designs.history(c.get('me').id, a.id) });
});
app.post('/api/designs', async (c) => {
	try {
		return c.json({ design: await designs.create(c.get('me').id, await c.req.json()) });
	} catch (err) {
		return fail(c, err);
	}
});
app.get('/api/designs/:id', async (c) => {
	try {
		return c.json({ design: await designs.get(c.get('me').id, c.req.param('id')) });
	} catch (err) {
		return fail(c, err, 404);
	}
});
// Renames the proposal (the contract's name) from the contract panel's header.
app.patch('/api/designs/:id', async (c) => {
	try {
		return c.json({ design: await designs.rename(c.get('me').id, c.req.param('id'), await c.req.json()) });
	} catch (err) {
		return fail(c, err);
	}
});
// The owner adds or skips a tool the designer found (an MCP server with its secrets, a skill, a CLI).
app.post('/api/designs/:id/findings', async (c) => {
	try {
		return c.json({ design: await designs.decideFinding(c.get('me').id, c.req.param('id'), await c.req.json()) });
	} catch (err) {
		return fail(c, err);
	}
});
// The owner saves a secret the designer asked for, as an API key of theirs (never through the model).
app.post('/api/designs/:id/secrets', async (c) => {
	try {
		return c.json({ design: await designs.saveSecret(c.get('me').id, c.req.param('id'), await c.req.json()) });
	} catch (err) {
		return fail(c, err);
	}
});
// Grants one of the accesses the designer suggested to the agent (initialization, or the improved agent).
app.post('/api/designs/:id/grant', async (c) => {
	try {
		return c.json({ design: await designs.grantSuggested(c.get('me').id, c.req.param('id'), await c.req.json()) });
	} catch (err) {
		return fail(c, err);
	}
});
// Discards a draft of a new agent (sidebar → Borradores).
app.delete('/api/designs/:id', async (c) => {
	try {
		await designs.remove(c.get('me').id, c.req.param('id'));
		return c.json({ ok: true });
	} catch (err) {
		return fail(c, err);
	}
});
app.post('/api/designs/:id/messages', async (c) => {
	// The reply can take minutes; Bun's idle timeout (120 s) would drop the request and cancel it.
	(c.env as { timeout?: (req: Request, seconds: number) => void } | undefined)?.timeout?.(c.req.raw, 0);
	try {
		return c.json({
			design: await designs.message(c.get('me').id, c.req.param('id'), await c.req.json(), c.req.raw.signal),
		});
	} catch (err) {
		return fail(c, err);
	}
});
app.get('/api/designs/:id/files/:file', async (c) => {
	try {
		const f = await designs.file(c.get('me').id, c.req.param('id'), c.req.param('file'));
		if (!f) return c.json({ error: 'No existe.' }, 404);
		return new Response(Bun.file(f.path), { headers: artifactHeaders(f.name, c.req.query('download') === '1') });
	} catch (err) {
		return fail(c, err, 404);
	}
});
app.post('/api/designs/:id/validate', async (c) => {
	try {
		return c.json({
			design: await designs.testHarness(c.get('me').id, c.req.param('id'), (await c.req.json()).version),
		});
	} catch (err) {
		return fail(c, err);
	}
});
app.post('/api/designs/:id/approve', async (c) => {
	try {
		let design = await designs.approve(c.get('me').id, c.req.param('id'), (await c.req.json()).version);
		if (!design.agent_id && !design.init_run_id && !design.last_error)
			design = await designs.initialize(c.get('me').id, design.id, c.get('me').admin, { retry: false });
		return c.json({ design });
	} catch (err) {
		return fail(c, err);
	}
});
app.post('/api/designs/:id/initialize', async (c) => {
	try {
		return c.json({
			design: await designs.initialize(c.get('me').id, c.req.param('id'), c.get('me').admin, {
				previousRunId: (await c.req.json().catch(() => ({}))).runId,
			}),
		});
	} catch (err) {
		return fail(c, err);
	}
});
app.get('/api/agents/:id/configuration', async (c) => {
	try {
		return c.json(await designs.configuration(c.get('me'), Number(c.req.param('id'))));
	} catch (err) {
		return fail(c, err, 404);
	}
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

// How long one of its trabajos may go without activity before it closes (1 h to 30 days).
app.put('/api/agents/:id/inactivity', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	const hours = Number((await c.req.json().catch(() => ({})))?.hours);
	if (!Number.isInteger(hours) || hours < 1 || hours > 720) return c.json({ error: 'Escribe de 1 a 720 horas.' }, 400);
	await exec('update agents set inactivity_hours = $2 where id = $1', [a.id, hours]);
	return c.json({ ok: true, hours });
});

// Pagos simulados: its owner turns them on to test flows; every payment of the agent is then simulated.
app.put('/api/agents/:id/simulated-payments', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	const on = (await c.req.json().catch(() => ({})))?.on === true;
	await exec('update agents set simulated_payments = $2 where id = $1', [a.id, on]);
	return c.json({ ok: true, on });
});

// Avanzado: its personality (five dials) and its harness tuned by hand (tested in the background, applied
// only if the test passes).
// Estilo: how it sounds (shared/souls.ts): a preset, or its owner's own text; it applies from its next turn.
app.put('/api/agents/:id/soul', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	const body = (await c.req.json().catch(() => ({}))) as { style?: unknown; soul?: unknown };
	const style = typeof body.style === 'string' && STYLES.some((x) => x.key === body.style) ? body.style : null;
	const soul = typeof body.soul === 'string' && body.soul.trim() ? body.soul.trim() : null;
	if (soul && soul.length > SOUL_CHARS) return c.json({ error: `Hasta ${SOUL_CHARS} caracteres.` }, 400);
	await exec('update agents set style = $2, soul = $3 where id = $1', [a.id, style, soul]);
	return c.json({ style, soul });
});
app.put('/api/agents/:id/personality', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	const personality = cleanPersonality((await c.req.json().catch(() => ({})))?.personality);
	await exec('update agents set personality = $2 where id = $1', [a.id, JSON.stringify(personality)]);
	return c.json({ personality });
});
app.get('/api/agents/:id/rank', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	return c.json({ rank: await (await import('./evaluations')).rank(a.id) });
});
// Aprendizajes: what it learned by itself after each trabajo; its owner pins or deletes them.
app.get('/api/agents/:id/lessons', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	return c.json({ lessons: await lessons.list(a.id) });
});
// Aprender: its owner teaches it something, from a trabajo (pinned, shown on that trabajo).
app.post('/api/agents/:id/lessons', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	try {
		const body = await c.req.json().catch(() => ({}));
		const conversation = Number(body?.conversation) || null;
		if (
			conversation &&
			!(await row('select 1 from conversations where id = $1 and agent_id = $2', [conversation, a.id]))
		)
			return c.json({ error: 'Ese trabajo no es de este agente.' }, 400);
		await lessons.teach(a.id, conversation, body?.text);
		return c.json({ lessons: await lessons.list(a.id) });
	} catch (err) {
		return fail(c, err);
	}
});
app.post('/api/agents/:id/lessons/delete', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	try {
		await lessons.removeMany(a.id, await c.req.json().catch(() => ({})));
		return c.json({ lessons: await lessons.list(a.id) });
	} catch (err) {
		return fail(c, err);
	}
});
app.delete('/api/agents/:id/lessons/:lesson', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	try {
		await lessons.remove(a.id, Number(c.req.param('lesson')));
		return c.json({ lessons: await lessons.list(a.id) });
	} catch (err) {
		return fail(c, err);
	}
});
app.put('/api/agents/:id/lessons/:lesson/pin', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	try {
		await lessons.pin(a.id, Number(c.req.param('lesson')), (await c.req.json().catch(() => ({})))?.on === true);
		return c.json({ lessons: await lessons.list(a.id) });
	} catch (err) {
		return fail(c, err);
	}
});
app.get('/api/agents/:id/tune', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	return c.json({ tune: await harnessTune.latest(a.id) });
});
app.post('/api/agents/:id/tune', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	try {
		return c.json({ tune: await harnessTune.request(a.id, c.get('me').id, await c.req.json().catch(() => ({}))) }, 202);
	} catch (err) {
		return fail(c, err);
	}
});

// Tarjeta simulada: the card its simulated payments use (brand, last four, expiry, holder).
app.get('/api/agents/:id/simulated-card', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	return c.json({ card: await simCard.cardOf(a.id) });
});
app.put('/api/agents/:id/simulated-card', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	try {
		return c.json({ card: await simCard.setCard(a.id, await c.req.json().catch(() => ({}))) });
	} catch (err) {
		return fail(c, err);
	}
});

// Modo objetivo: its trabajos go on by themselves until their objective is met.
app.put('/api/agents/:id/goal-mode', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	const on = (await c.req.json().catch(() => ({})))?.on === true;
	await exec('update agents set goal_mode = $2 where id = $1', [a.id, on]);
	// Turned on: its open trabajos with a list go on from where they are.
	if (on)
		for (const t of await rows<{ id: number }>(
			"select c.id from conversations c join flows f on f.conversation_id = c.id and f.status = 'running' where c.agent_id = $1 and c.status = 'open' and not c.is_default",
			[a.id],
		))
			void flows.resume(t.id).catch((err) => console.error('reanudar trabajo:', (err as Error).message));
	return c.json({ ok: true, on });
});

// Conversaciones simuladas: its WhatsApp goes to the simulator, where its owner writes as its contacts.
app.put('/api/agents/:id/simulated-conversations', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	const on = (await c.req.json().catch(() => ({})))?.on === true;
	await waSim.setOn(a.id, on);
	return c.json({ ok: true, on });
});
// Conversaciones: its WhatsApp chats (real and simulated), the latest first; ?conversation= only a trabajo's.
app.get('/api/agents/:id/chats', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño ve sus conversaciones.' }, 403);
	const conversation = Number(c.req.query('conversation')) || undefined;
	return c.json({ chats: await waLog.chats(a.id, c.get('me'), conversation), trabajos: await waLog.trabajos(a.id) });
});
app.get('/api/agents/:id/chats/:chat', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño ve sus conversaciones.' }, 403);
	const chat = c.req.param('chat');
	if (!waLog.VIEW_CHAT.test(chat)) return c.json({ error: 'Chat inválido.' }, 400);
	// Who is writing now, if anyone: its agent («…» on its side) or the simulated contact's AI.
	const typing = (await waLog.agentTyping(a.id, chat))
		? 'agent'
		: chat.startsWith('s') && waActor.isComposing(a.id, chat.slice(1))
			? 'contact'
			: null;
	return c.json({ ...(await waLog.messages(a.id, chat, Number(c.req.query('after')) || 0)), typing });
});
app.get('/api/agents/:id/sim', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño usa su simulador.' }, 403);
	const last = new Map((await waSim.last(a.id)).map((m) => [m.chat, m]));
	const actors = new Map((await waActor.list(a.id)).map((x) => [x.chat, x]));
	return c.json({
		on: await waSim.on(a.id),
		chats: (await whatsapp.simChats(a.id, c.get('me'))).map((x) => ({
			...x,
			last: last.get(x.chat) ?? null,
			actor: actors.get(x.chat) ?? null,
		})),
	});
});
app.get('/api/agents/:id/sim/:chat', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño usa su simulador.' }, 403);
	const chat = c.req.param('chat');
	if (!waSim.CHAT.test(chat)) return c.json({ error: 'Chat inválido.' }, 400);
	return c.json({ messages: await waSim.messages(a.id, chat, Number(c.req.query('after')) || 0) });
});
app.post('/api/agents/:id/sim/:chat', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño usa su simulador.' }, 403);
	try {
		return c.json(
			await whatsapp.simulate(a.id, c.get('me'), c.req.param('chat'), await c.req.json().catch(() => ({}))),
		);
	} catch (err) {
		return fail(c, err);
	}
});
// The chat's actor: GPT plays that contact; on «auto» it answers the agent until the conversation is done.
app.put('/api/agents/:id/sim/:chat/actor', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño usa su simulador.' }, 403);
	try {
		return c.json({ actor: await waActor.set(a.id, c.req.param('chat'), await c.req.json().catch(() => ({}))) });
	} catch (err) {
		return fail(c, err);
	}
});
app.delete('/api/agents/:id/sim', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño usa su simulador.' }, 403);
	await waSim.clear(a.id);
	return c.json({ ok: true });
});

app.delete('/api/agents/:id', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 404);
	const input = await c.req.json().catch(() => null);
	if (input?.confirmName !== a.name)
		return c.json({ error: 'Escribe el nombre exacto del agente para confirmar el retiro.' }, 400);
	await agents.retire(a);
	// Its schedules would keep firing at a retired agent: they go too.
	for (const s of await channels.schedules(a.id)) await channels.deleteSchedule(a.id, s.name);
	void whatsapp.syncGroups(); // a group left without agents closes
	return c.json({ ok: true });
});

// Jobs are private to their requester, including for admins. The DB record precedes durable dispatch.
async function enqueueComputerUpdate(job: Awaited<ReturnType<typeof computerUpdates.request>>) {
	await computerUpdates
		.dispatch(job.id)
		.catch((e) => console.warn('computer update queued for reconciliation:', (e as Error).message));
	void tasks.keepPinnedImages();
	return job;
}
app.get('/api/computer-updates', async (c) => {
	c.header('Cache-Control', 'private, no-store');
	return c.json(await computerUpdates.overview(c.get('me').id));
});
app.post('/api/computer-updates', async (c) => {
	try {
		return c.json(await enqueueComputerUpdate(await computerUpdates.request(c.get('me').id, await c.req.json())), 202);
	} catch (err) {
		return fail(c, err);
	}
});
app.get('/api/computer-updates/:job', async (c) => {
	try {
		c.header('Cache-Control', 'private, no-store');
		return c.json(await computerUpdates.get(c.req.param('job'), c.get('me').id));
	} catch (err) {
		return fail(c, err, 404);
	}
});
app.post('/api/computer-updates/:job/cancel', async (c) => {
	try {
		return c.json(await computerUpdates.cancelPending(c.req.param('job'), c.get('me').id));
	} catch (err) {
		return fail(c, err);
	}
});
app.post('/api/computer-updates/:job/retry', async (c) => {
	try {
		const input = await c.req.json();
		return c.json(
			await enqueueComputerUpdate(
				await computerUpdates.retryFailed(c.req.param('job'), c.get('me').id, input?.requestId),
			),
			202,
		);
	} catch (err) {
		return fail(c, err);
	}
});

// Private repair data and decisions. Shared users and admins other than the owner cannot approve.
app.get('/api/agents/:id/self-diagnosis', async (c) => {
	if (!(await ownAgent(c))) return c.json({ error: 'Sólo el dueño revisa la configuración.' }, 403);
	c.header('Cache-Control', 'private, no-store');
	try {
		return c.json(await selfMaintenance.diagnose(Number(c.req.param('id')), c.get('me').id));
	} catch (err) {
		return fail(c, err);
	}
});
app.get('/api/self-repairs/:id', async (c) => {
	c.header('Cache-Control', 'private, no-store');
	try {
		return c.json(await selfMaintenance.getRepair(c.req.param('id'), c.get('me').id));
	} catch (err) {
		return fail(c, err, 404);
	}
});
app.post('/api/self-repairs/:id/decision', async (c) => {
	try {
		const input = await c.req.json();
		if (typeof input.approve !== 'boolean') return c.json({ error: 'Elige autorizar o rechazar.' }, 400);
		const repair = await selfMaintenance.decide(c.req.param('id'), c.get('me').id, input.approve);
		return c.json(repair, 202);
	} catch (err) {
		return fail(c, err);
	}
});

// Computer image and pi: only the owner may inspect/apply the platform's published target.
app.get('/api/agents/:id/computer-update', async (c) => {
	if (!(await ownAgent(c))) return c.json({ error: 'Sólo su dueño actualiza la computadora.' }, 403);
	try {
		c.header('Cache-Control', 'private, no-store');
		return c.json(await imageUpdates.view(Number(c.req.param('id')), c.get('me').id));
	} catch (err) {
		return fail(c, err);
	}
});
app.post('/api/agents/:id/computer-update', async (c) => {
	if (!(await ownAgent(c))) return c.json({ error: 'Sólo su dueño actualiza la computadora.' }, 403);
	try {
		const input = await c.req.json();
		const job = await computerUpdates.request(c.get('me').id, {
			requestId: input?.requestId ?? randomUUID(),
			imageId: input?.imageId,
			agents: [{ id: Number(c.req.param('id')), revision: input?.revision }],
			shutdown: input?.shutdown,
		});
		return c.json(await enqueueComputerUpdate(job), 202);
	} catch (err) {
		return fail(c, err);
	}
});

// Giving it to someone else (transfers.ts): only its owner, with its computer off.
app.post('/api/agents/:id/transfer', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño lo transfiere.' }, 403);
	const input = await c.req.json().catch(() => ({}));
	if (input?.confirmName !== a.name)
		return c.json({ error: 'Escribe el nombre exacto del agente para confirmar la transferencia.' }, 400);
	const r = await transfers.transfer(a, input.to, c.get('me').id);
	void whatsapp.syncGroups(); // its groups follow its new owner
	return c.json(r);
});
app.post('/api/agents/:id/copy', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño lo copia.' }, 403);
	const input = await c.req.json().catch(() => ({}));
	const r = await transfers.copy(a, input.to, c.get('me').id);
	void whatsapp.syncGroups();
	return c.json({ to: r.to, agentId: r.agent.id, name: r.agent.name, schedules: r.schedules });
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
		return c.json({
			task: tasks.publicTask(
				await tasks.enqueue(a, prompt, {
					admin: c.get('me').admin,
					sender: a.person_id === c.get('me').id ? null : c.get('me').name,
					personId: c.get('me').id,
				}),
			),
		});
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
		artifacts: await tasks.artifacts(t.id),
	});
});

// Same ownership rules as task details/files; never expose a browser image publicly.
app.get('/api/tasks/:id/snapshot', async (c) => {
	const t = await seeableTask(c);
	if (!t) return c.json({ error: 'No existe.' }, 404);
	c.header('Cache-Control', 'private, no-store');
	return c.json({ snapshot: tasks.snapshot(t.id) });
});

// Steer and follow-up: requester or owner. An unrelated admin can watch/cancel, never steer.
app.post('/api/tasks/:id/steer', async (c) => {
	const t = await usableTask(c);
	if (!t || !tasks.directs(t, c.get('me').id)) return c.json({ error: 'Sólo quien pidió esta tarea la dirige.' }, 403);
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
	if (!t || !tasks.directs(t, c.get('me').id))
		return c.json({ error: 'Sólo quien pidió esta tarea le responde al agente.' }, 403);
	if (c.get('me').id !== t.person_id && (await tasks.helpFor(t.id)) === 'dueño')
		return c.json({ error: 'Esta pregunta es para su dueño: sólo él la responde.' }, 403);
	try {
		return c.json({ ok: true, ...(await tasks.answerHelp(t.id, await c.req.json())) });
	} catch (err) {
		return fail(c, err);
	}
});

// ---------- takeover: only the owner drives the agent's browser; the admin can only watch ----------

// Sharing: the owner picks who may use the agent. Everyone can see the names to pick from.
app.get('/api/people', async (c) => c.json({ people: await people.directory() }));
app.put('/api/agents/:id/shares', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño comparte su agente.' }, 403);
	try {
		const shares = await agents.setShares(a, (await c.req.json()).people);
		void whatsapp.syncGroups(); // whoever it is shared with gets (or loses) their group with its owner
		return c.json({ shares });
	} catch (err) {
		return fail(c, err);
	}
});

app.post('/api/agents/:id/browser', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño abre el navegador de su agente.' }, 403);
	try {
		const prompt = 'Abrí el navegador del agente para iniciar sesión o guardar métodos de pago.';
		return c.json({
			task: tasks.publicTask(await tasks.enqueue(a, prompt, { admin: c.get('me').admin, kind: 'browser' })),
		});
	} catch (err) {
		return fail(c, err);
	}
});

app.post('/api/tasks/:id/control', async (c) => {
	// Only its owner: someone it is shared with runs tasks, never drives its browser.
	const t = await tasks.getTask(Number(c.req.param('id')));
	if (!t || t.person_id !== c.get('me').id)
		return c.json({ error: 'Sólo el dueño toma el control del navegador.' }, 403);
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
	if (!c.get('me').admin && !tasks.directs(t, c.get('me').id))
		return c.json({ error: 'Sólo quien pidió esta tarea la cancela.' }, 403);
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
	try {
		return c.json({
			agentId: t.agent_id,
			runId: t.id,
			...(await readPreview(f.path, name)),
			artifacts: await tasks.artifacts(t.id),
		});
	} catch (err) {
		return fail(c, err);
	}
});

app.get('/api/tasks/:id/files/:name', async (c) => {
	const t = await seeableTask(c);
	if (!t) return c.json({ error: 'No existe.' }, 404);
	const f = await tasks.file(t.id, c.req.param('name'));
	if (!f) return c.json({ error: 'No existe.' }, 404);
	return new Response(Bun.file(f.path), {
		headers: artifactHeaders(c.req.param('name'), c.req.query('download') === '1'),
	});
});

// ---------- an agent's channels (owner only: they hold its secrets) ----------

async function channelsView(agentId: number, owner: people.Person) {
	return {
		...(await channels.view(agentId)),
		deliveries: await channels.deliveries(agentId),
		schedules: await channels.schedules(agentId),
		timezone: channels.TZ,
		whatsapp: await whatsapp.agentView(agentId, owner),
	};
}

app.get('/api/agents/:id/channels', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño ve los canales de su agente.' }, 403);
	return c.json(await channelsView(a.id, c.get('me')));
});

app.post('/api/agents/:id/channels/rotate', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 403);
	const { which } = await c.req.json();
	await channels.rotate(a.id, which === 'out' ? 'out' : 'in');
	return c.json(await channelsView(a.id, c.get('me')));
});

// ---------- an agent's credentials and MCP sign-ins (owner only; values are never returned) ----------

app.get('/api/agents/:id/secrets', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño ve las credenciales de su agente.' }, 403);
	return c.json({ secrets: await secrets.list(a.id) });
});
// An agent no longer gets secrets of its own (#24): what is left is a conflict of the migration.
app.put('/api/agents/:id/secrets/:name', (c) =>
	c.json(
		{ error: 'Las API Keys ahora son tuyas: guárdala en Configuración → Accesos y concédela a este agente.' },
		410,
	),
);
// The person keeps this agent's value for that name: it becomes their key, granted where it was.
app.post('/api/agents/:id/secrets/:name/resolve', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño resuelve las credenciales de su agente.' }, 403);
	try {
		await accesses.resolveConflict(c.get('me').id, c.req.param('name'), a.id);
		return c.json({ secrets: await secrets.list(a.id) });
	} catch (err) {
		return fail(c, err);
	}
});
// What the owner has and what this agent was granted (values never leave the server).
app.get('/api/agents/:id/access', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño ve los accesos de su agente.' }, 403);
	const me = c.get('me').id;
	c.header('Cache-Control', 'private, no-store');
	return c.json({
		keys: await accesses.listKeys(me),
		mcp: await accesses.listMcp(me),
		conflicts: await accesses.conflictsOf(a.id),
		proxyReady: !!accesses.proxyConfig(),
	});
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
	const server =
		(a.harness?.mcp ?? []).find((s) => s.name === c.req.param('server') && s.oauth) ??
		(await accesses.grantedOauth(a.id, c.req.param('server')));
	if (!server)
		return c.json({ error: 'Ese servidor MCP no está aprobado para este agente o no usa inicio de sesión.' }, 404);
	try {
		const prompt = `Iniciar sesión en el servidor MCP «${server.name}».`;
		return c.json({
			task: tasks.publicTask(
				await tasks.enqueue(a, prompt, {
					admin: c.get('me').admin,
					kind: 'browser',
					context: { mcpLogin: server.name },
				}),
			),
		});
	} catch (err) {
		return fail(c, err);
	}
});

// Trabajos: what one is for and how it went; its owner or whoever it is for ends, reopens or redirects it.
async function jobOf(c: Context<Env>) {
	const a = await usableAgent(c);
	const j = a ? await jobs.get(Number(c.req.param('conversation'))) : null;
	if (!a || !j || j.agent_id !== a.id) return null;
	return { a, j, mine: a.person_id === c.get('me').id || j.person_id === c.get('me').id };
}
app.get('/api/agents/:id/conversations/:conversation/job', async (c) => {
	const x = await jobOf(c);
	if (!x) return c.json({ error: 'No existe.' }, 404);
	return c.json({
		job: x.j,
		evaluation: await evaluations.of(x.j.id),
		// Its playbook (what its agent worked with) and what it taught (Aprendizajes).
		...(await lessons.ofTrabajo(x.j.id)),
		canManage: x.mine,
		owner: x.a.person_id === c.get('me').id,
		simulatedPayments: !!x.a.simulated_payments,
		goalMode: !!x.a.goal_mode,
	});
});
app.post('/api/agents/:id/conversations/:conversation/job/:op', async (c) => {
	const x = await jobOf(c);
	if (!x) return c.json({ error: 'No existe.' }, 404);
	if (!x.mine) return c.json({ error: 'Sólo su dueño o quien lo pidió decide sobre este trabajo.' }, 403);
	try {
		const op = c.req.param('op');
		const body = await c.req.json().catch(() => ({}));
		if (op === 'close') {
			if (!(await jobs.closeByPerson(x.j.id, c.get('me').name))) throw new Error('Este trabajo ya había terminado.');
		} else if (op === 'reopen') {
			if (!(await jobs.reopen(x.j.id))) throw new Error('Este trabajo está abierto.');
		} else if (op === 'goal') await jobs.setGoal(x.j.id, String(body?.goal ?? ''));
		else if (op === 'budget') {
			if (x.a.person_id !== c.get('me').id) throw new Error('Sólo su dueño cambia su presupuesto.');
			await jobs.setBudget(x.j.id, body ?? {});
			void flows.resume(x.j.id).catch((err) => console.error('reanudar trabajo:', (err as Error).message));
		} else if (op === 'rating') {
			if (x.a.person_id !== c.get('me').id) throw new Error('Sólo su dueño califica sus trabajos.');
			await jobs.rate(x.j.id, body?.rating, body?.note);
		} else return c.json({ error: 'Acción desconocida.' }, 400);
		return c.json({
			job: await jobs.get(x.j.id),
			evaluation: await evaluations.of(x.j.id),
			...(await lessons.ofTrabajo(x.j.id)),
		});
	} catch (err) {
		return fail(c, err);
	}
});

// Tareas: a trabajo's list; whoever sees the trabajo reads it, its owner edits it (the agent hears it).
app.get('/api/agents/:id/conversations/:conversation/tasks', async (c) => {
	const x = await jobOf(c);
	if (!x) return c.json({ error: 'No existe.' }, 404);
	return c.json({
		...(await flows.tasksOf(x.a.id, x.j.id)),
		canEdit: x.a.person_id === c.get('me').id && x.j.status === 'open' && !x.j.is_default,
	});
});
app.post('/api/agents/:id/conversations/:conversation/tasks', async (c) => {
	const x = await jobOf(c);
	if (!x) return c.json({ error: 'No existe.' }, 404);
	if (x.a.person_id !== c.get('me').id) return c.json({ error: 'Sólo su dueño cambia las tareas.' }, 403);
	try {
		return c.json({
			...(await flows.ownerEdit(x.a.id, x.j.id, await c.req.json().catch(() => ({})))),
			canEdit: true,
		});
	} catch (err) {
		return fail(c, err);
	}
});

// Flujos (#18): its owner sees them; they answer its questions and may stop one. Shared people do not.
app.get('/api/agents/:id/flows', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño ve los flujos del agente.' }, 403);
	return c.json({ flows: await flows.list(a.id) });
});
app.get('/api/agents/:id/flows/:fid', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño ve los flujos del agente.' }, 403);
	const d = await flows.detail(a.id, Number(c.req.param('fid')), Number(c.req.query('after') ?? 0));
	return d ? c.json(d) : c.json({ error: 'Ese flujo no existe.' }, 404);
});
app.post('/api/agents/:id/flows/:fid/steps/:key/answer', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño contesta las preguntas del flujo.' }, 403);
	try {
		await flows.answer(a.id, Number(c.req.param('fid')), c.req.param('key'), String((await c.req.json())?.texto ?? ''));
		return c.json({ ok: true });
	} catch (err) {
		return fail(c, err);
	}
});
app.post('/api/agents/:id/flows/:fid/stop', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño detiene los flujos del agente.' }, 403);
	try {
		await flows.stop(a.id, Number(c.req.param('fid')));
		return c.json({ ok: true });
	} catch (err) {
		return fail(c, err);
	}
});

// Encargos (#18): what each one of the agent's did, for its owner.
app.get('/api/agents/:id/delegations', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño ve los encargos del agente.' }, 403);
	const conversation = Number(c.req.query('conversation')) || undefined;
	return c.json({ delegations: await delegations.list(a.id, conversation) });
});
app.get('/api/agents/:id/delegations/:did', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño ve los encargos del agente.' }, 403);
	const d = await delegations.detail(a.id, Number(c.req.param('did')));
	return d ? c.json({ delegation: d }) : c.json({ error: 'Ese encargo no existe.' }, 404);
});
app.post('/api/agents/:id/delegations/:did/stop', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño detiene los encargos del agente.' }, 403);
	try {
		await delegations.stop(a.id, Number(c.req.param('did')));
		return c.json({ delegation: await delegations.detail(a.id, Number(c.req.param('did'))) });
	} catch (err) {
		return fail(c, err);
	}
});

app.put('/api/agents/:id/channels/whatsapp/contacts', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño decide quién le escribe a su agente.' }, 403);
	try {
		await whatsapp.setContact(a.id, c.get('me'), await c.req.json());
		return c.json(await channelsView(a.id, c.get('me')));
	} catch (err) {
		return fail(c, err);
	}
});
app.put('/api/agents/:id/channels/whatsapp', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño configura el WhatsApp de su agente.' }, 403);
	try {
		await whatsapp.setAgent(a.id, c.get('me'), await c.req.json());
		return c.json(await channelsView(a.id, c.get('me')));
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
		return c.json(await channelsView(a.id, c.get('me')));
	} catch (err) {
		return fail(c, err);
	}
});

app.post('/api/agents/:id/deliveries/:did/resend', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 403);
	try {
		await channels.resend(a.id, Number(c.req.param('did')));
		return c.json(await channelsView(a.id, c.get('me')));
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
		return c.json(await channelsView(a.id, c.get('me')));
	} catch (err) {
		return fail(c, err);
	}
});

app.post('/api/agents/:id/schedules/:name/:action', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 403);
	try {
		await channels.pauseSchedule(a.id, c.req.param('name'), c.req.param('action') === 'pause');
		return c.json(await channelsView(a.id, c.get('me')));
	} catch (err) {
		return fail(c, err);
	}
});

app.delete('/api/agents/:id/schedules/:name', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'No es tuyo.' }, 403);
	try {
		await channels.deleteSchedule(a.id, c.req.param('name'));
		return c.json(await channelsView(a.id, c.get('me')));
	} catch (err) {
		return fail(c, err);
	}
});

// ---------- the sidebar: pins and recent conversations ----------

app.get('/api/sidebar', async (c) => {
	const me = c.get('me');
	c.header('Cache-Control', 'private, no-store');
	return c.json({
		pins: await pins.list(me.id),
		conversations: await pins.recentConversations(me.id),
		drafts: await designs.drafts(me.id),
	});
});

app.put('/api/pins', async (c) => {
	const body = await c.req.json().catch(() => null);
	try {
		return c.json({ pins: await pins.set(c.get('me'), body?.kind, body?.id, body?.pinned) });
	} catch (err) {
		return fail(c, err);
	}
});

// ---------- an agent's memory: conversations and browser profile ----------

app.get('/api/agents/:id/conversations', async (c) => {
	const a = await agents.seeable(c.get('me'), Number(c.req.param('id')));
	if (!a) return c.json({ error: 'No existe.' }, 404);
	c.header('Cache-Control', 'private, no-store');
	return c.json({
		conversations: await agents.conversations(a.id),
		profileResetPending: await agents.pendingProfileReset(a.id),
	});
});

app.post('/api/agents/:id/conversations', async (c) => {
	const a = await usableAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño y quienes lo tienen compartido abren conversaciones.' }, 403);
	const body = await c.req.json().catch(() => null);
	// The old empty POST was a destructive reset. It stays unavailable; new tabs require an explicit identity.
	if (!body?.requestId) return c.json({ error: 'No se reinicia la conversación. Abre una nueva explícitamente.' }, 410);
	try {
		return c.json({ conversation: await conversations.create(a.id, body.requestId) });
	} catch (err) {
		return fail(c, err);
	}
});

app.patch('/api/agents/:id/conversations/:conversation', async (c) => {
	const a = await usableAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño y quienes lo tienen compartido administran las conversaciones.' }, 403);
	const body = await c.req.json().catch(() => null);
	const id = Number(c.req.param('conversation'));
	if (typeof body?.title === 'string')
		try {
			return c.json({ conversation: await conversations.rename(a.id, id, body.title) });
		} catch (err) {
			return fail(c, err);
		}
	if (typeof body?.archived !== 'boolean') return c.json({ error: 'Indica si quieres cerrar o reabrir el tab.' }, 400);
	try {
		return c.json({
			conversation: await conversations.archive(a.id, id, body.archived),
		});
	} catch (err) {
		return fail(c, err);
	}
});
// The hub's «Archivos recientes»: what its runs produced, newest first, with the run each came from.
app.get('/api/agents/:id/files', async (c) => {
	const a = await agents.seeable(c.get('me'), Number(c.req.param('id')));
	if (!a) return c.json({ error: 'No existe.' }, 404);
	const limit = Math.min(50, Math.max(1, Number(c.req.query('limit')) || 12));
	c.header('Cache-Control', 'private, no-store');
	return c.json({ files: await tasks.recentArtifacts(a.id, limit) });
});
app.delete('/api/agents/:id/conversations/:conversation', async (c) => {
	const a = await usableAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño y quienes lo tienen compartido eliminan sus conversaciones.' }, 403);
	try {
		await conversations.remove(a.id, Number(c.req.param('conversation')));
		return c.json({ ok: true });
	} catch (err) {
		return fail(c, err);
	}
});
app.get('/api/agents/:id/conversations/:conversation', async (c) => {
	const a = await agents.seeable(c.get('me'), Number(c.req.param('id')));
	if (!a) return c.json({ error: 'No existe.' }, 404);
	const id = Number(c.req.param('conversation'));
	if (!(await conversations.get(a.id, id))) return c.json({ error: 'No existe.' }, 404);
	const before = c.req.query('before') === undefined ? undefined : Number(c.req.query('before'));
	if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0))
		return c.json({ error: 'Página inválida.' }, 400);
	c.header('Cache-Control', 'private, no-store');
	return c.json(await conversations.transcript(a.id, id, before));
});
app.post('/api/agents/:id/conversations/:conversation/messages', async (c) => {
	const a = await usableAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño y quienes lo tienen compartido escriben en esta conversación.' }, 403);
	const id = Number(c.req.param('conversation'));
	if (!(await conversations.get(a.id, id))) return c.json({ error: 'No existe.' }, 404);
	const body = await c.req.json().catch(() => null);
	const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
	if (typeof body?.text !== 'string' || body.text.length > 4000 || (!body.text.trim() && !attachments.length))
		return c.json({ error: 'Escribe un mensaje de hasta 4000 caracteres o adjunta un archivo.' }, 400);
	try {
		const key = conversations.requestKey(body.requestId);
		// /terminar: its owner (or whoever it is for) ends the trabajo; nothing reaches the agent.
		if (/^\/terminar\b/i.test(body.text.trim())) {
			const j = await jobs.get(id);
			if (!j || j.is_default) throw new Error('Esta conversación (Principal) no es un trabajo: no se termina.');
			if (a.person_id !== c.get('me').id && j.person_id !== c.get('me').id)
				throw new Error('Sólo su dueño o quien lo pidió da por terminado un trabajo.');
			if (!(await jobs.closeByPerson(id, c.get('me').name))) throw new Error('Este trabajo ya había terminado.');
			return c.json({ ok: true, closed: true });
		}
		if (body.replyTo !== undefined) {
			if (attachments.length)
				throw new Error('Responde la pregunta sin adjuntos y manda los archivos en un mensaje aparte.');
			const { runId, round } = body.replyTo ?? {};
			if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(round))
				throw new Error('La solicitud de ayuda cambió. Recarga antes de responder.');
			const t = await tasks.getTask(runId);
			if (!t || t.agent_id !== a.id || t.conversation_id !== id)
				throw new Error('La solicitud no pertenece a esta conversación.');
			if (!tasks.directs(t, c.get('me').id)) throw new Error('Sólo quien pidió esta tarea le responde al agente.');
			return c.json({ ok: true, ...(await tasks.answerHelpText(runId, round, body.text, key)) });
		}
		// «@rd @compras revisa…»: the message goes to those agents, each in a new conversation of its own,
		// and not to this one (unless it is mentioned too). The chat it was written in stays as it was.
		const to = await aliases.mentions(c.get('me'), body.text);
		if (to) {
			if (!to.text && !attachments.length) throw new Error('Escribe el mensaje después de mencionar al agente.');
			const forwarded = [];
			for (const target of to.agents) {
				// Same request, same conversation: a retry never opens a second one.
				const h = createHash('sha256').update(`${key}:${target.id}`).digest('hex');
				const request = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
				const conversation = target.id === a.id ? id : (await conversations.create(target.id, request)).id;
				if (target.id !== a.id) await conversations.rename(target.id, conversation, to.text.slice(0, 80) || 'Archivos');
				await inbox.receive(
					{
						agentId: target.id,
						personId: c.get('me').id,
						sender: target.person_id === c.get('me').id ? null : c.get('me').name,
						source: 'web',
						conversationId: conversation,
						text: to.text,
						attachments,
						dedupeKey: `chat:${key}:${target.id}`,
					},
					{ routeNow: false },
				);
				forwarded.push({ agentId: target.id, name: target.name, conversationId: conversation });
			}
			return c.json({ ok: true, forwarded });
		}
		// Someone it is shared with writes under their name, so the agent knows it is not its owner.
		const routing = await inbox.receive(
			{
				agentId: a.id,
				personId: c.get('me').id,
				sender: a.person_id === c.get('me').id ? null : c.get('me').name,
				source: 'web',
				conversationId: id,
				text: body.text,
				attachments,
				dedupeKey: `chat:${key}`,
			},
			{ routeNow: false },
		);
		return c.json({ ok: true, ...routing });
	} catch (err) {
		return fail(c, err);
	}
});

// /reload: the chat's work goes on with the agent's current configuration (stops a live run first).
app.post('/api/agents/:id/conversations/:conversation/reload', async (c) => {
	const a = await usableAgent(c);
	if (!a) return c.json({ error: 'Sólo su dueño y quienes lo tienen compartido escriben en esta conversación.' }, 403);
	const id = Number(c.req.param('conversation'));
	if (!(await conversations.get(a.id, id))) return c.json({ error: 'No existe.' }, 404);
	try {
		const me = c.get('me');
		return c.json({ ok: true, ...(await tasks.reloadConversation(a.id, id, me, a.person_id === me.id)) });
	} catch (err) {
		return fail(c, err);
	}
});

// A file sent to the agent with a message (chat or webhook): whoever sees the agent sees its inbox.
app.get('/api/agents/:id/messages/:message/files/:name', async (c) => {
	const a = await agents.seeable(c.get('me'), Number(c.req.param('id')));
	if (!a) return c.json({ error: 'No existe.' }, 404);
	const f = await inbox.inboundFile(a.id, Number(c.req.param('message')), decodeURIComponent(c.req.param('name')));
	if (!f) return c.json({ error: 'No existe.' }, 404);
	c.header('Cache-Control', 'private, no-store');
	return new Response(Bun.file(f.path), { headers: artifactHeaders(f.name, c.req.query('download') === '1') });
});

// The queue of messages sent while the agent works: send one now, or remove it.
async function queuedMessage(c: Context<Env>) {
	const a = await usableAgent(c);
	if (!a) throw new Error('Sólo su dueño y quienes lo tienen compartido manejan la cola.');
	const m = await row<{ run_id: number | null; person_id: number | null }>(
		"select run_id, person_id::int from messages where id = $1 and agent_id = $2 and conversation_id = $3 and routed_as = 'queued'",
		[Number(c.req.param('message')), a.id, Number(c.req.param('conversation'))],
	);
	if (!m?.run_id) throw new Error('Ese mensaje ya no está en la cola.');
	// Its owner manages the whole queue; someone it is shared with, only their own messages.
	if (a.person_id !== c.get('me').id && m.person_id !== c.get('me').id)
		throw new Error('Ese mensaje es de otra persona.');
	return { runId: m.run_id, messageId: Number(c.req.param('message')) };
}
app.post('/api/agents/:id/conversations/:conversation/messages/:message/send', async (c) => {
	try {
		const q = await queuedMessage(c);
		await tasks.sendQueuedNow(q.runId, q.messageId);
		return c.json({ ok: true });
	} catch (err) {
		return fail(c, err);
	}
});
app.delete('/api/agents/:id/conversations/:conversation/messages/:message', async (c) => {
	try {
		const q = await queuedMessage(c);
		await tasks.removeQueued(q.runId, q.messageId);
		return c.json({ ok: true });
	} catch (err) {
		return fail(c, err);
	}
});

app.post('/api/agents/:id/profile/reset', async (c) => {
	const a = await ownAgent(c);
	if (!a) return c.json({ error: 'Sólo el dueño borra el perfil del navegador.' }, 403);
	await agents.resetProfile(a.id, c.get('me').id);
	return c.json({ profileResetPending: true });
});

// ---------- vault ----------

// ---------- a person's API Keys and MCP servers, granted to their agents (#24) ----------

const accessView = async (personId: number) => ({
	keys: await accesses.listKeys(personId),
	mcp: await accesses.listMcp(personId),
	proxyReady: !!accesses.proxyConfig(),
});
app.get('/api/access', async (c) => {
	c.header('Cache-Control', 'private, no-store');
	return c.json(await accessView(c.get('me').id));
});
app.post('/api/access/keys', async (c) => {
	try {
		await accesses.saveKey(c.get('me').id, await c.req.json());
		return c.json(await accessView(c.get('me').id));
	} catch (err) {
		return fail(c, err);
	}
});
app.delete('/api/access/keys/:id', async (c) => {
	await accesses.removeKey(c.get('me').id, Number(c.req.param('id')));
	return c.json(await accessView(c.get('me').id));
});
app.put('/api/access/keys/:id/grants', async (c) => {
	try {
		await accesses.grantKey(c.get('me').id, Number(c.req.param('id')), (await c.req.json()).agents);
		return c.json(await accessView(c.get('me').id));
	} catch (err) {
		return fail(c, err);
	}
});
app.post('/api/access/mcp', async (c) => {
	try {
		await accesses.saveMcp(c.get('me').id, await c.req.json());
		return c.json(await accessView(c.get('me').id));
	} catch (err) {
		return fail(c, err);
	}
});
app.delete('/api/access/mcp/:id', async (c) => {
	await accesses.removeMcp(c.get('me').id, Number(c.req.param('id')));
	return c.json(await accessView(c.get('me').id));
});
app.put('/api/access/mcp/:id/grants', async (c) => {
	try {
		await accesses.grantMcp(c.get('me').id, Number(c.req.param('id')), (await c.req.json()).agents);
		return c.json(await accessView(c.get('me').id));
	} catch (err) {
		return fail(c, err);
	}
});
app.post('/api/access/mcp/:id/test', async (c) => {
	try {
		return c.json(await accesses.testMcp(c.get('me').id, Number(c.req.param('id'))));
	} catch (err) {
		return fail(c, err);
	}
});

app.get('/api/vault', async (c) =>
	c.json({ credentials: await vault.list(c.get('me').id), uses: await vault.uses(c.get('me').id) }),
);
app.post('/api/vault', async (c) => {
	try {
		const b = await c.req.json();
		const name = await vault.save(c.get('me').id, {
			name: b.name,
			loginUrl: b.loginUrl,
			username: b.username,
			password: b.password,
		});
		return c.json({ name, credentials: await vault.list(c.get('me').id) });
	} catch (err) {
		return fail(c, err);
	}
});
app.put('/api/vault/:id/grants', async (c) => {
	try {
		const { agents: ids } = await c.req.json();
		const lost = await vault.grant(
			c.get('me').id,
			Number(c.req.param('id')),
			Array.isArray(ids) ? ids.map(Number) : [],
		);
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

// ---------- WhatsApp numbers (#18): anyone links theirs; an admin also offers public and private ones ----------

const wa = (fn: (c: Context<Env>) => Promise<unknown>) => async (c: Context<Env>) => {
	try {
		return c.json(await fn(c));
	} catch (err) {
		return fail(c, err);
	}
};
const numberId = (c: Context<Env>) => Number(c.req.param('id'));
app.get(
	'/api/whatsapp/numbers',
	wa((c) => whatsapp.numbers(c.get('me'))),
);
app.post(
	'/api/whatsapp/numbers',
	wa(async (c) => whatsapp.add(c.get('me'), await c.req.json())),
);
app.get(
	'/api/whatsapp/numbers/:id/pairing',
	wa((c) => whatsapp.pairing(c.get('me'), numberId(c))),
);
app.patch(
	'/api/whatsapp/numbers/:id',
	wa(async (c) => whatsapp.update(c.get('me'), numberId(c), await c.req.json())),
);
app.delete(
	'/api/whatsapp/numbers/:id',
	wa((c) => whatsapp.remove(c.get('me'), numberId(c))),
);
// Who may write to a number: its allow list (attended) and block list (refused).
app.get(
	'/api/whatsapp/numbers/:id/lists',
	wa((c) => whatsapp.lists(c.get('me'), numberId(c))),
);
app.put(
	'/api/whatsapp/numbers/:id/lists',
	wa(async (c) => whatsapp.setLists(c.get('me'), numberId(c), await c.req.json())),
);

// ---------- admin (behind the PIN) ----------

app.get(
	'/api/admin',
	async (c) =>
		adminOnly(c) ?? c.json({ settings: settings(), people: await people.everyone(), uses: await vault.uses(0, true) }),
);
// cuby-whatsapp (#18): the company number as a channel for everyone's agents; its keys only go in here.
app.get('/api/admin/cuby-whatsapp', (c) => adminOnly(c) ?? c.json(cuby.adminView()));
app.put('/api/admin/cuby-whatsapp', async (c) => {
	const denied = adminOnly(c);
	if (denied) return denied;
	try {
		return c.json(await cuby.configure(c.get('me'), await c.req.json()));
	} catch (err) {
		return fail(c, err);
	}
});
// Each person's own phone on the company number, as they write it (no code).
app.get('/api/whatsapp/cuby/link', async (c) => c.json(await cuby.linkView(c.get('me'))));
app.post('/api/whatsapp/cuby/link', async (c) => {
	try {
		return c.json(await cuby.startLink(c.get('me'), await c.req.json()));
	} catch (err) {
		return fail(c, err);
	}
});
app.delete('/api/whatsapp/cuby/link', async (c) => c.json(await cuby.unlink(c.get('me'))));
// The photo of my groups «Agentes <me>».
app.get('/api/whatsapp/group-photo', async (c) => c.json(await whatsapp.groupPhotoView(c.get('me'))));
app.put('/api/whatsapp/group-photo', async (c) => {
	try {
		return c.json(await whatsapp.setGroupPhoto(c.get('me'), await c.req.json()));
	} catch (err) {
		return fail(c, err);
	}
});
app.delete('/api/whatsapp/group-photo', async (c) => c.json(await whatsapp.setGroupPhoto(c.get('me'), null)));
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
app.post(
	'/api/admin/people/:id/invite',
	async (c) => adminOnly(c) ?? c.json({ code: await people.invite(Number(c.req.param('id'))) }),
);
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
					viewer = hub.join(
						person,
						(d: string) => ws.send(d),
						() =>
							((ws.raw as { getBufferedAmount?: () => number } | undefined)?.getBufferedAmount?.() ?? 0) >
							hub.BACKLOG_BYTES,
					);
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
			},
		};
	}),
);

// ---------- the owner's terminal and desktop on the agent's computer (#27) ----------
// Only its owner (not people it is shared with, not an admin), only while the computer is on.
// Terminal: text frames {t:'in',d} / {t:'size',cols,rows}; binary frames out. Desktop: raw RFB both ways.

const channelRoute = (kind: 'pty' | 'vnc') =>
	upgradeWebSocket((c) => {
		const agentId = Number(c.req.param('id'));
		const ready = (async () => {
			const me = await people.whoIs(getCookie(c, people.COOKIE));
			const a = me ? await agents.get(agentId) : null;
			return me && a && a.person_id === me.id ? me : null;
		})();
		let ch: ReturnType<typeof tasks.openChannel> = null;
		let closed = false;
		// What the client sends right after connecting (its size, the first keys) waits for the channel.
		const early: Parameters<typeof take>[0][] = [];
		const take = (data: unknown) => {
			if (!ch) return void (early.length < 256 && early.push(data));
			if (kind === 'pty' && typeof data === 'string') {
				let m: any;
				try {
					m = JSON.parse(data);
				} catch {
					return;
				}
				if (m.t === 'in' && typeof m.d === 'string') ch.write(Buffer.from(m.d.slice(0, 64 * 1024)));
				else if (m.t === 'size') ch.resize(Number(m.cols), Number(m.rows));
				return;
			}
			if (kind === 'vnc' && typeof data !== 'string') {
				const d = data as ArrayBuffer | Uint8Array | Blob;
				if (d instanceof Blob) void d.arrayBuffer().then((b) => ch?.write(Buffer.from(b)));
				else ch.write(Buffer.from(d instanceof Uint8Array ? d : new Uint8Array(d)));
			}
		};
		return {
			onOpen(_e, ws) {
				void ready.then((me) => {
					if (closed) return;
					if (!me) return ws.close(4403, 'Sólo el dueño del agente.');
					ch = tasks.openChannel(agentId, me, kind, {
						data: (b) => ws.send(new Uint8Array(b)),
						closed: () => ws.close(1000, 'cerrado'),
					});
					if (!ch) return ws.close(4409, 'La computadora del agente está apagada.');
					for (const d of early.splice(0)) take(d);
				});
			},
			onMessage(e) {
				take(e.data);
			},
			onClose() {
				closed = true;
				ch?.close();
			},
		};
	});
app.get('/api/agents/:id/terminal', channelRoute('pty'));
app.get('/api/agents/:id/desktop', channelRoute('vnc'));

app.post('/api/tasks/:id/mcp-requests/:rid', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	await tasks.answerMcpRequest(c.get('me').id, Number(c.req.param('id')), c.req.param('rid'), body.accept === true);
	return c.json({ ok: true });
});

// ---------- the web app (built) ----------

const WEB = process.env.AGENTS_WEB_DIST ?? '../web/dist';
if (existsSync(WEB)) {
	app.use('/*', serveStatic({ root: WEB }));
	app.get('*', serveStatic({ path: `${WEB}/index.html` }));
}

console.log(`agents listening on :${PORT}`);

export default { port: PORT, fetch: app.fetch, websocket, idleTimeout: 120 };
