import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {
	AssistantRuntimeProvider,
	ComposerPrimitive,
	MessagePrimitive,
	QueueItemPrimitive,
	ThreadPrimitive,
	useAuiState,
	useExternalStoreRuntime,
	MessageNotSentError,
	type ExternalThreadQueueAdapter,
} from '@assistant-ui/react';
import { ArrowUp, Globe, MessageSquare, Pencil, Terminal, X } from 'lucide-react';
import {
	api,
	isLive,
	type Agent,
	type Artifact,
	type Task,
	type TaskEvent,
	type WorkRecord,
	type ConversationInput,
	type Conversation,
	type InterviewAnswers,
	type Question,
} from '@/api';
import { workTranscript, type WorkBinding } from '@/lib/work-transcript';
import { helpReplyTarget } from '@/lib/work-access';
import { ArtifactMarkdown, ArtifactCards } from './artifacts';
import { Questionnaire, type QuestionDraft } from './questionnaire';
import { ConversationTabs } from './conversation-tabs';
import { Button } from './ui/button';
import { AttachButton, AttachmentChips, SentAttachments, useAttachments } from './attachments';
import { CopyMessage } from './message-actions';
import { ScrollArea } from './ui/scroll-area';
type Props = {
	agent: Agent & { mine: boolean };
	task: Task | null;
	events: TaskEvent[];
	files: Artifact[];
	historical: boolean;
	active: boolean;
	onRefresh: () => Promise<void>;
	conversation?: Conversation;
	conversations?: Conversation[];
	records?: WorkRecord[];
	inputs?: ConversationInput[];
	loading?: boolean;
	loadError?: string;
	onSelect?: (id: number) => Promise<void>;
	onCreate?: () => Promise<void>;
	onArchive?: (id: number, archived: boolean) => Promise<void>;
	onLoadEarlier?: () => Promise<void>;
	hasEarlier?: boolean;
	waitingForComputer?: boolean;
	// Shared agents: busyWith names who the agent works for now (not me); directs says whose tasks I may answer.
	busyWith?: string | null;
	directs?: (t: Task) => boolean;
};
type ChatContext = {
	unsent: boolean;
	instanceId: string;
	props: Props;
	bindings: Map<string, WorkBinding>;
	lastByRun: Map<number, string>;
	busy: boolean;
	error: string;
	onAnswer: (taskId: number, a: InterviewAnswers) => Promise<void>;
	drafts: Record<string, QuestionDraft>;
	updateDraft: (key: string, patch: Partial<QuestionDraft>) => void;
};
const Context = createContext<ChatContext | null>(null);
function WorkMessage() {
	const { unsent, instanceId, props, bindings, lastByRun, busy, onAnswer, drafts, updateDraft } = useContext(Context)!;
	const role = useAuiState((s) => s.message.role);
	const id = useAuiState((s) => s.message.id),
		binding = bindings.get(id),
		record = binding?.record,
		event = binding?.event,
		task = record?.task;
	const blocked = event?.kind === 'blocked' ? event : null;
	const receipt = blocked ? record?.events.find((e) => e.kind === 'help_answer' && e.data.round === blocked.id) : null;
	const textReply = blocked ? record?.events.find((e) => e.kind === 'help_reply' && e.data.round === blocked.id) : null;
	const control = record
		? [...record.events].reverse().find((e) => ['blocked', 'steer', 'unblocked'].includes(e.kind))
		: null;
	const expired = !!blocked && record?.events.some((e) => e.kind === 'help_expired' && e.data.round === blocked.id);
	const pending = !!blocked && task?.status === 'blocked' && control?.kind === 'blocked' && control.id === blocked.id;
	const questions: Question[] = Array.isArray(blocked?.data.questions) ? blocked.data.questions : [];
	const editable =
		props.agent.mine &&
		!props.historical &&
		props.active &&
		!props.conversation?.archived_at &&
		(!task || !props.directs || props.directs(task));
	const draftKey = task && blocked ? `${task.id}:${blocked.id}` : '';
	return (
		<MessagePrimitive.Root className={`work-message designer-message designer-message-${role}`}>
			<span className="sr-only">{role === 'user' ? 'Tú' : 'Agente'}</span>
			{binding?.steps ? (
				<WorkSteps steps={binding.steps} live={!!task && isLive(task) && id === lastByRun.get(task.id)} />
			) : (
				<div className="work-message-body designer-message-content">
					<MessagePrimitive.Parts
						components={{
							Text: ({ text }) => (
								<ArtifactMarkdown
									text={text}
									agentId={props.agent.id}
									runId={task?.id ?? 0}
									files={record?.artifacts ?? []}
								/>
							),
						}}
					/>
				</div>
			)}
			{binding?.input?.files?.length ? (
				<SentAttachments
					files={binding.input.files}
					href={(name) =>
						`/api/agents/${props.agent.id}/messages/${binding.input!.id}/files/${encodeURIComponent(name)}`
					}
				/>
			) : null}
			{binding?.pending && (
				<p className="text-xs text-muted-foreground" role="status">
					Mensaje pendiente; se entregará sólo en esta conversación.
				</p>
			)}
			{blocked && task && (
				<div className="work-questionnaire" data-help-round={blocked.id}>
					{questions.length > 0 && !textReply && !pending && !receipt ? (
						<details className="mt-3 text-xs text-muted-foreground">
							<summary>Solicitud anterior · ya terminó</summary>
							<ul className="mt-2 list-disc pl-4">
								{questions.map((q) => (
									<li key={q.id}>{q.title}</li>
								))}
							</ul>
						</details>
					) : questions.length > 0 && !textReply ? (
						<Questionnaire
							key={draftKey}
							id={`${instanceId}:help:${draftKey}`}
							round={blocked.id}
							questions={questions}
							answered={receipt?.data.answers}
							draft={drafts[draftKey] ?? { value: {}, other: {} }}
							update={(patch) => updateDraft(draftKey, patch)}
							onAnswer={(a) => onAnswer(task.id, a)}
							blocked={!editable || !pending || busy || unsent || !!expired}
							working={busy}
							unsent={unsent}
							legend="Respuesta al agente"
							receiptTitle={
								expired
									? 'Respuesta guardada, no entregada'
									: pending
										? 'Respuestas guardadas; esperando entrega'
										: 'Respuestas enviadas'
							}
						/>
					) : pending && !textReply ? (
						<p className="text-sm text-muted-foreground">Responde escribiendo en el chat.</p>
					) : null}
					{textReply && pending && (
						<p className="text-xs text-muted-foreground" role="status">
							Respuesta guardada; esperando entrega.
						</p>
					)}
				</div>
			)}
			{task && id === lastByRun.get(task.id) && (
				<ArtifactCards files={record?.artifacts ?? []} agentId={props.agent.id} runId={task.id} />
			)}
			{!binding?.steps && <CopyMessage />}
		</MessagePrimitive.Root>
	);
}
/** The agent's steps between two of its messages; open while it is still working on them. */
function WorkSteps({ steps, live }: { steps: TaskEvent[]; live: boolean }) {
	const icon = (e: TaskEvent) =>
		(e.data.name === 'bash' && /agent-browser/.test(e.data.summary)) || e.data.name === 'browser'
			? Globe
			: e.data.name === 'bash'
				? Terminal
				: Pencil;
	return (
		<details className="work-steps" open={live}>
			<summary>
				{live ? <span className="work-steps-live" aria-hidden="true" /> : null}
				{live ? 'Trabajando' : 'Trabajó'} · {steps.length} {steps.length === 1 ? 'paso' : 'pasos'}
			</summary>
			<ol>
				{steps.slice(-40).map((e) => {
					const Icon = icon(e);
					return (
						<li key={e.id}>
							<Icon aria-hidden="true" />
							<span className="min-w-0 truncate" title={e.data.summary}>
								{e.data.summary || e.data.name}
							</span>
						</li>
					);
				})}
			</ol>
			{steps.length > 40 && (
				<p className="text-2xs text-muted-foreground">
					Últimos 40 de {steps.length}. El detalle completo está en Actividad y Terminal.
				</p>
			)}
		</details>
	);
}
export function WorkChat(props: Props) {
	const { agent, task, historical, active, onRefresh, conversation } = props;
	const instanceId = useId();
	const viewport = useRef<HTMLDivElement>(null),
		scrollMemory = useRef<{ top: number; atBottom: boolean } | null>(null);
	const [followEnabled, setFollowEnabled] = useState(active);
	useLayoutEffect(() => {
		if (!active) {
			setFollowEnabled(false);
			return;
		}
		const el = viewport.current,
			saved = scrollMemory.current;
		if (el && saved) {
			// Hidden elements look "at bottom" to the library's ResizeObserver. Restore reader intent
			// while following is paused, then let assistant-ui resume its normal scroll behavior.
			el.scrollTop = saved.atBottom ? el.scrollHeight : saved.top;
			el.dispatchEvent(new Event('scroll'));
		}
		setFollowEnabled(true);
	}, [active]);
	const [busy, setBusy] = useState(false),
		[error, setError] = useState('');
	const sending = useRef(false);
	const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
	const draftRef = useRef(drafts);
	draftRef.current = drafts;
	const updateDraft = (key: string, patch: Partial<QuestionDraft>) =>
		setDrafts((old) => ({ ...old, [key]: { ...(old[key] ?? { value: {}, other: {} }), ...patch } }));
	const records = useMemo(
		() => props.records ?? (task ? [{ task, events: props.events, artifacts: props.files }] : []),
		[props.records, task, props.events, props.files],
	);
	const transcript = useMemo(() => workTranscript(records, props.inputs ?? []), [records, props.inputs]);
	const current = useRef(props);
	current.current = props;
	const attach = useAttachments({ files: 10, fileBytes: 10 * 1024 * 1024, totalBytes: 25 * 1024 * 1024 });
	const attachRef = useRef(attach);
	attachRef.current = attach;
	const request = useRef<{ key: string; sig: string; replyTo?: { runId: number; round: number } } | null>(null);
	const composingIntent = useRef<{ runId: number; round: number } | null | undefined>(undefined);
	const replyTarget = () => {
		const p = current.current;
		return helpReplyTarget(p.task, p.events, !!p.task && (!p.directs || p.directs(p.task)));
	};
	const newMessage = useCallback(async (message: { content: readonly { type: string; text?: string }[] }) => {
		const p = current.current,
			text = message.content
				.filter((c) => c.type === 'text')
				.map((c) => c.text ?? '')
				.join('\n')
				.trim(),
			files = attachRef.current.current.current;
		if (
			(!text && !files.length) ||
			!p.agent.mine ||
			p.historical ||
			!p.active ||
			!p.conversation ||
			p.conversation.archived_at ||
			p.loading
		)
			throw new MessageNotSentError('No puedes enviar en esta vista.');
		if (sending.current) throw new MessageNotSentError('Espera a que termine la petición actual.');
		if (text.length > 4000) throw new MessageNotSentError('El mensaje es demasiado largo. Máximo 4000 caracteres.');
		sending.current = true;
		setBusy(true);
		setError('');
		const sig = `${text}\n${files.map((f) => f.id).join(',')}`;
		if (!request.current || request.current.sig !== sig) {
			// Files never answer a help question: they go as their own message to the conversation.
			const replyTo = files.length
				? null
				: composingIntent.current === undefined
					? replyTarget()
					: composingIntent.current;
			request.current = { key: crypto.randomUUID(), sig, ...(replyTo ? { replyTo } : {}) };
		}
		try {
			const r = request.current;
			await api(`/agents/${p.agent.id}/conversations/${p.conversation.id}/messages`, {
				method: 'POST',
				body: {
					text,
					requestId: r.key,
					...(r.replyTo ? { replyTo: r.replyTo } : {}),
					...(files.length ? { attachments: files.map(({ name, mime, data }) => ({ name, mime, data })) } : {}),
				},
			});
			request.current = null;
			composingIntent.current = undefined;
			attachRef.current.clear();
			// A durable acknowledgement wins even if refreshing the transcript fails; never resend an accepted message.
			await p.onRefresh().catch(() => {});
		} catch (e) {
			setError((e as Error).message);
			throw new MessageNotSentError((e as Error).message);
		} finally {
			sending.current = false;
			setBusy(false);
		}
	}, []);
	const list = useMemo(
		() =>
			props.conversations?.map((c) => ({
				id: String(c.id),
				title: c.title || 'Conversación',
				archived: !!c.archived_at,
			})),
		[props.conversations],
	);
	// While the agent works, what you send waits in the run's queue (server side): send one now or remove it.
	const working =
		!!task &&
		isLive(task) &&
		task.status !== 'blocked' &&
		task.kind !== 'browser' &&
		agent.mine &&
		!historical &&
		!props.busyWith;
	const queued = useMemo(
		() => (props.inputs ?? []).filter((m) => m.routed_as === 'queued' && m.run_id === task?.id),
		[props.inputs, task?.id],
	);
	const queueAction = async (id: string, path: string, method: string) => {
		const p = current.current;
		if (!p.conversation) return;
		setError('');
		try {
			await api(`/agents/${p.agent.id}/conversations/${p.conversation.id}/messages/${id}${path}`, { method });
			await p.onRefresh().catch(() => {});
		} catch (e) {
			setError((e as Error).message);
		}
	};
	const queue = useMemo<ExternalThreadQueueAdapter | undefined>(
		() =>
			working
				? {
						items: queued.map((m) => ({
							id: String(m.id),
							prompt: m.text,
							parts: [{ type: 'text' as const, text: m.text || 'Archivos adjuntos' }],
						})),
						steerItems: [],
						enqueue: (m) => void newMessage(m).catch(() => {}),
						steer: (m) => void newMessage(m).catch(() => {}),
						move: (id, placement) => {
							if (placement.lane === 'steer') void queueAction(id, '/send', 'POST');
						},
						edit: () => {},
						remove: (id) => void queueAction(id, '', 'DELETE'),
					}
				: undefined,
		[working, queued, newMessage],
	);
	const runtime = useExternalStoreRuntime({
		messages: transcript.messages,
		convertMessage: (m) => m,
		isRunning: busy || working,
		isDisabled:
			!agent.mine ||
			historical ||
			!active ||
			!conversation ||
			!!props.loading ||
			!!props.loadError ||
			!!conversation?.archived_at,
		onNew: newMessage,
		adapters: {
			...(queue ? { queue } : {}),
			...(list
				? {
						threadList: {
							threadId: conversation ? String(conversation.id) : 'no-open-conversation',
							threads: list
								.filter((c) => !c.archived || !agent.mine)
								.map((c) => ({ id: c.id, title: c.title, status: 'regular' as const })),
							archivedThreads: agent.mine
								? list.filter((c) => c.archived).map((c) => ({ id: c.id, title: c.title, status: 'archived' as const }))
								: [],
							onSwitchToThread: async (id) => {
								try {
									await current.current.onSelect?.(Number(id));
								} catch (e) {
									setError((e as Error).message);
								}
							},
							onSwitchToNewThread: agent.mine
								? async () => {
										setError('');
										try {
											await current.current.onCreate?.();
										} catch (e) {
											setError((e as Error).message);
										}
									}
								: undefined,
							onArchive: agent.mine
								? async (id) => {
										setError('');
										try {
											await current.current.onArchive?.(Number(id), true);
										} catch (e) {
											setError((e as Error).message);
										}
									}
								: undefined,
							onUnarchive: agent.mine
								? async (id) => {
										setError('');
										try {
											await current.current.onArchive?.(Number(id), false);
										} catch (e) {
											setError((e as Error).message);
										}
									}
								: undefined,
						},
					}
				: {}),
		},
	});
	const hasText = useRef(false),
		[unsent, setUnsent] = useState(false);
	useEffect(() => {
		const composer = runtime.thread.composer;
		return composer.subscribe(() => {
			hasText.current = composer.getState().text.trim().length > 0;
			setUnsent(hasText.current);
		});
	}, [runtime]);
	useEffect(() => {
		const guard = (e: BeforeUnloadEvent) => {
			if (
				hasText.current ||
				Object.values(draftRef.current).some(
					(d) => Object.values(d.value).some((v) => v.length) || Object.values(d.other).some((v) => v.trim()),
				)
			) {
				e.preventDefault();
				e.returnValue = '';
			}
		};
		window.addEventListener('beforeunload', guard);
		return () => window.removeEventListener('beforeunload', guard);
	}, []);
	const onAnswer = async (taskId: number, answers: InterviewAnswers) => {
		const p = current.current;
		if (!p.agent.mine || p.historical || !p.active) return;
		if (sending.current) throw new Error('Espera a que termine la petición actual.');
		sending.current = true;
		setBusy(true);
		setError('');
		try {
			await api(`/tasks/${taskId}/help`, { method: 'POST', body: answers });
			await p.onRefresh().catch(() => {});
		} catch (e) {
			setError((e as Error).message);
			throw e;
		} finally {
			sending.current = false;
			setBusy(false);
		}
	};
	useEffect(() => {
		const answered = new Set(
			records.flatMap((r) =>
				r.events
					.filter((e) => ['help_answer', 'help_reply'].includes(e.kind))
					.map((e) => `${r.task.id}:${e.data.round}`),
			),
		);
		setDrafts((ds) =>
			Object.keys(ds).some((k) => answered.has(k))
				? Object.fromEntries(Object.entries(ds).filter(([k]) => !answered.has(k)))
				: ds,
		);
	}, [records]);
	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<Context.Provider
				value={{
					unsent,
					instanceId,
					props,
					bindings: transcript.bindings,
					lastByRun: transcript.lastByRun,
					busy,
					error,
					onAnswer,
					drafts,
					updateDraft,
				}}
			>
				<ThreadPrimitive.Root className="work-chat designer-thread" data-empty={transcript.messages.length === 0}>
					{list && <ConversationTabs readOnly={!agent.mine} disabled={busy} />}
					<ScrollArea type="auto" className="designer-thread-scroll" viewportProps={{ asChild: true }}>
						<ThreadPrimitive.Viewport
							ref={viewport}
							className="designer-thread-viewport work-chat-viewport"
							autoScroll={active && followEnabled}
							onScroll={(e) => {
								const el = e.currentTarget;
								if (current.current.active && el.clientHeight)
									scrollMemory.current = {
										top: el.scrollTop,
										atBottom: el.scrollHeight - el.clientHeight - el.scrollTop < 4,
									};
							}}
							turnAnchor="bottom"
							tabIndex={0}
							aria-label="Conversación de trabajo"
						>
							<div
								className="designer-thread-content work-chat-messages"
								role="log"
								aria-live={active ? 'polite' : 'off'}
							>
								{props.hasEarlier && (
									<Button
										variant="ghost"
										size="sm"
										disabled={!!props.loading}
										onClick={() => void props.onLoadEarlier?.()}
									>
										Cargar mensajes anteriores
									</Button>
								)}
								{props.loading && !props.loadError && (
									<p role="status" className="text-sm text-muted-foreground">
										Cargando conversación…
									</p>
								)}
								{props.loadError && (
									<div role="alert" className="error">
										{props.loadError}
										<Button variant="ghost" size="sm" onClick={() => void onRefresh()}>
											Reintentar
										</Button>
									</div>
								)}
								{transcript.messages.length === 0 && !props.loading && !props.loadError && (
									<div className="work-chat-empty">
										<MessageSquare aria-hidden="true" />
										<h2>{historical ? 'Conversación guardada' : '¿Qué quieres resolver?'}</h2>
										<p>
											{historical
												? 'Esta ejecución no tiene mensajes de trabajo.'
												: `Escribe a ${agent.name}. Puedes continuar aquí después de cada ejecución.`}
										</p>
										{conversation && !conversation.is_default && (
											<p>
												Este chat tiene su propio contexto. Comparte archivos y navegador con las demás conversaciones;
												el agente trabaja en una a la vez. Los canales y horarios continúan en Principal.
											</p>
										)}
									</div>
								)}
								<ThreadPrimitive.Messages components={{ UserMessage: WorkMessage, AssistantMessage: WorkMessage }} />
							</div>
						</ThreadPrimitive.Viewport>
					</ScrollArea>
					<div className="work-composer designer-composer-wrap">
						{error && (
							<p role="alert" className="error mb-2">
								{error}
							</p>
						)}
						{historical ? (
							<p className="text-sm text-muted-foreground">
								Ejecución histórica · sólo lectura. Vuelve a la conversación para continuar.
							</p>
						) : !agent.mine ? (
							<p className="text-sm text-muted-foreground">Sólo el dueño puede dirigir este trabajo.</p>
						) : !conversation ? (
							<p className="text-sm text-muted-foreground">
								Abre una nueva conversación o retoma una desde Recientes. Las anteriores se conservan.
							</p>
						) : conversation.archived_at ? (
							<p className="text-sm text-muted-foreground">Tab cerrado. Reábrelo desde Recientes para continuar.</p>
						) : (
							<>
								{attach.error && (
									<p role="alert" className="error mb-2">
										{attach.error}
									</p>
								)}
								<ComposerPrimitive.Root
									className="designer-composer"
									onSubmitCapture={(e) => {
										if (busy) {
											e.preventDefault();
											e.stopPropagation();
										}
									}}
									onDrop={attach.onDrop}
									onDragOver={attach.onDragOver}
								>
									<ComposerPrimitive.Queue>
										{() => (
											<div className="queue-item">
												<span className="queue-tag">En cola</span>
												<QueueItemPrimitive.Text className="queue-text" />
												<QueueItemPrimitive.Steer asChild>
													<Button
														type="button"
														size="sm"
														variant="ghost"
														title="Entregarlo ya, a mitad de su paso actual"
													>
														Enviar ahora
													</Button>
												</QueueItemPrimitive.Steer>
												<QueueItemPrimitive.Remove asChild>
													<Button
														type="button"
														size="icon"
														variant="ghost"
														className="size-7"
														aria-label="Quitar de la cola"
													>
														<X aria-hidden="true" />
													</Button>
												</QueueItemPrimitive.Remove>
											</div>
										)}
									</ComposerPrimitive.Queue>
									<AttachmentChips files={attach.files} onRemove={attach.remove} />
									<ComposerPrimitive.Input
										onPaste={attach.onPaste}
										aria-label="Mensaje al agente"
										placeholder={
											props.busyWith
												? 'Escribe; tu mensaje esperará a que termine…'
												: task?.status === 'blocked' && (!props.directs || props.directs(task))
													? 'Responde al agente…'
													: props.waitingForComputer
														? 'Escribe; tu mensaje esperará su turno…'
														: task && isLive(task)
															? 'Escribe; el mensaje quedará pendiente…'
															: 'Escribe al agente…'
										}
										className="designer-composer-input"
										minRows={2}
										maxRows={6}
										maxLength={4000}
										submitMode="enter"
										autoFocus={false}
										addAttachmentOnPaste={false}
										onChange={(e) => {
											if (!e.target.value.trim()) {
												composingIntent.current = undefined;
												request.current = null;
											} else if (composingIntent.current === undefined) composingIntent.current = replyTarget();
										}}
									/>
									<div className="designer-composer-actions">
										<AttachButton onFiles={(f) => void attach.add(f)} disabled={busy || !!props.loading} />
										{attach.files.length && !unsent ? (
											<Button
												type="button"
												size="icon"
												aria-label="Enviar adjuntos"
												disabled={busy || !!props.loading}
												onClick={() => void newMessage({ content: [] }).catch(() => {})}
											>
												<ArrowUp aria-hidden="true" />
											</Button>
										) : (
											<ComposerPrimitive.Send asChild>
												<Button size="icon" aria-label="Enviar mensaje" disabled={busy || !!props.loading}>
													<ArrowUp aria-hidden="true" />
												</Button>
											</ComposerPrimitive.Send>
										)}
									</div>
								</ComposerPrimitive.Root>
								<p className="text-xs text-muted-foreground" role={props.busyWith ? 'status' : undefined}>
									{props.busyWith ? (
										<>
											<strong>Ocupado</strong> con la tarea de {props.busyWith}. Tu mensaje esperará a que termine y
											luego el agente lo atiende como una tarea nueva.
										</>
									) : props.waitingForComputer ? (
										'El agente trabaja en otra conversación. Tu mensaje esperará su turno.'
									) : task && isLive(task) ? (
										'El agente está trabajando: lo que envíes queda en cola y lo recibe al terminar su paso actual.'
									) : (
										'Una conversación puede continuar durante varias ejecuciones.'
									)}
								</p>
							</>
						)}
					</div>
				</ThreadPrimitive.Root>
			</Context.Provider>
		</AssistantRuntimeProvider>
	);
}
