// Memoria (Angel 9-nov-2026): what an agent knows from one trabajo to the next. Each trabajo is its own
// conversation, so without this an agent forgets its owner's preferences, the people and places it deals with
// and what it learned to do. The agent saves, searches and forgets with platform tools (mem_save, mem_search,
// mem_forget); its owner sees, corrects, pins and deletes from the web. Per agent.
//
// Model and protocol after Engram (Gentleman Programming, MIT): a memory has a kind and, optionally, a stable
// topic; saving to the same topic updates it (keeping its earlier versions) instead of piling up duplicates.
// Every work starts with the pinned and most recent memories in its prompt (block); the rest, by search.
import { row, rows, exec, tx, type Exec } from './db';

export const KINDS = {
	preference: 'preferencia',
	person: 'persona',
	place: 'lugar',
	procedure: 'procedimiento',
	fact: 'dato',
	decision: 'decisión',
} as const;
export type Kind = keyof typeof KINDS;
/** By its Spanish name too (what the agent sees and writes). */
const KIND_OF: Record<string, Kind> = Object.fromEntries(
	Object.entries(KINDS).flatMap(([k, es]) => [
		[k, k as Kind],
		[es, k as Kind],
		[es.normalize('NFD').replace(/\p{M}/gu, ''), k as Kind],
	]),
);

/** Live memories an agent keeps; past it, it forgets what it no longer needs. */
export const MAX_MEMORIES = 500;
/** What every work starts with: pinned first, then the most recently used or changed (characters). */
const BLOCK_BUDGET = 4000;

export type Memory = {
	id: number;
	kind: Kind;
	topic: string | null;
	title: string;
	content: string;
	source: 'agent' | 'owner';
	pinned: boolean;
	revisions: number;
	conversation_id: number | null;
	created_at: number;
	updated_at: number;
	used_at: number | null;
};
const COLS =
	'id, kind, topic, title, content, source, pinned, revisions, conversation_id, created_at, updated_at, used_at';

type Reply = { ok: boolean; error?: string; [k: string]: unknown };

/** The time, for tests. */
export const clock = { now: () => new Date() };

// Secrets never go to memory: they live in Accesos and the vault. A rough net for the obvious ones; the
// protocol in the prompt is the rule.
const SECRET = [
	/\b(?:\d[ -]?){13,19}\b/, // a card number
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/, // API keys
	/\b(?:ghp|gho|github_pat|xox[abp]|AKIA)[A-Za-z0-9_]{12,}/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\b(?:contraseña|password|passwd|pwd|cvv|cvc|nip|pin)\s*[:=]\s*\S+/i,
];
const luhn = (digits: string) => {
	let sum = 0;
	for (let i = 0; i < digits.length; i++) {
		let d = Number(digits[digits.length - 1 - i]);
		if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
		sum += d;
	}
	return sum % 10 === 0;
};
export function secretIn(text: string) {
	for (const re of SECRET) {
		const m = text.match(re);
		if (!m) continue;
		// A long number is a card only if it passes Luhn (phone numbers and order ids do not).
		if (re === SECRET[0] && !luhn(m[0].replace(/\D/g, ''))) continue;
		return true;
	}
	return false;
}

/** Words for search, without accents: «leche deslactosada» → leche:* | deslactosada:*. */
function words(q: string) {
	return [
		...new Set(
			q
				.normalize('NFD')
				.replace(/\p{M}/gu, '')
				.toLowerCase()
				.match(/[a-z0-9]{2,}/g) ?? [],
		),
	].slice(0, 10);
}

const clean = (v: unknown, max: number) =>
	String(v ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max);
const cleanBody = (v: unknown, max: number) =>
	String(v ?? '')
		.trim()
		.slice(0, max);
const topicOf = (v: unknown) => {
	if (v === undefined || v === null || v === '') return null;
	const t = String(v).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, '-');
	return /^[a-z0-9][a-z0-9/_-]{0,79}$/.test(t) ? t : undefined;
};

