// The agent's page (Bubble agents #25), in three views on one URL family:
//   #/agent/:id            its hub: header, current work, a composer that starts a new chat, its
//                          chats («Recientes») and its recent files;
//   #/agent/:id/chat/:c    one chat as the protagonist, with the work (browser, activity, terminal,
//                          answer) on the right when the chat has runs; its header lives in the app bar;
//   #/agent/:id/improve    Automejora.
// A file (#/agent/:id/artifact/…) opens in a drawer over whichever of the first two it came from.
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
	api,
	isLive,
	type Agent,
	type Artifact,
	type BrowserSnapshot,
	type Conversation,
	type Person,
	type PublicSettings,
	type Task,
	type TaskEvent,
} from './api';
import { AgentHeader, AutomejoraLink } from '@/components/agent-header';
import { Browser } from './Browser';
import { onEvent, onTask, useConnected, useTick, useWatch } from './live';
import { directsTask } from './lib/work-access';
import { AgentSettings } from './AgentSettings';
import {
	Bot,
	Compass,
	CreditCard,
	Globe,
	Hand,
	KeyRound,
	ListChecks,
	MessageSquareText,
	Pencil,
	Plus,
	type LucideIcon,
	PanelRightClose,
	MonitorPlay,
	PanelRightOpen,
	RotateCw,
	Square,
	Terminal as TerminalIcon,
	TriangleAlert,
} from 'lucide-react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WorkChat } from '@/components/work-chat';
import { useWorkConversations } from '@/lib/use-work-conversations';
import { ArtifactCards, ArtifactDrawer, ArtifactMarkdown, type ArtifactTarget } from '@/components/artifacts';
import { IconButton } from '@/components/actions';
import { ChatHistory, HubComposer, RecentFiles, WorkFooter } from '@/components/agent-hub';
import { ConversationMenu } from '@/components/conversation-menu';
import { HeaderSlot } from '@/components/header-slot';
import { crewOf, usePeople } from '@/lib/use-people';
import { useSlidePanel } from '@/lib/use-slide-panel';
import { WorkPeek } from '@/components/work-peek';
import { improveWith } from '@/lib/sidebar-events';

type Tab = 'browser' | 'activity' | 'terminal' | 'answer';
type Mode = 'hub' | 'chat' | 'browser' | 'improve';
const TABS: Record<Tab, { label: string; icon: LucideIcon }> = {
	browser: { label: 'Navegador', icon: Globe },
	activity: { label: 'Actividad', icon: ListChecks },
	terminal: { label: 'Terminal', icon: TerminalIcon },
	answer: { label: 'Respuesta', icon: MessageSquareText },
};
const AgentImprovement = lazy(() =>
	import('./AgentImprovement').then((module) => ({ default: module.AgentImprovement })),
);

