// Runs (the HTTP API still calls them tasks): the queue, each run's sandbox, the pi event stream,
// steer/cancel and the limits. Durable with DBOS, in the same Postgres as everything else.
//
// The queue has two levels, because a person's quota is their own number:
//   admit-<uuid>  on queue person:<id>  (concurrency = that person's run_quota): holds the person's
//               slot and waits for
//   run-<uuid>    on queue sandboxes    (concurrency = the admin's global cap, priority 0 for runs
//               launched with the admin PIN, 10 for the rest): start -> wait for 'end' -> collect
//               -> finish.
// Steps run at least once (a step cut by a restart runs again), so each one is idempotent.
//
// Three tokens per run, stored as sha256. The bootstrap token reaches the container in its
// environment and only opens the supervisor's WebSocket, once. That first connection hands the
// supervisor a session token, which is how it reconnects after the backend restarts (a deploy);
// it dies with the run. The llm token is pi's provider key: it only works on the LLM gateway, for
// this run's model, while the run is live.
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { DBOS, Error as DBOSError } from '@dbos-inc/dbos-sdk';
import { row, rows, exec, tx, hash, DATA_DIR, type Exec } from './db';
import { decodeHelp, helpData } from './help';
import { defaultConversation, requestKey } from './conversations';
import { validateAnswers } from './interview';
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
import { requestRoute, startPrompt, filesFor, render } from './inbox';
import * as whatsapp from './whatsapp';
import * as secrets from './secrets';
import { browserSnapshot, readSnapshot, saveSnapshot, type BrowserSnapshot } from './snapshots';
import { definition, digest, defaultHarness, withHarnessPrompt, type Definition } from './harnesses';
import { runtimeToolNames } from '../../sandbox/harness';
import { newRunWorkflowId, isNewRunWorkflowId, admissionWorkflowId } from './run-identity';
export const snapshot = (runId: number) => readSnapshot(DATA_DIR, runId);

export type Status = 'queued' | 'starting' | 'running' | 'blocked' | 'done' | 'incomplete' | 'cancelled' | 'error';
export type CharState =
	| 'idle' | 'starting' | 'thinking' | 'browsing' | 'running' | 'writing' | 'blocked' | 'steered'
	| 'done' | 'incomplete' | 'cancelled' | 'error';

export type Task = {
	definition: Definition | null;
	id: number; agent_id: number; person_id: number; prompt: string; model: string; status: Status; state: CharState; kind: Kind;
	container_id: string | null; workflow_id: string; priority: number; cost: number; tokens: number;
	end_reason: string | null; answer: string | null; conversation_id: number;
	created_at: number; started_at: number | null; ended_at: number | null;
	requested_by: number | null; requested_by_name: string | null; // someone it is shared with; null: its owner
};

/** browser: Chrome only, no pi, for the owner to sign in and save payment methods in the profile. */
export type Kind = 'task' | 'initialize' | 'browser';
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
	browserSnapshot?: BrowserSnapshot;
	snapshotFinal?: boolean;
	ending?: boolean;
	timer?: Timer; // waiting for the supervisor to (re)connect
	kind?: Kind;
	control?: boolean; // someone drives the browser; pi is stopped
	controller?: number; // who: the owner or someone the agent is shared with
	takeover?: boolean; // its supervisor said it can be driven (older images cannot)
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

// ---------- reads ----------

/** `select ${RUN_SELECT} where ...`: a run as the API shows it, with the message that started it. */
export const RUN_SELECT = `r.id, r.agent_id, r.person_id, r.model, r.status, r.state, r.kind, r.container_id, r.workflow_id,
	r.priority, r.cost, r.tokens, r.end_reason, r.answer, r.conversation_id, r.created_at, r.started_at, r.ended_at, r.definition,
	coalesce((select m.text from messages m where m.run_id = r.id and m.routed_as = 'new_run' order by m.id limit 1), '') as prompt,
	(select case when m.source = 'web' and m.person_id is distinct from r.person_id then m.person_id end from messages m where m.run_id = r.id and m.routed_as = 'new_run' order by m.id limit 1)::int as requested_by,
	(select p.name from people p where p.id = (select case when m.source = 'web' and m.person_id is distinct from r.person_id then m.person_id end from messages m where m.run_id = r.id and m.routed_as = 'new_run' order by m.id limit 1)) as requested_by_name
	from runs r`;

/**
 * A run is one person's task: whoever asked for it (or the agent's owner) answers, steers or cancels
 * it, and only their messages join it. Everyone else's wait for it to end (inbox.routeOnce).
 */
export const directs = (t: Pick<Task, 'person_id' | 'requested_by'>, personId: number) => personId === t.person_id || personId === t.requested_by;

export const getTask = (id: number) => row<Task>(`select ${RUN_SELECT} where r.id = $1`, [id]);

export const byLlmToken = (token: string) =>
	row<RunRef & { model: string }>(
		`select id, person_id, agent_id, model from runs where llm_token_hash = $1 and status in ('starting','running','blocked')`,
		[hash(token)]
	);