/** The run that calls a tool: its agent and the trabajo it works on. */
async function caller(runId: number) {
	return row<{ agent_id: number; conversation_id: number | null }>(
		`select a.id as agent_id, r.conversation_id
		 from runs r join agents a on a.id = r.agent_id where r.id = $1 and a.deleted_at is null`,
		[runId],
	);
}

/** One line for the agent: #id [kind · topic] title: content. */
function line(m: Memory, full = true) {
	const head = `#${m.id} [${KINDS[m.kind]}${m.topic ? ` · ${m.topic}` : ''}] ${m.title}`;
	const by = m.source === 'owner' ? ' (lo escribió tu dueño)' : '';
	return `${head}${by}: ${full ? m.content : m.content.slice(0, 300) + (m.content.length > 300 ? '…' : '')}`;
}

/** Keeps what a memory said before it changes. */
async function revise(m: Memory, by: 'agent' | 'owner', on: Exec) {
	await exec(
		'insert into memory_revisions (memory_id, title, content, source, changed_by) values ($1, $2, $3, $4, $5)',
		[m.id, m.title, m.content, m.source, by],
		on,
	);
}

type Input = { kind: Kind; topic: string | null; title: string; content: string };
/** Checks what the agent or its owner wants to save; a string is the reason it cannot. */
function input(args: Record<string, unknown>, partial = false): Input | string {
	const kind = KIND_OF[String(args.tipo ?? args.kind ?? '').toLowerCase()];
	const topic = topicOf(args.tema ?? args.topic);
	const title = clean(args.titulo ?? args.title, 120);
	const content = cleanBody(args.contenido ?? args.content, 2000);
	if (!kind && !partial) return `tipo: uno de ${Object.values(KINDS).join(', ')}.`;
	if (topic === undefined)
		return 'tema: una clave corta en minúsculas, con / para agrupar (p. ej. «super/leche», «contacto/cortez»).';
	if (!partial && !title) return 'Falta el título.';
	if (!partial && !content) return 'Falta el contenido.';
	if (secretIn(`${title}\n${content}`))
		return 'Eso parece un secreto (contraseña, tarjeta, clave o token): no va en la memoria. Las credenciales viven en los accesos de tu dueño.';
	return { kind: kind!, topic, title, content };
}

/** mem_save: a new memory, or a change to one (by id or by its topic). */
async function save(runId: number, args: Record<string, unknown>): Promise<Reply> {
	const a = await caller(runId);
	if (!a) return { ok: false, error: 'El trabajo ya no existe.' };
	const id = args.id === undefined || args.id === null || args.id === '' ? null : Number(args.id);
	const v = input(args, id !== null);
	if (typeof v === 'string') return { ok: false, error: v };
	return tx(async (c) => {
		const existing = id
			? await row<Memory>(
					`select ${COLS} from memories where id = $1 and agent_id = $2 and deleted_at is null for update`,
					[id, a.agent_id],
					c,
				)
			: v.topic
				? await row<Memory>(
						`select ${COLS} from memories where agent_id = $1 and topic = $2 and deleted_at is null for update`,
						[a.agent_id, v.topic],
						c,
					)
				: null;
		if (id && !existing) return { ok: false, error: `No tienes la memoria #${id}.` };
		if (existing) {
			const next = {
				kind: v.kind ?? existing.kind,
				topic: v.topic ?? existing.topic,
				title: v.title || existing.title,
				content: v.content || existing.content,
			};
			if (next.title === existing.title && next.content === existing.content && next.kind === existing.kind)
				return { ok: true, id: existing.id, accion: 'sin cambios', memoria: line(existing) };
			if (
				next.topic !== existing.topic &&
				next.topic &&
				(await row(
					'select 1 from memories where agent_id = $1 and topic = $2 and deleted_at is null and id <> $3',
					[a.agent_id, next.topic, existing.id],
					c,
				))
			)
				return { ok: false, error: `Ya hay otra memoria con el tema ${next.topic}: actualiza ésa.` };
			await revise(existing, 'agent', c);
			const m = (await row<Memory>(
				`update memories set kind = $2, topic = $3, title = $4, content = $5, source = 'agent', run_id = $6,
				   conversation_id = coalesce($7, conversation_id), revisions = revisions + 1, updated_at = $8
				 where id = $1 returning ${COLS}`,
				[existing.id, next.kind, next.topic, next.title, next.content, runId, a.conversation_id, clock.now()],
				c,
			))!;
			return {
				ok: true,
				id: m.id,
				accion: 'actualizada',
				titulo: m.title,
				memoria: line(m),
				...(existing.source === 'owner'
					? { aviso: 'Esa memoria la había escrito tu dueño: cámbiala sólo si él te lo pidió o la realidad cambió.' }
					: {}),
			};
		}
		const live = (await row<{ n: number }>(
			'select count(*)::int as n from memories where agent_id = $1 and deleted_at is null',
			[a.agent_id],
			c,
		))!.n;
		if (live >= MAX_MEMORIES)
			return {
				ok: false,
				error: `Tu memoria está llena (${MAX_MEMORIES}). Olvida (mem_forget) lo que ya no sirve o actualiza una existente.`,
			};
		const m = (await row<Memory>(
			`insert into memories (agent_id, kind, topic, title, content, source, conversation_id, run_id, created_at, updated_at)
			 values ($1, $2, $3, $4, $5, 'agent', $6, $7, $8, $8) returning ${COLS}`,
			[a.agent_id, v.kind, v.topic, v.title, v.content, a.conversation_id, runId, clock.now()],
			c,
		))!;
		return { ok: true, id: m.id, accion: 'guardada', titulo: m.title, memoria: line(m) };
	});
}

