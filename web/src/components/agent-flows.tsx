// Tareas (#18): Configuración lists the agent's lists of tasks, each leading to its trabajo's hub; there
// (FlowDetail) a list is a canvas of its tasks (nodes pulse while they work or wait; edges move into what is
// under way), the saga of everything that happened, and each node's detail. Its owner answers the list's
// questions there and may stop one.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, Bot, Clock, Handshake, MessageCircleQuestion, Square, Users, type LucideIcon } from 'lucide-react';
import { api, ago } from '@/api';
import { InfoTip } from '@/WhatsApp';
import { DelegationDetail } from '@/components/agent-delegations';
import { useConfirm } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type FlowStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'expired';
type StepStatus = 'pending' | 'working' | 'waiting' | 'blocked' | 'done' | 'skipped' | 'failed' | 'removed';
type Kind = 'agent' | 'subagent' | 'delegation' | 'question' | 'wait';
type Field = { name: string; description: string; type: 'text' | 'number' | 'boolean' };
type Item = {
	id: number;
	title: string;
	/** Its recipe's name; null for a free list. */
	recipe: string | null;
	conversation_id: number | null;
	status: FlowStatus;
	waiting_for: string | null;
	waiting_since: string | null;
	created_at: string;
	ended_at: string | null;
	steps: number;
	done: number;
};
type Step = {
	id: number;
	key: string;
	title: string;
	kind: Kind;
	depends: string[];
	spec: {
		instructions: string;
		optional: boolean;
		hours: number | null;
		encargo: { plantilla: string; contacto: string; parametros: Record<string, string>; contexto: string } | null;
		/** A question: what the agent wrote for its owner, and the files it sent with it. */
		question?: string;
		files?: string[];
	};
	status: StepStatus;
	result: unknown;
	note: string | null;
	delegation_id: number | null;
	until: string | null;
	started_at: string | null;
	ended_at: string | null;
};
type Event = { id: number; step_key: string | null; kind: string; text: string; at: string };
type Detail = {
	flow: {
		id: number;
		title: string;
		recipe: { name: string; objective: string; produces: { list: boolean; fields: Field[] }; maxWakes: number } | null;
		conversation_id: number | null;
		status: FlowStatus;
		waiting_for: string | null;
		waiting_since: string | null;
		result: unknown;
		summary: string | null;
		end_reason: string | null;
		wakes: number;
		deadline: string;
		created_at: string;
	};
	steps: Step[];
	events: Event[];
	facts: { source: string; text: string; at: string }[];
};

const FLOW_STATUS: Record<FlowStatus, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> =
	{
		running: { label: 'En curso', variant: 'default' },
		done: { label: 'Terminado', variant: 'secondary' },
		failed: { label: 'Falló', variant: 'destructive' },
		cancelled: { label: 'Cancelado', variant: 'outline' },
		expired: { label: 'Vencido', variant: 'outline' },
	};
