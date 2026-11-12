import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GoalModeNote } from '@/components/goal-mode';
import {
	AssistantRuntimeProvider,
	ComposerPrimitive,
	MessageNotSentError,
	MessagePrimitive,
	ThreadListItemPrimitive,
	ThreadListPrimitive,
	ThreadPrimitive,
	useAuiState,
	useExternalStoreRuntime,
	type ExternalStoreThreadListAdapter,
	type ThreadMessageLike,
	type TextMessagePartProps,
} from '@assistant-ui/react';
import {
	ArrowDown,
	ArrowLeft,
	ArrowUp,
	Check,
	ChevronRight,
	FileText,
	FlaskConical,
	LoaderCircle,
	PanelRightClose,
	PanelRightOpen,
	Pencil,
	Blocks,
	CalendarClock,
	History,
	MessagesSquare,
	Plus,
	RotateCcw,
	BrainCircuit,
	MessageSquare,
	TriangleAlert,
} from 'lucide-react';
import { api, type Agent, type Design, type PublicSettings, type InterviewAnswers } from '@/api';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';

/** A contract longer than this still works; the panel only warns (every job carries all of it). */
const CONTRACT_RECOMMENDED = 16000;
import { useSlidePanel } from '@/lib/use-slide-panel';
import { IconButton } from '@/components/actions';
import { Character } from '@/Character';
import { OptionSelect } from '@/components/option-select';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ContractMarkdown } from './design-content';
import { HarnessPanel, HarnessTests, SchedulesPanel } from './harness-content';
import { Input } from '@/components/ui/input';
import { DesignFindings, FindingsContext, SearchCall, type FindingsActions } from './design-findings';
import { DesignerProgress, ReasoningPart } from './design-progress';
import { IMPROVE_REQUEST, takeImproveRequest } from '@/lib/sidebar-events';
import { InterviewCard, InterviewContext, type InterviewDrafts, type InterviewDraft } from './interview-card';
import { AttachButton, AttachmentChips, SentAttachments, useAttachments } from './attachments';
import { CopyMessage } from './message-actions';
import { ComposerReferenceChip, ReferencePopover, referenceFormatter, useReferenceMentions } from './references';
import { LexicalComposerInput } from '@assistant-ui/react-lexical';

type Props = {
	design: Design | null;
	agent?: Agent;
	effectivePrompt?: string;
	settings: PublicSettings;
	model: string;
	onModel: (model: string) => void;
	working: boolean;
	loading: boolean;
	canApply: boolean;
	error: string;
	onReload: () => void;
	onReset: () => void;
	onSend: (text: string, attachments?: { name: string; mime: string; data: string }[]) => Promise<void>;
	onAnswer: (answers: InterviewAnswers) => Promise<void>;
	onApprove: () => void;
	onValidate: () => void;
	/** Grants a suggested access (to a new agent: when its proposal is approved). */
	onGrant?: (kind: string, id: number) => Promise<void>;
	/** The owner adds or skips a tool the designer found, or saves a secret it asked for. */
	onFinding?: FindingsActions['decide'];
	onSecret?: FindingsActions['saveSecret'];
	/** Renames the proposal (its contract's name). */
	onRename?: (name: string) => Promise<void>;
	onBack?: () => void;
	notice?: string;
	active?: boolean;
	validating?: boolean;
};
const convertMessage = (message: ThreadMessageLike) => message;
/** One improvement chat of the agent, as the server lists it. */
type ImprovementChat = { id: string; status: 'draft' | 'approved'; title: string; messages: number; updatedAt: number };

/** Automejora → Historial: the agent's improvement chats (assistant-ui's thread list) and a new one. */
function ImprovementHistory({ disabled }: { disabled: boolean }) {
	const [open, setOpen] = useState(false);
	const count = useAuiState((s) => s.threads.threadIds.length);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button type="button" variant="outline" size="sm" disabled={disabled} title="Mejoras anteriores">
					<MessagesSquare aria-hidden="true" />
					Historial
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 p-1">
				<ThreadListPrimitive.Root className="grid gap-0.5" aria-label="Mejoras de este agente">
					<ThreadListPrimitive.New asChild>
						<Button type="button" variant="ghost" size="sm" className="justify-start" onClick={() => setOpen(false)}>
							<Plus aria-hidden="true" />
							Nueva mejora
						</Button>
					</ThreadListPrimitive.New>
					{count === 0 && <p className="muted small px-2 py-1.5">Todavía no hay mejoras anteriores.</p>}
					<div className="max-h-80 overflow-y-auto">
						<ThreadListPrimitive.Items>
							{({ threadListItem }) => <ImprovementItem item={threadListItem} onPick={() => setOpen(false)} />}
						</ThreadListPrimitive.Items>
					</div>
				</ThreadListPrimitive.Root>
			</PopoverContent>
		</Popover>
	);
}

