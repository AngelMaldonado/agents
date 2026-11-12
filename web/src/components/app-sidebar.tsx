// The app's sidebar, shaped like ChatGPT's and Claude.ai's: new agent, search, the gallery, the full
// list of the person's agents, and everything else under the person's tile. Built on shadcn's
// Sidebar (the same base assistant-ui's thread list uses); assistant-ui's ThreadList primitives list
// one chat runtime's threads, not agents, so they stay in the agent view's conversation tabs.
import { ComputerBusy, humanDriving } from '@/components/computer-busy';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	AtSign,
	BadgeCheck,
	Bot,
	ChevronsUpDown,
	LayoutGrid,
	Loader2,
	LoaderCircle,
	Clock,
	LogOut,
	MessageSquare,
	MessageSquareText,
	MoreHorizontal,
	Pencil,
	BrainCircuit,
	Share2,
	FilePen,
	Moon,
	Palette,
	Pin,
	PinOff,
	Search,
	Settings2,
	SquarePen,
	Sun,
	Trash2,
	Users,
	X,
} from 'lucide-react';
import { api, ago, isLive, type Agent, type Person, type SearchHit } from '@/api';
import { onTask } from '@/live';
import { CubyBot } from '@/components/cuby-bot';
import wordmarkUrl from '@/assets/cuby-agents-wordmark.png';
import { useVersion } from '@/lib/use-version';
import { ChatDialog } from '@/components/chat-dialog';
import { SaveButton, useSaving } from '@/components/actions';
import { SIDEBAR_CHANGED, improveWith, requestShare } from '@/lib/sidebar-events';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInput,
	SidebarMenu,
	SidebarMenuAction,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AgentFace } from '@/components/agent-face';
import { Input } from '@/components/ui/input';
import { FormDialog } from '@/components/access-ui';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { SidebarResizer } from '@/components/sidebar-resizer';
import type { SidebarWidth } from '@/lib/sidebar-width';

/** Case- and accent-insensitive, keeping one character per character (NFC input). */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The person's own list: theirs and the ones shared with them (an admin's too; the rest are in the gallery). */
export function listedAgents(agents: Agent[], me: Person) {
	const lastActivity = (a: Agent) => Math.max(a.created_at, a.task?.created_at ?? 0);
	return agents
		.filter((a) => a.person_id === me.id || a.shares?.includes(me.id))
		.sort((a, b) => lastActivity(b) - lastActivity(a) || b.id - a.id);
}

function Highlight({ text, query }: { text: string; query: string }) {
	const i = fold(text).indexOf(fold(query));
	if (!query || i < 0) return <>{text}</>;
	return (
		<>
			{text.slice(0, i)}
			<mark className="rounded-sm bg-sidebar-primary/15 px-0.5 text-sidebar-foreground">
				{text.slice(i, i + query.length)}
			</mark>
			{text.slice(i + query.length)}
		</>
	);
}

/** Shared and managed marks, each with a tooltip that says what it means for this person. */
/** A run of it (or of this chat) is working now: a small spinner; in the queue, a clock. */
function Working({ queued = false, label }: { queued?: boolean; label: string }) {
	const Icon = queued ? Clock : LoaderCircle;
	return (
		<span role="img" aria-label={label} title={label} className="inline-flex shrink-0 text-primary">
			<Icon className={cn('size-3.5', !queued && 'animate-spin')} aria-hidden="true" />
		</span>
	);
}

function AgentMarks({ agent, me }: { agent: Agent; me: Person }) {
	const live = isLive(agent.task);
	const marks: { icon: typeof Users; label: string }[] = [];
	if (agent.person_id !== me.id) marks.push({ icon: Users, label: `Compartido contigo por ${agent.owner}` });
	else if (agent.shares?.length)
		marks.push({
			icon: Users,
			label: `Lo compartes con ${agent.shares.length} ${agent.shares.length === 1 ? 'persona' : 'personas'}`,
		});
	if (agent.managed) marks.push({ icon: BadgeCheck, label: 'Administrado: viene del catálogo del admin' });
	if (!marks.length && !live) return null;
	return (
		<span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
			{live &&
				(humanDriving(agent.task) ? (
					<ComputerBusy
						label={
							agent.task!.kind === 'browser'
								? 'Su computadora está abierta para su dueño'
								: 'Una persona tomó el control de su computadora'
						}
					/>
				) : (
					<Working
						queued={agent.task!.status === 'queued'}
						label={agent.task!.status === 'queued' ? 'Turno en cola' : 'Trabajando'}
					/>
				))}
			{marks.map(({ icon: Icon, label }) => (
				<Tooltip key={label}>
					<TooltipTrigger asChild>
						<span role="img" aria-label={label} className="inline-flex">
							<Icon className="size-3.5" aria-hidden="true" />
						</span>
					</TooltipTrigger>
					<TooltipContent side="right">{label}</TooltipContent>
				</Tooltip>
			))}
		</span>
	);
}

