// A trabajo's list of tasks, under its objective: what the agent does, what waits for whom, and how far it
// got. Its owner checks, skips, reopens, removes or adds tasks; the agent hears each change as an instruction.
import { useEffect, useState, type FormEvent } from 'react';
import {
	ChevronDown,
	Circle,
	CircleCheck,
	CircleDot,
	CircleSlash,
	CircleX,
	Hourglass,
	MoreHorizontal,
	OctagonAlert,
	Plus,
	RotateCcw,
	Trash2,
	type LucideIcon,
} from 'lucide-react';
import { api, type Conversation } from '@/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { TaskMeter } from '@/components/task-meter';

type Status = 'pending' | 'working' | 'waiting' | 'blocked' | 'done' | 'skipped' | 'failed' | 'removed';
type Task = {
	key: string;
	title: string;
	kind: 'agent' | 'subagent' | 'delegation' | 'question' | 'wait';
	status: Status;
	note: string | null;
	spec: {
		instructions: string;
		encargo?: { contacto: string } | null;
		persona?: { name: string } | null;
		by?: 'owner';
	};
};
type View = {
	list: { id: number; recipe: { name: string } | null; waiting_for: string | null; simulation: boolean } | null;
	tasks: Task[];
	canEdit: boolean;
};

const STATUS: Record<Exclude<Status, 'removed'>, { label: string; icon: LucideIcon; className: string }> = {
	pending: { label: 'Pendiente', icon: Circle, className: 'text-muted-foreground' },
	working: { label: 'En curso', icon: CircleDot, className: 'text-primary' },
	waiting: { label: 'Esperando', icon: Hourglass, className: 'text-primary' },
	blocked: { label: 'Bloqueada', icon: OctagonAlert, className: 'text-warning' },
	done: { label: 'Hecha', icon: CircleCheck, className: 'text-success' },
	skipped: { label: 'Omitida', icon: CircleSlash, className: 'text-muted-foreground' },
	failed: { label: 'Falló', icon: CircleX, className: 'text-destructive' },
};
const over = (s: Status) => s === 'done' || s === 'skipped';

/** Who takes care of it, in a word or two. */
function who(t: Task) {
	if (t.kind === 'delegation') return `encargo · ${t.spec.encargo?.contacto || '?'}`;
	if (t.kind === 'question') return 'pregunta · tú';
	if (t.kind === 'wait') return t.spec.persona ? `espera · ${t.spec.persona.name}` : 'espera';
	return t.kind === 'subagent' ? 'subagente' : 'agente';
}

