// Memoria: what the agent knows from one trabajo to the next, as a shelf of books (one per memory; its color and
// icon say its kind, a ribbon that its owner pinned it). Hovering a book lifts it and shows its title; a click
// opens it. Its owner searches, writes, corrects, pins (always in the agent's prompt) and deletes: one, several
// (each book's check, top left; while some are checked a click checks instead of opening) or all of them.
import { useEffect, useState, type FormEvent } from 'react';
import { cn } from '@/lib/utils';
import {
	BookMarked,
	Lightbulb,
	ListChecks,
	MapPin,
	Pencil,
	Pin,
	PinOff,
	Plus,
	Scale,
	Search,
	Trash2,
	UserRound,
	Heart,
	type LucideIcon,
} from 'lucide-react';
import { api, ago } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { OptionSelect } from '@/components/option-select';
import { useConfirm } from '@/components/confirm-dialog';

export const MEMORY_KINDS = [
	{ id: 'preference', label: 'Preferencia' },
	{ id: 'person', label: 'Persona' },
	{ id: 'place', label: 'Lugar' },
	{ id: 'procedure', label: 'Procedimiento' },
	{ id: 'fact', label: 'Dato' },
	{ id: 'decision', label: 'Decisión' },
] as const;
type Kind = (typeof MEMORY_KINDS)[number]['id'];
const kindLabel = (k: Kind) => MEMORY_KINDS.find((x) => x.id === k)?.label ?? k;
const KIND_ICON: Record<Kind, LucideIcon> = {
	preference: Heart,
	person: UserRound,
	place: MapPin,
	procedure: ListChecks,
	fact: Lightbulb,
	decision: Scale,
};

type Memory = {
	id: number;
	kind: Kind;
	topic: string | null;
	title: string;
	content: string;
	source: 'agent' | 'owner';
	pinned: boolean;
	revisions: number;
	created_at: number;
	updated_at: number;
	used_at: number | null;
};
type Revision = { title: string; content: string; changed_by: 'agent' | 'owner'; created_at: number };
type Draft = { id?: number; kind: Kind; topic: string; title: string; content: string };

