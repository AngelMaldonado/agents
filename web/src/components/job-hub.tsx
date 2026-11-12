// A trabajo's page (#/agent/:id/job/:conversation), like a card opened in Notion or Trello: its objective as the
// title, its properties (state, progress, what goes on now, origin, dates, recipe, evaluation), a description
// that gathers the long text, its to-dos first; then, secondary, its flow of nodes, its saga and its
// Conversaciones (its WhatsApp chats, encargos included: a page of their own). An encargo's detail still opens
// from its route (/encargos/:id), as Configuración's table and a chat's encargo link do. Lists of tasks,
// encargos and chats are its owner's; whoever it is shared with sees the rest.
import { lazy, Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
	ArrowLeft,
	BookOpen,
	CalendarDays,
	ChevronRight,
	CircleDot,
	ClipboardCheck,
	ListChecks,
	LoaderCircle,
	MessageSquare,
	MessagesSquare,
	Network,
	Pencil,
	RotateCcw,
	ScrollText,
	Square,
	ThumbsDown,
	ThumbsUp,
	Target,
	Timer,
	Wallet,
	type LucideIcon,
} from 'lucide-react';
import { api, ago, type Conversation } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { OptionSelect } from '@/components/option-select';
import { ChannelIcon } from '@/components/channel-icon';
import { CLOSE_JOB, JobStatusBadge, RubricDialog, scoreClass, useJob } from '@/components/job-bar';
import { useConfirm } from '@/components/confirm-dialog';
import { SlideStack } from '@/components/slide-stack';
import { SmoothHeight } from '@/components/smooth-height';
import { JobTasks } from '@/components/job-tasks';
import { GOAL_MODE_EXPLAIN } from '@/components/goal-mode';
import { AgentDelegations, DelegationDetail } from '@/components/agent-delegations';
import { TaskMeter } from '@/components/task-meter';

// The canvas (React Flow) loads only when a page shows it.
const FlowDetail = lazy(() => import('@/components/agent-flows').then((m) => ({ default: m.FlowDetail })));

export type JobTab = 'flujo' | 'saga' | 'conversaciones' | 'encargos';
type FlowItem = { id: number; title: string; status: string; conversation_id: number | null; created_at: string };
type FlowInfo = {
	flow: {
		status: string;
		recipe: { name: string } | null;
		waiting_for: string | null;
		waiting_since: string | null;
		summary: string | null;
		end_reason: string | null;
	};
	facts: { source: string; text: string; at: string }[];
};
const date = (ms: number) =>
	new Date(ms).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });

