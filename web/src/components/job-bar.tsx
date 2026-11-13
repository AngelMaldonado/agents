// A trabajo (a conversation with an objective): what it is for, ending or reopening it, and once it ended
// its summary, its owner's own 👍 / 👎 and how another agent evaluated it with the rubric (in a dialog).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
	CircleCheck,
	ClipboardCheck,
	BookMarked,
	LoaderCircle,
	RotateCcw,
	Square,
	Target,
	ThumbsDown,
	ThumbsUp,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { NEW_OPS, type PlaybookEntry, type Taught } from '@/components/job-playbook';
import { api, ago, type Conversation } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useConfirm, type ConfirmOptions } from '@/components/confirm-dialog';
import { ScrollArea } from '@/components/ui/scroll-area';

type Job = {
	id: number;
	goal: string | null;
	status: 'open' | 'done' | 'closed';
	end_reason: string | null;
	summary: string | null;
	closed_at: number | null;
	rating: -1 | 1 | null;
	is_default: boolean;
	/** Modo objetivo: its budget, what it spent and its turns without anyone. */
	budget_usd?: number;
	budget_turns?: number;
	spent_usd?: number;
	auto_turns?: number;
};
type Score = {
	key: string;
	name: string;
	weight: number;
	score: number | null;
	justification: string;
	evidence: string[];
};
type Evaluation = {
	status: 'pending' | 'done' | 'failed';
	overall: number | null;
	comment: string | null;
	suggestions: string[] | null;
	scores: Score[] | null;
	metrics: Record<string, number> | null;
	error: string | null;
};
type View = {
	job: Job;
	evaluation: Evaluation | null;
	/** Its playbook (what its agent worked with) and what it taught (Aprendizajes). */
	playbook?: PlaybookEntry[];
	taught?: Taught[];
	canManage: boolean;
	owner: boolean;
	/** Pagos simulados is on for its agent. */
	simulatedPayments?: boolean;
	/** Modo objetivo is on for its agent: its trabajos go on by themselves. */
	goalMode?: boolean;
};

/** A trabajo's state as a badge: done in green with its check, closed as an outline. */
export function JobStatusBadge({ status }: { status: 'done' | 'closed' }) {
	return status === 'done' ? (
		<Badge variant="success">
			<CircleCheck aria-hidden="true" />
			Terminado
		</Badge>
	) : (
		<Badge variant="outline">Cerrado</Badge>
	);
}

/** Ending a trabajo, asked the same way from its bar and from its page. */
export const CLOSE_JOB: ConfirmOptions = {
	title: '¿Dar por terminado este trabajo?',
	description:
		'Si el agente está trabajando, se detiene; otro agente lo evaluará. Lo siguiente que le pidas empieza un trabajo nuevo.',
	action: 'Terminar trabajo',
	destructive: true,
};

export const scoreClass = (n: number) => (n >= 75 ? 'good' : n >= 50 ? 'fair' : 'poor');

export type JobView = View;
/** A trabajo's state from the server (refreshed while its evaluation arrives) and its actions. */
export function useJob(agentId: number, conversation: Conversation, onChanged?: () => void) {
	const [v, setV] = useState<View | null>(null);
	const evaluating = v?.evaluation?.status === 'pending';
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const base = `/agents/${agentId}/conversations/${conversation.id}/job`;
	const refresh = () =>
		api<View>(base)
			.then((r) => setV(r))
			.catch((e) => setError((e as Error).message));
	useEffect(() => {
		let gone = false;
		const load = () =>
			api<View>(base)
				.then((r) => !gone && setV(r))
				.catch((e) => !gone && setError((e as Error).message));
		void load();
		// Its evaluation arrives a moment after it ends: closer while it is being evaluated.
		const timer = setInterval(load, evaluating ? 5_000 : 15_000);
		return () => {
			gone = true;
			clearInterval(timer);
		};
	}, [base, conversation.status, evaluating]);
	const act = async (op: string, body?: unknown) => {
		if (!v) return false;
		setBusy(true);
		setError('');
		try {
			const next = await api<Omit<View, 'canManage' | 'owner'>>(`${base}/${op}`, { body: body ?? {} });
			setV((cur) => (cur ? { ...cur, ...next } : cur));
			onChanged?.();
			return true;
		} catch (e) {
			setError((e as Error).message);
			return false;
		} finally {
			setBusy(false);
		}
	};
	return { v, error, busy, act, refresh };
}

