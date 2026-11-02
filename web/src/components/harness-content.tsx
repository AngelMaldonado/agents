import { useState } from 'react';
import { BookOpen, MessageSquare, Plug, Puzzle, SquareTerminal } from 'lucide-react';
import type { AccessSuggestion, Design, Harness, HarnessValidation } from '@/api';
import { effectiveTools, PLUGINS } from '../../../sandbox/harness';
import { ContractMarkdown, ToolsPanel } from './design-content';
import { Tile } from './harness-tile';
import { AccessSuggestions } from './access-suggestions';
import { ScheduleCalendar } from './schedule-calendar';
import { PlanCompact, type PlanTodo } from './tool-ui/plan';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SCHEDULE_TZ, zoneLabel } from '@/lib/schedules';

function Category({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
	return (
		<section className="grid min-w-0 gap-2">
			<h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
			{children}
			{hint && <p className="text-2xs text-muted-foreground">{hint}</p>}
		</section>
	);
}
const Empty = ({ children }: { children: React.ReactNode }) => (
	<p className="text-xs text-muted-foreground">{children}</p>
);

/** The proposed harness as tiles (icon + name; what it is in the tooltip), like Configuración → Harness. */
export function HarnessPanel({
	value,
	accesses,
	onGrant,
	newAgent = false,
}: {
	value: Harness;
	accesses?: AccessSuggestion[];
	/** «Conceder» from the panel: right away when improving, on approval for a new agent. */
	onGrant?: (kind: string, id: number) => Promise<void>;
	newAgent?: boolean;
}) {
	const [skill, setSkill] = useState<Harness['skills'][number] | null>(null);
	return (
		<div className="grid min-w-0 gap-5" aria-label="Harness propuesto">
			<p className="text-xs text-muted-foreground">
				Manifiesto v{value.version}. Sólo se activa tras probar y aprobar esta revisión, en corridas nuevas. Políticas,
				cuotas, red y accesos de plataforma no son autoeditables.
			</p>
			<Category title="Herramientas">
				<ToolsPanel tools={effectiveTools(value)} compact />
			</Category>
			<Category title="Skills" hint="Instrucciones versionadas; no ejecutan código durante la entrevista.">
				{value.skills.length ? (
					<div className="harness-tiles">
						{value.skills.map((s) => (
							<Tile key={s.name} icon={BookOpen} title={s.name} hint={s.description} onClick={() => setSkill(s)} />
						))}
					</div>
				) : (
					<Empty>Sin skills adicionales.</Empty>
				)}
			</Category>
			<Category title="MCP">
				{value.mcp?.length ? (
					<div className="harness-tiles">
						{value.mcp.map((s) => (
							<Tile
								key={s.name}
								icon={Plug}
								title={s.name}
								detail={s.transport === 'http' ? (s.url ?? '') : [s.command, ...s.args].join(' ')}
								hint={`${s.description}${s.oauth ? ' Inicia sesión con OAuth.' : ''}${
									[...s.headers, ...s.env].length
										? ` Usa: ${[...s.headers, ...s.env].map((p) => `${p.name}=${p.value}`).join(' · ')}.`
										: ''
								}`}
							/>
						))}
					</div>
				) : (
					<Empty>Sin servidores MCP.</Empty>
				)}
			</Category>
			<Category title="CLI">
				{value.installs?.length ? (
					<div className="harness-tiles">
						{value.installs.map((i) => (
							<Tile
								key={`${i.kind}:${i.spec}`}
								icon={SquareTerminal}
								title={i.kind === 'binary' ? (i.name ?? i.spec) : i.spec}
								detail={i.kind === 'npm' ? 'npm' : i.kind === 'uv' ? 'Python (uv)' : 'binario'}
								hint={`Versión fija: se instala en la computadora del agente al arrancar y queda en su PATH.${
									i.kind === 'binary' ? ` sha256 ${i.sha256}` : ''
								}`}
							/>
						))}
					</div>
				) : (
					<Empty>Sin herramientas de línea de comandos.</Empty>
				)}
			</Category>
			{!!value.plugins.length && (
				<Category title="Plugins">
					<div className="harness-tiles">
						{value.plugins.map((p) => (
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
			{!!accesses?.length && (
				<Category
					title="Accesos sugeridos"
					hint={
						newAgent
							? 'Son tuyos. Lo que concedas aquí se le concede a este agente al aprobarlo; también puedes hacerlo durante la inicialización.'
							: 'Son tuyos. «Conceder» se lo concede a este agente ahora (se administra en Configuración → Accesos).'
					}
				>
					<AccessSuggestions suggestions={accesses} onGrant={onGrant} />
				</Category>
			)}
			{!!value.restrictions.guidelines.length && (
				<Category title="Pautas de trabajo" hint="Instrucciones para el modelo, no permisos ni garantías técnicas.">
					<ul className="list-disc space-y-1.5 pl-4 text-xs">
						{value.restrictions.guidelines.map((g, i) => (
							<li key={i} className="break-words">
								{g}
							</li>
						))}
					</ul>
				</Category>
			)}
			<p className="text-2xs text-muted-foreground">
				Archivos: {value.restrictions.workspaceFilesOnly ? 'limitados a ~/work' : 'dentro de la computadora aislada'} ·{' '}
				{value.restrictions.readOnlyFiles ? 'sólo lectura' : 'escritura según herramientas'}
				{value.tools.includes('bash') ? ' · con bash (puede reproducir operaciones de otras herramientas)' : ''}.
			</p>
			<Dialog open={!!skill} onOpenChange={(open) => !open && setSkill(null)}>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>{skill?.name}</DialogTitle>
						<DialogDescription>{skill?.description}</DialogDescription>
					</DialogHeader>
					{skill && (
						<div className="max-h-[60vh] overflow-y-auto">
							<ContractMarkdown text={skill.instructions} />
						</div>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}

/** What the approval leaves: the proposed schedules (or the current ones it keeps) as an agenda, with
 * each prompt below. Read only: they change by asking in the chat. */
export function SchedulesPanel({ design }: { design: Design }) {
	const timezone = design.scheduleTimezone ?? SCHEDULE_TZ,
		current = design.currentSchedules ?? [];
	const kept = design.schedules == null;
	const list = kept
		? current
		: design.schedules!.map((s, i) => ({
				name: `propuesto-${i + 1}`,
				cron: s.cron,
				message: s.message,
				status: 'ACTIVE',
			}));
	return (
		<div className="grid min-w-0 gap-4" aria-label="Horarios">
			{design.status === 'draft' && (
				<p className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-2xs text-muted-foreground">
					<MessageSquare className="mt-px size-3.5 shrink-0 text-primary" aria-hidden="true" />
					Para agregar, cambiar o quitar un horario (o su prompt), pídelo en el chat.
				</p>
			)}
			<p className="text-xs text-muted-foreground">
				{kept
					? current.length
						? 'Esta propuesta no cambia los horarios: se conservan los vigentes.'
						: 'Sin horarios: el agente sólo trabaja cuando le escriben o por webhook.'
					: list.length
						? 'Al aprobar, el agente queda con exactamente estos horarios. Los vigentes iguales se conservan (también si están en pausa); los demás se quitan.'
						: 'La propuesta quita todos los horarios.'}{' '}
				{zoneLabel(timezone)}.
			</p>
			{list.length > 0 && <ScheduleCalendar readOnly schedules={list} timezone={timezone} height={380} />}
		</div>
	);
}

/** Everything the isolated test checks, as a checklist that runs and ticks (Tool UI's Plan). */
export function HarnessTests({
	report,
	version,
	pending,
	checks,
}: {
	report?: HarnessValidation | null;
	version: number;
	pending?: boolean;
	checks: string[];
}) {
	const current = report?.version === version ? report : null;
	// No step-by-step progress comes from the server: while it runs every check is running, and a
	// failed test does not say which one failed (its error does).
	const status: PlanTodo['status'] = pending ? 'in_progress' : current?.status === 'passed' ? 'completed' : 'pending';
	const todos: PlanTodo[] = checks.map((label, i) => ({
		id: `check-${i}`,
		label,
		status,
		...(label === 'Herramientas efectivas exactas' && current?.tools.length
			? { description: `Confirmadas: ${current.tools.join(', ')}.` }
			: {}),
	}));
	return (
		<section aria-label="Pruebas del harness" className="grid min-w-0 gap-4 text-xs">
			<div>
				<h3 className="text-sm font-semibold">
					{pending
						? 'Prueba aislada en curso…'
						: !current
							? 'Esta revisión todavía no se ha probado'
							: current.status === 'passed'
								? 'Harness comprobado en pi'
								: 'La prueba del harness falló'}
				</h3>
				<p className="mt-1 text-muted-foreground">
					Arranca pi real sin red, credenciales, volúmenes del agente ni peticiones GPT. No prueba la calidad del modelo
					ni garantiza que siga instrucciones semánticas.
				</p>
			</div>
			{current?.error && !pending && (
				<p role="alert" className="error break-words">
					{current.error}
				</p>
			)}
			{todos.length > 0 && (
				<PlanCompact
					id={`harness-tests-${version}`}
					title="Comprobaciones"
					todos={todos}
					maxVisibleTodos={todos.length}
					className="max-w-none min-w-0 border-0 bg-transparent py-0 shadow-none [&_[data-slot=card-content]]:px-0"
				/>
			)}
			{current && !pending && (
				<p className="break-all text-2xs text-muted-foreground">
					Revisión {current.version} · harness {current.harnessDigest.slice(0, 12)} · imagen{' '}
					{current.imageId ? current.imageId.slice(0, 19) : 'no disponible'}
				</p>
			)}
			<p className="text-2xs text-muted-foreground">
				Cada cambio de la propuesta invalida la prueba anterior (renombrar no). Probar no crea ni cambia un agente; aún
				debes aprobar explícitamente.
			</p>
		</section>
	);
}
