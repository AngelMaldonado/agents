// Runs (the HTTP API still calls them tasks): the queue, each run's sandbox, the pi event stream,
// steer/cancel and the limits. Durable with DBOS, in the same Postgres as everything else.
//
// The queue has two levels, because a person's quota is their own number:
//   admit-<id>  on queue person:<id>  (concurrency = that person's run_quota): holds the person's
//               slot and waits for
//   run-<id>    on queue sandboxes    (concurrency = the admin's global cap, priority 0 for runs
//               launched with the admin PIN, 10 for the rest): start -> wait for 'end' -> collect
//               -> finish.
// Steps run at least once (a step cut by a restart runs again), so each one is idempotent.
//
// Three tokens per run, stored as sha256. The bootstrap token reaches the container in its
// environment and only opens the supervisor's WebSocket, once. That first connection hands the
// supervisor a session token, which is how it reconnects after the backend restarts (a deploy);
// it dies with the run. The llm token is pi's provider key: it only works on the LLM gateway, for
// this run's model, while the run is live.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { row, rows, exec, tx, hash, DATA_DIR } from './db';
import * as hub from './hub';
import { settings } from './settings';
import { systemPrompt } from './prompt';
import { DockerSandbox } from './sandbox/docker';
import type { SandboxProvider } from './sandbox/provider';
import { hasKey, proxyOf, checkProxyModel, type Provider } from './providers';
import { grantedNames, resolveCredential } from './vault';
import { quotaOf } from './people';
import { stateMount } from './state';
import { createDelivery, startDelivery, notify } from './channels';
import { requestRoute, startPrompt } from './inbox';

export type Status = 'queued' | 'starting' | 'running' | 'blocked' | 'done' | 'incomplete' | 'cancelled' | 'error';
export type CharState =
	| 'idle' | 'starting' | 'thinking' | 'browsing' | 'running' | 'writing' | 'blocked' | 'steered'
	| 'done' | 'incomplete' | 'cancelled' | 'error';

export type Task = {
	id: number; agent_id: number; person_id: number; prompt: string; model: string; status: Status; state: CharState;
	container_id: string | null; workflow_id: string; priority: number; cost: number; tokens: number;
	end_reason: string | null; answer: string | null; conversation_id: number;
	created_at: number; started_at: number | null; ended_at: number | null;
};

type RunRef = { id: number; person_id: number; agent_id: number };
type End = { status: Status; reason: string | null };
type Supervisor = { send: (data: string) => void; close: () => void };
/** What only this process knows about a live run: its socket and a few timers. */
type Live = {
	ref: RunRef;
	sup?: Supervisor;
	chain: Promise<void>;
	collected?: () => void;
	steeredUntil?: number;
	lastError?: string; // the provider's error on the last assistant turn, if it failed
	ending?: boolean;
	timer?: Timer; // waiting for the supervisor to (re)connect
};

const SERVER_URL = process.env.AGENTS_SANDBOX_SERVER_URL ?? 'http://agents-server:8787';
// dev and prod share reko-3's Docker: names and labels carry the instance.
export const INSTANCE = process.env.AGENTS_INSTANCE ?? 'dev';
const LABEL = `agents.instance=${INSTANCE}`;
const LIVE: Status[] = ['queued', 'starting', 'running', 'blocked'];
const FINAL: Status[] = ['done', 'incomplete', 'cancelled', 'error'];
const SANDBOXES = 'sandboxes';
const ATTACH_MS = 3 * 60_000; // a new sandbox must dial in by then
const GRACE_MS = 60_000; // a lost supervisor must come back by then
const provider: SandboxProvider = new DockerSandbox();
const live = new Map<number, Live>();

const personQueue = (personId: number) => `person:${personId}`;
const runWorkflowId = (id: number) => `run-${id}`;

// ---------- reads ----------

/** `select ${RUN_SELECT} where ...`: a run as the API shows it, with the message that started it. */
export const RUN_SELECT = `r.id, r.agent_id, r.person_id, r.model, r.status, r.state, r.container_id, r.workflow_id,
	r.priority, r.cost, r.tokens, r.end_reason, r.answer, r.conversation_id, r.created_at, r.started_at, r.ended_at,
	coalesce((select m.text from messages m where m.run_id = r.id and m.routed_as = 'new_run' order by m.id limit 1), '') as prompt
	from runs r`;

