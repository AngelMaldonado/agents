// Tareas (Angel 6-nov-2026, from the flujos of #18): every trabajo keeps one list of tasks that its agent and
// its owner see and edit. The list is a flow: a recipe of the contract preloads it (and asks for its result
// in the recipe's shape), or the agent writes it (task_plan) when the trabajo has more than one step. The
// platform keeps it: it launches the encargos, asks the owner, waits (for a time, or for a person's reply,
// which then lands in this trabajo), and wakes the agent when a task is its own or something needs deciding.
// Its owner may add, check, skip, reopen or remove tasks from the web; the agent hears it as an instruction.
//
// The saga (flow_events) is the one record of what happened. Every work of the agent starts with its
// trabajo's list in full and the others' in short (activeBlock).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { row, rows, exec, DATA_DIR } from './db';
import {
	checkStep,
	flowParams,
	validateHarness,
	type DelegationField,
	type FlowRecipe,
	type FlowStepKind,
} from '../../sandbox/harness';
import { receive } from './inbox';
import * as delegations from './delegations';

type FlowStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'expired';
type StepStatus = 'pending' | 'working' | 'waiting' | 'blocked' | 'done' | 'skipped' | 'failed' | 'removed';
type Encargo = { plantilla: string; contacto: string; parametros: Record<string, string>; contexto: string };
type Spec = {
	instructions: string;
	optional: boolean;
	hours: number | null;
	encargo: Encargo | null;
	/** A question: what the agent wrote for its owner (short), and the files it sends with it. */
	question?: string;
	files?: string[];
	/** A wait for a person's reply (a contact of the agent): their next message lands in this trabajo. */
	persona?: { name: string; number: number; phone: string; sim?: boolean };
	/** Who added it, when it was its owner from the web. */
	by?: 'owner';
};
export type Flow = {
	id: number;
	agent_id: number;
	run_id: number | null;
	conversation_id: number | null;
	/** The recipe that preloaded it; null for a list the agent or its owner wrote. */
	recipe: FlowRecipe | null;
	params: Record<string, string>;
	title: string;
	status: FlowStatus;
	waiting_for: string | null;
	waiting_since: string | null;
	result: unknown;
	summary: string | null;
	end_reason: string | null;
	wakes: number;
	asked_final: boolean;
	deadline: string;
	created_at: string;
	updated_at: string;
	ended_at: string | null;
};
export type Step = {
	id: number;
	flow_id: number;
	key: string;
	position: number;
	title: string;
	kind: FlowStepKind;
	depends: string[];
	spec: Spec;
	status: StepStatus;
	result: unknown;
	note: string | null;
	delegation_id: number | null;
	until: string | null;
	started_at: string | null;
	ended_at: string | null;
};
type Reply = { ok: boolean; error?: string; [k: string]: unknown };

/** The time, for deadlines and waits; tests set it. */
export const clock = { now: () => new Date() };
/** A list stays readable: up to 12 open tasks (finished ones stay as its history), no subtasks. */
export const MAX_STEPS = 12;
/** A free list's budget (a recipe has its own). */
const budget = (f: Flow) => ({
	delegations: f.recipe?.maxDelegations ?? 6,
	wakes: f.recipe?.maxWakes ?? 40,
});
const load = (id: number) => row<Flow>('select * from flows where id = $1', [id]);
const stepsOf = (id: number) =>
	rows<Step>("select * from flow_steps where flow_id = $1 and status <> 'removed' order by position, id", [id]);
const fill = (text: string, params: Record<string, string>) =>
	text.replace(/\{([a-z][a-z0-9_]{0,30})\}/g, (all, name) => params[name] ?? all);
const finished = (s: StepStatus) => s === 'done' || s === 'skipped';
const when = (iso: string | Date) =>
	new Date(iso).toLocaleString('es-MX', {
		timeZone: 'America/Mexico_City',
		weekday: 'short',
		hour: '2-digit',
		minute: '2-digit',
	});

/** One line of the saga. */
async function event(flowId: number, kind: string, text: string, stepKey: string | null = null, data?: unknown) {
	await exec('insert into flow_events (flow_id, step_key, kind, text, data) values ($1, $2, $3, $4, $5)', [
		flowId,
		stepKey,
		kind,
		text.slice(0, 2000),
		data === undefined ? null : JSON.stringify(data),
	]);
}

/** The run that calls a tool: its agent, its harness and its conversation. */
async function caller(runId: number) {
	return row<{ agent_id: number; owner_id: number; harness: unknown; conversation_id: number }>(
		`select a.id as agent_id, a.person_id as owner_id, a.harness, r.conversation_id
		 from runs r join agents a on a.id = r.agent_id where r.id = $1 and a.deleted_at is null`,
		[runId],
	);
}
type Trabajo = { id: number; is_default: boolean; status: string; goal: string | null };
/** The trabajo a tool works on (its own, or another of the agent's) and its running list, if any. */
async function target(runId: number, trabajo?: unknown) {
	const a = await caller(runId);
	if (!a) return { error: 'El trabajo ya no existe.' } as const;
	const id = trabajo === undefined || trabajo === null || trabajo === '' ? a.conversation_id : Number(trabajo);
	const c = await row<Trabajo>(
		'select id, is_default, status, goal from conversations where id = $1 and agent_id = $2 and deleted_at is null',
		[id, a.agent_id],
	);
	if (!c) return { error: `No hay un trabajo #${trabajo} de este agente.` } as const;
	if (c.is_default)
		return {
			error: 'La conversación Principal no es un trabajo: no tiene lista de tareas. Las tareas viven en un trabajo.',
		} as const;
	return { a, c, f: await listOf(c.id) };
}
const listOf = (conversationId: number) =>
	row<Flow>("select * from flows where conversation_id = $1 and status = 'running'", [conversationId]);

// ---------- what the agent reads ----------

const STEP_MARK: Record<StepStatus, string> = {
	pending: '[ ]',
	working: '[en curso]',
	waiting: '[espera]',
	blocked: '[bloqueada]',
	done: '[✓]',
	skipped: '[omitida]',
	failed: '[falló]',
	removed: '[quitada]',
};
const fieldsText = (p: { list: boolean; fields: DelegationField[] }) =>
	`${p.list ? 'una lista de renglones con' : 'un registro con'} ${p.fields.map((f) => `${f.name} (${f.type}): ${f.description}`).join('; ')}`;
const kindText = (s: Step) =>
	s.kind === 'wait' && s.spec.persona
		? `espera a ${s.spec.persona.name}`
		: s.kind === 'delegation' && s.spec.encargo
			? `encargo con ${s.spec.encargo.contacto || '?'}`
			: {
					agent: 'tuya',
					subagent: 'subagente',
					delegation: 'encargo',
					question: 'pregunta a tu dueño',
					wait: 'espera',
				}[s.kind];

/** How it goes, for the agent: its tasks, what each got, who it waits for, what people established. */
export async function board(f: Flow, steps?: Step[]) {
	const list = steps ?? (await stepsOf(f.id));
	const facts = await rows<{ source: string; text: string }>(
		'select source, text from flow_facts where flow_id = $1 order by id',
		[f.id],
	);
	const goal = f.recipe
		? fill(f.recipe.objective, f.params)
		: ((await row<{ goal: string | null }>('select goal from conversations where id = $1', [f.conversation_id]))
				?.goal ?? f.title);
	const short = (v: unknown) => {
		const t = JSON.stringify(v);
		return t && t.length > 600 ? `${t.slice(0, 600)}…` : t;
	};
	const done = list.filter((s) => finished(s.status)).length;
	return [
		`Tareas del trabajo #${f.conversation_id}${f.recipe ? ` (receta ${f.recipe.name})` : ''} · ${done} de ${list.length} · ${f.status === 'running' ? `vence ${when(f.deadline)}` : f.status}`,
		`Objetivo: ${goal}`,
		...(f.recipe ? [`Debe producir: ${fieldsText(f.recipe.produces)}.`] : []),
		...(f.waiting_for ? [`Espera a: ${f.waiting_for}`] : []),
		...list.map(
			(s) =>
				`- ${STEP_MARK[s.status]} ${s.key} · ${s.title} (${kindText(s)}${s.depends.length ? `, después de ${s.depends.join(', ')}` : ''}${s.spec.optional ? ', opcional' : ''}${s.spec.by === 'owner' ? ', la agregó tu dueño' : ''})${s.status === 'working' || s.status === 'pending' ? `: ${s.spec.instructions}` : ''}${s.result !== null && s.result !== undefined ? ` → ${short(s.result)}` : ''}${s.note ? ` (${s.note})` : ''}`,
		),
		...(facts.length
			? [
					'Ya establecido (no lo vuelvas a preguntar):',
					...facts.map(
						(x) => `- ${x.source === 'owner' ? 'tu dueño' : x.source === 'contact' ? 'un contacto' : 'tú'}: ${x.text}`,
					),
				]
			: []),
	].join('\n');
}

/**
 * Every work of the agent starts with this: its trabajo's list in full (or how to start one), and the
 * lists of its other trabajos in short.
 */
