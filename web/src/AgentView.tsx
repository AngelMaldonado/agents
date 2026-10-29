import { lazy, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, ago, isLive, type Agent, type Artifact, type BrowserSnapshot, type Conversation, type Person, type PublicSettings, type Task, type TaskEvent } from './api';
import { STATE_LABEL } from './Character';
import { AgentHeader, AutomejoraLink, TrabajoLink } from '@/components/agent-header';
import { Browser } from './Browser';
import { onEvent, onTask, useConnected, useTick, useWatch } from './live';
import { AgentSettings } from './AgentSettings';
import { Bot, Compass, CreditCard, Globe, Hand, History, KeyRound, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Radio, RotateCw, Square, Terminal as TerminalIcon, TriangleAlert } from 'lucide-react';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WorkChat } from '@/components/work-chat';
import { useWorkConversations } from '@/lib/use-work-conversations';
import { ArtifactCards, ArtifactDrawer, ArtifactMarkdown, type ArtifactTarget } from '@/components/artifacts';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

type Tab = 'browser' | 'activity' | 'terminal' | 'answer';
const AgentImprovement = lazy(() => import('./AgentImprovement').then(module => ({ default: module.AgentImprovement })));

export function AgentView({ agent, me, settings, onBack, onChanged, improving = false, designId, onViewChange, artifact = null }: {
	agent: Agent; me: Person; settings: PublicSettings; onBack: () => void; onChanged: () => void;
	improving?: boolean; designId?: string; artifact?: ArtifactTarget | null; onViewChange: (view: 'work' | 'improve', draft?: string) => void;
}) {
	useTick(1000);
	const mine = agent.person_id === me.id;
	// Shared with me: I run tasks (chat, answers, queue); improving, configuring and driving its browser are the owner's.
	const canUse = mine || !!agent.shares?.includes(me.id);
	const root = useRef<HTMLDivElement>(null);
	const surface = useRef<HTMLDivElement>(null), chatPanel = useRef<HTMLElement>(null), chatToggle = useRef<HTMLButtonElement>(null);
	const chatId = useId();
	const [chatOpen, setChatOpen] = useState<boolean | null>(null);
	const [compactWork, setCompactWork] = useState(false);
	const splitChat = useRef<PanelImperativeHandle>(null), lastChatWidth = useRef<number | string>('28rem');
	const [animatingChat, setAnimatingChat] = useState(false);
	useEffect(() => {
		if (!animatingChat) return;
		const timeout = setTimeout(() => setAnimatingChat(false), 260);
		return () => clearTimeout(timeout);
	}, [animatingChat, chatOpen]);
	useLayoutEffect(() => {
		if (compactWork || chatOpen === false) splitChat.current?.collapse();
		else if (chatOpen) splitChat.current?.resize(lastChatWidth.current);
	}, [chatOpen, compactWork]);
	useLayoutEffect(() => {
		const element = surface.current!;
		const measure = () => {
			if (!element.clientWidth) return;
			const compact = element.clientWidth < 900;
			setCompactWork(compact);
			if (root.current) element.style.setProperty('--work-overlay-offset', `${Math.max(0, element.getBoundingClientRect().top - root.current.getBoundingClientRect().top - parseFloat(getComputedStyle(root.current).paddingTop))}px`);
			setChatOpen(value => value ?? !compact);
		};
		measure(); const observer = new ResizeObserver(measure); observer.observe(element);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		// A resize can turn the docked panel into an overlay while focus is in the preview.
		if (compactWork && chatOpen && !improving && surface.current?.querySelector('.work-preview-column')?.contains(document.activeElement)) chatPanel.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
	}, [compactWork, chatOpen, improving]);
	const closeChat = () => {
		const returnFocus = chatPanel.current?.contains(document.activeElement);
		setAnimatingChat(true); setChatOpen(false);
		if (returnFocus) requestAnimationFrame(() => chatToggle.current?.focus({ preventScroll: true }));
	};
	const toggleChat = () => {
		if (chatOpen) closeChat();
		else {
			setAnimatingChat(true); setChatOpen(true);
			requestAnimationFrame(() => {
				const chat=chatPanel.current?.querySelector<HTMLElement>('.conversation-chat:not([hidden]) .work-chat, .conversation-chats > .work-chat');
				(chat?.querySelector<HTMLElement>('textarea:not(:disabled)')??chat?.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]'))?.focus({preventScroll:true});
			});
		}
	};
	const [improvementVisited, setImprovementVisited] = useState(improving);
	const [lastDraftId, setLastDraftId] = useState(designId);
	const improvingNow = useRef(improving);
	improvingNow.current = improving;
	const previousMode = useRef(improving);
	useEffect(() => {
		if (improving) { setImprovementVisited(true); setLastDraftId(designId); }
		// Full browser/events streaming is paused in improvement mode. Catch up on return,
		// without replacing an explicitly selected immutable historical snapshot.
		if (previousMode.current && !improving && !historical) setRefresh(v => v + 1);
		if (previousMode.current !== improving && (document.activeElement === document.body || root.current?.querySelector('[hidden]')?.contains(document.activeElement))) {
			root.current?.querySelector<HTMLAnchorElement>('.agent-view-navigation a[aria-current="page"]')?.focus({ preventScroll: true });
		}
		previousMode.current = improving;
	}, [improving, designId]);
	const [history, setHistory] = useState<Task[]>([]);
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [conversations,setConversations]=useState<Conversation[]>([]);
	const [conversationsLoaded,setConversationsLoaded]=useState(false);
	const conversationState=useWorkConversations({...agent,mine:canUse},me.id,conversations,setConversations,conversationsLoaded,!improving);
	const currentTask=conversationState.currentTask;
	const historical = selectedId !== null;
	const taskId = selectedId ?? currentTask?.id ?? null;
	const [snapshot, setSnapshot] = useState<{ id: number; data: BrowserSnapshot | null; loading: boolean; error: boolean } | null>(null);
	const [detailError, setDetailError] = useState('');
	const [actionError, setActionError] = useState('');
	const [refresh, setRefresh] = useState(0);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [historyLoading, setHistoryLoading] = useState(true);
	const [historyError, setHistoryError] = useState('');
	const [historyVersion, setHistoryVersion] = useState(0);
	const browserRegion = useRef<HTMLDivElement>(null);
	const selectedFromHistory = useRef(false);
	const [task, setTask] = useState<Task | null>(agent.task);
	const [events, setEvents] = useState<TaskEvent[]>([]);
	const [files, setFiles] = useState<Artifact[]>([]);
	const [tab, setTab] = useState<Tab>('browser');

	const [profileReset, setProfileReset] = useState(false);
	useEffect(() => {
		let alive = true;
		setHistoryLoading(true); setHistoryError('');
		Promise.all([conversationState.loadList(), api(`/agents/${agent.id}/tasks`)]).then(([c, r]) => {
			if (!alive) return;
			setConversationsLoaded(true); setProfileReset(c.profileResetPending);
			setHistory(r.tasks.filter((t: Task) => !isLive(t) && t.kind !== 'initialize'));
		}).catch(e => alive && setHistoryError(e.message)).finally(() => alive && setHistoryLoading(false));
		return () => { alive = false; };
	}, [agent.id, historyVersion]);
	useEffect(() => onTask(t => { if (t.agent_id === agent.id && !isLive(t)) setHistoryVersion(v => v + 1); }), [agent.id]);

	const connected = useConnected();
	useEffect(() => { if (connected) {setRefresh(v => v + 1);void conversationState.refresh();} }, [connected]);
	useEffect(() => {
		let alive = true;
		setDetailError(''); setEvents([]); setFiles([]); setSnapshot(null);
		if (!taskId) { setTask(null); return; }
		const merge = (a: TaskEvent[], b: TaskEvent[]) => [...new Map([...a, ...b].map(e => [e.id, e])).values()].sort((a, b) => a.id - b.id);
		api(`/tasks/${taskId}`).then(r => {
			if (!alive) return;
			if (r.task?.id !== taskId || r.task.agent_id !== agent.id) throw new Error('No se pudo cargar este trabajo.');
			setTask(t => t?.id === taskId && !isLive(t) && isLive(r.task) ? t : r.task);
			setEvents(es => merge(r.events, es)); setFiles(r.artifacts);
			if (!isLive(r.task)) {
				setSnapshot({ id: taskId, data: null, loading: true, error: false });
				void api(`/tasks/${taskId}/snapshot`).then(s => {
					if (alive) setSnapshot({ id: taskId, data: s.snapshot, loading: false, error: false });
				}).catch(() => { if (alive) setSnapshot({ id: taskId, data: null, loading: false, error: true }); });
			}
		}).catch(e => alive && setDetailError(e.message));
		const offE = historical ? () => {} : onEvent((id, e) => { if (alive && id === taskId) setEvents(es => merge(es, [e])); });
		const offT = historical ? () => {} : onTask(t => {
			if (!alive || t.id !== taskId) return;
			setTask(t);
			if (!isLive(t)) {
				setRefresh(v => v + 1);
			}
		});
		return () => { alive = false; offE(); offT(); };
	}, [taskId, historical, refresh, agent.id]);

	useWatch(agent.id, !historical && !improving);
	const shownTask = task?.id === taskId ? task : !historical ? currentTask : null;
	const live = !historical && isLive(currentTask) && currentTask!.status !== 'queued';
	const elapsed = shownTask?.started_at ? Math.max(0, Math.round(((shownTask.ended_at ?? Date.now()) - shownTask.started_at) / 1000)) : 0;
	const shot = snapshot?.id === taskId ? snapshot : null;
	const selectCurrent = () => { setSelectedId(null); setDetailError(''); if (improving) onViewChange('work'); };
	const focusConversation=()=>requestAnimationFrame(()=>{
		if(improvingNow.current||chatPanel.current?.inert)return;
		const focused=document.activeElement;
		if(focused!==document.body&&!focused?.closest('.conversation-tabs,[role="menu"]'))return;
		const target=root.current?.querySelector<HTMLButtonElement>('.conversation-chat:not([hidden]) .conversation-tabs [aria-current="page"], .conversation-chats > .work-chat .conversation-tabs button[aria-label="Nueva conversación"]');
		target?.focus({preventScroll:true});
	});
	const selectConversation=async(id:number)=>{setSelectedId(null);setDetailError('');await conversationState.select(id);focusConversation();};
	const createConversation=async()=>{setSelectedId(null);setDetailError('');await conversationState.create();focusConversation();};
	const archiveConversation=async(id:number,archived:boolean)=>{await conversationState.archive(id,archived);focusConversation();};
	const refreshConversation=async()=>{await conversationState.refresh();setRefresh(v=>v+1);};
	const action = async (fn: () => Promise<void>) => { setActionError(''); try { await fn(); } catch (e) { setActionError((e as Error).message); } };
	// Takeover: the agent's live run in any conversation; only its owner drives.
	const agentTask = conversationState.agentTask;
	const liveAgent = !historical && isLive(agentTask) ? agentTask : null;
	const driving = mine && !!liveAgent?.control;
	const navigate = (a: 'open' | 'back' | 'forward' | 'reload', url?: string) => void action(() => api(`/tasks/${liveAgent!.id}/navigate`, { body: { action: a, url } }));
	useEffect(() => { if (driving) setTab('browser'); }, [driving]);

	return (
		<div ref={root} className={`page agent-view${improving ? ' is-improving' : ''}`} data-view={improving ? 'improve' : 'work'}>
			<div className="min-w-0 shrink-0" inert={!improving && compactWork && !!chatOpen} aria-hidden={!improving && compactWork && !!chatOpen}><AgentHeader agent={{ ...agent, task: historical ? shownTask : currentTask }} settings={settings} mine={mine} onBack={onBack} work={improving || !shownTask ? undefined : { task: shownTask, historical, elapsed }}>
					{shot?.error && <Button variant="outline" size="sm" aria-label="Reintentar captura" title="Reintentar captura" onClick={() => setRefresh(v => v + 1)}><RotateCw /><span className="agent-action-label">Reintentar captura</span></Button>}
					{historical && <Button variant="outline" size="sm" onClick={selectCurrent} aria-label="Volver al trabajo actual" title="Volver al trabajo actual"><Radio /><span className="agent-action-label">Trabajo actual</span></Button>}
					{mine && !historical && !liveAgent && !improving && <Button variant="outline" size="sm" aria-label="Abrir navegador" title="Abrir el navegador del agente para iniciar sesión o guardar métodos de pago" onClick={() => void action(async () => { await api(`/agents/${agent.id}/browser`, { method: 'POST' }); setTab('browser'); })}><Globe /><span className="agent-action-label">Abrir navegador</span></Button>}
					{mine && liveAgent?.kind === 'task' && ['running', 'blocked'].includes(liveAgent.status) && !liveAgent.control && <Button variant="outline" size="sm" aria-label="Tomar control" title="Tomar el control del navegador; el agente queda en pausa" onClick={() => void action(() => api(`/tasks/${liveAgent.id}/control`, { body: { on: true } }))}><Hand /><span className="agent-action-label">Tomar control</span></Button>}
					{driving && <>
						<Button variant="outline" size="sm" aria-label="Tarjetas guardadas" title="Guardar tarjetas en el navegador del agente" onClick={() => navigate('open', 'chrome://settings/payments')}><CreditCard /><span className="agent-action-label">Tarjetas</span></Button>
						<Button variant="outline" size="sm" aria-label="Contraseñas guardadas" title="Guardar contraseñas en el navegador del agente" onClick={() => navigate('open', 'chrome://password-manager/passwords')}><KeyRound /><span className="agent-action-label">Contraseñas</span></Button>
					</>}
					{driving && liveAgent!.kind === 'task' && <Button size="sm" aria-label="Devolver control" title="Devolver el navegador al agente; sigue desde la página actual" onClick={() => void action(() => api(`/tasks/${liveAgent!.id}/control`, { body: { on: false } }))}><Bot /><span className="agent-action-label">Devolver control</span></Button>}
					{mine && liveAgent?.kind === 'browser' && <Button size="sm" aria-label="Cerrar navegador" title="Cerrar y guardar sesiones, contraseñas y tarjetas en el perfil del agente" onClick={() => void action(() => api(`/tasks/${liveAgent.id}/close`, { method: 'POST' }))}><Square /><span className="agent-action-label">Cerrar navegador</span></Button>}
					{!historical && isLive(currentTask) && currentTask!.kind !== 'browser' && (canUse || me.admin) && <Button variant="danger-outline" size="sm" aria-label="Cancelar tarea" title="Cancelar tarea" onClick={() => void action(async () => {
						if (confirm('¿Cancelar la tarea? Se guarda lo que lleve.')) await api(`/tasks/${currentTask!.id}/cancel`, { method: 'POST' });
					})}><Square /><span className="agent-action-label">Cancelar tarea</span></Button>}
					<Dialog open={historyOpen} onOpenChange={open => { setHistoryOpen(open); if (open) setHistoryVersion(v => v + 1); }}>
						<DialogTrigger asChild><Button variant="outline" size="sm" aria-label="Historial de trabajos" title="Historial de trabajos"><History /><span className="agent-action-label">Historial</span><span className="text-muted-foreground text-xs">{history.length}</span></Button></DialogTrigger>
						<DialogContent className="sm:max-w-2xl" onCloseAutoFocus={e => { if (selectedFromHistory.current) { e.preventDefault(); selectedFromHistory.current = false; requestAnimationFrame(() => browserRegion.current?.focus()); } }}>
							<DialogHeader><DialogTitle>Historial de trabajos</DialogTitle><DialogDescription>Trabajos recientes finalizados, agrupados por conversación. Abre uno para ver su snapshot de sólo lectura.</DialogDescription></DialogHeader>
							{historyError ? <div role="alert" className="error">{historyError}<Button variant="outline" size="sm" onClick={() => setHistoryVersion(v => v + 1)}>Reintentar historial</Button></div> : historyLoading ? <p role="status" className="muted">Cargando historial…</p> : <div className="history">
								{[...conversations.map(c => ({ key: c.id, label: `${c.title||'Conversación'}${c.archived_at ? ' · Tab cerrado' : ''} · ${new Date(c.started_at).toLocaleString('es-MX')}`, runs: history.filter(t => t.conversation_id === c.id) })), { key: 0, label: 'Otros trabajos', runs: history.filter(t => !conversations.some(c => c.id === t.conversation_id)) }].filter(c => c.runs.length).map(c => <section className="conversation" key={c.key} aria-label={c.label}>
									<h3 className="muted small">{c.label}</h3>
									{c.runs.map(t => <Button key={t.id} variant="outline" className={`history-row h-auto! items-stretch justify-start whitespace-normal px-3 py-3 ${t.id === selectedId ? 'on' : ''}`} aria-current={t.id === selectedId ? 'true' : undefined} onClick={() => { selectedFromHistory.current = true; setSelectedId(t.id); setTab('browser'); setHistoryOpen(false); if (improving) onViewChange('work'); }}>
										<span className="history-run"><span className={`pill s-${t.status}`}>#{t.id} · {STATE_LABEL[t.status as keyof typeof STATE_LABEL] ?? t.status}</span><span className="muted small">{ago(t.ended_at ?? t.created_at)} · US${t.cost.toFixed(3)}</span></span>
										<span className="history-prompt">{t.prompt}</span>
									</Button>)}
								</section>)}
								{!history.length && <p className="muted">Todavía no hay trabajos finalizados.</p>}
							</div>}
						</DialogContent>
					</Dialog>
					<nav className="agent-view-navigation contents" aria-label="Vista del agente"><TrabajoLink agentId={agent.id} active={!improving} />{mine && <AutomejoraLink agentId={agent.id} active={improving} designId={improving ? designId : lastDraftId} />}</nav>
					{(mine || me.admin) && <AgentSettings agent={{ ...agent, task: conversationState.agentTask }} settings={settings} mine={mine} profileReset={profileReset} onProfileReset={setProfileReset} onChanged={onChanged} onDeleted={() => { onChanged(); onBack(); }} />}
			</AgentHeader></div>
			{actionError && <p role="alert" className="error mb-3">{actionError}</p>}
			<div className="agent-work" hidden={improving} inert={improving} onKeyDown={e => { if (e.key === 'Escape' && !e.defaultPrevented && chatOpen) { e.preventDefault(); closeChat(); } }}>
			{detailError && <div role="alert" className="error mb-3">{detailError} <Button size="sm" variant="outline" onClick={() => setRefresh(v => v + 1)}>Reintentar trabajo</Button></div>}
			<Tabs value={tab} onValueChange={value => setTab(value as Tab)} className="agent-tabs">
				<div ref={surface} className="work-surface" data-compact={compactWork} data-chat-open={!!chatOpen}>
					{compactWork && <button type="button" className="work-chat-backdrop" tabIndex={-1} aria-hidden="true" onClick={closeChat} />}
					<ResizablePanelGroup orientation="horizontal" className="work-split" style={{overflow:'visible'}} data-animating={animatingChat} onPointerDownCapture={e=>{if((e.target as HTMLElement).closest('[role="separator"]'))setAnimatingChat(false);}} onLayoutChanged={(_layout,meta)=>{
						if (!meta.isUserInteraction || compactWork) return;
						const collapsed=splitChat.current?.isCollapsed();
						if (collapsed) closeChat();
						else { lastChatWidth.current=splitChat.current!.getSize().inPixels; setChatOpen(true); }
					}}>
					<ResizablePanel id="work-conversation" panelRef={splitChat} defaultSize="28rem" minSize={compactWork ? '3rem' : '20rem'} maxSize={compactWork ? '3rem' : '45%'} collapsible collapsedSize="3rem" groupResizeBehavior="preserve-pixel-size" style={{overflow:'visible'}}>
					<div className="work-sidebar-frame" data-state={chatOpen ? 'open' : 'closed'}>
						<div className="work-chat-rail" hidden={!!chatOpen}><Button ref={chatToggle} variant="ghost" size="icon" onClick={toggleChat} aria-label="Mostrar chat" title="Mostrar chat" aria-expanded={!!chatOpen} aria-controls={chatId}><PanelLeftOpen aria-hidden="true" />{shownTask?.status==='blocked' && <span className="work-help-dot" aria-label="El agente espera tu respuesta" />}</Button></div>
						<aside id={chatId} ref={chatPanel} className="work-sidebar" aria-label="Chat del agente" aria-hidden={!chatOpen} inert={!chatOpen}>
							<div className="work-sidebar-header"><Button variant="ghost" size="icon" aria-label="Cerrar chat" title="Ocultar chat" aria-expanded={!!chatOpen} aria-controls={chatId} onClick={closeChat}><PanelLeftClose aria-hidden="true" /></Button><h2 className="min-w-0 flex-1 text-xs">Conversación</h2></div>
							<div className="conversation-chats">
							{Object.keys(conversationState.pages).map(Number).map(id=>{
							 const c=conversations.find(c=>c.id===id),page=conversationState.pages[id];if(!c)return null;
							 const selected=id===conversationState.selected&&!historical&&(!mine||!c.archived_at),records=page.records??[],latest=records[records.length-1];
							 return <div key={id} className="conversation-chat" hidden={!selected} inert={!selected} aria-hidden={!selected}><WorkChat agent={{...agent,mine:canUse}} conversation={c} conversations={conversations} records={records} inputs={page.inputs??[]} waitingForComputer={isLive(conversationState.agentTask)&&conversationState.agentTask?.conversation_id!==id} task={latest?.task??null} events={latest?.events??[]} files={latest?.artifacts??[]} historical={false} active={selected&&!improving&&!!chatOpen&&!artifact} loading={!page.records&&!page.error} loadError={page.error} hasEarlier={page.hasEarlier} onLoadEarlier={()=>conversationState.load(id,true)} onRefresh={()=>conversationState.load(id)} onSelect={selectConversation} onCreate={createConversation} onArchive={archiveConversation}/></div>;
							})}
							{!historical&&(!conversationState.selectedConversation||(canUse&&!!conversationState.selectedConversation.archived_at))&&<WorkChat agent={{...agent,mine:canUse}} conversations={conversations} task={null} events={[]} files={[]} historical={false} active={!improving&&!!chatOpen&&!artifact} loading={!conversationsLoaded} loadError={historyError} onRefresh={async()=>{setHistoryVersion(v=>v+1);}} onSelect={selectConversation} onCreate={createConversation} onArchive={archiveConversation}/>}
							{historical&&<WorkChat key={`historical:${taskId}`} agent={{...agent,mine}} task={shownTask} events={task?.id===taskId?events:[]} files={task?.id===taskId?files:[]} historical active={!improving&&!!chatOpen&&!artifact} loading={!!taskId&&task?.id!==taskId} onRefresh={refreshConversation}/>}
							</div>
						</aside>
					</div>
					</ResizablePanel>
					<ResizableHandle withHandle hidden={compactWork || !chatOpen} disabled={compactWork || !chatOpen} className="work-resize-handle" aria-label="Redimensionar chat y navegador" />
					<ResizablePanel id="work-preview" minSize={compactWork ? 0 : '45%'}>
					<div className="work-preview-column agent-details" inert={compactWork && !!chatOpen} aria-hidden={compactWork && !!chatOpen}>
						<div className="work-toolbar"><TabsList aria-label="Detalle del agente">{(['browser','activity','terminal','answer'] as Tab[]).map(t=><TabsTrigger key={t} value={t}>{{browser:'Navegador',activity:'Actividad',terminal:'Terminal',answer:'Respuesta'}[t]}</TabsTrigger>)}</TabsList></div>
						<TabsContent value="browser" forceMount hidden={tab!=='browser'} className="work-browser-panel"><div className="agent-browser" ref={browserRegion} tabIndex={-1} role="region" aria-label={historical ? `Snapshot del trabajo #${taskId}` : 'Navegador del agente'}><Browser fit agentId={agent.id} taskId={driving ? liveAgent!.id : taskId} live={driving || live} historical={historical} snapshot={shot?.data} loading={shot?.loading || (historical && !shownTask && !detailError)} error={shot?.error} control={driving} onNavigate={navigate} /></div></TabsContent>
						<TabsContent value="activity" forceMount hidden={tab!=='activity'}><Activity events={task?.id===taskId ? events : []} /></TabsContent>
						<TabsContent value="terminal" forceMount hidden={tab!=='terminal'}><Terminal events={task?.id===taskId ? events : []} /></TabsContent>
						<TabsContent value="answer" forceMount hidden={tab!=='answer'}><ScrollArea className="work-content-scroll" viewportProps={{tabIndex:0,'aria-label':'Respuesta del trabajo'}}><div className="work-content"><Answer task={shownTask} files={task?.id===taskId ? files : []} /></div></ScrollArea></TabsContent>
					</div>
					</ResizablePanel>
					</ResizablePanelGroup>
				</div>
			</Tabs>
			</div>
			<div className="agent-improvement" hidden={!improving} inert={!improving}>
				{(improvementVisited || improving) && <Suspense fallback={<p role="status" className="muted py-4">Cargando Automejora…</p>}><AgentImprovement agent={{ ...agent, task: conversationState.agentTask }} settings={settings} mine={mine} active={improving} designId={improving ? designId : lastDraftId} onDraft={id => { setLastDraftId(id); if (improvingNow.current) onViewChange('improve', id); }} onResetDraft={() => setLastDraftId(undefined)} onChanged={onChanged} /></Suspense>}
			</div>
			<ArtifactDrawer target={artifact} agentId={agent.id} onClose={()=>onViewChange('work')} />
		</div>
	);
}

