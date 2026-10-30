// Channels: what wakes an agent besides the web, and what it says back. Agents knows no channel
// (WhatsApp, n8n, Bubble...): each agent has a signed inbound URL and a signed outbound webhook,
// and bridges translate. Cron is the agent's own: DBOS schedules, America/Mexico_City.
//
// Outbound: a delivery per event (done, incomplete, error, cancelled, and each blocked), a durable
// DBOS workflow that retries with backoff for ~24 h. Every attempt is logged; "Reenviar" copies
// the delivery into a new one.
import { randomBytes } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { row, rows, exec } from './db';
import { seal, open } from './crypto';
import { newSecret, signature, signedLink, publicUrl } from './sign';
import { getTask, artifacts } from './tasks';
import { receive } from './inbox';

export type Webhooks = {
	agent_id: number;
	in_token: string;
	in_secret_enc: string;
	in_rotated_at: number;
	out_url: string | null;
	out_secret_enc: string;
	out_rotated_at: number;
};

// ---------- the agent's webhooks ----------

/** The agent's webhooks row, created the first time someone looks. */
export async function webhooksOf(agentId: number) {
	await exec(
		`insert into agent_webhooks (agent_id, in_token, in_secret_enc, out_secret_enc) values ($1, $2, $3, $4)
		 on conflict (agent_id) do nothing`,
		[agentId, `ag_${randomBytes(18).toString('base64url')}`, seal(newSecret()), seal(newSecret())],
	);
	return (await row<Webhooks>('select * from agent_webhooks where agent_id = $1', [agentId]))!;
}

/** What the owner sees in the agent's Canales tab: URLs and secrets in the clear. */
export async function view(agentId: number) {
	const w = await webhooksOf(agentId);
	return {
		inUrl: publicUrl(`/hooks/${w.in_token}`),
		inSecret: open(w.in_secret_enc),
		inRotatedAt: w.in_rotated_at,
		outUrl: w.out_url,
		outSecret: open(w.out_secret_enc),
		outRotatedAt: w.out_rotated_at,
	};
}

export async function rotate(agentId: number, which: 'in' | 'out') {
	await webhooksOf(agentId);
	if (which === 'in') {
		// A new URL too: the old one stops answering at once.
		await exec(
			'update agent_webhooks set in_token = $2, in_secret_enc = $3, in_rotated_at = now() where agent_id = $1',
			[agentId, `ag_${randomBytes(18).toString('base64url')}`, seal(newSecret())],
		);
	} else {
		await exec('update agent_webhooks set out_secret_enc = $2, out_rotated_at = now() where agent_id = $1', [
			agentId,
			seal(newSecret()),
		]);
	}
	return view(agentId);
}

export async function setOutUrl(agentId: number, raw: string | null) {
	let url: string | null = null;
	if (raw && raw.trim()) {
		const u = new URL(raw.trim());
		if (u.protocol !== 'http:' && u.protocol !== 'https:')
			throw new Error('La URL debe empezar con http:// o https://');
		url = u.toString();
	}
	await webhooksOf(agentId);
	await exec('update agent_webhooks set out_url = $2 where agent_id = $1', [agentId, url]);
	return view(agentId);
}

/** The agent behind an inbound token, if the token is current and the agent alive. */
export function agentByToken(token: string) {
	return row<{ agent_id: number; in_secret_enc: string }>(
		`select w.agent_id, w.in_secret_enc from agent_webhooks w join agents a on a.id = w.agent_id
		 where w.in_token = $1 and a.deleted_at is null`,
		[token],
	);
}

// ---------- outbound ----------

type Event = 'done' | 'incomplete' | 'error' | 'cancelled' | 'blocked';
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

/** What a bridge receives. Built when the event happens, so a retry sends the same thing. */
async function payload(runId: number, event: Event, text: string | null) {
	const t = (await getTask(runId))!;
	const agent = (await row<{ id: number; name: string }>('select id, name from agents where id = $1', [t.agent_id]))!;
	const last = await row<{ id: number; context: unknown }>(
		`select id, context from messages where run_id = $1 and routed_as in ('new_run','queued_with','follow_up','unblock') order by id desc limit 1`,
		[runId],
	);
	const files = await artifacts(runId);
	return {
		event,
		agent: { id: agent.id, name: agent.name },
		run: {
			id: t.id,
			status: t.status,
			end_reason: t.end_reason,
			cost: t.cost,
			tokens: t.tokens,
			created_at: iso(t.created_at),
			started_at: iso(t.started_at),
			ended_at: iso(t.ended_at),
		},
		text: event === 'blocked' ? text : (t.answer ?? null),
		links: {
			run: signedLink(`/api/public/runs/${t.id}`),
			files: files.map((f) => ({
				name: f.name,
				mime: f.mime,
				size: f.size,
				url: signedLink(`/api/public/runs/${t.id}/files/${encodeURIComponent(f.name)}`),
			})),
		},
		message_id: last?.id ?? null,
		context: last?.context ?? null,
	};
}

