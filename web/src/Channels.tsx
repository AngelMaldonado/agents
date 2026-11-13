// An agent's channels, visible only to its owner: WhatsApp (who talks to it in their groups) and signed
// webhooks. Schedules have their own settings tab.
import { useEffect, useRef, useState } from 'react';
import { formatPhone, InfoTip, STATE_LABEL, type WhatsAppNumber } from './WhatsApp';
import { GrantToggle } from '@/components/access-ui';
import { SaveButton, useSaving, type SaveState } from '@/components/actions';
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
	whatsapp: {
		available: boolean;
		number: WhatsAppNumber | null;
		notify: boolean;
		contacts: Contact[];
	};
};

/** One phone of the number's allow list, as the agent's owner may switch it for this agent. */
type Contact = {
	key: string;
	shown: string;
	name: string;
	kind: 'owner' | 'person' | 'guest' | 'external' | 'direct';
	enabled: boolean;
};
const KIND: Record<Contact['kind'], string> = {
	owner: 'Tú',
	person: 'Compartido',
	guest: 'Invitado',
	external: 'Contacto externo',
	direct: 'Invitado directo',
};

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
	// Here and not in each section: the WhatsApp section remounts when its data changes, which is
	// exactly when its check must show.
	const waSaving = useSaving(),
		outSaving = useSaving();
	const saveWith = (saving: ReturnType<typeof useSaving>, path: string, body: unknown) =>
		saving
			.run(async () => {
				const err = await call(path, 'PUT', body);
				if (err) throw new Error(err);
			})
			.then(
				() => null,
				(e: Error) => e.message,
			);
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
		<div className="channels min-w-0">
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
			<WhatsApp
				key={JSON.stringify(v.whatsapp)}
				v={v.whatsapp}
				saveState={waSaving.state}
				save={(notify) => saveWith(waSaving, '/channels/whatsapp', { notify })}
			/>
			{v.whatsapp.available && v.whatsapp.number && (
				<WhatsAppContacts
					contacts={v.whatsapp.contacts}
					onToggle={(key, enabled) => call('/channels/whatsapp/contacts', 'PUT', { key, enabled })}
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
				saveState={outSaving.state}
				save={(url) => void saveWith(outSaving, '/channels/out', { url })}
				rotate={() =>
					confirm('¿Rotar el secreto de salida? Tu puente tendrá que usar el nuevo.') &&
					call('/channels/rotate', 'POST', { which: 'out' })
				}
			/>
			<Deliveries list={v.deliveries} resend={(id) => call(`/deliveries/${id}/resend`, 'POST')} />
		</div>
	);
}

