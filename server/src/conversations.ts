import { row, rows, exec, tx, type Exec } from './db';
export type Conversation = {
	id: number;
	agent_id: number;
	title: string;
	started_at: number;
	archived_at: number | null;
	is_default: boolean;
	runs: number;
};
export const requestKey = (value: unknown) => {
	if (typeof value !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))
		throw new Error('Falta una identidad válida para esta petición.');
	return value;
};
// Caller holds the agent lock. Channels never depend on the UI's active tab.
export async function defaultConversation(agentId: number, c: Exec) {
	let conv = await row<{ id: number }>('select id from conversations where agent_id=$1 and is_default', [agentId], c);
	if (!conv) {
		conv = await row<{ id: number }>(
			'select id from conversations where agent_id=$1 order by archived_at is not null,id desc limit 1',
			[agentId],
			c,
		);
		if (conv) await exec('update conversations set is_default=true where id=$1', [conv.id], c);
		else
			conv = await row<{ id: number }>(
				'insert into conversations(agent_id,pi_session_id,is_default) values($1,gen_random_uuid()::text,true) returning id',
				[agentId],
				c,
			);
	}
	return conv!;
}
const title = `coalesce(c.title,case when c.is_default then 'Principal' else (select left(m.text,60) from messages m left join runs r on r.id=m.run_id where m.conversation_id=c.id and (r.kind is null or r.kind<>'initialize') order by m.id limit 1) end,'Nueva conversación')`;
export function list(agentId: number) {
	return rows<Conversation>(
		`select c.id,c.agent_id,${title} as title,c.started_at,c.archived_at,c.is_default,(select count(*) from runs r where r.conversation_id=c.id) as runs from conversations c where c.agent_id=$1 order by c.is_default desc,c.id desc`,
		[agentId],
	);
}
export function get(agentId: number, id: number, on?: Exec) {
	return row<Conversation>(
		`select c.id,c.agent_id,${title} as title,c.started_at,c.archived_at,c.is_default,(select count(*) from runs r where r.conversation_id=c.id) as runs from conversations c where c.agent_id=$1 and c.id=$2`,
		[agentId, id],
		on,
	);
}
export async function create(agentId: number, key: unknown) {
	const requestId = requestKey(key);
	const id = await tx(async (c) => {
		if (!(await row('select id from agents where id=$1 and deleted_at is null for update', [agentId], c)))
			throw new Error('El agente ya no existe.');
		const conv = await row<{ id: number }>(
			`insert into conversations(agent_id,pi_session_id,client_key) values($1,gen_random_uuid()::text,$2) on conflict(agent_id,client_key) do update set client_key=excluded.client_key returning id`,
			[agentId, requestId],
			c,
		);
		return conv!.id;
	});
	return (await get(agentId, id))!;
}
export async function archive(agentId: number, id: number, archived: boolean) {
	const n = await exec(
		'update conversations set archived_at=case when $3 then coalesce(archived_at,now()) else null end where agent_id=$1 and id=$2',
		[agentId, id, archived],
	);
	if (!n) throw new Error('La conversación no pertenece a este agente.');
	return (await get(agentId, id))!;
}
export async function transcript(agentId: number, id: number, before?: number) {
	const conversation = await get(agentId, id);
	if (!conversation) throw new Error('La conversación no pertenece a este agente.');
	const tasks = await import('./tasks');
	const runs = await rows<import('./tasks').Task>(
		`select ${tasks.RUN_SELECT} where r.agent_id=$1 and r.conversation_id=$2 and ($3::bigint is null or r.id<$3) order by r.id desc limit 11`,
		[agentId, id, before ?? null],
	);
	const hasEarlier = runs.length > 10;
	const page = runs.slice(0, 10).reverse();
	const inputs = await rows(
		`select id,text,source,received_at,run_id,routed_as,routed_at,context,
  coalesce((select json_agg(json_build_object('name',f.name,'mime',f.mime,'size',f.size) order by f.id) from files f where f.direction='in' and f.message_id=messages.id),'[]') as files
  from messages where conversation_id=$1 and (run_id=any($2::bigint[]) or (run_id is null and $3::bigint is null)) order by id`,
		[id, page.map((r) => r.id), before ?? null],
	);
	const records = [];
	for (const r of page)
		records.push({
			task: tasks.publicTask(r),
			events: await tasks.events(r.id, 0, true),
			artifacts: await tasks.artifacts(r.id),
		});
	return { conversation, records, inputs, hasEarlier, before: page[0]?.id ?? null };
}