/** Records the delivery an event causes, if the agent has an outbound URL. Returns its id. */
export async function createDelivery(runId: number, event: Event, text: string | null = null) {
	const r = await row<{ agent_id: number; out_url: string | null }>(
		'select r.agent_id, w.out_url from runs r left join agent_webhooks w on w.agent_id = r.agent_id where r.id = $1',
		[runId],
	);
	if (!r?.out_url) return null;
	const d = await row<{ id: number }>(
		`insert into webhook_deliveries (agent_id, run_id, event, url, payload, status) values ($1, $2, $3, $4, $5, 'pending') returning id`,
		[r.agent_id, runId, event, r.out_url, JSON.stringify(await payload(runId, event, text))],
	);
	await exec("update webhook_deliveries set workflow_id = 'delivery-' || id where id = $1", [d!.id]);
	return d!.id;
}

/** Outside a workflow (blocked, cancelled while queued): record and send. */
export async function notify(runId: number, event: Event, text: string | null = null) {
	const id = await createDelivery(runId, event, text);
	if (id) await startDelivery(id);
}

export const startDelivery = (id: number) => DBOS.startWorkflow(deliver, { workflowID: `delivery-${id}` })(id);

// Seconds before each attempt: about 24 h in all, then it is failed.
const BACKOFF = [0, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14400, 28800, 28800];

async function deliverFn(id: number) {
	for (let i = 0; i < BACKOFF.length; i++) {
		if (BACKOFF[i]) await DBOS.sleep(BACKOFF[i] * 1000);
		const ok = await DBOS.runStep(() => attempt(id, BACKOFF[i + 1]), { name: `attempt-${i + 1}` });
		if (ok) return;
	}
	await DBOS.runStep(
		() => exec("update webhook_deliveries set status = 'failed', next_at = null where id = $1", [id]).then(() => {}),
		{ name: 'give-up' },
	);
}
const deliver = DBOS.registerWorkflow(deliverFn, { name: 'deliver' });

async function attempt(id: number, nextInS: number | undefined) {
	const d = await row<{ url: string; payload: unknown; event: string; status: string; agent_id: number }>(
		'select url, payload, event, status, agent_id from webhook_deliveries where id = $1',
		[id],
	);
	if (!d || d.status === 'delivered') return true;
	const secret = open(
		(await row<{ out_secret_enc: string }>('select out_secret_enc from agent_webhooks where agent_id = $1', [
			d.agent_id,
		]))!.out_secret_enc,
	);
	const body = JSON.stringify({ ...(d.payload as object), delivery_id: id });
	let code: number | null = null;
	let error: string | null = null;
	try {
		const res = await fetch(d.url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'user-agent': 'agents-webhook/2',
				'x-agents-event': d.event,
				'x-agents-delivery': String(id),
				'x-agents-signature': signature(secret, body),
			},
			body,
			signal: AbortSignal.timeout(10_000),
			redirect: 'manual',
		});
		code = res.status;
		if (!res.ok) error = (await res.text().catch(() => '')).slice(0, 300) || `HTTP ${res.status}`;
	} catch (err) {
		error = (err as Error).message.slice(0, 300);
	}
	const ok = code !== null && code >= 200 && code < 300;
	await exec(
		`update webhook_deliveries set attempts = attempts + 1, last_code = $2, last_error = $3,
		   status = case when $4 then 'delivered' else status end,
		   delivered_at = case when $4 then now() else delivered_at end,
		   next_at = case when $4 or $5::int is null then null else now() + make_interval(secs => $5::int) end
		 where id = $1`,
		[id, code, ok ? null : error, ok, nextInS ?? null],
	);
	return ok;
}

export function deliveries(agentId: number) {
	return rows(
		`select id, run_id, event, url, status, attempts, last_code, last_error, next_at, resend_of, created_at, delivered_at
		 from webhook_deliveries where agent_id = $1 order by id desc limit 100`,
		[agentId],
	);
}

