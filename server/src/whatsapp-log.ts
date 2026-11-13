// Conversaciones (Angel 11-nov-2026): every WhatsApp message between an agent and a person, as it came in or
// went out, and the agent's chats for its WhatsApp-like view (its real ones from this log, its simulated ones
// from the simulator's). Recording never fails a send or a receive: a lost line is logged, not thrown.
import { exec, row, rows } from './db';
import * as sim from './whatsapp-sim';
import type { Person } from './people';

export const CHAT = /^[gde]:[0-9]{8,15}$/;
/** A chat of the view: a real one (g:/d:/e:) or the simulator's (s + its chat: sg:/sd:/se:). */
export const VIEW_CHAT = /^s?[gde]:[0-9]{8,15}$/;

export async function record(
	agentId: number,
	chat: string,
	direction: 'in' | 'out',
	author: string,
	text: string,
	files: { name: string }[] = [],
	opts: { conversationId?: number | null; delegationId?: number | null; ref?: string | null } = {},
) {
	if (!CHAT.test(chat)) return;
	await exec(
		`insert into whatsapp_log (agent_id, chat, direction, author, text, files, conversation_id, delegation_id, ref)
		 values ($1, $2, $3, $4, $5, $6, coalesce($7, (select conversation_id from delegations where id = $8)), $8, $9)
		 on conflict (agent_id, chat, ref) where ref is not null do nothing`,
		[
			agentId,
			chat,
			direction,
			author.slice(0, 200),
			text.slice(0, 20_000),
			files.length ? JSON.stringify(files.map((f) => f.name)) : null,
			opts.conversationId ?? null,
			opts.delegationId ?? null,
			opts.ref ?? null,
		],
	).catch((err) => console.error(`registro de WhatsApp ${agentId} ${chat}:`, (err as Error).message));
}

export type ChatRow = {
	id: string;
	kind: 'group' | 'direct' | 'external';
	role: 'owner' | 'person' | 'guest' | 'direct' | 'external';
	name: string;
	shown: string;
	simulated: boolean;
	count: number;
	last: { direction: 'in' | 'out'; author: string; text: string; at: number; actor: boolean } | null;
	/** Its encargos (external contacts): how many, and whether one is active. */
	encargos: number;
	active: boolean;
};

const KIND = { g: 'group', d: 'direct', e: 'external' } as const;

/**
 * Its chats, the latest first: every chat its log or simulator has, named as its owner sees the contact
 * (a phone no longer listed keeps the name it wrote with). With `conversationId`, only the chats of that trabajo.
 */
export async function chats(agentId: number, owner: Person, conversationId?: number): Promise<ChatRow[]> {
	const filter = conversationId
		? 'and (conversation_id = $2 or delegation_id in (select id from delegations where conversation_id = $2))'
		: '';
	const params = conversationId ? [agentId, conversationId] : [agentId];
	const real = await rows<{ chat: string; count: number; last_id: number }>(
		`select chat, count(*)::int as count, max(id) as last_id from whatsapp_log where agent_id = $1 ${filter} group by chat`,
		params,
	);
	const simulated = await rows<{ chat: string; count: number; last_id: number }>(
		`select chat, count(*)::int as count, max(id) as last_id from whatsapp_sim_messages
		 where agent_id = $1 and chat <> 'g:owner' ${filter} group by chat`,
		params,
	);
	const lastReal = real.length
		? await rows<{ id: number; direction: 'in' | 'out'; author: string; text: string; at: number }>(
				'select id, direction, author, text, at from whatsapp_log where id = any($1)',
				[real.map((r) => r.last_id)],
			)
		: [];
	const lastSim = simulated.length
		? await rows<{ id: number; direction: 'in' | 'out'; author: string; text: string; at: number; actor: boolean }>(
				'select id, direction, author, text, created_at as at, actor from whatsapp_sim_messages where id = any($1)',
				[simulated.map((r) => r.last_id)],
			)
		: [];
	const whatsapp = await import('./whatsapp');
	const known = new Map((await whatsapp.contactsOf(agentId, owner)).map((c) => [c.phone, c]));
	const encargos = await rows<{ phone: string; simulated: boolean; n: number; active: boolean; contact: string }>(
		`select phone, simulated, count(*)::int as n, bool_or(status = 'active') as active, max(contact) as contact
		 from delegations where agent_id = $1 group by phone, simulated`,
		[agentId],
	);
	const out: ChatRow[] = [];
	const add = (r: { chat: string; count: number; last_id: number }, isSim: boolean) => {
		const phone = r.chat.slice(2);
		const c = known.get(phone);
		const last = (isSim ? lastSim : lastReal).find((l) => l.id === r.last_id);
		const e = encargos.find((x) => x.phone === phone && x.simulated === isSim);
		const kind = KIND[r.chat[0] as 'g' | 'd' | 'e'];
		out.push({
			id: `${isSim ? 's' : ''}${r.chat}`,
			kind,
			role: c?.kind ?? (kind === 'group' ? 'guest' : kind),
			name: c?.name ?? e?.contact ?? (last?.direction === 'in' ? last.author : `+${phone}`),
			shown: c?.shown ?? `••••${phone.slice(-4)}`,
			simulated: isSim,
			count: r.count,
			last: last
				? {
						direction: last.direction,
						author: last.author,
						text: last.text,
						at: last.at,
						actor: 'actor' in last && !!last.actor,
					}
				: null,
			encargos: e?.n ?? 0,
			active: !!e?.active,
		});
	};
	for (const r of real) add(r, false);
	for (const r of simulated) if (sim.CHAT.test(r.chat)) add(r, true);
	return out.sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0));
}

