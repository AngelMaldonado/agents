// Automejora: type @ to cite an earlier job or conversation of the agent, so the designer reads what
// happened there (what it did wrong, what to improve). The text keeps an explicit reference that the
// server recognizes: @[#62 Revisa noticias](run:62) or @[Principal](conversation:3).
import { useEffect, useMemo, useState } from 'react';
import { ComposerPrimitive, unstable_useMentionAdapter, type Unstable_DirectiveFormatter } from '@assistant-ui/react';
import { api, type Conversation, type Task } from '@/api';

const REF = /@\[([^\]\n]{1,120})\]\(((run|conversation):(\d+))\)/g;
export const referenceFormatter: Unstable_DirectiveFormatter = {
	serialize: (item) => `@[${item.label.replace(/[[\]\n]/g, ' ').slice(0, 120)}](${item.id})`,
	parse: (text) => {
		const out: ({ kind: 'text'; text: string } | { kind: 'mention'; type: string; label: string; id: string })[] = [];
		let last = 0;
		for (const m of text.matchAll(REF)) {
			if (m.index! > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
			out.push({ kind: 'mention', type: m[3], label: m[1], id: m[2] });
			last = m.index! + m[0].length;
		}
		if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
		return out;
	},
};

const STATUS: Record<string, string> = {
	done: 'terminó',
	incomplete: 'incompleto',
	error: 'error',
	cancelled: 'cancelado',
	running: 'en curso',
	blocked: 'atascado',
	queued: 'en cola',
	starting: 'arrancando',
};
const day = (ms: number) =>
	new Date(ms).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** The agent's recent jobs and conversations as @ mentions (owner only: the improvement view). */
export function useReferenceMentions(agentId: number | undefined) {
	const [tasks, setTasks] = useState<Task[]>([]),
		[conversations, setConversations] = useState<Conversation[]>([]);
	useEffect(() => {
		if (!agentId) return;
		let alive = true;
		Promise.all([
			api<{ tasks: Task[] }>(`/agents/${agentId}/tasks`),
			api<{ conversations: Conversation[] }>(`/agents/${agentId}/conversations`),
		])
			.then(([t, c]) => {
				if (alive) {
					setTasks(t.tasks.filter((x) => x.kind !== 'initialize' && x.kind !== 'browser'));
					setConversations(c.conversations);
				}
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [agentId]);
	const categories = useMemo(
		() =>
			[
				{
					id: 'runs',
					label: 'Trabajos',
					items: tasks.slice(0, 30).map((t) => ({
						id: `run:${t.id}`,
						type: 'run',
						label: `#${t.id} ${t.prompt.replace(/\s+/g, ' ').slice(0, 50)}`,
						description: `${STATUS[t.status] ?? t.status} · ${day(t.created_at)}`,
					})),
				},
				{
					id: 'conversations',
					label: 'Conversaciones',
					items: conversations.slice(0, 20).map((c) => ({
						id: `conversation:${c.id}`,
						type: 'conversation',
						label: c.title || 'Conversación',
						description: `${c.archived_at ? 'Cerrada · ' : ''}${day(c.started_at)}`,
					})),
				},
			].filter((c) => c.items.length),
		[tasks, conversations],
	);
	return unstable_useMentionAdapter({ categories, formatter: referenceFormatter, includeModelContextTools: false });
}

/** The @ popover: categories first, then the items of the chosen one. */
export function ReferencePopover({ mention }: { mention: ReturnType<typeof useReferenceMentions> }) {
	return (
		<ComposerPrimitive.TriggerPopover
			char="@"
			adapter={mention.adapter}
			className="reference-popover"
			aria-label="Citar un trabajo o una conversación"
		>
			<ComposerPrimitive.TriggerPopover.Directive
				formatter={mention.directive.formatter}
				onInserted={mention.directive.onInserted}
			/>
			<ComposerPrimitive.TriggerPopoverBack className="reference-back">← Volver</ComposerPrimitive.TriggerPopoverBack>
			<ComposerPrimitive.TriggerPopoverCategories>
				{(cats) =>
					cats.map((c) => (
						<ComposerPrimitive.TriggerPopoverCategoryItem key={c.id} categoryId={c.id} className="reference-item">
							{c.label}
						</ComposerPrimitive.TriggerPopoverCategoryItem>
					))
				}
			</ComposerPrimitive.TriggerPopoverCategories>
			<ComposerPrimitive.TriggerPopoverItems>
				{(items) =>
					items.map((it, i) => (
						<ComposerPrimitive.TriggerPopoverItem key={it.id} item={it} index={i} className="reference-item">
							<span className="min-w-0 truncate">{it.label}</span>
							{it.description && <span className="reference-description">{it.description}</span>}
						</ComposerPrimitive.TriggerPopoverItem>
					))
				}
			</ComposerPrimitive.TriggerPopoverItems>
		</ComposerPrimitive.TriggerPopover>
	);
}
