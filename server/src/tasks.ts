// Tasks: the queue, each task's sandbox, the pi event stream, steer/cancel and the limits.
//
// A task's life: queued -> starting (container created) -> running (supervisor connected, pi
// prompted) -> done | incomplete | cancelled | error. Ending always aborts pi, asks the sandbox for
// what it wrote under ~/work/out, destroys the container and kills its tokens.
//
// Two tokens per task. `token` reaches the container in its environment and only opens the
// supervisor's WebSocket, once: it is burnt on connect, so the agent reading /proc/1/environ gets
// nothing. Site logins travel only over that socket. `llm_token` is pi's provider key: it only
// works on the LLM gateway, for this task's model, while the task runs.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { db, now, DATA_DIR } from './db';
import * as hub from './hub';
import { settings } from './settings';
import { systemPrompt } from './prompt';
import { DockerSandbox } from './sandbox/docker';
import type { SandboxProvider } from './sandbox/provider';
import { hasKey, proxyOf, checkProxyModel, type Provider } from './providers';
import { grantedNames, resolveCredential } from './vault';

export type Status = 'queued' | 'starting' | 'running' | 'done' | 'incomplete' | 'cancelled' | 'error';
export type CharState =
	| 'idle' | 'starting' | 'thinking' | 'browsing' | 'running' | 'writing' | 'blocked' | 'steered'
	| 'done' | 'incomplete' | 'cancelled' | 'error';

export type Task = {
	id: number; agent_id: number; person_id: number; prompt: string; model: string; status: Status;
	state: CharState; token: string | null; llm_token: string | null; container_id: string | null; cost: number; tokens: number;
	end_reason: string | null; result: string | null; created_at: number; started_at: number | null; ended_at: number | null;
};

type Supervisor = { send: (data: string) => void; close: () => void };
type Run = {
	taskId: number;
	ownerId: number;
	agentId: number;
	sup?: Supervisor;
	deadline?: Timer;
	ending?: Promise<void>;
	collected?: () => void;
	steeredUntil?: number;
	lastError?: string; // the provider's error on the last assistant turn, if it failed
};

const SERVER_URL = process.env.BUYER_SANDBOX_SERVER_URL ?? 'http://buyer-server:8787';
// dev and prod share reko-3's Docker: names and labels carry the instance.
const INSTANCE = process.env.BUYER_INSTANCE ?? 'dev';
const LABEL = `buyer.instance=${INSTANCE}`;
const provider: SandboxProvider = new DockerSandbox();
const runs = new Map<number, Run>();

// ---------- reads ----------

export const getTask = (id: number) => db.query('SELECT * FROM tasks WHERE id = ?').get(id) as Task | null;
export const byLlmToken = (token: string) =>
	db.query("SELECT * FROM tasks WHERE llm_token = ? AND status IN ('starting','running')").get(token) as Task | null;

export function events(taskId: number, afterId = 0) {
	return (db.query('SELECT id, at, kind, data FROM task_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT 2000').all(taskId, afterId) as {
		id: number; at: number; kind: string; data: string;
	}[]).map((e) => ({ ...e, data: JSON.parse(e.data) }));
}

export function artifacts(taskId: number) {
	return db.query('SELECT id, name, mime, size FROM artifacts WHERE task_id = ? ORDER BY name').all(taskId) as {
		id: number; name: string; mime: string; size: number;
	}[];
}

/** Task id -> owner, for the tasks whose last frame a new viewer may get. */
export function liveOwners() {
	const m = new Map<number, number>();
	for (const r of runs.values()) m.set(r.taskId, r.ownerId);
	return m;
}

// ---------- writes that the UI sees ----------

function event(task: { id: number; person_id: number; agent_id: number }, kind: string, data: unknown) {
	const at = now();
	const { lastInsertRowid } = db.query('INSERT INTO task_events (task_id, at, kind, data) VALUES (?, ?, ?, ?)').run(task.id, at, kind, JSON.stringify(data));
	hub.publish(task.person_id, { t: 'event', taskId: task.id, agentId: task.agent_id, event: { id: Number(lastInsertRowid), at, kind, data } });
}

function update(taskId: number, patch: Partial<Task>) {
	const keys = Object.keys(patch);
	if (!keys.length) return;
	db.query(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(Object.values(patch) as never[]), taskId);
	const t = getTask(taskId)!;
	hub.publish(t.person_id, { t: 'task', task: publicTask(t) });
}

export function publicTask(t: Task) {
	const { token, llm_token, container_id, ...rest } = t;
	return { ...rest, result: t.result ? JSON.parse(t.result) : null };
}

