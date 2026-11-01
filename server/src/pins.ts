// The sidebar (Bubble agents #25): each person's pins (agents and conversations at the top) and the
// recent conversations of the agents they use (their own and the ones shared with them).
import { exec, rows } from './db';
import { titleSql } from './conversations';
import type { Person } from './people';

export type Pin = { kind: 'agent' | 'conversation'; ref_id: number };
export type RecentConversation = {
	id: number;
	agent_id: number;
	title: string;
	archived_at: number | null;
	is_default: boolean;
	last_at: number;
};

/** The agents someone uses: theirs and the ones shared with them (an admin's view of others' is not "use"). */
const USES = `a.deleted_at is null and (a.person_id = $1 or exists (select 1 from agent_shares s where s.agent_id = a.id and s.person_id = $1))`;

export function list(personId: number) {
	return rows<Pin>(
		`select p.kind, p.ref_id from pins p
		 where p.person_id = $1 and (
		   (p.kind = 'agent' and exists (select 1 from agents a where a.id = p.ref_id and ${USES})) or
		   (p.kind = 'conversation' and exists (select 1 from conversations c join agents a on a.id = c.agent_id where c.id = p.ref_id and c.deleted_at is null and ${USES})))
		 order by p.pinned_at`,
		[personId],
	);
}

/**
 * The latest conversations with something in them, newest activity first, plus the pinned ones
 * however old (or closed) they are.
 */
export function recentConversations(personId: number, limit = 30) {
	return rows<RecentConversation>(
		`select * from (
		   select c.id, c.agent_id, ${titleSql} as title, c.archived_at, c.is_default,
		     greatest(c.started_at, (select max(r.created_at) from runs r where r.conversation_id = c.id),
		       (select max(m.received_at) from messages m where m.conversation_id = c.id)) as last_at,
		     exists (select 1 from pins p where p.person_id = $1 and p.kind = 'conversation' and p.ref_id = c.id) as pinned
		   from conversations c join agents a on a.id = c.agent_id
		   where ${USES} and c.deleted_at is null
		     and (exists (select 1 from messages m where m.conversation_id = c.id) or exists (select 1 from runs r where r.conversation_id = c.id and r.kind is distinct from 'initialize'))
		 ) x
		 where pinned or archived_at is null
		 order by pinned desc, last_at desc
		 limit $2`,
		[personId, limit],
	).then((list) => list.map(({ pinned: _pinned, ...c }: RecentConversation & { pinned?: boolean }) => c));
}

/** Pins or unpins something the person uses; anything else is refused. */
export async function set(person: Person, kind: unknown, id: unknown, pinned: unknown) {
	if (kind !== 'agent' && kind !== 'conversation') throw new Error('Sólo se fijan agentes o conversaciones.');
	if (!Number.isSafeInteger(id) || typeof pinned !== 'boolean') throw new Error('Pin inválido.');
	if (pinned) {
		const owned = await rows(
			kind === 'agent'
				? `select 1 from agents a where a.id = $2 and ${USES}`
				: `select 1 from conversations c join agents a on a.id = c.agent_id where c.id = $2 and c.deleted_at is null and ${USES}`,
			[person.id, id],
		);
		if (!owned.length) throw new Error(kind === 'agent' ? 'Ese agente no es tuyo.' : 'Esa conversación no es tuya.');
		await exec('insert into pins (person_id, kind, ref_id) values ($1, $2, $3) on conflict do nothing', [
			person.id,
			kind,
			id,
		]);
	} else await exec('delete from pins where person_id = $1 and kind = $2 and ref_id = $3', [person.id, kind, id]);
	return list(person.id);
}