export const getTask = (id: number) => row<Task>(`select ${RUN_SELECT} where r.id = $1`, [id]);

export const byLlmToken = (token: string) =>
	row<RunRef & { model: string }>(
		`select id, person_id, agent_id, model from runs where llm_token_hash = $1 and status in ('starting','running','blocked')`,
		[hash(token)]
	);

export function events(taskId: number, after = 0) {
	return rows<{ id: number; at: number; kind: string; data: unknown }>(
		'select seq as id, at, kind, data from run_events where run_id = $1 and seq > $2 order by seq limit 2000',
		[taskId, after]
	);
}

export function artifacts(taskId: number) {
	return rows<{ id: number; name: string; mime: string; size: number }>(
		"select id, name, mime, size from files where run_id = $1 and direction = 'out' order by name",
		[taskId]
	);
}

export async function file(taskId: number, name: string) {
	const f = await row<{ path: string; mime: string }>(
		"select path, mime from files where run_id = $1 and direction = 'out' and name = $2",
		[taskId, name]
	);
	return f && { path: joinPath(DATA_DIR, f.path), mime: f.mime };
}

/** The full stream only flows while someone has the agent's view open (thumbnails always do). */
hub.onWatchChange((agentId, watched) => {
	for (const l of live.values()) if (l.ref.agent_id === agentId) l.sup?.send(JSON.stringify({ t: 'watch', on: watched }));
});

export function publicTask(t: Task) {
	const { container_id, workflow_id, ...rest } = t;
	return rest;
}

// ---------- writes that the UI sees ----------

async function publishTask(id: number) {
	const t = await getTask(id);
	if (t) hub.publish(t.person_id, { t: 'task', task: publicTask(t) });
	return t;
}

async function event(ref: RunRef, kind: string, data: unknown) {
	const e = await row<{ seq: number; at: number }>(
		`with s as (update runs set event_seq = event_seq + 1 where id = $1 returning event_seq)
		 insert into run_events (run_id, seq, kind, data) select $1, event_seq, $2, $3 from s returning seq, at`,
		[ref.id, kind, JSON.stringify(data)]
	);
	if (e) hub.toWatchers(ref.agent_id, ref.person_id, { t: 'event', taskId: ref.id, agentId: ref.agent_id, event: { id: e.seq, at: e.at, kind, data } });
}

async function setState(id: number, state: CharState) {
	if (await exec('update runs set state = $2 where id = $1 and state <> $2', [id, state])) await publishTask(id);
}

async function setStatus(id: number, status: Status, state: CharState, from: Status[]) {
	if (await exec('update runs set status = $2, state = $3 where id = $1 and status = any($4::text[])', [id, status, state, from])) {
		await publishTask(id);
	}
}

function liveOf(ref: RunRef) {
	let l = live.get(ref.id);
	if (!l) live.set(ref.id, (l = { ref, chain: Promise.resolve() }));
	return l;
}

/** The supervisor's messages are handled one at a time, in arrival order. */
function serial(l: Live, fn: () => Promise<void>) {
	l.chain = l.chain.then(fn).catch((err) => console.error(`run ${l.ref.id}:`, (err as Error).message));
}

// ---------- queues ----------

const registered = new Map<string, number>();

async function ensureQueue(name: string, concurrency: number) {
	if (registered.get(name) === concurrency) return;
	await DBOS.registerQueue(name, { concurrency, onConflict: 'always_update' });
	registered.set(name, concurrency);
}

/** The global cap changed (Admin): the sandboxes queue follows it. */
export const applyGlobalCap = () => ensureQueue(SANDBOXES, settings().maxConcurrent);

/** A person's quota changed (Admin): their queue follows it. */
export const applyQuota = (personId: number, quota: number) => ensureQueue(personQueue(personId), quota);

// ---------- starting a run ----------

type AgentRef = { id: number; person_id: number; model: string };

