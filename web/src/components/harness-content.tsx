import type { Agent, Design, Harness, HarnessValidation } from '@/api';
import { defaultHarness, effectiveTools, PLUGINS } from '../../../sandbox/harness';
import { ContractMarkdown, ToolsPanel } from './design-content';
import { nextRuns, SCHEDULE_TZ, zoneLabel } from '@/lib/schedules';
export function HarnessPanel({ value }: { value: Harness }) {
	return (
		<div className="grid min-w-0 gap-5" aria-label="Harness propuesto">
			<p className="text-xs text-muted-foreground">
				Manifiesto v{value.version}. Políticas, cuotas, red y accesos de plataforma no son autoeditables. Sólo se activa
				tras probar y aprobar esta revisión, en corridas nuevas.
			</p>
			<section className="min-w-0">
				<h3 className="mb-3 text-sm font-semibold">Herramientas efectivas</h3>
				<ToolsPanel tools={effectiveTools(value)} />
			</section>
			<section className="grid gap-2 text-xs">
				<h3 className="text-sm font-semibold">Restricciones de archivos</h3>
				<p>
					{value.restrictions.workspaceFilesOnly
						? 'Rutas limitadas a ~/work, comprobando destinos reales de enlaces.'
						: 'Archivos dentro de la computadora aislada; sin límite adicional a ~/work.'}
				</p>
				<p>
					{value.restrictions.readOnlyFiles
						? 'Sólo lectura: no write/edit ni capturas en disco.'
						: 'Escritura según herramientas seleccionadas.'}
				</p>
				{value.tools.includes('bash') && (
					<p className="text-muted-foreground">
						Bash habilitado: puede reproducir operaciones de otras herramientas. Su selección no es una frontera de
						seguridad.
					</p>
				)}
				<p className="text-muted-foreground">
					Estos controles cubren las operaciones de archivos del harness confiable; no son un sandbox para código
					arbitrario. La navegación y los accesos mantienen su estado gestionado por la plataforma.
				</p>
			</section>
			<section className="min-w-0">
				<h3 className="mb-2 text-sm font-semibold">Pautas de trabajo</h3>
				{value.restrictions.guidelines.length ? (
					<ul className="list-disc space-y-2 pl-4 text-xs">
						{value.restrictions.guidelines.map((g, i) => (
							<li key={i} className="break-words">
								{g}
							</li>
						))}
					</ul>
				) : (
					<p className="text-xs text-muted-foreground">Sin pautas adicionales.</p>
				)}
				<p className="mt-2 text-2xs text-muted-foreground">
					Son instrucciones para el modelo, no permisos ni garantías técnicas.
				</p>
			</section>
			<section className="min-w-0">
				<h3 className="mb-2 text-sm font-semibold">Skills generadas</h3>
				{value.skills.length ? (
					value.skills.map((s) => (
						<details key={s.name} className="min-w-0 border-t py-3">
							<summary className="cursor-pointer break-words text-xs font-medium">
								{s.name} — {s.description}
							</summary>
							<div className="mt-3">
								<ContractMarkdown text={s.instructions} />
							</div>
						</details>
					))
				) : (
					<p className="text-xs text-muted-foreground">Sin skills adicionales.</p>
				)}
				<p className="mt-2 text-2xs text-muted-foreground">
					Sólo instrucciones versionadas; no ejecutan código durante la entrevista.
				</p>
			</section>
			<section className="min-w-0">
				<h3 className="mb-2 text-sm font-semibold">Servidores MCP</h3>
				{value.mcp?.length ? (
					<ul className="space-y-3 text-xs">
						{value.mcp.map((s) => (
							<li key={s.name}>
								<strong className="break-all">{s.name}</strong> ·{' '}
								{s.transport === 'http' ? (
									<code className="break-all">{s.url}</code>
								) : (
									<code className="break-all">{[s.command, ...s.args].join(' ')}</code>
								)}
								{s.oauth && <span className="text-muted-foreground"> · inicio de sesión (OAuth)</span>}
								<p className="mt-1 text-muted-foreground">{s.description}</p>
								{[...s.headers, ...s.env].length > 0 && (
									<p className="mt-1 break-all text-2xs text-muted-foreground">
										{[...s.headers, ...s.env].map((p) => `${p.name}=${p.value}`).join(' · ')}
									</p>
								)}
							</li>
						))}
					</ul>
				) : (
					<p className="text-xs text-muted-foreground">Sin servidores MCP.</p>
				)}
				<p className="mt-2 text-2xs text-muted-foreground">
					Sus herramientas se declaran al modelo como mcp__servidor__herramienta. Las credenciales se guardan aparte, en
					Configuración → Herramientas.
				</p>
			</section>
			<section className="min-w-0">
				<h3 className="mb-2 text-sm font-semibold">Herramientas por instalar</h3>
				{value.installs?.length ? (
					<ul className="space-y-1 text-xs">
						{value.installs.map((i) => (
							<li key={`${i.kind}:${i.spec}`}>
								<code className="break-all">{i.kind === 'binary' ? `${i.name} ← ${i.spec}` : i.spec}</code>{' '}
								<span className="text-muted-foreground">
									{i.kind === 'npm' ? 'npm' : i.kind === 'uv' ? 'Python (uv)' : `sha256 ${i.sha256}`}
								</span>
							</li>
						))}
					</ul>
				) : (
					<p className="text-xs text-muted-foreground">Sin herramientas adicionales.</p>
				)}
				<p className="mt-2 text-2xs text-muted-foreground">
					Versiones fijas; se instalan en la computadora del agente al arrancar y quedan en su PATH.
				</p>
			</section>
			<section className="min-w-0">
				<h3 className="mb-2 text-sm font-semibold">Plugins fijados</h3>
				{value.plugins.length ? (
					<ul className="space-y-3 text-xs">
						{value.plugins.map((p) => (
							<li key={p.id}>
								<strong className="break-all">
									{p.id}@{p.version}
								</strong>
								<p className="mt-1 text-muted-foreground">{PLUGINS.find((c) => c.id === p.id)?.description}</p>
							</li>
						))}
					</ul>
				) : (
					<p className="text-xs text-muted-foreground">Sin plugins adicionales.</p>
				)}
				<p className="mt-3 text-2xs text-muted-foreground">
					Sólo catálogo revisado. Código de plugins generado, paquetes externos y nuevas concesiones de acceso no están
					habilitados.
				</p>
			</section>
		</div>
	);
}
type ProposedSchedule = { cron: string; message: string; status?: string };
const when = (d: Date, timezone: string) =>
	d.toLocaleString('es-MX', {
		timeZone: timezone,
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
	});
