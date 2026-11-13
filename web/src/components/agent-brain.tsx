// Configuración → Avanzado (Angel 12-nov-2026): the agent as a character. Its card (face, level = its revision,
// its model, its five personality dials, the rubric it is judged by), its skill tree (the harness by branch:
// tools, skills, MCP, CLI, plugins, encargo templates and recipes) and its prompt by sections (its contract's,
// editable and reorderable; the platform's and its personality's, to read). Tuning is easy: a node clicked off
// or a star changed goes to a background test on its computer's image and applies only if it passes; if it
// fails, the agent stays as it was and the error shows.
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
	BookOpen,
	Brain,
	ChevronRight,
	Globe,
	Handshake,
	GripVertical,
	Loader2,
	Lock,
	MessageCircle,
	Network,
	Pencil,
	Plug,
	ScrollText,
	Sparkles,
	SquareTerminal,
	Star,
	TriangleAlert,
	Workflow,
	X,
	type LucideIcon,
} from 'lucide-react';
import { api, type Agent, type Harness, type PublicSettings } from '@/api';
import {
	PLUGINS,
	RUBRIC,
	TOOLS,
	type DelegationField,
	type DelegationTemplate,
	type FlowRecipe,
} from '../../../sandbox/harness';
import { DIALS, personalitySection, type Personality } from '../../../shared/personality';
import { useAgentConfiguration } from '@/AgentConfiguration';
import { AgentFace } from '@/components/agent-face';
import { AgentStyle } from '@/components/agent-style';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { OptionSelect } from '@/components/option-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ContractMarkdown } from '@/components/design-content';
import { RecipeDetail, TemplateDetail } from '@/components/harness-content';
import { cn } from '@/lib/utils';
import { keepOpenForVim } from '@/lib/vim-escape';

// Its editor (CodeMirror, markdown): loaded when a section opens.
const RoleEditor = lazy(() => import('@/components/role-editor').then((m) => ({ default: m.RoleEditor })));
// The canvas library is heavy: loaded when a workflow opens.
const RecipeCanvas = lazy(() => import('@/components/agent-flows').then((m) => ({ default: m.RecipeCanvas })));

type Tune = {
	id: number;
	status: 'testing' | 'waiting' | 'applied' | 'failed';
	summary: string;
	error: string | null;
	revision: number | null;
};
type ToolId = (typeof TOOLS)[number]['id'];
const toolOf = (id: string) => TOOLS.find((t) => t.id === id);
/** Always on: the platform needs it to reach its owner. */
const REQUIRED: ToolId[] = ['request_help'];

/** Its latest tune, followed while it is tested; `request` sends a harness to test. */
function useTune(agentId: number, onApplied: () => void) {
	const [tune, setTune] = useState<Tune | null>(null);
	const [pending, setPending] = useState<Harness | null>(null);
	const [error, setError] = useState('');
	const live = tune && (tune.status === 'testing' || tune.status === 'waiting');
	const applied = useRef(onApplied);
	applied.current = onApplied;
	useEffect(() => {
		let gone = false;
		const load = () =>
			api<{ tune: Tune | null }>(`/agents/${agentId}/tune`)
				.then((r) => {
					if (gone) return;
					setTune((before) => {
						if (before && (before.status === 'testing' || before.status === 'waiting') && r.tune?.id === before.id) {
							if (r.tune.status === 'applied') applied.current();
							if (r.tune.status === 'applied' || r.tune.status === 'failed') setPending(null);
						}
						return r.tune;
					});
				})
				.catch(() => {});
		void load();
		if (!live) return () => void (gone = true);
		const timer = setInterval(load, 2000);
		return () => {
			gone = true;
			clearInterval(timer);
		};
	}, [agentId, live]);
	const request = async (harness: Harness, summary: string) => {
		setError('');
		try {
			const r = await api<{ tune: Tune }>(`/agents/${agentId}/tune`, { body: { harness, summary } });
			setPending(harness);
			setTune(r.tune);
		} catch (e) {
			setError((e as Error).message);
		}
	};
	return { tune, pending, busy: !!live, error, clearError: () => setError(''), request };
}

