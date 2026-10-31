// An agent's channels, visible only to its owner: WhatsApp (the instance's shared number) and signed
// webhooks. Schedules have their own settings tab.
import { useEffect, useRef, useState } from 'react';
import { FEATURES } from '../../sandbox/features';
import { api, ago } from './api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Delivery = {
	id: number;
	run_id: number | null;
	event: string;
	url: string;
	status: 'pending' | 'delivered' | 'failed';
	attempts: number;
	last_code: number | null;
	last_error: string | null;
	next_at: number | null;
	resend_of: number | null;
	created_at: number;
};
import type { Schedule } from '@/lib/schedules';
type View = {
	inUrl: string;
	inSecret: string;
	outUrl: string | null;
	outSecret: string;
	deliveries: Delivery[];
	schedules: Schedule[];
	timezone: string;
	whatsapp: { available: boolean; phone: string | null; enabled: boolean; contacts: Contact[] };
};
type Contact = { phone: string; label: string; notify: boolean };

export function useAgentChannels(agentId: number) {
	const [v, setV] = useState<View | null>(null);
	const [error, setError] = useState('');
	const active = useRef<number | null>(null);
	const call = async (path: string, method: string, body?: unknown) => {
		setError('');
		try {
			const result = await api<View>(`/agents/${agentId}${path}`, { method, body });
			if (active.current === agentId) setV(result);
			return null;
		} catch (err) {
			const message = (err as Error).message;
			if (active.current === agentId) setError(message);
			return message;
		}
	};
	useEffect(() => {
		active.current = agentId;
		setV(null);
		void call('/channels', 'GET');
		return () => {
			active.current = null;
		};
	}, [agentId]);
	return { v, error, call };
}

export function Channels({ agentId }: { agentId: number }) {
	const { v, error, call } = useAgentChannels(agentId);
	if (!v)
		return (
			<div className="py-4">
				{error ? (
					<p role="alert" className="error">
						{error}{' '}
						<Button variant="outline" size="sm" onClick={() => void call('/channels', 'GET')}>
							Reintentar canales
						</Button>
					</p>
				) : (
					<p role="status" className="muted">
						Cargando canales…
					</p>
				)}
			</div>
		);
	return (
		<div className="channels grid min-w-0 gap-7 divide-y">
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
			{FEATURES.whatsapp && (
				<WhatsApp
					key={JSON.stringify(v.whatsapp)}
					v={v.whatsapp}
					save={(enabled, contacts) => call('/channels/whatsapp', 'PUT', { enabled, contacts })}
				/>
			)}
			<Inbound
				v={v}
				rotate={() =>
					confirm('¿Rotar la entrada? La URL y el secreto actuales dejan de servir al instante.') &&
					call('/channels/rotate', 'POST', { which: 'in' })
				}
			/>
			<Outbound
				v={v}
				save={(url) => call('/channels/out', 'PUT', { url })}
				rotate={() =>
					confirm('¿Rotar el secreto de salida? Tu puente tendrá que usar el nuevo.') &&
					call('/channels/rotate', 'POST', { which: 'out' })
				}
			/>
			<Deliveries list={v.deliveries} resend={(id) => call(`/deliveries/${id}/resend`, 'POST')} />
		</div>
	);
}

const phone = (digits: string) => `+${digits}`;
function WhatsApp({
	v,
	save,
}: {
	v: View['whatsapp'];
	save: (enabled: boolean, contacts: Contact[]) => Promise<string | null>;
}) {
	const [enabled, setEnabled] = useState(v.enabled);
	const [contacts, setContacts] = useState<Contact[]>(v.contacts);
	const [busy, setBusy] = useState(false),
		[saved, setSaved] = useState(false);
	const dirty = enabled !== v.enabled || JSON.stringify(contacts) !== JSON.stringify(v.contacts);
	const edit = (i: number, patch: Partial<Contact>) => {
		setSaved(false);
		setContacts((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
	};
	return (
		<section className="channel-section min-w-0" aria-label="WhatsApp">
			<h2>WhatsApp</h2>
			{v.available ? (
				<p className="muted">
					Un número para todos los agentes: <strong>{phone(v.phone ?? '')}</strong>. Sólo pueden escribirle a este
					agente los números de la lista. Quien habla con varios elige con <code>/agentes</code> y{' '}
					<code>/agente &lt;nombre&gt;</code>. Recibe la respuesta, los archivos que entregue y, si se atasca, su
					pregunta.
				</p>
			) : (
				<p className="muted">
					Un administrador todavía no ha vinculado un número de WhatsApp. Puedes dejar lista la configuración; se usa en
					cuanto haya número.
				</p>
			)}
			<label className="row mb-4 gap-2 text-sm">
				<input
					type="checkbox"
					checked={enabled}
					onChange={(e) => {
						setSaved(false);
						setEnabled(e.target.checked);
					}}
				/>{' '}
				Recibir y responder por WhatsApp
			</label>
			<div className="grid gap-2" role="group" aria-label="Números que pueden escribirle">
				{contacts.map((c, i) => (
					<div key={i} className="row wrap gap-2">
						<Input
							aria-label="Número con lada de país"
							className="max-w-48"
							value={c.phone}
							onChange={(e) => edit(i, { phone: e.target.value })}
							placeholder="5215512345678"
							inputMode="tel"
						/>
						<Input
							aria-label="Nombre"
							className="max-w-48"
							value={c.label}
							onChange={(e) => edit(i, { label: e.target.value })}
							placeholder="Nombre (opcional)"
						/>
						<label
							className="row gap-2 text-xs"
							title="También recibe cómo terminó el trabajo programado o por webhook"
						>
							<input type="checkbox" checked={c.notify} onChange={(e) => edit(i, { notify: e.target.checked })} />{' '}
							Avisos
						</label>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setSaved(false);
								setContacts((cs) => cs.filter((_, j) => j !== i));
							}}
						>
							Quitar
						</Button>
					</div>
				))}
				{!contacts.length && <p className="muted small">Sin números: nadie puede escribirle por WhatsApp.</p>}
			</div>
			<div className="row wrap mt-3 gap-2">
				<Button
					variant="outline"
					size="sm"
					disabled={contacts.length >= 20}
					onClick={() => {
						setSaved(false);
						setContacts((cs) => [...cs, { phone: '', label: '', notify: false }]);
					}}
				>
					Agregar número
				</Button>
				<Button
					size="sm"
					disabled={!dirty || busy}
					onClick={async () => {
						setBusy(true);
						const err = await save(enabled, contacts);
						setBusy(false);
						setSaved(!err);
					}}
				>
					{busy ? 'Guardando…' : 'Guardar WhatsApp'}
				</Button>
				{saved && !dirty && (
					<span role="status" className="muted small">
						Guardado.
					</span>
				)}
			</div>
			<p className="muted small mt-2">
				Escribe la lada de país y el número, sin espacios (México: 521 + 10 dígitos). «Avisos» recibe cómo terminó el
				trabajo de horarios y webhooks.
			</p>
		</section>
	);
}

