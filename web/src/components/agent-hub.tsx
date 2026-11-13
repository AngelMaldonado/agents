// The agent's hub (Bubble agents #25), like a stream: its current work on a stage as wide as the page,
// under it who the agent is and what it works on (with «Nuevo trabajo»), and tabs with its trabajos and
// the files its runs produced. Plus the current work's footer for the chat view: who ran it and for how long.
import { ComputerBusy, humanDriving } from '@/components/computer-busy';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
	BrainCircuit,
	GraduationCap,
	BookMarked,
	MoreHorizontal,
	Pencil,
	Trash2,
	ArrowLeft,
	ArrowUpRight,
	Check,
	ChevronDown,
	Clock,
	Clock3,
	Download,
	FileText,
	Image,
	LoaderCircle,
	Table2,
	UserPlus,
} from 'lucide-react';
import { api, ago, isLive, type Agent, type Conversation, type Person, type PublicSettings, type Task } from '@/api';
import { artifactFileUrl, artifactUrl } from '@/lib/artifacts';
import { cn } from '@/lib/utils';
import { ChannelIcon } from '@/components/channel-icon';
import { Character, STATE_LABEL } from '@/Character';
import { stateOf } from '@/Gallery';
import { modelLabel } from '@/components/agent-header';
import { IconButton } from '@/components/actions';
import { PeopleStack } from '@/components/people-stack';
import { StatusIcon } from '@/components/status-icon';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChatDialog } from '@/components/chat-dialog';
import { LearnDialog } from '@/components/learn-dialog';
import { DevBubble } from '@/components/dev-bubble';
import { previewed, usePreview } from '@/lib/card-preview';
import { Evaluating, JobStatusBadge, scoreClass } from '@/components/job-bar';
import { improveWith } from '@/lib/sidebar-events';
import { TaskMeter } from '@/components/task-meter';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** Elapsed seconds of a run: still counting while it is live. */
export const elapsedOf = (t: Task | null) =>
	t?.started_at ? Math.max(0, Math.round(((t.ended_at ?? Date.now()) - t.started_at) / 1000)) : 0;

/** Who ran a run (or is running it): the person who asked, its owner, or the setup. */
export function whoRan(t: Task, owner: string) {
	if (t.kind === 'initialize') return 'Inicialización';
	return t.requested_by_name ?? owner;
}

/** Under the current work: who ran it (or runs it), which run it is, and how long it took. */
export function WorkFooter({ task, agent, chatHref }: { task: Task | null; agent: Agent; chatHref?: string }) {
	if (!task) return <footer className="work-footer text-muted-foreground">Sin turnos todavía</footer>;
	const live = isLive(task),
		who = whoRan(task, agent.owner);
	const verb = task.status === 'queued' ? 'En cola para' : live ? 'Ejecutando' : 'Ejecutó';
	return (
		<footer className="work-footer">
			<span className="flex min-w-0 items-center gap-2">
				<span className="work-footer-face" aria-hidden="true">
					{who.slice(0, 2).toUpperCase()}
				</span>
				{/* Working: a spinner; finished: a check (a queue waits with a clock). */}
				{task.status === 'queued' ? (
					<Clock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
				) : live && humanDriving(task) ? (
					<ComputerBusy
						label={task.kind === 'browser' ? 'Computadora abierta para su dueño' : 'Una persona tiene el control'}
					/>
				) : live ? (
					<LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" />
				) : task.status === 'done' ? (
					<Check className="size-3.5 shrink-0 text-success" aria-hidden="true" />
				) : null}
				<span className="min-w-0 truncate">
					<span className="text-muted-foreground">{verb} </span>
					<span className="font-medium">{who}</span>
					<span className="text-muted-foreground">
						{' · '}
						{chatHref ? (
							<a
								href={chatHref}
								className="inline-flex items-center gap-0.5 text-foreground underline decoration-muted-foreground/60 underline-offset-4 hover:decoration-foreground"
								title="Abrir su chat"
							>
								Turno #{task.id}
								<ArrowUpRight className="size-3.5" aria-hidden="true" />
							</a>
						) : (
							`Turno #${task.id}`
						)}
					</span>
				</span>
			</span>
			<span className="flex shrink-0 items-center gap-3 text-muted-foreground tabular-nums">
				<span className="inline-flex items-center gap-1" aria-label="Tiempo transcurrido">
					<Clock3 className="size-3.5" aria-hidden="true" />
					{clock(elapsedOf(task))}
				</span>
				<span title={`${(task.tokens / 1000).toFixed(1)}k tokens`}>US${task.cost.toFixed(3)}</span>
			</span>
		</footer>
	);
}