export function AgentBrain({
	agent,
	settings,
	mine,
	onChanged,
}: {
	agent: Agent;
	settings: PublicSettings;
	mine: boolean;
	onChanged: () => void;
}) {
	const { data, error, retry } = useAgentConfiguration(agent);
	const tuning = useTune(agent.id, onChanged);
	const [dismissed, setDismissed] = useState<number | null>(null);
	if (error)
		return (
			<div className="panel">
				<p role="alert" className="error">
					{error}
				</p>
				<Button variant="outline" size="sm" onClick={retry}>
					Reintentar
				</Button>
			</div>
		);
	if (!data?.harness)
		return (
			<p role="status" className="muted">
				Cargando…
			</p>
		);
	const current = { ...agent, ...data.agent };
	const h = tuning.pending ?? data.harness;
	const t = tuning.tune;
	const tune = (next: Harness, summary: string) => mine && !tuning.busy && void tuning.request(next, summary);
	const notice = (tuning.error || (t && t.id !== dismissed && t.status !== 'applied')) && (
		<div
			className={cn('brain-tune', (tuning.error || t?.status === 'failed') && 'is-failed')}
			role={tuning.busy ? 'status' : 'alert'}
		>
			{tuning.busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
			<span className="min-w-0 flex-1">
				{tuning.error
					? `No se puede: ${tuning.error}`
					: t?.status === 'testing'
						? `Probando «${t.summary}» en su computadora…`
						: t?.status === 'waiting'
							? `«${t.summary}» pasó la prueba: se aplica cuando termine su turno.`
							: `«${t?.summary}» no se aplicó, sigue como estaba: ${t?.error}`}
			</span>
			{!tuning.busy && (
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Cerrar"
					onClick={() => {
						tuning.clearError();
						setDismissed(t?.id ?? null);
					}}
				>
					<X aria-hidden="true" />
				</Button>
			)}
		</div>
	);
	// Sections of the modal, as its other tabs: plain, divided by a rule (.app-settings .panel + .panel).
	return (
		<>
			<Character agent={current} settings={settings} mine={mine} onChanged={onChanged} notice={notice} />
			<SkillTree harness={h} mine={mine} busy={tuning.busy} onTune={tune} />
			<PromptSections agent={current} effectivePrompt={data.effectivePrompt} mine={mine} onChanged={onChanged} />
		</>
	);
}

// ---------- the character ----------

function Character({
	agent,
	settings,
	mine,
	onChanged,
	notice,
}: {
	agent: Agent;
	settings: PublicSettings;
	mine: boolean;
	onChanged: () => void;
	/** A change in test, or why it did not apply. */
	notice?: ReactNode;
}) {
	const [dials, setDials] = useState<Personality>((agent.personality ?? {}) as Personality);
	const [error, setError] = useState('');
	useEffect(() => setDials((agent.personality ?? {}) as Personality), [agent.personality]);
	const setDial = async (key: string, value: number) => {
		const next = { ...dials, [key]: value };
		setDials(next);
		setError('');
		try {
			await api(`/agents/${agent.id}/personality`, { method: 'PUT', body: { personality: next } });
			onChanged();
		} catch (e) {
			setError((e as Error).message);
		}
	};
	const model = settings.models.find((m) => m.id === agent.model)?.label ?? agent.model;
	return (
		<section className="panel brain-card" aria-label="Personaje">
			{notice}
			<div className="brain-id">
				<AgentFace agent={agent} size={56} still />
				<div className="min-w-0">
					<p className="truncate text-base font-semibold">{agent.name}</p>
					<Rank agentId={agent.id} />
					<p className="brain-model">
						<Brain aria-hidden="true" />
						{model}
					</p>
				</div>
			</div>
			<AgentStyle agent={agent} mine={mine} onChanged={onChanged} />
			<h3 className="brain-heading">Personalidad</h3>
			<div className="grid gap-2">
				{DIALS.map((d) => {
					const v = dials[d.key] ?? 3;
					return (
						<div key={d.key} className="brain-dial">
							<span className="brain-dial-name">{d.name}</span>
							<span className="brain-dial-end">{d.low}</span>
							<span
								className="brain-slider"
								title={v === 3 ? 'Como dice la plataforma' : (d.lines as Record<number, string>)[v]}
							>
								<Slider
									min={1}
									max={5}
									step={1}
									value={[v]}
									disabled={!mine}
									aria-label={d.name}
									onValueChange={([n]) => setDials((x) => ({ ...x, [d.key]: n }))}
									onValueCommit={([n]) => void setDial(d.key, n)}
								/>
								<span className="brain-ticks" aria-hidden="true">
									{[1, 2, 3, 4, 5].map((n) => (
										<span key={n} className={cn(n === v && 'is-on')} />
									))}
								</span>
							</span>
							<span className="brain-dial-end">{d.high}</span>
						</div>
					);
				})}
			</div>
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
		</section>
	);
}

type RankView = { overall: number; trabajos: number; criteria: { key: string; score: number }[] } | null;

/** Its rank: five stars from the average of its latest evaluated trabajos; the rubric behind it, on click. */
function Rank({ agentId }: { agentId: number }) {
	const [rank, setRank] = useState<RankView | undefined>(undefined);
	useEffect(() => {
		let gone = false;
		api<{ rank: RankView }>(`/agents/${agentId}/rank`)
			.then((r) => !gone && setRank(r.rank))
			.catch(() => !gone && setRank(null));
		return () => void (gone = true);
	}, [agentId]);
	if (rank === undefined) return <p className="brain-rank text-muted-foreground">…</p>;
	// 0 to 5, by halves.
	const stars = rank ? Math.round(rank.overall / 10) / 2 : 0;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="brain-rank"
					aria-label={rank ? `Rango: ${stars} de 5 estrellas` : 'Sin trabajos evaluados'}
				>
					{[1, 2, 3, 4, 5].map((n) => (
						<span key={n} className="brain-rank-star" aria-hidden="true">
							<Star />
							<span className="brain-rank-fill" style={{ width: `${Math.max(0, Math.min(1, stars - n + 1)) * 100}%` }}>
								<Star />
							</span>
						</span>
					))}
					<span className="brain-rank-text">
						{rank
							? `${rank.overall} · ${rank.trabajos} ${rank.trabajos === 1 ? 'trabajo' : 'trabajos'}`
							: 'sin evaluar'}
					</span>
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-80 text-xs" align="start">
				<p className="text-sm font-medium">Cómo lo evalúan</p>
				<p className="mt-1 text-muted-foreground">
					{rank
						? `Promedio de sus últimos ${rank.trabajos} trabajos, evaluados por otro agente con esta rúbrica.`
						: 'Todavía no tiene trabajos evaluados: otro agente evalúa cada trabajo que termina, con esta rúbrica.'}
				</p>
				<ul className="mt-2 grid gap-1">
					{RUBRIC.map((r) => {
						const c = rank?.criteria.find((x) => x.key === r.key);
						return (
							<li key={r.key} className="flex items-center gap-2" title={r.description}>
								<span className="min-w-0 flex-1 truncate">{r.name}</span>
								<span className="text-muted-foreground tabular-nums">{c ? `${c.score} / 4` : '—'}</span>
							</li>
						);
					})}
				</ul>
			</PopoverContent>
		</Popover>
	);
}