/** "Reenviar": the same payload, to the agent's current URL, as a new delivery. */
export async function resend(agentId: number, deliveryId: number) {
	const w = await webhooksOf(agentId);
	if (!w.out_url) throw new Error('El agente no tiene webhook de salida.');
	const d = await row<{ id: number }>(
		`insert into webhook_deliveries (agent_id, run_id, event, url, payload, status, resend_of)
		 select agent_id, run_id, event, $3, payload, 'pending', id from webhook_deliveries where id = $2 and agent_id = $1
		 returning id`,
		[agentId, deliveryId, w.out_url],
	);
	if (!d) throw new Error('No existe.');
	await exec("update webhook_deliveries set workflow_id = 'delivery-' || id where id = $1", [d.id]);
	await startDelivery(d.id);
	return d.id;
}

// ---------- cron ----------

export const TZ = 'America/Mexico_City';
const prefix = (agentId: number) => `agent:${agentId}:`;

async function cronTickFn(when: Date, ctx: { agentId: number; message: string; name: string }) {
	await DBOS.runStep(
		() =>
			receive(
				{
					agentId: ctx.agentId,
					source: 'cron',
					text: ctx.message,
					scheduleName: ctx.name,
					dedupeKey: `cron:${ctx.name}:${when.toISOString()}`,
				},
				{ routeNow: false },
			),
		{ name: 'message' },
	);
}
const cronTick = DBOS.registerWorkflow(cronTickFn, { name: 'cronTick' });

export async function schedules(agentId: number) {
	return (await DBOS.listSchedules({ scheduleNamePrefix: prefix(agentId) })).map((s) => ({
		name: s.scheduleName,
		cron: s.schedule,
		message: (s.context as { message?: string })?.message ?? '',
		status: s.status,
		timezone: s.cronTimezone,
	}));
}

/** For reads outside the server (tests, scripts): no DBOS launched means no schedules; any other error stands. */
export async function schedulesIfRunning(agentId: number) {
	try {
		return await schedules(agentId);
	} catch (err) {
		if (/DBOS\.launch\(\)/.test((err as Error).message)) return [];
		throw err;
	}
}

export async function addSchedule(agentId: number, cron: string, message: string) {
	const text = String(message ?? '')
		.trim()
		.slice(0, 4000);
	if (!text) throw new Error('Falta el mensaje.');
	const expr = String(cron ?? '').trim();
	if (expr.split(/\s+/).length !== 5)
		throw new Error('El horario va en formato cron de 5 campos: minuto hora día mes día-de-semana.');
	const name = `${prefix(agentId)}${randomBytes(4).toString('hex')}`;
	try {
		await DBOS.createSchedule({
			scheduleName: name,
			workflowFn: cronTick,
			schedule: expr,
			context: { agentId, message: text, name },
			options: { cronTimezone: TZ },
		});
	} catch (err) {
		throw new Error(`Horario inválido: ${(err as Error).message}`);
	}
	return schedules(agentId);
}

async function ownSchedule(agentId: number, name: string) {
	if (!name.startsWith(prefix(agentId))) throw new Error('No es de este agente.');
}

export async function pauseSchedule(agentId: number, name: string, paused: boolean) {
	await ownSchedule(agentId, name);
	await (paused ? DBOS.pauseSchedule(name) : DBOS.resumeSchedule(name));
	return schedules(agentId);
}

export async function deleteSchedule(agentId: number, name: string) {
	await ownSchedule(agentId, name);
	await DBOS.deleteSchedule(name);
	return schedules(agentId);
}

/**
 * Leaves the agent with exactly these schedules (an approved design's). One that is already there,
 * same cron and message, stays as it is, paused or not; the rest go, the missing ones are created.
 */
export async function syncSchedules(agentId: number, wanted: { cron: string; message: string }[]) {
	const key = (s: { cron: string; message: string }) => `${s.cron.trim().split(/\s+/).join(' ')}\n${s.message.trim()}`;
	const current = await schedules(agentId);
	const want = new Set(wanted.map(key)),
		have = new Set(current.map(key));
	for (const s of current) if (!want.has(key(s))) await DBOS.deleteSchedule(s.name);
	for (const w of wanted) if (!have.has(key(w))) await addSchedule(agentId, w.cron, w.message);
	return schedules(agentId);
}