function ImprovementItem({
	item,
	onPick,
}: {
	item: { title?: string; custom?: Record<string, unknown> };
	onPick: () => void;
}) {
	const c = (item.custom ?? {}) as { status?: string; updatedAt?: number; current?: boolean };
	const when = c.updatedAt
		? new Date(c.updatedAt).toLocaleString('es-MX', {
				day: 'numeric',
				month: 'short',
				hour: '2-digit',
				minute: '2-digit',
			})
		: '';
	return (
		<ThreadListItemPrimitive.Root className="rounded-md data-[current=true]:bg-muted" data-current={c.current}>
			<ThreadListItemPrimitive.Trigger
				className="grid w-full gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted"
				onClick={onPick}
				aria-current={c.current ? 'page' : undefined}
			>
				<span className="truncate text-sm">
					<ThreadListItemPrimitive.Title fallback="Mejora sin texto" />
				</span>
				<span className="muted small">
					{c.status === 'approved' ? 'Aplicada' : 'Borrador'}
					{when ? ` · ${when}` : ''}
					{c.current ? ' · abierta' : ''}
				</span>
			</ThreadListItemPrimitive.Trigger>
		</ThreadListItemPrimitive.Root>
	);
}
type Artifact = { name: string; prompt: string };
type ArtifactLink = {
	artifact: Artifact | null;
	version: number;
	lastAssistant: string | undefined;
	panelId: string;
	open: boolean;
	onOpen: (button: HTMLButtonElement) => void;
};
const ArtifactContext = createContext<ArtifactLink | null>(null);
// The images and text files the owner sent with each interview message, by message index.
const FilesContext = createContext<{
	designId: string;
	files: (Design['messages'][number]['attachments'] | undefined)[];
} | null>(null);
// The designer reads images, PDFs, Word files (.docx) and text files; other formats are refused before sending
// (the server reads a document's text; a scanned PDF or an old .doc it refuses with what to do).
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DESIGN_FILES = {
	files: 4,
	fileBytes: 10 * 1024 * 1024,
	totalBytes: 20 * 1024 * 1024,
	accept: `image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf,${DOCX},.docx,text/*,.md,.csv,.tsv,.json,.yaml,.yml,.xml,.log`,
	allow: (f: File) =>
		/^image\/(png|jpeg|gif|webp)$/.test(f.type) ||
		f.type === 'application/pdf' ||
		f.type === DOCX ||
		/\.(pdf|docx)$/i.test(f.name) ||
		f.type.startsWith('text/') ||
		f.type === 'application/json' ||
		/\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|log)$/i.test(f.name),
	rejectMessage:
		'El diseñador lee imágenes (png, jpg, gif, webp), PDF, Word (.docx) y archivos de texto (txt, md, csv, json…). Un Word antiguo (.doc): guárdalo como .docx o PDF.',
};