function Secret({ value }: { value: string }) {
	const [shown, setShown] = useState(false);
	return (
		<span className="row flex-wrap">
			<code>{shown ? value : `${value.slice(0, 10)}…`}</code>
			<Button variant="ghost" size="sm" onClick={() => setShown((s) => !s)}>
				{shown ? 'Ocultar' : 'Mostrar'}
			</Button>
			<Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(value)}>
				Copiar
			</Button>
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
		<section className="channel-section min-w-0">
			<h2>Entrada</h2>
			<p className="muted">
				Un puente (n8n, Bubble…) despierta al agente con un POST firmado. Si trabaja, el mensaje entra como seguimiento;
				si está atascado, es su respuesta.
			</p>
			<div className="kv">
				<span className="muted">URL</span>
				<span className="row">
					<code>{v.inUrl}</code>
					<Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(v.inUrl)}>
						Copiar
					</Button>
				</span>
			</div>
			<div className="kv">
				<span className="muted">Secreto</span>
				<Secret value={v.inSecret} />
			</div>
			<details>
				<summary className="muted small">Ejemplo con curl</summary>
				<pre>{example}</pre>
			</details>
			<Button variant="danger-outline" size="sm" onClick={rotate}>
				Rotar URL y secreto
			</Button>
		</section>
	);
}

function Outbound({ v, save, rotate }: { v: View; save: (url: string) => void; rotate: () => void }) {
	const [url, setUrl] = useState(v.outUrl ?? '');
	return (
		<section className="channel-section min-w-0">
			<h2>Salida</h2>
			<p className="muted">
				Cuando una tarea termina o se atasca, Agents envía la respuesta, enlaces a archivos válidos por 7 días y el{' '}
				<code>context</code> del puente. Reintenta hasta 24 h.
			</p>
			<form
				className="row wrap mb-4"
				onSubmit={(e) => {
					e.preventDefault();
					save(url);
				}}
			>
				<Input
					aria-label="URL del webhook de salida"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="https://mi-puente/agents (vacío = sin webhook)"
				/>
				<Button>Guardar</Button>
			</form>
			<div className="kv">
				<span className="muted">Secreto</span>
				<Secret value={v.outSecret} />
			</div>
			<Button variant="danger-outline" size="sm" onClick={rotate}>
				Rotar secreto
			</Button>
		</section>
	);
}

const DELIVERY_LABEL = { pending: 'Reintentando', delivered: 'Entregado', failed: 'Falló' } as const;
function Deliveries({ list, resend }: { list: Delivery[]; resend: (id: number) => void }) {
	return (
		<section className="channel-section min-w-0">
			<h2>Entregas</h2>
			{!list.length ? (
				<p className="muted">Todavía no hay entregas.</p>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>#</TableHead>
							<TableHead>Evento</TableHead>
							<TableHead>Tarea</TableHead>
							<TableHead>Estado</TableHead>
							<TableHead>Intentos</TableHead>
							<TableHead>Última respuesta</TableHead>
							<TableHead>Cuándo</TableHead>
							<TableHead>
								<span className="sr-only">Acciones</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{list.map((d) => (
							<TableRow key={d.id}>
								<TableCell>
									{d.id}
									{d.resend_of ? <span className="muted small"> ↻{d.resend_of}</span> : null}
								</TableCell>
								<TableCell>{d.event}</TableCell>
								<TableCell>{d.run_id ?? '—'}</TableCell>
								<TableCell className={d.status === 'failed' ? 'error' : d.status === 'delivered' ? 'ok' : ''}>
									{DELIVERY_LABEL[d.status]}
									{d.status === 'pending' && d.next_at ? (
										<span className="muted small"> · otra vez {ago(d.next_at).replace('hace ', 'en ')}</span>
									) : null}
								</TableCell>
								<TableCell>{d.attempts}</TableCell>
								<TableCell className="max-w-xs text-xs whitespace-normal">
									{d.last_code ?? '—'}
									{d.last_error ? ` · ${d.last_error}` : ''}
								</TableCell>
								<TableCell className="text-xs">{ago(d.created_at)}</TableCell>
								<TableCell>
									<Button variant="ghost" size="sm" onClick={() => resend(d.id)}>
										Reenviar
									</Button>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</section>
	);
}