/** Throws a readable error when the agent can't run now (model, keys, proxy, quota). */
export async function checkRunnable(agent: AgentRef) {
	const providerName = agent.model.split('/')[0] as Provider;
	if (providerName !== 'openai') throw new Error('Este agente usa un modelo que ya no está en el catálogo: cámbialo por uno GPT.');
	if (!(await proxyOf(agent.person_id)) && !(await hasKey(agent.person_id, providerName))) {
		throw new Error('Falta tu CLIProxyAPI o tu API key de OpenAI (Ajustes).');
	}
	await checkProxyModel(agent.person_id, agent.model);
	if ((await quotaOf(agent.person_id)) < 1) throw new Error('Tu cuota de tareas simultáneas es 0: pídele a un admin que la suba.');
}

/** The agent's live run, if any. */
export const liveRunOf = (agentId: number) =>
	row<RunRef & { status: Status }>(
		"select id, person_id, agent_id, status from runs where agent_id = $1 and status in ('queued','starting','running','blocked')",
		[agentId]
	);

/** Inserts a run for a stored message, in the agent's current conversation. */
async function insertRun(agent: AgentRef, messageId: number, priority: number, status: 'queued' | 'error', reason: string | null) {
	try {
		return await tx(async (c) => {
			let conv = await row<{ id: number }>('select id from conversations where agent_id = $1 and archived_at is null', [agent.id], c);
			conv ??= await row<{ id: number }>(
				'insert into conversations (agent_id, pi_session_id) values ($1, gen_random_uuid()::text) returning id',
				[agent.id],
				c
			);
			const { id } = (await row<{ id: number }>("select nextval(pg_get_serial_sequence('runs', 'id')) as id", [], c))!;
			await exec(
				`insert into runs (id, agent_id, person_id, conversation_id, workflow_id, model, priority, status, state, end_reason, ended_at)
				 overriding system value values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, case when $8 = 'error' then now() end)`,
				[id, agent.id, agent.person_id, conv!.id, runWorkflowId(id), agent.model, priority, status, reason],
				c
			);
			await exec("update messages set run_id = $2, routed_as = 'new_run', routed_at = now() where id = $1", [messageId, id], c);
			return id;
		});
	} catch (err) {
		if ((err as { constraint?: string }).constraint === 'runs_one_live_per_agent') throw new Error('Este agente ya tiene una tarea en curso.');
		throw err;
	}
}

/** A run for a stored message: queued on its person's queue. */
export async function startRun(agent: AgentRef, messageId: number, priority: number) {
	const id = await insertRun(agent, messageId, priority, 'queued', null);
	await publishTask(id);
	try {
		await applyQuota(agent.person_id, await quotaOf(agent.person_id));
		await DBOS.startWorkflow(admit, { workflowID: `admit-${id}`, queueName: personQueue(agent.person_id) })(id, priority);
	} catch (err) {
		await finish(id, { status: 'error', reason: `No se pudo encolar: ${(err as Error).message}` });
		throw err;
	}
	return (await getTask(id))!;
}

/** A message that can't start a run (no key, quota 0...) still gets one, ended in error, so its sender hears why. */
export async function failRun(agent: AgentRef, messageId: number, reason: string) {
	const id = await insertRun(agent, messageId, 10, 'error', reason);
	const t = (await publishTask(id))!;
	await event(t, 'status', { status: 'error', reason });
	await notify(id, 'error');
}

/** From the web: the owner launches a task on an idle agent. */
export async function enqueue(agent: AgentRef, prompt: string, opts: { admin: boolean }) {
	await checkRunnable(agent);
	if (await liveRunOf(agent.id)) throw new Error('Este agente ya tiene una tarea en curso.');
	const m = (await row<{ id: number }>(
		"insert into messages (agent_id, source, person_id, text) values ($1, 'web', $2, $3) returning id",
		[agent.id, agent.person_id, prompt.trim()]
	))!;
	try {
		return await startRun(agent, m.id, opts.admin ? 0 : 10);
	} catch (err) {
		await exec('delete from messages where id = $1 and run_id is null', [m.id]);
		throw err;
	}
}

/** Sends messages to a run's supervisor, in order; false if it is not connected right now. */
export function toSupervisor(runId: number, msgs: object[]) {
	const sup = live.get(runId)?.sup;
	if (!sup) return false;
	for (const m of msgs) sup.send(JSON.stringify(m));
	return true;
}

