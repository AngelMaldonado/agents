// Aprendizajes (Angel 12/13-nov-2026), a tab of the agent: what it knows from one trabajo to the next
// (lessons.ts), as a shelf of books (the style its memory had). A book's color and icon say its state: pinned
// by its owner (with a ribbon), useful, harmful, or no marks yet. Hovering lifts it and shows what it says; a
// click opens it. Its owner searches, teaches one (pinned), pins and deletes: one, several (each book's check,
// top left; while some are checked a click checks instead of opening) or all of them.
import { useEffect, useMemo, useState } from 'react';
import {
	BookMarked,
	GraduationCap,
	Pin,
	PinOff,
	Search,
	Star,
	Trash2,
	TriangleAlert,
	type LucideIcon,
} from 'lucide-react';
import { api, ago } from '@/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useConfirm } from '@/components/confirm-dialog';
import { LearnDialog } from '@/components/learn-dialog';
import { cn } from '@/lib/utils';

type Lesson = {
	id: number;
	text: string;
	conversation_id: number | null;
	helpful: number;
	harmful: number;
	pinned: boolean;
	created_at: number;
	updated_at: number;
};
type State = 'pinned' | 'useful' | 'harmful' | 'new';
const stateOf = (l: Lesson): State =>
	l.pinned ? 'pinned' : l.harmful > l.helpful ? 'harmful' : l.helpful > l.harmful ? 'useful' : 'new';
