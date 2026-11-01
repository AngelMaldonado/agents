// The app's sidebar, shaped like ChatGPT's and Claude.ai's: new agent, search, the gallery, the full
// list of the person's agents, and everything else under the person's tile. Built on shadcn's
// Sidebar (the same base assistant-ui's thread list uses); assistant-ui's ThreadList primitives list
// one chat runtime's threads, not agents, so they stay in the agent view's conversation tabs.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
	BadgeCheck,
	ChevronsUpDown,
	LayoutGrid,
	Loader2,
	LogOut,
	MessageSquareText,
	Moon,
	Palette,
	Search,
	Settings2,
	SquarePen,
	Sun,
	Users,
	X,
} from 'lucide-react';
import { api, ago, isLive, type Agent, type Person, type SearchHit } from '@/api';
import { Character } from '@/Character';
import { stateOf } from '@/Gallery';
import logoUrl from '@/assets/agents-logo.png';
import { useTheme } from '@/lib/theme';
import { requestConversation } from '@/lib/conversation-request';
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
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
function AgentMarks({ agent, me }: { agent: Agent; me: Person }) {
	const marks: { icon: typeof Users; label: string }[] = [];
	if (agent.person_id !== me.id) marks.push({ icon: Users, label: `Compartido contigo por ${agent.owner}` });
	else if (agent.shares?.length)
		marks.push({
			icon: Users,
			label: `Lo compartes con ${agent.shares.length} ${agent.shares.length === 1 ? 'persona' : 'personas'}`,
		});
	if (agent.managed) marks.push({ icon: BadgeCheck, label: 'Administrado: viene del catálogo del admin' });
	if (!marks.length) return null;
	return (
		<span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
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

function AgentItem({
	agent,
	me,
	active,
	query,
	onNavigate,
}: {
	agent: Agent;
	me: Person;
	active: boolean;
	query: string;
	onNavigate: () => void;
}) {
	return (
		<SidebarMenuItem>
			<SidebarMenuButton asChild isActive={active} className="h-9">
				<a href={`#/agent/${agent.id}`} onClick={onNavigate} aria-current={active ? 'page' : undefined}>
					<span className="relative flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
						{/* The 32 px drawing has a desk and margins: drawn larger and cropped to the person. */}
						<span className="flex size-7 items-end justify-center overflow-hidden rounded-md">
							<Character seed={agent.seed} state={stateOf(agent)} size={40} still />
						</span>
						<StatusDot agent={agent} />
					</span>
					<span className="min-w-0 flex-1 truncate">
						<Highlight text={agent.name} query={query} />
					</span>
					<AgentMarks agent={agent} me={me} />
				</a>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

/** Folded sidebar: just the character, moving (only here: few and small), its name in a tooltip. */
function CollapsedAgent({ agent, active }: { agent: Agent; active: boolean }) {
	return (
		<SidebarMenuItem>
			<SidebarMenuButton asChild isActive={active} tooltip={agent.name} className="group-data-[collapsible=icon]:p-0!">
				<a href={`#/agent/${agent.id}`} aria-label={agent.name} aria-current={active ? 'page' : undefined}>
					<span className="relative flex size-8 shrink-0 justify-center">
						{/* The 32-unit drawing at 2 px a unit, cropped to the character: units x 5–21, y 2–18
						    (Character.tsx draws it at x 7–21 from y 3; the laptop starts at x 18, y 17). */}
						<span className="relative size-8 overflow-hidden rounded-md">
							<span className="absolute -top-1 -left-2.5">
								<Character seed={agent.seed} state={stateOf(agent)} size={64} />
							</span>
						</span>
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
	onSettings,
	onLogout,
}: {
	me: Person;
	agents: Agent[];
	hash: string;
	width: SidebarWidth;
	onSettings: () => void;
	onLogout: () => Promise<void>;
}) {
	const { isMobile, setOpenMobile, state, setOpen } = useSidebar();
	const [query, setQuery] = useState('');
	const input = useRef<HTMLInputElement>(null);
	const listed = useMemo(() => listedAgents(agents, me), [agents, me]);
	const names = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
	const q = query.trim();
	const shown = q ? listed.filter((a) => fold(a.name).includes(fold(q))) : listed;
	const search = useSearch(q);
	const activeAgent = Number(hash.match(/^\/agent\/(\d+)/)?.[1]);
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
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton asChild size="lg" tooltip="Agents">
							<a href="#/" onClick={close}>
								<img src={logoUrl} alt="" width={512} height={512} className="size-8 shrink-0 object-contain" />
								<span className="grid min-w-0 flex-1 gap-0.5 leading-tight">
									<span className="text-sm font-semibold">Agents</span>
									<span className="truncate text-xs text-muted-foreground">Espacio de trabajo</span>
								</span>
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
			<SidebarContent className="group-data-[collapsible=icon]:overflow-y-auto group-data-[collapsible=icon]:[scrollbar-width:none]">
				{collapsed && (
					<SidebarGroup className="py-0">
						<SidebarMenu aria-label="Tus agentes">
							{listed.map((a) => (
								<CollapsedAgent key={a.id} agent={a} active={a.id === activeAgent} />
							))}
						</SidebarMenu>
					</SidebarGroup>
				)}
				<SidebarGroup className="group-data-[collapsible=icon]:hidden">
					<SidebarGroupLabel>Agentes</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu aria-label="Tus agentes">
							{shown.map((a) => (
								<AgentItem key={a.id} agent={a} me={me} active={a.id === activeAgent} query={q} onNavigate={close} />
							))}
						</SidebarMenu>
						{!shown.length && (
							<p className="px-2 py-1.5 text-xs text-muted-foreground">
								{q ? 'Ningún agente se llama así.' : 'Todavía no tienes agentes.'}
							</p>
						)}
					</SidebarGroupContent>
				</SidebarGroup>
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
											<a
												href={`#/agent/${h.agent_id}`}
												onClick={() => {
													requestConversation(h.agent_id, h.conversation_id);
													close();
												}}
											>
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
			<SidebarFooter>
				<ProfileMenu
					me={me}
					onSettings={() => {
						close();
						onSettings();
					}}
					onLogout={onLogout}
				/>
			</SidebarFooter>
			<SidebarResizer width={width} />
		</Sidebar>
	);
}
