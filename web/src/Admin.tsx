// Behind the shared PIN: global limits, the model catalog, the sandbox image, and people.
import { useEffect, useState } from 'react';
import { FEATURES } from '../../sandbox/features';
import { api, ago, type Person } from './api';
import { UsesTable } from './Settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function Admin({ me, pinIsSet, onChanged }: { me: Person; pinIsSet: boolean; onChanged: () => void }) {
	if (!me.admin) return <Unlock pinIsSet={pinIsSet} onUnlocked={onChanged} />;
	return <Panel onChanged={onChanged} />;
}

function Unlock({ pinIsSet, onUnlocked }: { pinIsSet: boolean; onUnlocked: () => void }) {
	const [pin, setPin] = useState('');
	const [error, setError] = useState('');
	if (!pinIsSet)
		return (
			<div className="page">
				<p className="muted">Todavía no hay PIN: falta poner AGENTS_ADMIN_PIN en el stack.</p>
			</div>
		);
	return (
		<div className="page narrow">
			<h1 className="mb-2">Administración</h1>
			<p className="muted mb-6">Escribe el PIN de admin. Dura 30 días en este navegador.</p>
			<form
				className="row"
				onSubmit={async (e) => {
					e.preventDefault();
					try {
						await api('/admin/unlock', { body: { pin } });
						onUnlocked();
					} catch (err) {
						setError((err as Error).message);
					}
				}}
			>
				<Input
					type="password"
					aria-label="PIN de administrador"
					inputMode="numeric"
					value={pin}
					onChange={(e) => setPin(e.target.value)}
					autoFocus
				/>
				<Button>Entrar</Button>
			</form>
			{error && <p className="error">{error}</p>}
		</div>
	);
}

/** A person's simultaneous-task quota, saved when it changes. */
function Quota({ person, onSaved }: { person: { id: number; run_quota: number }; onSaved: (people: any[]) => void }) {
	const [value, setValue] = useState(person.run_quota);
	const [error, setError] = useState('');
	const save = async () => {
		if (value === person.run_quota) return;
		try {
			const { people } = await api(`/admin/people/${person.id}/quota`, { method: 'PUT', body: { quota: value } });
			setError('');
			onSaved(people);
		} catch (err) {
			setError((err as Error).message);
		}
	};
	return (
		<>
			<Input
				type="number"
				aria-label={`Cuota de la persona ${person.id}`}
				min={0}
				max={60}
				value={value}
				className="w-20"
				onChange={(e) => setValue(Number(e.target.value))}
				onBlur={save}
				onKeyDown={(e) => e.key === 'Enter' && save()}
			/>
			{error && <span className="error small"> {error}</span>}
		</>
	);
}

type WhatsAppStatus = {
	state: 'off' | 'down' | 'unlinked' | 'pairing' | 'connecting' | 'connected';
	phone?: string;
	name?: string;
	qr?: string;
	error?: string;
};
const WA_STATE = {
	off: 'Sin puente',
	down: 'El puente no responde',
	unlinked: 'Sin número',
	pairing: 'Esperando que escanees el código',
	connecting: 'Conectando…',
	connected: 'Conectado',
} as const;
/** One WhatsApp number for every agent of this instance; owners turn it on per agent in Canales. */
function WhatsAppAdmin() {
	const [s, setS] = useState<WhatsAppStatus | null>(null);
	const [msg, setMsg] = useState('');
	const load = () =>
		api<WhatsAppStatus>('/admin/whatsapp')
			.then(setS)
			.catch((e) => setMsg((e as Error).message));
	useEffect(() => {
		void load();
	}, []);
	// While pairing the code changes every ~20 s; while connecting it settles in a few.
	useEffect(() => {
		if (s?.state !== 'pairing' && s?.state !== 'connecting') return;
		const t = setInterval(() => void load(), 2000);
		return () => clearInterval(t);
	}, [s?.state]);
	const act = async (path: string) => {
		setMsg('');
		try {
			setS(await api<WhatsAppStatus>(path, { method: 'POST' }));
		} catch (e) {
			setMsg((e as Error).message);
		}
	};
	return (
		<section className="panel">
			<h2>WhatsApp</h2>
			<p className="muted">
				Un número compartido por todos los agentes. Cada dueño lo activa en los Canales de su agente y decide qué
				números pueden escribirle. Usa un número dedicado: es la conexión de WhatsApp Web (whatsmeow), no la API
				oficial, y WhatsApp puede bloquear números que detecte como automatizados.
			</p>
			{!s ? (
				<p className="muted">Cargando…</p>
			) : (
				<>
					<p>
						<strong>{WA_STATE[s.state]}</strong>
						{s.phone ? ` · +${s.phone}${s.name ? ` (${s.name})` : ''}` : ''}
					</p>
					{s.error && (
						<p role="alert" className="error">
							{s.error}
						</p>
					)}
					{s.state === 'pairing' &&
						(s.qr ? (
							<div className="grid justify-items-start gap-2">
								<img
									src={`data:image/png;base64,${s.qr}`}
									alt="Código QR para vincular WhatsApp"
									width={240}
									height={240}
									className="rounded-md bg-white p-2"
								/>
								<p className="muted small">
									En el teléfono: WhatsApp → Dispositivos vinculados → Vincular un dispositivo, y escanea. El código
									cambia cada ~20 s.
								</p>
							</div>
						) : (
							<p className="muted">Generando el código…</p>
						))}
					<div className="row wrap gap-2">
						{s.state === 'unlinked' && (
							<Button onClick={() => void act('/admin/whatsapp/pair')}>Vincular número</Button>
						)}
						{(s.state === 'connected' || s.state === 'connecting' || s.state === 'pairing') && (
							<Button
								variant="danger-outline"
								onClick={() => {
									if (
										confirm(
											'¿Desvincular el número? Los agentes dejarán de recibir y enviar por WhatsApp hasta que vincules otro.',
										)
									)
										void act('/admin/whatsapp/logout');
								}}
							>
								{s.state === 'pairing' ? 'Cancelar' : 'Desvincular'}
							</Button>
						)}
						<Button variant="ghost" onClick={() => void load()}>
							Actualizar
						</Button>
					</div>
				</>
			)}
			{msg && (
				<p role="alert" className="error">
					{msg}
				</p>
			)}
		</section>
	);
}