export function AgentView({
	agent,
	me,
	settings,
	onBack,
	onChanged,
	improving = false,
	designId,
	chatId,
	browsing = false,
	onRoute,
	artifact = null,
}: {
	agent: Agent;
	me: Person;
	settings: PublicSettings;
	onBack: () => void;
	onChanged: () => void;
	improving?: boolean;
	designId?: string;
	chatId?: number;
	/** #/agent/:id/browser: its browser, maximized. */
	browsing?: boolean;
	artifact?: ArtifactTarget | null;
	/** Goes to another view of this agent: '' (hub), '/chat/<id>', '/browser', '/improve[/<draft>]'. */
	onRoute: (suffix: string) => void;
}) {
	useTick(1000);
	const mine = agent.person_id === me.id;
	// Shared with me: I run tasks (chat, answers, queue); improving, configuring and driving its browser are the owner's.
	const canUse = mine || !!agent.shares?.includes(me.id);
	// A run is one person's task: its owner and whoever asked for it direct it; everyone else waits.
	const directs = (t: Task) => directsTask(t, me.id);
	const people = usePeople();

	// The view under an open file is the one it was opened from.
	const routed = {
		mode: (improving ? 'improve' : browsing ? 'browser' : chatId ? 'chat' : 'hub') as Mode,
		chatId,
	};
	const lastView = useRef(routed);
	if (!artifact) lastView.current = routed;
	const { mode, chatId: openChat } = artifact ? lastView.current : routed;
	const suffixOf = (v: { mode: Mode; chatId?: number }) =>
		v.mode === 'chat'
			? `/chat/${v.chatId}`
			: v.mode === 'improve'
				? '/improve'
				: v.mode === 'browser'
					? '/browser'
					: '';

	const [improvementVisited, setImprovementVisited] = useState(improving);
	const [lastDraftId, setLastDraftId] = useState(designId);
	const improvingNow = useRef(improving);
	improvingNow.current = improving;
	useEffect(() => {
		if (improving) {
			setImprovementVisited(true);
			setLastDraftId(designId);
		}
	}, [improving, designId]);

	const [conversations, setConversations] = useState<Conversation[]>([]);
	const [conversationsLoaded, setConversationsLoaded] = useState(false);
	const conversationState = useWorkConversations(
		{ ...agent, mine: canUse },
		me.id,
		conversations,
		setConversations,
		conversationsLoaded,
		mode !== 'improve',
		mode === 'chat',
	);
	const [listVersion, setListVersion] = useState(0);
	const [listError, setListError] = useState('');
	const [listLoading, setListLoading] = useState(true);
	const [filesVersion, setFilesVersion] = useState(0);
	const [profileReset, setProfileReset] = useState(false);
	useEffect(() => {
		let alive = true;
		setListLoading(true);
		setListError('');
		conversationState
			.loadList()
			.then((c) => {
				if (!alive) return;
				setConversationsLoaded(true);
				setProfileReset(c.profileResetPending);
			})
			.catch((e) => alive && setListError(e.message))
			.finally(() => alive && setListLoading(false));
		return () => {
			alive = false;
		};
	}, [agent.id, listVersion]);
	// A run that ends changes «Recientes» (its time) and maybe «Archivos recientes».
	useEffect(
		() =>
			onTask((t) => {
				if (t.agent_id !== agent.id || isLive(t)) return;
				setListVersion((v) => v + 1);
				setFilesVersion((v) => v + 1);
			}),
		[agent.id],
	);

	// ---------- the chat in the URL ----------
	const opened = useRef<number | null>(null); // the chat this visit arrived at
	useEffect(() => {
		opened.current = null;
	}, [openChat, mode]);
	const chat = mode === 'chat' ? conversations.find((c) => c.id === openChat) : undefined;
	const missingChat = mode === 'chat' && conversationsLoaded && !chat;
	useEffect(() => {
		if (!chat) return;
		// A closed chat reopens when its owner (or someone it is shared with) opens it, like picking a
		// closed tab from Recientes did; only on arriving, never because it was just closed here.
		// Others read it as it is.
		const arriving = opened.current !== chat.id;
		opened.current = chat.id;
		if (canUse && chat.archived_at) {
			if (arriving) void conversationState.archive(chat.id, false).catch((e) => setActionError((e as Error).message));
		} else if (conversationState.selected !== chat.id) void conversationState.select(chat.id);
	}, [chat?.id, chat?.archived_at, conversationState.selected]);

	// ---------- the work on screen: the agent's latest run (hub) or this chat's (chat) ----------
	const agentTask = conversationState.agentTask;
	const chatReady = mode === 'chat' && conversationState.selected === openChat;
	const baseTask = mode === 'chat' ? (chatReady ? conversationState.currentTask : null) : agentTask;
	const taskId = mode === 'improve' ? null : (baseTask?.id ?? null);
	const [snapshot, setSnapshot] = useState<{
		id: number;
		data: BrowserSnapshot | null;
		loading: boolean;
		error: boolean;
	} | null>(null);
	const [detailError, setDetailError] = useState('');
	const [actionError, setActionError] = useState('');
	const [refresh, setRefresh] = useState(0);
	const [task, setTask] = useState<Task | null>(agent.task);
	const [events, setEvents] = useState<TaskEvent[]>([]);
	const [files, setFiles] = useState<Artifact[]>([]);
	const [tab, setTab] = useState<Tab>('browser');
	const pickedTab = useRef<number | null>(null);

	const connected = useConnected();
	useEffect(() => {
		if (connected) {
			setRefresh((v) => v + 1);
			if (mode === 'chat') void conversationState.refresh();
		}
	}, [connected]);
	useEffect(() => {
		let alive = true;
		setDetailError('');
		setEvents([]);
		setFiles([]);
		setSnapshot(null);
		if (!taskId) {
			setTask(null);
			return;
		}
		const merge = (a: TaskEvent[], b: TaskEvent[]) =>
			[...new Map([...a, ...b].map((e) => [e.id, e])).values()].sort((a, b) => a.id - b.id);
		api(`/tasks/${taskId}`)
			.then((r) => {
				if (!alive) return;
				if (r.task?.id !== taskId || r.task.agent_id !== agent.id) throw new Error('No se pudo cargar este trabajo.');
				setTask((t) => (t?.id === taskId && !isLive(t) && isLive(r.task) ? t : r.task));
				setEvents((es) => merge(r.events, es));
				setFiles(r.artifacts);
				if (!isLive(r.task)) {
					setSnapshot({ id: taskId, data: null, loading: true, error: false });
					void api(`/tasks/${taskId}/snapshot`)
						.then((s) => {
							if (alive) setSnapshot({ id: taskId, data: s.snapshot, loading: false, error: false });
						})
						.catch(() => {
							if (alive) setSnapshot({ id: taskId, data: null, loading: false, error: true });
						});
				}
			})
			.catch((e) => alive && setDetailError(e.message));
		const offE = onEvent((id, e) => {
			if (alive && id === taskId) setEvents((es) => merge(es, [e]));
		});
		const offT = onTask((t) => {
			if (!alive || t.id !== taskId) return;
			setTask(t);
			if (!isLive(t)) setRefresh((v) => v + 1);
		});
		return () => {
			alive = false;
			offE();
			offT();
		};
	}, [taskId, refresh, agent.id]);

	useWatch(agent.id, mode !== 'improve');
	const shownTask = task?.id === taskId ? task : baseTask;
	const live = isLive(baseTask) && baseTask!.status !== 'queued';
	const shot = snapshot?.id === taskId ? snapshot : null;
	const action = async (fn: () => Promise<void>) => {
		setActionError('');
		try {
			await fn();
		} catch (e) {
			setActionError((e as Error).message);
		}
	};
	// Takeover: the agent's live run in any conversation; only its owner drives.
	const busyWith =
		agentTask &&
		isLive(agentTask) &&
		agentTask.kind !== 'browser' &&
		(agentTask.requested_by ?? null) !== (mine ? null : me.id)
			? (agentTask.requested_by_name ?? agent.owner)
			: null;
	const liveAgent = isLive(agentTask) ? agentTask : null;
	const driving = mine && !!liveAgent?.control;
	const navigate = (a: 'open' | 'back' | 'forward' | 'reload', url?: string) =>
		void action(() => api(`/tasks/${liveAgent!.id}/navigate`, { body: { action: a, url } }));
	useEffect(() => {
		if (driving) setTab('browser');
	}, [driving]);
	// «Abrir navegador» opens the maximized browser view; it starts the browser run unless it is on.
	const browserOn = liveAgent?.kind === 'browser';
	const canOpenBrowser = mine && (!liveAgent || browserOn);
	const openBrowser = () =>
		void action(async () => {
			if (!browserOn) await api(`/agents/${agent.id}/browser`, { method: 'POST' });
			setTab('browser');
			onRoute('/browser');
		});

	/** The live run's controls: labelled buttons in the hub, icons in the chat view's bar. */
	const workActions = (compact: boolean) => {
		const Act = ({
			icon,
			label,
			title = label,
			onClick,
			danger,
			primary,
		}: {
			icon: LucideIcon;
			label: string;
			title?: string;
			onClick: () => void;
			danger?: boolean;
			primary?: boolean;
		}) => {
			const Icon = icon;
			return compact ? (
				<IconButton icon={icon} label={title} danger={danger} onClick={onClick} />
			) : (
				<Button
					variant={danger ? 'danger-outline' : primary ? 'default' : 'outline'}
					size="sm"
					title={title}
					aria-label={label}
					onClick={onClick}
				>
					<Icon />
					<span className="agent-action-label">{label}</span>
				</Button>
			);
		};
		return (
			<>
				{shot?.error && <Act icon={RotateCw} label="Reintentar captura" onClick={() => setRefresh((v) => v + 1)} />}
				{mine &&
					liveAgent?.kind === 'task' &&
					['running', 'blocked'].includes(liveAgent.status) &&
					!liveAgent.control && (
						<Act
							icon={Hand}
							label="Tomar control"
							title="Tomar el control del navegador; el agente queda en pausa"
							onClick={() => void action(() => api(`/tasks/${liveAgent.id}/control`, { body: { on: true } }))}
						/>
					)}
				{driving && (
					<>
						<Act
							icon={CreditCard}
							label="Tarjetas"
							title="Guardar tarjetas en el navegador del agente"
							onClick={() => navigate('open', 'chrome://settings/payments')}
						/>
						<Act
							icon={KeyRound}
							label="Contraseñas"
							title="Guardar contraseñas en el navegador del agente"
							onClick={() => navigate('open', 'chrome://password-manager/passwords')}
						/>
					</>
				)}
				{driving && liveAgent!.kind === 'task' && (
					<Act
						icon={Bot}
						label="Devolver control"
						title="Devolver el navegador al agente; sigue desde la página actual"
						primary
						onClick={() => void action(() => api(`/tasks/${liveAgent!.id}/control`, { body: { on: false } }))}
					/>
				)}
				{mine && liveAgent?.kind === 'browser' && (
					<Act
						icon={Square}
						label="Cerrar navegador"
						title="Cerrar y guardar sesiones, contraseñas y tarjetas en el perfil del agente"
						primary
						onClick={() =>
							void action(async () => {
								await api(`/tasks/${liveAgent.id}/close`, { method: 'POST' });
								// Closed from its own view: back to the hub, where the run finishes saving.
								if (mode === 'browser') onRoute('');
							})
						}
					/>
				)}
				{liveAgent && liveAgent.kind !== 'browser' && (directs(liveAgent) || me.admin) && (
					<Act
						icon={Square}
						label="Cancelar tarea"
						danger
						onClick={() =>
							void action(async () => {
								if (confirm('¿Cancelar la tarea? Se guarda lo que lleve.'))
									await api(`/tasks/${liveAgent.id}/cancel`, { method: 'POST' });
							})
						}
					/>
				)}
			</>
		);
	};

	// ---------- the work panels: one place in the hub, the right side of a chat ----------
	const browserRegion = useRef<HTMLDivElement>(null);
	const records = (chatReady && conversationState.pages[openChat!]?.records) || [];
	/** The agent's browser: live, under the owner's control, or the run's last screen. */
	const browserPane = (
		<div className="agent-browser" ref={browserRegion} tabIndex={-1} role="region" aria-label="Navegador del agente">
			<Browser
				fit
				agentId={agent.id}
				taskId={driving ? liveAgent!.id : taskId}
				live={driving || live}
				snapshot={shot?.data}
				loading={shot?.loading}
				error={shot?.error}
				control={driving}
				onNavigate={navigate}
			/>
		</div>
	);
	const footer = (
		<WorkFooter
			task={shownTask ?? null}
			agent={agent}
			chatHref={
				mode === 'hub' && shownTask && shownTask.kind !== 'browser'
					? `#/agent/${agent.id}/chat/${shownTask.conversation_id}`
					: undefined
			}
		/>
	);
	/** The work's tabs; the hub puts its footer under them, the chat view under its input. */
	const workPanels = (toolbarEnd?: ReactNode, withFooter = false) => (
		<>
			{detailError && (
				<div role="alert" className="error mb-3">
					{detailError}{' '}
					<Button size="sm" variant="outline" onClick={() => setRefresh((v) => v + 1)}>
						Reintentar trabajo
					</Button>
				</div>
			)}
			<Tabs
				value={tab}
				onValueChange={(value) => {
					pickedTab.current = taskId; // the owner's pick for this work stays
					setTab(value as Tab);
				}}
				className="agent-tabs"
			>
				<div className="work-toolbar">
					<TabsList aria-label="Detalle del trabajo">
						{(Object.keys(TABS) as Tab[]).map((t) => {
							const { label, icon: Icon } = TABS[t];
							return (
								<TabsTrigger key={t} value={t} aria-label={label} title={label}>
									<Icon aria-hidden="true" />
									<span className="work-tab-label">{label}</span>
								</TabsTrigger>
							);
						})}
					</TabsList>
					{toolbarEnd && (
						<div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">{toolbarEnd}</div>
					)}
				</div>
				<div className="agent-details work-body">
					<TabsContent value="browser" forceMount hidden={tab !== 'browser'} className="work-browser-panel">
						{browserPane}
					</TabsContent>
					<TabsContent value="activity" forceMount hidden={tab !== 'activity'}>
						<Activity events={task?.id === taskId ? events : []} />
					</TabsContent>
					<TabsContent value="terminal" forceMount hidden={tab !== 'terminal'}>
						<Terminal events={task?.id === taskId ? events : []} />
					</TabsContent>
					<TabsContent value="answer" forceMount hidden={tab !== 'answer'}>
						<ScrollArea
							className="work-content-scroll"
							viewportProps={{ tabIndex: 0, 'aria-label': 'Respuesta del trabajo' }}
						>
							<div className="work-content">
								<Answer task={shownTask} files={task?.id === taskId ? files : []} />
							</div>
						</ScrollArea>
					</TabsContent>
				</div>
			</Tabs>
			{withFooter && footer}
		</>
	);

	// ---------- header pieces ----------
	const [settingsRequest, setSettingsRequest] = useState<{ section: 'share'; at: number } | null>(null);
	const settingsButton = (iconOnly: boolean) =>
		(mine || me.admin) && (
			<AgentSettings
				agent={{ ...agent, task: agentTask }}
				settings={settings}
				mine={mine}
				profileReset={profileReset}
				onProfileReset={setProfileReset}
				onChanged={onChanged}
				onDeleted={() => {
					onChanged();
					onBack();
				}}
				iconOnly={iconOnly}
				request={iconOnly ? null : settingsRequest}
			/>
		);
	const header = (
		<AgentHeader
			agent={{ ...agent, task: agentTask }}
			settings={settings}
			mine={mine}
			onBack={mode === 'improve' ? () => onRoute('') : onBack}
			backLabel={mode === 'improve' ? `Volver a ${agent.name}` : 'Volver a agentes'}
			people={crewOf(agent, people)}
			onShare={mine ? () => setSettingsRequest({ section: 'share', at: Date.now() }) : undefined}
		>
			{canOpenBrowser && (
				<Button
					variant="outline"
					size="sm"
					aria-label="Abrir navegador"
					title="Abrir el navegador del agente para iniciar sesión o guardar métodos de pago"
					onClick={openBrowser}
				>
					<Globe />
					<span className="agent-action-label">Abrir navegador</span>
				</Button>
			)}
			{mine && (
				<AutomejoraLink
					agentId={agent.id}
					active={mode === 'improve'}
					designId={mode === 'improve' ? designId : lastDraftId}
				/>
			)}
			{settingsButton(false)}
		</AgentHeader>
	);
	const errors = actionError && (
		<p role="alert" className="error agent-view-error">
			{actionError}
		</p>
	);

	// ---------- the chat view's layout ----------
	const chatView = useRef<HTMLDivElement>(null);
	const [compact, setCompact] = useState(false);
	const [panelOpen, setPanelOpen] = useState(true);
	useLayoutEffect(() => {
		const element = chatView.current;
		if (!element) return;
		const measure = () => element.clientWidth && setCompact(element.clientWidth < 900);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [mode]);
	// The work panel shows once the chat has runs (or the agent works for it right now).
	const hasWork = !!chat && (chat.runs > 0 || records.length > 0 || !!baseTask);
	const showPanel = hasWork && panelOpen;
	const slide = useSlidePanel(showPanel, () => setPanelOpen(false));
	// The peek closed with its X stays closed until the work panel opens again (then closing the
	// panel brings it back), another run starts or another chat opens.
	const [peekClosed, setPeekClosed] = useState(false);
	// The peek shows the browser only when the work really uses it (a blank page that was never used
	// does not count); otherwise its latest activity.
	const peekEvents = task?.id === taskId ? events : [];
	const browserActive =
		driving ||
		(!!shot?.data?.url && shot.data.url !== 'about:blank') ||
		peekEvents.some(
			(e) => e.kind === 'tool' && (e.data.name === 'browser' || /agent-browser/.test(e.data.summary ?? '')),
		);
	// The work's first view: the browser when it uses it; otherwise its terminal (if it ran commands) or
	// its activity. Until the owner picks a tab for this work.
	const ranCommands = peekEvents.some((e) => e.kind === 'tool');
	useEffect(() => {
		if (pickedTab.current === taskId || driving) return;
		setTab(browserActive ? 'browser' : ranCommands ? 'terminal' : 'activity');
	}, [taskId, browserActive, ranCommands, driving]);
	useEffect(() => {
		if (showPanel) setPeekClosed(false);
	}, [showPanel]);
	useEffect(() => setPeekClosed(false), [openChat, baseTask?.id]);
	const page = chatReady ? conversationState.pages[openChat!] : undefined;
	const latest = page?.records?.[page.records.length - 1];
	useEffect(() => {
		// On a narrow screen the panel replaces the chat: start with the chat.
		if (compact) setPanelOpen(false);
	}, [compact, openChat]);

	return (
		<div className={`page agent-view${mode === 'improve' ? ' is-improving' : ''}`} data-view={mode}>
			{mode === 'hub' && (
				<div className="agent-hub">
					{header}
					{errors}
					<section className="current-work" aria-label="Trabajo actual">
						{workPanels(workActions(false), true)}
					</section>
					<HubComposer
						agent={agent}
						canUse={canUse}
						hint={
							busyWith
								? `Ocupado con la tarea de ${busyWith}: tu chat nuevo esperará a que termine.`
								: liveAgent && liveAgent.kind !== 'browser'
									? 'El agente está trabajando: tu chat nuevo esperará su turno.'
									: undefined
						}
						onSent={(c) => {
							setConversations((cs) => [c, ...cs.filter((x) => x.id !== c.id)]);
							onRoute(`/chat/${c.id}`);
						}}
					/>
					<ChatHistory
						agentId={agent.id}
						conversations={conversations}
						loading={listLoading}
						error={listError}
						onRetry={() => setListVersion((v) => v + 1)}
						mine={mine}
						onChanged={() => setListVersion((v) => v + 1)}
					/>
					<RecentFiles agentId={agent.id} version={filesVersion} />
				</div>
			)}
			{mode === 'chat' && (
				<>
					<HeaderSlot>
						<nav aria-label="Ruta" className="flex min-w-0 items-center gap-1 text-sm">
							<a href={`#/agent/${agent.id}`} className="breadcrumb-link">
								{agent.name}
							</a>
							<span className="text-muted-foreground" aria-hidden="true">
								/
							</span>
							<ConversationMenu
								agentId={agent.id}
								conversation={chat}
								conversations={conversations}
								canManage={canUse}
								onImprove={mine && chat ? () => improveWith(agent.id, { id: chat.id, title: chat.title }) : undefined}
								onRename={async (title) => {
									const { conversation } = await api<{ conversation: Conversation }>(
										`/agents/${agent.id}/conversations/${chat!.id}`,
										{ method: 'PATCH', body: { title } },
									);
									setConversations((cs) => cs.map((c) => (c.id === conversation.id ? conversation : c)));
								}}
								onArchive={(archived) =>
									action(async () => {
										// Closing leaves the chat first, so nothing here reopens it.
										if (archived) onRoute('');
										await conversationState.archive(chat!.id, archived);
									})
								}
							/>
						</nav>
						<div className="ml-auto flex shrink-0 items-center gap-0.5" aria-label="Acciones del chat">
							{/* Only the live run's controls, while there is one. */}
							{workActions(true)}
						</div>
					</HeaderSlot>
					{errors}
					<div ref={chatView} className="chat-view" data-panel={showPanel} data-compact={compact}>
						{hasWork && !showPanel && !missingChat && !compact && (
							// Where the panel's own close button was: open it again from the same spot.
							<IconButton
								icon={PanelRightOpen}
								label="Mostrar el trabajo"
								aria-expanded={false}
								className="panel-reopen"
								onClick={() => setPanelOpen(true)}
							/>
						)}
						{hasWork && !showPanel && !missingChat && !peekClosed && (
							// The work panel is hidden: a small live view, top right (or where it was dragged); it opens the
							// panel. The browser when the work uses it; otherwise its latest activity.
							<WorkPeek container={chatView} onOpen={() => setPanelOpen(true)} onClose={() => setPeekClosed(true)}>
								{browserActive ? (
									<Browser
										compact
										agentId={agent.id}
										taskId={driving ? liveAgent!.id : taskId}
										live={driving || live}
										snapshot={shot?.data}
										loading={shot?.loading}
										error={shot?.error}
									/>
								) : (
									<PeekActivity events={peekEvents} live={live} />
								)}
							</WorkPeek>
						)}
						{missingChat ? (
							<div className="empty">
								<p>Ese chat no existe o ya no es de este agente.</p>
								<Button variant="outline" size="sm" className="mt-3" onClick={() => onRoute('')}>
									Ver sus chats
								</Button>
							</div>
						) : (
							(() => {
								const chatPane = (
									<div className="chat-pane">
										{chat && chatReady ? (
											<WorkChat
												key={chat.id}
												agent={{ ...agent, mine: canUse }}
												busyWith={busyWith}
												directs={directs}
												conversation={chat}
												records={page?.records ?? []}
												inputs={page?.inputs ?? []}
												waitingForComputer={isLive(agentTask) && agentTask?.conversation_id !== chat.id}
												task={latest?.task ?? null}
												events={latest?.events ?? []}
												files={latest?.artifacts ?? []}
												historical={false}
												footer={baseTask ? footer : undefined}
												composerActions={
													hasWork && (
														<Button
															type="button"
															variant="outline"
															size="sm"
															aria-label={showPanel ? 'Ocultar el trabajo' : 'Mostrar el trabajo'}
															title={showPanel ? 'Ocultar el trabajo' : 'Mostrar el trabajo'}
															aria-expanded={showPanel}
															onClick={() => setPanelOpen((v) => !v)}
														>
															<span className="work-toggle-icon" data-live={live || undefined}>
																<MonitorPlay aria-hidden="true" />
															</span>
															Trabajo
															{live && <span className="sr-only">(trabajando)</span>}
														</Button>
													)
												}
												active={mode === 'chat' && !artifact && (!compact || !showPanel)}
												loading={!page?.records && !page?.error}
												loadError={page?.error}
												hasEarlier={page?.hasEarlier}
												onLoadEarlier={() => conversationState.load(chat.id, true)}
												onRefresh={() => conversationState.load(chat.id)}
											/>
										) : (
											<p role="status" className="muted p-4">
												Cargando chat…
											</p>
										)}
									</div>
								);
								const workPane = (
									<div className="chat-work">
										{workPanels(
											<IconButton
												icon={PanelRightClose}
												label="Cerrar el trabajo"
												onClick={() => setPanelOpen(false)}
											/>,
										)}
									</div>
								);
								if (!hasWork) return chatPane;
								// Narrow: the panel replaces the chat. Wide: it slides in and out beside it.
								if (compact) return showPanel ? workPane : chatPane;
								return (
									<ResizablePanelGroup
										orientation="horizontal"
										className="chat-split slide-split"
										data-animating={slide.animating}
									>
										<ResizablePanel id="chat-conversation" minSize="22rem">
											{chatPane}
										</ResizablePanel>
										<ResizableHandle
											withHandle
											className="work-resize-handle"
											hidden={!showPanel}
											disabled={!showPanel}
											aria-label="Redimensionar chat y trabajo"
										/>
										<ResizablePanel
											id="chat-work"
											panelRef={slide.ref}
											defaultSize="55%"
											minSize="30%"
											collapsible
											collapsedSize={0}
											onResize={slide.onResize}
										>
											<div className="h-full min-w-0" inert={!showPanel} aria-hidden={!showPanel}>
												{workPane}
											</div>
										</ResizablePanel>
									</ResizablePanelGroup>
								);
							})()
						)}
					</div>
				</>
			)}
			{mode === 'browser' && (
				<>
					<HeaderSlot>
						<nav aria-label="Ruta" className="flex min-w-0 items-center gap-1 text-sm">
							<a href={`#/agent/${agent.id}`} className="breadcrumb-link">
								{agent.name}
							</a>
							<span className="text-muted-foreground" aria-hidden="true">
								/
							</span>
							<span className="truncate px-1.5 font-semibold" aria-current="page">
								Navegador
							</span>
						</nav>
						<div className="ml-auto flex shrink-0 items-center gap-0.5" aria-label="Acciones del navegador">
							{workActions(true)}
							{canOpenBrowser && !browserOn && (
								<IconButton icon={Globe} label="Abrir navegador" onClick={openBrowser} />
							)}
							{mine && <AutomejoraLink agentId={agent.id} designId={lastDraftId} iconOnly />}
							{settingsButton(true)}
						</div>
					</HeaderSlot>
					{errors}
					<div className="browser-focus">{browserPane}</div>
				</>
			)}
			{mode === 'improve' && (
				// A focused chat, like a work chat: its header is the app bar's breadcrumb; the designer's own
				// side panel holds the configuration it works on (contract, skills, tools, schedules).
				<>
					<HeaderSlot>
						<nav aria-label="Ruta" className="flex min-w-0 items-center gap-1 text-sm">
							<a href={`#/agent/${agent.id}`} className="breadcrumb-link">
								{agent.name}
							</a>
							<span className="text-muted-foreground" aria-hidden="true">
								/
							</span>
							<span className="truncate px-1.5 font-semibold" aria-current="page">
								Automejora
							</span>
						</nav>
					</HeaderSlot>
					{errors}
				</>
			)}
			<div className="agent-improvement" hidden={mode !== 'improve'} inert={mode !== 'improve'}>
				{(improvementVisited || improving) && (
					<Suspense
						fallback={
							<p role="status" className="muted py-4">
								Cargando Automejora…
							</p>
						}
					>
						<AgentImprovement
							agent={{ ...agent, task: agentTask }}
							settings={settings}
							mine={mine}
							active={mode === 'improve'}
							designId={mode === 'improve' ? designId : lastDraftId}
							onDraft={(id) => {
								setLastDraftId(id);
								if (improvingNow.current) onRoute(`/improve/${id}`);
							}}
							onResetDraft={() => setLastDraftId(undefined)}
							onChanged={onChanged}
						/>
					</Suspense>
				)}
			</div>
			<ArtifactDrawer target={artifact} agentId={agent.id} onClose={() => onRoute(suffixOf(lastView.current))} />
		</div>
	);
}

/** Newest first: near the top it stays at the top, where the new lines arrive; scrolled down to read
 * something older, the browser's scroll anchoring keeps that place while lines push in above. */
function useStickToTop(dep: unknown) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (el && el.scrollTop < 120) el.scrollTop = 0;
	}, [dep]);
	return ref;
}

