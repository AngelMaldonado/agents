// Trabajos (Angel 5-nov-2026): agents people hire, and the trabajos they give them. A trabajo is one
// objective in one conversation (conversations.status and friends): it ends when the agent meets its
// objective (job_done), when its owner (or whoever it is for) ends it, or after the agent's hours without
// activity; what comes next opens a new one. Every work starts knowing its trabajo and the summaries of
// the recent ones (jobBlock). Each one that ends is evaluated by another agent (evaluations.ts).
//
// The conversation Principal is not a trabajo: its initialization and the owner's computer sessions live
// there, and it never closes.
import { row, rows, exec } from './db';

export type Job = {
	id: number;
	agent_id: number;
	title: string | null;
	goal: string | null;
	status: 'open' | 'done' | 'closed';
	end_reason: string | null;
	summary: string | null;
	result: unknown;
	closed_at: number | null;
	origin: string | null;
	person_id: number | null;
	rating: -1 | 1 | null;
	rating_note: string | null;
	is_default: boolean;
	started_at: number;
	/** Modo objetivo: its budget, and what it spent (all its turns) and how many turns it took without anyone. */
	budget_usd: number;
	budget_turns: number;
	spent_usd: number;
	auto_turns: number;
};
type Reply = { ok: boolean; error?: string; [k: string]: unknown };

/** The time, for the inactivity sweep; tests set it. */
export const clock = { now: () => new Date() };
const COLUMNS =
	'c.id, c.agent_id, c.title, c.goal, c.status, c.end_reason, c.summary, c.result, c.closed_at, c.origin, c.person_id, c.rating, c.rating_note, c.is_default, c.started_at, c.budget_usd::float as budget_usd, c.budget_turns, ' +
	'(select coalesce(sum(r.cost), 0)::float from runs r where r.conversation_id = c.id) as spent_usd, ' +
	"(select count(*)::int from runs r where r.conversation_id = c.id and exists (select 1 from messages m where m.run_id = r.id and m.source = 'flow')) as auto_turns";
export const get = (conversationId: number) =>
	row<Job>(`select ${COLUMNS} from conversations c where c.id = $1 and c.deleted_at is null`, [conversationId]);

/** A run's trabajo. */
async function ofRun(runId: number) {
	const r = await row<{ conversation_id: number }>('select conversation_id from runs where id = $1', [runId]);
	return r ? get(r.conversation_id) : null;
}

/**
 * Ends a trabajo: done (its objective met) or closed (its owner, inactivity). Its flows and encargos
 * stop with it, and another agent evaluates it.
 */
export async function close(
	conversationId: number,
	how: 'done' | 'closed',
	reason: string,
	extra: { summary?: string | null; result?: unknown } = {},
) {
	const ended = await row<{ id: number; agent_id: number }>(
		`update conversations set status = $2, end_reason = $3, closed_at = now(),
		   summary = coalesce($4, summary), result = coalesce($5, result)
		 where id = $1 and status = 'open' and not is_default returning id, agent_id`,
		[
			conversationId,
			how,
			reason,
			extra.summary ?? null,
			extra.result === undefined ? null : JSON.stringify(extra.result),
		],
	);
	if (!ended) return false;
	// Its list of tasks ends with it (done when nothing was left open).
	await (await import('./flows')).endWithJob(conversationId).catch(() => {});
	for (const d of await rows<{ id: number }>(
		"select id from delegations where conversation_id = $1 and status = 'active'",
		[conversationId],
	))
		await (await import('./delegations')).end(d.id, 'cancelled', 'terminó su trabajo');
	await (await import('./evaluations')).queue(conversationId);
	return true;
}

/** Its owner (or whoever it is for) ends it from the web or WhatsApp; a work on it stops too. */
export async function closeByPerson(conversationId: number, personName: string) {
	const live = await row<{ id: number; kind: string }>(
		"select id, kind from runs where conversation_id = $1 and status in ('queued','starting','running','blocked')",
		[conversationId],
	);
	if (live) {
		const tasks = await import('./tasks');
		await (live.kind === 'browser'
			? tasks.closeBrowser(live.id)
			: tasks.cancel(live.id, `${personName} dio por terminado el trabajo.`));
	}
	return close(conversationId, 'closed', `lo dio por terminado ${personName}`);
}

/** It opens again: its evaluation goes (it will have another when it ends again). */
export async function reopen(conversationId: number) {
	const n = await exec(
		"update conversations set status = 'open', closed_at = null, end_reason = null, archived_at = null, idle_turns = 0, audit_rejections = 0, budget_noticed_at = null where id = $1 and status <> 'open' and not is_default",
		[conversationId],
	);
	if (n) await exec('delete from job_evaluations where conversation_id = $1', [conversationId]);
	return n > 0;
}