/** A value that follows another at most every `ms` (a stage's backdrop does not need every frame). */
function useThrottled<T>(value: T, ms: number) {
	const [shown, setShown] = useState(value);
	const last = useRef(0);
	useEffect(() => {
		const wait = last.current + ms - Date.now();
		if (wait <= 0) {
			last.current = Date.now();
			setShown(value);
			return;
		}
		const timer = setTimeout(() => {
			last.current = Date.now();
			setShown(value);
		}, wait);
		return () => clearTimeout(timer);
	}, [value, ms]);
	return shown;
}

/**
 * The hub's stage, like a stream: the agent's current work as big as the page allows, centered, with
 * a dark blur of itself (its screen, or its surface when it is text) filling the sides. It has no tabs:
 * it shows what the work does now. Clicking it opens that work.
 */
export function HubStage({
	backdrop,
	surface,
	href,
	label,
	view,
	live,
	children,
}: {
	/** What it shows, as a JPEG (base64): blurred, it fills the sides. */
	backdrop?: string | null;
	/** Without a picture, the sides take the tone of its surface. */
	surface: 'dark' | 'card';
	/** Where clicking it goes (the work's chat); none while the owner drives its browser. */
	href?: string;
	label: string;
	/** What it shows now: Navegador, Terminal, Actividad, Respuesta. */
	view: string;
	live: boolean;
	children: ReactNode;
}) {
	const blur = useThrottled(backdrop ?? null, 1500);
	return (
		<section className="hub-stage" aria-label={`Trabajo actual: ${view}`}>
			<div
				className={cn('hub-stage-backdrop', !blur && `tint-${surface}`)}
				style={blur ? { backgroundImage: `url(data:image/jpeg;base64,${blur})` } : undefined}
				aria-hidden="true"
			/>
			<div className={cn('hub-stage-screen', `surface-${surface}`)}>{children}</div>
			<div className="hub-stage-badges">
				{live && <span className="hub-live">En vivo</span>}
				<span className="hub-view">{view}</span>
			</div>
			{href && (
				<a href={href} className="hub-stage-link" aria-label={label} title={label}>
					<span className="hub-stage-cta">
						Abrir trabajo
						<ArrowUpRight aria-hidden="true" />
					</span>
				</a>
			)}
		</section>
	);
}

const JOB_STATUS = {
	open: 'Abierto',
	done: 'Terminado',
	closed: 'Cerrado',
} as const;

/**
 * Under the stage, like a stream's info: who the agent is and its state, what it works on now (the
 * trabajo's objective), a few tags about it, its actions, and how long and how much the current turn.
 */
