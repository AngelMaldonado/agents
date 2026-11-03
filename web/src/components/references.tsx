// Automejora: type @ to cite an earlier job or conversation of the agent, so the designer reads what
// happened there (what it did wrong, what to improve). The text keeps an explicit reference that the
// server recognizes: @[#62 Revisa noticias](run:62) or @[Principal](conversation:3).
import { useEffect, useMemo, useState } from 'react';
import { ComposerPrimitive, unstable_useMentionAdapter, type Unstable_DirectiveFormatter } from '@assistant-ui/react';
import { Briefcase, MessageSquare } from 'lucide-react';
import { api, type Agent, type Conversation, type Task } from '@/api';
import { Badge } from '@/components/ui/badge';

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

/** In a sent message, each reference becomes a markdown link to its id (no «@»), drawn as a chip. */
export const referenceLinks = (text: string) => text.replace(REF, (_m, label, id) => `[${label}](${id})`);
export const isReference = (href: string | undefined) => !!href && /^(run|conversation):\d+$/.test(href);

/** A cited job or conversation as an outline chip (like assistant-ui's DirectiveText, outline). A
 * conversation opens its chat; a job has no page of its own, so it only names itself. */
export function ReferenceChip({ id, children }: { id: string; children: React.ReactNode }) {
	const [type, n] = id.split(':');
	const agent = location.hash.match(/^#\/agent\/(\d+)/)?.[1];
	const Icon = type === 'run' ? Briefcase : MessageSquare;
	const body = (
		<>
			<Icon aria-hidden="true" />
			<span className="min-w-0 truncate">{children}</span>
		</>
	);
	const className = 'reference-chip';
	return type === 'conversation' && agent ? (
		<Badge asChild variant="outline" className={className}>
			<a href={`#/agent/${agent}/chat/${n}`} title="Abrir la conversación">
				{body}
			</a>
		</Badge>
	) : (
		<Badge variant="outline" className={className} title={`Trabajo #${n}`}>
			{body}
		</Badge>
	);
}

/** The same chip inside the composer (Lexical's directive node): atomic, deleted as a whole. */
export function ComposerReferenceChip({
	directiveType,
	label,
}: {
	directiveId: string;
	directiveType: string;
	label: string;
}) {
	const Icon = directiveType === 'run' ? Briefcase : MessageSquare;
	return (
		<Badge variant="outline" className="reference-chip">
			<Icon aria-hidden="true" />
			<span className="min-w-0 truncate">{label}</span>
		</Badge>
	);
}

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
export function ReferencePopover({
	mention,
	label = 'Citar un trabajo o una conversación',
}: {
	mention: ReturnType<typeof unstable_useMentionAdapter>;
	label?: string;
}) {
	return (
		<ComposerPrimitive.TriggerPopover
			char="@"
			adapter={mention.adapter}
			className="reference-popover"
			aria-label={label}
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

/**
 * The work chat's @: the agents you use, by your alias (or their @handle). «@rd revisa…» sends the message to
 * that agent, in a new conversation of its own, instead of this one; the server reads the leading @words.
 * Plain text in the composer (no chip): what you see is what the server reads, as in WhatsApp.
 */
const agentFormatter: Unstable_DirectiveFormatter = {
	serialize: (item) => `@${item.id.replace(/^agent:/, '')}`,
	parse: (text) => [{ kind: 'text', text }],
};
export function useAgentMentions(current: number) {
	const [list, setList] = useState<Agent[]>([]);
	useEffect(() => {
		let alive = true;
		api<{ agents: Agent[] }>('/agents')
			.then((r) => alive && setList(r.agents.filter((a) => a.usable)))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);
	// A flat list (no category to open first): typing filters it.
	const items = useMemo(
		() =>
			list.map((a) => {
				const word = a.aliases?.[0] ?? a.handle ?? String(a.id);
				return {
					id: `agent:${word}`,
					type: 'agent',
					label: `@${word}`,
					description: a.id === current ? `${a.name} (este)` : a.name,
				};
			}),
		[list, current],
	);
	return unstable_useMentionAdapter({ items, formatter: agentFormatter, includeModelContextTools: false });
}
