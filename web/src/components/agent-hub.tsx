// The agent's hub (Bubble agents #25), below its current work: a composer that starts a new chat,
// its chats like Claude's «Recientes», and the files its runs produced. Plus the current work's
// footer: who ran it and for how long.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowUp, Clock3, Download, FileText, Image, Table2 } from 'lucide-react';
import { api, ago, isLive, type Agent, type Conversation, type Task } from '@/api';
import { artifactFileUrl, artifactUrl } from '@/lib/artifacts';
import { cn } from '@/lib/utils';
import { AttachButton, AttachmentChips, useAttachments } from '@/components/attachments';
import { Button } from '@/components/ui/button';

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
				<span className="min-w-0 truncate">
					<span className="text-muted-foreground">{verb} </span>
					<span className="font-medium">{who}</span>
					<span className="text-muted-foreground">
						{' · '}
						{chatHref ? (
							<a href={chatHref} className="underline-offset-4 hover:underline">
								Trabajo #{task.id}
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
		<section className="hub-composer" aria-label="Nuevo trabajo">
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

/** The agent's chats, newest activity first, like Claude's «Recientes». */
export function ChatHistory({
	agentId,
	conversations,
	loading,
	error,
	onRetry,
}: {
	agentId: number;
	conversations: Conversation[];
	loading: boolean;
	error: string;
	onRetry: () => void;
}) {
	const [all, setAll] = useState(false);
	const sorted = [...conversations].sort((a, b) => (b.last_at ?? b.started_at) - (a.last_at ?? a.started_at));
	const shown = all ? sorted : sorted.slice(0, SHOWN);
	return (
		<section className="hub-section" aria-labelledby="hub-recents">
			<h2 id="hub-recents" className="hub-section-title">
				Recientes
			</h2>
			{error ? (
				<p role="alert" className="error">
					{error}{' '}
					<Button variant="outline" size="sm" onClick={onRetry}>
						Reintentar
					</Button>
				</p>
			) : loading && !conversations.length ? (
				<p role="status" className="muted small">
					Cargando chats…
				</p>
			) : !conversations.length ? (
				<p className="muted small">Todavía no hay chats.</p>
			) : (
				<>
					<ul className="hub-list">
						{shown.map((c) => (
							<li key={c.id}>
								<a href={`#/agent/${agentId}/chat/${c.id}`} className="hub-row">
									<span className={cn('min-w-0 truncate', c.archived_at && 'text-muted-foreground')}>
										{c.title || 'Conversación'}
									</span>
									<span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
										{c.archived_at && <span className="rounded-sm bg-muted px-1.5 py-0.5 text-2xs">Cerrada</span>}
										{ago(c.last_at ?? c.started_at)}
									</span>
								</a>
							</li>
						))}
					</ul>
					{sorted.length > SHOWN && (
						<Button variant="ghost" size="sm" className="mt-1" onClick={() => setAll((v) => !v)}>
							{all ? 'Ver menos' : `Ver todos (${sorted.length})`}
						</Button>
					)}
				</>
			)}
		</section>
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
