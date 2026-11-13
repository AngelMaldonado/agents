// Evaluaciones (Angel 5-nov-2026): another agent judges each trabajo that ends, with the rubric of the
// contract (sandbox/harness.ts RUBRIC, weighed by the owner). The platform measures what can be measured
// (time, turns, help asked, takeovers, tool errors, tokens, encargos, files) and the evaluator, a model of
// its own with no stake in the work, judges the rest from the evidence: what the agent says of itself is
// not evidence. It reads, never writes; its scores cite what they rest on.
import { row, rows, exec } from './db';
import { RUBRIC, rubricOf, validateHarness, type RubricKey } from '../../sandbox/harness';
import { askJson } from './gpt';
import * as lessons from './lessons';

type Score = { key: RubricKey; score: number | null; justification: string; evidence: string[] };
export type Verdict = {
	scores: Score[];
	comment: string;
	suggestions: string[];
	summary: string;
	/** Its changes to the agent's Aprendizajes (lessons.ts). */
	lessons?: lessons.LessonOp[];
};

/** The model that evaluates; tests replace it. */
export const evaluator = {
	ask: (personId: number, model: string, instructions: string, evidence: string, schema: object) =>
		askJson<Verdict>(personId, model, instructions, evidence, schema, {
			name: 'evaluacion_de_trabajo',
			label: 'evaluación',
			maxTokens: 6000,
		}),
};

const pending = new Map<number, Promise<void>>();
/** Once its evaluation in progress ended; for tests. */
export const idle = (conversationId: number) => pending.get(conversationId) ?? Promise.resolve();

/** A trabajo ended: its evaluation is due (once; reopening it drops it). */
export async function queue(conversationId: number) {
	// Only trabajos that began as trabajos: the conversations from before (closed by the first inactivity
	// sweep) would be a burst of model calls about work nobody framed as one.
	const c = await row<{ agent_id: number }>(
		`select agent_id from conversations where id = $1
		   and started_at >= coalesce((select applied_at from schema_migrations where version = '042_jobs.sql'), '-infinity')`,
		[conversationId],
	);
	if (!c) return;
	await exec(
		'insert into job_evaluations (conversation_id, agent_id) values ($1, $2) on conflict (conversation_id) do nothing',
		[conversationId, c.agent_id],
	);
	run(conversationId);
}

function run(conversationId: number) {
	if (pending.has(conversationId)) return pending.get(conversationId)!;
	const p = evaluate(conversationId)
		.catch(async (err) => {
			console.error(`evaluación del trabajo ${conversationId}:`, (err as Error).message);
			await exec(
				"update job_evaluations set attempts = attempts + 1, error = $2, status = case when attempts + 1 >= 3 then 'failed' else status end where conversation_id = $1",
				[conversationId, (err as Error).message.slice(0, 300)],
			);
		})
		.finally(() => pending.delete(conversationId));
	pending.set(conversationId, p);
	return p;
}