// ---------- the skill tree ----------

type Node = {
	key: string;
	name: string;
	description: string | null;
	state: 'on' | 'off' | 'locked';
	/** Clicking it: what the harness becomes, and in its owner's words. */
	toggle?: () => [Harness, string];
	/** Read more: a skill's instructions, an encargo's whole template. */
	sheet?: {
		label: string;
		body: ReactNode | ((close: () => void) => ReactNode);
		/** It already says its description (an encargo's objective). */
		whole?: boolean;
	};
};

function SkillTree({
	harness: h,
	mine,
	busy,
	onTune,
}: {
	harness: Harness;
	mine: boolean;
	busy: boolean;
	onTune: (h: Harness, summary: string) => void;
}) {
	const tool = (id: ToolId): Node => {
		const t = toolOf(id)!;
		const on = h.tools.includes(id);
		return {
			key: `tool:${id}`,
			name: t.name,
			description: t.description,
			state: REQUIRED.includes(id) ? 'locked' : on ? 'on' : 'off',
			toggle: REQUIRED.includes(id)
				? undefined
				: () => [
						{ ...h, tools: on ? h.tools.filter((x) => x !== id) : [...h.tools, id] },
						`${on ? 'Quitó' : 'Agregó'} ${t.name}`,
					],
		};
	};
	const without = <K extends keyof Harness>(key: K, keep: (x: never) => boolean, what: string): [Harness, string] => [
		{ ...h, [key]: ((h[key] as unknown[] | undefined) ?? []).filter(keep as (x: unknown) => boolean) },
		what,
	];
	const branches: { name: string; icon: LucideIcon; nodes: Node[] }[] = [
		{ name: 'Navegar', icon: Globe, nodes: [tool('browser'), tool('login')] },
		{
			name: 'Programar',
			icon: SquareTerminal,
			nodes: (['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls'] as ToolId[]).map(tool),
		},
		{ name: 'Comunicar', icon: MessageCircle, nodes: [tool('request_help'), tool('whatsapp_notify')] },
		{
			name: 'Delegar',
			icon: Network,
			nodes: [
				tool('subagents'),
				tool('delegations'),
				...(h.delegations ?? []).map((d) => ({
					key: `delegation:${d.name}`,
					name: `Encargo: ${d.name}`,
					description: d.objective,
					sheet: {
						label: 'Ver plantilla',
						whole: true,
						body: (close: () => void) => (
							<TemplateSheet
								t={d}
								mine={mine}
								busy={busy}
								onClose={close}
								onSave={(next) =>
									onTune(
										{ ...h, delegations: (h.delegations ?? []).map((x) => (x.name === d.name ? next : x)) },
										`Editó el encargo ${d.name}`,
									)
								}
							/>
						),
					},
					state: 'on' as const,
					toggle: () =>
						without('delegations', (x: { name: string }) => x.name !== d.name, `Quitó el encargo ${d.name}`),
				})),
				tool('flows'),
				...(h.flows ?? []).map((f) => ({
					key: `flow:${f.name}`,
					name: `Receta: ${f.name}`,
					description: f.description,
					sheet: { label: 'Ver receta', body: <RecipeDetail r={f} /> },
					state: 'on' as const,
					toggle: () => without('flows', (x: { name: string }) => x.name !== f.name, `Quitó la receta ${f.name}`),
				})),
			],
		},
		{
			name: 'Skills',
			icon: BookOpen,
			nodes: h.skills.map((s) => ({
				key: `skill:${s.name}`,
				name: s.name,
				description: s.description,
				sheet: { label: 'Instrucciones', body: <pre className="brain-pre">{s.instructions}</pre> },
				state: 'on' as const,
				toggle: () => without('skills', (x: { name: string }) => x.name !== s.name, `Quitó la skill ${s.name}`),
			})),
		},
		{
			name: 'Conectar',
			icon: Plug,
			nodes: [
				...(h.mcp ?? []).map((m) => ({
					key: `mcp:${m.name}`,
					name: `MCP: ${m.name}`,
					description: m.transport === 'http' ? m.url : `${m.command} ${m.args.join(' ')}`,
					state: 'on' as const,
					toggle: () => without('mcp', (x: { name: string }) => x.name !== m.name, `Quitó el MCP ${m.name}`),
				})),
				...(h.installs ?? []).map((i) => {
					const label = i.kind === 'binary' ? (i.name ?? i.spec) : i.spec;
					return {
						key: `cli:${label}`,
						name: `CLI: ${label}`,
						description: `${i.kind} ${i.spec}`,
						state: 'on' as const,
						toggle: () => without('installs', (x: { spec: string }) => x.spec !== i.spec, `Quitó la CLI ${label}`),
					};
				}),
				...PLUGINS.map((p) => {
					const on = h.plugins.some((x) => x.id === p.id);
					return {
						key: `plugin:${p.id}`,
						name: p.name,
						description: p.description,
						state: on ? ('on' as const) : ('off' as const),
						toggle: (): [Harness, string] => [
							{
								...h,
								plugins: on ? h.plugins.filter((x) => x.id !== p.id) : [...h.plugins, { id: p.id, version: p.version }],
							},
							`${on ? 'Quitó' : 'Agregó'} ${p.name}`,
						],
					};
				}),
			],
		},
	];
	return (
		<section className="panel brain-tree" aria-label="Árbol de habilidades">
			<h3 className="brain-heading">Habilidades</h3>
			{!!(h.flows?.length || h.delegations?.length) && (
				<div className="brain-workflows">
					{(h.flows ?? []).map((f) => (
						<WorkflowTile key={f.name} recipe={f} />
					))}
					{(h.delegations ?? []).map((d) => (
						<EncargoTile
							key={d.name}
							t={d}
							mine={mine}
							busy={busy}
							onSave={(next) =>
								onTune(
									{ ...h, delegations: (h.delegations ?? []).map((x) => (x.name === d.name ? next : x)) },
									`Editó el encargo ${d.name}`,
								)
							}
						/>
					))}
				</div>
			)}
			<div className="brain-branches">
				{branches.map((b) => (
					<div key={b.name} className="brain-branch">
						<p className="brain-branch-name">
							<b.icon aria-hidden="true" />
							{b.name}
						</p>
						<ul className="brain-nodes">
							{b.nodes.length ? (
								b.nodes.map((n) => (
									<li key={n.key}>
										<SkillNode node={n} mine={mine} busy={busy} onTune={onTune} />
									</li>
								))
							) : (
								<li className="brain-node-empty">Ninguna todavía · en Automejora</li>
							)}
						</ul>
					</div>
				))}
			</div>
			<p className="brain-legend">
				<span className="brain-dot is-on" /> activa <span className="brain-dot" /> disponible{' '}
				<Lock aria-hidden="true" /> fija · cada cambio se prueba antes de aplicarse
			</p>
		</section>
	);
}