/** The memories that match a search (all of them, newest first, without one), best first. */
export async function search(agentId: number, q: string, opts: { kind?: Kind; limit?: number } = {}) {
	const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50);
	const w = words(q);
	if (!w.length)
		return rows<Memory>(
			`select ${COLS} from memories where agent_id = $1 and deleted_at is null and ($2::text is null or kind = $2)
			 order by pinned desc, updated_at desc limit $3`,
			[agentId, opts.kind ?? null, limit],
		);
	// Any of its words (with their Spanish stem, as prefixes), or close enough to absorb a typo.
	const query = w.map((x) => `${x}:*`).join(' | ');
	return rows<Memory>(
		`select ${COLS} from (
		   select ${COLS}, ts_rank(search, q) + 0.5 * word_similarity($3, memory_text(title || ' ' || content)) as score,
		     search @@ q as hit, word_similarity($3, memory_text(title || ' ' || content)) as near
		   from memories, to_tsquery('spanish', $2) q
		   where agent_id = $1 and deleted_at is null and ($4::text is null or kind = $4)
		 ) m where hit or near > 0.5
		 order by score desc, updated_at desc limit $5`,
		[agentId, query, w.join(' '), opts.kind ?? null, limit],
	);
}

/** mem_search: what it already knows, before asking or starting over. */
async function find(runId: number, args: Record<string, unknown>): Promise<Reply> {
	const a = await caller(runId);
	if (!a) return { ok: false, error: 'El trabajo ya no existe.' };
	const kind = args.tipo ? KIND_OF[String(args.tipo).toLowerCase()] : undefined;
	if (args.tipo && !kind) return { ok: false, error: `tipo: uno de ${Object.values(KINDS).join(', ')}.` };
	const found = await search(a.agent_id, clean(args.consulta, 300), {
		kind,
		limit: Number(args.limite) || 8,
	});
	if (found.length)
		await exec('update memories set used_at = $2 where id = any($1::bigint[])', [found.map((m) => m.id), clock.now()]);
	return {
		ok: true,
		resultados: found.length,
		memorias: found.map((m) => line(m)),
		...(found.length
			? {}
			: {
					nota: 'Nada guardado con esas palabras. Prueba con otras (sinónimos, el nombre de la tienda o la persona).',
				}),
	};
}