export async function recordEvent(runId: number, kind: string, data: unknown) {
	const t = await row<RunRef>('select id, person_id, agent_id from runs where id = $1', [runId]);
	if (t) await event(t, kind, data);
}

// ---------- the durable part ----------

async function admitFn(runId: number, priority: number) {
	const h = await DBOS.startWorkflow(sandboxRun, { workflowID: runWorkflowId(runId), queueName: SANDBOXES, enqueueOptions: { priority } })(runId);
	await h.getResult();
}
const admit = DBOS.registerWorkflow(admitFn, { name: 'admit' });

async function sandboxRunFn(runId: number) {
	const started = await DBOS.runStep(() => startSandbox(runId), { name: 'start' });
	if (!started) return; // cancelled while it waited
	let end: End;
	if ('failed' in started) {
		end = { status: 'error', reason: started.failed };
	} else {
		end = (await DBOS.recv<End>('end', { deadlineEpochMS: started.deadline })) ?? {
			status: 'incomplete',
			reason: `Se acabó el tiempo (${started.minutes} min).`
		};
		await DBOS.runStep(() => collect(runId), { name: 'collect' });
	}
	const status = await DBOS.runStep(() => finish(runId, end), { name: 'finish' });
	// The agent's webhook hears how it ended (a child workflow: retries for a day).
	const delivery = status ? await DBOS.runStep(() => createDelivery(runId, status as 'done'), { name: 'delivery' }) : null;
	if (delivery) await startDelivery(delivery);
}
const sandboxRun = DBOS.registerWorkflow(sandboxRunFn, { name: 'sandboxRun' });

/** Creates the sandbox. Run again after a crash, it replaces whatever the first try left. */
async function startSandbox(runId: number): Promise<{ deadline: number; minutes: number } | { failed: string } | null> {
	const s = settings();
	const token = randomBytes(32).toString('base64url');
	const llmToken = randomBytes(32).toString('base64url');
	const t = await row<RunRef & { model: string; started_at: number }>(
		`update runs set status = 'starting', state = 'starting', started_at = coalesce(started_at, now()),
		   bootstrap_token_hash = $2, llm_token_hash = $3, session_token_hash = null, container_id = null
		 where id = $1 and status in ('queued', 'starting')
		 returning id, person_id, agent_id, model, started_at`,
		[runId, hash(token), hash(llmToken)]
	);
	if (!t) return null;
	await publishTask(runId);
	await event(t, 'status', { status: 'starting' });
	const l = liveOf(t);
	const agent = (await row<{ id: number; state_ref: string }>('select id, state_ref from agents where id = $1', [t.agent_id]))!;
	try {
		await removeContainers(runId);
		const id = await provider.start({
			name: `agents-${INSTANCE}-run-${runId}`,
			image: s.sandboxImage,
			memoryBytes: 1536 * 1024 * 1024,
			cpus: 1,
			labels: { 'agents.instance': INSTANCE, 'agents.run': String(runId) },
			volumes: [stateMount(agent, INSTANCE)],
			env: {
				AGENTS_RUN_ID: String(runId),
				AGENTS_TASK_TOKEN: token,
				AGENTS_LLM_TOKEN: llmToken,
				AGENTS_SERVER_URL: SERVER_URL
			}
		});
		await exec('update runs set container_id = $2 where id = $1', [runId, id]);
	} catch (err) {
		await event(t, 'error', { message: `No se pudo crear la computadora: ${(err as Error).message}` });
		return { failed: 'No se pudo crear la computadora.' };
	}
	waitForSupervisor(l, ATTACH_MS, 'La computadora no arrancó.');
	return { deadline: t.started_at + s.maxMinutes * 60_000, minutes: s.maxMinutes };
}

async function removeContainers(runId: number) {
	for (const c of await provider.list(`agents.run=${runId}`)) {
		if (c.labels['agents.instance'] === INSTANCE) await provider.destroy(c.id);
	}
}

/** Tells the run's workflow it is over. The first message wins; later ones are ignored. */
async function signalEnd(runId: number, end: End) {
	const l = live.get(runId);
	if (l?.ending) return;
	if (l) {
		l.ending = true;
		clearTimeout(l.timer);
	}
	await DBOS.send(runWorkflowId(runId), end, 'end');
}