function setState(taskId: number, state: CharState) {
	const t = getTask(taskId);
	if (!t || t.state === state) return;
	update(taskId, { state });
}

// ---------- queue ----------

export async function enqueue(agent: { id: number; person_id: number; model: string }, prompt: string) {
	const providerName = agent.model.split('/')[0] as Provider;
	if (!proxyOf(agent.person_id) && !hasKey(agent.person_id, providerName)) {
		throw new Error(`Falta tu CLIProxyAPI o tu API key de ${providerName === 'anthropic' ? 'Anthropic' : 'OpenAI'} (Ajustes).`);
	}
	await checkProxyModel(agent.person_id, agent.model);
	// After the network check: simultaneous requests must not both enqueue the same agent.
	if (db.query("SELECT 1 FROM tasks WHERE agent_id = ? AND status IN ('queued','starting','running')").get(agent.id)) {
		throw new Error('Este agente ya tiene una tarea en curso.');
	}
	const { lastInsertRowid } = db
		.query("INSERT INTO tasks (agent_id, person_id, prompt, model, status, state, created_at) VALUES (?, ?, ?, ?, 'queued', 'idle', ?)")
		.run(agent.id, agent.person_id, prompt.trim(), agent.model, now());
	const t = getTask(Number(lastInsertRowid))!;
	hub.publish(t.person_id, { t: 'task', task: publicTask(t) });
	void pump();
	return t;
}

let pumping = false;
async function pump() {
	if (pumping) return;
	pumping = true;
	try {
		while (runs.size < settings().maxConcurrent) {
			const next = db.query("SELECT * FROM tasks WHERE status = 'queued' ORDER BY id LIMIT 1").get() as Task | null;
			if (!next) break;
			await launch(next);
		}
	} finally {
		pumping = false;
	}
}

async function launch(task: Task) {
	const s = settings();
	const token = randomBytes(32).toString('base64url');
	const llmToken = randomBytes(32).toString('base64url');
	const run: Run = { taskId: task.id, ownerId: task.person_id, agentId: task.agent_id };
	runs.set(task.id, run);
	update(task.id, { status: 'starting', state: 'starting', token, llm_token: llmToken, started_at: now() });
	event(task, 'status', { status: 'starting' });
	try {
		const id = await provider.start({
			name: `buyer-${INSTANCE}-task-${task.id}`,
			image: s.sandboxImage,
			memoryBytes: 1536 * 1024 * 1024,
			cpus: 1,
			labels: { 'buyer.instance': INSTANCE, 'buyer.task': String(task.id) },
			env: {
				BUYER_TASK_ID: String(task.id),
				BUYER_TASK_TOKEN: token,
				BUYER_LLM_TOKEN: llmToken,
				BUYER_SERVER_URL: SERVER_URL
			}
		});
		update(task.id, { container_id: id });
		run.deadline = setTimeout(() => void end(task.id, 'incomplete', `Se acabó el tiempo (${s.maxMinutes} min).`), s.maxMinutes * 60_000);
	} catch (err) {
		event(task, 'error', { message: `No se pudo crear la computadora: ${(err as Error).message}` });
		await finish(task.id, 'error', 'No se pudo crear la computadora.');
	}
}

// ---------- the sandbox's side ----------

/** The supervisor inside the sandbox connected. Burns its token; returns its handlers. */
export function attach(token: string, sup: Supervisor) {
	const task = db.query("SELECT * FROM tasks WHERE token = ? AND status = 'starting'").get(token) as Task | null;
	const run = task && runs.get(task.id);
	if (!task || !run || run.sup) return null;
	db.query('UPDATE tasks SET token = NULL WHERE id = ?').run(task.id);
	run.sup = sup;
	const agent = db.query('SELECT name, role FROM agents WHERE id = ?').get(task.agent_id) as { name: string; role: string };
	const s = settings();
	sup.send(JSON.stringify({
		t: 'start',
		model: task.model,
		prompt: task.prompt,
		system: systemPrompt(agent, grantedNames(task.agent_id)),
		blockedWaitMs: s.blockedWaitMinutes * 60_000
	}));
	update(task.id, { status: 'running', state: 'thinking' });
	event(task, 'status', { status: 'running' });
	return {
		message: (raw: string) => onSupervisor(task.id, raw),
		close: () => {
			const r = runs.get(task.id);
			if (!r) return;
			r.sup = undefined;
			if (!r.ending) void end(task.id, 'error', 'La computadora se desconectó.');
		}
	};
}