export async function activeBlock(agentId: number, conversationId?: number) {
	const here = conversationId
		? await row<Trabajo>('select id, is_default, status, goal from conversations where id = $1', [conversationId])
		: null;
	const current = here && !here.is_default ? await listOf(here.id) : null;
	const others = await rows<Flow>(
		"select * from flows where agent_id = $1 and status = 'running' and conversation_id is distinct from $2 order by id desc limit 5",
		[agentId, current?.conversation_id ?? null],
	);
	const parts: string[] = [];
	if (current)
		parts.push(
			`## Tus tareas\n${await board(current)}\nMantenla al día: task_update al empezar una (working), al terminarla (done, con su resultado) o si te atoras (blocked, con el motivo). Ajusta la lista con task_plan diciendo por qué. Tu dueño también la edita desde la web.`,
		);
	else if (here && !here.is_default && here.status === 'open')
		parts.push(
			`## Tus tareas\nEste trabajo no tiene lista. Si tiene más de un paso, escríbela con task_plan antes de empezar (hasta ${MAX_STEPS} tareas, sin subtareas): tú y tu dueño la ven y la siguen. Si es de un solo paso, no hace falta.`,
		);
	if (others.length) {
		const lines = [];
		for (const f of others) {
			const steps = await stepsOf(f.id);
			const done = steps.filter((s) => finished(s.status)).length;
			lines.push(
				`- Trabajo #${f.conversation_id} · ${f.title}${f.recipe ? ` (receta ${f.recipe.name})` : ''}: ${done} de ${steps.length}${f.waiting_for ? `; espera a ${f.waiting_for}` : ''}.`,
			);
		}
		parts.push(
			`## Tareas de tus otros trabajos\nSiguen aunque no estés en su conversación (el detalle, con task_list y su trabajo):\n${lines.join('\n')}`,
		);
	}
	return parts.join('\n\n');
}

// ---------- the agent's tools ----------

/** A new list for a trabajo: free, or preloaded from a recipe with its parameters. */
async function create(
	a: { agent_id: number; harness: unknown },
	c: Trabajo,
	runId: number | null,
	input: { receta?: unknown; parametros?: unknown; titulo?: unknown },
	now: Date,
): Promise<{ error: string } | { id: number; recipe: FlowRecipe | null }> {
	let recipe: FlowRecipe | null = null;
	const params: Record<string, string> = {};
	if (input.receta) {
		const h = validateHarness(a.harness);
		const r = (h.flows ?? []).find((x) => x.name === String(input.receta).trim());
		if (!r)
			return {
				error: h.flows?.length
					? `No hay una receta «${String(input.receta)}». Las de tu contrato: ${h.flows.map((x) => x.name).join(', ')}.`
					: 'Tu contrato no tiene recetas: escribe tus tareas con agregar.',
			};
		const names = flowParams(r);
		const given = input.parametros && typeof input.parametros === 'object' ? (input.parametros as object) : {};
		for (const [k, v] of Object.entries(given)) {
			if (!names.includes(k)) return { error: `La receta ${r.name} no tiene el parámetro «${k}».` };
			const value = String(v ?? '').trim();
			if (value.length > 2000) return { error: `«${k}» pasa de 2000 caracteres.` };
			if (value) params[k] = value;
		}
		const missing = names.filter((n) => !params[n]);
		if (missing.length) return { error: `Faltan parámetros de ${r.name}: ${missing.join(', ')}.` };
		recipe = r;
	}
	const title =
		String(input.titulo ?? '')
			.trim()
			.slice(0, 80) ||
		(recipe ? recipe.description.slice(0, 80) : (c.goal ?? '').slice(0, 80)) ||
		`Trabajo #${c.id}`;
	const hours = recipe?.maxHours ?? 14 * 24;
	let id: number;
	try {
		id = (await row<{ id: number }>(
			`insert into flows (agent_id, run_id, conversation_id, recipe, params, title, deadline)
			 values ($1, $2, $3, $4, $5, $6, $7) returning id`,
			[
				a.agent_id,
				runId,
				c.id,
				recipe ? JSON.stringify(recipe) : null,
				JSON.stringify(params),
				title,
				new Date(now.getTime() + hours * 3600_000),
			],
		))!.id;
	} catch (err) {
		if ((err as { code?: string }).code === '23505')
			return { error: `El trabajo #${c.id} ya tiene su lista de tareas: ajústala con task_plan.` };
		throw err;
	}
	for (const [i, st] of (recipe?.steps ?? []).entries())
		await insertStep(id, i, {
			key: st.key,
			title: st.title,
			kind: st.kind,
			depends: st.depends,
			spec: {
				instructions: fill(st.instructions, params),
				optional: st.optional,
				hours: st.hours,
				encargo: st.delegation
					? {
							plantilla: st.delegation.template,
							contacto: st.delegation.contact,
							parametros: Object.fromEntries(st.delegation.params.map((p) => [p.name, fill(p.value, params)])),
							contexto: '',
						}
					: null,
			},
		});
	// A recipe states the trabajo's objective when nobody did yet.
	if (recipe && !c.goal)
		await exec("update conversations set goal = $2 where id = $1 and status = 'open' and goal is null", [
			c.id,
			fill(recipe.objective, params).slice(0, 1000),
		]);
	await event(
		id,
		'started',
		recipe
			? `Arrancó con la receta ${recipe.name}: ${recipe.steps.length} tareas, vence en ${recipe.maxHours} h.`
			: 'Empezó la lista de tareas.',
		null,
		{ params },
	);
	return { id, recipe };
}

const yours = (t: Turn) => ({
	...(t.mine.length
		? {
				tareas_tuyas: t.mine.map((s) => ({
					tarea: s.key,
					titulo: s.title,
					tipo: s.kind,
					instrucciones: s.spec.instructions,
				})),
			}
		: {}),
	...(t.final ? { entrega_el_resultado: true } : {}),
	...(t.stuck?.length
		? {
				bloqueadas: t.stuck,
				decide:
					'Falló una tarea de la que dependen otras: reintenta con una nueva (y marca skipped la que falló), omítelas o cambia la lista.',
			}
		: {}),
});

async function insertStep(
	flowId: number,
	position: number,
	s: { key: string; title: string; kind: FlowStepKind; depends: string[]; spec: Spec },
) {
	await exec(
		`insert into flow_steps (flow_id, key, position, title, kind, depends, spec) values ($1, $2, $3, $4, $5, $6, $7)
		 on conflict (flow_id, key) do update set position = excluded.position, title = excluded.title, kind = excluded.kind,
		   depends = excluded.depends, spec = excluded.spec, status = 'pending', result = null, note = null,
		   delegation_id = null, until = null, started_at = null, ended_at = null`,
		[flowId, s.key, position, s.title, s.kind, s.depends, JSON.stringify(s.spec)],
	);
}

/**
 * task_plan: writes the trabajo's list (free, or from a recipe of the contract) or changes it: adds or
 * redefines tasks that have not started, or takes them out; a change says why.
 */