export function AgentMemory({ agentId }: { agentId: number }) {
	const [q, setQ] = useState(''),
		[query, setQuery] = useState(''),
		[kind, setKind] = useState<'all' | Kind>('all');
	const [view, setView] = useState<{ memories: Memory[]; total: number; max: number } | null>(null);
	const [error, setError] = useState('');
	const [version, setVersion] = useState(0);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [open, setOpen] = useState<Memory | null>(null);
	const [picked, setPicked] = useState<Set<number>>(new Set());
	const [deleting, setDeleting] = useState(false);
	const [ask, confirmDialog] = useConfirm();
	const toggle = (id: number) =>
		setPicked((cur) => {
			const next = new Set(cur);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const remove = async (which: { ids: number[] } | { all: true }) => {
		const n = 'all' in which ? (view?.total ?? 0) : which.ids.length;
		const ok = await ask({
			title: 'all' in which ? '¿Borrar toda su memoria?' : `¿Borrar ${n} ${n === 1 ? 'memoria' : 'memorias'}?`,
			description:
				'all' in which
					? `Se borran sus ${n} ${n === 1 ? 'memoria' : 'memorias'}, también las fijadas y las que no salen en esta búsqueda. Desde el siguiente turno no las recuerda.`
					: 'Desde el siguiente turno no las recuerda.',
			action: 'all' in which ? 'Borrar todas' : 'Borrar',
			destructive: true,
		});
		if (!ok) return;
		setDeleting(true);
		setError('');
		try {
			await api(`/agents/${agentId}/memories/delete`, { body: which });
			setPicked(new Set());
			reload();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setDeleting(false);
		}
	};
	// Search as it is typed, without a request per key.
	useEffect(() => {
		const t = setTimeout(() => setQuery(q.trim()), 250);
		return () => clearTimeout(t);
	}, [q]);
	useEffect(() => {
		let alive = true;
		const params = new URLSearchParams();
		if (query) params.set('q', query);
		if (kind !== 'all') params.set('kind', kind);
		api<{ memories: Memory[]; total: number; max: number }>(`/agents/${agentId}/memories?${params}`)
			.then((r) => {
				if (!alive) return;
				setView(r);
				setError('');
			})
			.catch((e) => alive && setError((e as Error).message));
		return () => {
			alive = false;
		};
	}, [agentId, query, kind, version]);
	const reload = () => setVersion((v) => v + 1);
	return (
		<section className="hub-section memory" aria-label="Memoria">
			{confirmDialog}
			<div className="memory-bar">
				<div className="memory-search">
					<Search className="memory-search-icon" aria-hidden="true" />
					<Input
						type="search"
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="Buscar en lo que recuerda"
						aria-label="Buscar en la memoria"
						className="pl-8"
					/>
				</div>
				<OptionSelect
					label="Tipo de memoria"
					value={kind}
					onValueChange={(v) => setKind(v as 'all' | Kind)}
					options={[{ id: 'all', label: 'Todos los tipos' }, ...MEMORY_KINDS]}
					className="sm:w-44 sm:shrink-0"
				/>
				<Button
					className="sm:shrink-0"
					onClick={() => setDraft({ kind: 'preference', topic: '', title: '', content: '' })}
				>
					<Plus aria-hidden="true" />
					Agregar
				</Button>
				{!!view?.total && (
					<Button
						variant="danger-outline"
						className="sm:shrink-0"
						disabled={deleting}
						onClick={() => void remove({ all: true })}
					>
						<Trash2 aria-hidden="true" />
						Borrar todas
					</Button>
				)}
			</div>
			{picked.size > 0 && (
				<div className="memory-picked" role="toolbar" aria-label="Memorias seleccionadas">
					<span className="font-medium">
						{picked.size} {picked.size === 1 ? 'seleccionada' : 'seleccionadas'}
					</span>
					{view && view.memories.some((m) => !picked.has(m.id)) && (
						<Button variant="ghost" size="sm" onClick={() => setPicked(new Set(view.memories.map((m) => m.id)))}>
							Seleccionar las {view.memories.length}
						</Button>
					)}
					<Button variant="ghost" size="sm" className="ml-auto" onClick={() => setPicked(new Set())}>
						Cancelar
					</Button>
					<Button variant="destructive" size="sm" disabled={deleting} onClick={() => void remove({ ids: [...picked] })}>
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
			{!view ? (
				!error && (
					<p role="status" className="muted small">
						Cargando memoria…
					</p>
				)
			) : !view.memories.length ? (
				<div className="memory-empty">
					<BookMarked aria-hidden="true" />
					<p className="muted small">
						{query || kind !== 'all'
							? 'Nada con esa búsqueda.'
							: 'Todavía no recuerda nada. Guardará tus preferencias, personas, lugares y lo que aprenda a hacer; también puedes agregarlo tú.'}
					</p>
				</div>
			) : (
				<>
					<ul className={cn('memory-shelf', picked.size > 0 && 'is-picking')} aria-label="Memorias">
						{view.memories.map((m) => (
							<li key={m.id} className="memory-slot" data-picked={picked.has(m.id) || undefined}>
								<MemoryBook memory={m} onOpen={() => (picked.size ? toggle(m.id) : setOpen(m))} />
								<Checkbox
									className="memory-check"
									checked={picked.has(m.id)}
									onCheckedChange={() => toggle(m.id)}
									aria-label={`Seleccionar «${m.title}»`}
								/>
							</li>
						))}
					</ul>
					<p className="muted small">
						{view.memories.length < view.total
							? `${view.memories.length} de ${view.total} memorias`
							: `${view.total} ${view.total === 1 ? 'memoria' : 'memorias'}`}
					</p>
				</>
			)}
			{open && (
				<MemoryDetail
					agentId={agentId}
					memory={open}
					onClose={() => setOpen(null)}
					onEdit={(m) => {
						setOpen(null);
						setDraft({ id: m.id, kind: m.kind, topic: m.topic ?? '', title: m.title, content: m.content });
					}}
					onChanged={(m) => {
						setOpen(m);
						reload();
					}}
				/>
			)}
			{draft && (
				<MemoryDialog
					draft={draft}
					onClose={() => setDraft(null)}
					onSave={async (d) => {
						const body = { kind: d.kind, topic: d.topic.trim() || null, title: d.title, content: d.content };
						await api(d.id ? `/agents/${agentId}/memories/${d.id}` : `/agents/${agentId}/memories`, {
							method: d.id ? 'PUT' : 'POST',
							body,
						});
						setDraft(null);
						reload();
					}}
				/>
			)}
		</section>
	);
}

/** One memory as a book: its kind's color and icon; a ribbon when pinned; its title shows on hover. */
function MemoryBook({ memory: m, onOpen }: { memory: Memory; onOpen: () => void }) {
	const Icon = KIND_ICON[m.kind];
	return (
		<button
			type="button"
			className="memory-book"
			data-kind={m.kind}
			onClick={onOpen}
			aria-label={`${kindLabel(m.kind)}: ${m.title}${m.pinned ? ' (fijada)' : ''}`}
		>
			<span className="memory-book-cover" aria-hidden="true">
				<Icon className="memory-book-icon" />
				<span className="memory-book-label" />
				{m.pinned && <span className="memory-book-ribbon" />}
			</span>
			<span className="memory-book-title" aria-hidden="true">
				{m.title}
			</span>
		</button>
	);
}

/** A memory opened: what it says, who wrote it and when, its earlier versions, and what its owner can do. */
function MemoryDetail({
	agentId,
	memory,
	onClose,
	onEdit,
	onChanged,
}: {
	agentId: number;
	memory: Memory;
	onClose: () => void;
	onEdit: (m: Memory) => void;
	onChanged: (m: Memory) => void;
}) {
	const [m, setM] = useState(memory);
	const [history, setHistory] = useState<Revision[] | null>(null);
	const [busy, setBusy] = useState(false),
		[error, setError] = useState('');
	const [ask, confirmDialog] = useConfirm();
	useEffect(() => {
		let alive = true;
		api<{ memory: Memory & { history: Revision[] } }>(`/agents/${agentId}/memories/${memory.id}`)
			.then((r) => {
				if (!alive) return;
				const { history: h, ...rest } = r.memory;
				setM(rest);
				setHistory(h);
			})
			.catch((e) => alive && setError((e as Error).message));
		return () => {
			alive = false;
		};
	}, [agentId, memory.id]);
	const run = async (fn: () => Promise<void>) => {
		setBusy(true);
		setError('');
		try {
			await fn();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const pin = () =>
		run(async () => {
			const r = await api<{ memory: Memory }>(`/agents/${agentId}/memories/${m.id}`, {
				method: 'PUT',
				body: { pinned: !m.pinned },
			});
			setM(r.memory);
			onChanged(r.memory);
		});
	const remove = async () =>
		(await ask({
			title: `¿Borrar «${m.title}»?`,
			description: 'El agente deja de saberlo desde su próximo trabajo.',
			action: 'Borrar',
			destructive: true,
		})) &&
		run(async () => {
			await api(`/agents/${agentId}/memories/${m.id}`, { method: 'DELETE' });
			onChanged(m);
			onClose();
		});
	const Icon = KIND_ICON[m.kind];
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			{confirmDialog}
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<div className="flex min-w-0 flex-wrap items-center gap-1.5">
						<Badge variant="secondary" className="memory-kind-badge" data-kind={m.kind}>
							<Icon aria-hidden="true" />
							{kindLabel(m.kind)}
						</Badge>
						{m.pinned && (
							<Badge variant="outline" title="Siempre en su contexto">
								<Pin aria-hidden="true" />
								Fijada
							</Badge>
						)}
						{m.topic && <code className="memory-topic">{m.topic}</code>}
					</div>
					<DialogTitle className="break-words">{m.title}</DialogTitle>
					<DialogDescription>
						{m.source === 'owner' ? 'Lo escribiste tú' : 'Lo guardó el agente'} · {ago(m.updated_at)}
						{m.used_at ? ` · la usó ${ago(m.used_at)}` : ''}
					</DialogDescription>
				</DialogHeader>
				<p className="memory-content">{m.content}</p>
				{!!history?.length && (
					<details className="memory-versions">
						<summary>
							{history.length} {history.length === 1 ? 'versión anterior' : 'versiones anteriores'}
						</summary>
						<ol className="memory-history">
							{history.map((r, i) => (
								<li key={i}>
									<p className="muted small">
										Hasta {ago(r.created_at)}, cuando lo cambió {r.changed_by === 'owner' ? 'su dueño' : 'el agente'}
									</p>
									{r.title !== m.title && <p className="text-sm font-medium break-words">{r.title}</p>}
									<p className="memory-content">{r.content}</p>
								</li>
							))}
						</ol>
					</details>
				)}
				{error && (
					<p role="alert" className="error">
						{error}
					</p>
				)}
				<DialogFooter className="memory-detail-actions">
					<Button variant="danger-ghost" disabled={busy} onClick={() => void remove()}>
						<Trash2 aria-hidden="true" />
						Borrar
					</Button>
					<Button variant="outline" disabled={busy} onClick={() => void pin()}>
						{m.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
						{m.pinned ? 'Soltar' : 'Fijar'}
					</Button>
					<Button disabled={busy} onClick={() => onEdit(m)}>
						<Pencil aria-hidden="true" />
						Corregir
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function MemoryDialog({
	draft,
	onClose,
	onSave,
}: {
	draft: Draft;
	onClose: () => void;
	onSave: (d: Draft) => Promise<void>;
}) {
	const [d, setD] = useState(draft),
		[busy, setBusy] = useState(false),
		[error, setError] = useState('');
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError('');
		try {
			await onSave(d);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<form onSubmit={submit} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>{d.id ? 'Corregir memoria' : 'Agregar a la memoria'}</DialogTitle>
						<DialogDescription>
							El agente lo leerá como escrito por ti. Nunca pongas contraseñas, tarjetas ni códigos: esos van en
							Accesos.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="grid gap-1.5">
							<Label htmlFor="memory-kind">Tipo</Label>
							<OptionSelect
								id="memory-kind"
								label="Tipo"
								value={d.kind}
								onValueChange={(v) => setD({ ...d, kind: v as Kind })}
								options={MEMORY_KINDS}
							/>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="memory-topic">Tema (opcional)</Label>
							<Input
								id="memory-topic"
								value={d.topic}
								onChange={(e) => setD({ ...d, topic: e.target.value })}
								placeholder="super/leche"
								maxLength={80}
							/>
						</div>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="memory-title">Título</Label>
						<Input
							id="memory-title"
							value={d.title}
							onChange={(e) => setD({ ...d, title: e.target.value })}
							maxLength={120}
							required
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="memory-content">Qué debe recordar</Label>
						<Textarea
							id="memory-content"
							value={d.content}
							onChange={(e) => setD({ ...d, content: e.target.value })}
							maxLength={2000}
							rows={5}
							required
						/>
					</div>
					{error && (
						<p role="alert" className="error">
							{error}
						</p>
					)}
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onClose}>
							Cancelar
						</Button>
						<Button type="submit" disabled={busy || !d.title.trim() || !d.content.trim()}>
							{d.id ? 'Guardar cambios' : 'Agregar'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
