// An agent's channels (its owner only): the signed inbound URL, the outbound webhook with its
// delivery log, and its schedules. The contract for bridges is in Bubble: agents, docs/canales.md.
import { useEffect, useState } from 'react';
import { api, ago } from './api';

type Delivery = {
	id: number; run_id: number | null; event: string; url: string; status: 'pending' | 'delivered' | 'failed'; attempts: number;
	last_code: number | null; last_error: string | null; next_at: number | null; resend_of: number | null; created_at: number;
};
type Schedule = { name: string; cron: string; message: string; status: string };
type View = {
	inUrl: string; inSecret: string; outUrl: string | null; outSecret: string;
	deliveries: Delivery[]; schedules: Schedule[]; timezone: string;
};

export function Channels({ agentId }: { agentId: number }) {
	const [v, setV] = useState<View | null>(null);
	const [error, setError] = useState('');
	const call = async (path: string, method: string, body?: unknown) => {
		setError('');
		try {
			setV(await api(`/agents/${agentId}${path}`, { method, body }));
		} catch (err) {
			setError((err as Error).message);
		}
	};
	useEffect(() => {
		void call('/channels', 'GET');
	}, [agentId]);
	if (!v) return <p className="muted pad">{error || 'Cargando…'}</p>;
	return (
		<div className="pad channels">
			{error && <p className="error">{error}</p>}
			<Inbound v={v} rotate={() => confirm('¿Rotar la entrada? La URL y el secreto actuales dejan de servir al instante.') && call('/channels/rotate', 'POST', { which: 'in' })} />
			<Outbound v={v} save={(url) => call('/channels/out', 'PUT', { url })} rotate={() => confirm('¿Rotar el secreto de salida? Tu puente tendrá que usar el nuevo.') && call('/channels/rotate', 'POST', { which: 'out' })} />
			<Deliveries list={v.deliveries} resend={(id) => call(`/deliveries/${id}/resend`, 'POST')} />
			<Schedules v={v} add={(cron, message) => call('/schedules', 'POST', { cron, message })}
				toggle={(s) => call(`/schedules/${encodeURIComponent(s.name)}/${s.status === 'PAUSED' ? 'resume' : 'pause'}`, 'POST')}
				remove={(s) => confirm(`¿Borrar el horario «${s.cron}»?`) && call(`/schedules/${encodeURIComponent(s.name)}`, 'DELETE')} />
		</div>
	);
}

function Secret({ value }: { value: string }) {
	const [shown, setShown] = useState(false);
	return (
		<span className="row">
			<code>{shown ? value : `${value.slice(0, 10)}…`}</code>
			<button className="ghost" onClick={() => setShown((s) => !s)}>{shown ? 'Ocultar' : 'Mostrar'}</button>
			<button className="ghost" onClick={() => navigator.clipboard.writeText(value)}>Copiar</button>
		</span>
	);
}

function Inbound({ v, rotate }: { v: View; rotate: () => void }) {
	const example = `body='{"text":"Hola, ¿qué tal?","from":"+52 55 0000 0000","context":{"chat":"123"}}'
t=$(date +%s)
sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$SECRETO" -hex | sed 's/^.* //')
curl -s ${v.inUrl} -H 'content-type: application/json' \\
  -H "x-agents-signature: t=$t,v1=$sig" -H "idempotency-key: msg-123" -d "$body"`;
	return (
		<section className="panel">
			<h2>Entrada</h2>
			<p className="muted">Un puente (WhatsApp, n8n, Bubble…) despierta a este agente con un POST firmado. Si está trabajando, el mensaje entra como seguimiento; si está atascado, es su respuesta.</p>
			<div className="kv"><span className="muted">URL</span><span className="row"><code>{v.inUrl}</code><button className="ghost" onClick={() => navigator.clipboard.writeText(v.inUrl)}>Copiar</button></span></div>
			<div className="kv"><span className="muted">Secreto</span><Secret value={v.inSecret} /></div>
			<details><summary className="muted small">Ejemplo con curl</summary><pre className="mono small">{example}</pre></details>
			<button className="ghost danger" onClick={rotate}>Rotar URL y secreto</button>
		</section>
	);
}