function SkillNode({
	node: n,
	mine,
	busy,
	onTune,
}: {
	node: Node;
	mine: boolean;
	busy: boolean;
	onTune: (h: Harness, summary: string) => void;
}) {
	const [detail, setDetail] = useState(false);
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button type="button" className={cn('brain-node', `is-${n.state}`)}>
					<span className={cn('brain-dot', n.state !== 'off' && 'is-on')} aria-hidden="true" />
					<span className="min-w-0 truncate">{n.name}</span>
					{n.state === 'locked' && <Lock className="brain-node-lock" aria-label="Fija" />}
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-72 text-sm">
				<p className="font-medium">{n.name}</p>
				<p className="mt-1 line-clamp-6 text-xs text-muted-foreground">{n.description}</p>
				{n.state === 'locked' && (
					<p className="mt-2 text-xs text-muted-foreground">
						La plataforma la necesita para que el agente te pida ayuda.
					</p>
				)}
				<div className="mt-3 flex flex-wrap gap-2">
					{n.sheet && (
						<Button variant="outline" size="sm" onClick={() => setDetail(true)}>
							<ScrollText aria-hidden="true" />
							{n.sheet.label}
						</Button>
					)}
					{mine && n.toggle && (
						<Button
							size="sm"
							variant={n.state === 'on' ? 'danger-outline' : 'default'}
							disabled={busy}
							onClick={() => {
								const [h, summary] = n.toggle!();
								onTune(h, summary);
							}}
						>
							{n.state === 'on' ? 'Quitar' : 'Activar'}
						</Button>
					)}
				</div>
				{busy && <p className="mt-2 text-xs text-muted-foreground">Hay un cambio en prueba: espera a que termine.</p>}
			</PopoverContent>
			{n.sheet && (
				<Dialog open={detail} onOpenChange={setDetail}>
					<DialogContent className="sm:max-w-2xl">
						<DialogHeader>
							<DialogTitle>{n.name}</DialogTitle>
							{n.sheet.whole ? (
								<DialogDescription className="sr-only">{n.description}</DialogDescription>
							) : (
								<DialogDescription>{n.description}</DialogDescription>
							)}
						</DialogHeader>
						{typeof n.sheet.body === 'function' ? n.sheet.body(() => setDetail(false)) : n.sheet.body}
					</DialogContent>
				</Dialog>
			)}
		</Popover>
	);
}