/** The trabajos its chats belong to, the latest first: Conversaciones filters by one. */
export async function trabajos(agentId: number) {
	return rows<{ id: number; title: string; status: string; last: number }>(
		`select c.id, coalesce(nullif(c.title, ''), 'Trabajo #' || c.id) as title, c.status, max(x.at) as last
		 from (
		   select conversation_id as id, at from whatsapp_log where agent_id = $1 and conversation_id is not null
		   union all
		   select conversation_id, created_at from whatsapp_sim_messages where agent_id = $1 and conversation_id is not null
		 ) x join conversations c on c.id = x.id and c.deleted_at is null
		 group by c.id order by last desc limit 100`,
		[agentId],
	);
}

export type Line = {
	id: number;
	direction: 'in' | 'out';
	author: string;
	text: string;
	files: string[] | null;
	conversation_id: number | null;
	delegation_id: number | null;
	/** Its simulator's AI actor wrote it. */
	actor: boolean;
	/** Rebuilt from before the log: an agent's line may be only its start. */
	backfilled: boolean;
	at: number;
};

/** One chat's latest lines, oldest first (those after id `after`, for polling), and since when it is complete. */
export async function messages(agentId: number, chat: string, after = 0) {
	if (!VIEW_CHAT.test(chat)) throw new Error('Chat inválido.');
	if (chat.startsWith('s')) {
		const lines = await rows<Line>(
			`select id, direction, author, text, files, conversation_id, delegation_id, actor, false as backfilled, created_at as at
			 from whatsapp_sim_messages where agent_id = $1 and chat = $2 and id > $3 order by id desc limit 500`,
			[agentId, chat.slice(1), after],
		);
		return { lines: lines.reverse(), completeSince: null as number | null };
	}
	const lines = await rows<Line>(
		`select id, direction, author, text, files, conversation_id, delegation_id, false as actor, backfilled, at
		 from whatsapp_log where agent_id = $1 and chat = $2 and id > $3 order by at desc, id desc limit 500`,
		[agentId, chat, after],
	);
	lines.reverse(); // its latest 500, oldest first (the backfilled ones' ids are not in order: by time)
	const since = await row<{ at: number | null }>(
		'select min(at) as at from whatsapp_log where agent_id = $1 and chat = $2 and not backfilled',
		[agentId, chat],
	);
	const any = await row('select 1 from whatsapp_log where agent_id = $1 and chat = $2 and backfilled limit 1', [
		agentId,
		chat,
	]);
	return { lines, completeSince: any ? (since?.at ?? Date.now()) : null };
}

/**
 * Whether the agent is writing to this chat now (Conversaciones shows «…»): a run of its asked from this
 * chat, which answers there, while it thinks or writes; or its encargo, between the contact's line and its
 * reply. Not while it browses or runs a tool: that is working, not writing.
 */
export async function agentTyping(agentId: number, viewChat: string) {
	if (!VIEW_CHAT.test(viewChat)) return false;
	const sim = viewChat.startsWith('s');
	const chat = sim ? viewChat.slice(1) : viewChat;
	const phone = chat.slice(2);
	const run = await row(
		`select 1 from runs r join messages m on m.run_id = r.id and m.routed_as = 'new_run'
		 where r.agent_id = $1 and r.status = 'running' and r.state in ('thinking', 'writing')
		   and (case when $2 then m.context->'whatsapp'->>'sim' = $3
		        else m.context->'whatsapp'->>'sim' is null and m.context->'whatsapp'->>'phone' = $4 end)
		 limit 1`,
		[agentId, sim, chat, phone],
	);
	if (run) return true;
	// Its encargo owes the contact a reply: the last line is theirs, recent, of an encargo still going.
	const last = await row<{ direction: string; delegation_id: number | null; at: number }>(
		sim
			? 'select direction, delegation_id, created_at as at from whatsapp_sim_messages where agent_id = $1 and chat = $2 order by id desc limit 1'
			: 'select direction, delegation_id, at from whatsapp_log where agent_id = $1 and chat = $2 order by at desc, id desc limit 1',
		[agentId, chat],
	);
	if (!last || last.direction !== 'in' || !last.delegation_id || Date.now() - Number(last.at) > 3 * 60_000)
		return false;
	return !!(await row("select 1 from delegations where id = $1 and status = 'active'", [last.delegation_id]));
}
