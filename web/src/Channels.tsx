// An agent's signed webhooks, visible only to its owner. Schedules have their own settings tab.
import { useEffect, useRef, useState } from 'react';
import { api, ago } from './api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Delivery = {
	id: number; run_id: number | null; event: string; url: string; status: 'pending' | 'delivered' | 'failed'; attempts: number;
	last_code: number | null; last_error: string | null; next_at: number | null; resend_of: number | null; created_at: number;
};
import type { Schedule } from '@/lib/schedules';
type View = {
	inUrl: string; inSecret: string; outUrl: string | null; outSecret: string;
	deliveries: Delivery[]; schedules: Schedule[]; timezone: string;
};

export function useAgentChannels(agentId: number) {
	const [v, setV] = useState<View | null>(null);
	const [error, setError] = useState('');
	const active = useRef<number | null>(null);
	const call = async (path: string, method: string, body?: unknown) => {
		setError('');
		try { const result = await api<View>(`/agents/${agentId}${path}`, { method, body }); if (active.current === agentId) setV(result); return null; }
		catch (err) { const message = (err as Error).message; if (active.current === agentId) setError(message); return message; }
	};
	useEffect(() => { active.current = agentId; setV(null); void call('/channels', 'GET'); return () => { active.current = null; }; }, [agentId]);
	return { v, error, call };
}

export function Channels({ agentId }: { agentId: number }) {
	const { v, error, call } = useAgentChannels(agentId);
	if (!v) return <div className="py-4">{error ? <p role="alert" className="error">{error} <Button variant="outline" size="sm" onClick={() => void call('/channels', 'GET')}>Reintentar canales</Button></p> : <p role="status" className="muted">Cargando canales…</p>}</div>;
	return (
		<div className="channels grid min-w-0 gap-7 divide-y">
			{error && <p role="alert" className="error">{error}</p>}
			<Inbound v={v} rotate={() => confirm('¿Rotar la entrada? La URL y el secreto actuales dejan de servir al instante.') && call('/channels/rotate', 'POST', { which: 'in' })} />
			<Outbound v={v} save={(url) => call('/channels/out', 'PUT', { url })} rotate={() => confirm('¿Rotar el secreto de salida? Tu puente tendrá que usar el nuevo.') && call('/channels/rotate', 'POST', { which: 'out' })} />
			<Deliveries list={v.deliveries} resend={(id) => call(`/deliveries/${id}/resend`, 'POST')} />
		</div>
	);
}

function Secret({ value }: { value: string }) {
	const [shown, setShown] = useState(false);
	return <span className="row flex-wrap"><code>{shown ? value : `${value.slice(0, 10)}…`}</code><Button variant="ghost" size="sm" onClick={() => setShown((s) => !s)}>{shown ? 'Ocultar' : 'Mostrar'}</Button><Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(value)}>Copiar</Button></span>;
}

function Inbound({ v, rotate }: { v: View; rotate: () => void }) {
	const example = `body='{"text":"Hola, ¿qué tal?","from":"+52 55 0000 0000","context":{"chat":"123"}}'
t=$(date +%s)
sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$SECRETO" -hex | sed 's/^.* //')
curl -s ${v.inUrl} -H 'content-type: application/json' \\
  -H "x-agents-signature: t=$t,v1=$sig" -H "idempotency-key: msg-123" -d "$body"`;
	return (
		<section className="channel-section min-w-0">
			<h2>Entrada</h2><p className="muted">Un puente (WhatsApp, n8n, Bubble…) despierta al agente con un POST firmado. Si trabaja, el mensaje entra como seguimiento; si está atascado, es su respuesta.</p>
			<div className="kv"><span className="muted">URL</span><span className="row"><code>{v.inUrl}</code><Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(v.inUrl)}>Copiar</Button></span></div>
			<div className="kv"><span className="muted">Secreto</span><Secret value={v.inSecret} /></div>
			<details><summary className="muted small">Ejemplo con curl</summary><pre>{example}</pre></details>
			<Button variant="danger-outline" size="sm" onClick={rotate}>Rotar URL y secreto</Button>
		</section>
	);
}

function Outbound({ v, save, rotate }: { v: View; save: (url: string) => void; rotate: () => void }) {
	const [url, setUrl] = useState(v.outUrl ?? '');
	return (
		<section className="channel-section min-w-0">
			<h2>Salida</h2><p className="muted">Cuando una tarea termina o se atasca, Agents envía la respuesta, enlaces a archivos válidos por 7 días y el <code>context</code> del puente. Reintenta hasta 24 h.</p>
			<form className="row wrap mb-4" onSubmit={(e) => { e.preventDefault(); save(url); }}><Input aria-label="URL del webhook de salida" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mi-puente/agents (vacío = sin webhook)" /><Button>Guardar</Button></form>
			<div className="kv"><span className="muted">Secreto</span><Secret value={v.outSecret} /></div>
			<Button variant="danger-outline" size="sm" onClick={rotate}>Rotar secreto</Button>
		</section>
	);
}

const DELIVERY_LABEL = { pending: 'Reintentando', delivered: 'Entregado', failed: 'Falló' } as const;
function Deliveries({ list, resend }: { list: Delivery[]; resend: (id: number) => void }) {
	return (
		<section className="channel-section min-w-0"><h2>Entregas</h2>
			{!list.length ? <p className="muted">Todavía no hay entregas.</p> : <Table>
				<TableHeader><TableRow><TableHead>#</TableHead><TableHead>Evento</TableHead><TableHead>Tarea</TableHead><TableHead>Estado</TableHead><TableHead>Intentos</TableHead><TableHead>Última respuesta</TableHead><TableHead>Cuándo</TableHead><TableHead><span className="sr-only">Acciones</span></TableHead></TableRow></TableHeader>
				<TableBody>{list.map((d) => <TableRow key={d.id}>
					<TableCell>{d.id}{d.resend_of ? <span className="muted small"> ↻{d.resend_of}</span> : null}</TableCell><TableCell>{d.event}</TableCell><TableCell>{d.run_id ?? '—'}</TableCell>
					<TableCell className={d.status === 'failed' ? 'error' : d.status === 'delivered' ? 'ok' : ''}>{DELIVERY_LABEL[d.status]}{d.status === 'pending' && d.next_at ? <span className="muted small"> · otra vez {ago(d.next_at).replace('hace ', 'en ')}</span> : null}</TableCell>
					<TableCell>{d.attempts}</TableCell><TableCell className="max-w-xs text-xs whitespace-normal">{d.last_code ?? '—'}{d.last_error ? ` · ${d.last_error}` : ''}</TableCell><TableCell className="text-xs">{ago(d.created_at)}</TableCell>
					<TableCell><Button variant="ghost" size="sm" onClick={() => resend(d.id)}>Reenviar</Button></TableCell>
				</TableRow>)}</TableBody>
			</Table>}
		</section>
	);
}