/** In «Fijados», what a row is: an agent or a conversation, a mini icon at the face's bottom left. */
function KindBadge({ kind }: { kind: 'agent' | 'conversation' }) {
	const Icon = kind === 'agent' ? Bot : MessageSquare;
	return (
		<span
			role="img"
			aria-label={kind === 'agent' ? 'Agente' : 'Conversación'}
			className="absolute -bottom-1 -left-1 grid size-3.5 place-items-center rounded-full bg-sidebar-accent text-sidebar-foreground ring-2 ring-sidebar"
		>
			<Icon className="size-2!" aria-hidden="true" />
		</span>
	);
}

function StatusDot({ agent }: { agent: Agent }) {
	const t = agent.task;
	if (!isLive(t)) return null;
	const blocked = t!.status === 'blocked',
		queued = t!.status === 'queued';
	const label = blocked ? 'Necesita ayuda' : queued ? 'En cola' : 'Trabajando';
	return (
		<span
			role="img"
			aria-label={label}
			title={label}
			className={cn(
				'absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-sidebar',
				blocked ? 'bg-warning' : queued ? 'bg-muted-foreground' : 'animate-pulse bg-success',
			)}
		/>
	);
}

type PinRef = { kind: 'agent' | 'conversation'; ref_id: number };
type RecentConversation = {
	id: number;
	agent_id: number;
	title: string;
	archived_at: number | null;
	is_default: boolean;
	last_at: number;
	/** It has a run in the queue or working now. */
	live?: boolean;
};
/** A draft of a new agent: its conversation lives in «Nuevo agente» until approved. */
type Draft = { id: string; name: string; updated_at: number };

/** The sidebar's pins, recent conversations and drafts; reloaded on navigation and when a run ends. */
function useSidebarData(hash: string) {
	const [pins, setPins] = useState<PinRef[]>([]);
	const [conversations, setConversations] = useState<RecentConversation[]>([]);
	const [drafts, setDrafts] = useState<Draft[]>([]);
	const load = useCallback(
		() =>
			api<{ pins: PinRef[]; conversations: RecentConversation[]; drafts?: Draft[] }>('/sidebar')
				.then((r) => {
					setPins(r.pins);
					setConversations(r.conversations);
					setDrafts(r.drafts ?? []);
				})
				.catch(() => {}),
		[],
	);
	useEffect(() => {
		void load();
	}, [hash, load]);
	// A run that starts or ends changes which chats are working (and the recent ones): reload then.
	const statuses = useRef(new Map<number, string>());
	useEffect(
		() =>
			onTask((t) => {
				if (statuses.current.get(t.id) === t.status) return;
				statuses.current.set(t.id, t.status);
				void load();
			}),
		[load],
	);
	// Something the sidebar lists changed elsewhere (a draft got its first reply or a new name).
	useEffect(() => {
		const reload = () => void load();
		window.addEventListener(SIDEBAR_CHANGED, reload);
		return () => window.removeEventListener(SIDEBAR_CHANGED, reload);
	}, [load]);
	const isPinned = (kind: PinRef['kind'], id: number) => pins.some((p) => p.kind === kind && p.ref_id === id);
	const toggle = async (kind: PinRef['kind'], id: number) => {
		const pinned = !isPinned(kind, id);
		setPins((ps) => (pinned ? [...ps, { kind, ref_id: id }] : ps.filter((p) => p.kind !== kind || p.ref_id !== id)));
		try {
			setPins((await api<{ pins: PinRef[] }>('/pins', { method: 'PUT', body: { kind, id, pinned } })).pins);
			if (kind === 'conversation') void load(); // a pinned closed chat joins the list, an unpinned one may leave it
		} catch {
			void load();
		}
	};
	return { pins, conversations, drafts, isPinned, toggle, reload: load };
}

