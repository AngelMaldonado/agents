import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ThreadListPrimitive, ThreadListItemPrimitive, useAuiState } from '@assistant-ui/react';
import { History, Plus, X } from 'lucide-react';
import { Button } from './ui/button';
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuItem,
} from './ui/dropdown-menu';

const Options = createContext<{ readOnly: boolean; shown: Set<string> }>({ readOnly: false, shown: new Set() });
function ConversationTab() {
	const { readOnly, shown } = useContext(Options);
	const id = useAuiState((s) => s.threadListItem.id);
	const title = useAuiState((s) => s.threadListItem.title ?? 'Conversación');
	const selected = useAuiState((s) => s.threads.mainThreadId === s.threadListItem.id);
	if (!shown.has(id)) return null;
	return (
		<ThreadListItemPrimitive.Root className="conversation-tab" data-active={selected}>
			<ThreadListItemPrimitive.Trigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="min-w-0 flex-1 justify-start"
					aria-current={selected ? 'page' : undefined}
					aria-label={`Abrir conversación ${title}`}
					title={title}
				>
					<span className="truncate">
						<ThreadListItemPrimitive.Title />
					</span>
				</Button>
			</ThreadListItemPrimitive.Trigger>
			{!readOnly && (
				<ThreadListItemPrimitive.Archive asChild>
					<Button
						variant="ghost"
						size="icon-sm"
						className="shrink-0"
						aria-label={`Cerrar conversación ${title}`}
						title="Cerrar tab sin cancelar ni borrar"
					>
						<X aria-hidden="true" />
					</Button>
				</ThreadListItemPrimitive.Archive>
			)}
		</ThreadListItemPrimitive.Root>
	);
}
function OpenConversation() {
	const { shown } = useContext(Options);
	const id = useAuiState((s) => s.threadListItem.id),
		title = useAuiState((s) => s.threadListItem.title ?? 'Conversación');
	if (shown.has(id)) return null;
	return (
		<ThreadListItemPrimitive.Root>
			<ThreadListItemPrimitive.Trigger asChild>
				<DropdownMenuItem aria-label={`Abrir conversación ${title}`}>
					<span className="truncate">
						<ThreadListItemPrimitive.Title />
					</span>
				</DropdownMenuItem>
			</ThreadListItemPrimitive.Trigger>
		</ThreadListItemPrimitive.Root>
	);
}
function RecentConversation() {
	const title = useAuiState((s) => s.threadListItem.title ?? 'Conversación');
	return (
		<ThreadListItemPrimitive.Root>
			<ThreadListItemPrimitive.Unarchive asChild>
				<DropdownMenuItem aria-label={`Reabrir conversación ${title}`}>
					<span className="truncate">
						<ThreadListItemPrimitive.Title />
					</span>
				</DropdownMenuItem>
			</ThreadListItemPrimitive.Unarchive>
		</ThreadListItemPrimitive.Root>
	);
}
export function ConversationTabs({ disabled = false, readOnly = false }: { disabled?: boolean; readOnly?: boolean }) {
	const ids = useAuiState((s) => s.threads.threadIds),
		selected = useAuiState((s) => s.threads.mainThreadId),
		archived = useAuiState((s) => s.threads.archivedThreadIds.length);
	const root = useRef<HTMLDivElement>(null),
		[capacity, setCapacity] = useState(1);
	useLayoutEffect(() => {
		const el = root.current!;
		const measure = () => {
			if (el.clientWidth) setCapacity(el.clientWidth >= 680 ? 3 : el.clientWidth >= 420 ? 2 : 1);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	// Keep the selected tab visible. Overflow goes into the existing menu, never a scrolling tab rail.
	const shown = new Set([...(ids.includes(selected) ? [selected] : []), ...ids].slice(0, capacity));
	for (const id of ids) {
		if (shown.size >= Math.min(capacity, ids.length)) break;
		shown.add(id);
	}
	const overflow = ids.length - shown.size;
	return (
		<Options.Provider value={{ readOnly, shown }}>
			<ThreadListPrimitive.Root
				ref={root}
				className="conversation-tabs"
				aria-label="Conversaciones del agente"
				style={{ '--conversation-tab-count': Math.max(1, shown.size) } as CSSProperties}
			>
				<fieldset disabled={disabled} className="m-0 flex min-w-0 items-center gap-1 border-0 p-0">
					<legend className="sr-only">Tabs de conversaciones</legend>
					<ThreadListPrimitive.Items components={{ ThreadListItem: ConversationTab }} />
					{!readOnly && (
						<ThreadListPrimitive.New asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								className="shrink-0"
								aria-label="Nueva conversación"
								title="Nueva conversación; conserva las anteriores"
							>
								<Plus aria-hidden="true" />
							</Button>
						</ThreadListPrimitive.New>
					)}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								className="shrink-0"
								aria-label={overflow ? 'Más conversaciones y recientes' : 'Conversaciones recientes'}
								title="Cambiar de conversación o reabrir un tab cerrado"
								disabled={(!archived && !overflow) || disabled}
							>
								<History aria-hidden="true" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="max-w-[calc(100vw-2rem)]">
							{overflow > 0 && (
								<>
									<DropdownMenuLabel>Otras conversaciones abiertas</DropdownMenuLabel>
									<ThreadListPrimitive.Items components={{ ThreadListItem: OpenConversation }} />
								</>
							)}
							{archived > 0 && (
								<>
									<DropdownMenuLabel>Conversaciones cerradas</DropdownMenuLabel>
									<ThreadListPrimitive.Items archived components={{ ThreadListItem: RecentConversation }} />
								</>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				</fieldset>
			</ThreadListPrimitive.Root>
		</Options.Provider>
	);
}