export async function plan(
	runId: number,
	input: {
		trabajo?: unknown;
		receta?: unknown;
		parametros?: unknown;
		titulo?: unknown;
		motivo?: unknown;
		agregar?: unknown;
		quitar?: unknown;
	},
	now = clock.now(),
): Promise<Reply> {
	const t = await target(runId, input.trabajo);
	if ('error' in t) return { ok: false, error: t.error };
	const { a, c } = t;
	if (c.status !== 'open') return { ok: false, error: `El trabajo #${c.id} ya terminó.` };
	let f = t.f;
	const fresh = !f;
	if (f && input.receta)
		return {
			ok: false,
			error: `El trabajo #${c.id} ya tiene su lista: agrega tareas con agregar, o empieza otro trabajo para esa receta.`,
		};
	if (!f) {
		const made = await create(a, c, runId, input, now);
		if ('error' in made) return { ok: false, error: made.error };
		f = (await load(made.id))!;
	}
	const why = String(input.motivo ?? '')
		.trim()
		.slice(0, 500);
	const adding = (Array.isArray(input.agregar) ? input.agregar : []) as Record<string, unknown>[];
	const remove = (Array.isArray(input.quitar) ? input.quitar : []).map(String);
	if (!fresh && !why && (adding.length || remove.length))
		return { ok: false, error: 'Di por qué cambias la lista (motivo): queda en su historia.' };
	const h = validateHarness(a.harness);
	const steps = await stepsOf(f.id);
	const byKey = new Map(steps.map((s) => [s.key, s]));
	for (const k of remove) {
		const s = byKey.get(k);
		if (!s) return { ok: false, error: `No hay una tarea «${k}».` };
		if (s.status !== 'pending' && s.status !== 'working' && s.status !== 'blocked')
			return {
				ok: false,
				error: `La tarea ${k} ya ${s.status === 'waiting' ? 'está en curso (si es un encargo, márcala skipped con task_update)' : 'terminó'}: no se quita.`,
			};
		if (steps.some((x) => x.key !== k && !remove.includes(x.key) && x.depends.includes(k) && !finished(x.status)))
			return { ok: false, error: `Otras tareas van después de ${k}: cámbialas o quítalas también.` };
	}
	const kept = steps.filter((s) => !remove.includes(s.key));
	const before = kept.map((s) => s.key);
	const added: { key: string; title: string; kind: FlowStepKind; depends: string[]; spec: Spec }[] = [];
	try {
		for (const raw of adding) {
			const key = String(raw?.key ?? raw?.clave ?? '');
			const existing = byKey.get(key);
			// Pending or blocked, it has not been done: it may be redefined (and goes pending again).
			if (existing && !remove.includes(key) && existing.status !== 'pending' && existing.status !== 'blocked')
				return { ok: false, error: `La tarea ${key} ya empezó o terminó: crea otra con una clave nueva.` };
			const enc = raw?.encargo as Record<string, unknown> | null | undefined;
			const step = checkStep(
				{
					key,
					title: raw?.title ?? raw?.titulo,
					kind: raw?.kind ?? raw?.tipo ?? 'agent',
					depends: raw?.depends ?? raw?.depende ?? [],
					instructions: raw?.instructions ?? raw?.instrucciones ?? raw?.titulo ?? raw?.title ?? '',
					optional: !!(raw?.optional ?? raw?.opcional),
					// A wait for a person lasts a week unless it says otherwise; then the agent decides.
					hours: raw?.hours ?? raw?.horas ?? (raw?.persona ? 168 : null),
					delegation: enc
						? {
								template: enc.plantilla,
								contact: enc.contacto ?? '',
								params: Object.entries((enc.parametros as object) ?? {}).map(([name, value]) => ({
									name,
									value: String(value),
								})),
							}
						: null,
				},
				before.filter((k) => k !== key),
				h.tools as readonly string[],
				h.delegations ?? [],
				`la lista del trabajo #${c.id}`,
			);
			// A wait for a person: their next message, from any chat with the agent, lands in this trabajo.
			let persona: Spec['persona'];
			if (raw?.persona) {
				if (step.kind !== 'wait') return { ok: false, error: `Sólo una espera (wait) espera a una persona (${key}).` };
				const who = await (await import('./whatsapp')).contactFor(a.agent_id, a.owner_id, String(raw.persona));
				if (!who)
					return {
						ok: false,
						error: `«${String(raw.persona)}» no es un contacto encendido para este agente (Canales → Quién le escribe por WhatsApp).`,
					};
				if (who.contact.kind === 'external')
					return {
						ok: false,
						error: `${who.contact.name} es un contacto externo: para esperar su respuesta, lanza un encargo.`,
					};
				persona = {
					name: who.contact.name,
					number: who.number.id,
					phone: who.contact.phone,
					// Conversaciones simuladas: only a simulated reply answers it.
					...((await (await import('./whatsapp-sim')).on(a.agent_id)) ? { sim: true } : {}),
				};
			}
			before.push(step.key);
			added.push({
				key: step.key,
				title: step.title,
				kind: step.kind,
				depends: step.depends,
				spec: {
					instructions: step.instructions,
					optional: step.optional,
					hours: step.hours,
					encargo: step.delegation
						? {
								plantilla: step.delegation.template,
								contacto: step.delegation.contact,
								parametros: Object.fromEntries(step.delegation.params.map((p) => [p.name, p.value])),
								contexto: String(enc?.contexto ?? '').slice(0, 4000),
							}
						: null,
					...(persona ? { persona } : {}),
				},
			});
		}
	} catch (err) {
		return { ok: false, error: (err as Error).message.replace(/^Harness: /, '').replace(/\bpaso/g, 'tarea') };
	}
	const open = (st: StepStatus) => !finished(st) && st !== 'failed';
	const active = kept.filter((s) => open(s.status) && !added.some((x) => x.key === s.key)).length + added.length;
	if (active > MAX_STEPS && active > steps.filter((s) => open(s.status)).length)
		return {
			ok: false,
			error: `Una lista tiene hasta ${MAX_STEPS} tareas abiertas: junta, omite o quita algunas (las terminadas no cuentan).`,
		};
	const encargos =
		kept.filter((s) => s.kind === 'delegation' && !added.some((x) => x.key === s.key)).length +
		added.filter((s) => s.kind === 'delegation').length;
	if (encargos > budget(f).delegations)
		return {
			ok: false,
			error: `Esta lista permite ${budget(f).delegations} encargos y el plan tendría ${encargos}.`,
		};
	for (const k of remove)
		await exec("update flow_steps set status = 'removed', ended_at = now() where flow_id = $1 and key = $2", [f.id, k]);
	// A new plan may add tasks after the last one: the result is asked for again when they end.
	await exec('update flows set asked_final = false where id = $1', [f.id]);
	const last = Math.max(-1, ...steps.map((s) => s.position));
	for (const [i, s] of added.entries()) await insertStep(f.id, byKey.get(s.key)?.position ?? last + 1 + i, s);
	if (added.length || remove.length)
		await event(
			f.id,
			'planned',
			`${fresh ? 'Escribió la lista' : 'Cambió la lista'}: ${[...added.map((s) => `${byKey.has(s.key) ? 'redefinió' : 'agregó'} ${s.key}`), ...remove.map((k) => `quitó ${k}`)].join(', ')}.${why ? ` Motivo: ${why}` : ''}`,
			null,
			{ agregar: added.map((s) => s.key), quitar: remove },
		);
	const turn = await advance(f.id, { inRun: true });
	return { ok: true, trabajo: c.id, ...yours(turn) };
}

/**
 * task_update: a task's state (working when it starts it, done with its result, blocked with the reason,
 * skipped or failed), or the list's result in the recipe's shape when every task is over.
 */
export async function update(
	runId: number,
	input: { trabajo?: unknown; tarea?: unknown; resultado?: unknown; estado?: unknown; nota?: unknown },
): Promise<Reply> {
	const t = await target(runId, input.trabajo);
	if ('error' in t) return { ok: false, error: t.error };
	const f = t.f;
	if (!f) return { ok: false, error: `El trabajo #${t.c.id} no tiene lista de tareas: escríbela con task_plan.` };
	const note =
		String(input.nota ?? '')
			.trim()
			.slice(0, 500) || null;
	const steps = await stepsOf(f.id);
	if (input.tarea) {
		const s = steps.find((x) => x.key === String(input.tarea));
		if (!s) return { ok: false, error: `No hay una tarea «${input.tarea}» en el trabajo #${t.c.id}.` };
		const estado = (
			['working', 'blocked', 'done', 'skipped', 'failed'].includes(String(input.estado)) ? String(input.estado) : 'done'
		) as StepStatus;
		// A failed task may be skipped (another replaced it), or taken up again (working) or held (blocked).
		if (finished(s.status) || (s.status === 'failed' && !['skipped', 'working', 'blocked'].includes(estado)))
			return {
				ok: false,
				error: `La tarea ${s.key} ya terminó (${s.status})${s.status === 'failed' ? '; puedes marcarla skipped si otra la reemplazó, o working/blocked si la retomas' : ''}.`,
			};
		if (estado === 'blocked' && !note) return { ok: false, error: 'Di qué la bloquea (nota).' };
		if ((estado === 'working' || estado === 'blocked') && s.status === 'waiting')
			return {
				ok: false,
				error: `La tarea ${s.key} la lleva la plataforma (${kindText(s)}): su resultado llega solo.`,
			};
		const cancelling = s.kind === 'delegation' && s.status === 'waiting';
		if (cancelling && estado !== 'skipped')
			return {
				ok: false,
				error: `La tarea ${s.key} es un encargo en curso: su resultado llega solo (o márcala skipped para cancelarlo).`,
			};
		const closes = estado === 'done' || estado === 'skipped' || estado === 'failed';
		await exec(
			`update flow_steps set status = $3, result = coalesce($4, result), note = $5, started_at = coalesce(started_at, now()),
			   ended_at = case when $6 then now() else null end where flow_id = $1 and key = $2`,
			[f.id, s.key, estado, input.resultado === undefined ? null : JSON.stringify(input.resultado), note, closes],
		);
		// After the task is marked: the encargo's ending then finds it closed and wakes nobody.
		if (cancelling && s.delegation_id) await delegations.end(s.delegation_id, 'cancelled', 'lo saltó el agente');
		if (s.kind === 'question' && estado === 'done')
			await exec("insert into flow_facts (flow_id, source, text) values ($1, 'owner', $2)", [
				f.id,
				`${s.spec.instructions} → ${typeof input.resultado === 'string' ? input.resultado : JSON.stringify(input.resultado)}`.slice(
					0,
					1000,
				),
			]);
		await event(
			f.id,
			'step',
			`${s.key}: ${{ working: 'en curso', blocked: 'bloqueada', done: 'lista', skipped: 'omitida', failed: 'falló' }[estado as 'done']}${note ? ` (${note})` : ''}.`,
			s.key,
			{ resultado: input.resultado ?? null },
		);
		const turn = await advance(f.id, { inRun: true });
		return { ok: true, trabajo: t.c.id, ...yours(turn) };
	}
	// The list's result: in the recipe's shape, once nothing is left but optional tasks.
	if (!f.recipe)
		return {
			ok: false,
			error:
				'Di qué tarea (tarea). Esta lista no entrega resultado: cierra el trabajo con job_done cuando sus tareas terminen.',
		};
	const open = steps.filter((s) => !finished(s.status) && !(s.spec.optional && s.status === 'pending'));
	if (open.length)
		return {
			ok: false,
			error: `Faltan tareas: ${open.map((s) => `${s.key} (${s.status})`).join(', ')}. Termínalas, márcalas skipped o quítalas con task_plan.`,
		};
	const problem = shapeError(f.recipe.produces, input.resultado);
	if (problem) return { ok: false, error: `El resultado no tiene la forma de la receta: ${problem}` };
	await finish(f, 'done', null, input.resultado, note);
	return { ok: true, trabajo: t.c.id, terminado: true };
}

/** Whether a result has the recipe's shape: a row (or rows) with its fields and their types. */
function shapeError(p: { list: boolean; fields: DelegationField[] }, value: unknown) {
	const rowsOf = p.list ? value : [value];
	if (!Array.isArray(rowsOf)) return 'debe ser una lista de renglones.';
	for (const [i, r] of rowsOf.entries()) {
		if (!r || typeof r !== 'object' || Array.isArray(r)) return `el renglón ${i + 1} no es un objeto.`;
		for (const fl of p.fields) {
			const v = (r as Record<string, unknown>)[fl.name];
			if (v === undefined) return `falta ${fl.name}${p.list ? ` en el renglón ${i + 1}` : ''}.`;
			if (v !== null && typeof v !== (fl.type === 'text' ? 'string' : fl.type))
				return `${fl.name} debe ser ${fl.type === 'text' ? 'texto' : fl.type === 'number' ? 'número' : 'sí/no'}.`;
		}
	}
	return null;
}

/** The longest a question to its owner may be: the details go in its files. */
const QUESTION_MAX = 600;
const filesDir = (flowId: number, key: string) => join(DATA_DIR, 'flows', String(flowId), key);

/**
 * task_ask: a question to its owner, written by the agent: a new one, or the one a question task is for
 * (tarea). Short, with the files it needs (a report); it waits for the answer.
 */