function DraftItem({
	draft,
	active,
	query,
	onNavigate,
	onDiscard,
}: {
	draft: Draft;
	active: boolean;
	query: string;
	onNavigate: () => void;
	onDiscard: () => void;
}) {
	return (
		<SidebarMenuItem>
			<SidebarMenuButton asChild isActive={active}>
				<a
					href={`#/new/${draft.id}`}
					onClick={onNavigate}
					aria-current={active ? 'page' : undefined}
					title={`${draft.name} · borrador, ${ago(draft.updated_at)}`}
				>
					<FilePen aria-hidden="true" className="text-muted-foreground" />
					<span className="min-w-0 flex-1 truncate">
						<Highlight text={draft.name} query={query} />
					</span>
				</a>
			</SidebarMenuButton>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<SidebarMenuAction
						showOnHover
						className="text-muted-foreground data-[state=open]:opacity-100"
						aria-label={`Acciones de ${draft.name}`}
						title="Más"
					>
						<MoreHorizontal aria-hidden="true" />
					</SidebarMenuAction>
				</DropdownMenuTrigger>
				<DropdownMenuContent side="right" align="start" className="w-44">
					<DropdownMenuItem variant="destructive" onSelect={onDiscard}>
						<Trash2 aria-hidden="true" />
						Descartar
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</SidebarMenuItem>
	);
}