function Activity({ events }: { events: TaskEvent[] }) {
	// The newest at the top, pushing the older ones down.
	const shown = events.filter((e) => e.kind !== 'tool_end' && !(e.kind === 'system' && e.data?.stderr)).reverse();
	const ref = useStickToTop(shown.length);
	return (
		<ScrollArea
			className="work-content-scroll"
			viewportProps={{ ref, tabIndex: 0, 'aria-label': 'Actividad del trabajo' }}
		>
			<div className="log work-content">
				{shown.map((e) => (
					<div key={e.id} className={`ev ev-${e.kind}`}>
						<span className="t">{new Date(e.at).toLocaleTimeString('es-MX')}</span>
						<EventBody e={e} />
					</div>
				))}
				{!shown.length && <p className="muted">Nada todavía.</p>}
			</div>
		</ScrollArea>
	);
}

/** The peek without a browser: the work's latest activity, newest first. */
function PeekActivity({ events, live }: { events: TaskEvent[]; live: boolean }) {
	const latest = events
		.filter((e) => e.kind !== 'tool_end' && !(e.kind === 'system' && e.data?.stderr))
		.slice(-6)
		.reverse();
	return (
		<div className="peek-activity">
			<p className="peek-activity-bar">
				<span className={live ? 'peek-activity-dot' : 'peek-activity-dot peek-activity-dot-off'} aria-hidden="true" />
				Actividad
			</p>
			<div className="log peek-activity-log">
				{latest.map((e) => (
					<div key={e.id} className={`ev ev-${e.kind}`}>
						<EventBody e={e} />
					</div>
				))}
				{!latest.length && <p className="muted">Nada todavía.</p>}
			</div>
		</div>
	);
}