/**
 * An encargo template: read, or edited as a form. Saving it goes the tree's way: tested in the background,
 * applied only if it passes. Its name stays (its recipes name it).
 */
function TemplateSheet({
	t,
	mine,
	busy,
	onSave,
	onClose,
}: {
	t: DelegationTemplate;
	mine: boolean;
	busy: boolean;
	onSave: (next: DelegationTemplate) => void;
	onClose: () => void;
}) {
	const [draft, setDraft] = useState<DelegationTemplate | null>(null);
	const lines = (text: string) =>
		text
			.split('\n')
			.map((x) => x.trim())
			.filter(Boolean);
	if (!draft)
		return (
			<>
				<TemplateDetail t={t} />
				{mine && (
					<DialogFooter>
						<Button variant="outline" disabled={busy} onClick={() => setDraft(structuredClone(t))}>
							<Pencil aria-hidden="true" />
							Editar
						</Button>
					</DialogFooter>
				)}
			</>
		);
	const d = draft;
	const set = (patch: Partial<DelegationTemplate>) => setDraft({ ...d, ...patch });
	const setField = (i: number, patch: Partial<DelegationField>) =>
		set({ collect: { ...d.collect, fields: d.collect.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) } });
	return (
		<>
			<div className="brain-form">
				<label className="brain-form-row">
					<span>Objetivo</span>
					<Textarea rows={3} value={d.objective} onChange={(e) => set({ objective: e.target.value })} />
				</label>
				<label className="brain-form-row">
					<span>Presentación</span>
					<Textarea rows={2} value={d.intro} onChange={(e) => set({ intro: e.target.value })} />
				</label>
				<label className="brain-form-row">
					<span>Reglas · una por línea</span>
					<Textarea rows={5} value={d.rules.join('\n')} onChange={(e) => set({ rules: e.target.value.split('\n') })} />
				</label>
				<div className="brain-form-row">
					<span className="flex items-center justify-between gap-2">
						Datos que obtiene
						<label className="flex flex-row items-center gap-2 text-xs font-normal text-muted-foreground">
							Varios renglones
							<Switch
								checked={d.collect.list}
								onCheckedChange={(list) => set({ collect: { ...d.collect, list } })}
								aria-label="Varios renglones"
							/>
						</label>
					</span>
					<div className="grid gap-2">
						{d.collect.fields.map((f, i) => (
							<div key={i} className="brain-field">
								<Input
									aria-label="Nombre del dato"
									value={f.name}
									onChange={(e) => setField(i, { name: e.target.value })}
									placeholder="nombre"
								/>
								<OptionSelect
									label="Tipo"
									value={f.type}
									onValueChange={(type) => setField(i, { type: type as DelegationField['type'] })}
									options={[
										{ id: 'text', label: 'Texto' },
										{ id: 'number', label: 'Número' },
										{ id: 'boolean', label: 'Sí/no' },
									]}
								/>
								<Input
									aria-label="Qué es"
									value={f.description}
									onChange={(e) => setField(i, { description: e.target.value })}
									placeholder="Qué es"
								/>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={`Quitar ${f.name}`}
									disabled={d.collect.fields.length <= 1}
									onClick={() => set({ collect: { ...d.collect, fields: d.collect.fields.filter((_, j) => j !== i) } })}
								>
									<X aria-hidden="true" />
								</Button>
							</div>
						))}
						<div>
							<Button
								variant="outline"
								size="sm"
								disabled={d.collect.fields.length >= 12}
								onClick={() =>
									set({
										collect: {
											...d.collect,
											fields: [...d.collect.fields, { name: '', type: 'text', description: '' }],
										},
									})
								}
							>
								Agregar dato
							</Button>
						</div>
					</div>
				</div>
				<label className="brain-form-row">
					<span>Escala al agente si · uno por línea</span>
					<Textarea
						rows={4}
						value={d.escalate.join('\n')}
						onChange={(e) => set({ escalate: e.target.value.split('\n') })}
					/>
				</label>
				<div className="brain-form-inline">
					<div className="grid gap-1.5 font-medium">
						<span className="flex items-center justify-between gap-2">
							Mensajes máximo
							<label className="flex flex-row items-center gap-1.5 text-xs font-normal whitespace-nowrap text-muted-foreground">
								Sin límite
								<Switch
									checked={d.maxMessages === null}
									onCheckedChange={(free) => set({ maxMessages: free ? null : 16 })}
									aria-label="Sin límite de mensajes"
								/>
							</label>
						</span>
						<Input
							type="number"
							min={1}
							max={40}
							disabled={d.maxMessages === null}
							value={d.maxMessages ?? ''}
							placeholder="Sin límite"
							aria-label="Mensajes máximo"
							onChange={(e) => set({ maxMessages: Number(e.target.value) })}
						/>
					</div>
					<label>
						<span>Horas máximo</span>
						<Input
							type="number"
							min={1}
							max={168}
							value={d.maxHours}
							onChange={(e) => set({ maxHours: Number(e.target.value) })}
						/>
					</label>
					<label className="flex flex-row items-center gap-2 sm:col-span-2">
						<Switch checked={d.files} onCheckedChange={(files) => set({ files })} aria-label="Manda archivos" />
						<span>Puede mandar archivos</span>
					</label>
				</div>
			</div>
			<DialogFooter>
				<Button variant="ghost" onClick={() => setDraft(null)}>
					Cancelar
				</Button>
				<Button
					disabled={busy}
					onClick={() => {
						onSave({ ...d, rules: lines(d.rules.join('\n')), escalate: lines(d.escalate.join('\n')) });
						onClose();
					}}
				>
					Guardar y probar
				</Button>
			</DialogFooter>
		</>
	);
}