function AgentItem({
	agent,
	me,
	active,
	query,
	pinned,
	onPin,
	onRename,
	onAliases,
	onShare,
	onDelete,
	onNavigate,
	badge = false,
}: {
	agent: Agent;
	me: Person;
	active: boolean;
	query: string;
	pinned: boolean;
	onPin: () => void;
	onRename: () => void;
	/** Your own aliases for it: for every agent you use, yours or shared. */
	onAliases: () => void;
	onShare: () => void;
	onDelete: () => void;
	onNavigate: () => void;
	badge?: boolean;
}) {
	const mine = agent.person_id === me.id;
	const live = isLive(agent.task);
	return (
		<SidebarMenuItem>
			<SidebarMenuButton asChild isActive={active} className="h-9">
				<a href={`#/agent/${agent.id}`} onClick={onNavigate} aria-current={active ? 'page' : undefined}>
					<span className="relative flex shrink-0">
						<AgentFace agent={agent} size={28} still />
						{badge && <KindBadge kind="agent" />}
						<StatusDot agent={agent} />
					</span>
					<span className="min-w-0 flex-1 truncate">
						<Highlight text={agent.name} query={query} />
					</span>
					{/* The marks stay while hovering: the row keeps room for the «…» menu on its right (pr-8). */}
					<span className="contents">
						<AgentMarks agent={agent} me={me} />
					</span>
				</a>
			</SidebarMenuButton>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<SidebarMenuAction
						showOnHover
						className="top-2 text-muted-foreground data-[state=open]:opacity-100"
						aria-label={`Acciones de ${agent.name}`}
						title="Más"
					>
						<MoreHorizontal aria-hidden="true" />
					</SidebarMenuAction>
				</DropdownMenuTrigger>
				<DropdownMenuContent side="right" align="start" className="w-44">
					{/* Renaming, sharing and deleting are the owner's; a shared agent can only be pinned. */}
					{mine && (
						<DropdownMenuItem
							onSelect={onRename}
							disabled={live}
							title={live ? 'Espera a que termine su turno.' : undefined}
						>
							<Pencil aria-hidden="true" />
							Renombrar
						</DropdownMenuItem>
					)}
					<DropdownMenuItem onSelect={onPin}>
						{pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
						{pinned ? 'Desfijar' : 'Fijar'}
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={onAliases}>
						<AtSign aria-hidden="true" />
						Alias
					</DropdownMenuItem>
					{mine && (
						<DropdownMenuItem onSelect={onShare}>
							<Share2 aria-hidden="true" />
							Compartir
						</DropdownMenuItem>
					)}
					{mine && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								variant="destructive"
								disabled={live}
								title={live ? 'Termina o cancela su turno antes de eliminarlo.' : undefined}
								onSelect={onDelete}
							>
								<Trash2 aria-hidden="true" />
								Eliminar
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</SidebarMenuItem>
	);
}

function ConversationItem({
	chat,
	agent,
	active,
	query,
	pinned,
	onPin,
	onRename,
	onDelete,
	onImprove,
	onNavigate,
	badge = false,
}: {
	chat: RecentConversation;
	agent: Agent | undefined;
	active: boolean;
	query: string;
	pinned: boolean;
	onPin: () => void;
	onRename: () => void;
	onDelete: () => void;
	/** «Usar para mejorar»: only for the person's own agents (Automejora is the owner's). */
	onImprove?: () => void;
	onNavigate: () => void;
	badge?: boolean;
}) {
	return (
		<SidebarMenuItem>
			<SidebarMenuButton asChild isActive={active}>
				<a
					href={`#/agent/${chat.agent_id}/chat/${chat.id}`}
					onClick={onNavigate}
					aria-current={active ? 'page' : undefined}
					title={agent ? `${chat.title} · ${agent.name}` : chat.title}
				>
					<span className="relative flex shrink-0">
						{agent ? <AgentFace agent={agent} size={20} still /> : <MessageSquareText aria-hidden="true" />}
						{badge && <KindBadge kind="conversation" />}
					</span>
					<span className={cn('min-w-0 flex-1 truncate', chat.archived_at && 'text-muted-foreground')}>
						<Highlight text={chat.title} query={query} />
					</span>
					{chat.live && (
						// Stays while hovering: the «…» menu has its own room on the right.
						<span className="contents">
							<Working label="Este chat está trabajando" />
						</span>
					)}
				</a>
			</SidebarMenuButton>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<SidebarMenuAction
						showOnHover
						className="text-muted-foreground data-[state=open]:opacity-100"
						aria-label={`Acciones de ${chat.title}`}
						title="Más"
					>
						<MoreHorizontal aria-hidden="true" />
					</SidebarMenuAction>
				</DropdownMenuTrigger>
				<DropdownMenuContent side="right" align="start" className="w-44">
					<DropdownMenuItem onSelect={onRename}>
						<Pencil aria-hidden="true" />
						Renombrar
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={onPin}>
						{pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
						{pinned ? 'Desfijar' : 'Fijar'}
					</DropdownMenuItem>
					{onImprove && (
						<DropdownMenuItem onSelect={onImprove}>
							<BrainCircuit aria-hidden="true" />
							Usar para mejorar
						</DropdownMenuItem>
					)}
					<DropdownMenuSeparator />
					<DropdownMenuItem
						variant="destructive"
						disabled={chat.is_default}
						title={chat.is_default ? 'Principal no se elimina: ahí llegan los webhooks y los horarios.' : undefined}
						onSelect={onDelete}
					>
						<Trash2 aria-hidden="true" />
						Eliminar
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</SidebarMenuItem>
	);
}

/** Renaming or deleting (retiring) an agent from the sidebar: one dialog, over the page. */
function AgentDialog({
	edit,
	onClose,
	onDone,
}: {
	edit: { agent: Agent; action: 'rename' | 'delete' | 'aliases' } | null;
	onClose: () => void;
	onDone: (deleted: Agent | null) => void;
}) {
	const [value, setValue] = useState('');
	const [busy, setBusy] = useState(false);
	const saving = useSaving();
	const [error, setError] = useState('');
	useEffect(() => {
		setValue(
			edit?.action === 'rename'
				? edit.agent.name
				: edit?.action === 'aliases'
					? (edit.agent.aliases ?? []).join(', ')
					: '',
		);
		setError('');
	}, [edit]);
	const agent = edit?.agent;
	const deleting = edit?.action === 'delete';
	const naming = edit?.action === 'aliases';
	const savedAliases = (agent?.aliases ?? []).join(', ');
	return (
		<FormDialog
			open={!!edit}
			onOpenChange={(open) => !open && !busy && onClose()}
			title={deleting ? `¿Eliminar a ${agent?.name}?` : naming ? `Alias de ${agent?.name}` : 'Renombrar agente'}
			description={
				deleting
					? 'Se retira de la galería y se eliminan sus horarios; sus trabajos y turnos no se purgan. Para confirmar, escribe su nombre exacto.'
					: naming
						? `Tus nombres cortos para este agente, separados por comas: sólo valen para ti. Con @alias le mandas un mensaje desde cualquier chat, y en WhatsApp lo eliges con «alias: …» o /agente alias. Sin alias, responde a @${agent?.handle ?? ''}.`
						: 'Cambia sólo el nombre (queda como una revisión nueva de su definición).'
			}
		>
			<form
				className="form"
				onSubmit={async (e) => {
					e.preventDefault();
					if (!agent || busy || (deleting && value !== agent.name)) return;
					setBusy(true);
					setError('');
					try {
						if (deleting) {
							await api(`/agents/${agent.id}`, { method: 'DELETE', body: { confirmName: value } });
							onDone(agent);
						} else if (naming) {
							await saving.run(() => api(`/agents/${agent.id}/aliases`, { method: 'PUT', body: { aliases: value } }), {
								hold: true,
							});
							onDone(null);
						} else {
							await saving.run(
								() =>
									api(`/agents/${agent.id}`, {
										method: 'PATCH',
										body: { name: value.trim(), revision: agent.config_revision },
									}),
								{ hold: true },
							);
							onDone(null);
						}
					} catch (err) {
						setError((err as Error).message);
					} finally {
						setBusy(false);
					}
				}}
			>
				<label>
					{deleting ? `Escribe ${agent?.name}` : naming ? 'Alias' : 'Nombre'}
					<Input
						value={value}
						onChange={(e) => setValue(e.target.value)}
						maxLength={naming ? 140 : 40}
						placeholder={naming ? 'rd, radar' : undefined}
						autoFocus
						autoComplete="off"
						spellCheck={false}
						disabled={busy}
					/>
				</label>
				{error && (
					<p role="alert" className="error">
						{error}
					</p>
				)}
				<div className="flex justify-end gap-2">
					<Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
						Cancelar
					</Button>
					{deleting ? (
						<Button variant="destructive" disabled={busy || value !== agent?.name}>
							Eliminar agente
						</Button>
					) : (
						<SaveButton
							state={saving.state}
							disabled={
								busy || (naming ? value.trim() === savedAliases : !value.trim() || value.trim() === agent?.name)
							}
						/>
					)}
				</div>
			</form>
		</FormDialog>
	);
}

/** Folded sidebar: just the character, moving (only here: few and small), its name in a tooltip. */
function CollapsedAgent({ agent, active }: { agent: Agent; active: boolean }) {
	return (
		<SidebarMenuItem>
			<SidebarMenuButton asChild isActive={active} tooltip={agent.name} className="group-data-[collapsible=icon]:p-0!">
				<a href={`#/agent/${agent.id}`} aria-label={agent.name} aria-current={active ? 'page' : undefined}>
					<span className="relative flex size-8 shrink-0 justify-center">
						<AgentFace agent={agent} size={32} />
						<StatusDot agent={agent} />
					</span>
				</a>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

function useSearch(query: string) {
	const [hits, setHits] = useState<SearchHit[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	const ticket = useRef(0);
	useEffect(() => {
		const q = query.trim();
		const mine = ++ticket.current;
		if (q.length < 2) {
			setHits([]);
			setLoading(false);
			setError('');
			return;
		}
		setLoading(true);
		const timer = setTimeout(() => {
			api<{ hits: SearchHit[] }>(`/search?q=${encodeURIComponent(q)}`)
				.then((r) => {
					if (ticket.current !== mine) return;
					setHits(r.hits);
					setError('');
				})
				.catch((err: Error) => ticket.current === mine && setError(err.message))
				.finally(() => ticket.current === mine && setLoading(false));
		}, 250);
		return () => clearTimeout(timer);
	}, [query]);
	return { hits, loading, error };
}

function ProfileMenu({
	me,
	onSettings,
	onLogout,
}: {
	me: Person;
	onSettings: () => void;
	onLogout: () => Promise<void>;
}) {
	const theme = useTheme();
	const [confirming, setConfirming] = useState(false);
	const [leaving, setLeaving] = useState(false);
	const [error, setError] = useState('');
	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<SidebarMenuButton
							size="lg"
							className="data-[state=open]:bg-sidebar-accent"
							aria-label={`Menú de ${me.name}`}
						>
							<span
								className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-medium"
								aria-hidden="true"
							>
								{me.name.slice(0, 2).toUpperCase()}
							</span>
							<span className="grid min-w-0 flex-1 gap-0.5 leading-tight">
								<span className="truncate text-sm font-medium">{me.name}</span>
								<span className="truncate text-xs text-muted-foreground">
									{me.admin ? 'Administrador' : 'Espacio personal'}
								</span>
							</span>
							<ChevronsUpDown className="ml-auto size-4" aria-hidden="true" />
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
						<DropdownMenuLabel className="truncate text-xs">{me.name}</DropdownMenuLabel>
						<DropdownMenuSeparator />
						<DropdownMenuItem className="text-xs" onSelect={onSettings}>
							<Settings2 aria-hidden="true" />
							Configuración
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="flex items-center gap-2 text-xs">
							<Palette className="size-icon" aria-hidden="true" />
							Apariencia
						</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={theme.mode}
							onValueChange={(mode) => {
								if (mode === 'light' || mode === 'dark') theme.set(mode);
							}}
						>
							<DropdownMenuRadioItem value="light" className="text-xs">
								<Sun aria-hidden="true" />
								Claro
							</DropdownMenuRadioItem>
							<DropdownMenuRadioItem value="dark" className="text-xs">
								<Moon aria-hidden="true" />
								Oscuro
							</DropdownMenuRadioItem>
						</DropdownMenuRadioGroup>
						<DropdownMenuSeparator />
						<DropdownMenuItem className="text-xs" onSelect={() => setConfirming(true)}>
							<LogOut aria-hidden="true" />
							Cerrar sesión
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<Dialog
					open={confirming}
					onOpenChange={(open) => {
						if (leaving) return;
						setConfirming(open);
						setError('');
					}}
				>
					<DialogContent className="sm:max-w-md">
						<DialogHeader>
							<DialogTitle>¿Cerrar sesión?</DialogTitle>
							<DialogDescription>
								Tu nombre ya está registrado: para volver a entrar en este navegador necesitarás un enlace de acceso de
								un admin.
							</DialogDescription>
						</DialogHeader>
						{error && (
							<p role="alert" className="text-xs text-destructive">
								{error}
							</p>
						)}
						<DialogFooter>
							<Button variant="outline" disabled={leaving} onClick={() => setConfirming(false)}>
								Cancelar
							</Button>
							<Button
								variant="destructive"
								disabled={leaving}
								onClick={async () => {
									setLeaving(true);
									setError('');
									try {
										await onLogout();
									} catch (err) {
										setError((err as Error).message);
										setLeaving(false);
									}
								}}
							>
								{leaving ? 'Cerrando…' : 'Cerrar sesión'}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}

export function AppSidebar({
	me,
	agents,
	hash,
	width,
	onAgentsChanged,
	onSettings,
	onLogout,
}: {
	me: Person;
	agents: Agent[];
	hash: string;
	width: SidebarWidth;
	onAgentsChanged: () => void;
	onSettings: () => void;
	onLogout: () => Promise<void>;
}) {
	const { isMobile, setOpenMobile, state, setOpen } = useSidebar();
	const [query, setQuery] = useState('');
	const [agentEdit, setAgentEdit] = useState<{ agent: Agent; action: 'rename' | 'delete' | 'aliases' } | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const version = useVersion();
	const listed = useMemo(() => listedAgents(agents, me), [agents, me]);
	const names = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
	const q = query.trim();
	// Your aliases and its @handle find it too.
	const byAlias = (a: Agent) => {
		const w = fold(q).replace(/^@/, '');
		return [...(a.aliases ?? []), a.handle ?? ''].some((x) => x && x.includes(w));
	};
	const shown = q ? listed.filter((a) => fold(a.name).includes(fold(q)) || byAlias(a)) : listed;
	const search = useSearch(q);
	const activeAgent = Number(hash.match(/^\/agent\/(\d+)/)?.[1]);
	const activeChat = Number(hash.match(/^\/agent\/\d+\/chat\/(\d+)/)?.[1]);
	const side = useSidebarData(hash);
	const activeDraft = hash.match(/^\/new\/([\w-]+)/)?.[1];
	const shownDrafts = q ? side.drafts.filter((d) => fold(d.name).includes(fold(q))) : side.drafts;
	// Nothing was created from a draft: discarding it deletes its conversation for good.
	const discardDraft = async (d: Draft) => {
		if (!confirm(`¿Descartar el borrador «${d.name}»? Se borra su conversación.`)) return;
		try {
			await api(`/designs/${d.id}`, { method: 'DELETE' });
			if (activeDraft === d.id) location.hash = '/new';
			void side.reload();
		} catch (err) {
			alert((err as Error).message);
		}
	};
	const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
	// Pinned first (in the order they were pinned), then the rest.
	const pinnedAgents = side.pins.flatMap((p) => (p.kind === 'agent' ? shown.filter((a) => a.id === p.ref_id) : []));
	const otherAgents = shown.filter((a) => !side.isPinned('agent', a.id));
	const chatMatches = (c: RecentConversation) =>
		!q || fold(c.title).includes(fold(q)) || fold(byId.get(c.agent_id)?.name ?? '').includes(fold(q));
	const pinnedChats = side.pins.flatMap((p) =>
		p.kind === 'conversation' ? side.conversations.filter((c) => c.id === p.ref_id && chatMatches(c)) : [],
	);
	const recentChats = side.conversations
		.filter((c) => !side.isPinned('conversation', c.id) && chatMatches(c))
		.slice(0, 15);
	const agentItem = (a: Agent, badge = false) => (
		<AgentItem
			key={a.id}
			badge={badge}
			agent={a}
			me={me}
			// In one of its chats, the chat is the highlighted row (when it is listed).
			active={a.id === activeAgent && !side.conversations.some((c) => c.id === activeChat)}
			query={q}
			pinned={side.isPinned('agent', a.id)}
			onPin={() => void side.toggle('agent', a.id)}
			onRename={() => setAgentEdit({ agent: a, action: 'rename' })}
			onAliases={() => setAgentEdit({ agent: a, action: 'aliases' })}
			onShare={() => {
				close();
				location.hash = `/agent/${a.id}`;
				requestShare(a.id);
			}}
			onDelete={() => setAgentEdit({ agent: a, action: 'delete' })}
			onNavigate={close}
		/>
	);
	const chatItem = (c: RecentConversation, badge = false) => (
		<ConversationItem
			key={c.id}
			badge={badge}
			chat={c}
			agent={byId.get(c.agent_id)}
			active={c.id === activeChat}
			query={q}
			pinned={side.isPinned('conversation', c.id)}
			onPin={() => void side.toggle('conversation', c.id)}
			onRename={() => setChatEdit({ chat: c, action: 'rename' })}
			onDelete={() => setChatEdit({ chat: c, action: 'delete' })}
			onImprove={
				byId.get(c.agent_id)?.person_id === me.id
					? () => {
							close();
							improveWith(c.agent_id, { id: c.id, title: c.title });
						}
					: undefined
			}
			onNavigate={close}
		/>
	);
	const [chatEdit, setChatEdit] = useState<{ chat: RecentConversation; action: 'rename' | 'delete' } | null>(null);
	const close = () => isMobile && setOpenMobile(false);
	const collapsed = state === 'collapsed' && !isMobile;
	const focusSearch = () => {
		if (isMobile) setOpenMobile(true);
		else if (state === 'collapsed') setOpen(true);
		requestAnimationFrame(() => input.current?.focus());
	};
	// ⌘K / Ctrl+K: search, like ChatGPT and Claude.ai.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing)
				return;
			event.preventDefault();
			focusSearch();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
	const nav = [
		{ href: '/new', label: 'Nuevo agente', icon: SquarePen, active: hash.startsWith('/new') },
		{ href: '/', label: 'Galería', icon: LayoutGrid, active: hash === '/' },
	];
	return (
		<Sidebar variant="inset" collapsible="icon" aria-label="Barra lateral">
			{/* Everything scrolls together (header, search, lists); only the person's tile stays put. */}
			{/* Out to the sidebar's top edge (rows scroll away under it instead of being cut 8 px below, the
			    inset container's padding) and close to its right edge (the scrollbar keeps 4 px of air). */}
			<ScrollArea
				type="hover"
				className="sidebar-scroll min-h-0 flex-1 md:-mt-2 md:-mr-2"
				viewportProps={{ className: 'md:pt-2 md:pr-2' }}
			>
				<SidebarHeader>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton asChild size="lg" tooltip="Cuby agents">
								<a href="#/" onClick={close} aria-label="Cuby agents">
									<CubyBot size={32} className="size-8!" />
									{/* «cuby» cut from the Cuby Smart logo, «agents» in the style of its «smart» (Codex). */}
									<img src={wordmarkUrl} alt="" width={307} height={160} className="h-9 w-auto shrink-0" />
									{version && (
										<span className="ml-auto self-end pb-0.5 font-mono text-2xs text-muted-foreground" title="Versión">
											{version}
										</span>
									)}
								</a>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton
								tooltip="Buscar (⌘K)"
								onClick={focusSearch}
								className="hidden group-data-[collapsible=icon]:flex"
							>
								<Search aria-hidden="true" />
								<span>Buscar</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
						{nav.map(({ href, label, icon: Icon, active }) => (
							<SidebarMenuItem key={href}>
								<SidebarMenuButton asChild isActive={active} tooltip={label}>
									<a href={`#${href}`} onClick={close} aria-current={active ? 'page' : undefined}>
										<Icon aria-hidden="true" />
										<span>{label}</span>
									</a>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
					<div role="search" className="relative group-data-[collapsible=icon]:hidden">
						<Search
							className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
							aria-hidden="true"
						/>
						<SidebarInput
							ref={input}
							type="search"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Escape' && query) {
									e.stopPropagation();
									setQuery('');
								}
							}}
							placeholder="Buscar agentes y conversaciones"
							aria-label="Buscar agentes y conversaciones"
							className="pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
						/>
						{query && (
							<button
								type="button"
								onClick={() => {
									setQuery('');
									input.current?.focus();
								}}
								className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
								aria-label="Limpiar búsqueda"
							>
								<X className="size-3.5" aria-hidden="true" />
							</button>
						)}
					</div>
				</SidebarHeader>
				<SidebarContent className="flex-none overflow-visible group-data-[collapsible=icon]:overflow-visible">
					{collapsed && (
						<SidebarGroup className="py-0">
							<SidebarMenu aria-label="Tus agentes">
								{[
									...listed.filter((a) => side.isPinned('agent', a.id)),
									...listed.filter((a) => !side.isPinned('agent', a.id)),
								].map((a) => (
									<CollapsedAgent key={a.id} agent={a} active={a.id === activeAgent} />
								))}
							</SidebarMenu>
						</SidebarGroup>
					)}
					{(pinnedAgents.length > 0 || pinnedChats.length > 0) && (
						<SidebarGroup className="group-data-[collapsible=icon]:hidden">
							<SidebarGroupLabel>Fijados</SidebarGroupLabel>
							<SidebarGroupContent>
								<SidebarMenu aria-label="Fijados">
									{pinnedAgents.map((a) => agentItem(a, true))}
									{pinnedChats.map((c) => chatItem(c, true))}
								</SidebarMenu>
							</SidebarGroupContent>
						</SidebarGroup>
					)}
					<SidebarGroup className="group-data-[collapsible=icon]:hidden">
						<SidebarGroupLabel>Agentes</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu aria-label="Tus agentes">{otherAgents.map((a) => agentItem(a))}</SidebarMenu>
							{!shown.length && (
								<p className="px-2 py-1.5 text-xs text-muted-foreground">
									{q ? 'Ningún agente se llama así.' : 'Todavía no tienes agentes.'}
								</p>
							)}
						</SidebarGroupContent>
					</SidebarGroup>
					{shownDrafts.length > 0 && (
						<SidebarGroup className="group-data-[collapsible=icon]:hidden">
							<SidebarGroupLabel>Borradores</SidebarGroupLabel>
							<SidebarGroupContent>
								<SidebarMenu aria-label="Borradores de agentes nuevos">
									{shownDrafts.map((d) => (
										<DraftItem
											key={d.id}
											draft={d}
											active={activeDraft === d.id}
											query={q}
											onNavigate={close}
											onDiscard={() => void discardDraft(d)}
										/>
									))}
								</SidebarMenu>
							</SidebarGroupContent>
						</SidebarGroup>
					)}
					{recentChats.length > 0 && (
						<SidebarGroup className="group-data-[collapsible=icon]:hidden">
							<SidebarGroupLabel>Conversaciones</SidebarGroupLabel>
							<SidebarGroupContent>
								<SidebarMenu aria-label="Conversaciones recientes">{recentChats.map((c) => chatItem(c))}</SidebarMenu>
							</SidebarGroupContent>
						</SidebarGroup>
					)}
					{q.length >= 2 && (
						<SidebarGroup className="group-data-[collapsible=icon]:hidden">
							<SidebarGroupLabel className="gap-2">
								En conversaciones
								{search.loading && <Loader2 className="size-3 animate-spin" aria-label="Buscando" />}
							</SidebarGroupLabel>
							<SidebarGroupContent>
								<SidebarMenu aria-label="Coincidencias en conversaciones" aria-busy={search.loading}>
									{search.hits.map((h) => (
										<SidebarMenuItem key={`${h.kind}-${h.run_id ?? ''}-${h.conversation_id}-${h.at}`}>
											<SidebarMenuButton asChild className="h-auto items-start py-1.5">
												<a href={`#/agent/${h.agent_id}/chat/${h.conversation_id}`} onClick={close}>
													<MessageSquareText className="mt-0.5" aria-hidden="true" />
													<span className="grid min-w-0 flex-1 gap-0.5">
														<span className="flex min-w-0 items-baseline gap-1 text-xs">
															<span className="truncate font-medium">{names.get(h.agent_id) ?? 'Agente'}</span>
															<span className="truncate text-muted-foreground">· {h.conversation_title}</span>
														</span>
														<span className="line-clamp-2 text-xs whitespace-normal text-muted-foreground">
															<span className="sr-only">{h.kind === 'answer' ? 'Respondió: ' : 'Dijeron: '}</span>
															<Highlight text={h.snippet} query={q} />
														</span>
														<span className="text-2xs text-muted-foreground/80">
															{h.kind === 'answer' ? 'Respuesta' : 'Mensaje'} · {ago(h.at)}
														</span>
													</span>
												</a>
											</SidebarMenuButton>
										</SidebarMenuItem>
									))}
								</SidebarMenu>
								{!search.loading && !search.hits.length && (
									<p className="px-2 py-1.5 text-xs text-muted-foreground" role="status">
										{search.error || 'Nada dicho en tus conversaciones coincide.'}
									</p>
								)}
							</SidebarGroupContent>
						</SidebarGroup>
					)}
				</SidebarContent>
			</ScrollArea>
			<SidebarFooter className="border-t border-sidebar-border">
				<ProfileMenu
					me={me}
					onSettings={() => {
						close();
						onSettings();
					}}
					onLogout={onLogout}
				/>
			</SidebarFooter>
			<AgentDialog
				edit={agentEdit}
				onClose={() => setAgentEdit(null)}
				onDone={(deleted) => {
					setAgentEdit(null);
					onAgentsChanged();
					void side.reload();
					// The open agent was deleted: back to the gallery.
					if (deleted && deleted.id === activeAgent) location.hash = '/';
				}}
			/>
			<ChatDialog
				edit={chatEdit}
				onClose={() => setChatEdit(null)}
				onDone={(deleted) => {
					setChatEdit(null);
					void side.reload();
					// The open chat was deleted: go to its agent's hub.
					if (deleted && deleted.id === activeChat) location.hash = `/agent/${deleted.agent_id}`;
				}}
			/>
			<SidebarResizer width={width} />
		</Sidebar>
	);
}
