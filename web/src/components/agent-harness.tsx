// Configuración → Avanzado → Harness (Bubble agents #25): the agent's approved definition by kind:
// its system prompt (the contract, editable by its owner, and the complete prompt), skills, MCP
// servers, command-line tools, guidelines and plugins, and its revisions. A prompt is a document
// tile; opening one slides the panel left to its editor, and «Volver» slides back.
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, FileText, Loader2, Plug, Puzzle, SquareTerminal } from 'lucide-react';
import { api, isLive, type Agent } from '@/api';
import { PLUGINS } from '../../../sandbox/harness';
import { useAgentConfiguration } from '@/AgentConfiguration';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Tile } from '@/components/harness-tile';
import { cn } from '@/lib/utils';

const RoleEditor = lazy(() => import('@/components/role-editor').then((module) => ({ default: module.RoleEditor })));

type Doc = { key: string; title: string; hint: string; text: string; editable?: boolean };

export function AgentHarness({
	agent,
	mine,
	onChanged,
	onEditing,
}: {
	agent: Agent;
	mine: boolean;
	onChanged: () => void;
	/** A document opened or closed: the settings hide what follows the harness while it is open. */
	onEditing?: (open: boolean) => void;
}) {
	const { data, error, retry } = useAgentConfiguration(agent);
	const [open, setOpen] = useState<Doc | null>(null);
	const [settled, setSettled] = useState(true);
	const [draft, setDraft] = useState('');
	const [saveError, setSaveError] = useState('');
	const root = useRef<HTMLDivElement>(null);
	const live = isLive(agent.task);
	// An open document takes the whole panel, edge to edge: its scroll viewport, over its padding.
	const [box, setBox] = useState<{ height: number; margin: string }>();
	const docOpen = !!open;
	useEffect(() => {
		const viewport = root.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
		if (!docOpen || !viewport) return;
		const measure = () => {
			const content = viewport.querySelector<HTMLElement>('.agent-settings-content') ?? viewport;
			const style = getComputedStyle(content);
			const pad = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
			setBox({ height: viewport.clientHeight, margin: pad.map((p) => `-${p}`).join(' ') });
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(viewport);
		return () => observer.disconnect();
	}, [docOpen]);

	// Autosave: the contract saves itself once typing stops for a moment (each save is a revision of
	// the definition, so not on every keystroke). One save at a time; the next one carries the
	// revision the last one returned.
	const [saveState, setSaveState] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved');
	const saved = useRef(''),
		latest = useRef(''),
		saving = useRef(false),
		revision = useRef<number | undefined>(undefined),
		identity = useRef({ name: '', model: '' });
	latest.current = draft;
	const persist = async (): Promise<boolean> => {
		if (saving.current) return false;
		const text = latest.current;
		if (text === saved.current) return true;
		saving.current = true;
		setSaveState('saving');
		setSaveError('');
		try {
			const r = await api<{ agent: Agent }>(`/agents/${agent.id}`, {
				method: 'PATCH',
				body: { ...identity.current, role: text, revision: revision.current },
			});
			revision.current = r.agent.config_revision;
			saved.current = text;
			onChanged();
			return true;
		} catch (e) {
			setSaveError((e as Error).message);
			setSaveState('error');
			return false;
		} finally {
			saving.current = false;
			if (saved.current === latest.current) setSaveState((s) => (s === 'error' ? s : 'saved'));
			else setSaveState((s) => (s === 'error' ? s : 'pending'));
		}
	};
	useEffect(() => {
		if (!open?.editable || draft === saved.current || saveState === 'saving') return;
		setSaveState((s) => (s === 'error' ? s : 'pending'));
		if (live) return; // waits for the active run, like manual edits
		const timer = setTimeout(() => void persist(), 1500);
		return () => clearTimeout(timer);
	}, [draft, open, live, saveState]);
	if (error)
		return (
			<p role="alert" className="error">
				{error}{' '}
				<Button variant="outline" size="sm" onClick={retry}>
					Reintentar
				</Button>
			</p>
		);
	if (!data)
		return (
			<p role="status" className="muted">
				Cargando harness…
			</p>
		);
	const current = { ...agent, ...data.agent };
	const h = data.harness;
	const show = (doc: Doc | null) => {
		setSettled(false);
		setOpen(doc);
		onEditing?.(!!doc);
		setSaveError('');
		if (doc) {
			setDraft(doc.text);
			saved.current = latest.current = doc.text;
			revision.current = current.config_revision;
			identity.current = { name: current.name, model: current.model };
			setSaveState('saved');
		}
		// The panel scrolls: bring the harness (where the slide happens) to its top.
		root.current?.scrollIntoView({ block: 'start' });
	};
	/** «Volver»: what is left unsaved is saved first (or, during a run, discarded only if you say so). */
	const back = async () => {
		if (open?.editable && latest.current !== saved.current) {
			if (live) {
				if (!confirm('El agente está trabajando y el contrato no se ha guardado. ¿Descartar los cambios?')) return;
			} else if (!(await persist())) return;
		}
		retry();
		show(null);
	};
	const status = !open?.editable
		? 'Sólo lectura'
		: saveState === 'saving'
			? 'Guardando…'
			: saveState === 'error'
				? 'No se guardó'
				: saveState === 'pending'
					? live
						? 'Se guarda al terminar la corrida'
						: 'Sin guardar'
					: 'Guardado';
	const prompts: Doc[] = [
		{
			key: 'contract',
			title: 'Contrato',
			hint: mine ? 'El rol del agente; lo puedes editar.' : 'El rol del agente.',
			text: current.role || '',
			editable: mine,
		},
		{
			key: 'effective',
			title: 'Prompt completo',
			hint: 'Lo que recibe el modelo: contrato, reglas de la plataforma y harness. Sólo lectura.',
			text: data.effectivePrompt,
		},
		...(h?.restrictions.guidelines.length
			? [
					{
						key: 'guidelines',
						title: 'Pautas de trabajo',
						hint: 'Instrucciones para el modelo, no permisos ni garantías técnicas. Sólo lectura.',
						text: h.restrictions.guidelines.map((g) => `- ${g}`).join('\n'),
					},
				]
			: []),
	];
	const skills: Doc[] = (h?.skills ?? []).map((s) => ({
		key: `skill:${s.name}`,
		title: s.name,
		hint: `${s.description} Se cambia en Automejora.`,
		text: s.instructions,
	}));
	return (
		<div
			ref={root}
			className="slide-stack"
			style={open && box ? { margin: box.margin } : undefined}
			data-detail={!!open}
			onTransitionEnd={(e) => {
				// Only the track's own slide, not a button's hover fading inside it.
				if (e.target === e.currentTarget.firstElementChild && e.propertyName === 'transform') setSettled(true);
			}}
		>
			<div className="slide-stack-track">
				<div
					className={cn('slide-stack-pane', open && settled && 'slide-stack-hidden')}
					inert={!!open}
					aria-hidden={!!open}
				>
					<section className="grid min-w-0 gap-5" aria-labelledby="harness-title">
						<div>
							<h2 id="harness-title">Harness</h2>
							<p className="mt-1 text-xs text-muted-foreground">
								{h
									? `Manifiesto v${h.version} · revisión ${current.config_revision}. Skills, MCP, herramientas y plugins se cambian en Automejora: se prueban y se aprueban antes de aplicarse.`
									: 'Sin harness aprobado todavía.'}
							</p>
						</div>
						<Category title="System prompt">
							<DocTiles docs={prompts} onOpen={show} />
						</Category>
						<Category title="Skills">
							{skills.length ? <DocTiles docs={skills} onOpen={show} /> : <Empty>Sin skills.</Empty>}
						</Category>
						<Category title="MCP">
							{h?.mcp?.length ? (
								<div className="harness-tiles">
									{h.mcp.map((s) => (
										<Tile
											key={s.name}
											icon={Plug}
											title={s.name}
											detail={s.transport === 'http' ? (s.url ?? '') : [s.command, ...s.args].join(' ')}
											hint={`${s.description}${s.oauth ? ' Inicia sesión con OAuth.' : ''}`}
										/>
									))}
								</div>
							) : (
								<Empty>Sin servidores MCP.</Empty>
							)}
						</Category>
						<Category title="CLI">
							{h?.installs?.length ? (
								<div className="harness-tiles">
									{h.installs.map((i) => (
										<Tile
											key={`${i.kind}:${i.spec}`}
											icon={SquareTerminal}
											title={i.kind === 'binary' ? (i.name ?? i.spec) : i.spec}
											detail={i.kind === 'npm' ? 'npm' : i.kind === 'uv' ? 'Python (uv)' : 'binario'}
											hint="Versión fija: se instala en la computadora del agente al arrancar y queda en su PATH."
										/>
									))}
								</div>
							) : (
								<Empty>Sin herramientas de línea de comandos.</Empty>
							)}
						</Category>
						{!!h?.plugins.length && (
							<Category title="Plugins">
								<div className="harness-tiles">
									{h.plugins.map((p) => (
										<Tile
											key={p.id}
											icon={Puzzle}
											title={p.id}
											detail={`v${p.version}`}
											hint={PLUGINS.find((c) => c.id === p.id)?.description ?? ''}
										/>
									))}
								</div>
							</Category>
						)}
						{h && (
							<p className="text-2xs text-muted-foreground">
								Archivos:{' '}
								{h.restrictions.workspaceFilesOnly ? 'limitados a ~/work' : 'dentro de la computadora aislada'} ·{' '}
								{h.restrictions.readOnlyFiles ? 'sólo lectura' : 'escritura según herramientas'}.
							</p>
						)}
						<Revisions agent={agent} mine={mine} current={current.config_revision} revisions={data.revisions} />
					</section>
				</div>
				<div
					className={cn('slide-stack-pane', !open && settled && 'slide-stack-hidden')}
					inert={!open}
					aria-hidden={!open}
				>
					{open && (
						<section className="flex min-w-0 flex-col" style={{ height: box?.height }} aria-label={open.title}>
							{saveError && (
								<p role="alert" className="error border-b px-3 py-2">
									{saveError}
								</p>
							)}
							<div className="min-h-0 flex-1">
								<Suspense
									fallback={
										<p role="status" className="muted p-4">
											Cargando editor…
										</p>
									}
								>
									<RoleEditor
										fill
										value={open.editable ? draft : open.text}
										onChange={setDraft}
										disabled={!open.editable}
										label={open.title}
										leading={
											<div className="flex min-w-0 items-center gap-2">
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													aria-label="Volver al harness"
													onClick={() => void back()}
												>
													<ArrowLeft aria-hidden="true" />
												</Button>
												<FileText className="size-4 shrink-0 text-primary" aria-hidden="true" />
												<div className="grid min-w-0 leading-tight">
													<h2 className="!mb-0 truncate text-sm leading-tight font-semibold">{open.title}</h2>
													<p className="truncate text-2xs leading-tight text-muted-foreground" title={open.hint}>
														{open.hint}
													</p>
												</div>
											</div>
										}
										actions={
											<span
												role="status"
												className={cn('text-2xs', saveState === 'error' ? 'text-danger' : 'text-muted-foreground')}
											>
												{saveState === 'saving' && (
													<Loader2 className="mr-1 inline size-3 animate-spin" aria-hidden="true" />
												)}
												{saveState === 'saved' && open.editable && (
													<Check className="mr-1 inline size-3" aria-hidden="true" />
												)}
												{status}
											</span>
										}
									/>
								</Suspense>
							</div>
						</section>
					)}
				</div>
			</div>
		</div>
	);
}

function Category({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="grid min-w-0 gap-2">
			<h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
			{children}
		</section>
	);
}

const Empty = ({ children }: { children: ReactNode }) => <p className="text-xs text-muted-foreground">{children}</p>;

/** Prompts as documents: an icon and a name; the hover says what it is. */
function DocTiles({ docs, onOpen }: { docs: Doc[]; onOpen: (doc: Doc) => void }) {
	return (
		<div className="harness-tiles">
			{docs.map((d) => (
				<Tooltip key={d.key}>
					<TooltipTrigger asChild>
						<button type="button" className="harness-tile" onClick={() => onOpen(d)} aria-label={`Abrir ${d.title}`}>
							<FileText className="size-5 shrink-0 text-primary" aria-hidden="true" />
							<span className="min-w-0 truncate">{d.title}</span>
						</button>
					</TooltipTrigger>
					<TooltipContent side="top" className="max-w-xs">
						{d.hint}
					</TooltipContent>
				</Tooltip>
			))}
		</div>
	);
}

/** The definition's revisions; restoring prepares a draft in Automejora (it must be tested and approved). */
export function Revisions({
	agent,
	mine,
	current,
	revisions,
}: {
	agent: Agent;
	mine: boolean;
	current: number | undefined;
	revisions?: { revision: number; name: string; model: string; created_at: number }[];
}) {
	const [restoring, setRestoring] = useState<number | null>(null);
	const [error, setError] = useState('');
	if (!revisions?.length) return null;
	const restore = async (revision: number) => {
		setRestoring(revision);
		setError('');
		try {
			const r = await api<{ design: { id: string } }>('/designs', {
				body: { agentId: agent.id, model: agent.model, revision },
			});
			location.hash = `/agent/${agent.id}/improve/${r.design.id}`;
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setRestoring(null);
		}
	};
	return (
		<Category title="Revisiones">
			<p className="text-xs text-muted-foreground">
				Restaurar prepara un borrador en Automejora: debes probarlo y aprobarlo. No deshace archivos ni efectos externos
				ni reinicia la conversación.
			</p>
			<ul className="grid gap-2 text-xs">
				{revisions.map((r) => (
					<li key={r.revision} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
						<span className="min-w-0 break-words">
							Revisión {r.revision} · {r.name} · {r.model}
							{r.revision === current ? ' · Vigente' : ''}
						</span>
						{mine && r.revision !== current && (
							<Button
								type="button"
								variant="outline"
								size="xs"
								disabled={restoring !== null}
								onClick={() => void restore(r.revision)}
								aria-label={`Preparar restauración revisión ${r.revision}`}
							>
								{restoring === r.revision ? 'Preparando…' : 'Restaurar'}
							</Button>
						)}
					</li>
				))}
			</ul>
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
		</Category>
	);
}
