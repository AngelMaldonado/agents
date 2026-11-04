import { useEffect, useRef, useState } from 'react';
import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import {
	Activity,
	CheckCircle2,
	Clock3,
	Info,
	LoaderCircle,
	LockKeyhole,
	ShieldCheck,
	TriangleAlert,
	XCircle,
} from 'lucide-react';
import { api } from '@/api';
import { REPAIR_LABEL, repairPending, type Diagnosis, type Repair } from '../../../shared/self-maintenance';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';

const when = (ms: number) =>
	new Date(ms).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const LEVEL = {
	error: { icon: XCircle, className: 'text-destructive' },
	warning: { icon: TriangleAlert, className: 'text-warning' },
	info: { icon: Info, className: 'text-muted-foreground' },
} as const;

export function DiagnosisCard({ report }: { report: Diagnosis }) {
	const problems = report.findings.filter((f) => f.level !== 'info').length;
	return (
		<section className="grid gap-3 rounded-lg border p-4 text-sm" aria-label="Diagnóstico de configuración">
			<div className="flex items-start justify-between gap-3">
				<h3 className="flex items-center gap-2 font-medium">
					{problems ? (
						<TriangleAlert className="size-4 text-warning" aria-hidden="true" />
					) : (
						<Activity className="size-4 text-muted-foreground" aria-hidden="true" />
					)}
					{/* Without errors is not «all good»: the platform cannot know which tools a task needs. */}
					{problems
						? `${problems} ${problems === 1 ? 'problema' : 'problemas'} de configuración`
						: 'Sin errores de configuración detectados'}
				</h3>
				<span className="shrink-0 text-2xs text-muted-foreground">
					Revisión {report.revision} · {when(report.at)}
				</span>
			</div>
			{report.findings.length > 0 && (
				<ul className="grid gap-2.5">
					{report.findings.map((f) => {
						const { icon: Icon, className } = LEVEL[f.level];
						return (
							<li key={f.code} className="flex gap-2.5">
								<Icon className={`mt-0.5 size-4 shrink-0 ${className}`} aria-hidden="true" />
								<div className="min-w-0">
									<p className={f.level === 'error' ? 'font-medium' : ''}>{f.summary}</p>
									<p className="text-xs text-muted-foreground">{f.suggestion}</p>
									{f.fields.length > 0 && (
										<p className="text-2xs text-muted-foreground">Dónde: {f.fields.join(' · ')}</p>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			)}
			{report.runtime && (
				<div className="grid gap-1.5 border-t pt-3">
					<p className="text-xs font-medium text-muted-foreground">
						En la computadora del agente · {when(report.runtime.at)}
					</p>
					<Check
						ok={report.runtime.toolsOk}
						label="Herramientas CLI"
						detail={report.runtime.toolsOk ? 'instaladas' : 'no confirmadas'}
					/>
					{report.runtime.mcp.map((m) => (
						<Check
							key={m.name}
							ok={m.ok}
							label={`MCP ${m.name}`}
							detail={
								m.ok
									? 'conectado'
									: m.ok === null
										? 'falta iniciar sesión'
										: 'no conectó: revisa URL, autenticación y permisos'
							}
						/>
					))}
					{report.runtime.undelivered.map((n) => (
						<Check key={n} ok={false} label={n} detail="concedido pero no entregado (falta el proxy de salida)" />
					))}
				</div>
			)}
			{report.accesses.length > 0 && (
				<details className="border-t pt-3">
					<summary className="cursor-pointer text-xs text-muted-foreground">
						Tus accesos ({report.accesses.length})
					</summary>
					<ul className="mt-2 grid gap-1.5">
						{report.accesses.map((a) => (
							<li key={`${a.kind}:${a.id}`} className="text-xs">
								<span className="font-medium">{a.name}</span>{' '}
								<span className="text-muted-foreground">
									· {a.kind === 'key' ? 'API Key' : 'MCP'} · {a.granted ? 'concedido a este agente' : 'no concedido'}
									{a.usedBy?.length > 0 && ` · lo usan: ${a.usedBy.map((n) => n.name).join(', ')}`}
								</span>
							</li>
						))}
					</ul>
				</details>
			)}
			<p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
				<LockKeyhole className="size-3" aria-hidden="true" />
				Los valores secretos no entran al diagnóstico: se corrigen en Configuración → Accesos, nunca en el chat.
			</p>
		</section>
	);
}

function Check({ ok, label, detail }: { ok: boolean | null; label: string; detail: string }) {
	const Icon = ok ? CheckCircle2 : ok === null ? Clock3 : XCircle;
	return (
		<p className="flex items-center gap-2 text-xs">
			<Icon
				className={`size-3.5 shrink-0 ${ok ? 'text-success' : ok === null ? 'text-muted-foreground' : 'text-destructive'}`}
				aria-hidden="true"
			/>
			<span className="font-medium">{label}</span>
			<span className="text-muted-foreground">{detail}</span>
		</p>
	);
}

/** Only what changes between two texts, line by line (an LCS; contracts and harnesses are small). */
function lineDiff(before: string, after: string) {
	const a = before.split('\n'),
		b = after.split('\n');
	const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
	const out: { kind: ' ' | '-' | '+'; text: string }[] = [];
	let i = 0,
		j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			out.push({ kind: ' ', text: a[i] });
			i++;
			j++;
		} else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j]))
			out.push({ kind: '+', text: b[j++] });
		else out.push({ kind: '-', text: a[i++] });
	}
	// Unchanged lines only as context next to a change.
	return out.filter((l, k) => l.kind !== ' ' || out.slice(Math.max(0, k - 2), k + 3).some((x) => x.kind !== ' '));
}

function Diff({ before, after }: { before: string; after: string }) {
	const lines = lineDiff(before, after);
	if (!lines.some((l) => l.kind !== ' '))
		return <p className="text-xs text-muted-foreground">Sin cambios en el texto.</p>;
	return (
		<pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 py-1 font-mono text-2xs leading-5">
			{lines.map((l, k) => (
				<div
					key={k}
					className={`whitespace-pre-wrap break-words px-2 ${l.kind === '+' ? 'bg-success-soft text-success-on-soft' : l.kind === '-' ? 'bg-danger-soft text-danger-on-soft' : 'text-muted-foreground'}`}
				>
					{l.kind} {l.text}
				</div>
			))}
		</pre>
	);
}

function RepairCard({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
	const [repair, setRepair] = useState<Repair | null>(null),
		[error, setError] = useState(''),
		[saving, setSaving] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const refreshed = useRef<string | null>(null),
		changed = useRef(onChanged);
	changed.current = onChanged;
	useEffect(() => {
		let alive = true;
		let timer: ReturnType<typeof setTimeout>;
		const load = async () => {
			try {
				const r = await api<Repair>(`/self-repairs/${id}`);
				if (!alive) return;
				setRepair(r);
				setError('');
				if (repairPending(r)) timer = setTimeout(() => void load(), 3000);
				else if (r.status === 'done' && refreshed.current !== r.id) {
					refreshed.current = r.id;
					await changed.current();
				}
			} catch (e) {
				if (alive) setError((e as Error).message);
			}
		};
		void load();
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [id, refresh]);
	const decide = async (approve: boolean) => {
		setSaving(true);
		setError('');
		try {
			const r = await api<Repair>(`/self-repairs/${id}/decision`, { body: { approve } });
			setRepair(r);
			setRefresh((n) => n + 1);
			await onChanged();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	};
	if (!repair)
		return (
			<div className="flex items-center gap-3 text-sm text-muted-foreground">
				<p role={error ? 'alert' : 'status'}>{error || 'Cargando propuesta…'}</p>
				{error && (
					<Button size="sm" variant="outline" onClick={() => setRefresh((n) => n + 1)}>
						Reintentar
					</Button>
				)}
			</div>
		);
	return (
		<section className="grid gap-3 rounded-lg border p-4 text-sm" aria-label="Propuesta de reparación">
			<div className="flex items-start justify-between gap-3">
				<h3 className="flex items-center gap-2 font-medium">
					<ShieldCheck className="size-4 text-primary" aria-hidden="true" />
					Propuesta de reparación
				</h3>
				<span className="shrink-0 font-mono text-2xs text-muted-foreground">{repair.code}</span>
			</div>
			<p>{repair.reason}</p>
			<p className="text-2xs text-muted-foreground">
				Sobre la revisión {repair.revision}. {repair.policy}
			</p>
			{repair.action.kind === 'configuration' ? (
				<div className="grid gap-1.5">
					<p className="text-xs font-medium text-muted-foreground">Qué cambia (contrato y harness)</p>
					<Diff
						before={`${repair.before.role}\n\n${JSON.stringify(repair.before.harness, null, 2)}`}
						after={`${repair.action.role}\n\n${JSON.stringify(repair.action.harness, null, 2)}`}
					/>
				</div>
			) : repair.action.kind === 'install' ? (
				<ul className="list-disc pl-4">
					{repair.action.packages.map((p) => (
						<li className="break-all" key={p.spec}>
							{p.kind}: {p.spec}
							{p.sha256 && <span className="block text-xs">SHA256: {p.sha256}</span>}
						</li>
					))}
				</ul>
			) : (
				<p>
					Conceder <strong>{repair.action.name}</strong> sólo a este agente. No cambia los campos del acceso ni las
					concesiones de los demás.
				</p>
			)}
			<p role="status" className="flex items-center gap-2 text-xs font-medium">
				{repair.status === 'done' ? (
					<CheckCircle2 className="size-3.5 text-success" aria-hidden="true" />
				) : ['failed', 'rejected', 'expired'].includes(repair.status) ? (
					<XCircle className="size-3.5 text-destructive" aria-hidden="true" />
				) : repair.status === 'pending' ? (
					<Clock3 className="size-3.5 text-warning" aria-hidden="true" />
				) : (
					<LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
				)}
				{REPAIR_LABEL[repair.status]}
				{repair.automatic ? ' · se aplicó sola (lista segura)' : ''}
			</p>
			{repair.result && <p>{repair.result}</p>}
			{repair.status === 'pending' && (
				<>
					<p className="text-2xs text-muted-foreground">
						Autorizar cubre sólo esta propuesta; si la configuración cambia antes, se descarta.
					</p>
					<div className="flex gap-2">
						<Button size="sm" disabled={saving} onClick={() => void decide(true)}>
							Autorizar reparación
						</Button>
						<Button size="sm" variant="outline" disabled={saving} onClick={() => void decide(false)}>
							Rechazar
						</Button>
					</div>
				</>
			)}
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
		</section>
	);
}
function CurrentDiagnosis({ agentId }: { agentId: number }) {
	const [data, setData] = useState<Diagnosis | null>(null),
		[error, setError] = useState('');
	useEffect(() => {
		let alive = true;
		void api<Diagnosis>(`/agents/${agentId}/self-diagnosis`)
			.then((r) => {
				if (alive) setData(r);
			})
			.catch((e) => {
				if (alive) setError(e.message);
			});
		return () => {
			alive = false;
		};
	}, [agentId]);
	return data ? (
		<DiagnosisCard report={data} />
	) : (
		<p role={error ? 'alert' : 'status'} className="text-sm text-muted-foreground">
			{error || 'Revisando la configuración…'}
		</p>
	);
}
// Backend-owned tool cards, rendered by assistant-ui. Buttons call the authenticated decision API,
// not addResult/resume: a browser tool result is never executable approval authority.
export function maintenanceToolUI(
	agentId: number,
	mine: boolean,
	onChanged: () => Promise<void>,
): ToolCallMessagePartComponent {
	return function MaintenanceTool({ toolName, args }) {
		if (!mine)
			return <p className="text-xs text-muted-foreground">El dueño está revisando la configuración de este agente.</p>;
		if (toolName === 'self_repair' && typeof args.id === 'string')
			return <RepairCard id={args.id} onChanged={onChanged} />;
		return <CurrentDiagnosis agentId={agentId} />;
	};
}
export function DiagnoseButton({ agentId }: { agentId: number }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
				<Activity className="size-4" />
				Revisar configuración
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>Diagnóstico de configuración</DialogTitle>
						<DialogDescription>
							Funciona aunque el agente no pueda arrancar. No instala herramientas ni cambia accesos.
						</DialogDescription>
					</DialogHeader>
					{open && <CurrentDiagnosis agentId={agentId} />}
				</DialogContent>
			</Dialog>
		</>
	);
}