export function StreamInfo({
	agent,
	settings,
	mine,
	task,
	job,
	live,
	onBack,
	people,
	onShare,
	actions,
	workActions,
}: {
	agent: Agent;
	settings: PublicSettings;
	mine: boolean;
	task: Task | null;
	job: Conversation | null;
	live: boolean;
	onBack: () => void;
	people: Pick<Person, 'id' | 'name'>[];
	onShare?: () => void;
	/** Computadora, Automejora, Configuración, Nuevo trabajo. */
	actions: ReactNode;
	/** The live turn's: take or give back control, cancel. */
	workActions: ReactNode;
}) {
	const state = stateOf(agent);
	const queued = agent.task?.status === 'queued';
	const title = job?.goal || (job && !job.is_default ? job.title : null) || task?.prompt || 'Sin trabajo todavía';
	const tags = [
		job && !job.is_default ? `Trabajo #${job.id}` : job?.is_default ? 'Principal' : null,
		job && !job.is_default && job.status ? JOB_STATUS[job.status] : null,
		task ? `Turno #${task.id}` : null,
		task ? `${task.status === 'queued' ? 'Para' : 'De'} ${whoRan(task, agent.owner)}` : null,
	].filter(Boolean) as string[];
	return (
		// A container of its own: the actions stay on the name's row (icons when they do not fit), and on a
		// narrow one they go under it as buttons.
		<header className="stream-info">
			<div className="stream-grid">
				<Button
					variant="ghost"
					size="icon"
					className="stream-back"
					onClick={onBack}
					aria-label="Volver a agentes"
					title="Volver a agentes"
				>
					<ArrowLeft />
				</Button>
				<div className={cn('stream-avatar', live && 'is-live')}>
					<Character seed={agent.seed} state={state} size={64} />
					{live && <span className="hub-live stream-avatar-badge">En vivo</span>}
				</div>
				<div className="stream-text">
					<h1 className="stream-name" title={agent.name}>
						{agent.name}
					</h1>
					<p className="stream-title" title={title}>
						{title}
					</p>
					{!!job?.tasks && (
						<p className="stream-task">
							<TaskMeter done={job.tasks_done ?? 0} total={job.tasks} label="Avance del trabajo" />
							<span className="tabular-nums">
								{job.tasks_done ?? 0}/{job.tasks}
							</span>
							{job.task_now && <span className="min-w-0 truncate">▶ {job.task_now}</span>}
						</p>
					)}
					<p className="stream-meta">
						<StatusIcon status={queued ? 'queued' : state} label={queued ? 'En cola' : STATE_LABEL[state]} />
						<span className="truncate">
							{modelLabel(settings, agent.model)}
							{!mine && ` · de ${agent.owner}`}
							{(agent.aliases?.length || agent.handle) &&
								` · ${(agent.aliases?.length ? agent.aliases : [agent.handle]).map((x) => `@${x}`).join(' ')}`}
						</span>
					</p>
					{tags.length > 0 && (
						<ul className="stream-tags" aria-label="Del trabajo actual">
							{tags.map((t) => (
								<li key={t}>{t}</li>
							))}
						</ul>
					)}
				</div>
				<div className="stream-side">
					<div className="agent-actions" aria-label="Acciones del agente">
						{actions}
					</div>
					<div className="stream-stats">
						{workActions}
						{task && (
							<>
								<span className="inline-flex items-center gap-1" aria-label="Tiempo del turno">
									<Clock3 className="size-3.5" aria-hidden="true" />
									{clock(elapsedOf(task))}
								</span>
								<span title={`${(task.tokens / 1000).toFixed(1)}k tokens`}>US${task.cost.toFixed(3)}</span>
							</>
						)}
						<span className="inline-flex items-center gap-1">
							<PeopleStack people={people} />
							{onShare && <IconButton icon={UserPlus} label="Compartir" onClick={onShare} className="size-6" />}
						</span>
					</div>
				</div>
			</div>
		</header>
	);
}

const JOBS_PAGE = 12;

