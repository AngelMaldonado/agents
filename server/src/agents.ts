// Workers: stable characters owned by a person. Each run gets a fresh sandbox; what an agent keeps
// between runs (its conversation, later its volume) hangs off the agent.
import { randomBytes } from 'node:crypto';
import { list as listConversations } from './conversations';
import { row, rows, exec, tx, type Exec } from './db';
import { settings } from './settings';
import { publicTask, RUN_SELECT, INSTANCE, type Task } from './tasks';
import type { Person } from './people';
import * as hub from './hub';
import { defaultHarness, validateHarness, saveRevision, type Harness } from './harnesses';

export type Agent = {
	id: number;
	person_id: number;
	name: string;
	role: string;
	model: string;
	seed: string;
	created_at: number;
	config_revision: number;
	harness: Harness;
	harness_image: string | null;
	/** Hours without activity that close one of its trabajos (jobs.ts). */
	inactivity_hours: number;
	/** Pagos simulados: its payments are intercepted, and it sees them as done. */
	simulated_payments: boolean;
	/** Conversaciones simuladas: its WhatsApp goes to the web simulator. */
	simulated_conversations: boolean;
	/** Modo objetivo: its trabajos go on by themselves until their objective is met. */
	goal_mode: boolean;
	shares: number[];
};

const COLS =
	'a.id, a.person_id, a.name, a.role, a.model, a.seed, a.created_at, a.config_revision, a.harness, a.harness_image, a.inactivity_hours, a.simulated_payments, a.simulated_conversations, a.goal_mode, array(select s.person_id::int from agent_shares s where s.agent_id = a.id order by s.person_id) as shares';

export async function visible(viewer: Person) {
	const list = await rows<Agent & { owner: string }>(
		`select ${COLS}, p.name as owner,
			 (select d.id from agent_designs d where d.applied_agent_id=a.id and d.agent_id is null) as setup_design_id
		 from agents a join people p on p.id = a.person_id
		 where a.deleted_at is null ${viewer.admin ? '' : 'and (a.person_id = $1 or exists (select 1 from agent_shares s where s.agent_id = a.id and s.person_id = $1))'}
		 order by (a.person_id = $1) desc, a.id`,
		[viewer.id],
	);
	if (!list.length) return [];
	const last = await rows<Task>(
		`select distinct on (r.agent_id) ${RUN_SELECT} where r.agent_id = any($1::bigint[]) order by r.agent_id, r.id desc`,
		[list.map((a) => a.id)],
	);
	const byAgent = new Map(last.map((t) => [t.agent_id, t]));
	return list.map((a) => {
		const t = byAgent.get(a.id);
		// managed: made from the admin's catalog. The catalog does not exist yet (Bubble, agents #22),
		// so no agent is managed; the sidebar already shows the mark.
		return { ...a, managed: false, task: t ? publicTask(t) : null };
	});
}

export function get(id: number, on?: Exec) {
	return row<Agent>(`select ${COLS} from agents a where a.id = $1 and a.deleted_at is null`, [id], on);
}

/** The agent if the viewer may see it. */
export async function seeable(viewer: Person, id: number) {
	const a = await get(id);
	return a && (viewer.admin || a.person_id === viewer.id || a.shares.includes(viewer.id)) ? a : null;
}

/**
 * What someone it is shared with gets about the agent: name and work, not how it is built. Its
 * role (prompt), harness (tools, MCP servers, installs) and who else has it stay with the owner and
 * admins. Server code keeps using the full agent; this is only for what goes to the browser.
 */
export function forViewer<T extends Agent>(agent: T, viewer: Person): T {
	if (viewer.admin || agent.person_id === viewer.id) return agent;
	return { ...agent, role: '', harness: undefined, harness_image: null, shares: [viewer.id] } as unknown as T;
}

/** Its owner or someone it is shared with: chat, tasks, answers. Not its configuration. */
export async function usable(viewer: Person, id: number) {
	const a = await get(id);
	return a && (a.person_id === viewer.id || a.shares.includes(viewer.id)) ? a : null;
}