function useAutoScroll(dep: unknown) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
	}, [dep]);
	return ref;
}

function Activity({ events }: { events: TaskEvent[] }) {
	const shown = events.filter((e) => e.kind !== 'tool_end' && !(e.kind === 'system' && e.data?.stderr));
	const ref = useAutoScroll(shown.length);
	return (
		<ScrollArea className="work-content-scroll" viewportProps={{ref,tabIndex:0,'aria-label':'Actividad del trabajo'}}><div className="log work-content">
			{shown.map((e) => (
				<div key={e.id} className={`ev ev-${e.kind}`}>
					<span className="t">{new Date(e.at).toLocaleTimeString('es-MX')}</span>
					<EventBody e={e} />
				</div>
			))}
			{!shown.length && <p className="muted">Nada todavía.</p>}
		</div></ScrollArea>
	);
}

function EventBody({ e }: { e: TaskEvent }) {
	switch (e.kind) {
		case 'text':
			return <span className="say">{e.data.text}</span>;
		case 'tool': {
			const Icon = e.data.name === 'bash' && /agent-browser/.test(e.data.summary) ? Globe : e.data.name === 'bash' ? TerminalIcon : Pencil;
			return <span className="tool"><Icon aria-hidden="true" /> {e.data.summary}</span>;
		}
		case 'steer':
			return <span className="human"><Compass aria-hidden="true" /> Steer: {e.data.text}</span>;
		case 'follow_up':
			return <span className="human"><Plus aria-hidden="true" /> Al terminar: {e.data.text}</span>;
		case 'blocked':
			return <span className="blocked"><Hand aria-hidden="true" /> Atascado: {e.data.reason}</span>;
		case 'help_answer':
		case 'help_reply':
			return <span className="human"><Compass aria-hidden="true" /> Respuesta: {e.data.text}</span>;
		case 'help_expired':
			return <span className="muted">La solicitud terminó antes de entregar la respuesta.</span>;
		case 'control':
			return <span className="human"><Hand aria-hidden="true" /> {e.data.browser ? 'Navegador abierto: el control es de su dueño' : e.data.on ? 'El dueño tomó el control del navegador; el agente queda en pausa' : 'El dueño devolvió el control al agente'}</span>;
		case 'credential':
			return <span className={e.data.ok ? 'tool' : 'error'}><KeyRound aria-hidden="true" /> {e.data.ok ? `Usó el acceso «${e.data.name}»` : `Pidió «${e.data.name}»: ${e.data.error}`}</span>;
		case 'status':
			return <span className="status">— {e.data.status}{e.data.reason ? `: ${e.data.reason}` : ''}</span>;
		case 'error':
			return <span className="error"><TriangleAlert aria-hidden="true" /> {e.data.message}</span>;
		default:
			return <span className="muted">{e.data.message ?? JSON.stringify(e.data)}</span>;
	}
}