/** What the platform measures, without a model. */
export async function metrics(conversationId: number) {
	const runs = await rows<{
		id: number;
		status: string;
		tokens: number;
		cost: number;
		created_at: number;
		started_at: number | null;
		ended_at: number | null;
		kind: string;
	}>(
		"select id, status, tokens, cost, created_at, started_at, ended_at, kind from runs where conversation_id = $1 and kind = 'task' order by id",
		[conversationId],
	);
	const ids = runs.map((r) => r.id);
	const ev = (await row<Record<string, number>>(
		`select
		   count(*) filter (where kind = 'tool')::int as tool_calls,
		   count(*) filter (where kind = 'tool_end' and (data->>'isError') = 'true')::int as tool_errors,
		   count(*) filter (where kind = 'blocked')::int as help_requests,
		   count(*) filter (where kind = 'control' and (data->>'on') = 'true')::int as takeovers,
		   count(*) filter (where kind = 'self_diagnosis')::int as self_diagnoses,
		   count(*) filter (where kind = 'tool_end' and data->>'output' like 'Herramienta fuera del harness%')::int as denied_tools
		 from run_events where run_id = any($1::bigint[])`,
		[ids],
	))!;
	const c = (await row<{ started_at: number; closed_at: number | null }>(
		'select started_at, closed_at from conversations where id = $1',
		[conversationId],
	))!;
	const people = (await row<{ n: number }>(
		"select count(*)::int as n from messages where conversation_id = $1 and source in ('web', 'whatsapp') and person_id is not null",
		[conversationId],
	))!.n;
	const d = (await row<Record<string, number>>(
		`select count(*)::int as delegations, coalesce(sum(sent), 0)::int as delegation_messages,
		   count(*) filter (where status = 'done')::int as delegations_done,
		   (select count(*)::int from delegation_messages m join delegations x on x.id = m.delegation_id where x.conversation_id = $1 and m.role = 'agent') as escalations_answered
		 from delegations where conversation_id = $1`,
		[conversationId],
	))!;
	const flows = await rows<{ status: string }>('select status from flows where conversation_id = $1', [conversationId]);
	const files = (await row<{ n: number }>(
		"select count(*)::int as n from files where direction = 'out' and run_id = any($1::bigint[])",
		[ids],
	))!.n;
	const active = runs.reduce((s, r) => s + (r.started_at && r.ended_at ? r.ended_at - r.started_at : 0), 0);
	return {
		turns: runs.length,
		turns_failed: runs.filter((r) => ['error', 'incomplete', 'cancelled'].includes(r.status)).length,
		minutes_total: Math.round(((c.closed_at ?? Date.now()) - c.started_at) / 60000),
		minutes_working: Math.round(active / 60000),
		tokens: runs.reduce((s, r) => s + Number(r.tokens ?? 0), 0),
		cost: Math.round(runs.reduce((s, r) => s + Number(r.cost ?? 0), 0) * 10000) / 10000,
		messages_from_people: people,
		...ev,
		...d,
		flows: flows.length,
		flows_done: flows.filter((f) => f.status === 'done').length,
		files_delivered: files,
	};
}

const clip = (t: unknown, n: number) => {
	const s = typeof t === 'string' ? t : JSON.stringify(t ?? null);
	return s.length > n ? `${s.slice(0, n)}…` : s;
};
const at = (ms: number) => new Date(ms).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', hour12: false });