/** Keeps whatever the agent already wrote, even when it is cancelled. */
async function collect(runId: number) {
	const l = live.get(runId);
	const sup = l?.sup;
	if (!l || !sup) return;
	sup.send(JSON.stringify({ t: 'pi_cmd', cmd: { type: 'abort' } }));
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, 20_000);
		l.collected = () => {
			clearTimeout(timer);
			resolve();
		};
		sup.send(JSON.stringify({ t: 'collect' }));
	});
}

/** Ends the run; returns its final status, or null if it had already ended. */
async function finish(runId: number, end: End): Promise<Status | null> {
	const t = await getTask(runId);
	if (!t || FINAL.includes(t.status)) return null;
	const { status, reason } = end;
	const l = live.get(runId);
	try {
		l?.sup?.send(JSON.stringify({ t: 'bye' }));
		l?.sup?.close();
	} catch {}
	if (l) clearTimeout(l.timer);
	if (t.container_id) await provider.destroy(t.container_id).catch(() => {});
	await removeContainers(runId).catch(() => {});
	await exec(
		`update runs set status = $2, state = $2, end_reason = $3, ended_at = now(),
		   bootstrap_token_hash = null, session_token_hash = null, llm_token_hash = null
		 where id = $1`,
		[runId, status, reason]
	);
	await publishTask(runId);
	await event(t, 'status', { status, reason });
	hub.forgetAgent(t.agent_id);
	live.delete(runId);
	// Messages that waited for this run to end (a new conversation, a lost follow-up) go now.
	requestRoute(t.agent_id);
	return status;
}

// ---------- the sandbox's side ----------

/** If the supervisor is not (back) on its socket within `ms`, the run ends in error. */
function waitForSupervisor(l: Live, ms: number, reason: string) {
	clearTimeout(l.timer);
	l.timer = setTimeout(() => {
		if (!l.sup) void signalEnd(l.ref.id, { status: 'error', reason });
	}, ms);
}

/**
 * The supervisor connected: with the bootstrap token (first time; burnt, and it gets the run's
 * start and a session token) or with its session token (after the backend restarted).
 */
export async function attach(cred: { token?: string; session?: string }, sup: Supervisor) {
	let t: (RunRef & { model: string }) | null = null;
	let session: string | null = null;
	if (cred.token) {
		session = randomBytes(32).toString('base64url');
		t = await row(
			`update runs set bootstrap_token_hash = null, session_token_hash = $2, status = 'running', state = 'thinking'
			 where bootstrap_token_hash = $1 and status = 'starting'
			 returning id, person_id, agent_id, model`,
			[hash(cred.token), hash(session)]
		);
	} else if (cred.session) {
		t = await row(
			`select id, person_id, agent_id, model from runs where session_token_hash = $1 and status in ('running', 'blocked')`,
			[hash(cred.session)]
		);
	}
	if (!t) return null;
	const l = liveOf(t);
	const replaced = l.sup;
	l.sup = sup;
	clearTimeout(l.timer);
	try {
		replaced?.close();
	} catch {}
	if (session) {
		const agent = (await row<{ name: string; role: string }>('select name, role from agents where id = $1', [t.agent_id]))!;
		const conv = (await row<{ pi_session_id: string }>(
			'select c.pi_session_id from runs r join conversations c on c.id = r.conversation_id where r.id = $1',
			[t.id]
		))!;
		const s = settings();
		// Every message that joined while the run waited goes into its first prompt.
		const { prompt, files } = await startPrompt(t.id);
		sup.send(JSON.stringify({
			t: 'start',
			session,
			model: t.model,
			prompt,
			files,
			system: systemPrompt(agent, await grantedNames(t.agent_id)),
			blockedWaitMs: s.blockedWaitMinutes * 60_000,
			piSession: conv.pi_session_id,
			purges: await pendingPurges(t.agent_id)
		}));
		await publishTask(t.id);
		await event(t, 'status', { status: 'running' });
	} else {
		sup.send(JSON.stringify({ t: 'resumed' }));
		await event(t, 'system', { message: 'La computadora se volvió a conectar.' });
		requestRoute(t.agent_id); // follow-ups that waited for it
	}
	if (hub.watchers(t.agent_id)) sup.send(JSON.stringify({ t: 'watch', on: true }));
	return {
		message: (raw: string) => onSupervisor(l, raw),
		close: () => {
			if (l.sup !== sup) return;
			l.sup = undefined;
			if (!l.ending) waitForSupervisor(l, GRACE_MS, 'La computadora se desconectó.');
		}
	};
}

