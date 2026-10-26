// The container monitor (Q2, Q3): each person sees their runs and their place in the queue; an
// admin sees everyone's, the host and the orphans. Fed every few seconds over the live socket.
import { useCallback, useEffect, useState } from 'react';
import { api, ago, type Person } from './api';
import { useMonitorFeed, useTick } from './live';

type Row = {
	run_id: number; agent_id: number; agent: string; person_id: number; person: string; status: string; state: string;
	created_at: number; started_at: number | null; cost: number; tokens: number;
	queue_position: number | null; person_queue_position: number | null;
	container: { id: string; cpuPercent: number; memoryBytes: number; memoryLimit: number; netRx: number; netTx: number } | null;
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
const STATUS: Record<string, string> = { queued: 'en cola', starting: 'arrancando', running: 'trabajando', blocked: 'atascado' };

export function Monitor({ me }: { me: Person }) {
	useTick(1000);
	const [snap, setSnap] = useState<Snapshot | null>(null);
	const [msg, setMsg] = useState('');
	useEffect(() => {
		void api('/monitor').then(setSnap);
	}, [me.admin]);
	useMonitorFeed(useCallback((m: Snapshot) => setSnap(m), []));
	if (!snap) return <div className="page"><p className="muted">Cargando…</p></div>;
	const running = snap.rows.filter((r) => r.status !== 'queued');
	const queued = snap.rows.filter((r) => r.status === 'queued');
	const cancel = async (r: Row) => {
		if (!confirm(`¿Cancelar la tarea #${r.run_id} de ${r.agent}?`)) return;
		await api(`/tasks/${r.run_id}/cancel`, { method: 'POST' }).catch((err) => setMsg((err as Error).message));
	};
	return (
		<div className="page monitor">
			<div className="page-head">
				<h1>Monitor</h1>
				<span className="muted small">{snap.at ? `actualizado ${ago(snap.at)}` : 'esperando la primera muestra…'}</span>
			</div>
			{msg && <p className="error">{msg}</p>}
			{snap.host && (
				<section className="panel host">
					<h2>reko-3</h2>
					<div className="row wrap">
						<span><b>{snap.host.cpus}</b> núcleos · carga {snap.host.load1.toFixed(2)}</span>
						<span><b>{gb(snap.host.memoryAvailable)}</b> libres de {gb(snap.host.memoryTotal)}</span>
						<span>caben <b>~{snap.host.fits}</b> computadoras más (1.5 GB c/u)</span>
					</div>
				</section>
			)}
			<section className="panel">
				<h2>Trabajando ({running.length})</h2>
				{!running.length ? <p className="muted">Nada corriendo.</p> : (
					<div className="table-wrap">
						<table>
							<thead><tr><th>Tarea</th><th>Agente</th>{me.admin && <th>Dueño</th>}<th>Estado</th><th>CPU</th><th>RAM</th><th>Red ↓/↑</th><th>Vivo</th><th>Costo</th><th>Tokens</th><th /></tr></thead>
							<tbody>
								{running.map((r) => (
									<tr key={r.run_id}>
										<td>#{r.run_id}</td>
										<td><a href={`#/agent/${r.agent_id}`}>{r.agent}</a></td>
										{me.admin && <td>{r.person}</td>}
										<td>{STATUS[r.status] ?? r.status}{r.state && r.status === 'running' ? <span className="muted small"> · {r.state}</span> : null}</td>
										<td className="num">{r.container ? `${r.container.cpuPercent.toFixed(0)} %` : '—'}</td>
										<td className="num">{r.container ? `${mb(r.container.memoryBytes)} / ${mb(r.container.memoryLimit)}` : '—'}</td>
										<td className="num small">{r.container ? `${net(r.container.netRx)} / ${net(r.container.netTx)}` : '—'}</td>
										<td className="num">{since(r.started_at)}</td>
										<td className="num">US${r.cost.toFixed(3)}</td>
										<td className="num">{(r.tokens / 1000).toFixed(1)}k</td>
										<td>{(me.admin || r.person_id === me.id) && <button className="ghost danger" onClick={() => cancel(r)}>Cancelar</button>}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
			<section className="panel">
				<h2>En cola ({queued.length})</h2>
				{!queued.length ? <p className="muted">Nadie esperando.</p> : (
					<div className="table-wrap">
						<table>
							<thead><tr><th>Lugar</th><th>Tarea</th><th>Agente</th>{me.admin && <th>Dueño</th>}<th>Esperando</th><th /></tr></thead>
							<tbody>
								{queued.map((r) => (
									<tr key={r.run_id}>
										<td>{me.admin ? `${r.queue_position}.º` : `${r.person_queue_position}.º tuya`}</td>
										<td>#{r.run_id}</td>
										<td><a href={`#/agent/${r.agent_id}`}>{r.agent}</a></td>
										{me.admin && <td>{r.person}</td>}
										<td className="num">{since(r.created_at)}</td>
										<td>{(me.admin || r.person_id === me.id) && <button className="ghost danger" onClick={() => cancel(r)}>Cancelar</button>}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				{!me.admin && <p className="muted small">Tu cuota decide cuántas tuyas corren a la vez; el tope global, cuántas en total.</p>}
			</section>
			{me.admin && (
				<section className="panel">
					<h2>Huérfanos ({snap.orphans.length})</h2>
					<p className="muted">Computadoras de esta instancia que ninguna tarea viva reclama (una caída a medio camino, un contenedor que no se borró).</p>
					{snap.orphans.length > 0 && (
						<>
							<table>
								<thead><tr><th>Contenedor</th><th>Tarea</th><th>Estado</th><th>Creado</th></tr></thead>
								<tbody>
									{snap.orphans.map((o) => (
										<tr key={o.id}><td className="mono small">{o.name}</td><td>{o.run ? `#${o.run}` : '—'}</td><td>{o.state}</td><td className="small">{ago(o.created)}</td></tr>
									))}
								</tbody>
							</table>
							<button className="danger" onClick={async () => {
								if (!confirm(`¿Borrar ${snap.orphans.length} computadora(s) huérfana(s)?`)) return;
								const r = await api('/admin/orphans/clean', { method: 'POST' });
								setMsg(`Se borraron ${r.cleaned}.`);
							}}>Limpiar huérfanos</button>
						</>
					)}
				</section>
			)}
		</div>
	);
}