/** What it read: the trabajo, its contract, the measurements, and what happened (clipped). */
async function evidence(conversationId: number, m: Awaited<ReturnType<typeof metrics>>) {
	const c = (await row<{
		goal: string | null;
		title: string | null;
		origin: string | null;
		end_reason: string | null;
		summary: string | null;
		result: unknown;
		agent: string;
		agent_id: number;
		role: string;
	}>(
		`select c.goal, c.title, c.origin, c.end_reason, c.summary, c.result, a.name as agent, a.id as agent_id, a.role
		 from conversations c join agents a on a.id = c.agent_id where c.id = $1`,
		[conversationId],
	))!;
	const said = await rows<{ received_at: number; source: string; sender: string | null; text: string }>(
		"select received_at, source, sender, text from messages where conversation_id = $1 and source in ('web', 'whatsapp') order by id limit 40",
		[conversationId],
	);
	const turns = await rows<{
		id: number;
		status: string;
		end_reason: string | null;
		answer: string | null;
		started_at: number | null;
		ended_at: number | null;
	}>(
		"select id, status, end_reason, answer, started_at, ended_at from runs where conversation_id = $1 and kind = 'task' order by id",
		[conversationId],
	);
	const errors = await rows<{ run_id: number; name: string; output: string }>(
		`select run_id, data->>'name' as name, data->>'output' as output from run_events
		 where run_id = any($1::bigint[]) and kind = 'tool_end' and (data->>'isError') = 'true' order by run_id, seq limit 15`,
		[turns.map((t) => t.id)],
	);
	// What it asked and what it was told: the answers it should not need to ask again.
	const help = await rows<{ run_id: number; kind: string; text: string }>(
		`select run_id, kind, coalesce(data->>'reason', data->>'text', data::text) as text from run_events
		 where run_id = any($1::bigint[]) and kind in ('blocked', 'help_answer', 'help_reply') order by run_id, seq limit 20`,
		[turns.map((t) => t.id)],
	);
	// What it worked with (its playbook) and what it saved while working: what the evaluator reviews.
	const playbook = await lessons.playbookFor(conversationId, false);
	const saved = (await lessons.list(c.agent_id)).filter(
		(l) => l.conversation_id === conversationId && !playbook.some((p) => p.id === l.id),
	);
	const saga = await rows<{ flow_id: number; at: number; text: string }>(
		'select e.flow_id, e.at, e.text from flow_events e join flows f on f.id = e.flow_id where f.conversation_id = $1 order by e.id limit 60',
		[conversationId],
	);
	const talks = await rows<{ id: number; contact: string; role: string; text: string }>(
		`select d.id, d.contact, m.role, m.text from delegation_messages m join delegations d on d.id = m.delegation_id
		 where d.conversation_id = $1 order by m.id limit 40`,
		[conversationId],
	);
	return [
		`# Trabajo #${conversationId} de ${c.agent}`,
		`Objetivo: ${c.goal ?? '(no se declaró)'}${c.title ? ` · título: ${c.title}` : ''} · vino por ${c.origin ?? 'web'}`,
		`Cómo terminó: ${c.end_reason ?? '—'}`,
		`Resumen del agente (su versión; no es evidencia): ${c.summary ?? '(no dejó)'}`,
		`Resultado que entregó: ${clip(c.result, 1500)}`,
		'',
		'## Su contrato (lo que debía hacer y cómo)',
		clip(c.role, 4000),
		'',
		'## Medido por la plataforma',
		JSON.stringify(m),
		'',
		'## Lo que le dijeron las personas',
		...said.map((x) => `- [${at(x.received_at)}] ${x.source}${x.sender ? ` (${x.sender})` : ''}: ${clip(x.text, 400)}`),
		'',
		'## Sus turnos',
		...turns.map(
			(t) =>
				`- Turno #${t.id}: ${t.status}${t.end_reason ? ` (${t.end_reason})` : ''}, ${t.started_at && t.ended_at ? Math.round((t.ended_at - t.started_at) / 60000) : '?'} min. Respondió: ${clip(t.answer, 700)}`,
		),
		...(help.length
			? [
					'',
					'## Lo que preguntó y le contestaron',
					...help.map(
						(h) => `- Turno #${h.run_id} ${h.kind === 'blocked' ? 'preguntó' : 'le contestaron'}: ${clip(h.text, 300)}`,
					),
				]
			: []),
		...(errors.length
			? [
					'',
					'## Errores de herramientas',
					...errors.map((e) => `- Turno #${e.run_id} ${e.name}: ${clip(e.output, 200)}`),
				]
			: []),
		...(saga.length
			? ['', '## Sus tareas (historia de la lista)', ...saga.map((s) => `- [${at(s.at)}] ${clip(s.text, 250)}`)]
			: []),
		...(talks.length
			? [
					'',
					'## Sus encargos (pláticas con contactos externos)',
					...talks.map(
						(t) =>
							`- Encargo #${t.id} ${t.role === 'contact' ? t.contact : t.role === 'delegate' ? 'encargo' : t.role}: ${clip(t.text, 250)}`,
					),
				]
			: []),
		'',
		'## Su playbook en este trabajo (aprendizajes con id)',
		...(playbook.length
			? playbook.map(
					(l) =>
						`- [${l.id}] ${l.text} (útil ${l.helpful}, dañino ${l.harmful}${l.pinned ? ', fijado por su dueño' : ''})`,
				)
			: ['(vacío)']),
		...(saved.length
			? ['', '## Lo que guardó como aprendizaje durante el trabajo', ...saved.map((l) => `- [${l.id}] ${l.text}`)]
			: []),
	].join('\n');
}