export async function ask(
	runId: number,
	input: { trabajo?: unknown; tarea?: unknown; pregunta?: unknown; files?: unknown },
	now = clock.now(),
): Promise<Reply> {
	const t = await target(runId, input.trabajo);
	if ('error' in t) return { ok: false, error: t.error };
	if (t.c.status !== 'open') return { ok: false, error: `El trabajo #${t.c.id} ya terminó.` };
	const q = String(input.pregunta ?? '').trim();
	if (!q) return { ok: false, error: 'La pregunta está vacía.' };
	if (q.length > QUESTION_MAX)
		return {
			ok: false,
			error: `La pregunta pasa de ${QUESTION_MAX} caracteres: escríbela como para alguien ocupado (una o dos frases con lo que debe decidir) y deja los detalles en el archivo adjunto.`,
		};
	let f = t.f;
	if (!f) {
		const made = await create(t.a, t.c, runId, {}, now);
		if ('error' in made) return { ok: false, error: made.error };
		f = (await load(made.id))!;
	}
	const steps = await rows<Step>('select * from flow_steps where flow_id = $1', [f.id]);
	const step = input.tarea ? steps.find((x) => x.key === String(input.tarea)) : null;
	if (input.tarea) {
		if (!step || step.kind !== 'question' || step.status === 'removed')
			return { ok: false, error: `«${input.tarea}» no es una tarea de pregunta de este trabajo.` };
		if (!['working', 'waiting', 'pending'].includes(step.status))
			return { ok: false, error: `La pregunta ${step.key} ya tiene respuesta.` };
	}
	const key = step?.key ?? `pregunta-${steps.filter((s) => s.key.startsWith('pregunta-')).length + 1}`;
	const list = (Array.isArray(input.files) ? input.files : []).slice(0, 5) as { name?: unknown; data?: unknown }[];
	const files: string[] = [];
	for (const file of list) {
		const name = String(file?.name ?? 'archivo')
			.replace(/[^\w.-]/g, '_')
			.slice(0, 100);
		const buf = Buffer.from(String(file?.data ?? ''), 'base64');
		if (!name || !buf.length || buf.length > 8 * 1024 * 1024) continue;
		mkdirSync(filesDir(f.id, key), { recursive: true });
		writeFileSync(join(filesDir(f.id, key), name), buf);
		files.push(name);
	}
	if (step) {
		await exec('update flow_steps set spec = spec || $2::jsonb where id = $1', [
			step.id,
			JSON.stringify({ question: q, files }),
		]);
		// Its own task, already its turn: it goes now (pending ones go when their turn comes).
		if (step.status !== 'pending') {
			const fresh = (await row<Step>('select * from flow_steps where id = $1', [step.id]))!;
			const flow = f;
			await serial(f.id, () => sendQuestion(flow, fresh));
		}
	} else
		await insertStep(f.id, Math.max(-1, ...steps.map((s) => s.position)) + 1, {
			key,
			title: q.slice(0, 120),
			kind: 'question',
			depends: [],
			spec: { instructions: q, optional: false, hours: null, encargo: null, question: q, files },
		});
	await advance(f.id, { inRun: true });
	return {
		ok: true,
		trabajo: t.c.id,
		tarea: key,
		...(files.length ? { archivos: files } : {}),
		siguiente: 'Su respuesta te llega en esta conversación; mientras, termina tu trabajo.',
	};
}

/** The question goes to its owner (their group and the web), with its files; the task waits. */
async function sendQuestion(f: Flow, s: Step) {
	const q = s.spec.question ?? s.spec.instructions;
	const files = (s.spec.files ?? []).flatMap((name) => {
		try {
			return [{ name, mime: mimeOf(name), data: readFileSync(join(filesDir(f.id, s.key), name)).toString('base64') }];
		} catch {
			return [];
		}
	});
	await exec(
		"update flow_steps set status = 'waiting', started_at = coalesce(started_at, now()), note = null where id = $1",
		[s.id],
	);
	const told = await (
		await import('./whatsapp')
	)
		.tellOwner(f.agent_id, `${q}\n\nResponde aquí o en la web.`, f.conversation_id, files)
		.catch(() => false);
	await event(
		f.id,
		'question',
		`Te preguntó: ${q}${files.length ? ` [${files.map((x) => x.name).join(', ')}]` : ''}${told ? ' (por tu grupo de WhatsApp y la web)' : ' (en la web)'}`,
		s.key,
		files.length ? { files: files.map((x) => x.name) } : undefined,
	);
}

