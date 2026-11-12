// Conversaciones simuladas (Angel 9-nov-2026): while an agent's switch is on, what it would send by WhatsApp is
// kept here instead (out), and its owner writes as each of its contacts from the web simulator (in). whatsapp.ts
// asks `on()` before sending and hands simulated messages in through the same paths as real ones.
import { row, rows, exec } from './db';

export type SimFile = { name: string; mime?: string; data?: string };
export type SimMessage = {
	id: number;
	chat: string;
	direction: 'in' | 'out';
	author: string;
	text: string;
	files: string[] | null;
	delegation_id: number | null;
	actor: boolean;
	created_at: number;
};

/**
 * Chats: g:<phone> (a person's group), d:<phone> (a direct guest), e:<phone> (an external contact). Never its
 * owner's: what the agent tells its owner is always real.
 */
export const CHAT = /^(g:[0-9]{8,15}|d:[0-9]{8,15}|e:[0-9]{8,15})$/;

/** Its switch is on: its WhatsApp goes to the simulator. */
export async function on(agentId: number) {
	return !!(await row('select 1 from agents where id = $1 and simulated_conversations', [agentId]));
}

export async function setOn(agentId: number, value: boolean) {
	await exec('update agents set simulated_conversations = $2 where id = $1', [agentId, value]);
}

/**
 * What the agent (or its encargo) says to a simulated chat: kept, never sent. `conversationId`, when given, is
 * where the chat's next message goes (like a group's last conversation). Returns ids like the real senders.
 */
export async function out(
	agentId: number,
	chat: string,
	author: string,
	text: string,
	files: SimFile[] = [],
	opts: { conversationId?: number | null; delegationId?: number | null } = {},
): Promise<string[]> {
	if (!CHAT.test(chat)) throw new Error(`Chat simulado inválido: ${chat}`);
	const m = (await row<{ id: number }>(
		`insert into whatsapp_sim_messages (agent_id, chat, direction, author, text, files, delegation_id, conversation_id)
		 values ($1, $2, 'out', $3, $4, $5, $6, coalesce($7,
		   (select conversation_id from delegations where id = $6),
		   (select conversation_id from whatsapp_sim_chats where agent_id = $1 and chat = $2))) returning id`,
		[
			agentId,
			chat,
			author,
			text,
			files.length ? JSON.stringify(files.map((f) => f.name)) : null,
			opts.delegationId ?? null,
			opts.conversationId ?? null,
		],
	))!;
	if (opts.conversationId !== undefined) await follow(agentId, chat, opts.conversationId);
	await arm(agentId, chat);
	return [`sim:${m.id}`];
}

/** Why an actor stopped. The last two only in rows from before those became pauses (056): a new line undoes them. */
export const STOPPED = {
	owner: 'lo detuviste',
	jobEnded: 'el trabajo terminó',
	simOff: 'las conversaciones simuladas están apagadas',
} as const;

/**
 * By default the AI answers as each contact (Angel 10-nov-2026): the agent writing to a chat turns its actor on.
 * Not when its owner turned it off, nor after its cap or a failure (an agent and an actor answering each other
 * forever).
 */
async function arm(agentId: number, chat: string) {
	await exec(
		`insert into whatsapp_sim_actors (agent_id, chat, auto) values ($1, $2, true)
		 on conflict (agent_id, chat) do update set auto = true, replies = 0, stopped = null, updated_at = now()
		 where not whatsapp_sim_actors.auto
		   and (whatsapp_sim_actors.stopped is null or whatsapp_sim_actors.stopped in ($3, $4))`,
		[agentId, chat, STOPPED.jobEnded, STOPPED.simOff],
	);
}

/** What the simulated person writes, as it came in. */
export async function inbound(
	agentId: number,
	chat: string,
	author: string,
	text: string,
	files: SimFile[] = [],
	/** Its AI actor wrote it (not its owner). */
	actor = false,
) {
	return (await row<{ id: number }>(
		`insert into whatsapp_sim_messages (agent_id, chat, direction, author, text, files, actor)
		 values ($1, $2, 'in', $3, $4, $5, $6) returning id`,
		[agentId, chat, author, text, files.length ? JSON.stringify(files.map((f) => f.name)) : null, actor],
	))!.id;
}

/** The trabajo a simulated person's line went to (Conversaciones lists a trabajo's chats). */
export async function tag(id: number, conversationId: number | null) {
	await exec('update whatsapp_sim_messages set conversation_id = $2 where id = $1', [id, conversationId]);
}

/** The chat's next message goes to this conversation (null: a new one). */
export async function follow(agentId: number, chat: string, conversationId: number | null) {
	await exec(
		`insert into whatsapp_sim_chats (agent_id, chat, conversation_id) values ($1, $2, $3)
		 on conflict (agent_id, chat) do update set conversation_id = excluded.conversation_id, updated_at = now()`,
		[agentId, chat, conversationId],
	);
}

/** The open conversation the chat's next message goes to, if any. */
export async function followed(agentId: number, chat: string) {
	return (
		(
			await row<{ id: number }>(
				`select c.id from whatsapp_sim_chats s join conversations c on c.id = s.conversation_id
				 where s.agent_id = $1 and s.chat = $2 and c.status = 'open' and c.deleted_at is null`,
				[agentId, chat],
			)
		)?.id ?? null
	);
}

export async function messages(agentId: number, chat: string, after = 0) {
	return rows<SimMessage>(
		`select id, chat, direction, author, text, files, delegation_id, actor, created_at from whatsapp_sim_messages
		 where agent_id = $1 and chat = $2 and id > $3 order by id limit 500`,
		[agentId, chat, after],
	);
}

/** Each chat's last line, for the simulator's list. */
export async function last(agentId: number) {
	return rows<SimMessage>(
		`select distinct on (chat) id, chat, direction, author, text, files, delegation_id, actor, created_at
		 from whatsapp_sim_messages where agent_id = $1 order by chat, id desc`,
		[agentId],
	);
}

/** Its earlier simulated chats, gone (a new test starts clean). Its conversations and encargos stay. */
export async function clear(agentId: number) {
	await exec('delete from whatsapp_sim_messages where agent_id = $1', [agentId]);
	await exec('delete from whatsapp_sim_chats where agent_id = $1', [agentId]);
	// Starting over: each actor on again (its default), but the ones its owner turned off.
	await exec(
		`update whatsapp_sim_actors set auto = stopped is distinct from $2 or auto, replies = 0,
		   stopped = case when stopped = $2 and not auto then stopped end, seen_id = null, note = null, updated_at = now()
		 where agent_id = $1`,
		[agentId, STOPPED.owner],
	);
}
