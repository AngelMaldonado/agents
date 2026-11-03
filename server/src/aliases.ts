// Each person's aliases for the agents they use (#18, Angel 2-nov-2026): personal short names that pick an
// agent in WhatsApp groups and send it a message from any web chat with @. Every agent also answers to its
// handle, its name folded with dashes (Radar Dev → @radar-dev), so @ works before anyone sets an alias.
import { rows, exec, tx, row } from './db';
import * as agents from './agents';
import type { Person } from './people';

const MAX_PER_AGENT = 5;
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
/** The handle every agent answers to: its name folded, with dashes. */
export const handleOf = (name: string) =>
	fold(name)
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40) || 'agente';
const clean = (raw: unknown) =>
	fold(String(raw ?? '').replace(/^@/, ''))
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9_-]/g, '');
const VALID = /^[a-z0-9][a-z0-9_-]{0,23}$/;

/** A person's aliases, by agent. */
export async function of(personId: number | null) {
	const map = new Map<number, string[]>();
	if (!personId) return map;
	for (const r of await rows<{ agent_id: number; alias: string }>(
		'select agent_id, alias from agent_aliases where person_id = $1 order by created_at, alias',
		[personId],
	))
		map.set(r.agent_id, [...(map.get(r.agent_id) ?? []), r.alias]);
	return map;
}

/** The agents a person uses (theirs and shared with them), as aliases see them. */
async function usableBy(person: Person) {
	return (await agents.visible(person)).filter((a) => a.person_id === person.id || a.shares.includes(person.id));
}

/**
 * Sets the person's aliases of one agent they use (replacing them). Each is lower case, without accents,
 * letters, digits, - or _, up to 24; not another of their agents' alias or handle.
 */
export async function set(person: Person, agentId: number, input: unknown) {
	const list = (Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/)).map(clean).filter(Boolean);
	const wanted = [...new Set(list)];
	if (wanted.length > MAX_PER_AGENT) throw new Error(`Hasta ${MAX_PER_AGENT} alias por agente.`);
	const bad = wanted.find((a) => !VALID.test(a));
	if (bad) throw new Error(`«${bad}» no sirve: usa letras, números, - o _, hasta 24.`);
	const mine = await usableBy(person);
	const agent = mine.find((a) => a.id === agentId);
	if (!agent) throw new Error('Sólo pones alias a tus agentes y a los que te compartieron.');
	const taken = await of(person.id);
	for (const a of wanted) {
		const other = mine.find((x) => x.id !== agentId && ((taken.get(x.id) ?? []).includes(a) || handleOf(x.name) === a));
		if (other) throw new Error(`«${a}» ya es de ${other.name}.`);
	}
	await tx(async (c) => {
		await exec('delete from agent_aliases where person_id = $1 and agent_id = $2', [person.id, agentId], c);
		for (const a of wanted)
			await exec(
				'insert into agent_aliases (person_id, agent_id, alias) values ($1, $2, $3)',
				[person.id, agentId, a],
				c,
			);
	});
	return wanted;
}

/** Adds one alias (WhatsApp /alias). */
export async function add(person: Person, agentId: number, alias: string) {
	const now = (await of(person.id)).get(agentId) ?? [];
	return set(person, agentId, [...now, alias]);
}
/** Removes one alias of any of the person's agents; whether there was one. */
export async function remove(personId: number, alias: string) {
	return !!(await row('delete from agent_aliases where person_id = $1 and alias = $2 returning 1', [
		personId,
		clean(alias),
	]));
}

/**
 * Which of `list` a word means for this person: one of their aliases, a handle, the exact name, or the
 * only agent whose handle or name starts with it.
 */
export function resolve<T extends { id: number; name: string }>(
	word: string,
	list: T[],
	aliases: Map<number, string[]>,
) {
	const w = clean(word);
	const name = fold(word);
	if (!w) return undefined;
	const exact =
		list.find((a) => (aliases.get(a.id) ?? []).includes(w)) ??
		list.find((a) => handleOf(a.name) === w) ??
		list.find((a) => fold(a.name) === name);
	if (exact) return exact;
	const starts = list.filter((a) => handleOf(a.name).startsWith(w) || fold(a.name).startsWith(name));
	return starts.length === 1 ? starts[0] : undefined;
}

/**
 * The agents a web message is for when it starts with @mentions («@rd @compras revisa…»): those agents and
 * the rest of the text. Null when it starts with no @word; an error when a word is no agent of theirs.
 */
export async function mentions(person: Person, text: string) {
	const lead = text.match(/^\s*((?:@[\p{L}\p{N}_-]+[\s,]*)+)([\s\S]*)$/u);
	if (!lead) return null;
	const words = lead[1].match(/@[\p{L}\p{N}_-]+/gu)!.map((w) => w.slice(1));
	const list = await usableBy(person);
	const aliases = await of(person.id);
	const found = words.map((w) => ({ word: w, agent: resolve(w, list, aliases) }));
	const missing = found.filter((f) => !f.agent).map((f) => `@${f.word}`);
	if (missing.length === found.length && !lead[2].trim()) return null; // «@algo» alone: just text
	if (missing.length) throw new Error(`No tienes un agente ${missing.join(', ')}. Revisa sus alias.`);
	return { agents: [...new Map(found.map((f) => [f.agent!.id, f.agent!])).values()], text: lead[2].trim() };
}
