// The chat view's breadcrumb title, like Claude's «Proyecto / Chat ⌄»: its menu renames the chat,
// closes or reopens it, and switches to another of the agent's chats.
import { useState } from 'react';
import { Archive, ArchiveRestore, BrainCircuit, Check, ChevronDown, List, Pencil } from 'lucide-react';
import type { Conversation } from '@/api';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { FormDialog } from '@/components/access-ui';
import { FormActions } from '@/components/actions';

const RECENT = 8;

export function ConversationMenu({
	agentId,
	conversation,
	conversations,
	canManage,
	onRename,
	onArchive,
	onImprove,
}: {
	agentId: number;
	conversation: Conversation | undefined;
	conversations: Conversation[];
	canManage: boolean;
	onRename: (title: string) => Promise<void>;
	onArchive: (archived: boolean) => Promise<void>;
	/** «Usar para mejorar»: Automejora with this chat cited (the owner's agents only). */
	onImprove?: () => void;
}) {
	const [renaming, setRenaming] = useState(false);
	const [title, setTitle] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const others = [...conversations]
		.filter((c) => !c.archived_at || c.id === conversation?.id)
		.sort((a, b) => (b.last_at ?? b.started_at) - (a.last_at ?? a.started_at))
		.slice(0, RECENT);
	const label = conversation?.title || 'Conversación';
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="sm" className="min-w-0 gap-1 px-2 font-semibold" aria-label={`Chat: ${label}`}>
						<span className="truncate">{label}</span>
						{conversation?.archived_at && <span className="text-2xs font-normal text-muted-foreground">· cerrado</span>}
						<ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-72">
					{canManage && conversation && (
						<>
							<DropdownMenuItem
								onSelect={() => {
									setTitle(conversation.title);
									setError('');
									setRenaming(true);
								}}
							>
								<Pencil aria-hidden="true" />
								Renombrar
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => void onArchive(!conversation.archived_at)}>
								{conversation.archived_at ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
								{conversation.archived_at ? 'Reabrir chat' : 'Cerrar chat'}
							</DropdownMenuItem>
							{onImprove && (
								<DropdownMenuItem onSelect={onImprove}>
									<BrainCircuit aria-hidden="true" />
									Usar para mejorar
								</DropdownMenuItem>
							)}
							<DropdownMenuSeparator />
						</>
					)}
					<DropdownMenuLabel className="text-xs text-muted-foreground">Chats recientes</DropdownMenuLabel>
					{others.map((c) => (
						<DropdownMenuItem key={c.id} asChild>
							<a href={`#/agent/${agentId}/chat/${c.id}`} aria-current={c.id === conversation?.id ? 'page' : undefined}>
								<Check className={c.id === conversation?.id ? '' : 'invisible'} aria-hidden="true" />
								<span className="min-w-0 truncate">{c.title || 'Conversación'}</span>
							</a>
						</DropdownMenuItem>
					))}
					<DropdownMenuSeparator />
					<DropdownMenuItem asChild>
						<a href={`#/agent/${agentId}`}>
							<List aria-hidden="true" />
							Ver todos los chats
						</a>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<FormDialog open={renaming} onOpenChange={(o) => !busy && setRenaming(o)} title="Renombrar chat">
				<form
					className="form"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						setError('');
						try {
							await onRename(title);
							setRenaming(false);
						} catch (err) {
							setError((err as Error).message);
						} finally {
							setBusy(false);
						}
					}}
				>
					<label>
						Título
						<Input
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							maxLength={80}
							autoFocus
							placeholder="Vacío: vuelve al título automático"
						/>
					</label>
					{error && (
						<p role="alert" className="error">
							{error}
						</p>
					)}
					<FormActions submitLabel="Guardar" onCancel={() => setRenaming(false)} disabled={busy} />
				</form>
			</FormDialog>
		</>
	);
}