/** Who of the number's allow list writes to this agent: one switch per phone, saved at once. */
function WhatsAppContacts({
	contacts,
	onToggle,
}: {
	contacts: Contact[];
	onToggle: (key: string, enabled: boolean) => Promise<string | null>;
}) {
	const [busy, setBusy] = useState('');
	return (
		<section className="panel channel-section min-w-0">
			<h2 className="inline-flex items-center gap-2">
				Quién le escribe por WhatsApp
				<InfoTip label="Quién habla con este agente">
					Los teléfonos de la lista blanca del número de los grupos. Cada uno encendido tiene este agente en su grupo
					«Agentes tuyo» y puede recibir sus avisos; un invitado directo encendido no tiene grupo: habla uno a uno con
					este agente (sólo un agente puede tenerlo encendido); un contacto externo encendido tampoco tiene grupo: el
					agente le escribe uno a uno con sus avisos o un encargo (por ejemplo, para cotizar) y su respuesta vuelve a la
					conversación que le preguntó. Tú y las personas con quienes lo compartiste (si su teléfono está ligado a ellas
					en la lista) están encendidos por defecto; los invitados y contactos externos, apagados. Agregar o bloquear
					teléfonos se hace en Configuración → WhatsApp → Editar, por quien administra el número.
				</InfoTip>
			</h2>
			{contacts.length ? (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Contacto</TableHead>
							<TableHead>Teléfono</TableHead>
							<TableHead className="w-24 text-right">Puede escribirle</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{contacts.map((c) => (
							<TableRow key={c.key}>
								<TableCell>
									<span className="font-medium">{c.name}</span> <span className="muted small">· {KIND[c.kind]}</span>
								</TableCell>
								<TableCell className="mono small">{/^\d+$/.test(c.shown) ? formatPhone(c.shown) : c.shown}</TableCell>
								<TableCell className="text-right">
									<GrantToggle
										on={c.enabled}
										what={c.name}
										label={`${c.name} puede escribirle a este agente`}
										disabled={busy === c.key}
										onChange={async (on) => {
											setBusy(c.key);
											await onToggle(c.key, on);
											setBusy('');
										}}
									/>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			) : (
				<p className="muted">
					Nadie de la lista blanca de este número puede escribirle todavía: agrega teléfonos en Configuración → WhatsApp
					→ Editar, o compártele el agente a alguien cuyo teléfono ya esté ligado a esa persona.
				</p>
			)}
		</section>
	);
}

function WhatsApp({
	v,
	save,
	saveState,
}: {
	v: View['whatsapp'];
	save: (notify: boolean) => Promise<string | null>;
	saveState: SaveState;
}) {
	const [notify, setNotify] = useState(v.notify);
	const n = v.number;
	return (
		<section className="panel channel-section min-w-0" aria-label="WhatsApp">
			<h2 className="inline-flex items-center gap-2">
				WhatsApp
				{v.available && (
					<InfoTip label="Cómo habla este agente por WhatsApp">
						Cada persona habla con tus agentes en su grupo «Agentes tuyo» del número de los grupos (lo elige un admin):
						ahí ve sólo los que le compartiste o le encendiste abajo. Contesta el agente que habló al último; para otro,
						empiezan con su nombre («Agente: …») o /agente &lt;nombre&gt;; citar un mensaje sigue esa conversación.
						/terminar cierra la conversación con el agente actual.
					</InfoTip>
				)}
			</h2>
			{!v.available ? (
				<p className="muted">Este servidor no tiene WhatsApp configurado.</p>
			) : !n ? (
				<p className="muted">
					Todavía no hay un número para los grupos: un admin lo elige en Configuración → WhatsApp.
				</p>
			) : (
				<>
					<p className="text-sm">
						Número de los grupos: <b className="font-medium">{n.label}</b>
						{n.phone && n.label !== formatPhone(n.phone) ? ` (${formatPhone(n.phone)})` : ''}
						{n.state === 'connected' ? '' : ` · ${STATE_LABEL[n.state]}`}
					</p>
					<div className="mt-3 flex items-center gap-2 text-sm">
						<GrantToggle
							on={notify}
							what="Avisar horarios y webhooks"
							label="Avisar horarios y webhooks"
							onChange={(on) => setNotify(on)}
						/>
						<span>Avisar horarios y webhooks</span>
						<InfoTip label="Qué avisa">
							Te manda a tu grupo «Agentes tuyo» cómo terminó el trabajo de sus horarios y webhooks.
						</InfoTip>
					</div>
					<div className="row wrap mt-3 gap-2">
						<SaveButton
							size="sm"
							state={saveState}
							disabled={notify === v.notify && saveState !== 'saved'}
							onClick={() => void save(notify)}
						>
							Guardar WhatsApp
						</SaveButton>
					</div>
				</>
			)}
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
		<section className="panel channel-section min-w-0">
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

function Outbound({
	v,
	save,
	saveState,
	rotate,
}: {
	v: View;
	save: (url: string) => void;
	saveState: SaveState;
	rotate: () => void;
}) {
	const [url, setUrl] = useState(v.outUrl ?? '');
	return (
		<section className="panel channel-section min-w-0">
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
				<SaveButton state={saveState} />
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
		<section className="panel channel-section min-w-0">
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