/** Its owner sets its budget (cost and turns without anyone): raised, it may go on by itself again. */
export async function setBudget(conversationId: number, input: { usd?: unknown; turns?: unknown }) {
	const usd = input.usd === undefined ? null : Number(input.usd);
	const turns = input.turns === undefined ? null : Number(input.turns);
	if (usd !== null && !(usd > 0 && usd <= 1000)) throw new Error('El presupuesto va de $0.01 a $1,000.');
	if (turns !== null && !(Number.isInteger(turns) && turns >= 1 && turns <= 500))
		throw new Error('Los turnos van de 1 a 500.');
	const n = await exec(
		`update conversations set budget_usd = coalesce($2, budget_usd), budget_turns = coalesce($3, budget_turns),
		   budget_noticed_at = null where id = $1 and not is_default`,
		[conversationId, usd, turns],
	);
	if (!n) throw new Error('Este trabajo no existe.');
}

/** Its objective: from /goal (its owner) or job_goal (the agent). */
export async function setGoal(conversationId: number, goal: string) {
	const text = goal.trim().slice(0, 1000);
	if (!text) throw new Error('Escribe el objetivo.');
	const n = await exec("update conversations set goal = $2 where id = $1 and status = 'open' and not is_default", [
		conversationId,
		text,
	]);
	if (!n) throw new Error('Esta conversación no es un trabajo abierto.');
}

export async function rate(conversationId: number, rating: unknown, note: unknown) {
	const r = rating === 1 || rating === -1 ? rating : null;
	await exec('update conversations set rating = $2, rating_note = $3 where id = $1', [
		conversationId,
		r,
		r === null
			? null
			: String(note ?? '')
					.trim()
					.slice(0, 500) || null,
	]);
}

// ---------- the agent's tools ----------

/** job_done: it met the objective; its summary is what the next trabajos will know of this one. */
export async function done(runId: number, input: { resumen?: unknown; resultado?: unknown }): Promise<Reply> {
	const j = await ofRun(runId);
	if (!j) return { ok: false, error: 'El trabajo ya no existe.' };
	if (j.is_default) return { ok: false, error: 'Esta conversación (Principal) no es un trabajo: no se cierra.' };
	if (j.status !== 'open') return { ok: false, error: `El trabajo #${j.id} ya terminó.` };
	const summary = String(input.resumen ?? '')
		.trim()
		.slice(0, 2000);
	if (!summary) return { ok: false, error: 'Escribe el resumen: qué se hizo, qué resultó y qué quedó pendiente.' };
	// Not while its tasks are open: they are what the objective is made of.
	const tasks = await (await import('./flows')).openTasks(j.id);
	if (tasks.open.length)
		return {
			ok: false,
			error: `Faltan tareas: ${tasks.open.map((s) => `${s.key} (${s.status}${s.note ? `: ${s.note}` : ''})`).join(', ')}. Termínalas, márcalas skipped o failed con task_update, o quítalas con task_plan, antes de terminar el trabajo.`,
		};
	if (tasks.result)
		return {
			ok: false,
			error: 'Entrega el resultado de la receta con task_update sin tarea antes de terminar el trabajo.',
		};
	// Modo objetivo: an independent auditor checks the claim against its objective. «Not yet» is its next step
	// (twice; the third time it closes, saying the auditor did not confirm it). If the auditor fails, it closes.
	const goalMode = !!(await row('select 1 from agents where id = $1 and goal_mode', [j.agent_id]));
	const verdict = !goalMode
		? null
		: await (await import('./audit')).audit(j.id, { summary, result: input.resultado }).catch((err) => {
				console.error(`auditor del trabajo #${j.id}:`, (err as Error).message);
				return null;
			});
	const rejections =
		(await row<{ n: number }>('select audit_rejections as n from conversations where id = $1', [j.id]))?.n ?? 0;
	if (verdict?.verdict === 'not_yet' && rejections < 2) {
		await exec('update conversations set audit_rejections = audit_rejections + 1 where id = $1', [j.id]);
		return {
			ok: false,
			error: `Un auditor revisó el trabajo contra su objetivo y todavía no lo da por cumplido: ${verdict.reason} Sigue con eso; si de verdad no se puede, dilo en el resumen al terminar.`,
		};
	}
	const why =
		verdict?.verdict === 'impossible'
			? `no se pudo: ${verdict.reason}`
			: verdict?.verdict === 'not_yet'
				? `terminó sin que el auditor lo confirmara: ${verdict.reason}`
				: 'cumplió su objetivo';
	await close(j.id, 'done', why, { summary, result: input.resultado });
	return {
		ok: true,
		trabajo: j.id,
		...(verdict ? { auditor: verdict.reason } : {}),
		siguiente: 'El trabajo quedó terminado. Dile a tu dueño el resultado en tu respuesta; puede reabrirlo si no quedó.',
	};
}

