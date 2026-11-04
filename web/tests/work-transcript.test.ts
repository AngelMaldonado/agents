import { expect, test } from 'bun:test';
import { workTranscript } from '../src/lib/work-transcript';
import type { Task, WorkRecord, ConversationInput } from '../src/api';
const task = (id: number): Task => ({
	id,
	agent_id: 4,
	person_id: 1,
	prompt: `Pedido ${id}`,
	model: 'openai/gpt-6-sol',
	status: 'done',
	state: 'done',
	cost: 0,
	tokens: 0,
	end_reason: null,
	answer: `Respuesta ${id}`,
	conversation_id: 2,
	created_at: id * 1000,
	started_at: id * 1000,
	ended_at: id * 1000 + 900,
});
const text = (m: any) => m.content.map((p: any) => p.text ?? '').join('');
test('one conversation joins executions, input messages and pending work with stable unique IDs', () => {
	const records: WorkRecord[] = [1, 2].map((id) => ({
		task: task(id),
		artifacts: [],
		events: [{ id: 1, at: id * 1000 + 100, kind: 'text', data: { text: `Avance ${id}` } }],
	}));
	const inputs: ConversationInput[] = [
		{ id: 10, text: 'Pedido 1', source: 'web', received_at: 1000, run_id: 1, routed_as: 'new_run', routed_at: 1000 },
		{
			id: 11,
			text: 'Otro detalle',
			source: 'web',
			received_at: 1200,
			run_id: 1,
			routed_as: 'follow_up',
			routed_at: 1300,
		},
		{ id: 12, text: 'Pendiente', source: 'web', received_at: 3000, run_id: null, routed_as: null, routed_at: null },
	];
	records[0].events.push({ id: 2, at: 1300, kind: 'follow_up', data: { text: 'Otro detalle', message_id: 11 } });
	const result = workTranscript(records, inputs);
	expect(result.messages.map(text)).toEqual([
		'Pedido 1',
		'Avance 1',
		'Otro detalle',
		'Respuesta 1',
		'Pedido 2',
		'Avance 2',
		'Respuesta 2',
		'Pendiente',
	]);
	expect(new Set(result.messages.map((m) => m.id)).size).toBe(result.messages.length);
	expect(result.bindings.get('input:12')?.pending).toBe(true);
	expect(result.bindings.get('run:2:event:1')?.record?.task.id).toBe(2);
	expect(result.lastByRun.get(1)).toBe('run:1:answer');
});
test('structured receipts appear once and a plain help reply is not duplicated by its outbox/steer', () => {
	const record: WorkRecord = {
		task: task(1),
		artifacts: [],
		events: [
			{ id: 1, at: 1100, kind: 'blocked', data: { reason: 'Fuentes', questions: [] } },
			{ id: 2, at: 1200, kind: 'help_answer', data: { round: 1, text: 'Elegí local' } },
			{ id: 3, at: 1300, kind: 'steer', data: { helpRound: 1, message_id: 20, text: 'Elegí local' } },
			{ id: 4, at: 1400, kind: 'blocked', data: { reason: 'Ciudad', questions: [] } },
			{ id: 5, at: 1500, kind: 'help_reply', data: { round: 4, message_id: 21, text: 'Guadalajara' } },
			{ id: 6, at: 1600, kind: 'steer', data: { helpRound: 4, message_id: 21, text: 'Guadalajara' } },
		],
	};
	const inputs: ConversationInput[] = [20, 21].map((id) => ({
		id,
		text: id === 20 ? 'Elegí local' : 'Guadalajara',
		source: 'web',
		received_at: 1200,
		run_id: 1,
		routed_as: 'unblock',
		routed_at: 1300,
		context: { helpRound: id === 20 ? 1 : 4 },
	}));
	const result = workTranscript([record], inputs),
		texts = result.messages.map(text);
	expect(texts.filter((t) => t === 'Guadalajara')).toHaveLength(1);
	expect(texts).not.toContain('Elegí local');
	expect(result.bindings.get('run:1:event:1')?.event?.kind).toBe('blocked');
});
test('initialization stays technical; final answer is not repeated if already present as last text', () => {
	const t = task(1);
	expect(workTranscript([{ task: { ...t, kind: 'initialize' }, events: [], artifacts: [] }], []).messages).toEqual([]);
	expect(
		workTranscript(
			[{ task: t, events: [{ id: 1, at: 1900, kind: 'text', data: { text: t.answer } }], artifacts: [] }],
			[],
		)
			.messages.map(text)
			.filter((t) => t === 'Respuesta 1'),
	).toHaveLength(1);
});
test('what the agent does between its messages shows as one block of steps; queued messages wait in the composer', () => {
	const t = { ...task(1), status: 'running' as const, answer: null };
	const tool = (id: number, summary: string) => ({ id, at: 1000 + id, kind: 'tool', data: { name: 'bash', summary } });
	const record: WorkRecord = {
		task: t,
		artifacts: [],
		events: [
			tool(1, 'agent-browser open https://a'),
			tool(2, 'ls ~/work'),
			{ id: 3, at: 1003, kind: 'text', data: { text: 'Encontré dos fuentes.' } },
			tool(4, 'cat notas.md'),
		],
	};
	const inputs: ConversationInput[] = [
		{
			id: 30,
			text: 'Y revisa precios',
			source: 'web',
			received_at: 1005,
			run_id: 1,
			routed_as: 'queued',
			routed_at: 1005,
		},
	];
	const result = workTranscript([record], inputs);
	expect(result.messages.map(text)).toEqual([
		'Pedido 1',
		'Trabajando · 2 pasos',
		'Encontré dos fuentes.',
		'Trabajando · 1 paso',
	]);
	expect(result.bindings.get('run:1:work:1')?.steps?.map((e) => e.data.summary)).toEqual([
		'agent-browser open https://a',
		'ls ~/work',
	]);
	expect(result.messages.map(text)).not.toContain('Y revisa precios');
});
test('repair events become one assistant-ui tool card per proposal, not raw configuration text', () => {
	const record: WorkRecord = {
		task: task(1),
		artifacts: [],
		events: [
			{ id: 1, at: 1100, kind: 'self_diagnosis', data: {} },
			{ id: 2, at: 1200, kind: 'self_repair', data: { id: 'proposal-id', status: 'pending' } },
			{ id: 3, at: 1300, kind: 'self_repair', data: { id: 'proposal-id', status: 'approved' } },
		],
	};
	const cards = workTranscript([record], [])
		.messages.flatMap((m) => m.content)
		.filter((p) => p.type === 'tool-call');
	expect(cards).toHaveLength(2);
	expect(cards.map((p) => p.toolName)).toEqual(['self_diagnosis', 'self_repair']);
	expect(cards[1].args).toEqual({ id: 'proposal-id', status: 'pending' });
});