export function JobTasks({
	agentId,
	conversation,
	hub = false,
}: {
	agentId: number;
	conversation: Conversation;
	/** The trabajo's hub: always open, what is left first and what is done folded; its long notes elsewhere. */
	hub?: boolean;
}) {
	const [v, setV] = useState<View | null>(null);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [open, setOpen] = useState(true);
	const [showDone, setShowDone] = useState(false);
	const [adding, setAdding] = useState(false);
	const [title, setTitle] = useState('');
	const base = `/agents/${agentId}/conversations/${conversation.id}/tasks`;
	useEffect(() => {
		let gone = false;
		const load = () =>
			api<View>(base)
				.then((r) => !gone && setV(r))
				.catch((e) => !gone && setError((e as Error).message));
		void load();
		// The platform and the agent move it on their own.
		const timer = setInterval(load, 10_000);
		return () => {
			gone = true;
			clearInterval(timer);
		};
	}, [base, conversation.status]);
	if (!v || conversation.is_default) return null;
	const tasks = v.tasks.filter((t) => t.status !== 'removed');
	if (!tasks.length && !v.canEdit) return null;
	const edit = async (body: Record<string, unknown>) => {
		setBusy(true);
		setError('');
		try {
			setV(await api<View>(base, { body }));
			return true;
		} catch (e) {
			setError((e as Error).message);
			return false;
		} finally {
			setBusy(false);
		}
	};
	const add = async (e: FormEvent) => {
		e.preventDefault();
		if (!title.trim()) return;
		if (await edit({ op: 'add', titulo: title.trim() })) {
			setTitle('');
			setAdding(false);
		}
	};
	const done = tasks.filter((t) => over(t.status)).length;
	// In the hub: what is left first; what is done, folded.
	const shown = hub
		? [...tasks.filter((t) => !over(t.status)), ...(showDone ? tasks.filter((t) => over(t.status)) : [])]
		: tasks;
	// Without a list yet: only its owner sees a way to start one.
	if (!tasks.length)
		return (
			<section className="job-tasks job-tasks-empty" aria-label="Tareas del trabajo">
				{adding ? (
					<AddForm title={title} setTitle={setTitle} busy={busy} onSubmit={add} onCancel={() => setAdding(false)} />
				) : (
					<Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
						<Plus aria-hidden="true" />
						Agregar tareas
					</Button>
				)}
				{error && (
					<p role="alert" className="error mt-1 text-xs">
						{error}
					</p>
				)}
			</section>
		);
	return (
		<section className={cn('job-tasks', hub && 'is-hub')} aria-label="Tareas del trabajo">
			<button
				type="button"
				className="job-tasks-head"
				onClick={() => !hub && setOpen((o) => !o)}
				aria-expanded={hub ? undefined : open}
				aria-controls={hub ? undefined : `job-tasks-${conversation.id}`}
				disabled={hub}
			>
				<span className="font-medium">Tareas</span>
				<span className="tabular-nums text-muted-foreground">
					{done}/{tasks.length}
				</span>
				<TaskMeter done={done} total={tasks.length} />
				{v.list?.recipe && <span className="truncate text-xs text-muted-foreground">receta {v.list.recipe.name}</span>}
				{!hub && v.list?.waiting_for && (
					<span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
						espera a {v.list.waiting_for}
					</span>
				)}
				{!hub && (
					<ChevronDown
						className={cn('ml-auto size-4 shrink-0 transition-transform', open && 'rotate-180')}
						aria-hidden="true"
					/>
				)}
			</button>
			{(open || hub) && (
				<div id={`job-tasks-${conversation.id}`}>
					<ul className="job-tasks-list">
						{shown.map((t) => {
							const st = STATUS[t.status as Exclude<Status, 'removed'>];
							const Icon = st.icon;
							const closed = over(t.status);
							return (
								<li key={t.key} className={cn('job-task', `is-${t.status}`)}>
									{v.canEdit ? (
										<button
											type="button"
											className={cn('job-task-check', st.className)}
											disabled={busy}
											aria-label={closed ? `Reabrir «${t.title}»` : `Marcar «${t.title}» como hecha`}
											title={closed ? 'Reabrir' : 'Marcar como hecha'}
											onClick={() => void edit({ op: closed ? 'reopen' : 'done', tarea: t.key })}
										>
											<Icon aria-hidden="true" />
										</button>
									) : (
										<span className={cn('job-task-check', st.className)} role="img" aria-label={st.label}>
											<Icon aria-hidden="true" />
										</span>
									)}
									<span className="min-w-0 flex-1">
										<span className="job-task-title" title={t.spec.instructions}>
											{t.title}
										</span>
										{t.note && ['blocked', 'failed', 'working'].includes(t.status) && (
											<span className="job-task-note">
												{t.status === 'blocked' ? 'Bloqueada: ' : t.status === 'failed' ? 'Falló: ' : ''}
												{t.note}
											</span>
										)}
									</span>
									<span className="job-task-who">
										{who(t)}
										{t.spec.by === 'owner' && ' · la agregaste'}
									</span>
									{v.canEdit && (
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<Button
													variant="ghost"
													size="icon-sm"
													className="job-task-menu"
													aria-label={`Acciones de «${t.title}»`}
												>
													<MoreHorizontal aria-hidden="true" />
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end" className="w-44">
												{closed || t.status === 'failed' || t.status === 'blocked' ? (
													<DropdownMenuItem onSelect={() => void edit({ op: 'reopen', tarea: t.key })}>
														<RotateCcw aria-hidden="true" />
														Reabrir
													</DropdownMenuItem>
												) : (
													<DropdownMenuItem onSelect={() => void edit({ op: 'done', tarea: t.key })}>
														<CircleCheck aria-hidden="true" />
														Marcar hecha
													</DropdownMenuItem>
												)}
												{!closed && (
													<DropdownMenuItem onSelect={() => void edit({ op: 'skip', tarea: t.key })}>
														<CircleSlash aria-hidden="true" />
														Omitir
													</DropdownMenuItem>
												)}
												{['pending', 'working', 'blocked'].includes(t.status) && (
													<>
														<DropdownMenuSeparator />
														<DropdownMenuItem
															variant="destructive"
															onSelect={() => void edit({ op: 'remove', tarea: t.key })}
														>
															<Trash2 aria-hidden="true" />
															Quitar
														</DropdownMenuItem>
													</>
												)}
											</DropdownMenuContent>
										</DropdownMenu>
									)}
								</li>
							);
						})}
					</ul>
					{hub && done > 0 && (
						<Button variant="ghost" size="sm" className="mt-1" onClick={() => setShowDone((x) => !x)}>
							{showDone ? 'Ocultar las hechas' : `Mostrar ${done} ${done === 1 ? 'hecha' : 'hechas'}`}
						</Button>
					)}
					{v.canEdit &&
						(adding ? (
							<AddForm title={title} setTitle={setTitle} busy={busy} onSubmit={add} onCancel={() => setAdding(false)} />
						) : (
							tasks.length < 12 && (
								<Button variant="ghost" size="sm" className="mt-1" onClick={() => setAdding(true)}>
									<Plus aria-hidden="true" />
									Agregar tarea
								</Button>
							)
						))}
					{v.canEdit && (
						<p className="mt-1 text-2xs text-muted-foreground">El agente recibe cada cambio como instrucción.</p>
					)}
				</div>
			)}
			{error && (
				<p role="alert" className="error mt-1 text-xs">
					{error}
				</p>
			)}
		</section>
	);
}

function AddForm({
	title,
	setTitle,
	busy,
	onSubmit,
	onCancel,
}: {
	title: string;
	setTitle: (t: string) => void;
	busy: boolean;
	onSubmit: (e: FormEvent) => void;
	onCancel: () => void;
}) {
	return (
		<form className="mt-1 flex min-w-0 items-center gap-2" onSubmit={onSubmit}>
			<Input
				autoFocus
				aria-label="Nueva tarea"
				value={title}
				onChange={(e) => setTitle(e.target.value)}
				maxLength={120}
				placeholder="Qué hay que hacer"
			/>
			<Button size="sm" type="submit" disabled={busy || !title.trim()}>
				Agregar
			</Button>
			<Button size="sm" variant="ghost" type="button" onClick={onCancel}>
				Cancelar
			</Button>
		</form>
	);
}