/** What the approval leaves: the proposed list, or the current one when the design keeps it. */
export function SchedulesPanel({ design }: { design: Design }) {
	const timezone = design.scheduleTimezone ?? SCHEDULE_TZ,
		current = design.currentSchedules ?? [];
	const kept = design.schedules == null,
		list: ProposedSchedule[] = kept ? current : design.schedules!;
	return (
		<div className="grid min-w-0 gap-4" aria-label="Horarios">
			<p className="text-xs text-muted-foreground">
				{kept
					? current.length
						? 'Esta propuesta no cambia los horarios: se conservan los vigentes.'
						: 'Sin horarios: el agente sólo trabaja cuando le escriben o por webhook.'
					: 'Al aprobar, el agente queda con exactamente estos horarios. Los vigentes iguales se conservan (también si están en pausa); los demás se quitan.'}{' '}
				{zoneLabel(timezone)}.
			</p>
			{list.length ? (
				<ul className="grid gap-3">
					{list.map((s, i) => (
						<li key={`${s.cron}-${i}`} className="min-w-0 rounded-md border p-3 text-xs">
							<p className="font-mono font-medium">
								{s.cron}
								{s.status === 'PAUSED' && <span className="ml-2 font-sans text-muted-foreground">(en pausa)</span>}
							</p>
							<p className="mt-1 text-2xs text-muted-foreground">
								Próximas:{' '}
								{nextRuns(s.cron, 3, timezone)
									.map((d) => when(d, timezone))
									.join(' · ') || 'no se pudo calcular'}
							</p>
							<p className="mt-2 whitespace-pre-wrap break-words">{s.message}</p>
						</li>
					))}
				</ul>
			) : (
				!kept && <p className="text-xs">La propuesta quita todos los horarios.</p>
			)}
		</div>
	);
}
const scheduleText = (list: ProposedSchedule[]) => list.map((s) => `${s.cron}  ${s.message}`).join('\n');
export function HarnessChanges({ design, agent }: { design: Design; agent?: Agent }) {
	const before = design.currentHarness ?? agent?.harness ?? defaultHarness(),
		after = design.harness ?? before;
	const rows = [
		['Nombre', design.currentContract?.name ?? agent?.name ?? '', design.contract?.name ?? ''],
		['Contrato', design.currentContract?.prompt ?? agent?.role ?? '', design.contract?.prompt ?? ''],
		['Modelo', agent?.model ?? '', design.model],
		['Herramientas', before.tools.join(', '), after.tools.join(', ')],
		['Restricciones', JSON.stringify(before.restrictions, null, 2), JSON.stringify(after.restrictions, null, 2)],
		['Skills', JSON.stringify(before.skills, null, 2), JSON.stringify(after.skills, null, 2)],
		['Plugins', JSON.stringify(before.plugins, null, 2), JSON.stringify(after.plugins, null, 2)],
		['Servidores MCP', JSON.stringify(before.mcp ?? [], null, 2), JSON.stringify(after.mcp ?? [], null, 2)],
		[
			'Herramientas por instalar',
			JSON.stringify(before.installs ?? [], null, 2),
			JSON.stringify(after.installs ?? [], null, 2),
		],
		[
			'Horarios',
			scheduleText(design.currentSchedules ?? []),
			scheduleText(design.schedules ?? design.currentSchedules ?? []),
		],
	].filter(([, old, next]) => old !== next);
	return (
		<section aria-label="Cambios de la definición" className="grid min-w-0 gap-4">
			<p className="text-xs text-muted-foreground">
				{agent
					? `Comparado con la revisión vigente ${agent.config_revision ?? ''}.`
					: 'Definición inicial comparada con las capacidades predeterminadas.'}{' '}
				La aprobación incluye contrato, modelo, harness y horarios completos.
			</p>
			{rows.length ? (
				rows.map(([name, old, next]) => (
					<details key={name} className="min-w-0 border-t pt-3">
						<summary className="cursor-pointer text-xs font-semibold">{name}</summary>
						<div className="mt-3 grid min-w-0 gap-3 text-2xs">
							<div>
								<p className="mb-1 font-medium">Antes</p>
								<pre className="whitespace-pre-wrap break-words text-muted-foreground">{old || 'No existía'}</pre>
							</div>
							<div>
								<p className="mb-1 font-medium">Propuesto</p>
								<pre className="whitespace-pre-wrap break-words">{next || 'Vacío'}</pre>
							</div>
						</div>
					</details>
				))
			) : (
				<p className="text-xs text-muted-foreground">Sin cambios en la definición.</p>
			)}
		</section>
	);
}
export function HarnessTests({
	report,
	version,
	pending,
}: {
	report?: HarnessValidation | null;
	version: number;
	pending?: boolean;
}) {
	const current = report?.version === version;
	return (
		<section aria-label="Pruebas del harness" className="grid min-w-0 gap-4 text-xs">
			<h3 className="text-sm font-semibold">
				{pending
					? 'Prueba aislada en curso…'
					: !current
						? 'Esta revisión todavía no se ha probado'
						: report.status === 'passed'
							? 'Harness comprobado en pi'
							: 'La prueba del harness falló'}
			</h3>
			<p className="text-muted-foreground">
				Arranca pi real sin red, credenciales, volúmenes del agente ni peticiones GPT. No prueba calidad del modelo ni
				garantiza el cumplimiento de instrucciones semánticas.
			</p>
			{current && (
				<>
					<p className="break-all text-2xs">
						Revisión del borrador: {report.version}
						<br />
						Hash del harness: {report.harnessDigest}
						<br />
						Imagen exacta: {report.imageId || 'No disponible'}
					</p>
					{report.error && (
						<p role="alert" className="error break-words">
							{report.error}
						</p>
					)}
					<ul className="list-disc space-y-2 pl-4">
						{report.checks.map((check) => (
							<li key={check}>{check}</li>
						))}
					</ul>
					{report.tools.length > 0 && (
						<p className="break-words text-muted-foreground">Herramientas confirmadas: {report.tools.join(', ')}.</p>
					)}
				</>
			)}
			<p className="text-2xs text-muted-foreground">
				Cada cambio de la propuesta invalida la prueba anterior. Probar no crea ni cambia un agente; aún debes aprobar
				explícitamente.
			</p>
		</section>
	);
}
