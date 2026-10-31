// Transformación exclusiva de la base temporal: no arranca DBOS ni ejecuta workflows.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export function classifyWorkflow(w, { runs, deliveries, agents }, parseArgs) {
	if (!['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(w.status))
		throw new Error('Workflow no terminal; hace falta drenado real');
	if (['sandboxRun', 'admit'].includes(w.name)) {
		const run = runs.find(
			(r) => (w.name === 'sandboxRun' ? r.workflow_id : `admit-${r.workflow_id.slice(4)}`) === w.workflow_uuid,
		);
		return Boolean(run);
	}
	if (w.name === 'deliver') return deliveries.some((d) => d.workflow_id === w.workflow_uuid);
	if (w.name === 'cronTick') {
		const args = parseArgs(w.inputs, w.serialization),
			context = args?.[1];
		if (!Number.isSafeInteger(context?.agentId) || !/^agent:\d+:/.test(context?.name ?? ''))
			throw new Error('Contexto cron no reconocido');
		if (!context.name.startsWith(`agent:${context.agentId}:`)) throw new Error('Cron con dueño ambiguo');
		return agents.some((a) => Number(a.id) === context.agentId);
	}
	throw new Error('Tipo de workflow no reconocido; no se descarta por suposición');
}

export async function prepareDbos(db) {
	const require = createRequire('/app/server/package.json');
	const entry = require.resolve('@dbos-inc/dbos-sdk');
	const { DBOSJSON, deserializePositionalArgs } = require(join(dirname(entry), 'serialization.js'));
	const parseArgs = (input, format) => deserializePositionalArgs(input, format, DBOSJSON);
	const agents = (await db.query('select id,deleted_at from agents order by id')).rows;
	const runs = (await db.query('select id,workflow_id from runs')).rows;
	const deliveries = (await db.query('select id,workflow_id from webhook_deliveries')).rows;
	const schedules = (
		await db.query('select to_jsonb(s) as data from dbos.workflow_schedules s order by schedule_name')
	).rows.map((r) => r.data);
	const keptSchedules = [],
		removedSchedules = [];
	for (const s of schedules) {
		const match = /^agent:(\d+):[a-f0-9]+$/.exec(s.schedule_name);
		const ctx = DBOSJSON.parse(s.context);
		if (
			!match ||
			s.workflow_name !== 'cronTick' ||
			Number(match[1]) !== ctx?.agentId ||
			ctx.name !== s.schedule_name ||
			s.automatic_backfill !== false
		)
			throw new Error('Agenda desconocida o backfill habilitado');
		const agent = agents.find((a) => Number(a.id) === ctx.agentId);
		if (agent?.deleted_at) throw new Error('Agenda de agente retirado; requiere decisión');
		(agent ? keptSchedules : removedSchedules).push(s);
	}
	const workflows = (
		await db.query(`select w.*,coalesce(i.inputs,w.inputs) as inputs from dbos.workflow_status w
		left join dbos.workflow_input i using(workflow_uuid) order by w.workflow_uuid`)
	).rows;
	const keep = [],
		remove = [];
	for (const w of workflows) {
		// El deserializador SDK puede ser async; ningún contenido privado sale del contenedor.
		let decoded;
		if (w.name === 'cronTick') decoded = await parseArgs(w.inputs, w.serialization);
		(classifyWorkflow(w, { agents, runs, deliveries }, () => decoded) ? keep : remove).push(w.workflow_uuid);
	}
	const removing = new Set(remove);
	for (const w of workflows) {
		if (w.parent_workflow_id && removing.has(w.workflow_uuid) !== removing.has(w.parent_workflow_id))
			throw new Error('Dependencia DBOS cruzada entre historia conservada y excluida');
	}
	const links = (
		await db.query(
			'select workflow_uuid,child_workflow_id from dbos.operation_outputs where child_workflow_id is not null',
		)
	).rows;
	for (const l of links)
		if (removing.has(l.workflow_uuid) !== removing.has(l.child_workflow_id)) throw new Error('Checkpoint DBOS cruzado');
	// Mismo orden que deleteWorkflows del SDK 5.3.0; los payloads no tienen FK cascade.
	for (const table of ['workflow_input', 'workflow_output', 'operation_outputs'])
		await db.query(`delete from dbos.${table} where workflow_uuid=any($1::text[])`, [remove]);
	await db.query('delete from dbos.workflow_status where workflow_uuid=any($1::text[])', [remove]);
	for (const table of ['workflow_events', 'workflow_events_history', 'streams'])
		await db.query(`delete from dbos.${table} where workflow_uuid=any($1::text[])`, [remove]);
	await db.query('delete from dbos.notifications where destination_uuid=any($1::text[])', [remove]);
	for (const s of removedSchedules)
		await db.query('delete from dbos.workflow_schedules where schedule_name=$1', [s.schedule_name]);
	const testQueueExcluded = (await db.query("delete from dbos.queues where name='person:1'")).rowCount;
	const after = (
		await db.query('select to_jsonb(s) as data from dbos.workflow_schedules s order by schedule_name')
	).rows.map((r) => r.data);
	if (JSON.stringify(after) !== JSON.stringify(keptSchedules)) throw new Error('Cambió agenda real');
	if (Number((await db.query('select count(*) as n from dbos.workflow_status')).rows[0].n) !== keep.length)
		throw new Error('Conteo DBOS inesperado');
	return {
		terminalOnly: true,
		testQueueExcluded,
		unreferencedTerminalHistoryExcludedOnlyInCopy: true,
		workflowsPreserved: keep.length,
		workflowsExcluded: remove.length,
		schedulesPreserved: keptSchedules.length,
		schedulesExcluded: removedSchedules.length,
		scheduleDefinitionsUnchanged: true,
		workflowsExecuted: 0,
	};
}