const STATE: Record<State, { icon: LucideIcon; label: string }> = {
	pinned: { icon: Pin, label: 'Fijado' },
	useful: { icon: Star, label: 'Útil' },
	harmful: { icon: TriangleAlert, label: 'Causó errores' },
	new: { icon: BookMarked, label: 'Sin marcas todavía' },
};
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function AgentLessons({ agentId, mine }: { agentId: number; mine: boolean }) {
	const [lessons, setLessons] = useState<Lesson[] | null>(null);
	const [error, setError] = useState('');
	const [q, setQ] = useState('');
	const [open, setOpen] = useState<number | null>(null);
	const [teaching, setTeaching] = useState(false);
	const [picked, setPicked] = useState<Set<number>>(new Set());
	const [busy, setBusy] = useState(false);
	const [version, setVersion] = useState(0);
	const [ask, confirmDialog] = useConfirm();
	useEffect(() => {
		let gone = false;
		api<{ lessons: Lesson[] }>(`/agents/${agentId}/lessons`)
			.then((r) => {
				if (gone) return;
				setLessons(r.lessons);
				setError('');
			})
			.catch((e) => !gone && setError((e as Error).message));
		return () => void (gone = true);
	}, [agentId, version]);
	const shown = useMemo(
		() => (lessons ?? []).filter((l) => !q.trim() || fold(l.text).includes(fold(q.trim()))),
		[lessons, q],
	);
	const run = async (fn: () => Promise<{ lessons: Lesson[] }>) => {
		setBusy(true);
		setError('');
		try {
			setLessons((await fn()).lessons);
			return true;
		} catch (e) {
			setError((e as Error).message);
			return false;
		} finally {
			setBusy(false);
		}
	};
	const toggle = (id: number) =>
		setPicked((cur) => {
			const next = new Set(cur);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	const confirmDelete = (n: number, all = false) =>
		ask({
			title: all ? '¿Borrar todos sus aprendizajes?' : `¿Borrar ${n} ${n === 1 ? 'aprendizaje' : 'aprendizajes'}?`,
			description: 'El agente deja de saberlo desde su próximo trabajo.',
			action: 'Borrar',
			destructive: true,
		});
	const removeMany = async (which: { ids?: number[]; all?: boolean }) => {
		if (!(await confirmDelete(which.all ? (lessons?.length ?? 0) : (which.ids?.length ?? 0), which.all))) return;
		if (await run(() => api(`/agents/${agentId}/lessons/delete`, { body: which }))) setPicked(new Set());
	};
	const opened = lessons?.find((l) => l.id === open) ?? null;
	return (
		<section className="hub-section lessons" aria-label="Aprendizajes">
			{confirmDialog}
			<div className="lessons-bar">
				<div className="lessons-search">
					<Search className="lessons-search-icon" aria-hidden="true" />
					<Input
						type="search"
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="Buscar en lo que aprendió"
						aria-label="Buscar en sus aprendizajes"
						className="pl-8"
					/>
				</div>
				{mine && (
					<Button className="sm:shrink-0" onClick={() => setTeaching(true)}>
						<GraduationCap aria-hidden="true" />
						Enseñar
					</Button>
				)}
				{mine && !!lessons?.length && (
					<Button
						variant="danger-outline"
						className="sm:shrink-0"
						disabled={busy}
						onClick={() => void removeMany({ all: true })}
					>
						<Trash2 aria-hidden="true" />
						Borrar todos
					</Button>
				)}
			</div>
			{picked.size > 0 && (
				<div className="lessons-picked" role="toolbar" aria-label="Aprendizajes seleccionados">
					<span className="font-medium">
						{picked.size} {picked.size === 1 ? 'seleccionado' : 'seleccionados'}
					</span>
					{shown.some((l) => !picked.has(l.id)) && (
						<Button variant="ghost" size="sm" onClick={() => setPicked(new Set(shown.map((l) => l.id)))}>
							Seleccionar los {shown.length}
						</Button>
					)}
					<Button variant="ghost" size="sm" className="ml-auto" onClick={() => setPicked(new Set())}>
						Cancelar
					</Button>
					<Button variant="destructive" size="sm" disabled={busy} onClick={() => void removeMany({ ids: [...picked] })}>
						<Trash2 aria-hidden="true" />
						Borrar
					</Button>
				</div>
			)}
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
			{!lessons ? (
				!error && (
					<p role="status" className="muted small">
						Cargando aprendizajes…
					</p>
				)
			) : !shown.length ? (
				<div className="lessons-empty">
					<BookMarked aria-hidden="true" />
					<p className="muted small">
						{q.trim()
							? 'Nada con esa búsqueda.'
							: 'Todavía no aprende nada. Guarda lo que le sirve mientras trabaja, otro agente revisa cada trabajo al terminar y tú puedes enseñarle.'}
					</p>
				</div>
			) : (
				<>
					<ul className={cn('lessons-shelf', picked.size > 0 && 'is-picking')} aria-label="Aprendizajes">
						{shown.map((l) => (
							<li key={l.id} className="lessons-slot" data-picked={picked.has(l.id) || undefined}>
								<LessonBook lesson={l} onOpen={() => (picked.size ? toggle(l.id) : setOpen(l.id))} />
								{mine && (
									<Checkbox
										className="lessons-check"
										checked={picked.has(l.id)}
										onCheckedChange={() => toggle(l.id)}
										aria-label={`Seleccionar «${l.text.slice(0, 60)}»`}
									/>
								)}
							</li>
						))}
					</ul>
				</>
			)}
			{opened && (
				<LessonDetail
					lesson={opened}
					mine={mine}
					busy={busy}
					onClose={() => setOpen(null)}
					onPin={(on) =>
						void run(() => api(`/agents/${agentId}/lessons/${opened.id}/pin`, { method: 'PUT', body: { on } }))
					}
					onDelete={async () => {
						if (
							(await confirmDelete(1)) &&
							(await run(() => api(`/agents/${agentId}/lessons/${opened.id}`, { method: 'DELETE' })))
						)
							setOpen(null);
					}}
				/>
			)}
			<LearnDialog
				agentId={agentId}
				job={teaching ? { id: null, title: null } : null}
				onClose={() => setTeaching(false)}
				onDone={() => {
					setTeaching(false);
					setVersion((v) => v + 1);
				}}
			/>
		</section>
	);
}

/** One lesson as a book: its state's color and icon; a ribbon when pinned; what it says shows on hover. */
function LessonBook({ lesson: l, onOpen }: { lesson: Lesson; onOpen: () => void }) {
	const state = stateOf(l);
	const Icon = STATE[state].icon;
	return (
		<button
			type="button"
			className="lessons-book"
			data-state={state}
			onClick={onOpen}
			aria-label={`${STATE[state].label}: ${l.text}`}
		>
			<span className="lessons-book-cover" aria-hidden="true">
				<Icon className="lessons-book-icon" />
				<span className="lessons-book-label" />
				{l.pinned && <span className="lessons-book-ribbon" />}
			</span>
			<span className="lessons-book-title" aria-hidden="true">
				{l.text}
			</span>
		</button>
	);
}

/** A lesson opened: what it says, where it came from, its marks, and what its owner can do. */
function LessonDetail({
	lesson: l,
	mine,
	busy,
	onClose,
	onPin,
	onDelete,
}: {
	lesson: Lesson;
	mine: boolean;
	busy: boolean;
	onClose: () => void;
	onPin: (on: boolean) => void;
	onDelete: () => void;
}) {
	const state = stateOf(l);
	const Icon = STATE[state].icon;
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<p className="lessons-state" data-state={state}>
						<Icon aria-hidden="true" />
						{STATE[state].label}
					</p>
					<DialogTitle className="sr-only">Aprendizaje</DialogTitle>
					<DialogDescription>
						{[
							l.conversation_id ? `Del trabajo #${l.conversation_id}` : 'Enseñado por ti',
							l.helpful ? `útil ${l.helpful}` : null,
							l.harmful ? `dañino ${l.harmful}` : null,
							`desde ${ago(l.created_at)}`,
						]
							.filter(Boolean)
							.join(' · ')}
					</DialogDescription>
				</DialogHeader>
				<p className="text-base break-words whitespace-pre-wrap">{l.text}</p>
				{mine && (
					<DialogFooter className="lessons-detail-actions">
						<Button variant="danger-ghost" disabled={busy} onClick={onDelete}>
							<Trash2 aria-hidden="true" />
							Borrar
						</Button>
						<Button variant="outline" disabled={busy} onClick={() => onPin(!l.pinned)}>
							{l.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
							{l.pinned ? 'Soltar' : 'Fijar'}
						</Button>
					</DialogFooter>
				)}
			</DialogContent>
		</Dialog>
	);
}