/** The agent's trabajos (not its chats: the Principal is apart), newest activity first, as cards. */
export function JobGallery({
	agentId,
	conversations,
	loading,
	error,
	onRetry,
	mine,
	onChanged,
}: {
	agentId: number;
	conversations: Conversation[];
	loading: boolean;
	error: string;
	onRetry: () => void;
	/** The owner's agent: its trabajos can be used to improve it (Automejora). */
	mine: boolean;
	/** A trabajo was renamed or deleted: reload the list. */
	onChanged: () => void;
}) {
	const [edit, setEdit] = useState<{ chat: Conversation; action: 'rename' | 'delete' } | null>(null);
	const [learning, setLearning] = useState<Conversation | null>(null);
	const [shown, setShown] = useState(JOBS_PAGE);
	// In development, the bubble may play states on the cards (lib/card-preview); never in production.
	const preview = usePreview();
	const jobs = conversations
		.filter((c) => !c.is_default)
		.sort((a, b) => (b.last_at ?? b.started_at) - (a.last_at ?? a.started_at))
		.map((c, i) => (import.meta.env.DEV && (i === 0 || preview.all) ? previewed(c, preview) : c));
	// A trabajo opens its hub: its flow of tasks, its conversations and its encargos.
	const href = (c: Conversation) => `#/agent/${agentId}/job/${c.id}`;
	if (error)
		return (
			<p role="alert" className="error">
				{error}{' '}
				<Button variant="outline" size="sm" onClick={onRetry}>
					Reintentar
				</Button>
			</p>
		);
	if (loading && !conversations.length)
		return (
			<p role="status" className="muted small">
				Cargando trabajos…
			</p>
		);
	if (!jobs.length) return <p className="muted small">Todavía no hay trabajos: empieza uno con «Nuevo trabajo».</p>;
	return (
		<>
			<ul className="job-grid">
				{jobs.slice(0, shown).map((c) => {
					const status = c.live ? 'live' : (c.status ?? 'open');
					return (
						<li key={c.id} className={cn('job-card group/job', `is-${status}`)}>
							<a href={href(c)} className="job-card-link">
								<span className="job-card-top">
									{c.live ? (
										<span className="inline-flex items-center gap-1.5 text-primary">
											Trabajando
											<LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
										</span>
									) : c.status === 'done' || c.status === 'closed' ? (
										<JobStatusBadge status={c.status} />
									) : (
										<span className="job-card-status">{JOB_STATUS.open}</span>
									)}
									{c.score != null && (
										<span className={`job-score ${scoreClass(c.score)}`} title="Evaluación">
											{Math.round(c.score)}/100
										</span>
									)}
									{c.evaluation === 'pending' && <Evaluating />}
									{!!c.learned && (
										<span
											className="job-card-mark is-learned"
											title={`Aprendió ${c.learned} ${c.learned === 1 ? 'cosa' : 'cosas'} de este trabajo`}
										>
											<BookMarked aria-hidden="true" />
											{c.learned}
											<span className="sr-only">{c.learned === 1 ? ' aprendizaje' : ' aprendizajes'}</span>
										</span>
									)}
								</span>
								<span className="job-card-title">{c.goal || c.title || 'Sin objetivo'}</span>
								{!!c.tasks && (
									<span className="job-card-tasks">
										{/* Across the whole card; under it, how many and the one going on. */}
										<TaskMeter done={c.tasks_done ?? 0} total={c.tasks} label="Avance del trabajo" />
										<span className="flex min-w-0 items-center gap-1">
											<span className="shrink-0 tabular-nums">
												{c.tasks_done ?? 0}/{c.tasks} tareas
											</span>
											{c.task_now && c.status === 'open' && <span className="min-w-0 truncate">· {c.task_now}</span>}
										</span>
									</span>
								)}
								{c.goal && c.title && c.title !== c.goal && <span className="job-card-sub">{c.title}</span>}
								<span className="job-card-foot">
									<span className="inline-flex min-w-0 items-center gap-1.5">
										<ChannelIcon origin={c.origin} />#{c.id} · {c.runs} {c.runs === 1 ? 'turno' : 'turnos'}
									</span>
									<span title={new Date(c.last_at ?? c.started_at).toLocaleString('es-MX')}>
										{ago(c.last_at ?? c.started_at)}
									</span>
								</span>
							</a>
							<ChatRowMenu
								chat={c}
								className="job-card-menu"
								onRename={() => setEdit({ chat: c, action: 'rename' })}
								onDelete={() => setEdit({ chat: c, action: 'delete' })}
								onImprove={mine ? () => improveWith(agentId, { id: c.id, title: c.title }) : undefined}
								onLearn={mine ? () => setLearning(c) : undefined}
							/>
						</li>
					);
				})}
			</ul>
			{jobs.length > shown && (
				<Button variant="ghost" size="sm" className="mt-3" onClick={() => setShown((n) => n + JOBS_PAGE)}>
					Ver más ({jobs.length - shown})
					<ChevronDown aria-hidden="true" />
				</Button>
			)}
			<DevBubble />
			<LearnDialog
				agentId={agentId}
				job={learning && { id: learning.id, title: learning.goal || learning.title }}
				onClose={() => setLearning(null)}
				onDone={() => {
					setLearning(null);
					onChanged();
				}}
			/>
			<ChatDialog
				edit={edit}
				onClose={() => setEdit(null)}
				onDone={() => {
					setEdit(null);
					onChanged();
				}}
			/>
		</>
	);
}