const MIME: Record<string, string> = {
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	csv: 'text/csv',
	txt: 'text/plain',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** task_list: a trabajo's list (its own by default), and the agent's other running lists in short. */
export async function listTool(runId: number, input: { trabajo?: unknown }): Promise<Reply> {
	const t = await target(runId, input.trabajo);
	if ('error' in t) return { ok: false, error: t.error };
	const others = await rows<Flow>(
		"select * from flows where agent_id = $1 and status = 'running' and conversation_id is distinct from $2 order by id desc limit 5",
		[t.a.agent_id, t.c.id],
	);
	return {
		ok: true,
		trabajo: t.c.id,
		tareas: t.f ? await board(t.f) : 'Este trabajo no tiene lista de tareas.',
		...(others.length
			? {
					otros_trabajos: others.map(
						(f) => `Trabajo #${f.conversation_id} · ${f.title}${f.waiting_for ? ` · espera a ${f.waiting_for}` : ''}`,
					),
				}
			: {}),
	};
}

/** The sandbox's request (task_*), answered for the supervisor. */
export async function handle(runId: number, op: string, args: Record<string, unknown>): Promise<Reply> {
	try {
		if (op === 'plan') return await plan(runId, args);
		if (op === 'update') return await update(runId, args);
		if (op === 'ask') return await ask(runId, args);
		if (op === 'list') return await listTool(runId, args);
		return { ok: false, error: 'Operación de tareas desconocida.' };
	} catch (err) {
		console.error(`tareas (${op}) del turno ${runId}:`, (err as Error).message);
		return { ok: false, error: 'No se pudo completar; consulta task_list antes de repetir.' };
	}
}

// ---------- the engine ----------

type Turn = { mine: Step[]; final: boolean; stuck?: string[] };
const locks = new Map<number, Promise<unknown>>();
/** One pass at a time per flow. */
function serial<T>(id: number, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(id) ?? Promise.resolve();
	const next = prev.catch(() => {}).then(fn);
	locks.set(id, next);
	void next.finally(() => locks.get(id) === next && locks.delete(id)).catch(() => {});
	return next;
}
/** Once the pass in progress ended; for tests. */
export const idle = (id: number) => (locks.get(id) ?? Promise.resolve()).catch(() => {});

/**
 * What is ready goes: encargos launch, questions reach the owner, waits start, the agent's steps are its.
 * `inRun`: called from one of its tools, in its work: what is its own is answered there, not woken for.
 */
export function advance(id: number, opts: { inRun?: boolean } = {}): Promise<Turn> {
	return serial(id, () => pass(id, opts.inRun ?? false));
}

async function pass(id: number, inRun: boolean): Promise<Turn> {
	const none = { mine: [], final: false };
	const f = await load(id);
	if (!f || f.status !== 'running') return none;
	const now = clock.now();
	if (new Date(f.deadline) <= now) {
		await finish(f, 'expired', 'venció su plazo');
		return none;
	}
	let steps = await stepsOf(id);
	const assigned: Step[] = [];
	const lapsed: string[] = [];
	for (const s of steps) {
		if (s.status === 'waiting' && s.kind === 'wait' && s.until && new Date(s.until) <= now) {
			if (s.spec.persona) {
				// Nobody answered in time: the agent decides (insist, go on without it, change the list).
				await setStep(s, 'failed', { note: `${s.spec.persona.name} no respondió a tiempo` });
				await event(id, 'step', `${s.key}: ${s.spec.persona.name} no respondió a tiempo.`, s.key);
				lapsed.push(`${s.key} (${s.spec.persona.name} no respondió a tiempo)`);
			} else {
				await setStep(s, 'done', { note: 'terminó la espera' });
				await event(id, 'step', `${s.key}: terminó la espera.`, s.key);
			}
		}
	}
	steps = await stepsOf(id);
	// A task after one that failed cannot go: it waits blocked (saying why) and the agent decides. Once the
	// failed one is skipped or replaced, it goes back to pending by itself.
	const failedKeys = new Set(steps.filter((s) => s.status === 'failed').map((s) => s.key));
	const stuck: string[] = [];
	for (const s of steps) {
		const bad = s.depends.filter((d) => failedKeys.has(d));
		if (s.status === 'pending' && bad.length) {
			await setStep(s, 'blocked', { note: `depende de ${bad.join(', ')}, que falló` });
			await event(id, 'step', `${s.key}: bloqueada, depende de ${bad.join(', ')}, que falló.`, s.key);
			stuck.push(`${s.key} (depende de ${bad.join(', ')})`);
		} else if (s.status === 'blocked' && s.note?.startsWith('depende de ') && !bad.length)
			await exec("update flow_steps set status = 'pending', note = null where id = $1", [s.id]);
	}
	steps = await stepsOf(id);
	const done = new Set(steps.filter((s) => finished(s.status)).map((s) => s.key));
	const removed = new Set(
		(await rows<{ key: string }>("select key from flow_steps where flow_id = $1 and status = 'removed'", [id])).map(
			(s) => s.key,
		),
	);
	// The agent's tasks go one at a time: the one in progress is the one it does (a blocked one lets the next go).
	let busy = steps.some((s) => s.status === 'working');
	for (const s of steps) {
		if (s.status !== 'pending' || !s.depends.every((d) => done.has(d) || removed.has(d))) continue;
		if (s.kind === 'agent' || s.kind === 'subagent') {
			if (busy) continue;
			busy = true;
			await setStep(s, 'working');
			assigned.push(s);
		} else if (s.kind === 'wait') {
			const persona = s.spec.persona;
			const until = persona
				? s.spec.hours
					? new Date(now.getTime() + s.spec.hours * 3600_000)
					: null
				: new Date(now.getTime() + (s.spec.hours ?? 1) * 3600_000);
			await exec("update flow_steps set status = 'waiting', until = $2, started_at = now() where id = $1", [
				s.id,
				until,
			]);
			await event(
				id,
				'step',
				persona
					? `${s.key}: espera la respuesta de ${persona.name}${until ? ` hasta ${when(until)}` : ''}.`
					: `${s.key}: espera hasta ${when(until!)}.`,
				s.key,
			);
		} else if (s.kind === 'question') {
			// Its owner reads what the agent writes for them, short and with its files; a recipe's step says
			// what to ask, not how: the agent writes it (task_ask with the task).
			if (s.spec.question) await sendQuestion(f, s);
			else {
				await setStep(s, 'working', {
					note: 'redacta la pregunta con task_ask (esta tarea): breve, lo que tu dueño debe decidir, y adjunta el archivo si hace falta',
				});
				assigned.push((await stepsOf(id)).find((x) => x.id === s.id)!);
			}
		} else if (s.kind === 'delegation') {
			const e = s.spec.encargo;
			const used = (await row<{ n: number }>(
				'select count(*)::int as n from delegations d join flow_steps x on x.id = d.flow_step_id where x.flow_id = $1',
				[id],
			))!.n;
			const unresolved =
				!e || !e.contacto || Object.values(e.parametros).some((v) => !v || /\{[a-z][a-z0-9_]*\}/.test(v));
			if (used >= budget(f).delegations || unresolved) {
				await setStep(s, 'working', {
					note:
						used >= budget(f).delegations
							? `llegó al tope de ${budget(f).delegations} encargos de esta lista`
							: 'faltan el contacto o parámetros del encargo: complétalos con task_plan',
				});
				assigned.push((await stepsOf(id)).find((x) => x.id === s.id)!);
				continue;
			}
			const r = await delegations.startForFlow(f, s.id, {
				plantilla: e.plantilla,
				contacto: e.contacto,
				parametros: e.parametros,
				contexto: e.contexto,
			});
			if (r.ok) {
				await exec("update flow_steps set status = 'waiting', delegation_id = $2, started_at = now() where id = $1", [
					s.id,
					r.id,
				]);
				await event(id, 'delegation', `${s.key}: lanzó el encargo #${r.id} con ${r.contacto}.`, s.key, {
					delegation: r.id,
				});
			} else {
				await setStep(s, 'working', { note: `no se pudo lanzar el encargo: ${r.error}` });
				assigned.push((await stepsOf(id)).find((x) => x.id === s.id)!);
			}
		}
	}
	steps = await stepsOf(id);
	await waitingFor(f, steps);
	// A recipe's list with nothing left but optional tasks: the agent hands in its result.
	const open = steps.filter((s) => !finished(s.status) && !(s.spec.optional && s.status === 'pending'));
	const final = !!f.recipe && !open.length && !f.asked_final;
	if (final) await exec('update flows set asked_final = true where id = $1', [id]);
	if (!assigned.length && !final && !lapsed.length && !stuck.length) return none;
	if (!inRun)
		await wake(
			f,
			assigned,
			final,
			[
				lapsed.length
					? `Se acabó la espera de ${lapsed.join(', ')}. Decide: insiste, sigue sin su respuesta o cambia la lista.`
					: '',
				stuck.length
					? `No pueden seguir porque falló una tarea anterior: ${stuck.join(', ')}. Decide: reintenta con una tarea nueva (task_plan) y marca skipped la que falló, omítelas o cambia la lista.`
					: '',
			]
				.filter(Boolean)
				.join('\n'),
		);
	return { mine: assigned, final, stuck };
}

async function setStep(s: Step, status: StepStatus, extra: { note?: string; result?: unknown } = {}) {
	await exec(
		`update flow_steps set status = $2, note = coalesce($3, note), result = coalesce($4, result),
		   started_at = coalesce(started_at, now()), ended_at = case when $2 in ('done', 'skipped', 'failed') then now() else ended_at end
		 where id = $1`,
		[s.id, status, extra.note ?? null, extra.result === undefined ? null : JSON.stringify(extra.result)],
	);
}

/** Who it waits for now, in words (the web's header), and since when. */
async function waitingFor(f: Flow, steps: Step[]) {
	const who: string[] = [];
	for (const s of steps) {
		if (s.status === 'working') who.push('el agente');
		else if (s.status === 'blocked') who.push(`el agente (bloqueada: ${s.note ?? s.key})`);
		else if (s.status === 'waiting' && s.kind === 'question') who.push('tu respuesta');
		else if (s.status === 'waiting' && s.kind === 'wait' && s.spec.persona) who.push(s.spec.persona.name);
		else if (s.status === 'waiting' && s.kind === 'wait' && s.until) who.push(`la hora (${when(s.until)})`);
		else if (s.status === 'waiting' && s.kind === 'delegation' && s.delegation_id) {
			const d = await row<{ contact: string; waiting: boolean }>(
				'select contact, waiting from delegations where id = $1',
				[s.delegation_id],
			);
			who.push(
				d
					? `${d.contact} (encargo #${s.delegation_id}${d.waiting ? ', espera al agente' : ''})`
					: `encargo #${s.delegation_id}`,
			);
		}
	}
	const text = [...new Set(who)].join(' · ') || null;
	if (text !== f.waiting_for)
		await exec(
			'update flows set waiting_for = $2, waiting_since = case when $2::text is null then null else now() end, updated_at = now() where id = $1',
			[f.id, text],
		);
}

/** Into the flow's conversation: what is the agent's now, with the whole board. */
async function wake(f: Flow, assigned: Step[], final: boolean, extra = '') {
	const fresh = (await load(f.id))!;
	if (fresh.wakes >= budget(f).wakes) {
		await finish(fresh, 'failed', `llegó a su tope de ${budget(f).wakes} despertares`);
		return;
	}
	await exec('update flows set wakes = wakes + 1, updated_at = now() where id = $1', [f.id]);
	const asks = [
		...assigned.map((s) => `- ${s.key} (${s.kind}): ${s.spec.instructions}${s.note ? ` — ${s.note}` : ''}`),
		...(final
			? [
					'- Todas las tareas terminaron: entrega el resultado con task_update sin tarea, en la forma de «Debe producir».',
				]
			: []),
	];
	const text = `${extra ? `${extra}\n\n` : ''}${asks.length ? `Ahora te toca:\n${asks.join('\n')}\n\nHazlo y regístralo con task_update.\n\n` : ''}${await board(fresh)}`;
	await event(
		f.id,
		'wake',
		`Despertó al agente${asks.length ? `: ${[...assigned.map((s) => s.key), ...(final ? ['resultado'] : [])].join(', ')}` : ''}${extra ? ` (${extra.slice(0, 200)})` : ''}.`,
	);
	const m = { agentId: f.agent_id, source: 'flow' as const, text, dedupeKey: `flow-${f.id}-wake-${fresh.wakes + 1}` };
	try {
		await receive({ ...m, ...(f.conversation_id ? { conversationId: f.conversation_id } : {}) }, { routeNow: false });
	} catch (err) {
		if (!/Reabre/.test((err as Error).message)) throw err;
		await receive(m, { routeNow: false });
	}
}

/** The flow ends: its open steps and encargos stop; its owner hears how it went. */
async function finish(
	f: Flow,
	how: Exclude<FlowStatus, 'running'>,
	reason: string | null,
	result?: unknown,
	summary?: string | null,
) {
	const ended = await row(
		`update flows set status = $2, end_reason = $3, result = coalesce($4, result), summary = coalesce($5, summary),
		   waiting_for = null, waiting_since = null, ended_at = now(), updated_at = now() where id = $1 and status = 'running' returning id`,
		[f.id, how, reason, result === undefined ? null : JSON.stringify(result), summary ?? null],
	);
	if (!ended) return;
	for (const s of await stepsOf(f.id)) {
		if (s.kind === 'delegation' && s.status === 'waiting' && s.delegation_id)
			await delegations.end(s.delegation_id, 'cancelled', 'terminó su flujo');
		if (!finished(s.status) && s.status !== 'failed') await setStep(s, 'skipped', { note: 'terminó la lista' });
	}
	const label = { done: 'terminó', failed: 'falló', cancelled: 'se canceló', expired: 'venció' }[how];
	await event(
		f.id,
		'ended',
		`La lista ${label}${reason ? `: ${reason}` : ''}.${summary ? ` ${summary}` : ''}`,
		null,
		result === undefined ? undefined : { result },
	);
	// A recipe's end is news for its owner; a free list ends with its trabajo, which already says so.
	if (f.recipe)
		await (
			await import('./whatsapp')
		)
			.tellOwner(
				f.agent_id,
				`«${f.title}» (receta ${f.recipe.name}) ${label}${reason ? ` (${reason})` : ''}.${summary ? ` ${summary}` : ''} El detalle, en la web.`,
				null,
			)
			.catch(() => false);
}

// ---------- its encargos ----------

const stepOfDelegation = (delegationId: number) =>
	row<{ step_id: number; flow_id: number; key: string }>(
		'select x.id as step_id, x.flow_id, x.key from delegations d join flow_steps x on x.id = d.flow_step_id where d.id = $1',
		[delegationId],
	);

/** A message of a flow's encargo, in the saga. */
export async function delegationEvent(delegationId: number, text: string) {
	const s = await stepOfDelegation(delegationId);
	if (s) await event(s.flow_id, 'message', text, s.key, { delegation: delegationId });
}

/** A flow's encargo ended: its step takes the result, and the flow goes on. */
export async function delegationEnded(delegationId: number) {
	const s = await stepOfDelegation(delegationId);
	if (!s) return;
	// Ended because its flow did (finish holds the flow's turn): nothing to carry on.
	if ((await load(s.flow_id))?.status !== 'running') return;
	await serial(s.flow_id, async () => {
		const d = (await row<{
			status: string;
			data: unknown;
			summary: string | null;
			end_reason: string | null;
			contact: string;
		}>('select status, data, summary, end_reason, contact from delegations where id = $1', [delegationId]))!;
		const step = (await row<Step>('select * from flow_steps where id = $1', [s.step_id]))!;
		if (step.status !== 'waiting') return;
		const ok = d.status === 'done';
		await setStep(step, ok ? 'done' : 'failed', {
			result: { datos: d.data ?? null, resumen: d.summary },
			note: ok
				? undefined
				: `el encargo ${d.status === 'expired' ? 'venció' : d.status === 'cancelled' ? 'se canceló' : 'falló'}${d.end_reason ? `: ${d.end_reason}` : ''}`,
		});
		if (d.summary)
			await exec("insert into flow_facts (flow_id, source, text) values ($1, 'contact', $2)", [
				s.flow_id,
				`${d.contact}: ${d.summary}`,
			]);
		await event(
			s.flow_id,
			'step',
			`${s.key}: el encargo #${delegationId} ${ok ? 'terminó' : 'no terminó'}${d.summary ? ` — ${d.summary}` : ''}.`,
			s.key,
			{
				datos: d.data ?? null,
			},
		);
	});
	const f = await load(s.flow_id);
	if (!f || f.status !== 'running') return;
	const step = (await row<Step>('select * from flow_steps where id = $1', [s.step_id]))!;
	// A failed encargo is the agent's to decide: try another contact, skip it, or change the plan.
	if (step.status === 'failed')
		await serial(f.id, () =>
			wake(
				f,
				[],
				false,
				`La tarea ${s.key} falló (${step.note}). Decide: lanza otro encargo con task_plan, márcala skipped o cambia la lista.`,
			),
		);
	await advance(f.id);
}

/** A flow's encargo asks its agent something: it wakes with the question and the board. */
export async function delegationEscalated(delegationId: number, question: string) {
	const s = await stepOfDelegation(delegationId);
	if (!s) return;
	const f = await load(s.flow_id);
	if (!f || f.status !== 'running') return;
	await event(f.id, 'escalated', `El encargo #${delegationId} (${s.key}) pregunta: ${question}`, s.key);
	await serial(f.id, async () => {
		await waitingFor(f, await stepsOf(f.id));
		await wake(
			f,
			[],
			false,
			`El encargo #${delegationId} de la tarea ${s.key} te pregunta: ${question}\nContéstale con delegation_message (id ${delegationId}).`,
		);
	});
}

// ---------- its owner, from the web ----------

/** The owner answers a question of the flow (the web's answer box). */
export async function answer(agentId: number, flowId: number, key: string, text: string) {
	const f = await row<Flow>("select * from flows where id = $1 and agent_id = $2 and status = 'running'", [
		flowId,
		agentId,
	]);
	if (!f) throw new Error('Ese flujo no está corriendo.');
	const s = await row<Step>(
		"select * from flow_steps where flow_id = $1 and key = $2 and kind = 'question' and status = 'waiting'",
		[flowId, key],
	);
	if (!s) throw new Error('Esa pregunta ya no espera respuesta.');
	const said = text.trim().slice(0, 2000);
	if (!said) throw new Error('Escribe tu respuesta.');
	await serial(flowId, async () => {
		await setStep(s, 'done', { result: { respuesta: said } });
		await exec("insert into flow_facts (flow_id, source, text) values ($1, 'owner', $2)", [
			flowId,
			`${s.spec.question ?? s.spec.instructions} → ${said}`.slice(0, 1000),
		]);
		await event(flowId, 'answer', `Respondiste: ${said}`, key);
	});
	// The answer is the agent's to act on even when no step becomes ready (a failed one may block the rest).
	const turn = await advance(flowId);
	const fresh = await load(flowId);
	if (!turn.mine.length && !turn.final && fresh?.status === 'running')
		await serial(flowId, () =>
			wake(
				fresh,
				[],
				false,
				`Tu dueño respondió a «${(s.spec.question ?? s.spec.instructions).slice(0, 300)}»: ${said}`,
			),
		);
}

/** The owner stops it from the web. */
export async function stop(agentId: number, flowId: number) {
	const f = await row<Flow>("select * from flows where id = $1 and agent_id = $2 and status = 'running'", [
		flowId,
		agentId,
	]);
	if (!f) throw new Error('Ese flujo no está corriendo.');
	await serial(flowId, () => finish(f, 'cancelled', 'lo detuvo su dueño'));
}

/**
 * Its owner changes the list from the web: adds a task, marks one done or skipped, reopens or removes it.
 * The agent hears it as an instruction (a wake with the change and the list).
 */
export async function ownerEdit(
	agentId: number,
	conversationId: number,
	input: { op?: unknown; tarea?: unknown; titulo?: unknown; instrucciones?: unknown },
) {
	const c = await row<Trabajo>(
		'select id, is_default, status, goal from conversations where id = $1 and agent_id = $2 and deleted_at is null',
		[conversationId, agentId],
	);
	if (!c) throw new Error('Ese trabajo no es de este agente.');
	if (c.is_default) throw new Error('La conversación Principal no es un trabajo: no tiene tareas.');
	if (c.status !== 'open') throw new Error('Este trabajo ya terminó: reábrelo para cambiar sus tareas.');
	const op = String(input.op ?? '');
	if (!['add', 'done', 'skip', 'reopen', 'remove'].includes(op)) throw new Error('Cambio de tarea desconocido.');
	let f = await listOf(c.id);
	if (!f) {
		if (op !== 'add') throw new Error('Este trabajo no tiene tareas.');
		const a = (await row<{ agent_id: number; harness: unknown }>(
			'select id as agent_id, harness from agents where id = $1',
			[agentId],
		))!;
		const made = await create(a, c, null, {}, clock.now());
		if ('error' in made) throw new Error(made.error);
		f = (await load(made.id))!;
	}
	const list = f;
	const said = await serial(list.id, async () => {
		const steps = await stepsOf(list.id);
		if (op === 'add') {
			const title = String(input.titulo ?? '')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, 120);
			if (!title) throw new Error('Escribe la tarea.');
			if (steps.length >= MAX_STEPS) throw new Error(`Una lista tiene hasta ${MAX_STEPS} tareas.`);
			const base =
				title
					.normalize('NFD')
					.replace(/[̀-ͯ]/g, '')
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, '-')
					.replace(/^-|-$/g, '')
					.slice(0, 30) || 'tarea';
			const all = await rows<{ key: string }>('select key from flow_steps where flow_id = $1', [list.id]);
			let key = base;
			for (let i = 2; all.some((x) => x.key === key); i++) key = `${base}-${i}`;
			const instructions =
				String(input.instrucciones ?? '')
					.trim()
					.slice(0, 1000) || title;
			await insertStep(list.id, Math.max(-1, ...steps.map((x) => x.position)) + 1, {
				key,
				title,
				kind: 'agent',
				depends: [],
				spec: { instructions, optional: false, hours: null, encargo: null, by: 'owner' },
			});
			await event(list.id, 'owner', `Tu dueño agregó «${title}».`, key);
			return `agregó la tarea «${title}» (${key})`;
		}
		const s = steps.find((x) => x.key === String(input.tarea ?? ''));
		if (!s) throw new Error('Esa tarea ya no está en la lista.');
		if (op === 'done' || op === 'skip') {
			if (finished(s.status)) throw new Error('Esa tarea ya terminó.');
			const status: StepStatus = op === 'done' ? 'done' : 'skipped';
			await setStep(s, status, { note: op === 'done' ? 'la marcó hecha tu dueño' : 'la omitió tu dueño' });
			if (s.kind === 'delegation' && s.status === 'waiting' && s.delegation_id)
				await delegations.end(s.delegation_id, 'cancelled', 'la cerró su dueño');
			await event(list.id, 'owner', `Tu dueño marcó «${s.title}» como ${op === 'done' ? 'hecha' : 'omitida'}.`, s.key);
			return `marcó «${s.title}» (${s.key}) como ${op === 'done' ? 'hecha' : 'omitida'}`;
		}
		if (op === 'reopen') {
			if (!['done', 'skipped', 'failed', 'blocked'].includes(s.status)) throw new Error('Esa tarea sigue abierta.');
			await exec(
				"update flow_steps set status = 'pending', note = null, ended_at = null, until = null, delegation_id = null where id = $1",
				[s.id],
			);
			// A reopened task asks for the result again when the list ends.
			await exec('update flows set asked_final = false where id = $1', [list.id]);
			await event(list.id, 'owner', `Tu dueño reabrió «${s.title}».`, s.key);
			return `reabrió «${s.title}» (${s.key})`;
		}
		if (!['pending', 'working', 'blocked'].includes(s.status))
			throw new Error('Esa tarea ya empezó o terminó: márcala hecha u omitida.');
		if (steps.some((x) => x.key !== s.key && x.depends.includes(s.key) && !finished(x.status)))
			throw new Error('Otras tareas van después de esta: quítalas o ciérralas primero.');
		await exec("update flow_steps set status = 'removed', ended_at = now() where id = $1", [s.id]);
		await event(list.id, 'owner', `Tu dueño quitó «${s.title}».`, s.key);
		return `quitó «${s.title}» (${s.key})`;
	});
	// The agent hears it as an instruction: one wake with the change, what is its now, and the list.
	const turn = await serial(list.id, () => pass(list.id, true));
	const fresh = await load(list.id);
	if (fresh?.status === 'running')
		await serial(list.id, () =>
			wake(fresh, turn.mine, turn.final, `Tu dueño cambió tus tareas: ${said}. Tómalo como instrucción.`),
		);
	return tasksOf(agentId, c.id);
}