function EventBody({ e }: { e: TaskEvent }) {
	switch (e.kind) {
		case 'text':
			return <span className="say">{e.data.text}</span>;
		case 'tool': {
			const Icon =
				e.data.name === 'bash' && /agent-browser/.test(e.data.summary)
					? Globe
					: e.data.name === 'bash'
						? TerminalIcon
						: Pencil;
			return (
				<span className="tool">
					<Icon aria-hidden="true" /> {e.data.summary}
				</span>
			);
		}
		case 'steer':
			return (
				<span className="human">
					<Compass aria-hidden="true" /> Steer: {e.data.text}
				</span>
			);
		case 'follow_up':
			return (
				<span className="human">
					<Plus aria-hidden="true" /> Al terminar: {e.data.text}
				</span>
			);
		case 'blocked':
			return (
				<span className="blocked">
					<Hand aria-hidden="true" /> Atascado: {e.data.reason}
				</span>
			);
		case 'help_answer':
		case 'help_reply':
			return (
				<span className="human">
					<Compass aria-hidden="true" /> Respuesta: {e.data.text}
				</span>
			);
		case 'help_expired':
			return <span className="muted">La solicitud terminó antes de entregar la respuesta.</span>;
		case 'control':
			return (
				<span className="human">
					<Hand aria-hidden="true" />{' '}
					{e.data.browser
						? 'Navegador abierto: el control es de su dueño'
						: e.data.on
							? 'El dueño tomó el control del navegador; el agente queda en pausa'
							: 'El dueño devolvió el control al agente'}
				</span>
			);
		case 'credential':
			return (
				<span className={e.data.ok ? 'tool' : 'error'}>
					<KeyRound aria-hidden="true" />{' '}
					{e.data.ok ? `Usó el acceso «${e.data.name}»` : `Pidió «${e.data.name}»: ${e.data.error}`}
				</span>
			);
		case 'status':
			return (
				<span className="status">
					— {e.data.status}
					{e.data.reason ? `: ${e.data.reason}` : ''}
				</span>
			);
		case 'error':
			return (
				<span className="error">
					<TriangleAlert aria-hidden="true" /> {e.data.message}
				</span>
			);
		default:
			return <span className="muted">{e.data.message ?? JSON.stringify(e.data)}</span>;
	}
}