export function JobHub({
	agentId,
	agentName,
	conversation,
	mine,
	tab,
	item,
	onRoute,
	onChanged,
}: {
	agentId: number;
	agentName: string;
	conversation: Conversation;
	/** Its owner: lists of tasks and encargos are theirs. */
	mine: boolean;
	tab?: JobTab;
	/** The encargo open in «Encargos», or the list of tasks shown in «Flujo» and «Saga». */
	item?: number;
	onRoute: (suffix: string) => void;
	onChanged: () => void;
}) {
	const id = conversation.id;
	// The quick access open (a modal), as in its route.
	// «Conversaciones» is a page of its own (AgentChats), not a modal.
	const shown: JobTab | null = tab && mine && tab !== 'conversaciones' ? tab : null;
	const go = (t: JobTab, i?: number) => onRoute(`/job/${id}/${t}${i ? `/${i}` : ''}`);
	const { v, error: jobError, busy, act, refresh } = useJob(agentId, conversation, onChanged);
	const [flows, setFlows] = useState<FlowItem[] | null>(null);
	const [info, setInfo] = useState<FlowInfo | null>(null);
	const [error, setError] = useState('');
	const [rubric, setRubric] = useState(false);
	const [editing, setEditing] = useState(false),
		[goal, setGoal] = useState('');
	const [tasksOpen, setTasksOpen] = useState(false);
	const [budget, setBudget] = useState<{ usd: string; turns: string } | null>(null);
	const [ask, confirmDialog] = useConfirm();
	// A task picked in the saga: shown selected on the canvas.
	const [picked, setPicked] = useState<string | null>(null);
	useEffect(() => {
		if (!mine) return;
		let gone = false;
		const load = () =>
			api<{ flows: FlowItem[] }>(`/agents/${agentId}/flows`)
				.then((f) => {
					if (gone) return;
					setFlows(f.flows.filter((x) => x.conversation_id === id));
				})
				.catch((e) => !gone && setError((e as Error).message));
		void load();
		const timer = setInterval(load, 15_000);
		return () => {
			gone = true;
			clearInterval(timer);
		};
	}, [agentId, id, mine]);
	// The list shown: the one in the route, else the running one, else the latest.
	const flowId =
		((shown === 'flujo' || shown === 'saga') && item && flows?.some((f) => f.id === item) ? item : null) ??
		flows?.find((f) => f.status === 'running')?.id ??
		flows?.[0]?.id ??
		null;
	// What the description says about the list: where it waits, its summary, what is established.
	useEffect(() => {
		if (!flowId) return setInfo(null);
		let gone = false;
		const load = () =>
			api<FlowInfo>(`/agents/${agentId}/flows/${flowId}`)
				.then((r) => !gone && setInfo(r))
				.catch(() => {});
		void load();
		const timer = setInterval(load, 15_000);
		return () => {
			gone = true;
			clearInterval(timer);
		};
	}, [agentId, flowId]);
	const j = v?.job;
	const ended = !!j && j.status !== 'open';
	const e = v?.evaluation ?? null;
	const tasks = conversation.tasks ?? 0,
		done = conversation.tasks_done ?? 0;
	const stopFlow = async (flow: number) => {
		if (
			!(await ask({
				title: '¿Detener esta lista de tareas?',
				description: 'Sus encargos en curso se cancelan y el agente deja de despertar por ella.',
				action: 'Detener',
				destructive: true,
			}))
		)
			return;
		try {
			await api(`/agents/${agentId}/flows/${flow}/stop`, { method: 'POST' });
			setInfo((cur) => (cur ? { ...cur, flow: { ...cur.flow, status: 'cancelled' } } : cur));
		} catch (x) {
			setError((x as Error).message);
		}
	};
	const saveGoal = async (ev: FormEvent) => {
		ev.preventDefault();
		if (await act('goal', { goal })) setEditing(false);
	};
	return (
		<article className="job-page" aria-label={`Trabajo ${id}`}>
			{confirmDialog}
			<div className="job-page-main">
				<div className="job-page-actions">
					<Button variant="ghost" size="sm" onClick={() => onRoute('')}>
						<ArrowLeft aria-hidden="true" />
						{agentName}
					</Button>
					<span className="flex-1" />
					{v?.canManage &&
						j &&
						(ended ? (
							<Button variant="outline" size="sm" disabled={busy} onClick={() => void act('reopen')}>
								<RotateCcw aria-hidden="true" />
								Reabrir
							</Button>
						) : (
							<Button
								variant="danger-outline"
								size="sm"
								disabled={busy}
								onClick={async () => {
									if (await ask(CLOSE_JOB)) void act('close');
								}}
							>
								<Square aria-hidden="true" />
								Terminar trabajo
							</Button>
						))}
					<Button asChild size="sm">
						<a href={`#/agent/${agentId}/chat/${id}`}>
							<MessageSquare aria-hidden="true" />
							Abrir conversación
						</a>
					</Button>
				</div>

				{editing ? (
					<form className="job-page-goal-form" onSubmit={saveGoal}>
						<Input
							autoFocus
							aria-label="Objetivo del trabajo"
							value={goal}
							onChange={(x) => setGoal(x.target.value)}
							maxLength={1000}
							placeholder="Qué es cierto cuando termine"
						/>
						<Button size="sm" type="submit" disabled={busy || !goal.trim()}>
							Guardar
						</Button>
						<Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
							Cancelar
						</Button>
					</form>
				) : (
					<div className="job-page-head">
						<h1 className="job-page-title" title={j?.goal ?? conversation.title}>
							{j?.goal ?? conversation.goal ?? conversation.title}
						</h1>
						{v?.canManage && !ended && (
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Cambiar el objetivo"
								title="Cambiar el objetivo"
								onClick={() => {
									setGoal(j?.goal ?? '');
									setEditing(true);
								}}
							>
								<Pencil aria-hidden="true" />
							</Button>
						)}
					</div>
				)}
				{(jobError || error) && (
					<p role="alert" className="error">
						{jobError || error}
					</p>
				)}

				<dl className="job-props">
					<Prop icon={CircleDot} label="Estado">
						{conversation.live ? (
							<Badge variant="default">
								Trabajando
								<LoaderCircle className="animate-spin" aria-hidden="true" />
							</Badge>
						) : ended ? (
							<JobStatusBadge status={j!.status as 'done' | 'closed'} />
						) : (
							<Badge variant="outline">Abierto</Badge>
						)}
						{v?.simulatedPayments && (
							<Badge
								variant="warning"
								title="Sus pagos se simulan: no llegan a la tienda y el agente los ve como hechos."
							>
								Pagos simulados
							</Badge>
						)}
					</Prop>
					<Prop icon={ListChecks} label="Avance">
						{tasks > 0 && <TaskMeter done={done} total={tasks} />}
						<button type="button" className="job-eval" onClick={() => setTasksOpen(true)}>
							<span className="tabular-nums">{tasks ? `${done} de ${tasks} tareas` : 'Sin tareas'}</span>
							<ChevronRight className="job-eval-arrow" aria-hidden="true" />
						</button>
					</Prop>
					{!ended && conversation.task_now && (
						<Prop icon={Timer} label="Ahora">
							<span className="min-w-0 truncate" title={conversation.task_now}>
								{conversation.task_now}
							</span>
						</Prop>
					)}
					<Prop icon={MessageSquare} label="Origen">
						<ChannelIcon origin={conversation.origin} className="mr-1.5" />
						<span className="min-w-0 truncate">
							{conversation.title} · {conversation.runs} {conversation.runs === 1 ? 'turno' : 'turnos'}
						</span>
					</Prop>
					<Prop icon={Target} label="Modo">
						{v?.goalMode ? (
							<span className="goal-mode-pill" title={GOAL_MODE_EXPLAIN}>
								Objetivo: sigue solo hasta cumplirlo
							</span>
						) : (
							<span className="text-muted-foreground">Avanza cuando alguien le escribe</span>
						)}
						{v?.owner && !v.goalMode && !ended && (
							<button
								type="button"
								className="job-eval"
								title={GOAL_MODE_EXPLAIN}
								onClick={async () => {
									if (
										!(await ask({
											title: '¿Encender el modo objetivo?',
											description: GOAL_MODE_EXPLAIN,
											action: 'Encender',
										}))
									)
										return;
									await api(`/agents/${agentId}/goal-mode`, { method: 'PUT', body: { on: true } }).catch((x) =>
										setError((x as Error).message),
									);
									onChanged();
									void refresh();
								}}
							>
								Encender
								<ChevronRight className="job-eval-arrow" aria-hidden="true" />
							</button>
						)}
					</Prop>
					{j && j.budget_usd !== undefined && (
						<Prop icon={Wallet} label="Presupuesto">
							<span
								className="tabular-nums"
								title="Lo que lleva gastado el trabajo, y cuántos turnos dio solo, sin que nadie le escribiera"
							>
								${(j.spent_usd ?? 0).toFixed(2)} de ${j.budget_usd.toFixed(2)} · {j.auto_turns ?? 0} de {j.budget_turns}{' '}
								turnos sin ti
							</span>
							{v?.owner && !ended && (
								<button
									type="button"
									className="job-eval"
									onClick={() => setBudget({ usd: String(j.budget_usd), turns: String(j.budget_turns) })}
								>
									<Pencil aria-hidden="true" />
									Cambiar
								</button>
							)}
						</Prop>
					)}
					<Prop icon={CalendarDays} label="Fechas">
						<span className="min-w-0 truncate">
							Empezó {date(conversation.started_at)}
							{ended && j?.closed_at
								? ` · terminó ${date(j.closed_at)}`
								: conversation.last_at
									? ` · última actividad ${ago(conversation.last_at)}`
									: ''}
						</span>
					</Prop>
					{info?.flow.recipe && (
						<Prop icon={BookOpen} label="Receta">
							{info.flow.recipe.name}
						</Prop>
					)}
					{ended && (
						<Prop icon={ClipboardCheck} label="Evaluación">
							{e?.status === 'done' ? (
								<button type="button" className="job-eval" onClick={() => setRubric(true)}>
									{e.overall !== null && (
										<span className={`job-score ${scoreClass(e.overall)}`}>{Math.round(e.overall)}/100</span>
									)}
									<span>Ver rúbrica</span>
									<ChevronRight className="job-eval-arrow" aria-hidden="true" />
								</button>
							) : e?.status === 'pending' ? (
								<span className="text-muted-foreground">Otro agente lo está evaluando…</span>
							) : e?.status === 'failed' ? (
								<span className="text-muted-foreground" title={e.error ?? undefined}>
									No se pudo evaluar
								</span>
							) : (
								<span className="text-muted-foreground">Sin evaluación</span>
							)}
							{v?.owner && j && (
								<span className="ml-1 inline-flex items-center">
									<Button
										size="icon-sm"
										variant={j.rating === 1 ? 'secondary' : 'ghost'}
										aria-label="Me sirvió"
										aria-pressed={j.rating === 1}
										disabled={busy}
										onClick={() => void act('rating', { rating: j.rating === 1 ? null : 1 })}
									>
										<ThumbsUp aria-hidden="true" />
									</Button>
									<Button
										size="icon-sm"
										variant={j.rating === -1 ? 'secondary' : 'ghost'}
										aria-label="No me sirvió"
										aria-pressed={j.rating === -1}
										disabled={busy}
										onClick={() => void act('rating', { rating: j.rating === -1 ? null : -1 })}
									>
										<ThumbsDown aria-hidden="true" />
									</Button>
								</span>
							)}
						</Prop>
					)}
				</dl>

				<nav className="job-quick" aria-label="Más del trabajo">
					{mine && (
						<QuickCard
							icon={Network}
							title="Flujo"
							sub={flows === null ? '…' : flows.length ? `${tasks} tareas en nodos` : 'Sin flujo todavía'}
							onOpen={() => go('flujo')}
						/>
					)}
					{mine && (
						<QuickCard
							icon={ScrollText}
							title="Saga"
							sub={flowId ? 'La historia, línea por línea' : 'Sin saga todavía'}
							onOpen={() => go('saga')}
						/>
					)}
					{mine && (
						<QuickCard
							icon={MessagesSquare}
							title="Conversaciones"
							sub="Sus chats de WhatsApp en este trabajo"
							onOpen={() => go('conversaciones')}
						/>
					)}
				</nav>

				<Description
					parts={[
						ended && j ? (
							<p key="end">
								<strong>Cómo terminó.</strong> {j.end_reason ?? 'Terminó'}
								{j.closed_at ? `, ${ago(j.closed_at)}` : ''}. Lo siguiente que le pidas empieza un trabajo nuevo.
							</p>
						) : null,
						j?.summary ? (
							<p key="summary">
								<strong>Resumen.</strong> {j.summary}
							</p>
						) : null,
						info?.flow.status === 'running' && info.flow.waiting_for ? (
							<p key="waiting">
								<strong>Espera a.</strong> {info.flow.waiting_for}
								{info.flow.waiting_since ? ` (desde ${ago(new Date(info.flow.waiting_since).getTime())})` : ''}
							</p>
						) : null,
						info?.flow.summary ? (
							<p key="flow">
								<strong>De la lista.</strong> {info.flow.summary}
							</p>
						) : null,
						info?.facts.length ? (
							<div key="facts">
								<strong>Ya establecido.</strong>
								<ul>
									{info.facts.map((x, i) => (
										<li key={i}>
											<span className="text-muted-foreground">
												{x.source === 'owner' ? 'Tú' : x.source === 'contact' ? 'Contacto' : 'Agente'}:
											</span>{' '}
											{x.text}
										</li>
									))}
								</ul>
							</div>
						) : null,
					]}
				/>
			</div>

			<Dialog open={!!budget} onOpenChange={(o) => !o && setBudget(null)}>
				<DialogContent className="sm:max-w-md">
					<form
						className="grid gap-4"
						onSubmit={async (ev) => {
							ev.preventDefault();
							if (budget && (await act('budget', { usd: Number(budget.usd), turns: Number(budget.turns) })))
								setBudget(null);
						}}
					>
						<DialogHeader>
							<DialogTitle>Presupuesto del trabajo</DialogTitle>
							<DialogDescription>
								Hasta dónde sigue solo: al llegar, deja de continuar por su cuenta y te avisa. Lo que tú le pidas no
								cuenta contra los turnos.
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-3 sm:grid-cols-2">
							<label className="grid gap-1.5 text-sm">
								Costo máximo (USD)
								<Input
									type="number"
									min={0.01}
									max={1000}
									step={0.5}
									value={budget?.usd ?? ''}
									onChange={(x) => setBudget((b) => (b ? { ...b, usd: x.target.value } : b))}
								/>
							</label>
							<label className="grid gap-1.5 text-sm">
								Turnos sin ti
								<Input
									type="number"
									min={1}
									max={500}
									step={1}
									value={budget?.turns ?? ''}
									onChange={(x) => setBudget((b) => (b ? { ...b, turns: x.target.value } : b))}
								/>
							</label>
						</div>
						{jobError && (
							<p role="alert" className="error">
								{jobError}
							</p>
						)}
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => setBudget(null)}>
								Cancelar
							</Button>
							<Button type="submit" disabled={busy}>
								Guardar
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog open={tasksOpen} onOpenChange={setTasksOpen}>
				<DialogContent className="job-modal sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle>Tareas del trabajo</DialogTitle>
						<DialogDescription>
							Lo que falta primero; las hechas, plegadas. El agente recibe cada cambio tuyo como instrucción.
						</DialogDescription>
					</DialogHeader>
					<SmoothHeight>
						<JobTasks agentId={agentId} conversation={conversation} hub />
					</SmoothHeight>
				</DialogContent>
			</Dialog>

			<Dialog open={!!shown} onOpenChange={(o) => !o && onRoute(`/job/${id}`)}>
				<DialogContent
					className={`job-modal ${shown === 'flujo' || shown === 'saga' ? 'sm:max-w-[min(96vw,90rem)]' : 'sm:max-w-3xl'}`}
				>
					<div className="job-modal-head">
						<DialogHeader className="min-w-0">
							<DialogTitle>{shown ? MODAL[shown].title : ''}</DialogTitle>
							<DialogDescription>{shown ? MODAL[shown].description : ''}</DialogDescription>
						</DialogHeader>
						{shown === 'flujo' && flowId && info?.flow.status === 'running' && (
							<Button variant="danger-ghost" size="sm" onClick={() => void stopFlow(flowId)}>
								<Square aria-hidden="true" />
								Detener
							</Button>
						)}
					</div>
					<SmoothHeight>
						{mine && shown === 'flujo' && (
							<>
								{!flows ? (
									!error && (
										<p role="status" className="muted small">
											Cargando el flujo…
										</p>
									)
								) : flowId ? (
									<div className="grid min-w-0 gap-3">
										{flows.length > 1 && (
											<OptionSelect
												label="Lista de tareas"
												value={String(flowId)}
												onValueChange={(x) => go('flujo', Number(x))}
												options={flows.map((f) => ({ id: String(f.id), label: `Lista #${f.id} · ${f.title}` }))}
												className="sm:w-80"
											/>
										)}
										<Suspense
											fallback={
												<p role="status" className="muted small">
													Cargando el flujo…
												</p>
											}
										>
											<FlowDetail key={flowId} agentId={agentId} id={flowId} bare view="canvas" selectStep={picked} />
										</Suspense>
									</div>
								) : (
									<p className="muted small">Sin flujo todavía: aparece cuando el trabajo tiene una lista de tareas.</p>
								)}
							</>
						)}
						{mine && shown === 'saga' && (
							<>
								{flowId ? (
									<Suspense
										fallback={
											<p role="status" className="muted small">
												Cargando la saga…
											</p>
										}
									>
										<FlowDetail
											key={flowId}
											agentId={agentId}
											id={flowId}
											bare
											view="saga"
											onPickStep={(key) => {
												setPicked(key);
												go('flujo', flowId);
											}}
										/>
									</Suspense>
								) : (
									<p className="muted small">
										Sin saga todavía: es la historia de la lista de tareas, línea por línea.
									</p>
								)}
							</>
						)}
						{mine && shown === 'encargos' && (
							<SlideStack
								list={<AgentDelegations agentId={agentId} conversationId={id} onOpen={(d) => go('encargos', d)} />}
								detail={
									item ? (
										<DelegationDetail key={item} agentId={agentId} id={item} onBack={() => go('encargos')} />
									) : null
								}
							/>
						)}
					</SmoothHeight>
				</DialogContent>
			</Dialog>
			{e?.status === 'done' && j && <RubricDialog jobId={j.id} evaluation={e} open={rubric} onOpenChange={setRubric} />}
		</article>
	);
}