const STEP_STATUS: Record<StepStatus, string> = {
	pending: 'Pendiente',
	working: 'En curso',
	waiting: 'Esperando',
	blocked: 'Bloqueada',
	done: 'Lista',
	skipped: 'Omitida',
	failed: 'Falló',
	removed: 'Quitado',
};
const KIND: Record<Kind, { label: string; icon: LucideIcon }> = {
	agent: { label: 'Agente', icon: Bot },
	subagent: { label: 'Subagente', icon: Users },
	delegation: { label: 'Encargo', icon: Handshake },
	question: { label: 'Pregunta', icon: MessageCircleQuestion },
	wait: { label: 'Espera', icon: Clock },
};
const when = (iso: string) => ago(new Date(iso).getTime());
const clock = (iso: string) =>
	new Date(iso).toLocaleString('es-MX', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function AgentFlows({
	agentId,
	onOpenJob,
}: {
	agentId: number;
	/** Opens the trabajo's hub at its list of tasks (closing Configuración). */
	onOpenJob?: (conversationId: number) => void;
}) {
	const [items, setItems] = useState<Item[] | null>(null);
	const [open, setOpen] = useState<number | null>(null);
	const [error, setError] = useState('');
	useEffect(() => {
		let gone = false;
		const load = () =>
			api<{ flows: Item[] }>(`/agents/${agentId}/flows`)
				.then((r) => !gone && setItems(r.flows))
				.catch((e) => !gone && setError((e as Error).message));
		void load();
		const timer = setInterval(load, 10_000);
		return () => {
			gone = true;
			clearInterval(timer);
		};
	}, [agentId]);
	if (open) return <FlowDetail agentId={agentId} id={open} onBack={() => setOpen(null)} />;
	return (
		<section className="panel min-w-0" aria-label="Tareas">
			<h2 className="inline-flex items-center gap-2">
				Tareas
				<InfoTip label="Qué son las tareas">
					La lista de tareas de cada trabajo de varios pasos: la escribe el agente (o la precarga una receta de su
					contrato) y tú la editas desde el chat del trabajo. La plataforma lleva sus encargos, preguntas a ti y esperas
					(también la respuesta de una persona), y despierta al agente cuando una tarea es suya. Cada cambio queda en su
					historia con el motivo.
				</InfoTip>
			</h2>
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
			{!items ? (
				!error && (
					<p role="status" className="muted">
						Cargando flujos…
					</p>
				)
			) : items.length ? (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Flujo</TableHead>
							<TableHead>Estado</TableHead>
							<TableHead>Espera a</TableHead>
							<TableHead className="text-right">Tareas</TableHead>
							<TableHead className="text-right">Cuándo</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{items.map((f) => (
							<TableRow
								key={f.id}
								className="cursor-pointer"
								onClick={() => (f.conversation_id && onOpenJob ? onOpenJob(f.conversation_id) : setOpen(f.id))}
							>
								<TableCell>
									<button type="button" className="font-medium underline-offset-4 hover:underline">
										#{f.id} · {f.title}
									</button>
									<span className="muted small">
										{' '}
										· {f.conversation_id ? `trabajo #${f.conversation_id} · ` : ''}
										{f.recipe ? `receta ${f.recipe}` : 'lista libre'}
									</span>
								</TableCell>
								<TableCell>
									<Badge variant={FLOW_STATUS[f.status].variant}>{FLOW_STATUS[f.status].label}</Badge>
								</TableCell>
								<TableCell className="muted small">
									{f.waiting_for ? `${f.waiting_for}${f.waiting_since ? ` · ${when(f.waiting_since)}` : ''}` : '—'}
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{f.done}/{f.steps}
								</TableCell>
								<TableCell className="muted small text-right">{when(f.created_at)}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			) : (
				<p className="muted">
					Este agente todavía no tiene listas de tareas: las escribe cuando un trabajo tiene varios pasos. Para trabajos
					que se repiten, pídele en Automejora una receta (por ejemplo, «el carrito de la semana: cotizar en el súper y
					con la carnicería, armarlo y preguntarme si lo compro»).
				</p>
			)}
		</section>
	);
}

/** One step as a node: its kind, title and state; it pulses while it is under way. */
function StepNode({ data }: NodeProps<Node<{ step: Step; selected: boolean }>>) {
	const s = data.step;
	const K = KIND[s.kind];
	const live = s.status === 'working' || s.status === 'waiting';
	return (
		<div
			className={`flow-node flow-node-${s.status} ${live ? 'flow-node-live' : ''} ${data.selected ? 'flow-node-selected' : ''}`}
			title={s.spec.instructions || s.title}
		>
			<Handle type="target" position={Position.Left} isConnectable={false} />
			<div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
				<K.icon className="size-3.5" aria-hidden="true" />
				{K.label}
				{s.spec.optional ? ' · opcional' : ''}
			</div>
			<div className="truncate text-xs font-medium">{s.title}</div>
			<div className="text-2xs">{STEP_STATUS[s.status]}</div>
			<Handle type="source" position={Position.Right} isConnectable={false} />
		</div>
	);
}
const nodeTypes = { step: StepNode };

/** Left to right by depth (a step goes after everything it depends on), top to bottom within a column. */
function layout(steps: Step[], selected: string | null) {
	const depth = new Map<string, number>();
	for (const s of steps) depth.set(s.key, 1 + Math.max(-1, ...s.depends.map((d) => depth.get(d) ?? 0)));
	const rows = new Map<number, number>();
	const nodes: Node<{ step: Step; selected: boolean }>[] = steps.map((s) => {
		const col = depth.get(s.key)!;
		const row = rows.get(col) ?? 0;
		rows.set(col, row + 1);
		return {
			id: s.key,
			type: 'step',
			position: { x: col * 230, y: row * 100 },
			data: { step: s, selected: s.key === selected },
		};
	});
	const byKey = new Map(steps.map((s) => [s.key, s]));
	const edges: Edge[] = steps.flatMap((s) =>
		s.depends
			.filter((d) => byKey.has(d))
			.map((d) => ({
				id: `${d}->${s.key}`,
				source: d,
				target: s.key,
				// Data moving: into what is under way now.
				animated: s.status === 'working' || s.status === 'waiting',
				className: s.status === 'removed' || byKey.get(d)!.status === 'removed' ? 'flow-edge-removed' : '',
			})),
	);
	return { nodes, edges };
}

/** One list of tasks: its canvas, the selected task's detail, what is established and its saga. */
export function FlowDetail({
	agentId,
	id,
	onBack,
	bare = false,
	view = 'all',
	selectStep = null,
	onPickStep,
}: {
	agentId: number;
	id: number;
	onBack?: () => void;
	/** In a trabajo's hub: without its title, summary and what is established (the hub's description has them). */
	bare?: boolean;
	/** The canvas with its tasks' detail, the saga, or both (Configuración). The hub gives each its tab. */
	view?: 'all' | 'canvas' | 'saga';
	/** A task to select on the canvas (picked in the saga). */
	selectStep?: string | null;
	/** The saga's line of a task was picked: the hub shows it on the canvas. */
	onPickStep?: (key: string) => void;
}) {
	const [d, setD] = useState<Detail | null>(null);
	const [error, setError] = useState('');
	const [selected, setSelected] = useState<string | null>(null);
	const [showRemoved, setShowRemoved] = useState(false);
	const saga = useRef<HTMLDivElement>(null);
	const [ask, confirmDialog] = useConfirm();
	useEffect(() => {
		if (selectStep) setSelected(selectStep);
	}, [selectStep]);
	const canvas = view !== 'saga',
		sagaShown = view !== 'canvas';
	const reload = () =>
		api<Detail>(`/agents/${agentId}/flows/${id}`)
			.then((r) => setD(r))
			.catch((e) => setError((e as Error).message));
	useEffect(() => {
		let gone = false;
		const load = () =>
			api<Detail>(`/agents/${agentId}/flows/${id}`)
				.then((r) => !gone && setD(r))
				.catch((e) => !gone && setError((e as Error).message));
		void load();
		// Live: the saga grows as things happen.
		const timer = setInterval(load, 4_000);
		return () => {
			gone = true;
			clearInterval(timer);
		};
	}, [agentId, id]);
	const events = d?.events.length ?? 0;
	useEffect(() => {
		saga.current?.scrollTo({ top: saga.current.scrollHeight });
	}, [events]);
	const steps = useMemo(
		() => (d ? d.steps.filter((s) => showRemoved || s.status !== 'removed') : []),
		[d, showRemoved],
	);
	const graph = useMemo(() => layout(steps, selected), [steps, selected]);
	const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
	if (!d)
		return (
			<section className="panel min-w-0">
				{onBack && (
					<Button variant="ghost" size="sm" onClick={onBack}>
						<ArrowLeft aria-hidden="true" />
						Tareas
					</Button>
				)}
				<p role={error ? 'alert' : 'status'} className={error ? 'error' : 'muted'}>
					{error || 'Cargando…'}
				</p>
			</section>
		);
	const f = d.flow;
	const step = d.steps.find((s) => s.key === selected) ?? null;
	const stop = async () => {
		if (
			!(await ask({
				title: '¿Detener esta lista de tareas?',
				description: 'Sus encargos en curso se cancelan y el agente deja de despertar por ella.',
				action: 'Detener',
				destructive: true,
			}))
		)
			return;
		try {
			await api(`/agents/${agentId}/flows/${id}/stop`, { method: 'POST' });
			await reload();
		} catch (e) {
			setError((e as Error).message);
		}
	};
	return (
		<section className={bare ? 'min-w-0' : 'panel min-w-0'} aria-label={`Flujo ${f.id}`}>
			{confirmDialog}
			<div className={canvas && !bare ? 'flex flex-wrap items-center justify-between gap-2' : 'hidden'}>
				{onBack ? (
					<Button variant="ghost" size="sm" onClick={onBack}>
						<ArrowLeft aria-hidden="true" />
						Tareas
					</Button>
				) : (
					<span />
				)}
				{f.status === 'running' && (
					<Button variant="danger-ghost" size="sm" onClick={() => void stop()}>
						<Square aria-hidden="true" />
						Detener
					</Button>
				)}
			</div>
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
			<div className="mt-2 grid min-w-0 gap-3">
				{!bare && (
					<div>
						<h2 className="inline-flex flex-wrap items-center gap-2">
							#{f.id} · {f.title}
							<Badge variant={FLOW_STATUS[f.status].variant}>{FLOW_STATUS[f.status].label}</Badge>
						</h2>
						<p className="muted small mt-1">
							{f.recipe ? `Receta ${f.recipe.name}` : 'Lista libre'}
							{f.conversation_id ? ` del trabajo #${f.conversation_id}` : ''} ·{' '}
							{f.status === 'running'
								? f.waiting_for
									? `espera a ${f.waiting_for}${f.waiting_since ? ` desde ${when(f.waiting_since)}` : ''}`
									: 'trabajando'
								: (f.end_reason ?? 'terminó')}{' '}
							· {f.wakes}
							{f.recipe ? ` de ${f.recipe.maxWakes}` : ''} despertares ·{' '}
							{f.status === 'running' ? `vence ${clock(f.deadline)}` : ''}
						</p>
						{f.summary && <p className="mt-1 text-sm">{f.summary}</p>}
					</div>
				)}
				{canvas && (
					<div
						className={`flow-canvas min-w-0 rounded-lg border ${bare ? 'h-[min(75vh,760px)] min-h-[420px]' : 'h-[340px]'}`}
						aria-label="Lienzo del flujo"
					>
						<ReactFlow
							nodes={graph.nodes}
							edges={graph.edges}
							nodeTypes={nodeTypes}
							onNodeClick={(_, n) => setSelected((k) => (k === n.id ? null : n.id))}
							nodesDraggable={false}
							nodesConnectable={false}
							fitView
							fitViewOptions={{ padding: 0.2 }}
							colorMode={dark ? 'dark' : 'light'}
							proOptions={{ hideAttribution: true }}
						>
							<Background />
							<Controls showInteractive={false} />
						</ReactFlow>
					</div>
				)}
				{canvas && d.steps.some((s) => s.status === 'removed') && (
					<label data-slot="label" className="muted small inline-flex items-center gap-2">
						<input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
						Mostrar las tareas que se quitaron
					</label>
				)}
				{canvas && step && (
					<StepPanel agentId={agentId} flowId={f.id} step={step} running={f.status === 'running'} onDone={reload} />
				)}
				{canvas && f.status === 'done' && f.recipe && <Result fields={f.recipe.produces.fields} value={f.result} />}
				{!bare && !!d.facts.length && (
					<div className="text-sm">
						<h3 className="text-sm font-medium">Ya establecido</h3>
						<ul className="mt-1 list-disc space-y-1 pl-4">
							{d.facts.map((x, i) => (
								<li key={i} className="break-words">
									<span className="muted small">
										{x.source === 'owner' ? 'Tú' : x.source === 'contact' ? 'Contacto' : 'Agente'}:
									</span>{' '}
									{x.text}
								</li>
							))}
						</ul>
					</div>
				)}
				{sagaShown && (
					<div className="grid min-w-0 gap-1" aria-label="Saga">
						<h3 className={view === 'saga' ? 'sr-only' : 'text-sm font-medium'}>Saga</h3>
						<div
							ref={saga}
							className={`overflow-y-auto rounded-lg border p-2 text-xs ${view === 'saga' ? 'max-h-[min(75vh,760px)]' : 'max-h-[320px]'}`}
						>
							{d.events.map((e) => (
								<button
									key={e.id}
									type="button"
									onClick={() => e.step_key && (onPickStep ? onPickStep(e.step_key) : setSelected(e.step_key))}
									className={`flex w-full gap-2 rounded px-1 py-0.5 text-left ${e.step_key ? 'hover:bg-muted' : 'cursor-default'} ${e.step_key && e.step_key === selected ? 'bg-muted' : ''}`}
								>
									<span className="muted w-24 shrink-0 tabular-nums">{clock(e.at)}</span>
									<span className={`flow-event flow-event-${e.kind} min-w-0 break-words`}>{e.text}</span>
								</button>
							))}
						</div>
					</div>
				)}
			</div>
		</section>
	);
}

/** A node's detail: what it was asked, what it got; its encargo's conversation; a question's answer box. */
function StepPanel({
	agentId,
	flowId,
	step,
	running,
	onDone,
}: {
	agentId: number;
	flowId: number;
	step: Step;
	running: boolean;
	onDone: () => void;
}) {
	const [answer, setAnswer] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const send = async () => {
		setBusy(true);
		setError('');
		try {
			await api(`/agents/${agentId}/flows/${flowId}/steps/${step.key}/answer`, { body: { texto: answer } });
			setAnswer('');
			onDone();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="grid min-w-0 gap-2 rounded-lg border p-3 text-sm" aria-label={`Paso ${step.key}`}>
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium">{step.title}</span>
				<Badge variant="outline">{KIND[step.kind].label}</Badge>
				<span className="muted small">
					{STEP_STATUS[step.status]}
					{step.depends.length ? ` · después de ${step.depends.join(', ')}` : ''}
					{step.until ? ` · hasta ${clock(step.until)}` : ''}
				</span>
			</div>
			{step.spec.question ? (
				<p className="whitespace-pre-wrap break-words font-medium">
					{step.spec.question}
					{step.spec.files?.length ? (
						<span className="muted small block font-normal">Adjuntó: {step.spec.files.join(', ')}</span>
					) : null}
				</p>
			) : null}
			{step.spec.instructions && (
				<p className={`whitespace-pre-wrap break-words ${step.spec.question ? 'muted small' : ''}`}>
					{step.spec.question ? `Lo que el agente debía preguntar: ${step.spec.instructions}` : step.spec.instructions}
				</p>
			)}
			{step.spec.encargo && (
				<p className="muted small">
					Encargo «{step.spec.encargo.plantilla}» con {step.spec.encargo.contacto || '(contacto por elegir)'}
					{Object.keys(step.spec.encargo.parametros).length
						? ` · ${Object.entries(step.spec.encargo.parametros)
								.map(([k, v]) => `${k}: ${v}`)
								.join(' · ')}`
						: ''}
				</p>
			)}
			{step.note && <p className="muted small">{step.note}</p>}
			{step.result !== null && step.result !== undefined && (
				<pre className="max-h-48 overflow-auto rounded bg-muted/50 p-2 text-2xs whitespace-pre-wrap break-words">
					{JSON.stringify(step.result, null, 2)}
				</pre>
			)}
			{step.kind === 'question' && step.status === 'waiting' && running && (
				<div className="grid gap-2">
					<Textarea
						aria-label="Tu respuesta"
						value={answer}
						onChange={(e) => setAnswer(e.target.value)}
						placeholder="Tu respuesta (también puedes contestar en tu grupo de WhatsApp)"
					/>
					<Button
						size="sm"
						className="justify-self-start"
						disabled={busy || !answer.trim()}
						onClick={() => void send()}
					>
						Responder
					</Button>
					{error && (
						<p role="alert" className="error">
							{error}
						</p>
					)}
				</div>
			)}
			{step.delegation_id && <DelegationDetail agentId={agentId} id={step.delegation_id} />}
		</div>
	);
}

/** What the flow produced, in its recipe's fields. */
function Result({ fields, value }: { fields: Field[]; value: unknown }) {
	const list = (Array.isArray(value) ? value : value ? [value] : []) as Record<string, unknown>[];
	const show = (v: unknown) =>
		v === null || v === undefined ? '—' : typeof v === 'boolean' ? (v ? 'Sí' : 'No') : String(v);
	return (
		<div className="grid min-w-0 gap-1">
			<h3 className="text-sm font-medium">Resultado</h3>
			<Table>
				<TableHeader>
					<TableRow>
						{fields.map((f) => (
							<TableHead key={f.name} title={f.description}>
								{f.name}
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{list.map((r, i) => (
						<TableRow key={i}>
							{fields.map((f) => (
								<TableCell key={f.name} className={f.type === 'number' ? 'tabular-nums' : ''}>
									{show(r?.[f.name])}
								</TableCell>
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