export async function events(taskId: number, after = 0, chatOnly = false) {
	const saved = await rows<{ id: number; at: number; kind: string; data: any }>(
		`select seq as id, at, kind, data from run_events where run_id = $1 and seq > $2 and (not $3::boolean or kind in ('text','blocked','help_answer','help_reply','steer','follow_up','unblocked','help_expired')) order by seq limit $4`,
		[taskId, after,chatOnly,chatOnly?null:2000]
	);
	const answered = new Map((await rows<{data:{round:number;questions?:import('./interview').Question[]}}>("select data from run_events where run_id=$1 and kind in ('help_answer','help_reply')",[taskId])).map(e=>[e.data.round,e.data]));
	return saved.map(e => e.kind === 'blocked' ? { ...e, data: helpData(e.data,answered.has(e.id),answered.get(e.id)?.questions) } : e);
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
	const { container_id, workflow_id, definition: d, ...rest } = t;
	return { ...rest, control: !!live.get(t.id)?.control, controller: live.get(t.id)?.control ? live.get(t.id)?.controller ?? t.person_id : null, definition: d ? { revision: d.revision, digest: d.digest, harnessDigest: d.harnessDigest, image: d.image } : null };
}

// ---------- writes that the UI sees ----------

async function publishTask(id: number) {
	const t = await getTask(id);
	if (t) hub.publish(t.person_id, { t: 'task', task: publicTask(t) });
	return t;
}