function Terminal({ events }: { events: TaskEvent[] }) {
	const lines = useMemo(() => events.filter((e) => (e.kind === 'tool' || e.kind === 'tool_end')), [events]);
	const ref = useAutoScroll(lines.length);
	return (
		<ScrollArea className="work-content-scroll work-terminal-scroll" viewportProps={{ref,tabIndex:0,'aria-label':'Terminal del trabajo'}}><div className="terminal work-content">
			{lines.map((e) =>
				e.kind === 'tool' ? (
					<div key={e.id} className="cmd">
						<span className="prompt-sign">{e.data.name === 'bash' ? 'agent@agents:~/work$' : `[${e.data.name}]`}</span> {e.data.summary}
					</div>
				) : (
					<pre key={e.id} className={e.data.isError ? 'out err' : 'out'}>{e.data.output || ' '}</pre>
				)
			)}
			{!lines.length && <span className="muted">La terminal es del agente: aquí sólo se ve lo que ejecuta.</span>}
		</div></ScrollArea>
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
				<p className="muted">{isLive(task) ? 'Todavía trabajando: la respuesta aparece cuando el agente escribe.' : 'Esta tarea terminó sin respuesta.'}</p>
			)}
			<ArtifactCards files={files} agentId={task.agent_id} runId={task.id} />
		</div>
	);
}
