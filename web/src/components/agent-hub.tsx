// The agent's hub (Bubble agents #25), below its current work: a composer that starts a new chat,
// its chats like Claude's «Recientes», and the files its runs produced. Plus the current work's
// footer: who ran it and for how long.
import { ComputerBusy, humanDriving } from '@/components/computer-busy';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
	BrainCircuit,
	MoreHorizontal,
	Pencil,
	Trash2,
	ArrowLeft,
	ArrowUp,
	ArrowUpRight,
	Check,
	ChevronLeft,
	ChevronRight,
	Clock,
	Clock3,
	Download,
	FileText,
	Image,
	LoaderCircle,
	Table2,
} from 'lucide-react';
import { api, ago, isLive, type Agent, type Conversation, type Task } from '@/api';
import { artifactFileUrl, artifactUrl } from '@/lib/artifacts';
import { cn } from '@/lib/utils';
import { AttachButton, AttachmentChips, useAttachments } from '@/components/attachments';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChatDialog } from '@/components/chat-dialog';
import { improveWith } from '@/lib/sidebar-events';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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
	if (!task) return <footer className="work-footer text-muted-foreground">Sin trabajos todavía</footer>;
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
								Trabajo #{task.id}
								<ArrowUpRight className="size-3.5" aria-hidden="true" />
							</a>
						) : (
							`Trabajo #${task.id}`
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

/**
 * Prepares the first message of a new chat: sending opens a new conversation with it and goes to
 * that chat. Retrying after a failure reuses the same request ids, so nothing is created twice.
 */
export function HubComposer({
	agent,
	canUse,
	hint,
	onSent,
}: {
	agent: Agent;
	canUse: boolean;
	hint?: string;
	onSent: (conversation: Conversation) => void;
}) {
	const [text, setText] = useState('');
	const [busy, setBusy] = useState(false),
		[error, setError] = useState('');
	const attach = useAttachments({ files: 10, fileBytes: 10 * 1024 * 1024, totalBytes: 25 * 1024 * 1024 });
	const pending = useRef<{ sig: string; conversation: string; message: string; created?: Conversation } | null>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const files = attach.files;
	const ready = canUse && !busy && (text.trim().length > 0 || files.length > 0);
	const send = async (e?: FormEvent) => {
		e?.preventDefault();
		if (!ready) return;
		if (text.length > 4000) return setError('El mensaje es demasiado largo. Máximo 4000 caracteres.');
		const sig = `${text}\n${files.map((f) => f.id).join(',')}`;
		if (pending.current?.sig !== sig)
			pending.current = { sig, conversation: crypto.randomUUID(), message: crypto.randomUUID() };
		const p = pending.current;
		setBusy(true);
		setError('');
		try {
			p.created ??= (
				await api<{ conversation: Conversation }>(`/agents/${agent.id}/conversations`, {
					method: 'POST',
					body: { requestId: p.conversation },
				})
			).conversation;
			await api(`/agents/${agent.id}/conversations/${p.created.id}/messages`, {
				method: 'POST',
				body: {
					text: text.trim(),
					requestId: p.message,
					...(files.length ? { attachments: files.map(({ name, mime, data }) => ({ name, mime, data })) } : {}),
				},
			});
			pending.current = null;
			setText('');
			attach.clear();
			onSent(p.created);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			void send();
		}
	};
	return (
		<section className="hub-composer" aria-labelledby="hub-composer-title">
			<h2 id="hub-composer-title" className="hub-composer-title">
				Nuevo trabajo
			</h2>
			{error && (
				<p role="alert" className="error mb-2">
					{error}
				</p>
			)}
			{attach.error && (
				<p role="alert" className="error mb-2">
					{attach.error}
				</p>
			)}
			<form
				className="designer-composer"
				onSubmit={(e) => void send(e)}
				onDrop={canUse ? attach.onDrop : undefined}
				onDragOver={canUse ? attach.onDragOver : undefined}
			>
				<AttachmentChips files={files} onRemove={attach.remove} />
				<textarea
					ref={input}
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={keyDown}
					onPaste={attach.onPaste}
					rows={2}
					maxLength={4000}
					disabled={!canUse || busy}
					aria-label={`Nuevo trabajo para ${agent.name}`}
					placeholder={canUse ? 'Escribe al agente…' : 'Sólo su dueño y quienes lo tienen compartido le dan trabajo.'}
					className="designer-composer-input field-sizing-content max-h-48 min-h-16"
				/>
				<div className="designer-composer-actions">
					<AttachButton onFiles={(f) => void attach.add(f)} disabled={!canUse || busy} />
					<Button type="submit" size="icon" aria-label="Enviar y abrir el chat" disabled={!ready}>
						<ArrowUp aria-hidden="true" />
					</Button>
				</div>
			</form>
			<p className="mt-2 text-xs text-muted-foreground">
				{hint ?? 'Cada envío abre un chat nuevo. Para continuar uno, ábrelo desde Recientes.'}
			</p>
		</section>
	);
}

const SHOWN = 8;
const PAGE = 15;

/** The agent's chats, newest activity first, like Claude's «Recientes»; «Ver todos» slides to a table. */
export function ChatHistory({
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
	/** The owner's agent: its chats can be used to improve it (Automejora). */
	mine: boolean;
	/** A chat was renamed or deleted: reload the list. */
	onChanged: () => void;
}) {
	const [edit, setEdit] = useState<{ chat: Conversation; action: 'rename' | 'delete' } | null>(null);
	const menu = (c: Conversation, className?: string) => (
		<ChatRowMenu
			chat={c}
			className={className}
			onRename={() => setEdit({ chat: c, action: 'rename' })}
			onDelete={() => setEdit({ chat: c, action: 'delete' })}
			onImprove={mine ? () => improveWith(agentId, { id: c.id, title: c.title }) : undefined}
		/>
	);
	const [table, setTable] = useState(false);
	const [settled, setSettled] = useState(true);
	const [page, setPage] = useState(0);
	const sorted = [...conversations].sort((a, b) => (b.last_at ?? b.started_at) - (a.last_at ?? a.started_at));
	const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
	const current = Math.min(page, pages - 1);
	const slide = (open: boolean) => {
		setSettled(false);
		setTable(open);
		if (open) setPage(0);
	};
	const href = (c: Conversation) => `#/agent/${agentId}/chat/${c.id}`;
	return (
		<section className="hub-section" aria-labelledby="hub-recents">
			{error ? (
				<>
					<h2 id="hub-recents" className="hub-section-title">
						Recientes
					</h2>
					<p role="alert" className="error">
						{error}{' '}
						<Button variant="outline" size="sm" onClick={onRetry}>
							Reintentar
						</Button>
					</p>
				</>
			) : (
				<div
					className="slide-stack"
					data-detail={table}
					onTransitionEnd={(e) => {
						if (e.target === e.currentTarget.firstElementChild && e.propertyName === 'transform') setSettled(true);
					}}
				>
					<div className="slide-stack-track">
						<div
							className={cn('slide-stack-pane', table && settled && 'slide-stack-hidden')}
							inert={table}
							aria-hidden={table}
						>
							<h2 id="hub-recents" className="hub-section-title">
								Recientes
							</h2>
							{loading && !conversations.length ? (
								<p role="status" className="muted small">
									Cargando chats…
								</p>
							) : !conversations.length ? (
								<p className="muted small">Todavía no hay chats.</p>
							) : (
								<>
									<ul className="hub-list">
										{sorted.slice(0, SHOWN).map((c) => (
											<li key={c.id} className="group/chat relative">
												<a href={href(c)} className="hub-row pr-11">
													<span className={cn('min-w-0 truncate', c.archived_at && 'text-muted-foreground')}>
														{c.title || 'Conversación'}
													</span>
													<span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
														{c.live && (
															<LoaderCircle
																className="size-3.5 animate-spin text-primary"
																role="img"
																aria-label="Trabajando"
															/>
														)}
														{c.archived_at && (
															<span className="rounded-sm bg-muted px-1.5 py-0.5 text-2xs">Cerrada</span>
														)}
														{ago(c.last_at ?? c.started_at)}
													</span>
												</a>
												{menu(
													c,
													'absolute top-1/2 right-2 -translate-y-1/2 opacity-0 group-hover/chat:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
												)}
											</li>
										))}
									</ul>
									{sorted.length > SHOWN && (
										<Button variant="ghost" size="sm" className="mt-1" onClick={() => slide(true)}>
											Ver todos ({sorted.length})
											<ChevronRight aria-hidden="true" />
										</Button>
									)}
								</>
							)}
						</div>
						<div
							className={cn('slide-stack-pane', !table && settled && 'slide-stack-hidden')}
							inert={!table}
							aria-hidden={!table}
						>
							<div className="mb-3 flex items-center gap-2">
								<Button variant="ghost" size="icon-sm" onClick={() => slide(false)} aria-label="Volver a Recientes">
									<ArrowLeft aria-hidden="true" />
								</Button>
								<h2 className="hub-section-title !mb-0">Todas las conversaciones</h2>
								<span className="text-xs text-muted-foreground">{sorted.length}</span>
							</div>
							<Table className="hub-chats-table">
								<TableHeader>
									<TableRow>
										<TableHead>Conversación</TableHead>
										<TableHead className="w-24 text-right">Trabajos</TableHead>
										<TableHead className="w-28">Estado</TableHead>
										<TableHead className="w-32 text-right">Última actividad</TableHead>
										<TableHead className="w-10">
											<span className="sr-only">Acciones</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{sorted.slice(current * PAGE, current * PAGE + PAGE).map((c) => (
										// The whole row opens the chat; its title is the link (keyboard and screen readers).
										<TableRow
											key={c.id}
											className="cursor-pointer"
											onClick={(e) => {
												// Clicks inside its menu (a portal) bubble here too: only the row's own open the chat.
												const target = e.target as Element;
												if (!e.currentTarget.contains(target) || target.closest('a, button')) return;
												location.hash = href(c).slice(1);
											}}
										>
											<TableCell className="max-w-0">
												<a href={href(c)} className="block truncate font-medium hover:underline">
													{c.title || 'Conversación'}
												</a>
											</TableCell>
											<TableCell className="text-right tnum text-muted-foreground">{c.runs}</TableCell>
											<TableCell>
												{c.live ? (
													<span className="inline-flex items-center gap-1.5 text-primary">
														<LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
														Trabajando
													</span>
												) : c.archived_at ? (
													<span className="rounded-sm bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
														Cerrada
													</span>
												) : c.is_default ? (
													<span className="text-muted-foreground">Principal</span>
												) : (
													<span className="text-muted-foreground">Abierta</span>
												)}
											</TableCell>
											<TableCell
												className="text-right text-muted-foreground"
												title={new Date(c.last_at ?? c.started_at).toLocaleString('es-MX')}
											>
												{ago(c.last_at ?? c.started_at)}
											</TableCell>
											<TableCell className="p-1 text-right">{menu(c)}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
							{pages > 1 && (
								<nav
									className="mt-3 flex items-center justify-end gap-2 text-xs"
									aria-label="Páginas de conversaciones"
								>
									<span className="text-muted-foreground">
										Página {current + 1} de {pages}
									</span>
									<Button
										variant="outline"
										size="icon-sm"
										disabled={current === 0}
										onClick={() => setPage(current - 1)}
										aria-label="Página anterior"
									>
										<ChevronLeft aria-hidden="true" />
									</Button>
									<Button
										variant="outline"
										size="icon-sm"
										disabled={current >= pages - 1}
										onClick={() => setPage(current + 1)}
										aria-label="Página siguiente"
									>
										<ChevronRight aria-hidden="true" />
									</Button>
								</nav>
							)}
						</div>
					</div>
				</div>
			)}
			<ChatDialog
				edit={edit}
				onClose={() => setEdit(null)}
				onDone={() => {
					setEdit(null);
					onChanged();
				}}
			/>
		</section>
	);
}

/** A chat's «…»: rename, use it to improve the agent (Automejora), delete. */
function ChatRowMenu({
	chat,
	className,
	onRename,
	onDelete,
	onImprove,
}: {
	chat: Conversation;
	className?: string;
	onRename: () => void;
	onDelete: () => void;
	onImprove?: () => void;
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
				<DropdownMenuSeparator />
				<DropdownMenuItem
					variant="destructive"
					disabled={chat.is_default || chat.live}
					title={
						chat.is_default
							? 'Principal no se elimina: ahí llegan los webhooks y los horarios.'
							: chat.live
								? 'Tiene un trabajo en curso.'
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
export function RecentFiles({ agentId, version }: { agentId: number; version: number }) {
	const [files, setFiles] = useState<RecentFile[] | null>(null),
		[error, setError] = useState('');
	useEffect(() => {
		let alive = true;
		setError('');
		api<{ files: RecentFile[] }>(`/agents/${agentId}/files?limit=8`)
			.then((r) => alive && setFiles(r.files))
			.catch((e) => alive && setError((e as Error).message));
		return () => {
			alive = false;
		};
	}, [agentId, version]);
	if (!error && files && !files.length) return null;
	return (
		<section className="hub-section" aria-labelledby="hub-files">
			<h2 id="hub-files" className="hub-section-title">
				Archivos recientes
			</h2>
			{error ? (
				<p role="alert" className="error">
					{error}
				</p>
			) : !files ? (
				<p role="status" className="muted small">
					Cargando archivos…
				</p>
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
										Trabajo #{f.run_id} · {ago(f.created_at)} · {(f.size / 1024).toFixed(1)} KB
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
