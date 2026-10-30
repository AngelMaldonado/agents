// Each person sees their runs and queue; an admin also sees the host and orphans.
import { useCallback, useEffect, useState } from 'react';
import { api, ago, type Person } from './api';
import { useMonitorFeed, useTick } from './live';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Row = {
	run_id: number;
	agent_id: number;
	agent: string;
	person_id: number;
	person: string;
	status: string;
	state: string;
	created_at: number;
	started_at: number | null;
	cost: number;
	tokens: number;
	queue_position: number | null;
	person_queue_position: number | null;
	container: {
		id: string;
		cpuPercent: number;
		memoryBytes: number;
		memoryLimit: number;
		netRx: number;
		netTx: number;
	} | null;
};
type Host = { cpus: number; memoryTotal: number; memoryAvailable: number; load1: number; fits: number };
type Orphan = { id: string; name: string; run: string | null; state: string; created: number };
type Snapshot = { at: number; rows: Row[]; orphans: Orphan[]; host: Host | null };
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;
const gb = (n: number) => `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
const net = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);
const since = (ms: number | null) => {
	if (!ms) return '—';
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const STATUS: Record<string, string> = {
	queued: 'En cola',
	starting: 'Arrancando',
	running: 'Trabajando',
	blocked: 'Atascado',
};

export function Monitor({ me }: { me: Person }) {
	useTick(1000);
	const [snap, setSnap] = useState<Snapshot | null>(null);
	const [msg, setMsg] = useState('');
	useEffect(() => {
		void api('/monitor').then(setSnap);
	}, [me.admin]);
	useMonitorFeed(useCallback((m: Snapshot) => setSnap(m), []));
	if (!snap)
		return (
			<div className="page">
				<p className="muted" role="status">
					Cargando monitor…
				</p>
			</div>
		);
	const running = snap.rows.filter((r) => r.status !== 'queued');
	const queued = snap.rows.filter((r) => r.status === 'queued');
	const cancel = async (r: Row) => {
		if (!confirm(`¿Cancelar la tarea #${r.run_id} de ${r.agent}?`)) return;
		await api(`/tasks/${r.run_id}/cancel`, { method: 'POST' }).catch((err) => setMsg((err as Error).message));
	};
	return (
		<div className="page monitor">
			<div className="page-head">
				<div>
					<h1>Monitor</h1>
					<p className="muted">
						Actividad, recursos y cola de trabajo{me.admin ? ' de todo el equipo' : ' de tus agentes'}.
					</p>
				</div>
				<Badge variant="outline">{snap.at ? `Actualizado ${ago(snap.at)}` : 'Esperando muestra'}</Badge>
			</div>
			{msg && (
				<p role="status" className="mb-5 text-sm">
					{msg}
				</p>
			)}
			{snap.host && (
				<div className="mb-7 grid gap-4 md:grid-cols-3">
					<Metric
						label="reko-3 · CPU"
						value={`${snap.host.cpus} núcleos`}
						detail={`Carga actual: ${snap.host.load1.toFixed(2)}`}
					/>
					<Metric
						label="Memoria disponible"
						value={gb(snap.host.memoryAvailable)}
						detail={`De ${gb(snap.host.memoryTotal)} en el host`}
					/>
					<Metric
						label="Capacidad disponible"
						value={`~${snap.host.fits} agentes`}
						detail="Estimación de 1.5 GB por computadora"
					/>
				</div>
			)}
			<section className="panel">
				<div className="mb-4 flex items-center gap-2">
					<h2 className="!mb-0">Trabajando</h2>
					<Badge variant="secondary">{running.length}</Badge>
				</div>
				{!running.length ? (
					<p className="muted py-4">No hay tareas en ejecución.</p>
				) : (
					<Table className="min-w-[900px]">
						<TableHeader>
							<TableRow>
								<TableHead>Tarea</TableHead>
								<TableHead>Agente</TableHead>
								{me.admin && <TableHead>Dueño</TableHead>}
								<TableHead>Estado</TableHead>
								<TableHead>CPU</TableHead>
								<TableHead>RAM</TableHead>
								<TableHead>Red ↓/↑</TableHead>
								<TableHead>Vivo</TableHead>
								<TableHead>Costo</TableHead>
								<TableHead>Tokens</TableHead>
								<TableHead>
									<span className="sr-only">Acciones</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{running.map((r) => (
								<TableRow key={r.run_id}>
									<TableCell className="font-mono text-xs">#{r.run_id}</TableCell>
									<TableCell>
										<a className="font-medium hover:underline" href={`#/agent/${r.agent_id}`}>
											{r.agent}
										</a>
									</TableCell>
									{me.admin && <TableCell>{r.person}</TableCell>}
									<TableCell>
										<Badge variant="outline" className={`pill s-${r.status}`}>
											{STATUS[r.status] ?? r.status}
										</Badge>
										{r.state && r.status === 'running' && (
											<div className="mt-1 text-xs text-muted-foreground">{r.state}</div>
										)}
									</TableCell>
									<TableCell className="num">{r.container ? `${r.container.cpuPercent.toFixed(0)} %` : '—'}</TableCell>
									<TableCell className="num">
										{r.container ? `${mb(r.container.memoryBytes)} / ${mb(r.container.memoryLimit)}` : '—'}
									</TableCell>
									<TableCell className="num text-xs">
										{r.container ? `${net(r.container.netRx)} / ${net(r.container.netTx)}` : '—'}
									</TableCell>
									<TableCell className="num">{since(r.started_at)}</TableCell>
									<TableCell className="num">US${r.cost.toFixed(3)}</TableCell>
									<TableCell className="num">{(r.tokens / 1000).toFixed(1)}k</TableCell>
									<TableCell>
										{(me.admin || r.person_id === me.id) && (
											<Button variant="danger-ghost" size="sm" onClick={() => cancel(r)}>
												Cancelar
											</Button>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</section>
			<section className="panel">
				<div className="mb-4 flex items-center gap-2">
					<h2 className="!mb-0">En cola</h2>
					<Badge variant="secondary">{queued.length}</Badge>
				</div>
				{!queued.length ? (
					<p className="muted py-4">No hay tareas esperando.</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Lugar</TableHead>
								<TableHead>Tarea</TableHead>
								<TableHead>Agente</TableHead>
								{me.admin && <TableHead>Dueño</TableHead>}
								<TableHead>Esperando</TableHead>
								<TableHead>
									<span className="sr-only">Acciones</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{queued.map((r) => (
								<TableRow key={r.run_id}>
									<TableCell>{me.admin ? `${r.queue_position}.º` : `${r.person_queue_position}.º tuya`}</TableCell>
									<TableCell className="font-mono text-xs">#{r.run_id}</TableCell>
									<TableCell>
										<a className="font-medium hover:underline" href={`#/agent/${r.agent_id}`}>
											{r.agent}
										</a>
									</TableCell>
									{me.admin && <TableCell>{r.person}</TableCell>}
									<TableCell className="num">{since(r.created_at)}</TableCell>
									<TableCell>
										{(me.admin || r.person_id === me.id) && (
											<Button variant="danger-ghost" size="sm" onClick={() => cancel(r)}>
												Cancelar
											</Button>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
				{!me.admin && (
					<p className="muted small mt-4">
						Tu cuota decide cuántas tareas tuyas corren a la vez; el tope global, cuántas en total.
					</p>
				)}
			</section>
			{me.admin && (
				<section className="panel">
					<div className="mb-3 flex items-center gap-2">
						<h2 className="!mb-0">Huérfanos</h2>
						<Badge variant="secondary">{snap.orphans.length}</Badge>
					</div>
					<p className="muted">Computadoras de esta instancia que ninguna tarea viva reclama.</p>
					{snap.orphans.length > 0 ? (
						<>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Contenedor</TableHead>
										<TableHead>Tarea</TableHead>
										<TableHead>Estado</TableHead>
										<TableHead>Creado</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{snap.orphans.map((o) => (
										<TableRow key={o.id}>
											<TableCell className="font-mono text-xs">{o.name}</TableCell>
											<TableCell>{o.run ? `#${o.run}` : '—'}</TableCell>
											<TableCell>{o.state}</TableCell>
											<TableCell className="text-xs">{ago(o.created)}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
							<Button
								variant="destructive"
								className="mt-4"
								onClick={async () => {
									if (!confirm(`¿Borrar ${snap.orphans.length} computadora(s) huérfana(s)?`)) return;
									const r = await api('/admin/orphans/clean', { method: 'POST' });
									setMsg(`Se borraron ${r.cleaned}.`);
								}}
							>
								Limpiar huérfanos
							</Button>
						</>
					) : (
						<p className="muted small">Todo en orden. No hay computadoras huérfanas.</p>
					)}
				</section>
			)}
		</div>
	);
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
	return (
		<Card className="gap-0 py-5 shadow-none">
			<CardContent>
				<p className="text-xs text-muted-foreground">{label}</p>
				<p className="mt-3 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
				<p className="mt-1 text-xs text-muted-foreground">{detail}</p>
			</CardContent>
		</Card>
	);
}