function ArtifactCard() {
	const data = useContext(ArtifactContext)!;
	if (!data.artifact) return null;
	return (
		<button
			type="button"
			data-open-artifact
			className="designer-artifact-card"
			aria-expanded={data.open}
			aria-controls={data.open ? data.panelId : undefined}
			onClick={(e) => data.onOpen(e.currentTarget)}
		>
			<span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-background">
				<FileText className="size-5 text-primary" aria-hidden="true" />
			</span>
			<span className="grid min-w-0 flex-1 gap-1">
				<span className="truncate text-xs font-medium">{data.artifact.name}</span>
				<span className="text-2xs text-muted-foreground">
					{data.version ? `Contrato · versión ${data.version}` : 'Contrato vigente'} · Abrir
				</span>
			</span>
			<ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		</button>
	);
}
function ContractPreview({ value, text, notice }: { value: string; text: string; notice?: string }) {
	return (
		<TabsContent value={value} className="designer-preview">
			<ScrollArea
				type="auto"
				className="designer-preview-scroll"
				viewportProps={{ tabIndex: 0, 'aria-label': 'Contenido del contrato' }}
			>
				<div className="designer-preview-content">
					{notice && (
						<p className="mb-4 flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-2xs text-muted-foreground">
							<MessageSquare className="mt-px size-3.5 shrink-0 text-primary" aria-hidden="true" />
							{notice}
						</p>
					)}
					<ContractMarkdown text={text} />
				</div>
			</ScrollArea>
		</TabsContent>
	);
}
/** The agent's name in the contract's header: a click edits it (Enter or leaving saves, Escape cancels). */
function NameField({
	name,
	editable,
	onRename,
}: {
	name: string;
	editable: boolean;
	onRename?: (name: string) => Promise<void>;
}) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(name);
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		if (!editing) setValue(name);
	}, [name, editing]);
	if (!editable || !onRename) return <h2 className="min-w-0 flex-1 truncate text-xs font-semibold">{name}</h2>;
	const commit = async () => {
		const next = value.trim();
		if (!next || next === name) return setEditing(false);
		setSaving(true);
		try {
			await onRename(next);
		} finally {
			setSaving(false);
			setEditing(false);
		}
	};
	if (editing)
		return (
			<Input
				autoFocus
				value={value}
				maxLength={40}
				disabled={saving}
				aria-label="Nombre del agente"
				className="h-7 min-w-0 flex-1 px-2 text-xs font-semibold"
				onChange={(e) => setValue(e.target.value)}
				onFocus={(e) => e.currentTarget.select()}
				onBlur={() => void commit()}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						void commit();
					} else if (e.key === 'Escape') {
						e.preventDefault();
						e.stopPropagation(); // not the panel's Escape (closing it)
						setValue(name);
						setEditing(false);
					}
				}}
			/>
		);
	return (
		<h2 className="min-w-0 flex-1 text-xs font-semibold">
			<button
				type="button"
				className="group/name -mx-1.5 flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-accent"
				onClick={() => setEditing(true)}
				title="Renombrar el agente"
			>
				<span className="truncate">{name}</span>
				<Pencil
					className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/name:opacity-100 group-focus-visible/name:opacity-100"
					aria-hidden="true"
				/>
				<span className="sr-only">(renombrar)</span>
			</button>
		</h2>
	);
}
function MessageText({ text }: TextMessagePartProps) {
	return <ContractMarkdown text={text} />;
}
function DesignMessage() {
	const role = useAuiState((s) => s.message.role);
	const id = useAuiState((s) => s.message.id);
	const hasText = useAuiState((s) => s.message.content.some((part) => part.type === 'text' && part.text.length > 0));
	const artifact = useContext(ArtifactContext)!,
		sent = useContext(FilesContext);
	const files = role === 'user' && sent ? sent.files[Number(id.split(':').at(-1))] : undefined;
	if (!hasText) return null; // The backend returns whole structured rounds, not a token stream.
	return (
		<MessagePrimitive.Root className={`designer-message designer-message-${role}`}>
			<span className="sr-only">{role === 'user' ? 'Tú' : 'IA'}</span>
			<div className="designer-message-content">
				<MessagePrimitive.Parts
					components={{ Text: MessageText, Reasoning: ReasoningPart, tools: { Fallback: SearchCall } }}
				/>
			</div>
			{files?.length ? (
				<SentAttachments
					files={files}
					href={(fileId) => `/api/designs/${sent!.designId}/files/${files.find((f) => f.name === fileId)?.id ?? ''}`}
				/>
			) : null}
			{/* What it found goes right under the text that mentions it, before the round's questions. */}
			{role === 'assistant' && <DesignFindings index={Number(id.split(':').at(-1))} />}
			{role === 'assistant' && <InterviewCard index={Number(id.split(':').at(-1))} />}
			{id === artifact.lastAssistant && <ArtifactCard />}
			<CopyMessage />
		</MessagePrimitive.Root>
	);
}