const INSTRUCTIONS = (criteria: { key: string; name: string; description: string; weight: number }[]) =>
	[
		'Eres el evaluador independiente de un trabajo que hizo un agente de IA contratado por una persona. No trabajaste en él y no tienes interés en que salga bien: juzgas con la evidencia.',
		'- Lo que el agente dice de sí mismo (su resumen, sus respuestas) no es evidencia: compruébalo contra lo medido, los turnos, los errores, los flujos y los encargos.',
		'- Califica cada criterio de 0 a 4: 0 muy mal, 1 mal, 2 regular, 3 bien, 4 excelente. null sólo si de verdad no aplica a este trabajo (por ejemplo, trato con terceros sin contactos externos).',
		'- En justification di por qué, en una o dos frases; en evidence cita de dónde sale (por ejemplo «turno #301», «encargo #2», «mensaje 10:05», «medido: takeovers 2»).',
		'- Sé exigente pero justo: no castigues lo que el dueño pidió ni lo que la plataforma impidió.',
		'- comment: una o dos frases con el balance.',
		'- suggestions: hasta 4 cambios concretos para su contrato (Automejora) que habrían mejorado este trabajo; vacío si no hay.',
		'- summary: en dos o tres frases qué se pidió, qué se hizo y en qué quedó (lo leerá el agente en sus siguientes trabajos).',
		'- lessons: cambios puntuales a sus aprendizajes (su playbook y lo que guardó, con id, en la evidencia), para que en sus siguientes trabajos pregunte menos y no repita errores. No la reescribas: add una lección nueva (una frase concreta y accionable, hasta 300 caracteres): una respuesta de su dueño que le evite volver a preguntarla («Hay refrigerador con espacio: no lo preguntes»), un error y cómo evitarlo, un dato estable (horarios de un proveedor, cómo funciona un sitio); update corrige una (id) con lo nuevo; helpful o harmful marca una (id) que este trabajo mostró útil o que causó un error; remove quita una (id) que quedó falsa o que su dueño contradijo. id null sólo en add; text vacío en helpful, harmful y remove. Nada que ya diga su contrato, nada que sólo valga para este trabajo (las fechas o montos de un pedido), ni datos personales o secretos. Una lección nunca da permisos: no amplía compras, contactos ni límites. Vacío si no hay nada que aprender.',
		'',
		'Criterios (con su peso para el dueño, de 0 a 5):',
		...criteria.map((c) => `- ${c.key} · ${c.name} (peso ${c.weight}): ${c.description}`),
	].join('\n');

export function schema() {
	return {
		type: 'object',
		additionalProperties: false,
		required: ['scores', 'comment', 'suggestions', 'summary', 'lessons'],
		properties: {
			scores: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['key', 'score', 'justification', 'evidence'],
					properties: {
						key: { type: 'string', enum: RUBRIC.map((r) => r.key) },
						score: { type: ['integer', 'null'] },
						justification: { type: 'string' },
						evidence: { type: 'array', items: { type: 'string' } },
					},
				},
			},
			comment: { type: 'string' },
			suggestions: { type: 'array', items: { type: 'string' } },
			summary: { type: 'string' },
			lessons: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['op', 'id', 'text'],
					properties: {
						op: { type: 'string', enum: ['add', 'update', 'helpful', 'harmful', 'remove'] },
						id: { type: ['integer', 'null'] },
						text: { type: 'string' },
					},
				},
			},
		},
	};
}

/** The weighted score, 0 to 100, over the criteria it scored (and the owner weighs). */
export function overall(scores: { score: number | null; weight: number }[]) {
	const counted = scores.filter((s) => s.score !== null && s.weight > 0);
	const max = counted.reduce((n, s) => n + 4 * s.weight, 0);
	return max ? Math.round((counted.reduce((n, s) => n + (s.score as number) * s.weight, 0) / max) * 1000) / 10 : null;
}