function onSupervisor(l: Live, raw: string) {
	let msg: any;
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}
	const ref = l.ref;
	if (msg.t === 'frame' || msg.t === 'thumb') {
		if (typeof msg.jpeg === 'string') (msg.t === 'frame' ? hub.frame : hub.thumb)(ref.person_id, ref.id, ref.agent_id, msg.jpeg, msg.meta ?? null);
		return;
	}
	if (msg.t === 'collected') {
		// After the files queued before it, so they are saved by then.
		serial(l, async () => l.collected?.());
		return;
	}
	serial(l, async () => {
		switch (msg.t) {
			case 'pi':
				await onPi(l, msg.ev);
				break;
			case 'blocked':
				await event(ref, 'blocked', { reason: String(msg.reason ?? '').slice(0, 2000) });
				await setStatus(ref.id, 'blocked', 'blocked', ['running']);
				// The bridge hears it: its next message is the answer (Q23).
				await notify(ref.id, 'blocked', String(msg.reason ?? '').slice(0, 2000));
				break;
			case 'unblocked':
				await event(ref, 'system', { message: msg.steered ? 'Recibió instrucciones y sigue.' : 'Nadie respondió: salta el sitio.' });
				await setStatus(ref.id, 'running', 'thinking', ['blocked']);
				break;
			case 'file':
				await saveFile(ref, String(msg.name ?? ''), String(msg.mime ?? 'application/octet-stream'), String(msg.data ?? ''));
				break;
			case 'cred': {
				// agent-browser's credential plugin asked for a login, through the supervisor.
				const reply = await resolveCredential(ref, String(msg.name ?? ''), String(msg.url ?? ''));
				if (reply.ok) await event(ref, 'credential', { name: msg.name, ok: true });
				else await event(ref, 'credential', { name: msg.name, ok: false, error: reply.error });
				l.sup?.send(JSON.stringify({ t: 'cred_res', id: msg.id, ...reply }));
				break;
			}
			case 'stderr':
				// pi's diagnostics; kept for debugging, not shown as the agent's work.
				if (msg.text) await event(ref, 'system', { message: String(msg.text).slice(0, 1000), stderr: true });
				break;
			case 'purged':
				await recordPurges(ref, Array.isArray(msg.results) ? msg.results : []);
				break;
			case 'exit':
				await signalEnd(ref.id, { status: 'error', reason: `El agente terminó inesperadamente (código ${msg.code}).` });
				break;
		}
	});
}

// ---------- the agent's browser profile ----------

type Purge = { id: number; origin: string | null };

/** What is waiting to be wiped from the agent's browser profile (null origin = all of it). */
function pendingPurges(agentId: number) {
	return rows<Purge>('select id, origin from profile_purges where agent_id = $1 and done_at is null order by id', [agentId]);
}

/** A live run applies origin purges at once (the whole profile waits: Chrome is using it). */
export async function purgeNow(agentId: number) {
	for (const l of live.values()) {
		if (l.ref.agent_id !== agentId || !l.sup) continue;
		const purges = (await pendingPurges(agentId)).filter((p) => p.origin);
		if (purges.length) l.sup.send(JSON.stringify({ t: 'purge', purges }));
	}
}

async function recordPurges(ref: RunRef, results: { id: number; ok: boolean; detail?: string }[]) {
	for (const r of results) {
		const p = await row<{ origin: string | null; credential_name: string | null; person_id: number | null }>(
			`update profile_purges set done_at = now(), run_id = $2, ok = $3, detail = $4
			 where id = $1 and agent_id = $5 and done_at is null returning origin, credential_name, person_id`,
			[Number(r.id), ref.id, Boolean(r.ok), String(r.detail ?? '').slice(0, 500), ref.agent_id]
		);
		if (!p) continue;
		const what = p.origin ? `borró cookies y almacenamiento de ${p.origin}` : 'borró el perfil del navegador';
		await event(ref, 'system', { message: r.ok ? `El navegador ${what}.` : `No se pudo: ${what} (${r.detail ?? 'sin detalle'}).` });
		if (p.credential_name && p.person_id) {
			await exec(
				`insert into credential_uses (credential_name, action, person_id, agent_id, run_id, ok, detail)
				 values ($1, 'purge', $2, $3, $4, $5, $6)`,
				[p.credential_name, p.person_id, ref.agent_id, ref.id, Boolean(r.ok), `${p.origin}${r.detail ? `: ${r.detail}` : ''}`]
			);
		}
	}
}