const MODAL: Record<JobTab, { title: string; description: string }> = {
	flujo: { title: 'Flujo', description: 'Las tareas como nodos: clic en una para ver su detalle.' },
	saga: { title: 'Saga', description: 'Todo lo que pasó en la lista; clic en una línea la muestra en el flujo.' },
	conversaciones: { title: 'Conversaciones', description: 'Sus chats de WhatsApp en este trabajo.' },
	encargos: { title: 'Encargos', description: 'Lo que el agente delegó a sus contactos por WhatsApp.' },
};

/** A quick access: its icon, name and one line; it opens its modal. */
function QuickCard({
	icon: Icon,
	title,
	sub,
	onOpen,
}: {
	icon: LucideIcon;
	title: string;
	sub: string;
	onOpen: () => void;
}) {
	return (
		<button type="button" className="job-quick-card" onClick={onOpen}>
			<span className="job-quick-icon">
				<Icon aria-hidden="true" />
			</span>
			<span className="min-w-0">
				<span className="job-quick-title">{title}</span>
				<span className="job-quick-sub">{sub}</span>
			</span>
			<ChevronRight className="job-eval-arrow ml-auto" aria-hidden="true" />
		</button>
	);
}

/** One property row: its icon and name, then its value. */
function Prop({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
	return (
		<div className="job-prop">
			<dt>
				<Icon aria-hidden="true" />
				{label}
			</dt>
			<dd>{children}</dd>
		</div>
	);
}

/**
 * The long text in one place: folded to a few lines; it opens while focused (click or Tab) and can stay open.
 */
/** The trabajo's long text, whole and as part of the page (no card). */
function Description({ parts }: { parts: ReactNode[] }) {
	const shown = parts.filter(Boolean);
	return (
		<section className="job-desc-section" aria-label="Descripción">
			<h2 className="job-section-title">Descripción</h2>
			{shown.length ? <div className="job-desc">{shown}</div> : <p className="muted small">Sin descripción todavía.</p>}
		</section>
	);
}
