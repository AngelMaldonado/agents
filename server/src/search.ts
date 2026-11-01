// The sidebar's search: what someone said to, or heard from, the agents in their own list (theirs and
// the ones shared with them; an admin's list is the same, everyone else's agents stay in the gallery).
// Plain ILIKE over messages and answers: enough for a person's history; add pg_trgm if it gets slow.
import { rows } from './db';
import { titleSql } from './conversations';
import type { Person } from './people';

export type SearchHit = {
	kind: 'message' | 'answer';
	agent_id: number;
	conversation_id: number;
	conversation_title: string;
	run_id: number | null;
	snippet: string;
	at: number;
};

const LIMIT = 30;
const CONTEXT = 60; // characters around the match

/** "  hola   mundo " -> "hola mundo"; null when too short to search. */
export function normalizeQuery(raw: unknown) {
	const q = String(raw ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 100);
	return q.length >= 2 ? q : null;
}

/** The match with some context, on one line, with an ellipsis where it was cut. */
export function snippet(text: string, q: string) {
	const flat = text.replace(/\s+/g, ' ').trim();
	const i = flat.toLocaleLowerCase('es').indexOf(q.toLocaleLowerCase('es'));
	if (i < 0) return flat.slice(0, CONTEXT * 2) + (flat.length > CONTEXT * 2 ? '…' : '');
	const start = Math.max(0, i - CONTEXT);
	const end = Math.min(flat.length, i + q.length + CONTEXT);
	return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

export async function search(viewer: Person, raw: unknown): Promise<SearchHit[]> {
	const q = normalizeQuery(raw);
	if (!q) return [];
	const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
	const found = await rows<Omit<SearchHit, 'snippet'> & { text: string }>(
		`with listed as (
			select a.id from agents a
			where a.deleted_at is null
			  and (a.person_id = $1 or exists (select 1 from agent_shares s where s.agent_id = a.id and s.person_id = $1))
		), hits as (
			select 'message' as kind, c.agent_id, m.conversation_id, m.run_id, m.text, m.received_at as at
			from messages m
			join conversations c on c.id = m.conversation_id
			left join runs r on r.id = m.run_id
			where c.agent_id in (select id from listed)
			  and (r.kind is null or r.kind <> 'initialize')
			  and m.text ilike $2 escape '\\'
			union all
			select 'answer', r.agent_id, r.conversation_id, r.id, r.answer, coalesce(r.ended_at, r.created_at)
			from runs r
			where r.agent_id in (select id from listed)
			  and r.kind <> 'initialize' and r.conversation_id is not null
			  and r.answer ilike $2 escape '\\'
		)
		select h.kind, h.agent_id, h.conversation_id, h.run_id, h.text, h.at, ${titleSql} as conversation_title
		from hits h join conversations c on c.id = h.conversation_id
		order by h.at desc
		limit ${LIMIT}`,
		[viewer.id, like],
	);
	return found.map(({ text, ...hit }) => ({ ...hit, snippet: snippet(text, q) }));
}
