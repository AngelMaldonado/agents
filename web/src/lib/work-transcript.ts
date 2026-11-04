import type { ThreadMessageLike } from '@assistant-ui/react';
import type { ConversationInput, TaskEvent, WorkRecord } from '@/api';
export type WorkBinding = {
	record?: WorkRecord;
	event?: TaskEvent;
	pending?: boolean;
	input?: ConversationInput;
	steps?: TaskEvent[];
};
export function workTranscript(records: WorkRecord[], inputs: ConversationInput[]) {
	const entries: { message: ThreadMessageLike; binding: WorkBinding; at: number; order: number }[] = [];
	const add = (id: string, role: 'user' | 'assistant', text: string, at: number, binding: WorkBinding) => {
		if (text)
			entries.push({
				message: { id, role, content: [{ type: 'text', text }], createdAt: new Date(at) },
				binding,
				at,
				order: entries.length,
			});
	};
	const byRun = new Map(records.map((r) => [r.task.id, r]));
	for (const m of inputs) {
		// Queued messages show in the composer's queue until the agent takes them.
		if (
			m.routed_as === 'queued' ||
			m.context?.helpRound ||
			(m.run_id && byRun.get(m.run_id)?.task.kind === 'initialize')
		)
			continue;
		add(`input:${m.id}`, 'user', m.text || (m.files?.length ? 'Archivos adjuntos' : ''), m.received_at, {
			record: m.run_id ? byRun.get(m.run_id) : undefined,
			pending: m.routed_at === null,
			input: m,
		});
	}
	for (const record of records) {
		const { task, events } = record;
		if (task.kind === 'initialize') continue;
		const prefix = `run:${task.id}:`;
		if (!inputs.some((m) => m.run_id === task.id && m.routed_as === 'new_run'))
			add(prefix + 'prompt', 'user', task.prompt, task.created_at, { record });
		// What the agent does between its messages (commands, browser, files) shows as one block of steps.
		let steps: TaskEvent[] = [];
		const flush = () => {
			if (steps.length)
				add(
					prefix + `work:${steps[0].id}`,
					'assistant',
					`Trabajando · ${steps.length} ${steps.length === 1 ? 'paso' : 'pasos'}`,
					steps[0].at,
					{ record, steps },
				);
			steps = [];
		};
		const repairCards = new Set<string>();
		for (const e of events) {
			if (e.kind === 'self_repair' || e.kind === 'self_diagnosis') {
				const key = e.kind === 'self_repair' ? String(e.data.id) : String(e.id);
				if (repairCards.has(key)) continue;
				repairCards.add(key);
				flush();
				entries.push({
					message: {
						id: prefix + `maintenance:${key}`,
						role: 'assistant',
						content: [
							{
								type: 'tool-call',
								toolCallId: prefix + `maintenance:${key}`,
								toolName: e.kind,
								args: e.data,
								result: { recorded: true },
							},
						],
						createdAt: new Date(e.at),
					},
					binding: { record, event: e },
					at: e.at,
					order: entries.length,
				});
				continue;
			}
			if (e.kind === 'tool') {
				steps.push(e);
				continue;
			}
			if (['text', 'blocked', 'help_reply', 'steer', 'follow_up'].includes(e.kind)) flush();
			const binding = { record, event: e };
			if (e.kind === 'text' || e.kind === 'blocked')
				add(prefix + `event:${e.id}`, 'assistant', e.kind === 'blocked' ? e.data.reason : e.data.text, e.at, binding);
			// Structured help is already rendered as a receipt on the question. Do not echo its transport text.
			if (
				e.kind === 'help_reply' ||
				(['steer', 'follow_up'].includes(e.kind) && !e.data.message_id && !e.data.helpRound)
			)
				add(prefix + `event:${e.id}`, 'user', e.data.text, e.at, binding);
		}
		flush();
		const lastText = [...events].reverse().find((e) => e.kind === 'text')?.data.text;
		if (task.answer && lastText !== task.answer)
			add(prefix + 'answer', 'assistant', task.answer, task.ended_at ?? task.created_at, { record });
		if (task.end_reason)
			add(prefix + 'end', 'assistant', task.end_reason, task.ended_at ?? task.created_at, { record });
	}
	entries.sort((a, b) => a.at - b.at || a.order - b.order);
	const bindings = new Map(entries.map((e) => [e.message.id!, e.binding]));
	const lastByRun = new Map<number, string>();
	for (const e of entries) if (e.binding.record) lastByRun.set(e.binding.record.task.id, e.message.id!);
	return { messages: entries.map((e) => e.message), bindings, lastByRun };
}
