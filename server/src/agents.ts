// Workers: stable characters owned by a person. Each run gets a fresh sandbox; what an agent keeps
// between runs (its conversation, later its volume) hangs off the agent.
import { randomBytes } from 'node:crypto';
import { row, rows, exec, tx } from './db';
import { settings } from './settings';
import { publicTask, RUN_SELECT, INSTANCE, type Task } from './tasks';
import type { Person } from './people';

export type Agent = {
	id: number; person_id: number; name: string; role: string; model: string; seed: string; created_at: number;
};

const COLS = 'a.id, a.person_id, a.name, a.role, a.model, a.seed, a.created_at';

export async function visible(viewer: Person) {
	const list = await rows<Agent & { owner: string }>(
		`select ${COLS}, p.name as owner
		 from agents a join people p on p.id = a.person_id
		 where a.deleted_at is null ${viewer.admin ? '' : 'and a.person_id = $1'}
		 order by (a.person_id = $1) desc, a.id`,
		[viewer.id]
	);
	if (!list.length) return [];
	const last = await rows<Task>(
		`select distinct on (r.agent_id) ${RUN_SELECT} where r.agent_id = any($1::bigint[]) order by r.agent_id, r.id desc`,
		[list.map((a) => a.id)]
	);
	const byAgent = new Map(last.map((t) => [t.agent_id, t]));
	return list.map((a) => {
		const t = byAgent.get(a.id);
		return { ...a, task: t ? publicTask(t) : null };
	});
}

export function get(id: number) {
	return row<Agent>(`select ${COLS} from agents a where a.id = $1 and a.deleted_at is null`, [id]);
}

/** The agent if the viewer may see it. */
export async function seeable(viewer: Person, id: number) {
	const a = await get(id);
	return a && (viewer.admin || a.person_id === viewer.id) ? a : null;
}

function checkModel(model: string) {
	if (!settings().models.some((m) => m.id === model)) throw new Error('Ese modelo no está en el catálogo.');
}

export async function create(personId: number, input: { name: string; role?: string; model: string }) {
	const name = String(input.name ?? '').trim().slice(0, 40);
	if (!name) throw new Error('Falta el nombre.');
	checkModel(input.model);
	const id = await tx(async (c) => {
		const a = (await row<{ id: number }>(
			`insert into agents (person_id, name, role, model, seed, state_ref) values ($1, $2, $3, $4, $5, '') returning id`,
			[personId, name, String(input.role ?? '').slice(0, 4000), input.model, randomBytes(6).toString('hex')],
			c
		))!;
		await exec('update agents set state_ref = $2 where id = $1', [a.id, `agents-${INSTANCE}-agent-${a.id}`], c);
		await exec('insert into conversations (agent_id, pi_session_id) values ($1, gen_random_uuid()::text)', [a.id], c);
		return a.id;
	});
	return (await get(id))!;
}

export async function edit(agent: Agent, input: { name?: string; role?: string; model?: string }) {
	const name = input.name !== undefined ? String(input.name).trim().slice(0, 40) : agent.name;
	if (!name) throw new Error('Falta el nombre.');
	const model = input.model ?? agent.model;
	if (model !== agent.model) checkModel(model);
	await exec('update agents set name = $2, role = $3, model = $4 where id = $1', [
		agent.id,
		name,
		input.role !== undefined ? String(input.role).slice(0, 4000) : agent.role,
		model
	]);
	return (await get(agent.id))!;
}

export async function retire(agent: Agent) {
	await exec('update agents set deleted_at = now() where id = $1', [agent.id]);
}

/** The agent's conversations, the current one first; each with how many runs it holds. */
export function conversations(agentId: number) {
	return rows<{ id: number; started_at: number; archived_at: number | null; runs: number }>(
		`select c.id, c.started_at, c.archived_at, (select count(*) from runs r where r.conversation_id = c.id) as runs
		 from conversations c where c.agent_id = $1 order by c.archived_at is not null, c.id desc`,
		[agentId]
	);
}

/**
 * Archives the current conversation and opens a fresh one (a new pi session). A live run keeps
 * the conversation it started in; the next run starts clean.
 */
export async function newConversation(agentId: number) {
	await tx(async (c) => {
		await exec('update conversations set archived_at = now() where agent_id = $1 and archived_at is null', [agentId], c);
		await exec('insert into conversations (agent_id, pi_session_id) values ($1, gen_random_uuid()::text)', [agentId], c);
	});
	return conversations(agentId);
}

/** Wipes the whole browser profile at the agent's next run (cookies, logins, storage). */
export async function resetProfile(agentId: number, personId: number) {
	await exec(
		`insert into profile_purges (agent_id, origin, person_id)
		 select $1, null, $2 where not exists (select 1 from profile_purges where agent_id = $1 and origin is null and done_at is null)`,
		[agentId, personId]
	);
}

export function pendingProfileReset(agentId: number) {
	return row('select 1 from profile_purges where agent_id = $1 and origin is null and done_at is null', [agentId]).then(Boolean);
}

export async function tasksOf(agentId: number) {
	return (await rows<Task>(`select ${RUN_SELECT} where r.agent_id = $1 order by r.id desc limit 50`, [agentId])).map(publicTask);
}