// ---------- people it waits for ----------

/** A wait for this person's reply in one of the agent's open trabajos: where their message lands. */
/** The wait of a task for this person's reply, if any; a simulated reply only answers a simulated wait. */
export async function waitingOn(agentId: number, numberId: number, phone: string, simulated = false) {
	return row<{ step_id: number; flow_id: number; conversation_id: number; key: string; name: string }>(
		`select s.id as step_id, f.id as flow_id, f.conversation_id, s.key, s.spec->'persona'->>'name' as name
		 from flow_steps s join flows f on f.id = s.flow_id join conversations c on c.id = f.conversation_id
		 where f.agent_id = $1 and f.status = 'running' and s.status = 'waiting' and s.kind = 'wait'
		   and (s.spec->'persona'->>'number')::bigint = $2 and s.spec->'persona'->>'phone' = $3
		   and coalesce((s.spec->'persona'->>'sim')::boolean, false) = $4
		   and c.status = 'open' and c.deleted_at is null
		 order by s.started_at, s.id limit 1`,
		[agentId, numberId, phone, simulated],
	);
}

/** Their reply came (it lands in the trabajo as a message, which wakes the agent there): the wait is over. */
export async function heard(
	w: { step_id: number; flow_id: number; key: string; name: string },
	text: string,
): Promise<void> {
	await serial(w.flow_id, async () => {
		const s = await row<Step>('select * from flow_steps where id = $1', [w.step_id]);
		if (!s || s.status !== 'waiting') return;
		const said = text.trim().slice(0, 2000);
		await setStep(s, 'done', { result: { respuesta: said, de: w.name } });
		await exec("insert into flow_facts (flow_id, source, text) values ($1, 'contact', $2)", [
			w.flow_id,
			`${w.name}: ${said}`.slice(0, 1000),
		]);
		await event(w.flow_id, 'answer', `${w.name} respondió: ${said.slice(0, 300)}`, w.key);
	});
	await advance(w.flow_id, { inRun: true });
}