/** job_goal: the objective, stated (or restated) by the agent. */
export async function goal(runId: number, input: { objetivo?: unknown }): Promise<Reply> {
	const j = await ofRun(runId);
	if (!j) return { ok: false, error: 'El trabajo ya no existe.' };
	try {
		await setGoal(j.id, String(input.objetivo ?? ''));
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
	return { ok: true, trabajo: j.id };
}

export async function handle(runId: number, op: string, args: Record<string, unknown>): Promise<Reply> {
	try {
		if (op === 'done') return await done(runId, args);
		if (op === 'goal') return await goal(runId, args);
		return { ok: false, error: 'Operación de trabajo desconocida.' };
	} catch (err) {
		console.error(`trabajo (${op}) del turno ${runId}:`, (err as Error).message);
		return { ok: false, error: 'No se pudo completar.' };
	}
}

// ---------- what the agent knows ----------

const day = (ms: number) =>
	new Date(ms).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short' });

/** Every work starts with its trabajo and the recent ones of whoever it is for (not someone else's). */
export async function jobBlock(conversationId: number) {
	const j = await get(conversationId);
	if (!j) return '';
	if (j.is_default)
		return '## Tu trabajo\nEstás en la conversación Principal: no es un trabajo (no tiene objetivo ni se cierra).';
	const recent = await rows<Job & { overall: number | null }>(
		`select ${COLUMNS}, e.overall from conversations c left join job_evaluations e on e.conversation_id = c.id and e.status = 'done'
		 where c.agent_id = $1 and c.id <> $2 and c.status <> 'open' and not c.is_default and c.deleted_at is null
		   and c.person_id is not distinct from $3
		 order by c.closed_at desc nulls last limit 5`,
		[j.agent_id, j.id, j.person_id],
	);
	return [
		`## Tu trabajo (#${j.id})`,
		j.goal
			? `Objetivo: ${j.goal}`
			: 'Todavía no tiene objetivo declarado: si lo que te piden es claro, decláralo con job_goal; si no, pregúntalo.',
		'Cuando cumplas el objetivo, ciérralo con job_done (resumen: qué hiciste, qué resultó y qué queda pendiente). Si tu dueño te pide algo que no es de este trabajo, díselo: puede empezar uno nuevo.',
		...(recent.length
			? [
					'',
					'## Tus trabajos recientes (lo que sabes de ellos; los detalles ya no están en tu contexto)',
					...recent.map(
						(r) =>
							`- #${r.id} (${r.closed_at ? day(r.closed_at) : ''}) ${r.goal ?? r.title ?? 'sin objetivo'} → ${r.status === 'done' ? 'terminado' : 'cerrado'}${r.end_reason ? ` (${r.end_reason})` : ''}${r.summary ? `: ${r.summary.slice(0, 500)}` : ''}`,
					),
				]
			: []),
	].join('\n');
}

// ---------- inactivity ----------

/** Trabajos with no message nor work for the agent's hours, and nothing waiting for anyone, close. */
export async function sweep(now = clock.now()) {
	const stale = await rows<{ id: number; hours: number }>(
		`select c.id, a.inactivity_hours as hours from conversations c join agents a on a.id = c.agent_id
		 where c.status = 'open' and not c.is_default and c.deleted_at is null and a.deleted_at is null
		   and greatest(c.started_at,
		         coalesce((select max(m.received_at) from messages m where m.conversation_id = c.id), c.started_at),
		         coalesce((select max(coalesce(r.ended_at, now())) from runs r where r.conversation_id = c.id), c.started_at))
		       < $1::timestamptz - make_interval(hours => a.inactivity_hours)
		   and not exists (select 1 from runs r where r.conversation_id = c.id and r.status in ('queued','starting','running','blocked'))
		   and not exists (select 1 from flows f where f.conversation_id = c.id and f.status = 'running')
		   and not exists (select 1 from delegations d where d.conversation_id = c.id and d.status = 'active')`,
		[now],
	);
	for (const s of stale) await close(s.id, 'closed', `sin actividad por ${s.hours} h`);
	return stale.length;
}

let sweeper: ReturnType<typeof setInterval> | null = null;
export function startSweeper() {
	sweeper ??= setInterval(
		() => void sweep().catch((err) => console.error('trabajos:', (err as Error).message)),
		10 * 60_000,
	);
	sweeper.unref?.();
}
