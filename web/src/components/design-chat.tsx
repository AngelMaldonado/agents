import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
	AssistantRuntimeProvider,
	ComposerPrimitive,
	MessageNotSentError,
	MessagePrimitive,
	ThreadPrimitive,
	useAuiState,
	useExternalStoreRuntime,
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
	LoaderCircle,
	PanelRightClose,
	RotateCcw,
	BrainCircuit,
	MessageSquare,
} from 'lucide-react';
import type { Agent, Design, PublicSettings, InterviewAnswers } from '@/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { OptionSelect } from '@/components/option-select';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ContractMarkdown } from './design-content';
import { HarnessPanel, HarnessChanges, HarnessTests, SchedulesPanel } from './harness-content';
import { InterviewCard, InterviewContext, type InterviewDrafts, type InterviewDraft } from './interview-card';
import { AttachButton, AttachmentChips, SentAttachments, useAttachments } from './attachments';
import { CopyMessage } from './message-actions';
import { ReferencePopover, useReferenceMentions } from './references';

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
	onBack?: () => void;
	notice?: string;
	active?: boolean;
	validating?: boolean;
};
const convertMessage = (message: ThreadMessageLike) => message;
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
// The designer reads images and text files; other formats are refused before sending.
const DESIGN_FILES = {
	files: 4,
	fileBytes: 5 * 1024 * 1024,
	totalBytes: 20 * 1024 * 1024,
	accept: 'image/png,image/jpeg,image/gif,image/webp,text/*,.md,.csv,.tsv,.json,.yaml,.yml,.xml,.log',
	allow: (f: File) =>
		/^image\/(png|jpeg|gif|webp)$/.test(f.type) ||
		f.type.startsWith('text/') ||
		f.type === 'application/json' ||
		/\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|log)$/i.test(f.name),
	rejectMessage: 'El diseñador lee imágenes (png, jpg, gif, webp) y archivos de texto (txt, md, csv, json…).',
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
function ContractPreview({ value, text }: { value: string; text: string }) {
	return (
		<TabsContent value={value} className="designer-preview">
			<ScrollArea
				type="auto"
				className="designer-preview-scroll"
				viewportProps={{ tabIndex: 0, 'aria-label': 'Contenido del contrato' }}
			>
				<div className="designer-preview-content">
					<ContractMarkdown text={text} />
				</div>
			</ScrollArea>
		</TabsContent>
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
				<MessagePrimitive.Parts components={{ Text: MessageText }} />
			</div>
			{files?.length ? (
				<SentAttachments
					files={files}
					href={(fileId) => `/api/designs/${sent!.designId}/files/${files.find((f) => f.name === fileId)?.id ?? ''}`}
				/>
			) : null}
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
			content: [{ type: 'text', text: m.content || (m.attachments?.length ? 'Archivos adjuntos' : '') }],
		}));
		if (pending && (design?.version ?? 0) <= pending.version)
			saved.push({ id: 'pending-user', role: 'user', content: [{ type: 'text', text: pending.text }] });
		return saved;
	}, [design?.id, design?.messages, design?.version, pending]);
	const waiting = !!design?.busy_until && design.busy_until > Date.now();
	const runtime = useExternalStoreRuntime({
		messages,
		convertMessage,
		isRunning: !!pending || waiting,
		isLoading: props.loading,
		isDisabled: props.loading || design?.status === 'approved' || (props.working && !pending && !waiting),
		isSendDisabled: props.working || !props.model,
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
					size="icon-sm"
					onClick={(e) => show(e.currentTarget)}
					aria-label="Abrir contrato"
					title="Abrir contrato"
					aria-expanded={open}
					aria-controls={open ? panelId : undefined}
				>
					<FileText aria-hidden="true" />
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
						{working && (
							<p role="status" className="designer-thinking">
								<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
								{props.validating || design?.validation_pending
									? 'Probando el harness aislado…'
									: design?.ready
										? 'Procesando…'
										: 'Pensando en la siguiente decisión…'}
							</p>
						)}
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
						<ComposerPrimitive.Input
							onPaste={props.attach.onPaste}
							id="designer-message"
							aria-label="Mensaje para la IA"
							placeholder={agent ? 'Quiero mejorar…' : 'Describe el agente que necesitas…'}
							className="designer-composer-input"
							minRows={2}
							maxRows={6}
							maxLength={8000}
							autoFocus={false}
							submitMode="enter"
							addAttachmentOnPaste={false}
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
					{agent ? 'Escribe @ para citar un trabajo o una conversación anterior. ' : ''}Tu cuenta GPT · Nada se aplica
					sin tu aprobación.
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
				<FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<h2 className="min-w-0 flex-1 truncate text-xs font-semibold">{artifact.name}</h2>
				<Badge variant="outline">
					{approved ? 'Aprobado' : design?.ready ? 'Listo para revisar' : design ? 'Borrador' : 'Vigente'}
				</Badge>
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
						<TabsTrigger value="contract">Contrato</TabsTrigger>
						{design?.harness && (
							<>
								<TabsTrigger value="harness">Harness</TabsTrigger>
								<TabsTrigger value="schedules">Horarios</TabsTrigger>
								<TabsTrigger value="changes">Cambios</TabsTrigger>
								<TabsTrigger value="tests">Pruebas</TabsTrigger>
							</>
						)}
						<TabsTrigger value="effective">Prompt completo</TabsTrigger>
						{agent && <TabsTrigger value="current">Vigente</TabsTrigger>}
					</TabsList>
				</div>
				<ContractPreview value="contract" text={artifact.prompt} />
				{design?.harness && (
					<>
						<TabsContent value="harness" className="designer-preview">
							<ScrollArea
								type="auto"
								className="designer-preview-scroll"
								viewportProps={{ tabIndex: 0, 'aria-label': 'Contenido del harness' }}
							>
								<div className="designer-preview-content">
									<HarnessPanel value={design.harness} />
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
						<TabsContent value="changes" className="designer-preview">
							<ScrollArea
								type="auto"
								className="designer-preview-scroll"
								viewportProps={{ tabIndex: 0, 'aria-label': 'Cambios propuestos' }}
							>
								<div className="designer-preview-content">
									<HarnessChanges design={design} agent={agent} />
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
										report={design.harness_validation}
										version={design.version}
										pending={props.validating || (working && design.validation_pending)}
									/>
								</div>
							</ScrollArea>
						</TabsContent>
					</>
				)}
				<ContractPreview
					value="effective"
					text={
						design?.effectivePrompt ??
						props.effectivePrompt ??
						'Las reglas obligatorias aparecerán con la primera propuesta.'
					}
				/>
				{agent && (
					<ContractPreview
						value="current"
						text={design?.currentContract?.prompt ?? agent.role ?? 'Sin rol personalizado.'}
					/>
				)}
			</Tabs>
			<div className="designer-artifact-footer">
				<p className="mb-3 text-xs text-muted-foreground">
					{agent
						? 'Aprueba contrato, modelo, harness y horarios. Se aplican en corridas nuevas; conservan conversación y memoria. No conceden accesos de plataforma.'
						: 'Prueba y aprueba contrato, modelo, harness y horarios antes de inicializar. Conversar o probar no crea un agente.'}
				</p>
				{design?.harness && !approved && (
					<Button
						type="button"
						variant="outline"
						className="mb-2 w-full whitespace-normal"
						onClick={() => {
							setPreview('tests');
							props.onValidate();
						}}
						disabled={testBlocked}
					>
						{props.validating || (working && design.validation_pending)
							? 'Probando harness…'
							: tested
								? 'Volver a probar harness'
								: 'Probar harness'}
					</Button>
				)}
				<Button className="w-full whitespace-normal" onClick={props.onApprove} disabled={blocked}>
					<Check className="size-4" aria-hidden="true" />
					{agent ? 'Aprobar y aplicar mejora' : 'Aprobar e inicializar agente'}
				</Button>
				{design?.ready && !tested && !approved && (
					<p className="mt-2 text-2xs text-muted-foreground">
						Falta una prueba correcta de esta misma revisión antes de aprobar.
					</p>
				)}
				{!design?.ready && !approved && (
					<p className="mt-2 text-2xs text-muted-foreground">
						Continúa la conversación para resolver las decisiones pendientes.
					</p>
				)}
				{agent && !props.canApply && (
					<p className="mt-2 text-2xs text-muted-foreground">
						Puedes preparar la propuesta; para aplicarla, termina o cancela la corrida activa.
					</p>
				)}
				{!!text.trim() && (
					<p className="mt-2 text-2xs text-muted-foreground">
						Tienes un mensaje sin enviar. Envíalo o bórralo antes de aprobar.
					</p>
				)}
				{design && (
					<p className="mt-3 text-2xs text-muted-foreground">
						{design.tokens.toLocaleString('es-MX')} tokens · versión {design.version}
					</p>
				)}
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
						{wide ? (
							<ResizablePanelGroup orientation="horizontal" id="design-workspace">
								<ResizablePanel id="conversation" minSize="34%" defaultSize={open && artifact ? '50%' : '100%'}>
									{conversation}
								</ResizablePanel>
								{open && contract && (
									<>
										<ResizableHandle
											withHandle
											className="designer-resize-handle bg-transparent focus-visible:bg-transparent focus-visible:ring-0"
											aria-label="Redimensionar chat y contrato"
										/>
										<ResizablePanel id="contract" minSize="34%" maxSize="66%" defaultSize="50%">
											{contract}
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
		</InterviewContext.Provider>
	);
}