// ---------- the prompt, by sections ----------

type Section = { title: string; text: string };
/** Its contract by its «## » headings; what comes before the first one is its introduction. */
function split(role: string): Section[] {
	return role
		.split(/^(?=## )/m)
		.filter((text) => text.trim())
		.map((text) => ({
			title: text.startsWith('## ') ? text.split('\n')[0].replace(/^##\s*/, '') : 'Introducción',
			text: text.replace(/\s+$/, ''),
		}));
}
const join = (sections: Section[]) => sections.map((s) => s.text).join('\n\n') + '\n';
const tokens = (text: string) => Math.max(1, Math.round(text.length / 4));

/** Its workflow (a recipe of its harness): a glowing tile; its ideal steps on the canvas, on click. */
/** An encargo template: a tile in WhatsApp's green (it talks there); its template, readable and editable, on click. */
function EncargoTile({
	t,
	mine,
	busy,
	onSave,
}: {
	t: DelegationTemplate;
	mine: boolean;
	busy: boolean;
	onSave: (next: DelegationTemplate) => void;
}) {
	const [open, setOpen] = useState(false);
	const fields = t.collect.fields.length;
	return (
		<>
			<button type="button" className="brain-workflow is-encargo" onClick={() => setOpen(true)}>
				<span className="brain-workflow-icon">
					<Handshake aria-hidden="true" />
				</span>
				<span className="min-w-0 flex-1 text-left">
					<span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
						Encargo <code className="brain-alias truncate">{t.name}</code>
					</span>
					<span className="block truncate text-2xs text-muted-foreground">
						{fields} {fields === 1 ? 'dato' : 'datos'} ·{' '}
						{t.maxMessages === null ? 'sin límite de mensajes' : `hasta ${t.maxMessages} mensajes`} ·{' '}
						{t.description || t.objective}
					</span>
				</span>
				<ChevronRight className="brain-workflow-arrow" aria-hidden="true" />
			</button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							Encargo <code className="brain-alias">{t.name}</code>
						</DialogTitle>
						<DialogDescription className="sr-only">{t.objective}</DialogDescription>
					</DialogHeader>
					{open && <TemplateSheet t={t} mine={mine} busy={busy} onSave={onSave} onClose={() => setOpen(false)} />}
				</DialogContent>
			</Dialog>
		</>
	);
}

function WorkflowTile({ recipe }: { recipe: FlowRecipe }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" className="brain-workflow" onClick={() => setOpen(true)}>
				<span className="brain-workflow-icon">
					<Workflow aria-hidden="true" />
				</span>
				<span className="min-w-0 flex-1 text-left">
					<span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
						Workflow <code className="brain-alias truncate">{recipe.name}</code>
					</span>
					<span className="block truncate text-2xs text-muted-foreground">
						Receta · {recipe.steps.length} {recipe.steps.length === 1 ? 'paso' : 'pasos'} · {recipe.description}
					</span>
				</span>
				<ChevronRight className="brain-workflow-arrow" aria-hidden="true" />
			</button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-5xl">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							Workflow <code className="brain-alias">{recipe.name}</code>
						</DialogTitle>
						<DialogDescription>{recipe.objective}</DialogDescription>
					</DialogHeader>
					{open && (
						<Suspense fallback={<p className="muted small">Cargando el lienzo…</p>}>
							<RecipeCanvas recipe={recipe} />
						</Suspense>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}

function PromptSections({
	agent,
	effectivePrompt,
	mine,
	onChanged,
}: {
	agent: Agent;
	effectivePrompt: string;
	mine: boolean;
	onChanged: () => void;
}) {
	const saved = useMemo(() => split(agent.role), [agent.role]);
	// Moved here first (and animated), saved after; a failed save puts it back.
	const [order, setOrder] = useState<Section[] | null>(null);
	useEffect(() => setOrder(null), [agent.role]);
	const sections = order ?? saved;
	const [editing, setEditing] = useState<{ index: number; text: string; tab: 'edit' | 'view' } | null>(null);
	const [reading, setReading] = useState<{ title: string; text: string } | null>(null);
	const [busy, setBusy] = useState(false),
		[error, setError] = useState('');
	const save = async (next: Section[]) => {
		setBusy(true);
		setError('');
		try {
			await api(`/agents/${agent.id}`, {
				method: 'PATCH',
				body: { name: agent.name, model: agent.model, role: join(next), revision: agent.config_revision },
			});
			onChanged();
			return true;
		} catch (e) {
			setError((e as Error).message);
			return false;
		} finally {
			setBusy(false);
		}
	};
	// Its introduction (the «# Name» before the first «##») stays first; the rest move freely.
	const fixed = (i: number) => sections[i]?.title === 'Introducción';
	const moveTo = (from: number, to: number) => {
		if (from === to || fixed(from) || fixed(to) || to < 0 || to >= sections.length) return;
		const next = [...sections];
		const [moved] = next.splice(from, 1);
		next.splice(to, 0, moved);
		setOrder(next);
		void save(next).then((ok) => !ok && setOrder(null));
	};
	const [drag, setDrag] = useState<number | null>(null),
		[over, setOver] = useState<number | null>(null);
	// The sort, animated: each tile slides from where it was to its new place (FLIP), by its title.
	const tiles = useRef(new Map<string, HTMLElement>());
	const places = useRef(new Map<string, { x: number; y: number }>());
	useLayoutEffect(() => {
		const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const now = new Map<string, { x: number; y: number }>();
		tiles.current.forEach((el, key) => {
			const at = { x: el.offsetLeft, y: el.offsetTop };
			now.set(key, at);
			const was = places.current.get(key);
			if (!still && was && (was.x !== at.x || was.y !== at.y))
				el.animate(
					[{ transform: `translate(${was.x - at.x}px, ${was.y - at.y}px)` }, { transform: 'translate(0, 0)' }],
					{ duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
				);
		});
		places.current = now;
	});
	const keep = (key: string) => (el: HTMLElement | null) => {
		if (el) tiles.current.set(key, el);
		else tiles.current.delete(key);
	};
	const traits = personalitySection((agent.personality ?? {}) as Personality);
	return (
		<section className="panel brain-prompt" aria-label="Prompt por secciones">
			<h3 className="brain-heading">Prompt · en el orden en que lo lee</h3>
			{mine && <p className="brain-hint">Arrastra las secciones de su contrato para cambiar su orden.</p>}
			<div className="brain-sections">
				<Tile
					n={1}
					icon={<Lock aria-hidden="true" />}
					title="Plataforma"
					sub={`Reglas, autonomía, cómo escribe, aprendizajes · ${tokens(effectivePrompt).toLocaleString('es-MX')} tokens en total`}
					onOpen={() => setReading({ title: 'Prompt completo (con el de la plataforma)', text: effectivePrompt })}
				/>
				{sections.map((s, i) => {
					const movable = mine && !busy && !fixed(i);
					return (
						<Tile
							key={s.title}
							tileRef={keep(s.title)}
							n={i + 2}
							icon={<Pencil aria-hidden="true" />}
							title={s.title}
							sub={`${tokens(s.text).toLocaleString('es-MX')} tokens`}
							onOpen={() => (mine ? setEditing({ index: i, text: s.text, tab: 'edit' }) : setReading(s))}
							drag={
								movable
									? {
											dragging: drag === i,
											over: over === i && drag !== null && drag !== i,
											onStart: () => setDrag(i),
											onOver: () => !fixed(i) && setOver(i),
											onDrop: () => {
												if (drag !== null) moveTo(drag, i);
												setDrag(null);
												setOver(null);
											},
											onEnd: () => {
												setDrag(null);
												setOver(null);
											},
											onKey: (by) => moveTo(i, i + by),
										}
									: undefined
							}
						/>
					);
				})}
				<Tile
					n={sections.length + 2}
					icon={<Sparkles aria-hidden="true" />}
					title="Personalidad"
					sub={traits ? 'De los controles del personaje' : 'Como dice la plataforma'}
					onOpen={() =>
						setReading({ title: 'Personalidad', text: traits || 'Todos los controles al centro: sin líneas extra.' })
					}
				/>
			</div>
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
			<Dialog open={!!editing} onOpenChange={(o) => !o && !busy && setEditing(null)}>
				<DialogContent onEscapeKeyDown={keepOpenForVim} className="flex h-[min(88vh,56rem)] flex-col sm:max-w-6xl">
					<DialogHeader>
						<DialogTitle>{editing ? sections[editing.index]?.title : ''}</DialogTitle>
						<DialogDescription>
							Una sección de su contrato. Empieza con «## Título»; guardar crea una revisión nueva.
						</DialogDescription>
					</DialogHeader>
					<Tabs
						value={editing?.tab ?? 'edit'}
						onValueChange={(tab) => setEditing((x) => (x ? { ...x, tab: tab as 'edit' | 'view' } : x))}
						className="brain-editor-tabs"
					>
						<TabsList>
							<TabsTrigger value="edit">Editar</TabsTrigger>
							<TabsTrigger value="view">Vista</TabsTrigger>
						</TabsList>
						<TabsContent value="edit" className="brain-editor-body">
							<Suspense fallback={<p className="muted small">Cargando editor…</p>}>
								<RoleEditor
									fill
									label="Texto de la sección"
									value={editing?.text ?? ''}
									onChange={(text) => setEditing((x) => (x ? { ...x, text } : x))}
									disabled={busy}
								/>
							</Suspense>
						</TabsContent>
						<TabsContent value="view" className="brain-editor-body brain-editor-view">
							<ContractMarkdown text={editing?.text ?? ''} />
						</TabsContent>
					</Tabs>
					{error && (
						<p role="alert" className="error">
							{error}
						</p>
					)}
					<DialogFooter>
						<Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
							Cancelar
						</Button>
						<Button
							disabled={busy || !editing?.text.trim()}
							onClick={async () => {
								if (!editing) return;
								const next = sections.map((s, i) =>
									i === editing.index ? { ...s, text: editing.text.replace(/\s+$/, '') } : s,
								);
								if (await save(next)) setEditing(null);
							}}
						>
							Guardar
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<Dialog open={!!reading} onOpenChange={(o) => !o && setReading(null)}>
				<DialogContent className="sm:max-w-4xl">
					<DialogHeader>
						<DialogTitle>{reading?.title}</DialogTitle>
						<DialogDescription>Sólo lectura.</DialogDescription>
					</DialogHeader>
					<pre className="brain-pre">{reading?.text}</pre>
				</DialogContent>
			</Dialog>
		</section>
	);
}

type Drag = {
	dragging: boolean;
	over: boolean;
	onStart: () => void;
	onOver: () => void;
	onDrop: () => void;
	onEnd: () => void;
	/** Arrow keys on its handle: up or down one place. */
	onKey: (by: -1 | 1) => void;
};

function Tile({
	n,
	icon,
	title,
	sub,
	onOpen,
	drag,
	tileRef,
}: {
	tileRef?: (el: HTMLElement | null) => void;
	n: number;
	icon: ReactNode;
	title: string;
	sub: string;
	onOpen: () => void;
	drag?: Drag;
}) {
	return (
		<div
			ref={tileRef}
			className={cn('brain-section', drag?.dragging && 'is-dragging', drag?.over && 'is-over')}
			draggable={!!drag}
			onDragStart={(e) => {
				if (!drag) return;
				e.dataTransfer.effectAllowed = 'move';
				e.dataTransfer.setData('text/plain', title);
				drag.onStart();
			}}
			onDragOver={(e) => {
				if (!drag) return;
				e.preventDefault();
				drag.onOver();
			}}
			onDrop={(e) => {
				if (!drag) return;
				e.preventDefault();
				drag.onDrop();
			}}
			onDragEnd={() => drag?.onEnd()}
		>
			<span className="brain-section-n">{n}</span>
			<button type="button" className="brain-section-open" onClick={onOpen}>
				<span className="brain-section-icon">{icon}</span>
				<span className="min-w-0">
					<span className="block truncate text-sm font-medium">{title}</span>
					<span className="block truncate text-2xs text-muted-foreground">{sub}</span>
				</span>
			</button>
			{drag && (
				<button
					type="button"
					className="brain-section-grip"
					aria-label={`Mover ${title} (flechas arriba y abajo)`}
					title="Arrastra para mover · flechas ↑↓"
					onKeyDown={(e) => {
						if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
							e.preventDefault();
							drag.onKey(-1);
						} else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
							e.preventDefault();
							drag.onKey(1);
						}
					}}
				>
					<GripVertical aria-hidden="true" />
				</button>
			)}
		</div>
	);
}