function toolState(name: string, args: any): CharState {
	const cmd = typeof args?.command === 'string' ? args.command : '';
	const path = typeof args?.path === 'string' ? args.path : '';
	if (name === 'bash' && /\bagents-blocked\b/.test(cmd)) return 'blocked';
	if (name === 'bash' && /\bagent-browser\b/.test(cmd)) return 'browsing';
	if ((name === 'write' || name === 'edit') && /out\//.test(path)) return 'writing';
	if (name === 'bash' && /work\/out\//.test(cmd)) return 'writing';
	return 'running';
}

function summarize(name: string, args: any) {
	if (name === 'bash') return String(args?.command ?? '').slice(0, 500);
	if (args?.path) return String(args.path);
	return JSON.stringify(args ?? {}).slice(0, 300);
}

function textOf(result: any) {
	const parts = Array.isArray(result?.content) ? result.content : [];
	return parts.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n');
}

async function onPi(l: Live, ev: any) {
	if (!ev || typeof ev.type !== 'string') return;
	const ref = l.ref;
	const steered = l.steeredUntil && l.steeredUntil > Date.now();
	switch (ev.type) {
		case 'message_update':
			if (!steered && ['thinking_delta', 'text_delta', 'toolcall_delta'].includes(ev.assistantMessageEvent?.type)) await setState(ref.id, 'thinking');
			break;
		case 'message_end': {
			const m = ev.message;
			if (m?.role !== 'assistant') break;
			const text = (Array.isArray(m.content) ? m.content : []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim();
			if (text) {
				await event(ref, 'text', { text });
				// The answer is the agent's last message: each new one replaces the previous.
				await exec('update runs set answer = $2 where id = $1', [ref.id, text]);
				await publishTask(ref.id);
			}
			if (m.stopReason === 'error' && m.errorMessage) {
				l.lastError = String(m.errorMessage).slice(0, 2000);
				await event(ref, 'error', { message: l.lastError });
			} else {
				l.lastError = undefined;
			}
			const cost = Number(m.usage?.cost?.total ?? 0);
			const tokens = Number(m.usage?.totalTokens ?? 0);
			if (cost || tokens) {
				const r = await row<{ cost: number }>(
					'update runs set cost = cost + $2, tokens = tokens + $3 where id = $1 returning cost',
					[ref.id, cost, tokens]
				);
				await publishTask(ref.id);
				const max = settings().maxCostUsd;
				if (r && r.cost > max) await signalEnd(ref.id, { status: 'incomplete', reason: `Llegó al tope de costo (US$${max}).` });
			}
			break;
		}
		case 'tool_execution_start':
			await event(ref, 'tool', { id: ev.toolCallId, name: ev.toolName, summary: summarize(ev.toolName, ev.args) });
			await setState(ref.id, toolState(ev.toolName, ev.args));
			break;
		case 'tool_execution_end': {
			const out = textOf(ev.result);
			await event(ref, 'tool_end', { id: ev.toolCallId, name: ev.toolName, isError: Boolean(ev.isError), output: out.length > 4000 ? out.slice(0, 2000) + '\n…\n' + out.slice(-1500) : out });
			if (!steered) await setState(ref.id, 'thinking');
			break;
		}
		case 'auto_retry_start':
			await event(ref, 'system', { message: `Reintento ${ev.attempt}/${ev.maxAttempts}: ${ev.errorMessage ?? ''}` });
			break;
		case 'agent_settled': {
			if (l.lastError) await signalEnd(ref.id, { status: 'error', reason: `El proveedor respondió con error: ${providerError(l.lastError)}` });
			else await signalEnd(ref.id, ev.aborted ? { status: 'incomplete', reason: 'Se interrumpió.' } : { status: 'done', reason: null });
			break;
		}
	}
}

/** "401 {..."message":"invalid x-api-key"}}" -> "401 invalid x-api-key" */
function providerError(raw: string) {
	const code = raw.match(/^\d{3}/)?.[0] ?? '';
	const msg = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? raw.slice(0, 200);
	return `${code} ${msg}`.trim();
}

async function saveFile(ref: RunRef, rawName: string, mime: string, b64: string) {
	const name = rawName.replace(/[^\w.-]/g, '_').slice(0, 100);
	if (!name || !b64) return;
	const buf = Buffer.from(b64, 'base64');
	if (buf.length > 15 * 1024 * 1024) return;
	const rel = joinPath('runs', String(ref.id), name);
	mkdirSync(joinPath(DATA_DIR, 'runs', String(ref.id)), { recursive: true });
	writeFileSync(joinPath(DATA_DIR, rel), buf);
	await exec(
		`insert into files (direction, run_id, name, path, mime, size) values ('out', $1, $2, $3, $4, $5)
		 on conflict (run_id, name) where direction = 'out' do update set path = excluded.path, mime = excluded.mime, size = excluded.size`,
		[ref.id, name, rel, mime, buf.length]
	);
}

// ---------- the human's side ----------

export async function steer(taskId: number, text: string, kind: 'steer' | 'follow_up') {
	const t = await getTask(taskId);
	const l = live.get(taskId);
	if (!t || !l?.sup || (t.status !== 'running' && t.status !== 'blocked')) throw new Error('La tarea no está corriendo.');
	const message = text.trim().slice(0, 4000);
	if (!message) throw new Error('Mensaje vacío.');
	l.sup.send(JSON.stringify({ t: 'pi_cmd', cmd: { type: kind, message } }));
	if (kind === 'steer') l.sup.send(JSON.stringify({ t: 'unblock' }));
	await event(t, kind, { text: message });
	if (kind === 'steer') {
		l.steeredUntil = Date.now() + 2500;
		await setState(taskId, 'steered');
	}
}

export async function cancel(taskId: number) {
	const t = await getTask(taskId);
	if (!t) throw new Error('No existe.');
	if (t.status === 'queued') {
		const n = await exec(
			`update runs set status = 'cancelled', state = 'cancelled', ended_at = now(), end_reason = 'Cancelada antes de empezar.',
			   bootstrap_token_hash = null, llm_token_hash = null
			 where id = $1 and status = 'queued'`,
			[taskId]
		);
		if (n) {
			for (const wf of [`admit-${taskId}`, runWorkflowId(taskId)]) await DBOS.cancelWorkflow(wf, { cancelChildren: true }).catch(() => {});
			await publishTask(taskId);
			await event(t, 'status', { status: 'cancelled', reason: 'Cancelada antes de empezar.' });
			await notify(taskId, 'cancelled');
			requestRoute(t.agent_id);
			return;
		}
	}
	if (!LIVE.includes(t.status)) throw new Error('La tarea ya terminó.');
	await signalEnd(taskId, { status: 'cancelled', reason: 'Cancelada por un humano.' });
}

// ---------- boot ----------

/**
 * After DBOS.launch() (which resumes the workflows themselves): queues, timers for the
 * supervisors that should dial back in, and sandboxes no live run owns.
 */
export async function recover() {
	await applyGlobalCap();
	for (const p of await rows<{ id: number; run_quota: number }>('select id, run_quota from people')) await applyQuota(p.id, p.run_quota);
	const running = await rows<RunRef & { status: Status }>(
		"select id, person_id, agent_id, status from runs where status in ('starting', 'running', 'blocked')"
	);
	for (const r of running) {
		const l = liveOf(r);
		if (!l.sup) waitForSupervisor(l, r.status === 'starting' ? ATTACH_MS : GRACE_MS + 30_000, 'La computadora se desconectó.');
	}
	const owned = new Set(running.map((r) => String(r.id)));
	try {
		for (const c of await provider.list(LABEL)) if (!owned.has(c.labels['agents.run'] ?? '')) await provider.destroy(c.id);
	} catch (err) {
		console.error('could not clean old sandboxes:', (err as Error).message);
	}
}