function Panel({ onChanged }: { onChanged: () => void }) {
	const [data, setData] = useState<any>(null);
	const [draft, setDraft] = useState<any>(null);
	const [models, setModels] = useState('');
	const [msg, setMsg] = useState('');
	const [link, setLink] = useState('');
	const load = () =>
		api('/admin').then((r) => {
			setData(r);
			setDraft(r.settings);
			setModels(r.settings.models.map((m: any) => `${m.id} | ${m.label}`).join('\n'));
		});
	useEffect(() => {
		void load();
	}, []);
	if (!data)
		return (
			<div className="page">
				<p className="muted">Cargando…</p>
			</div>
		);
	const num = (k: string) => (
		<Input
			type="number"
			value={draft[k]}
			onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })}
			step={k === 'maxCostUsd' ? 0.5 : 1}
		/>
	);
	return (
		<div className="page">
			<div className="page-head">
				<div>
					<h1>Administración</h1>
					<p className="muted">Límites, modelos y acceso del equipo.</p>
				</div>
				<Button
					variant="outline"
					onClick={async () => {
						await api('/admin/lock', { method: 'POST' });
						onChanged();
					}}
				>
					Salir de admin
				</Button>
			</div>
			{FEATURES.whatsapp && <WhatsAppAdmin />}
			<section className="panel">
				<h2>Límites</h2>
				<div className="settings-grid">
					<label>Computadoras a la vez, todos juntos (1–60){num('maxConcurrent')}</label>
					<label>Minutos máximos por tarea{num('maxMinutes')}</label>
					<label>Tope de costo por tarea (US$){num('maxCostUsd')}</label>
					<label>Minutos que espera un agente atascado{num('blockedWaitMinutes')}</label>
					<label>
						Imagen del sandbox
						<Input value={draft.sandboxImage} onChange={(e) => setDraft({ ...draft, sandboxImage: e.target.value })} />
					</label>
				</div>
				<label>
					Catálogo de modelos (uno por línea: <code>proveedor/modelo | nombre</code>)
					<Textarea rows={6} value={models} onChange={(e) => setModels(e.target.value)} className="mono" />
				</label>
				<div className="row wrap mt-4">
					<Button
						onClick={async () => {
							const list = models
								.split('\n')
								.map((l) => l.trim())
								.filter(Boolean)
								.map((l) => {
									const [id, label] = l.split('|').map((s) => s.trim());
									return { id, label: label || id };
								});
							try {
								await api('/admin/settings', { method: 'PUT', body: { ...draft, models: list } });
								setMsg('Guardado.');
								await load();
								onChanged();
							} catch (err) {
								setMsg((err as Error).message);
							}
						}}
					>
						Guardar
					</Button>
					<span className="muted">{msg}</span>
				</div>
			</section>
			<section className="panel">
				<h2>Personas</h2>
				<p className="muted">
					Quien vuelve desde otro navegador necesita un link de un solo uso (24 h). La cuota es cuántas tareas suyas
					corren a la vez; las tuyas con el PIN puesto pasan primero en la cola.
				</p>
				{link && (
					<div className="callout mb-4 break-all">
						<code>{link}</code>{' '}
						<Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(link)}>
							Copiar
						</Button>
					</div>
				)}
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Nombre</TableHead>
							<TableHead>Agentes</TableHead>
							<TableHead>Tareas</TableHead>
							<TableHead>Cuota</TableHead>
							<TableHead>Desde</TableHead>
							<TableHead>
								<span className="sr-only">Acciones</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{data.people.map((p: any) => (
							<TableRow key={p.id}>
								<TableCell className="font-medium">{p.name}</TableCell>
								<TableCell>{p.agents}</TableCell>
								<TableCell>{p.tasks}</TableCell>
								<TableCell>
									<Quota person={p} onSaved={(people) => setData({ ...data, people })} />
								</TableCell>
								<TableCell className="text-xs">{ago(p.created_at)}</TableCell>
								<TableCell>
									<div className="row">
										<Button
											variant="ghost"
											size="sm"
											onClick={async () => {
												const { code } = await api(`/admin/people/${p.id}/invite`, { method: 'POST' });
												setLink(`${location.origin}/#/invite/${code}`);
											}}
										>
											Enlace
										</Button>
										<Button
											variant="danger-ghost"
											size="sm"
											onClick={async () => {
												if (confirm(`¿Borrar a ${p.name} con sus agentes, tareas, keys y accesos?`)) {
													await api(`/admin/people/${p.id}`, { method: 'DELETE' });
													await load();
													onChanged();
												}
											}}
										>
											Borrar
										</Button>
									</div>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</section>
			<section className="panel">
				<h2>Uso de accesos (todos)</h2>
				<p className="muted">Los secretos nunca se muestran, tampoco aquí.</p>
				<UsesTable uses={data.uses} showPerson />
			</section>
		</div>
	);
}