function Terminal({ events }: { events: TaskEvent[] }) {
	const lines = useMemo(() => events.filter((e) => e.kind === 'tool' || e.kind === 'tool_end'), [events]);
	// The newest command at the top, each one still above its own output.
	const blocks = useMemo(() => {
		const out: TaskEvent[][] = [];
		for (const e of lines) {
			if (e.kind === 'tool' || !out.length) out.push([e]);
			else out.at(-1)!.push(e);
		}
		return out.reverse();
	}, [lines]);
	const ref = useStickToTop(lines.length);
	return (
		<ScrollArea
			className="work-content-scroll work-terminal-scroll"
			viewportProps={{ ref, tabIndex: 0, 'aria-label': 'Terminal del trabajo' }}
		>
			<div className="terminal work-content">
				{blocks.flat().map((e) =>
					e.kind === 'tool' ? (
						<div key={e.id} className="cmd">
							<span className="prompt-sign">
								{e.data.name === 'bash' ? 'agent@agents:~/work$' : `[${e.data.name}]`}
							</span>{' '}
							{e.data.summary}
						</div>
					) : (
						<pre key={e.id} className={e.data.isError ? 'out err' : 'out'}>
							{e.data.output || ' '}
						</pre>
					),
				)}
				{!lines.length && <span className="muted">La terminal es del agente: aquí sólo se ve lo que ejecuta.</span>}
			</div>
		</ScrollArea>
	);
}

/** The answer: the agent's last message, as markdown (no raw HTML), and the files it left in ~/work/out. */
function Answer({ task, files }: { task: Task | null; files: Artifact[] }) {
	if (!task) return <p className="muted pad">Sin tarea.</p>;

	return (
		<div className="result">
			{task.answer ? (
				<ArtifactMarkdown text={task.answer} agentId={task.agent_id} runId={task.id} files={files} />
			) : (
				<p className="muted">
					{isLive(task)
						? 'Todavía trabajando: la respuesta aparece cuando el agente escribe.'
						: 'Esta tarea terminó sin respuesta.'}
				</p>
			)}
			<ArtifactCards files={files} agentId={task.agent_id} runId={task.id} />
		</div>
	);
}