function Outbound({ v, save, rotate }: { v: View; save: (url: string) => void; rotate: () => void }) {
	const [url, setUrl] = useState(v.outUrl ?? '');
	return (
		<section className="panel">
			<h2>Salida</h2>
			<p className="muted">Cuando una tarea termina (o se atasca), Agents hace un POST firmado aquí con la respuesta, enlaces de 7 días a los archivos y el <code>context</code> que mandó el puente. Reintenta hasta 24 h.</p>
			<form className="row" onSubmit={(e) => { e.preventDefault(); save(url); }}>
				<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://mi-puente.lan:3000/agents (vacío = sin webhook)" />
				<button className="primary">Guardar</button>
			</form>
			<div className="kv"><span className="muted">Secreto</span><Secret value={v.outSecret} /></div>
			<button className="ghost danger" onClick={rotate}>Rotar secreto</button>
		</section>
	);
}

const DELIVERY_LABEL = { pending: 'reintentando', delivered: 'entregado', failed: 'falló' } as const;

function Deliveries({ list, resend }: { list: Delivery[]; resend: (id: number) => void }) {
	return (
		<section className="panel">
			<h2>Entregas</h2>
			{!list.length ? <p className="muted">Todavía nada.</p> : (
				<div className="table-wrap">
					<table>
						<thead><tr><th>#</th><th>Evento</th><th>Tarea</th><th>Estado</th><th>Intentos</th><th>Última respuesta</th><th>Cuándo</th><th /></tr></thead>
						<tbody>
							{list.map((d) => (
								<tr key={d.id}>
									<td>{d.id}{d.resend_of ? <span className="muted small"> ↻{d.resend_of}</span> : null}</td>
									<td>{d.event}</td>
									<td>{d.run_id ?? '—'}</td>
									<td className={d.status === 'failed' ? 'error' : d.status === 'delivered' ? 'ok' : ''}>
										{DELIVERY_LABEL[d.status]}{d.status === 'pending' && d.next_at ? <span className="muted small"> · otra vez {ago(d.next_at).replace('hace ', 'en ')}</span> : null}
									</td>
									<td>{d.attempts}</td>
									<td className="small">{d.last_code ?? '—'}{d.last_error ? ` · ${d.last_error}` : ''}</td>
									<td className="small">{ago(d.created_at)}</td>
									<td><button className="ghost" onClick={() => resend(d.id)}>Reenviar</button></td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

function Schedules({ v, add, toggle, remove }: { v: View; add: (cron: string, message: string) => void; toggle: (s: Schedule) => void; remove: (s: Schedule) => void }) {
	const [cron, setCron] = useState('0 9 * * 1-5');
	const [message, setMessage] = useState('');
	return (
		<section className="panel">
			<h2>Horarios</h2>
			<p className="muted">Formato cron de 5 campos (minuto hora día mes día-de-semana), hora de {v.timezone}. Si a esa hora el agente está ocupado, el mensaje entra como seguimiento.</p>
			{v.schedules.map((s) => (
				<div key={s.name} className="row schedule">
					<code>{s.cron}</code>
					<span className="grow">{s.message}</span>
					<span className="muted small">{s.status === 'PAUSED' ? 'en pausa' : 'activo'}</span>
					<button className="ghost" onClick={() => toggle(s)}>{s.status === 'PAUSED' ? 'Reanudar' : 'Pausar'}</button>
					<button className="ghost danger" onClick={() => remove(s)}>Borrar</button>
				</div>
			))}
			<form className="row wrap" onSubmit={(e) => { e.preventDefault(); add(cron, message); setMessage(''); }}>
				<input value={cron} onChange={(e) => setCron(e.target.value)} className="mono" style={{ maxWidth: '14em' }} />
				<input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Revisa el correo de ventas y resume lo nuevo" />
				<button className="primary" disabled={!message.trim()}>Agregar</button>
			</form>
		</section>
	);
}