// ---------- its trabajo ----------

/** What job_done needs: the tasks still open, and whether a recipe's result is still to hand in. */
export async function openTasks(conversationId: number) {
	const f = await listOf(conversationId);
	if (!f) return { open: [] as Step[], result: false };
	const open = (await stepsOf(f.id)).filter(
		(s) => !finished(s.status) && s.status !== 'failed' && !(s.spec.optional && s.status === 'pending'),
	);
	return { open, result: !!f.recipe };
}

/** Its trabajo ended: the list ends with it, done when nothing was left open. */
export async function endWithJob(conversationId: number) {
	const f = await listOf(conversationId);
	if (!f) return;
	const { open } = await openTasks(conversationId);
	await serial(f.id, () =>
		finish(f, open.length ? 'cancelled' : 'done', open.length ? 'terminó su trabajo con tareas abiertas' : null),
	);
}

/** A trabajo's list for the web: its latest (running or not), its tasks, and whether its owner may edit it. */
export async function tasksOf(agentId: number, conversationId: number) {
	const f = await row<Flow>(
		"select * from flows where agent_id = $1 and conversation_id = $2 order by (status = 'running') desc, id desc limit 1",
		[agentId, conversationId],
	);
	if (!f) return { list: null, tasks: [] as Step[] };
	return { list: f, tasks: await stepsOf(f.id) };
}

// ---------- the web ----------

export async function list(agentId: number) {
	return rows<{
		id: number;
		title: string;
		recipe: string | null;
		conversation_id: number | null;
		status: FlowStatus;
		waiting_for: string | null;
		waiting_since: string | null;
		created_at: string;
		ended_at: string | null;
		steps: number;
		done: number;
	}>(
		`select f.id, f.title, f.recipe->>'name' as recipe, f.conversation_id, f.status, f.waiting_for, f.waiting_since, f.created_at, f.ended_at,
		   (select count(*)::int from flow_steps s where s.flow_id = f.id and s.status <> 'removed') as steps,
		   (select count(*)::int from flow_steps s where s.flow_id = f.id and s.status in ('done', 'skipped')) as done
		 from flows f where f.agent_id = $1 order by f.id desc limit 100`,
		[agentId],
	);
}

/** One flow with its steps (removed ones too, for the canvas' history), saga and facts. */
export async function detail(agentId: number, flowId: number, after = 0) {
	const f = await row<Flow>('select * from flows where id = $1 and agent_id = $2', [flowId, agentId]);
	if (!f) return null;
	const [steps, events, facts] = await Promise.all([
		rows<Step>('select * from flow_steps where flow_id = $1 order by position, id', [flowId]),
		rows<{ id: number; step_key: string | null; kind: string; text: string; data: unknown; at: string }>(
			'select id, step_key, kind, text, data, at from flow_events where flow_id = $1 and id > $2 order by id limit 1000',
			[flowId, after],
		),
		rows<{ source: string; text: string; at: string }>(
			'select source, text, at from flow_facts where flow_id = $1 order by id',
			[flowId],
		),
	]);
	return { flow: f, steps, events, facts };
}

// ---------- the sweeper ----------

/** Deadlines, waits that are over, and the agent's steps nobody took (a work that ended without them). */
export async function sweep() {
	for (const f of await rows<{ id: number }>("select id from flows where status = 'running'")) await advance(f.id);
	for (const f of await rows<Flow>(
		`select f.* from flows f where f.status = 'running' and f.updated_at < now() - interval '15 minutes'
		   and exists (select 1 from flow_steps s where s.flow_id = f.id and s.status = 'working')
		   and not exists (select 1 from runs r where r.agent_id = f.agent_id and r.status in ('queued', 'starting', 'running', 'blocked'))`,
	)) {
		const pending = (await stepsOf(f.id)).filter((s) => s.status === 'working');
		await serial(f.id, () => wake(f, pending, false, 'Sigues teniendo una tarea en curso en este trabajo.'));
	}
	// A list nothing moves: open tasks, but none in progress and nobody waited for (no wait, question or encargo),
	// and its agent idle for 15 minutes.
	for (const f of await rows<Flow>(
		`select f.* from flows f where f.status = 'running' and f.updated_at < now() - interval '15 minutes'
		   and exists (select 1 from flow_steps s where s.flow_id = f.id and s.status in ('blocked', 'pending'))
		   and not exists (select 1 from flow_steps s where s.flow_id = f.id and s.status in ('working', 'waiting'))
		   and not exists (select 1 from runs r where r.agent_id = f.agent_id and r.status in ('queued', 'starting', 'running', 'blocked'))`,
	))
		await serial(f.id, () => stalled(f));
}

/** What a continuation says (after Codex's goal continuation, adapted): keep going, and prove it. */
const CONTINUE = (goal: string | null) =>
	[
		`Sigue con tu trabajo hasta cumplir su objetivo${goal ? `: «${goal}»` : ''}.`,
		'Antes de terminar este turno, clasifícalo: avance (hiciste algo y lo registraste en la lista), espera verificada (dejaste viva una espera, una pregunta o un encargo que te despertará) o sin avance. Repetir el estado o planear sin hacer no es avance. No termines el turno sin una de estas: avanzar una tarea, dejar algo vivo que te despierte, o terminar el trabajo con job_done (un auditor lo revisa contra el objetivo).',
		'Las decisiones reversibles tómalas tú con la opción más razonable y dilo; pregunta sólo lo que tu contrato reserva a tu dueño (request_help o task_ask, con opciones y tu recomendación).',
	].join('\n');

/**
 * Modo objetivo (Angel 10-nov-2026): after each turn of a trabajo with a list, the platform keeps it going. It
 * counts whether the turn moved the list; if something live will wake it (a wait, a question, an encargo, a
 * message) it lets it sleep; at its budget its owner hears; three autonomous turns without progress stall it;
 * otherwise it continues it right away (its tasks, or closing it), or asks it to ask for what it needs.
 */