/** The owner shares it with exactly these people (anyone but the owner). */
export async function setShares(agent: Agent, people: unknown) {
	const ids = [
		...new Set(
			(Array.isArray(people) ? people : [])
				.map(Number)
				.filter((n) => Number.isSafeInteger(n) && n > 0 && n !== agent.person_id),
		),
	].slice(0, 50);
	await tx(async (c) => {
		await exec('delete from agent_shares where agent_id = $1', [agent.id], c);
		await exec(
			'insert into agent_shares (agent_id, person_id) select $1, p.id from people p where p.id = any($2::bigint[])',
			[agent.id, ids],
			c,
		);
	});
	const now = (
		await rows<{ person_id: number }>('select person_id from agent_shares where agent_id = $1 order by person_id', [
			agent.id,
		])
	).map((s) => s.person_id);
	hub.setShares(agent.id, now);
	return now;
}

/** At boot: the hub learns who sees each shared agent. */
export async function loadShares() {
	const all = await rows<{ agent_id: number; people: number[] }>(
		'select agent_id, array_agg(person_id::int order by person_id) as people from agent_shares group by agent_id',
	);
	for (const s of all) hub.setShares(s.agent_id, s.people);
}

function checkModel(model: string) {
	if (!settings().models.some((m) => m.id === model)) throw new Error('Ese modelo no está en el catálogo.');
}

export async function create(
	personId: number,
	input: { name: string; role?: string; model: string; harness?: Harness; image?: string },
	on?: Exec,
) {
	const name = String(input.name ?? '')
		.trim()
		.slice(0, 40);
	if (!name) throw new Error('Falta el nombre.');
	checkModel(input.model);
	const insert = async (c: Exec) => {
		const a = (await row<{ id: number }>(
			`insert into agents (person_id, name, role, model, seed, state_ref, harness, harness_image) values ($1, $2, $3, $4, $5, '', $6, $7) returning id`,
			[
				personId,
				name,
				String(input.role ?? ''),
				input.model,
				randomBytes(6).toString('hex'),
				JSON.stringify(validateHarness(input.harness ?? defaultHarness())),
				input.image ?? null,
			],
			c,
		))!;
		await exec('update agents set state_ref = $2 where id = $1', [a.id, `agents-${INSTANCE}-agent-${a.id}`], c);
		await exec(
			'insert into conversations (agent_id, pi_session_id, is_default) values ($1, gen_random_uuid()::text, true)',
			[a.id],
			c,
		);
		const saved = (await get(a.id, c))!;
		await saveRevision(saved, c);
		return saved;
	};
	return on ? insert(on) : tx(insert);
}

export async function edit(agent: Agent, input: { name?: string; role?: string; model?: string; revision?: number }) {
	return tx(async (c) => {
		const current = await row<Agent>(
			'select * from agents where id=$1 and deleted_at is null for update',
			[agent.id],
			c,
		);
		if (!current) throw new Error('El agente ya no existe.');
		if (input.revision !== undefined && input.revision !== current.config_revision)
			throw new Error('La configuración cambió. Recarga antes de guardar.');
		if (
			await row(
				"select 1 from runs where agent_id=$1 and status in ('queued','starting','running','blocked')",
				[agent.id],
				c,
			)
		)
			throw new Error('Termina o cancela la corrida antes de cambiar su configuración.');
		const name = input.name !== undefined ? String(input.name).trim().slice(0, 40) : current.name;
		if (!name) throw new Error('Falta el nombre.');
		const model = input.model ?? current.model;
		checkModel(model);
		await exec(
			'update agents set name=$2, role=$3, model=$4, config_revision=config_revision+1 where id=$1',
			[agent.id, name, input.role !== undefined ? String(input.role) : current.role, model],
			c,
		);
		const saved = (await get(agent.id, c))!;
		await saveRevision(saved, c);
		return saved;
	});
}

export async function retire(agent: Agent) {
	await exec('update agents set deleted_at = now() where id = $1', [agent.id]);
}

/** The agent's conversations, the current one first; each with how many runs it holds. */
export function conversations(agentId: number) {
	return listConversations(agentId);
}

/** Wipes the whole browser profile at the agent's next run (cookies, logins, storage). */
export async function resetProfile(agentId: number, personId: number) {
	await exec(
		`insert into profile_purges (agent_id, origin, person_id)
		 select $1, null, $2 where not exists (select 1 from profile_purges where agent_id = $1 and origin is null and done_at is null)`,
		[agentId, personId],
	);
}

export function pendingProfileReset(agentId: number) {
	return row('select 1 from profile_purges where agent_id = $1 and origin is null and done_at is null', [agentId]).then(
		Boolean,
	);
}

export async function tasksOf(agentId: number) {
	return (await rows<Task>(`select ${RUN_SELECT} where r.agent_id = $1 order by r.id desc limit 50`, [agentId])).map(
		publicTask,
	);
}