export function DesignChat(props: Props) {
	const { design, onSend } = props;
	const [pending, setPending] = useState<{ text: string; version: number } | null>(null);
	const attach = useAttachments(DESIGN_FILES),
		attachRef = useRef(attach);
	attachRef.current = attach;
	const sending = useRef(false);
	const [interviewDrafts, setInterviewDrafts] = useState<InterviewDrafts>({});
	const updateInterview = (round: number, patch: Partial<InterviewDraft>) =>
		setInterviewDrafts((old) => ({ ...old, [round]: { ...(old[round] ?? { value: {}, other: {} }), ...patch } }));
	const messages = useMemo<ThreadMessageLike[]>(() => {
		const saved: ThreadMessageLike[] = (design?.messages ?? []).map((m, i) => ({
			id: `${design!.id}:${i}`,
			role: m.role,
			content: [
				// Its reasoning (folded), then its searches as finished tool calls, then its answer.
				...(m.reasoning ? [{ type: 'reasoning' as const, text: m.reasoning }] : []),
				// The designer's searches, as finished tool calls before its answer.
				...(m.searches ?? []).map((x, j) => ({
					type: 'tool-call' as const,
					toolCallId: `${design!.id}:${i}:${j}`,
					toolName: x.tool,
					args: { consulta: x.query },
					result: { results: x.results, error: x.error },
				})),
				{ type: 'text' as const, text: m.content || (m.attachments?.length ? 'Archivos adjuntos' : '') },
			],
		}));
		if (pending && (design?.version ?? 0) <= pending.version)
			saved.push({ id: 'pending-user', role: 'user', content: [{ type: 'text', text: pending.text }] });
		return saved;
	}, [design?.id, design?.messages, design?.version, pending]);
	const waiting = !!design?.busy_until && design.busy_until > Date.now();
	// Automejora → Historial: this agent's earlier improvement chats, as assistant-ui's thread list. The
	// current one is marked, not switched to in the runtime: opening another goes through its URL, which
	// loads it as any draft (switching the runtime's thread mid-send would drop the message on its way).
	const agentForHistory = props.agent?.id;
	const [history, setHistory] = useState<ImprovementChat[]>([]);
	useEffect(() => {
		if (agentForHistory === undefined) return;
		let alive = true;
		api<{ designs: ImprovementChat[] }>(`/agents/${agentForHistory}/designs`)
			.then((r) => alive && setHistory(r.designs))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [agentForHistory, design?.id, design?.status, design?.messages.length]);
	const threadList = useMemo<ExternalStoreThreadListAdapter | undefined>(
		() =>
			agentForHistory === undefined
				? undefined
				: {
						threads: history.map((h) => ({
							status: 'regular' as const,
							id: h.id,
							title: h.title,
							custom: { status: h.status, updatedAt: h.updatedAt, current: h.id === design?.id },
						})),
						onSwitchToThread: (id) => {
							if (id !== design?.id) location.hash = `/agent/${agentForHistory}/improve/${id}`;
						},
						onSwitchToNewThread: () => props.onReset(),
					},
		[agentForHistory, history, design?.id, props.onReset],
	);
	const runtime = useExternalStoreRuntime({
		messages,
		convertMessage,
		isRunning: !!pending || waiting,
		isLoading: props.loading,
		isDisabled: props.loading || design?.status === 'approved' || (props.working && !pending && !waiting),
		isSendDisabled: props.working || !props.model,
		adapters: threadList ? { threadList } : undefined,
		onNew: async (message) => {
			if (sending.current) throw new MessageNotSentError();
			const text = message.content
					.filter((part) => part.type === 'text')
					.map((part) => part.text)
					.join('\n'),
				files = attachRef.current.current.current;
			sending.current = true;
			setPending({ text: text || 'Archivos adjuntos', version: design?.version ?? 0 });
			try {
				await onSend(
					text,
					files.map(({ name, mime, data }) => ({ name, mime, data })),
				);
				attachRef.current.clear();
			} catch (err) {
				throw new MessageNotSentError((err as Error).message);
			} finally {
				sending.current = false;
				setPending(null);
			}
		},
	});
	const answer = async (answers: InterviewAnswers) => {
		if (sending.current) throw new Error('Espera a que termine la petición actual.');
		const text = (design?.interview?.pending?.questions ?? [])
			.map(
				(q) =>
					`${q.title}\n${(answers.values[q.id]?.selected ?? []).map((id) => (id === 'other' ? answers.values[q.id].other : (q.options.find((o) => o.id === id)?.label ?? id))).join('; ')}`,
			)
			.join('\n\n');
		sending.current = true;
		setPending({ text, version: design?.version ?? 0 });
		try {
			await props.onAnswer(answers);
		} finally {
			sending.current = false;
			setPending(null);
		}
	};
	// «Usar para mejorar» a chat (hub, sidebar, the chat's menu): the composer starts citing it, so the
	// designer gets what happened there; the owner finishes saying what went wrong.
	const agentId = props.agent?.id;
	useEffect(() => {
		if (agentId === undefined) return;
		const take = () => {
			const chat = takeImproveRequest(agentId);
			if (!chat) return;
			const mention = `@[${chat.title.replace(/[[\]\n]/g, ' ').slice(0, 120)}](conversation:${chat.id})`;
			runtime.thread.composer.setText(`${mention} Esto salió mal en esta conversación: `);
			requestAnimationFrame(() => document.querySelector<HTMLElement>('#designer-message [contenteditable]')?.focus());
		};
		take();
		window.addEventListener(IMPROVE_REQUEST, take);
		return () => window.removeEventListener(IMPROVE_REQUEST, take);
	}, [agentId, runtime]);
	const sendFiles = () =>
		runtime.thread.composer.getState().text.trim()
			? runtime.thread.composer.send()
			: void runtime.thread.append({ role: 'user', content: [{ type: 'text', text: '' }] });
	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<FilesContext.Provider
				value={design ? { designId: design.id, files: design.messages.map((m) => m.attachments) } : null}
			>
				<DesignWorkspace
					{...props}
					onAnswer={answer}
					messages={messages}
					interviewDrafts={interviewDrafts}
					updateInterview={updateInterview}
					attach={attach}
					sendFiles={sendFiles}
				/>
			</FilesContext.Provider>
		</AssistantRuntimeProvider>
	);
}