async function evaluate(conversationId: number) {
	const e = await row<{ status: string }>('select status from job_evaluations where conversation_id = $1', [
		conversationId,
	]);
	if (!e || e.status !== 'pending') return;
	const a = (await row<{ person_id: number; model: string; harness: unknown }>(
		'select a.person_id, a.model, a.harness from conversations c join agents a on a.id = c.agent_id where c.id = $1',
		[conversationId],
	))!;
	const m = await metrics(conversationId);
	if (!m.turns) {
		await exec(
			"update job_evaluations set status = 'done', metrics = $2, comment = 'No tuvo turnos que evaluar.', done_at = now() where conversation_id = $1",
			[conversationId, JSON.stringify(m)],
		);
		return;
	}
	const criteria = rubricOf(validateHarness(a.harness));
	const asked = await evaluator.ask(
		a.person_id,
		a.model,
		INSTRUCTIONS(criteria),
		await evidence(conversationId, m),
		schema(),
	);
	const v = asked.value;
	const scores = criteria.map((c) => {
		const s = v.scores.find((x) => x.key === c.key);
		const score = typeof s?.score === 'number' ? Math.max(0, Math.min(4, Math.round(s.score))) : null;
		return {
			key: c.key,
			name: c.name,
			weight: c.weight,
			score,
			justification: String(s?.justification ?? '').slice(0, 600),
			evidence: (s?.evidence ?? []).map((x) => String(x).slice(0, 200)).slice(0, 6),
		};
	});
	await exec(
		`update job_evaluations set status = 'done', metrics = $2, scores = $3, overall = $4, comment = $5, suggestions = $6,
		   model = $7, tokens = $8, error = null, done_at = now() where conversation_id = $1`,
		[
			conversationId,
			JSON.stringify(m),
			JSON.stringify(scores),
			overall(scores),
			String(v.comment ?? '').slice(0, 1000),
			JSON.stringify((v.suggestions ?? []).map((x) => String(x).slice(0, 400)).slice(0, 4)),
			a.model,
			asked.tokens,
		],
	);
	// What it learned from this trabajo: small changes to its Aprendizajes, applied by rule.
	if (Array.isArray(v.lessons) && v.lessons.length) {
		const agentId = (await row<{ agent_id: number }>('select agent_id from conversations where id = $1', [
			conversationId,
		]))!.agent_id;
		await lessons.apply(agentId, conversationId, v.lessons);
	}
	// Closed without the agent's own summary (its owner, inactivity): the evaluator's is what it remembers.
	if (v.summary)
		await exec('update conversations set summary = $2 where id = $1 and summary is null', [
			conversationId,
			String(v.summary).slice(0, 2000),
		]);
}

/** Evaluations a restart left, or that failed and may try again. */
export async function sweep() {
	for (const x of await rows<{ conversation_id: number }>(
		"select conversation_id from job_evaluations where status = 'pending' and attempts < 3 and created_at < now() - interval '2 minutes'",
	))
		void run(x.conversation_id);
}
let sweeper: ReturnType<typeof setInterval> | null = null;
export function startSweeper() {
	sweeper ??= setInterval(
		() => void sweep().catch((err) => console.error('evaluaciones:', (err as Error).message)),
		5 * 60_000,
	);
	sweeper.unref?.();
}

/** A trabajo's evaluation, for the web. */
export const of = (conversationId: number) =>
	row<{
		status: string;
		metrics: unknown;
		scores: unknown;
		overall: number | null;
		comment: string | null;
		suggestions: string[] | null;
		error: string | null;
		done_at: number | null;
	}>(
		'select status, metrics, scores, overall, comment, suggestions, error, done_at from job_evaluations where conversation_id = $1',
		[conversationId],
	);

/** The agent's recent evaluations, for Automejora's designer (what its trabajos showed). */
export async function recentFor(agentId: number, limit = 5) {
	return rows<{
		conversation_id: number;
		overall: number | null;
		comment: string | null;
		suggestions: string[] | null;
		scores: unknown;
	}>(
		"select conversation_id, overall, comment, suggestions, scores from job_evaluations where agent_id = $1 and status = 'done' order by done_at desc limit $2",
		[agentId, limit],
	);
}

/**
 * Its rank (Avanzado, next to its name): the average of its latest 20 evaluated trabajos, 0 to 100, and each
 * criterion's average score (0 to 4) over them. Null when none was evaluated yet.
 */
export async function rank(agentId: number) {
	const latest = `select overall, scores from job_evaluations
		where agent_id = $1 and status = 'done' and overall is not null order by done_at desc nulls last limit 20`;
	const r = await row<{ overall: number | null; n: number }>(
		`select round(avg(overall), 1) as overall, count(*)::int as n from (${latest}) e`,
		[agentId],
	);
	if (!r?.n) return null;
	const criteria = await rows<{ key: string; score: number }>(
		`select s->>'key' as key, round(avg((s->>'score')::numeric), 2) as score
		 from (${latest}) e, jsonb_array_elements(e.scores) s
		 where s->>'score' is not null group by 1`,
		[agentId],
	);
	return { overall: r.overall, trabajos: r.n, criteria };
}