/** mem_forget: what is no longer true or no longer serves. */
async function forget(runId: number, args: Record<string, unknown>): Promise<Reply> {
	const a = await caller(runId);
	if (!a) return { ok: false, error: 'El trabajo ya no existe.' };
	const id = Number(args.id);
	const why = clean(args.motivo, 300);
	if (!why) return { ok: false, error: 'Di el motivo (motivo): por qué ya no sirve.' };
	const m = await row<Memory>(`select ${COLS} from memories where id = $1 and agent_id = $2 and deleted_at is null`, [
		id,
		a.agent_id,
	]);
	if (!m) return { ok: false, error: `No tienes la memoria #${id}.` };
	if (m.pinned) return { ok: false, error: 'Tu dueño fijó esa memoria: sólo él la quita. Si ya no es cierta, díselo.' };
	await exec('update memories set deleted_at = $2 where id = $1', [id, clock.now()]);
	return { ok: true, id, titulo: m.title, olvidada: true, motivo: why };
}

export async function handle(runId: number, op: string, args: Record<string, unknown>): Promise<Reply> {
	try {
		if (op === 'save') return await save(runId, args);
		if (op === 'search') return await find(runId, args);
		if (op === 'forget') return await forget(runId, args);
		return { ok: false, error: 'Operación de memoria desconocida.' };
	} catch (err) {
		console.error(`memoria (${op}) del turno ${runId}:`, (err as Error).message);
		return { ok: false, error: 'No se pudo completar; busca con mem_search antes de repetir.' };
	}
}

/** The run's activity line for a memory tool (searching is not activity). */
export function activity(op: string, r: Reply) {
	if (op === 'search') return null;
	if (!r.ok) return `Memoria (${op}) no se pudo: ${r.error}`;
	if (op === 'forget') return `Olvidó «${r.titulo}» (#${r.id}): ${r.motivo}`;
	return r.accion === 'sin cambios'
		? null
		: `${r.accion === 'actualizada' ? 'Actualizó' : 'Guardó'} en su memoria «${r.titulo}» (#${r.id}).`;
}

/**
 * What every work starts with: pinned memories, then the most recently used or changed, within a budget;
 * and how many more there are to search.
 */
export async function block(agentId: number) {
	const all = await rows<Memory>(
		`select ${COLS} from memories where agent_id = $1 and deleted_at is null
		 order by pinned desc, greatest(updated_at, coalesce(used_at, updated_at)) desc limit 60`,
		[agentId],
	);
	const total = (await row<{ n: number }>(
		'select count(*)::int as n from memories where agent_id = $1 and deleted_at is null',
		[agentId],
	))!.n;
	const head = '## Lo que recuerdas';
	if (!total)
		return `${head}\n\nTodavía no tienes memorias. Cuando aprendas algo que te servirá en otros trabajos (una preferencia de tu dueño, una persona, una tienda, cómo se hace algo), guárdalo con mem_save.`;
	const shown: string[] = [];
	let used = 0;
	for (const m of all) {
		const l = `- ${line(m, false)}`;
		if (!m.pinned && used + l.length > BLOCK_BUDGET) break;
		shown.push(l);
		used += l.length;
	}
	const rest = total - shown.length;
	return `${head}\n\nTus memorias (las fijadas por tu dueño primero, luego las más recientes):\n${shown.join('\n')}${rest > 0 ? `\n\nTienes ${rest} más: búscalas con mem_search antes de preguntarle a tu dueño algo que quizá ya sabes.` : ''}`;
}

// ---------- its owner, from the web ----------

export type MemoryView = Memory & {
	history?: { title: string; content: string; changed_by: string; created_at: number }[];
};

export async function list(agentId: number, opts: { q?: string; kind?: Kind } = {}) {
	return {
		memories: await search(agentId, opts.q ?? '', { kind: opts.kind, limit: 50 }),
		total: (await row<{ n: number }>(
			'select count(*)::int as n from memories where agent_id = $1 and deleted_at is null',
			[agentId],
		))!.n,
		max: MAX_MEMORIES,
	};
}

export async function history(agentId: number, id: number) {
	const m = await row<Memory>(`select ${COLS} from memories where id = $1 and agent_id = $2 and deleted_at is null`, [
		id,
		agentId,
	]);
	if (!m) throw new Error('Esa memoria no existe.');
	return {
		...m,
		history: await rows<{ title: string; content: string; changed_by: string; created_at: number }>(
			'select title, content, changed_by, created_at from memory_revisions where memory_id = $1 order by created_at desc limit 20',
			[id],
		),
	};
}