function DesignWorkspace(
	props: Props & {
		messages: ThreadMessageLike[];
		interviewDrafts: InterviewDrafts;
		updateInterview: (round: number, patch: Partial<InterviewDraft>) => void;
		attach: ReturnType<typeof useAttachments>;
		sendFiles: () => void;
	},
) {
	const { design, agent, messages, settings, model, working, loading } = props;
	const mention = useReferenceMentions(agent?.id);
	const root = useRef<HTMLDivElement>(null);
	const opener = useRef<HTMLButtonElement | null>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const panelId = useId();
	const [wide, setWide] = useState(false);
	const [open, setOpen] = useState(false);
	const [preview, setPreview] = useState('contract');
	const text = useAuiState((s) => s.composer.text);
	const approved = design?.status === 'approved';
	const interviewing = design?.interview?.phase === 'questions';
	const artifact = interviewing
		? null
		: (design?.contract ?? (agent ? { name: agent.name, prompt: agent.role || 'Sin rol personalizado.' } : null));
	const signature =
		!interviewing && design?.contract && (design.version > 0 || design.ready)
			? `${design.id}\0${design.contract.name}\0${design.contract.prompt}\0${JSON.stringify(design.harness)}\0${design.ready}`
			: null;
	useLayoutEffect(() => {
		const element = root.current!;
		const measure = () => setWide(element.clientWidth >= 900);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		setOpen(!!signature);
	}, [signature]);
	useEffect(() => {
		if (!wide && open) closeButton.current?.focus({ preventScroll: true });
	}, [wide, open]);
	const slide = useSlidePanel(open && !!artifact, () => setOpen(false));
	const close = () => {
		setOpen(false);
		requestAnimationFrame(() => {
			const button = opener.current?.isConnected
				? opener.current
				: root.current?.querySelector<HTMLButtonElement>('[data-open-artifact]');
			button?.focus({ preventScroll: true });
		});
	};
	const show = (button: HTMLButtonElement) => {
		opener.current = button;
		setOpen(true);
	};
	const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')?.id;
	const link: ArtifactLink = { artifact, version: design?.version ?? 0, lastAssistant, panelId, open, onOpen: show };
	const testBlocked = interviewing || !design?.ready || working || loading || approved || design.stale || !!text.trim();
	const tested =
		!design?.harness ||
		(design.harness_validation?.status === 'passed' && design.harness_validation.version === design.version);
	const blocked = testBlocked || !props.canApply || !tested;
	const controls = (
		<>
			<div className="w-32 min-w-0 shrink">
				<OptionSelect
					size="sm"
					label="Modelo del diseñador y agente"
					value={design?.model ?? model}
					onValueChange={props.onModel}
					disabled={!!design || working || loading}
					options={
						settings.models.some((m) => m.id === (design?.model ?? model))
							? settings.models
							: [{ id: design?.model ?? model, label: design?.model ?? model }, ...settings.models]
					}
				/>
			</div>
			{artifact && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={(e) => (open ? close() : show(e.currentTarget))}
					aria-label={open ? 'Cerrar contrato' : 'Abrir contrato'}
					title={open ? 'Cerrar contrato' : 'Abrir contrato'}
					aria-expanded={open}
					aria-controls={open ? panelId : undefined}
				>
					<FileText aria-hidden="true" />
					Contrato
				</Button>
			)}
			{design && (
				<Button
					type="button"
					variant="outline"
					size="icon-sm"
					disabled={working || loading}
					onClick={props.onReset}
					aria-label="Empezar de nuevo"
					title="Empezar de nuevo"
				>
					<RotateCcw aria-hidden="true" />
				</Button>
			)}
			{props.agent && <ImprovementHistory disabled={working || loading} />}
		</>
	);
	// Both libraries must observe the same scroll element: no nested native viewport.
	const conversation = (
		<ThreadPrimitive.Root
			className="designer-thread"
			data-empty={messages.length === 0}
			aria-label="Conversación para definir el agente"
		>
			<ScrollArea type="auto" className="designer-thread-scroll" viewportProps={{ asChild: true }}>
				<ThreadPrimitive.Viewport
					className="designer-thread-viewport"
					autoScroll
					tabIndex={0}
					aria-label="Mensajes de la conversación"
				>
					<div role="log" aria-live="polite" aria-busy={working} className="designer-thread-content">
						{messages.length === 0 && (
							<div className="designer-welcome">
								{agent ? (
									<BrainCircuit className="mb-4 size-7 text-primary" aria-hidden="true" />
								) : (
									<MessageSquare className="mb-4 size-7 text-primary" aria-hidden="true" />
								)}
								<h2>{agent ? '¿Qué quieres mejorar?' : '¿Qué quieres delegar?'}</h2>
								<p>
									{agent
										? 'Cuéntame qué resultado esperabas. Revisaremos contrato, herramientas, skills y plugins sin aplicarlos todavía.'
										: 'Cuéntame el trabajo. Te haré preguntas concretas y construiremos su contrato y harness antes de crear su computadora.'}
								</p>
								{artifact && <ArtifactCard />}
							</div>
						)}
						<ThreadPrimitive.Messages components={{ UserMessage: DesignMessage, AssistantMessage: DesignMessage }} />
						{interviewing &&
							!working &&
							messages.length > 0 &&
							!design?.interview?.pending &&
							design?.interview?.completed === 0 && (
								<p role="status" className="rounded-lg border p-3 text-xs text-muted-foreground">
									Este borrador es anterior al cuestionario interactivo. Envía un mensaje para continuar la entrevista
									antes de probar o aprobar; tu conversación anterior se conserva.
								</p>
							)}
						{loading && (
							<p role="status" className="designer-thinking">
								<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
								Recuperando conversación…
							</p>
						)}
						{working &&
							(props.validating || design?.validation_pending ? (
								<p role="status" className="designer-thinking">
									<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
									Probando el harness aislado…
								</p>
							) : (
								<DesignerProgress progress={design?.progress} fallback="Enviando tu mensaje" />
							))}
					</div>
					<div className="pointer-events-none sticky bottom-3 flex h-0 shrink-0 justify-center">
						<ThreadPrimitive.ScrollToBottom asChild>
							<Button
								variant="outline"
								size="icon"
								className="pointer-events-auto -translate-y-full rounded-full bg-card shadow-sm disabled:hidden"
								aria-label="Ir al último mensaje"
							>
								<ArrowDown />
							</Button>
						</ThreadPrimitive.ScrollToBottom>
					</div>
				</ThreadPrimitive.Viewport>
			</ScrollArea>
			<div className="designer-composer-wrap">
				{props.attach.error && (
					<p role="alert" className="error mb-2">
						{props.attach.error}
					</p>
				)}
				<ComposerPrimitive.TriggerPopoverRoot>
					<ComposerPrimitive.Root
						className="designer-composer"
						onDrop={props.attach.onDrop}
						onDragOver={props.attach.onDragOver}
					>
						{agent && <ReferencePopover mention={mention} />}
						<AttachmentChips files={props.attach.files} onRemove={props.attach.remove} />
						{/* Lexical instead of a textarea: a cited job or conversation is a chip here too. */}
						<LexicalComposerInput
							onPaste={props.attach.onPaste}
							id="designer-message"
							aria-label="Mensaje para la IA"
							placeholder={agent ? 'Quiero mejorar…' : 'Describe el agente que necesitas…'}
							className="designer-composer-input designer-composer-lexical"
							formatter={referenceFormatter}
							directiveChip={ComposerReferenceChip}
							submitMode="enter"
						/>
						<div className="designer-composer-actions">
							<div className="flex min-w-0 flex-wrap items-center gap-2" aria-label="Opciones del prompt">
								<AttachButton
									onFiles={(f) => void props.attach.add(f)}
									accept={DESIGN_FILES.accept}
									disabled={working || design?.status === 'approved'}
								/>
								{props.active !== false && controls}
							</div>
							{props.attach.files.length ? (
								<Button
									type="button"
									size="icon"
									className="shrink-0 rounded-full"
									aria-label="Enviar"
									disabled={working || !model}
									onClick={props.sendFiles}
								>
									<ArrowUp aria-hidden="true" />
								</Button>
							) : (
								<ComposerPrimitive.Send asChild>
									<Button size="icon" className="shrink-0 rounded-full" aria-label="Enviar">
										<ArrowUp aria-hidden="true" />
									</Button>
								</ComposerPrimitive.Send>
							)}
						</div>
					</ComposerPrimitive.Root>
				</ComposerPrimitive.TriggerPopoverRoot>
				<p className="mt-2 text-center text-2xs text-muted-foreground">
					{agent ? 'Escribe @ para citar un turno o un trabajo anterior. ' : ''}Tu cuenta GPT · Nada se aplica sin tu
					aprobación.
				</p>
			</div>
		</ThreadPrimitive.Root>
	);
	const contract = artifact && (
		<section
			id={panelId}
			className="designer-contract"
			aria-label="Contrato del agente"
			onKeyDown={(e) => {
				if (e.key === 'Escape' && !e.defaultPrevented) {
					e.preventDefault();
					e.stopPropagation();
					close();
				}
			}}
		>
			<div className="designer-artifact-header">
				{agent ? (
					<Character seed={agent.seed} state="idle" size={24} still />
				) : (
					<FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				)}
				<NameField
					name={artifact.name}
					editable={!!design?.contract && design.status === 'draft' && !working && !loading}
					onRename={props.onRename}
				/>
				{(design?.contract?.prompt.length ?? 0) > CONTRACT_RECOMMENDED && (
					// Not a limit: a long contract works, but every job carries all of it.
					<Tooltip>
						<TooltipTrigger asChild>
							<Badge variant="warning" className="shrink-0 tabular-nums">
								<TriangleAlert aria-hidden="true" />
								{design!.contract!.prompt.length.toLocaleString('es-MX')} /{' '}
								{CONTRACT_RECOMMENDED.toLocaleString('es-MX')}
							</Badge>
						</TooltipTrigger>
						<TooltipContent className="max-w-72">
							Contrato largo: pasa de los {CONTRACT_RECOMMENDED.toLocaleString('es-MX')} caracteres recomendados.
							Funciona igual, pero cada turno lo carga completo (más tokens y costo). Para acortarlo, pídele en el chat
							que lo condense o que pase procedimientos largos a una skill.
						</TooltipContent>
					</Tooltip>
				)}
				<Button
					ref={closeButton}
					variant="ghost"
					size="icon"
					onClick={close}
					aria-label={wide ? 'Cerrar artefacto' : 'Volver al chat'}
				>
					{wide ? <PanelRightClose aria-hidden="true" /> : <ArrowLeft aria-hidden="true" />}
				</Button>
			</div>
			<Tabs value={preview} onValueChange={setPreview} className="min-h-0 flex-1 gap-0">
				<div className="shrink-0 overflow-x-auto border-b px-4 py-2">
					<TabsList aria-label="Vista del contrato">
						{[
							{ value: 'contract', label: 'Contrato', Icon: FileText, show: true },
							{ value: 'harness', label: 'Harness', Icon: Blocks, show: !!design?.harness },
							{ value: 'schedules', label: 'Horarios', Icon: CalendarClock, show: !!design?.harness },
							{ value: 'tests', label: 'Pruebas', Icon: FlaskConical, show: !!design?.harness },
							{ value: 'current', label: 'Vigente', Icon: History, show: !!agent },
						]
							.filter((t) => t.show)
							.map(({ value, label, Icon }) => (
								<TabsTrigger key={value} value={value} aria-label={label} title={label}>
									<Icon aria-hidden="true" />
									<span className="work-tab-label">{label}</span>
								</TabsTrigger>
							))}
					</TabsList>
				</div>
				{/* The full prompt the agent receives (contract + platform rules + harness): read only. */}
				<ContractPreview
					value="contract"
					text={design?.effectivePrompt ?? props.effectivePrompt ?? artifact.prompt}
					notice={
						approved
							? undefined
							: 'Es el prompt completo que recibirá el agente. Para cambiar el contrato, escribe tus observaciones en el chat.'
					}
				/>
				{design?.harness && (
					<>
						<TabsContent value="harness" className="designer-preview">
							<ScrollArea
								type="auto"
								className="designer-preview-scroll"
								viewportProps={{ tabIndex: 0, 'aria-label': 'Contenido del harness' }}
							>
								<div className="designer-preview-content">
									<GoalModeNote proposed={design.goal_mode} current={agent?.goal_mode} />
									<HarnessPanel
										value={design.harness}
										accesses={design.accessSuggestions}
										onGrant={design.status === 'draft' && !working && !loading ? props.onGrant : undefined}
										newAgent={!design.agent_id}
									/>
								</div>
							</ScrollArea>
						</TabsContent>
						<TabsContent value="schedules" className="designer-preview">
							<ScrollArea
								type="auto"
								className="designer-preview-scroll"
								viewportProps={{ tabIndex: 0, 'aria-label': 'Horarios propuestos' }}
							>
								<div className="designer-preview-content">
									<SchedulesPanel design={design} />
								</div>
							</ScrollArea>
						</TabsContent>
						<TabsContent value="tests" className="designer-preview">
							<ScrollArea
								type="auto"
								className="designer-preview-scroll"
								viewportProps={{ tabIndex: 0, 'aria-label': 'Resultado de pruebas' }}
							>
								<div className="designer-preview-content">
									<HarnessTests
										checks={design.harnessChecks ?? []}
										report={design.harness_validation}
										version={design.version}
										pending={props.validating || (working && design.validation_pending)}
									/>
								</div>
							</ScrollArea>
						</TabsContent>
					</>
				)}
				{agent && (
					<ContractPreview
						value="current"
						text={design?.currentContract?.prompt ?? agent.role ?? 'Sin rol personalizado.'}
					/>
				)}
			</Tabs>
			{/* Only the actions: what they do and why one is disabled go in their tooltips. */}
			<div className="designer-artifact-footer">
				{design?.harness && !approved && (
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="min-w-0 flex-1" tabIndex={testBlocked ? 0 : undefined}>
								<Button
									type="button"
									variant="outline"
									className="w-full"
									onClick={() => {
										setPreview('tests');
										props.onValidate();
									}}
									disabled={testBlocked}
								>
									<FlaskConical aria-hidden="true" />
									{props.validating || (working && design.validation_pending)
										? 'Probando…'
										: tested
											? 'Volver a probar'
											: 'Probar harness'}
								</Button>
							</span>
						</TooltipTrigger>
						<TooltipContent side="top" className="max-w-xs">
							{text.trim()
								? 'Tienes un mensaje sin enviar.'
								: !design.ready
									? 'Continúa la conversación para resolver las decisiones pendientes.'
									: 'Prueba el harness de esta revisión en una computadora aislada.'}
						</TooltipContent>
					</Tooltip>
				)}
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="min-w-0 flex-1" tabIndex={blocked ? 0 : undefined}>
							<Button className="w-full" onClick={props.onApprove} disabled={blocked}>
								<Check className="size-4" aria-hidden="true" />
								{agent && approved ? 'Ya aplicada' : agent ? 'Aprobar y aplicar' : 'Aprobar e inicializar'}
							</Button>
						</span>
					</TooltipTrigger>
					<TooltipContent side="top" className="max-w-xs">
						{text.trim()
							? 'Tienes un mensaje sin enviar. Envíalo o bórralo antes de aprobar.'
							: !design?.ready && !approved
								? 'Continúa la conversación para resolver las decisiones pendientes.'
								: design?.ready && !tested && !approved
									? 'Falta una prueba correcta de esta misma revisión antes de aprobar.'
									: agent && !props.canApply
										? 'Para aplicarla, termina o cancela la corrida activa.'
										: agent
											? 'Aprueba contrato, modelo, harness y horarios. Se aplican en corridas nuevas; conservan conversación y memoria. No conceden accesos de plataforma.'
											: 'Prueba y aprueba contrato, modelo, harness y horarios antes de inicializar. Conversar o probar no crea un agente.'}
					</TooltipContent>
				</Tooltip>
			</div>
		</section>
	);
	return (
		<InterviewContext.Provider
			value={{
				design,
				drafts: props.interviewDrafts,
				update: props.updateInterview,
				onAnswer: props.onAnswer,
				blocked: working || loading || approved || !!text.trim(),
				working,
				unsent: !!text.trim(),
			}}
		>
			<FindingsContext.Provider
				value={
					design && props.onFinding && props.onSecret
						? {
								messages: design.messages,
								blocked: working || loading || approved,
								decide: props.onFinding,
								saveSecret: props.onSecret,
							}
						: null
				}
			>
				<ArtifactContext.Provider value={link}>
					<div ref={root} className="designer designer-page" data-artifact-open={open && !!artifact}>
						{!agent && (
							<header className="designer-toolbar">
								{props.onBack && (
									<Button variant="ghost" size="icon" onClick={props.onBack} aria-label="Volver a agentes">
										<ArrowLeft />
									</Button>
								)}
								<div className="min-w-0 flex-1">
									<h1 className="sr-only text-sm sm:not-sr-only sm:truncate">Diseña tu agente</h1>
								</div>
							</header>
						)}
						{props.notice && (
							<p role="status" className="shrink-0 border-b border-success/30 bg-success/5 px-4 py-3 text-xs">
								{props.notice}
							</p>
						)}
						{props.error && (
							<div role="alert" className="designer-alert border-destructive/30 bg-destructive/5">
								<span className="min-w-0 flex-1">{props.error}</span>
								{/proveedor GPT|gateway GPT|CLIProxyAPI|API key|cuenta GPT/i.test(props.error) && (
									<a href="#/settings" className="text-primary underline">
										Ajustes de GPT
									</a>
								)}
								<Button variant="outline" size="xs" onClick={props.onReload} disabled={working || loading}>
									Recargar borrador
								</Button>
							</div>
						)}
						{design?.stale && (
							<p role="alert" className="designer-alert border-warning/30 bg-warning-soft text-warning-on-soft">
								El agente cambió desde que empezaste. Inicia una propuesta nueva para no sobrescribir su configuración.
							</p>
						)}
						<div className="designer-workspace">
							{wide && artifact && !open && (
								// Where the contract's own close button was: open it again from the same spot.
								<IconButton
									icon={PanelRightOpen}
									label="Abrir contrato"
									aria-expanded={false}
									className="panel-reopen designer-panel-reopen"
									onClick={(e) => show(e.currentTarget)}
								/>
							)}
							{wide ? (
								<ResizablePanelGroup
									orientation="horizontal"
									id="design-workspace"
									className="slide-split"
									data-animating={slide.animating}
								>
									<ResizablePanel id="conversation" minSize="34%">
										{conversation}
									</ResizablePanel>
									{contract && (
										<>
											<ResizableHandle
												withHandle
												hidden={!open}
												disabled={!open}
												className="designer-resize-handle bg-transparent focus-visible:bg-transparent focus-visible:ring-0"
												aria-label="Redimensionar chat y contrato"
											/>
											{/* Stays mounted and slides open and closed. */}
											<ResizablePanel
												id="contract"
												panelRef={slide.ref}
												minSize="34%"
												maxSize="66%"
												defaultSize="50%"
												collapsible
												collapsedSize={0}
												onResize={slide.onResize}
											>
												<div className="h-full min-w-0" inert={!open} aria-hidden={!open}>
													{contract}
												</div>
											</ResizablePanel>
										</>
									)}
								</ResizablePanelGroup>
							) : (
								<>
									<div className="h-full min-h-0" hidden={open && !!artifact} inert={open && !!artifact}>
										{conversation}
									</div>
									{open && contract}
								</>
							)}
						</div>
					</div>
				</ArtifactContext.Provider>
			</FindingsContext.Provider>
		</InterviewContext.Provider>
	);
}