function onSupervisor(taskId: number, raw: string) {
	const task = getTask(taskId);
	const run = runs.get(taskId);
	if (!task || !run) return;
	let msg: any;
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}
	switch (msg.t) {
		case 'frame':
			if (typeof msg.jpeg === 'string') hub.frame(task.person_id, task.id, task.agent_id, msg.jpeg, msg.meta ?? null);
			break;
		case 'pi':
			onPi(task, run, msg.ev);
			break;
		case 'blocked':
			event(task, 'blocked', { reason: String(msg.reason ?? '').slice(0, 2000) });
			setState(task.id, 'blocked');
			break;
		case 'unblocked':
			event(task, 'system', { message: msg.steered ? 'Recibió instrucciones y sigue.' : 'Nadie respondió: salta el sitio.' });
			setState(task.id, 'thinking');
			break;
		case 'file':
			saveFile(task, String(msg.name ?? ''), String(msg.mime ?? 'application/octet-stream'), String(msg.data ?? ''));
			break;
		case 'collected':
			run.collected?.();
			break;
		case 'cred': {
			// agent-browser's credential plugin asked for a login, through the supervisor.
			const reply = resolveCredential(task, String(msg.name ?? ''), String(msg.url ?? ''));
			if (reply.ok) event(task, 'credential', { name: msg.name, ok: true });
			else event(task, 'credential', { name: msg.name, ok: false, error: reply.error });
			run.sup?.send(JSON.stringify({ t: 'cred_res', id: msg.id, ...reply }));
			break;
		}
		case 'stderr':
			// pi's diagnostics; kept for debugging, not shown as the agent's work.
			if (msg.text) event(task, 'system', { message: String(msg.text).slice(0, 1000), stderr: true });
			break;
		case 'exit':
			if (!run.ending) void end(task.id, 'error', `El agente terminó inesperadamente (código ${msg.code}).`);
			break;
	}
}