async function storeEvent(runId: number, kind: string, data: unknown, on?: Exec) {
	return row<{ seq: number; at: number }>(
		`with s as (update runs set event_seq = event_seq + 1 where id = $1 returning event_seq)
		 insert into run_events (run_id, seq, kind, data) select $1, event_seq, $2, $3 from s returning seq, at`,
		[runId, kind, JSON.stringify(data)], on
	);
}
async function event(ref: RunRef, kind: string, data: unknown) {
	const e = await storeEvent(ref.id, kind, data);
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
export async function checkRunnable(agent: AgentRef, opts: { initialization?: boolean } = {}) {
	const providerName = agent.model.split('/')[0] as Provider;
	if (providerName !== 'openai') throw new Error('Este agente usa un modelo que ya no está en el catálogo: cámbialo por uno GPT.');
	if (!(await proxyOf(agent.person_id)) && !(await hasKey(agent.person_id, providerName))) {
		throw new Error('Falta tu CLIProxyAPI o tu API key de OpenAI (Ajustes).');
	}
	await checkProxyModel(agent.person_id, agent.model);
	if (!opts.initialization && await row(`select 1 from agent_designs d left join runs r on r.id=d.init_run_id
	 where d.applied_agent_id=$1 and d.agent_id is null and (r.status is null or r.status <> 'done')`, [agent.id])) {
		throw new Error('Completa la inicialización de este agente antes de darle tareas.');
	}
	if ((await quotaOf(agent.person_id)) < 1) throw new Error('Tu cuota de tareas simultáneas es 0: pídele a un admin que la suba.');
}

/** The agent's live run, if any. */
export const liveRunOf = (agentId: number) =>
	row<RunRef & { status: Status; conversation_id:number; kind: Kind; requested_by: number | null }>(
		`select r.id, r.person_id, r.agent_id, r.status, r.conversation_id, r.kind, (select case when m.source = 'web' and m.person_id is distinct from r.person_id then m.person_id end from messages m where m.run_id = r.id and m.routed_as = 'new_run' order by m.id limit 1)::int as requested_by from runs r where r.agent_id = $1 and r.status in ('queued','starting','running','blocked')`,
		[agentId]
	);

/** Inserts a run for a stored message, in the agent's current conversation. */
async function insertRun(agent: AgentRef, messageId: number, priority: number, status: 'queued' | 'error', reason: string | null, kind: Kind = 'task') {
	try {
		return await tx(async (c) => {
			const current = await row<Parameters<typeof definition>[0]>('select * from agents where id=$1 and deleted_at is null for update', [agent.id], c);
			if (!current || current.model !== agent.model) throw new Error('La configuración del agente cambió. Recarga y reintenta.');
			const message = await row<{conversation_id:number;run_id:number|null}>(`select m.conversation_id,m.run_id from messages m join conversations c on c.id=m.conversation_id and c.agent_id=m.agent_id where m.id=$1 and m.agent_id=$2 for update of m`,[messageId,agent.id],c);
			if (!message) throw new Error('El mensaje no pertenece a esta conversación.');
			if (message.run_id) return message.run_id;
			const conv = {id:message.conversation_id};
			const { id } = (await row<{ id: number }>("select nextval(pg_get_serial_sequence('runs', 'id')) as id", [], c))!;
			await exec(
				`insert into runs (id, agent_id, person_id, conversation_id, workflow_id, model, priority, status, state, end_reason, ended_at, kind, definition)
				 overriding system value values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, case when $8 = 'error' then now() end, $10, $11)`,
				[id, agent.id, agent.person_id, conv!.id, newRunWorkflowId(), agent.model, priority, status, reason, kind, JSON.stringify(definition(current))],
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
export async function startRun(agent: AgentRef, messageId: number, priority: number, kind: Kind = 'task') {
	const id = await insertRun(agent, messageId, priority, 'queued', null, kind);
	const t = (await publishTask(id))!;
	try {
		await applyQuota(agent.person_id, await quotaOf(agent.person_id));
		await enqueueAdmission(t);
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
	await whatsapp.onRun(id, 'error');
}

/** From the web: the owner launches a task on an idle agent. */
export async function enqueue(agent: AgentRef, prompt: string, opts: { admin: boolean; kind?: Kind; context?: unknown; sender?: string | null; personId?: number }) {
	// A browser session calls no model: it only needs a free slot.
	if (opts.kind === 'browser') {
		if ((await quotaOf(agent.person_id)) < 1) throw new Error('Tu cuota de tareas simultáneas es 0: pídele a un admin que la suba.');
	} else await checkRunnable(agent, { initialization: opts.kind === 'initialize' });
	if (await liveRunOf(agent.id)) throw new Error('Este agente ya tiene una tarea en curso.');
	const m = await tx(async c=>{
		await row('select id from agents where id=$1 for update',[agent.id],c);
		const conv=await defaultConversation(agent.id,c);
		return (await row<{id:number}>("insert into messages (agent_id,conversation_id,source,person_id,sender,text,context) values ($1,$2,'web',$3,$4,$5,$6) returning id",[agent.id,conv.id,opts.personId??agent.person_id,opts.sender??null,prompt.trim(),opts.context===undefined?null:JSON.stringify(opts.context)],c))!;
	});
	try {
		return await startRun(agent, m.id, opts.admin ? 0 : 10, opts.kind);
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

async function enqueueAdmission(t: Pick<Task, 'id' | 'workflow_id' | 'person_id' | 'priority'>) {
 await DBOS.startWorkflow(admit, { workflowID: admissionWorkflowId(t.workflow_id), queueName: personQueue(t.person_id) })(t.id, t.priority);
}
async function admitFn(runId: number, priority: number) {
 // This stable identity read adds no checkpoint/step: keep legacy replay order intact.
 const t = await row<{ workflow_id: string }>('select workflow_id from runs where id=$1', [runId]);
 if (!t || admissionWorkflowId(t.workflow_id) !== DBOS.workflowID) return;
	const h = await DBOS.startWorkflow(sandboxRun, { workflowID: t.workflow_id, queueName: SANDBOXES, enqueueOptions: { priority } })(runId);
	await h.getResult();
}
const admit = DBOS.registerWorkflow(admitFn, { name: 'admit' });

async function sandboxRunFn(runId: number) {
 const t = await row<{ workflow_id: string }>('select workflow_id from runs where id=$1', [runId]);
 if (!t || t.workflow_id !== DBOS.workflowID) return; // fence stale workflows after numeric-ID reuse
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
	const delivery = status ? await DBOS.runStep(async () => (await getTask(runId))?.kind !== 'task' ? null : createDelivery(runId, status as 'done'), { name: 'delivery' }) : null;
	if (delivery) await startDelivery(delivery);
	// After the existing steps, so replaying an older workflow keeps its order.
	if (status) await DBOS.runStep(() => whatsapp.onRun(runId, status as 'done'), { name: 'whatsapp' });
}
const sandboxRun = DBOS.registerWorkflow(sandboxRunFn, { name: 'sandboxRun' });

/** Creates the sandbox. Run again after a crash, it replaces whatever the first try left. */
async function startSandbox(runId: number): Promise<{ deadline: number; minutes: number } | { failed: string } | null> {
	const s = settings();
	const token = randomBytes(32).toString('base64url');
	const llmToken = randomBytes(32).toString('base64url');
	const t = await row<RunRef & { model: string; started_at: number; definition: Definition | null; kind: Kind }>(
		`update runs set status = 'starting', state = 'starting', started_at = coalesce(started_at, now()),
		   bootstrap_token_hash = $2, llm_token_hash = $3, session_token_hash = null, container_id = null
		 where id = $1 and status in ('queued', 'starting')
		 returning id, person_id, agent_id, model, started_at, definition, kind`,
		[runId, hash(token), hash(llmToken)]
	);
	if (!t) return null;
	await publishTask(runId);
	await event(t, 'status', { status: 'starting' });
	const l = liveOf(t);
	const agent = (await row<{ id: number; state_ref: string }>('select id, state_ref from agents where id = $1', [t.agent_id]))!;
	try {
		await removeContainers(runId);
		// A browser session runs no harness: it takes today's image, the one that knows that mode,
		// not the image the agent's harness was validated on.
		if (t.kind === 'browser') t.definition = null;
		if (t.definition && !t.definition.image) {
			const { digest: _digest, harnessDigest: _harnessDigest, ...value } = t.definition;
			value.image = await new DockerSandbox().imageId(s.sandboxImage);
			t.definition = { ...value, digest: digest(value), harnessDigest: _harnessDigest };
			await exec('update runs set definition=$2 where id=$1', [runId, JSON.stringify(t.definition)]);
		}
		const id = await provider.start({
			name: `agents-${INSTANCE}-run-${runId}`,
			image: t.definition?.image ?? s.sandboxImage,
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
		// The image the agent's harness was validated on was deleted from the host: say what fixes it.
		if (/No such image/i.test((err as Error).message) && t.definition?.image) {
			return { failed: 'No se pudo crear la computadora: la imagen con la que se validó este agente ya no existe en el servidor. Vuelve a validar y aprobar su configuración en Automejora.' };
		}
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
	const t = await row<{ workflow_id: string }>('select workflow_id from runs where id=$1', [runId]);
 if (t) {
  try { await DBOS.send(t.workflow_id, end, 'end'); }
  catch (err) {
   if (err instanceof DBOSError.DBOSNonExistentWorkflowError) {
    await finish(runId, { status: 'error', reason: 'La corrida perdió su workflow durable. Se conservó su memoria; puedes reintentar.' });
   } else {
    if (l) l.ending = false;
    throw err;
   }
  }
 }
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

function persistBrowser(l: Live) {
	if (!l.browserSnapshot) return;
	try { saveSnapshot(DATA_DIR, l.ref.id, l.browserSnapshot); }
	catch (err) { console.error(`Could not save browser snapshot for run ${l.ref.id}:`, (err as Error).message); }
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
	if (l) { clearTimeout(l.timer); if (!l.snapshotFinal) persistBrowser(l); }
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
	// What was still queued for this run waits for the next one, in the same conversation.
	await exec("update messages set run_id = null, routed_as = null, routed_at = null where run_id = $1 and routed_as = 'queued'", [runId]);
	// Messages that waited for this run to end (a new conversation, a lost follow-up) go now.
	requestRoute(t.agent_id);
	return status;
}

// ---------- the sandbox's side ----------

/** If the supervisor is not (back) on its socket within `ms`, the run ends in error. */
function waitForSupervisor(l: Live, ms: number, reason: string) {
	clearTimeout(l.timer);
	l.timer = setTimeout(() => {
		if (!l.sup) void signalEnd(l.ref.id, { status: 'error', reason }).catch(err => {
   // An unhandled rejection freezes timers under bun --watch while HTTP survives.
   // Never let an orphan/transient failure stop every queue's dispatcher.
   console.error(`Could not end disconnected run ${l.ref.id}:`, (err as Error).message);
  });
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
		const run = (await getTask(t.id))!;
		const agent = run.definition ?? (await row<{ name: string; role: string }>('select name, role from agents where id = $1', [t.agent_id]))!;
		const harness = run.definition?.harness ?? defaultHarness();
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
			kind: run.kind,
			harness,
			harnessDigest: run.definition?.harnessDigest,
			prompt,
			files,
			system: withHarnessPrompt(systemPrompt(agent, await grantedNames(t.agent_id)), harness),
			blockedWaitMs: s.blockedWaitMinutes * 60_000,
			piSession: conv.pi_session_id,
			// The agent's credentials go only to its own work; a browser session may sign an MCP server in.
			secrets: run.kind === 'browser' ? {} : await secrets.forRun(t.agent_id),
			mcpLogin: run.kind === 'browser' ? (await row<{ server: string | null }>("select context->>'mcpLogin' as server from messages where run_id = $1 and routed_as = 'new_run' order by id limit 1", [t.id]))?.server ?? undefined : undefined,
			purges: await pendingPurges(t.agent_id)
		}));
		await publishTask(t.id);
		await event(t, 'status', { status: 'running' });
	} else {
		sup.send(JSON.stringify({ t: 'resumed' }));
		await event(t, 'system', { message: 'La computadora se volvió a conectar.' });
		requestRoute(t.agent_id); // follow-ups that waited for it
	}
	// This process is the truth about control: a browser session is always driven by its owner,
	// and a takeover this backend forgot (it restarted) ends, so pi does not stay stopped.
	l.kind = (await row<{ kind: Kind }>('select kind from runs where id = $1', [t.id]))!.kind;
	if (l.kind === 'browser' && !l.control) {
		l.control = true;
		l.controller = t.person_id; // a browser session is its owner's
		await setState(t.id, 'browsing');
		await event(t, 'control', { on: true, browser: true });
	}
	sup.send(JSON.stringify({ t: 'control', on: !!l.control }));
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
		// While the owner drives, the screen can show what they type (a card number): it goes to the
		// owner only and is never kept as the run's snapshot.
		const onlyPerson = l.control ? l.controller ?? ref.person_id : undefined;
		if (onlyPerson === undefined && !l.snapshotFinal && typeof msg.jpeg === 'string') {
			// Keep only the newest frame; disk is written once at collection/end, not at stream FPS.
			const shot = browserSnapshot(msg.jpeg, msg.meta);
			if (shot) l.browserSnapshot = shot;
		}
		if (typeof msg.jpeg === 'string') (msg.t === 'frame' ? hub.frame : hub.thumb)(ref.person_id, ref.id, ref.agent_id, msg.jpeg, msg.meta ?? null, onlyPerson);
		return;
	}
	if (msg.t === 'caps') {
		l.takeover = !!msg.takeover;
		return;
	}
	if (msg.t === 'collected') {
		// After the files queued before it, so they are saved by then.
		serial(l, async () => l.collected?.());
		return;
	}
	serial(l, async () => {
		switch (msg.t) {
			case 'snapshot': {
				// Taken while the owner drove: keep the last image from before the takeover instead.
				const shot = l.control ? null : browserSnapshot(msg.jpeg, msg.meta, msg.at);
				if (shot) l.browserSnapshot = shot;
				l.snapshotFinal = true; persistBrowser(l);
				break;
			}
			case 'harness': {
				const run = await getTask(ref.id), d = run?.definition;
				if (d && (msg.digest !== d.harnessDigest || JSON.stringify(msg.tools) !== JSON.stringify(runtimeToolNames(d.harness)))) {
					await signalEnd(ref.id, { status: 'error', reason: 'El runtime no coincide con el harness fijado a esta corrida.' });
					break;
				}
				await event(ref, 'harness', { digest: msg.digest, tools: msg.tools, skills: msg.skills, plugins: msg.plugins });
				break;
			}
			case 'initialization': {
				const t = await getTask(ref.id);
				if (t?.kind === 'initialize' && ['workspace', 'tools', 'browser'].includes(msg.step)) await event(ref, 'initialization', { step: msg.step });
				break;
			}
			case 'initialized': {
				const t = await getTask(ref.id);
				if (t?.kind !== 'initialize') break;
				const done = new Set((await events(ref.id)).filter(e => e.kind === 'initialization').map(e => (e.data as { step: string }).step));
				if (!['workspace', 'tools', 'browser'].every(s => done.has(s)) || !(await events(ref.id)).some(e => e.kind === 'harness')) {
					await signalEnd(ref.id, { status: 'error', reason: 'La computadora no confirmó todos los pasos de inicialización.' });
					break;
				}
				await exec('update runs set answer=$2 where id=$1', [ref.id, 'Entorno inicializado: contrato guardado, memoria preparada, herramientas disponibles y Chrome comprobado. Listo para recibir tareas.']);
				await signalEnd(ref.id, { status: 'done', reason: null });
				break;
			}
			case 'startup_error':
				await signalEnd(ref.id, { status: 'error', reason: `No se pudo preparar el entorno: ${String(msg.message ?? '').slice(0, 500)}` });
				break;
			case 'pi':
				await onPi(l, msg.ev);
				break;
			case 'blocked':
				await event(ref, 'blocked', decodeHelp(msg.reason));
				await setStatus(ref.id, 'blocked', 'blocked', ['running']);
				// The bridge hears it: its next message is the answer (Q23).
				await notify(ref.id, 'blocked', decodeHelp(msg.reason).reason);
				void whatsapp.onRun(ref.id, 'blocked', msg.reason);
				break;
			case 'unblocked':
				await event(ref, 'unblocked', { message: msg.steered ? 'Recibió instrucciones y sigue.' : 'Nadie respondió: salta el sitio.', steered: !!msg.steered });
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
			case 'note':
				// What the computer is doing before the agent starts (installing tools, signing in).
				await event(ref, 'system', { message: String(msg.message ?? '').slice(0, 500) });
				break;
			case 'mcp_login':
				await event(ref, 'system', { message: msg.ok ? `Sesión iniciada en el servidor MCP «${msg.server}». Queda guardada para las siguientes tareas.` : `No se completó el inicio de sesión en «${msg.server}»: ${String(msg.detail ?? '').slice(0, 300)}` });
				if (msg.ok) await signalEnd(ref.id, { status: 'done', reason: null });
				break;
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
	if (name === 'browser' || name === 'login') return 'browsing';
	if (name === 'request_help') return 'blocked';
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
			// A message queued while it worked starts the next turn of the same run.
			if (!l.lastError && !ev.aborted && await deliverQueued(l, 'prompt')) break;
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

// Answer rounds are persisted with a run-bound inbox message. Reconnect/crash can deliver
// that message, but it must NEVER become a new task or answer a subsequent help request.
export async function answerHelp(taskId: number, value: unknown) {
 let broadcast = () => {};
 const result = await tx(async c => {
  const t = await row<Task>('select * from runs where id=$1 for update', [taskId], c);
  if (!t) throw new Error('No existe.');
  const round = (value as { round?: unknown })?.round;
  if (!Number.isSafeInteger(round)) throw new Error('La solicitud de ayuda cambió. Recarga antes de responder.');
  const blocked = await row<{ seq: number; data: any }>("select seq,data from run_events where run_id=$1 and seq=$2 and kind='blocked'", [taskId, round], c);
  const latest = await row<{ seq: number }>("select seq from run_events where run_id=$1 and kind in ('blocked','steer','unblocked') order by seq desc limit 1", [taskId], c);
  const previous = await row<{ data: any }>("select data from run_events where run_id=$1 and kind='help_answer' and data->>'round'=$2", [taskId, String(round)], c);
  if (!previous&&(t.status!=='blocked'||latest?.seq!==round||await row("select 1 from run_events where run_id=$1 and kind='help_reply' and data->>'round'=$2",[taskId,String(round)],c)))throw new Error('La solicitud de ayuda cambió o terminó. No se envió la respuesta.');
  const help=blocked?helpData(blocked.data,!!previous,previous?.data.questions):null;
  if (!help?.questions.length) throw new Error('Responde esta solicitud escribiendo en el chat.');
  const validated = validateAnswers(value, { round: blocked!.seq, questions: help.questions });
  if (previous) {
   if (!isDeepStrictEqual(previous.data.answers, validated.answers)) throw new Error('Esta solicitud ya tiene una respuesta distinta.');
   return { agentId: t.agent_id, duplicate: true };
  }
  await exec(`insert into messages (agent_id,person_id,source,text,context,dedupe_key,run_id,routed_as,conversation_id)
   values ($1,$2,'web',$3,$4,$5,$6,'unblock',$7)`, [t.agent_id,t.person_id,validated.content,JSON.stringify({ helpRound: round }),`help:${taskId}:${round}`,taskId,t.conversation_id], c);
  const data = { round, answers: validated.answers, text: validated.content, questions:help.questions };
  const e = await storeEvent(taskId, 'help_answer', data, c);
  if (e) broadcast = () => hub.toWatchers(t.agent_id, t.person_id, { t: 'event', taskId, agentId: t.agent_id, event: { id: e.seq, at: e.at, kind: 'help_answer', data } });
  return { agentId: t.agent_id, duplicate: false };
 });
 broadcast();
 requestRoute(result.agentId);
 return result;
}

/** A normal chat reply to a help request still binds to its exact run/round. */
export async function answerHelpText(taskId:number,round:number,text:string,key:unknown){
 const requestId=requestKey(key), message=text.trim();
 if(!message || message.length>4000)throw new Error('Escribe un mensaje de hasta 4000 caracteres.');
 let broadcast=()=>{};
 const result=await tx(async c=>{
  const t=await row<Task>('select * from runs where id=$1 for update',[taskId],c);if(!t)throw new Error('No existe.');
  const duplicate=await row<{id:number;run_id:number;text:string;context:any}>('select id,run_id,text,context from messages where agent_id=$1 and dedupe_key=$2',[t.agent_id,`reply:${requestId}`],c);
  if(duplicate){if(duplicate.run_id!==taskId || duplicate.text!==message || duplicate.context?.helpRound!==round)throw new Error('Esta petición ya contiene otra respuesta.');return {agentId:t.agent_id,message_id:duplicate.id,duplicate:true};}
  const latest=await row<{seq:number;kind:string;data:any}>("select seq,kind,data from run_events where run_id=$1 and kind in ('blocked','steer','unblocked') order by seq desc limit 1",[taskId],c);
  const answered=await row("select 1 from run_events where run_id=$1 and kind in ('help_answer','help_reply') and data->>'round'=$2",[taskId,String(round)],c);
  if(t.status!=='blocked'||latest?.kind!=='blocked'||latest.seq!==round||answered)throw new Error('La solicitud de ayuda cambió o terminó. No se envió la respuesta.');
  const m=(await row<{id:number}>(`insert into messages(agent_id,person_id,conversation_id,source,text,context,dedupe_key,run_id,routed_as) values($1,$2,$3,'web',$4,$5,$6,$7,'unblock') returning id`,[t.agent_id,t.person_id,t.conversation_id,message,JSON.stringify({helpRound:round}),`reply:${requestId}`,taskId],c))!;
  const data={round,text:message,message_id:m.id,questions:helpData(latest.data).questions},e=await storeEvent(taskId,'help_reply',data,c);
  if(e)broadcast=()=>hub.toWatchers(t.agent_id,t.person_id,{t:'event',taskId,agentId:t.agent_id,event:{id:e.seq,at:e.at,kind:'help_reply',data}});
  return {agentId:t.agent_id,message_id:m.id,duplicate:false};
 });
 broadcast();requestRoute(result.agentId);return result;
}

/** Run-bound help outbox. Returns false only while its supervisor is reconnecting. */
export async function deliverHelp(messageId: number) {
 let broadcast = () => {};
 const result = await tx(async c => {
  const m = await row<{ run_id: number; text: string; context: { helpRound: number } }>("select run_id,text,context from messages where id=$1 and routed_as='unblock' and routed_at is null for update", [messageId], c);
  if (!m) return true;
  const t = await row<Task>('select * from runs where id=$1 for update', [m.run_id], c);
  const latest = await row<{ seq: number }>("select seq from run_events where run_id=$1 and kind in ('blocked','steer','unblocked') order by seq desc limit 1", [m.run_id], c);
  const round = m.context?.helpRound;
  if (!t || t.status !== 'blocked' || latest?.seq !== round) {
   await exec('update messages set routed_at=now() where id=$1', [messageId], c);
   if (t) {
    const data = { round, message: 'La ayuda terminó antes de entregar esta respuesta; no se envió a otro bloqueo ni se creó una tarea.' };
    const e = await storeEvent(t.id, 'help_expired', data, c);
    if (e) broadcast = () => hub.toWatchers(t.agent_id,t.person_id,{ t:'event', taskId:t.id, agentId:t.agent_id, event:{ id:e.seq,at:e.at,kind:'help_expired',data } });
   }
   return true;
  }
  const l = live.get(t.id);
  if (!l?.sup) return false;
  l.sup.send(JSON.stringify({ t: 'pi_cmd', cmd: { type: 'steer', message: m.text } }));
  l.sup.send(JSON.stringify({ t: 'unblock' }));
  await exec('update messages set routed_at=now() where id=$1', [messageId], c);
  const data = { text: m.text, helpRound: round, message_id: messageId };
  const e = await storeEvent(t.id, 'steer', data, c);
  if (e) broadcast = () => hub.toWatchers(t.agent_id,t.person_id,{ t:'event', taskId:t.id, agentId:t.agent_id, event:{ id:e.seq,at:e.at,kind:'steer',data } });
  return true;
 });
 broadcast();
 return result;
}

export async function steer(taskId: number, text: string, kind: 'steer' | 'follow_up') {
	const t = await getTask(taskId);
	const l = live.get(taskId);
	if (!t || !l?.sup || (t.status !== 'running' && t.status !== 'blocked')) throw new Error('La tarea no está corriendo.');
	if (t.kind === 'browser') throw new Error('El navegador está abierto para ti: ciérralo y luego dale la tarea al agente.');
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

// ---------- the queue of messages sent while the agent works ----------

type Queued = { id: number; source: 'web' | 'hook' | 'cron' | 'whatsapp'; sender: string | null; schedule_name: string | null; text: string };

/**
 * Hands one queued message to pi: as the next prompt when its turn ended, or as a steer now.
 * The oldest, unless one is named. False when there is none or the computer is reconnecting.
 */
async function deliverQueued(l: Live, as: 'prompt' | 'steer', messageId?: number) {
	if (!l.sup) return false;
	const m = await row<Queued>(
		`select id, source, sender, schedule_name, text from messages where run_id = $1 and routed_as = 'queued' ${messageId ? 'and id = $2' : ''} order by id limit 1`,
		messageId ? [l.ref.id, messageId] : [l.ref.id]
	);
	if (!m) return false;
	const files = await filesFor([m.id]);
	const text = render(m, files.map((f) => f.name));
	const taken = await exec("update messages set routed_as = $2 where id = $1 and routed_as = 'queued'", [m.id, as === 'prompt' ? 'follow_up' : 'steer']);
	if (!taken) return false; // removed or sent a moment ago
	l.sup.send(JSON.stringify({ t: 'files', files }));
	l.sup.send(JSON.stringify({ t: 'pi_cmd', cmd: { type: as, message: text } }));
	await event(l.ref, as === 'prompt' ? 'follow_up' : 'steer', { text, source: m.source, message_id: m.id });
	if (as === 'prompt') await setState(l.ref.id, 'thinking');
	return true;
}

/** «Enviar ahora»: the owner's queued message goes in mid-turn, as a steer. */
export async function sendQueuedNow(runId: number, messageId: number) {
	const l = live.get(runId);
	const t = await getTask(runId);
	if (!t || !l?.sup || t.status !== 'running') throw new Error('El agente ya no está trabajando: tu mensaje se entregará al empezar su siguiente turno.');
	if (!(await deliverQueued(l, 'steer', messageId))) throw new Error('Ese mensaje ya no está en la cola.');
}

/** «Quitar»: a queued message never reaches the agent. */
export async function removeQueued(runId: number, messageId: number) {
	const n = await exec("delete from messages where id = $1 and run_id = $2 and routed_as = 'queued'", [messageId, runId]);
	if (!n) throw new Error('Ese mensaje ya se entregó o ya no está en la cola.');
	await recordEvent(runId, 'system', { message: 'Se quitó un mensaje de la cola.' });
}

// ---------- takeover: the owner drives the agent's browser ----------

const BACK_FROM_CONTROL = 'Tomé el control del navegador y ya terminé (por ejemplo, inicié sesión o pagué). Revisa la página actual antes de seguir.';

/**
 * Ends a takeover so pi continues; a browser session has no agent to give it back to. Only the
 * owner's explicit «Devolver control» calls it: an answer or a message sent while driving waits
 * in pi's input until then, so it never pulls the browser out from under the owner.
 */
function release(l: Live) {
	if (!l.control || l.kind === 'browser') return false;
	l.control = false;
	l.controller = undefined;
	l.sup?.send(JSON.stringify({ t: 'control', on: false }));
	void event(l.ref, 'control', { on: false }).then(() => publishTask(l.ref.id));
	return true;
}

/** The owner takes the browser (the agent freezes) or gives it back (the agent hears so). */
export async function setControl(taskId: number, on: boolean, personId: number) {
	const t = await getTask(taskId);
	const l = live.get(taskId);
	if (!t || !l?.sup || (t.status !== 'running' && t.status !== 'blocked')) throw new Error('La computadora no está prendida.');
	if (t.kind === 'browser') throw new Error('En una sesión de navegador el control ya es tuyo: ciérrala al terminar.');
	if (t.kind !== 'task') throw new Error('Este trabajo no admite tomar el control.');
	if (on) {
		if (l.control) return;
		if (!l.takeover) throw new Error('La computadora de este agente usa una imagen anterior que no permite tomar el control. Vuelve a validar y aprobar su configuración en Automejora para actualizarla.');
		l.control = true;
		l.controller = personId;
		l.sup.send(JSON.stringify({ t: 'control', on: true }));
		await event(t, 'control', { on: true });
		await setState(taskId, 'browsing');
		await publishTask(taskId);
		return;
	}
	if (!release(l)) return;
	if (t.status === 'blocked') {
		// The pending help request gets the answer, bound to its round like a chat reply.
		const round = (await row<{ seq: number; kind: string }>("select seq, kind from run_events where run_id = $1 and kind in ('blocked','steer','unblocked') order by seq desc limit 1", [taskId]));
		if (round?.kind === 'blocked') await answerHelpText(taskId, round.seq, BACK_FROM_CONTROL, randomUUID()).catch(() => {});
	} else {
		await steer(taskId, BACK_FROM_CONTROL, 'steer');
	}
}

const MOUSE = ['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'];
const KEYS = ['keyDown', 'keyUp', 'char'];
const BUTTONS = ['left', 'middle', 'right'];

/**
 * One event from the owner's view to Chrome, in agent-browser's stream format, only while that
 * owner has control. No database round trip: this runs at mouse-move rate.
 */
export function input(personId: number, agentId: number, e: any) {
	const l = [...live.values()].find((x) => x.ref.agent_id === agentId && x.control);
	if (!l?.sup || (l.controller ?? l.ref.person_id) !== personId || !e || typeof e !== 'object') return;
	const n = (v: unknown, max: number) => Math.max(-max, Math.min(max, Math.round(Number(v) || 0)));
	const s = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 32) : undefined);
	let out: object | null = null;
	if (e.type === 'input_mouse' && MOUSE.includes(e.eventType)) {
		out = {
			type: e.type, eventType: e.eventType, x: n(e.x, 10000), y: n(e.y, 10000),
			...(BUTTONS.includes(e.button) ? { button: e.button, clickCount: n(e.clickCount, 3) } : {}),
			...(e.eventType === 'mouseWheel' ? { deltaX: n(e.deltaX, 5000), deltaY: n(e.deltaY, 5000) } : {})
		};
	} else if (e.type === 'input_keyboard' && KEYS.includes(e.eventType)) {
		// windowsVirtualKeyCode is what makes Backspace, arrows and Ctrl+A act (agent-browser passes it to CDP).
		out = { type: e.type, eventType: e.eventType, key: s(e.key), code: s(e.code), text: s(e.text), modifiers: n(e.modifiers, 15), windowsVirtualKeyCode: n(e.windowsVirtualKeyCode, 255) || undefined };
	}
	if (out) l.sup.send(JSON.stringify({ t: 'input', e: out }));
}

// Chrome's own pages where the owner saves passwords, cards and addresses into the profile.
const CHROME_PAGES = ['chrome://settings/payments', 'chrome://settings/addresses', 'chrome://password-manager/passwords'];

export async function navigate(taskId: number, action: string, url: string | undefined, personId: number) {
	const l = live.get(taskId);
	if (!l?.sup || !l.control || (l.controller ?? l.ref.person_id) !== personId) throw new Error('Toma el control del navegador primero.');
	if (action === 'open') {
		const target = String(url ?? '').trim();
		const page = CHROME_PAGES.find((p) => target === p);
		let ok = !!page;
		if (!page) {
			try { ok = ['http:', 'https:'].includes(new URL(target).protocol); } catch {}
		}
		if (!ok) throw new Error('Escribe una dirección http(s) completa.');
		l.sup.send(JSON.stringify({ t: 'nav', action, url: target }));
	} else if (['back', 'forward', 'reload'].includes(action)) {
		l.sup.send(JSON.stringify({ t: 'nav', action }));
	} else throw new Error('Acción desconocida.');
}

/** Ends a browser session cleanly: Chrome closes and writes cookies and saved data to the profile. */
export async function closeBrowser(taskId: number) {
	const t = await getTask(taskId);
	if (!t || t.kind !== 'browser') throw new Error('No es una sesión de navegador.');
	if (!LIVE.includes(t.status)) return;
	if (t.status === 'queued') return cancel(taskId);
	await signalEnd(taskId, { status: 'done', reason: null });
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
			for (const wf of [admissionWorkflowId(t.workflow_id), t.workflow_id]) await DBOS.cancelWorkflow(wf, { cancelChildren: true }).catch(() => {});
			await publishTask(taskId);
			await event(t, 'status', { status: 'cancelled', reason: 'Cancelada antes de empezar.' });
			await notify(taskId, 'cancelled');
			await whatsapp.onRun(taskId, 'cancelled');
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
	// Reconcile only UUID identities. This closes insert/enqueue crash gaps and permits
 // explicit guarded repair without replaying legacy queued business fixtures.
 const queued = await rows<Task>(`select ${RUN_SELECT} where r.status='queued'`);
 const running = await rows<RunRef & { status: Status }>(
		"select id, person_id, agent_id, status from runs where status in ('starting', 'running', 'blocked')"
	);
	for (const r of running) {
		const l = liveOf(r);
		if (!l.sup) waitForSupervisor(l, r.status === 'starting' ? ATTACH_MS : GRACE_MS + 30_000, 'La computadora se desconectó.');
	}
	const owned = new Set([...queued, ...running].map((r) => String(r.id)));
	try {
		for (const c of await provider.list(LABEL)) if (!owned.has(c.labels['agents.run'] ?? '')) await provider.destroy(c.id);
	} catch (err) {
		console.error('could not clean old sandboxes:', (err as Error).message);
	}
 for (const t of queued) {
  if (!isNewRunWorkflowId(t.workflow_id)) continue;
  if (!(await DBOS.getWorkflowStatus(admissionWorkflowId(t.workflow_id)))) await enqueueAdmission(t);
 }
}