/** Its owner writes one (create) or corrects one (id). The agent sees it as written by its owner. */
export async function ownerSave(agentId: number, body: Record<string, unknown>, id?: number) {
	const v = input(body, id !== undefined);
	if (typeof v === 'string') throw new Error(v);
	return tx(async (c) => {
		if (id !== undefined) {
			const m = await row<Memory>(
				`select ${COLS} from memories where id = $1 and agent_id = $2 and deleted_at is null for update`,
				[id, agentId],
				c,
			);
			if (!m) throw new Error('Esa memoria no existe.');
			const pinned = typeof body.pinned === 'boolean' ? body.pinned : m.pinned;
			const next = {
				kind: v.kind ?? m.kind,
				topic: 'topic' in body || 'tema' in body ? v.topic : m.topic,
				title: v.title || m.title,
				content: v.content || m.content,
			};
			if (next.topic && next.topic !== m.topic) {
				const other = await row(
					'select 1 from memories where agent_id = $1 and topic = $2 and deleted_at is null and id <> $3',
					[agentId, next.topic, id],
					c,
				);
				if (other) throw new Error(`Ya hay otra memoria con el tema ${next.topic}.`);
			}
			const changed =
				next.title !== m.title || next.content !== m.content || next.kind !== m.kind || next.topic !== m.topic;
			if (changed) await revise(m, 'owner', c);
			return (await row<Memory>(
				`update memories set kind = $2, topic = $3, title = $4, content = $5, pinned = $6,
				   source = case when $7 then 'owner' else source end, revisions = revisions + case when $7 then 1 else 0 end,
				   updated_at = case when $7 then $8 else updated_at end
				 where id = $1 returning ${COLS}`,
				[id, next.kind, next.topic, next.title, next.content, pinned, changed, clock.now()],
				c,
			))!;
		}
		if (
			v.topic &&
			(await row(
				'select 1 from memories where agent_id = $1 and topic = $2 and deleted_at is null',
				[agentId, v.topic],
				c,
			))
		)
			throw new Error(`Ya hay una memoria con el tema ${v.topic}: corrígela.`);
		const live = (await row<{ n: number }>(
			'select count(*)::int as n from memories where agent_id = $1 and deleted_at is null',
			[agentId],
			c,
		))!.n;
		if (live >= MAX_MEMORIES) throw new Error(`La memoria de este agente está llena (${MAX_MEMORIES}).`);
		return (await row<Memory>(
			`insert into memories (agent_id, kind, topic, title, content, source, pinned, created_at, updated_at)
			 values ($1, $2, $3, $4, $5, 'owner', $6, $7, $7) returning ${COLS}`,
			[agentId, v.kind, v.topic, v.title, v.content, body.pinned === true, clock.now()],
			c,
		))!;
	});
}

export async function ownerDelete(agentId: number, id: number) {
	const n = await exec('update memories set deleted_at = $3 where id = $1 and agent_id = $2 and deleted_at is null', [
		id,
		agentId,
		clock.now(),
	]);
	if (!n) throw new Error('Esa memoria no existe.');
}

/** Its owner deletes several at once (`ids`), or all of them: how many went. */
export async function ownerDeleteMany(agentId: number, which: { ids?: unknown; all?: unknown }) {
	if (which.all === true)
		return exec('update memories set deleted_at = $2 where agent_id = $1 and deleted_at is null', [
			agentId,
			clock.now(),
		]);
	const ids = Array.isArray(which.ids) ? [...new Set(which.ids.map(Number).filter((x) => Number.isInteger(x)))] : [];
	if (!ids.length || ids.length > 500) throw new Error('Elige de 1 a 500 memorias.');
	return exec('update memories set deleted_at = $3 where agent_id = $1 and id = any($2) and deleted_at is null', [
		agentId,
		ids,
		clock.now(),
	]);
}