/** A chat's «…»: rename, use it to improve the agent (Automejora), teach it something (Aprender), delete. */
function ChatRowMenu({
	chat,
	className,
	onRename,
	onDelete,
	onImprove,
	onLearn,
}: {
	chat: Conversation;
	className?: string;
	onRename: () => void;
	onDelete: () => void;
	onImprove?: () => void;
	/** Aprender: its owner teaches the agent something from this trabajo. */
	onLearn?: () => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					className={className}
					aria-label={`Acciones de ${chat.title || 'Conversación'}`}
					title="Más"
				>
					<MoreHorizontal aria-hidden="true" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-48">
				<DropdownMenuItem onSelect={onRename}>
					<Pencil aria-hidden="true" />
					Renombrar
				</DropdownMenuItem>
				{onImprove && (
					<DropdownMenuItem onSelect={onImprove}>
						<BrainCircuit aria-hidden="true" />
						Usar para mejorar
					</DropdownMenuItem>
				)}
				{onLearn && (
					<DropdownMenuItem onSelect={onLearn}>
						<GraduationCap aria-hidden="true" />
						Aprender
					</DropdownMenuItem>
				)}
				<DropdownMenuSeparator />
				<DropdownMenuItem
					variant="destructive"
					disabled={chat.is_default || chat.live}
					title={
						chat.is_default
							? 'Principal no se elimina: ahí llegan los webhooks y los horarios.'
							: chat.live
								? 'Tiene un turno en curso.'
								: undefined
					}
					onSelect={onDelete}
				>
					<Trash2 aria-hidden="true" />
					Eliminar
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

type RecentFile = { id: number; name: string; mime: string; size: number; run_id: number; created_at: number };

/** What its runs produced lately, newest first; each opens in the file drawer. */
export function RecentFiles({ agentId, version, limit = 8 }: { agentId: number; version: number; limit?: number }) {
	const [files, setFiles] = useState<RecentFile[] | null>(null),
		[error, setError] = useState('');
	useEffect(() => {
		let alive = true;
		setError('');
		api<{ files: RecentFile[] }>(`/agents/${agentId}/files?limit=${limit}`)
			.then((r) => alive && setFiles(r.files))
			.catch((e) => alive && setError((e as Error).message));
		return () => {
			alive = false;
		};
	}, [agentId, version, limit]);
	return (
		<section className="hub-section" aria-label="Artefactos">
			{error ? (
				<p role="alert" className="error">
					{error}
				</p>
			) : !files ? (
				<p role="status" className="muted small">
					Cargando artefactos…
				</p>
			) : !files.length ? (
				<p className="muted small">Todavía no hay artefactos: lo que el agente deja en ~/work/out aparece aquí.</p>
			) : (
				<ul className="hub-files">
					{files.map((f) => {
						const Icon = /^image\//.test(f.mime) ? Image : /\.csv$/i.test(f.name) ? Table2 : FileText;
						return (
							<li key={f.id} className="hub-file">
								<Icon aria-hidden="true" className="size-5 shrink-0 text-primary" />
								<a
									href={artifactUrl(agentId, f.run_id, f.name)}
									className="grid min-w-0 flex-1 gap-0.5 text-xs"
									aria-label={`Ver ${f.name}`}
								>
									<span className="truncate font-medium">{f.name}</span>
									<span className="text-2xs text-muted-foreground">
										Turno #{f.run_id} · {ago(f.created_at)} · {(f.size / 1024).toFixed(1)} KB
									</span>
								</a>
								<Button asChild variant="ghost" size="icon-sm">
									<a
										href={`${artifactFileUrl(f.run_id, f.name)}?download=1`}
										download={f.name}
										aria-label={`Descargar ${f.name}`}
									>
										<Download aria-hidden="true" />
									</a>
								</Button>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