function toolState(name: string, args: any): CharState {
	const cmd = typeof args?.command === 'string' ? args.command : '';
	const path = typeof args?.path === 'string' ? args.path : '';
	if (name === 'bash' && /\bbuyer-blocked\b/.test(cmd)) return 'blocked';
	if (name === 'bash' && /\bagent-browser\b/.test(cmd)) return 'browsing';
	if ((name === 'write' || name === 'edit') && /out\//.test(path)) return 'writing';
	if (name === 'bash' && /result\.json/.test(cmd)) return 'writing';
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

function onPi(task: Task, run: Run, ev: any) {
	if (!ev || typeof ev.type !== 'string') return;
	const steered = run.steeredUntil && run.steeredUntil > now();
	switch (ev.type) {
		case 'message_update':
			if (!steered && ['thinking_delta', 'text_delta', 'toolcall_delta'].includes(ev.assistantMessageEvent?.type)) setState(task.id, 'thinking');
			break;
		case 'message_end': {
			const m = ev.message;
			if (m?.role !== 'assistant') break;
			const text = (Array.isArray(m.content) ? m.content : []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim();
			if (text) event(task, 'text', { text });
			if (m.stopReason === 'error' && m.errorMessage) {
				run.lastError = String(m.errorMessage).slice(0, 2000);
				event(task, 'error', { message: run.lastError });
			} else {
				run.lastError = undefined;
			}
			const cost = Number(m.usage?.cost?.total ?? 0);
			const tokens = Number(m.usage?.totalTokens ?? 0);
			if (cost || tokens) {
				const t = getTask(task.id)!;
				update(task.id, { cost: t.cost + cost, tokens: t.tokens + tokens });
				const max = settings().maxCostUsd;
				if (t.cost + cost > max && !run.ending) void end(task.id, 'incomplete', `Llegó al tope de costo (US$${max}).`);
			}
			break;
		}
		case 'tool_execution_start':
			event(task, 'tool', { id: ev.toolCallId, name: ev.toolName, summary: summarize(ev.toolName, ev.args) });
			setState(task.id, toolState(ev.toolName, ev.args));
			break;
		case 'tool_execution_end': {
			const out = textOf(ev.result);
			event(task, 'tool_end', { id: ev.toolCallId, name: ev.toolName, isError: Boolean(ev.isError), output: out.length > 4000 ? out.slice(0, 2000) + '\n…\n' + out.slice(-1500) : out });
			if (!steered) setState(task.id, 'thinking');
			break;
		}
		case 'auto_retry_start':
			event(task, 'system', { message: `Reintento ${ev.attempt}/${ev.maxAttempts}: ${ev.errorMessage ?? ''}` });
			break;
		case 'agent_settled':
			if (run.ending) break;
			if (run.lastError && !getTask(task.id)!.result) void end(task.id, 'error', `El proveedor respondió con error: ${providerError(run.lastError)}`);
			else void end(task.id, ev.aborted ? 'incomplete' : 'done', ev.aborted ? 'Se interrumpió.' : null);
			break;
	}
}

/** "401 {..."message":"invalid x-api-key"}}" -> "401 invalid x-api-key" */
function providerError(raw: string) {
	const code = raw.match(/^\d{3}/)?.[0] ?? '';
	const msg = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? raw.slice(0, 200);
	return `${code} ${msg}`.trim();
}

function saveFile(task: Task, rawName: string, mime: string, b64: string) {
	const name = rawName.replace(/[^\w.-]/g, '_').slice(0, 100);
	if (!name || !b64) return;
	const buf = Buffer.from(b64, 'base64');
	if (buf.length > 15 * 1024 * 1024) return;
	const dir = joinPath(DATA_DIR, 'tasks', String(task.id));
	mkdirSync(dir, { recursive: true });
	const path = joinPath(dir, name);
	writeFileSync(path, buf);
	db.query(
		`INSERT INTO artifacts (task_id, name, path, mime, size) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(task_id, name) DO UPDATE SET path = excluded.path, mime = excluded.mime, size = excluded.size`
	).run(task.id, name, path, mime, buf.length);
	if (name === 'result.json') {
		try {
			const parsed = JSON.parse(buf.toString('utf8'));
			update(task.id, { result: JSON.stringify(parsed) });
		} catch {
			event(task, 'error', { message: 'result.json no es JSON válido.' });
		}
	}
}

// ---------- the human's side ----------

export function steer(taskId: number, text: string, kind: 'steer' | 'follow_up') {
	const task = getTask(taskId);
	const run = runs.get(taskId);
	if (!task || !run?.sup || task.status !== 'running') throw new Error('La tarea no está corriendo.');
	const message = text.trim().slice(0, 4000);
	if (!message) throw new Error('Mensaje vacío.');
	run.sup.send(JSON.stringify({ t: 'pi_cmd', cmd: { type: kind, message } }));
	if (kind === 'steer') run.sup.send(JSON.stringify({ t: 'unblock' }));
	event(task, kind, { text: message });
	if (kind === 'steer') {
		run.steeredUntil = now() + 2500;
		setState(taskId, 'steered');
	}
}

export function cancel(taskId: number) {
	const task = getTask(taskId);
	if (!task) throw new Error('No existe.');
	if (task.status === 'queued') {
		update(taskId, { status: 'cancelled', state: 'cancelled', ended_at: now(), end_reason: 'Cancelada antes de empezar.' });
		return;
	}
	if (!runs.has(taskId)) throw new Error('La tarea ya terminó.');
	void end(taskId, 'cancelled', 'Cancelada por un humano.');
}

// ---------- ending ----------

function end(taskId: number, status: Status, reason: string | null) {
	const run = runs.get(taskId);
	if (!run) return Promise.resolve();
	if (run.ending) return run.ending;
	run.ending = (async () => {
		clearTimeout(run.deadline);
		const sup = run.sup;
		if (sup) {
			sup.send(JSON.stringify({ t: 'pi_cmd', cmd: { type: 'abort' } }));
			// Keep whatever the agent already wrote, even when it is cancelled.
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 20_000);
				run.collected = () => {
					clearTimeout(timer);
					resolve();
				};
				sup.send(JSON.stringify({ t: 'collect' }));
			});
		}
		const t = getTask(taskId)!;
		const final: Status = status === 'done' && !t.result ? 'incomplete' : status;
		const why = status === 'done' && !t.result ? 'Terminó sin escribir result.json.' : reason;
		await finish(taskId, final, why);
	})();
	return run.ending;
}

async function finish(taskId: number, status: Status, reason: string | null) {
	const run = runs.get(taskId);
	const t = getTask(taskId)!;
	try {
		run?.sup?.close();
	} catch {}
	if (t.container_id) await provider.destroy(t.container_id).catch(() => {});
	update(taskId, { status, state: status as CharState, token: null, llm_token: null, ended_at: now(), end_reason: reason });
	event(t, 'status', { status, reason });
	hub.forgetFrame(taskId);
	runs.delete(taskId);
	void pump();
}

/** On boot: tasks the previous process left mid-way can't be resumed; their sandboxes go away. */
export async function recover() {
	const stale = db.query("SELECT * FROM tasks WHERE status IN ('starting','running')").all() as Task[];
	for (const t of stale) {
		update(t.id, { status: 'error', state: 'error', token: null, llm_token: null, ended_at: now(), end_reason: 'El servidor se reinició a mitad de la tarea.' });
	}
	try {
		for (const id of await provider.list(LABEL)) await provider.destroy(id);
	} catch (err) {
		console.error('could not clean old sandboxes:', (err as Error).message);
	}
	void pump();
}