export function JobBar({
	agentId,
	conversation,
	onChanged,
}: {
	agentId: number;
	conversation: Conversation;
	onChanged?: () => void;
}) {
	const { v, error, busy, act } = useJob(agentId, conversation, onChanged);
	const [ask, confirmDialog] = useConfirm();
	const [editing, setEditing] = useState(false);
	const [goal, setGoal] = useState('');
	const [rubric, setRubric] = useState(false);
	const [more, setMore] = useState(false),
		[clamped, setClamped] = useState(false);
	const summary = useRef<HTMLParagraphElement>(null);
	useLayoutEffect(() => {
		// «Ver más» only when the summary does not fit in its lines.
		const el = summary.current;
		if (!el || more) return;
		const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [v?.job.summary, more]);
	if (!v || v.job.is_default) return null;
	const j = v.job,
		e = v.evaluation;
	const ended = j.status !== 'open';
	return (
		<section className="job-bar" aria-label={`Trabajo ${j.id}`}>
			{confirmDialog}
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<Target className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<span className="text-xs text-muted-foreground">Trabajo #{j.id}</span>
				{ended && <JobStatusBadge status={j.status as 'done' | 'closed'} />}
				{v.simulatedPayments && (
					<Badge variant="warning" title="Sus pagos se simulan: no llegan a la tienda y el agente los ve como hechos.">
						Pagos simulados
					</Badge>
				)}
				{editing ? (
					<form
						className="flex min-w-0 flex-1 items-center gap-2"
						onSubmit={(ev) => {
							ev.preventDefault();
							void act('goal', { goal }).then(() => setEditing(false));
						}}
					>
						<Input
							autoFocus
							aria-label="Objetivo del trabajo"
							value={goal}
							onChange={(ev) => setGoal(ev.target.value)}
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
					<button
						type="button"
						className={`min-w-0 flex-1 truncate text-left text-sm ${j.goal ? '' : 'text-muted-foreground'} ${!ended && v.canManage ? 'hover:underline' : 'cursor-default'}`}
						title={j.goal ?? undefined}
						disabled={ended || !v.canManage}
						onClick={() => {
							setGoal(j.goal ?? '');
							setEditing(true);
						}}
					>
						{j.goal ??
							(ended
								? 'Sin objetivo declarado'
								: 'Sin objetivo todavía: el agente lo declara, o escríbelo aquí (o con /goal)')}
					</button>
				)}
				{v.canManage &&
					!editing &&
					(ended ? (
						<Button size="sm" variant="outline" disabled={busy} onClick={() => void act('reopen')}>
							<RotateCcw aria-hidden="true" />
							Reabrir
						</Button>
					) : (
						<Button
							size="sm"
							variant="danger-outline"
							disabled={busy}
							onClick={async () => {
								if (await ask(CLOSE_JOB)) void act('close');
							}}
						>
							<Square aria-hidden="true" />
							Terminar trabajo
						</Button>
					))}
			</div>
			{error && (
				<p role="alert" className="error mt-1">
					{error}
				</p>
			)}
			{ended && (
				<div className="job-bar-body">
					<p className="text-xs text-muted-foreground">
						{j.end_reason ?? 'Terminó'}
						{j.closed_at ? ` · ${ago(j.closed_at)}` : ''}. Lo siguiente que le pidas empieza un trabajo nuevo.
					</p>
					{j.summary && (
						<div className="min-w-0">
							<p ref={summary} className={more ? 'job-summary' : 'job-summary line-clamp-3'}>
								{j.summary}
							</p>
							{(clamped || more) && (
								<button type="button" className="job-more" onClick={() => setMore((m) => !m)}>
									{more ? 'Ver menos' : 'Ver más'}
								</button>
							)}
						</div>
					)}
					<footer className="job-bar-foot">
						{v.owner ? (
							<div className="flex items-center gap-1 text-xs text-muted-foreground">
								¿Te sirvió?
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
							</div>
						) : (
							<span />
						)}
						{e?.status === 'pending' && <Evaluating />}
						{e?.status === 'failed' && (
							<span className="text-xs text-muted-foreground" title={e.error ?? undefined}>
								No se pudo evaluar
							</span>
						)}
						{e?.status === 'done' && (
							<Button variant="outline" size="sm" onClick={() => setRubric(true)} title="Ver la rúbrica">
								<ClipboardCheck aria-hidden="true" />
								Evaluación
								{e.overall !== null && (
									<span className={`job-score ${scoreClass(e.overall)}`}>{Math.round(e.overall)}/100</span>
								)}
							</Button>
						)}
						<Learned taught={v?.taught} />
					</footer>
				</div>
			)}
			{e?.status === 'done' && <RubricDialog jobId={j.id} evaluation={e} open={rubric} onOpenChange={setRubric} />}
		</section>
	);
}

/** How another agent evaluated a trabajo with the rubric: each criterion, suggestions and what was measured. */
export function RubricDialog({
	jobId,
	evaluation: e,
	open,
	onOpenChange,
}: {
	jobId: number;
	evaluation: Evaluation;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						Evaluación del trabajo #{jobId}
						{e.overall !== null && (
							<span className={`job-score ${scoreClass(e.overall)}`}>{Math.round(e.overall)}/100</span>
						)}
					</DialogTitle>
					<DialogDescription>{e.comment ?? 'Otro agente lo evaluó con la rúbrica.'}</DialogDescription>
				</DialogHeader>
				<ScrollArea className="max-h-[60vh]">
					<div className="grid min-w-0 gap-3 pr-3">
						{(e.scores ?? [])
							.filter((s) => s.weight > 0)
							.map((s) => (
								<div key={s.key} className="grid min-w-0 gap-1">
									<div className="flex min-w-0 items-center gap-2 text-sm">
										<span className="min-w-0 flex-1 truncate font-medium" title={s.name}>
											{s.name}
										</span>
										<span className="job-meter" aria-label={s.score === null ? 'No aplica' : `${s.score} de 4`}>
											{[0, 1, 2, 3].map((i) => (
												<span key={i} data-on={s.score !== null && i < s.score ? '' : undefined} />
											))}
										</span>
										<span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
											{s.score === null ? 'No aplica' : `${s.score}/4`}
										</span>
									</div>
									{s.justification && (
										<p className="text-xs break-words text-muted-foreground">
											{s.justification}
											{s.evidence.length ? ` · ${s.evidence.join(' · ')}` : ''}
										</p>
									)}
								</div>
							))}
						{!!e.suggestions?.length && (
							<div className="text-sm">
								<p className="font-medium">Para mejorar su contrato</p>
								<ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
									{e.suggestions.map((s, i) => (
										<li key={i}>{s}</li>
									))}
								</ul>
							</div>
						)}
						{e.metrics && (
							<p className="text-xs text-muted-foreground">
								Medido: {e.metrics.turns} turnos · {e.metrics.minutes_working} min trabajando de{' '}
								{e.metrics.minutes_total} · {e.metrics.help_requests} pedidos de ayuda · {e.metrics.takeovers} tomas de
								control · {e.metrics.tool_errors} errores de herramientas ·{' '}
								{Number(e.metrics.tokens).toLocaleString('es-MX')} tokens
							</p>
						)}
					</div>
				</ScrollArea>
			</DialogContent>
		</Dialog>
	);
}

/** While another agent evaluates the trabajo (a moment after it ends). */
export function Evaluating() {
	return (
		<span className="job-evaluating" role="status" title="Otro agente lo está evaluando">
			<ClipboardCheck aria-hidden="true" />
			<LoaderCircle className="animate-spin" aria-hidden="true" />
			<span className="sr-only">Evaluando</span>
		</span>
	);
}

/** What the agent learned from this trabajo; nothing when it learned nothing. */
export function Learned({ taught }: { taught?: Taught[] }) {
	const lessons = [...new Set((taught ?? []).filter((t) => NEW_OPS.includes(t.op)).map((t) => t.text))];
	if (!lessons.length) return null;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="job-learned"
					aria-label={`Aprendió ${lessons.length} ${lessons.length === 1 ? 'cosa' : 'cosas'}`}
				>
					<BookMarked aria-hidden="true" />
					Aprendió {lessons.length}
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-80 text-sm" align="start">
				<p className="font-medium">Lo que aprendió de este trabajo</p>
				<ul className="mt-2 grid list-disc gap-1.5 pl-4 text-muted-foreground">
					{lessons.map((l) => (
						<li key={l}>{l}</li>
					))}
				</ul>
				<p className="mt-2 text-2xs text-muted-foreground">
					Entra a sus siguientes trabajos por su playbook. Lo ves y lo borras en la pestaña Aprendizajes.
				</p>
			</PopoverContent>
		</Popover>
	);
}