export async function afterRun(runId: number) {
	const r = await row<{
		agent_id: number;
		conversation_id: number;
		status: string;
		kind: string;
		started_at: number | null;
		ended_at: number | null;
		autonomous: boolean;
	}>(
		`select r.agent_id, r.conversation_id, r.status, r.kind, r.started_at, r.ended_at,
		   coalesce((select m.source = 'flow' from messages m where m.run_id = r.id order by m.id limit 1), false) as autonomous
		 from runs r where r.id = $1`,
		[runId],
	);
	if (!r || r.kind !== 'task' || !['done', 'incomplete'].includes(r.status)) return;
	const c = await row<{
		is_default: boolean;
		status: string;
		goal: string | null;
		budget_usd: number;
		budget_turns: number;
		budget_noticed_at: number | null;
	}>('select is_default, status, goal, budget_usd, budget_turns, budget_noticed_at from conversations where id = $1', [
		r.conversation_id,
	]);
	if (!c || c.is_default || c.status !== 'open') return;
	if (!(await row('select 1 from agents where id = $1 and goal_mode', [r.agent_id]))) return; // its switch is off
	// With an objective but no list yet: the list starts with that objective, for the agent to break it down.
	const f =
		(await row<Flow>("select * from flows where conversation_id = $1 and status = 'running'", [r.conversation_id])) ??
		(c.goal ? await objectiveList(r.agent_id, r.conversation_id, c.goal) : null);
	if (!f) return; // without an objective nor a list, whoever asked drives it
	return serial(f.id, async () => {
		// Progress: the turn changed its list (an autonomous turn that did not, counts against it).
		const moved = !!(await row(
			`select 1 from flow_events where flow_id = $1 and kind not in ('wake', 'idle')
			   and at >= to_timestamp($2::double precision / 1000) and at <= to_timestamp($3::double precision / 1000) + interval '5 seconds'`,
			[f.id, r.started_at ?? 0, r.ended_at ?? Date.now()],
		));
		const idle = (await row<{ n: number }>(
			`update conversations set idle_turns = case when $2 then 0 when $3 then idle_turns + 1 else 0 end
			 where id = $1 returning idle_turns as n`,
			[r.conversation_id, moved, r.autonomous],
		))!.n;
		if (
			await row("select 1 from runs where agent_id = $1 and status in ('queued', 'starting', 'running', 'blocked')", [
				f.agent_id,
			])
		)
			return; // it works on something else now: its end comes back here
		const steps = await stepsOf(f.id);
		// A verified wait: something live wakes it when it changes.
		const live =
			steps.some((s) => s.status === 'waiting') ||
			!!(await row(
				`select 1 from delegations where conversation_id = $1 and status = 'active'
				 union all select 1 from messages where conversation_id = $1 and run_id is null and routed_at is null limit 1`,
				[r.conversation_id],
			));
		if (live) return;
		// Its budget (autonomous turns and cost of the trabajo): once reached, its owner hears, once.
		const spent = (await row<{ usd: number; turns: number }>(
			`select coalesce(sum(cost), 0)::float as usd,
			   count(*) filter (where exists (select 1 from messages m where m.run_id = r.id and m.source = 'flow'))::int as turns
			 from runs r where r.conversation_id = $1`,
			[r.conversation_id],
		))!;
		if (spent.usd >= Number(c.budget_usd) || spent.turns >= c.budget_turns) {
			if (c.budget_noticed_at) return;
			await exec('update conversations set budget_noticed_at = now() where id = $1', [r.conversation_id]);
			const open = steps.filter((s) => !finished(s.status) && s.status !== 'removed');
			await event(
				f.id,
				'idle',
				`Llegó a su presupuesto ($${spent.usd.toFixed(2)} de $${Number(c.budget_usd).toFixed(2)}, ${spent.turns} de ${c.budget_turns} turnos): ya no sigue solo.`,
				null,
				{ level: 2, budget: true },
			);
			await (
				await import('./whatsapp')
			)
				.tellOwner(
					f.agent_id,
					`El trabajo #${r.conversation_id} llegó a su presupuesto ($${spent.usd.toFixed(2)} de $${Number(c.budget_usd).toFixed(2)}, ${spent.turns} de ${c.budget_turns} turnos sin ti). Falta: ${open.map((s) => s.title).join('; ') || 'cerrarlo'}. Si quieres que siga, súbele el presupuesto en su página o dime cómo sigo.`,
					r.conversation_id,
				)
				.catch(() => false);
			return;
		}
		// Three autonomous turns without progress: stalled (its owner hears, once).
		if (idle >= 3) return stalled(f, true);
		const open = steps.filter((s) => !finished(s.status) && s.status !== 'removed');
		const working = steps.filter((s) => s.status === 'working' && (s.kind === 'agent' || s.kind === 'subagent'));
		if (working.length) return wake(f, working, false, CONTINUE(c.goal));
		if (!open.length) {
			if (f.recipe && !f.asked_final) return; // pass() asks it for the recipe's result
			return wake(
				f,
				[],
				false,
				`${CONTINUE(c.goal)}\nTodas las tareas terminaron: si el objetivo se cumplió, termina el trabajo con job_done; si falta algo, agrégalo con task_plan.`,
			);
		}
		// Open tasks, none of them its own now nor waited for: the first time, it asks for what it needs.
		const p = await pass(f.id, false);
		if (p.mine.length || p.final) return; // pass() woke it with its tasks
		return stalled(f);
	});
}

/**
 * Modo objetivo: a trabajo with an objective and no list gets one, with a single task of the agent's (meet the
 * objective, breaking it down first). /goal does it too.
 */
export async function objectiveList(agentId: number, conversationId: number, goal: string) {
	const running = () =>
		row<Flow>("select * from flows where conversation_id = $1 and status = 'running'", [conversationId]);
	const existing = await running();
	if (existing) return existing;
	const f = await row<Flow>(
		`insert into flows (agent_id, conversation_id, recipe, params, title, deadline)
		 values ($1, $2, null, '{}', $3, now() + interval '14 days') returning *`,
		[agentId, conversationId, goal.slice(0, 80)],
	).catch((err) => {
		if ((err as { code?: string }).code === '23505') return null; // another one just started it
		throw err;
	});
	if (!f) return running();
	await insertStep(f.id, 0, {
		key: 'objetivo',
		title: 'Cumplir el objetivo del trabajo',
		kind: 'agent',
		depends: [],
		spec: {
			instructions: `Desglosa este objetivo en tareas (task_plan, con motivo) y cúmplelas: «${goal.slice(0, 900)}». Marca esta tarea done cuando tu lista lo cubra.`,
			optional: false,
			hours: null,
			encargo: null,
		},
	});
	await event(f.id, 'started', 'Empezó la lista con el objetivo del trabajo (modo objetivo).');
	return f;
}

/** Its owner raised its budget: if it was standing still with tasks of its own, it goes on. */
export async function resume(conversationId: number) {
	const f = await row<Flow>("select * from flows where conversation_id = $1 and status = 'running'", [conversationId]);
	if (!f) return;
	if (
		await row("select 1 from runs where agent_id = $1 and status in ('queued', 'starting', 'running', 'blocked')", [
			f.agent_id,
		])
	)
		return;
	const goal =
		(await row<{ goal: string | null }>('select goal from conversations where id = $1', [conversationId]))?.goal ??
		null;
	await serial(f.id, async () => {
		const working = (await stepsOf(f.id)).filter(
			(s) => s.status === 'working' && (s.kind === 'agent' || s.kind === 'subagent'),
		);
		if (working.length) await wake(f, working, false, CONTINUE(goal));
		else await pass(f.id, false);
	});
}

/**
 * A stalled list (Angel 10-nov-2026): the first time, its agent is woken to ask whoever it needs (or to solve it,
 * or change the list); if it is still stalled after that, its owner hears by WhatsApp what is stuck. Then it
 * waits for someone to move it.
 */
async function stalled(f: Flow, noProgress = false) {
	const last = await row<{ kind: string; data: { level?: number } | null }>(
		'select kind, data from flow_events where flow_id = $1 order by id desc limit 1',
		[f.id],
	);
	// Three turns without progress already were its chances: straight to its owner.
	const level = noProgress
		? Math.max(1, last?.kind === 'idle' ? (last.data?.level ?? 1) : 1)
		: last?.kind === 'idle'
			? (last.data?.level ?? 1)
			: 0;
	if (level >= 2) return;
	const blocked = (await stepsOf(f.id))
		.filter((s) => s.status === 'blocked')
		.map((s) => `${s.title}${s.note ? ` (${s.note.slice(0, 200)})` : ''}`);
	const what = blocked.length ? blocked.join('; ') : 'sus tareas pendientes dependen de otras que no avanzan';
	if (level === 0) {
		await wake(
			f,
			[],
			false,
			`Tu lista quedó detenida: no hay tareas tuyas en curso ni nada que espere a alguien (ninguna espera, pregunta ni encargo pendiente). Bloqueado: ${what}.\nNo la dejes así. Si necesitas algo de alguien, pídeselo ahora: a tu dueño con task_ask (o request_help con para: dueño), a otra persona con una espera (wait con persona) o con un encargo. Si lo puedes resolver tú, hazlo. Si ya no hace falta, ajusta la lista (task_plan) o termina el trabajo.`,
		);
		await event(
			f.id,
			'idle',
			'Lista detenida: nada la movía; despertó al agente para que pida lo que necesita.',
			null,
			{
				level: 1,
			},
		);
		return;
	}
	const told = await (
		await import('./whatsapp')
	)
		.tellOwner(
			f.agent_id,
			`La lista del trabajo #${f.conversation_id} quedó detenida y no he podido moverla. Está bloqueado: ${what}. ¿Cómo sigo?`,
			f.conversation_id,
		)
		.catch(() => false);
	await event(
		f.id,
		'idle',
		`Lista detenida otra vez: ${told ? 'le avisó al dueño por WhatsApp' : 'no se pudo avisar al dueño por WhatsApp'}.`,
		null,
		{ level: 2 },
	);
	await exec('update flows set updated_at = now() where id = $1', [f.id]);
}

let sweeper: ReturnType<typeof setInterval> | null = null;
export function startSweeper() {
	sweeper ??= setInterval(() => void sweep().catch((err) => console.error('flujos:', (err as Error).message)), 60_000);
	sweeper.unref?.();
}

// ---------- simulación ----------

/**
 * Pagos simulados: the browser intercepted a payment in a turn (a click, or a request it blocked) and showed
 * the agent a confirmation. What happened, for people: the line for the run's activity, and the list's saga.
 */
export async function simulated(
	runId: number,
	input: { action?: unknown; label?: unknown; total?: unknown; order?: unknown; how?: unknown },
) {
	const label = String(input.label ?? '').slice(0, 120);
	const total = String(input.total ?? '').slice(0, 40);
	const order = String(input.order ?? '').slice(0, 20);
	const text = `Pago simulado${input.how === 'network' ? ' (bloqueó la petición de pago)' : ''}: «${label || 'pago'}»${total ? ` por ${total}` : ''}. No se cobró nada; el agente vio la confirmación${order ? ` del pedido #${order}` : ''} como si hubiera pagado.`;
	const f = await row<{ id: number }>(
		"select f.id from runs r join flows f on f.conversation_id = r.conversation_id where r.id = $1 and f.status = 'running'",
		[runId],
	);
	if (f) await event(f.id, 'simulated', text, null, { action: String(input.action ?? '').slice(0, 300) });
	return text;
}
