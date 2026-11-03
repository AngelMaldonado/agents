// cuby-whatsapp in the web (#18): the admin's section (turn it on, its keys, limits and state) and each
// person's card to link their own phone to the company number (by writing it; no code).
import { useEffect, useState } from 'react';
import type { Value as PhoneValue } from 'react-phone-number-input';
import { api } from '@/api';
import { formatPhone, InfoTip } from '@/WhatsApp';
import { GrantToggle } from '@/components/access-ui';
import { SaveButton, useSaving } from '@/components/actions';
import { OptionSelect } from '@/components/option-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';

type AdminView = {
	enabled: boolean;
	mode: 'live' | 'test';
	liveKey: string | null;
	testKey: string | null;
	dailyPerPerson: number;
	shownPhone: string;
	url: string;
	status: {
		connected: boolean;
		running: boolean;
		lastPollAt: number;
		lastError: string;
		allowlistSyncedAt: number;
		allowlistCount: number;
	};
};
const time = (ms: number) =>
	ms ? new Date(ms).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '—';

/** Administración → Cuby WhatsApp. The keys go only through these password fields, never anywhere else. */
export function CubyWhatsAppAdmin() {
	const [v, setV] = useState<AdminView | null>(null);
	const [draft, setDraft] = useState({ enabled: false, mode: 'test' as 'live' | 'test', daily: 100, phone: '' });
	const [keys, setKeys] = useState({ live: '', test: '' });
	const [error, setError] = useState('');
	const saving = useSaving();
	const take = (r: AdminView) => {
		setV(r);
		setDraft({
			enabled: r.enabled,
			mode: r.mode,
			daily: r.dailyPerPerson,
			phone: r.shownPhone ? `+${r.shownPhone}` : '',
		});
	};
	useEffect(() => {
		api<AdminView>('/admin/cuby-whatsapp')
			.then(take)
			.catch((e) => setError((e as Error).message));
	}, []);
	// While it is on, its connection is read again every few seconds (only the state: not the draft).
	useEffect(() => {
		if (!v?.enabled) return;
		const t = setInterval(
			() =>
				void api<AdminView>('/admin/cuby-whatsapp')
					.then((r) => setV((cur) => (cur ? { ...cur, status: r.status } : r)))
					.catch(() => {}),
			5000,
		);
		return () => clearInterval(t);
	}, [v?.enabled]);
	if (!v) return null;
	return (
		<section className="panel">
			<h2 className="inline-flex items-center gap-2">
				Cuby WhatsApp
				<InfoTip label="Qué es Cuby WhatsApp">
					El número de la empresa, por el servicio cuby-whatsapp ({v.url}). Agents se conecta como una integración (la
					creas en su página y pegas aquí su llave). Encendido, aloja los grupos «Agentes …» de cada persona (salvo que
					un admin marque otro número); la lista blanca la llevan los admins en Configuración → WhatsApp → Editar, y
					cada persona agrega su teléfono en Configuración → WhatsApp. El número es compartido con otras integraciones:
					su tope es de todos.
				</InfoTip>
			</h2>
			<form
				className="form"
				onSubmit={async (e) => {
					e.preventDefault();
					setError('');
					try {
						await saving.run(async () => {
							take(
								await api<AdminView>('/admin/cuby-whatsapp', {
									method: 'PUT',
									body: {
										enabled: draft.enabled,
										mode: draft.mode,
										dailyPerPerson: draft.daily,
										shownPhone: draft.phone,
										...(keys.live ? { liveKey: keys.live } : {}),
										...(keys.test ? { testKey: keys.test } : {}),
									},
								}),
							);
							setKeys({ live: '', test: '' });
						});
					} catch (err) {
						setError((err as Error).message);
					}
				}}
			>
				<div className="field-list">
					<div className="field">
						<span>Activa</span>
						<GrantToggle
							on={draft.enabled}
							what="Cuby WhatsApp"
							label="Cuby WhatsApp activa"
							onChange={(on) => setDraft({ ...draft, enabled: on })}
						/>
					</div>
					<label className="field">
						<span>Modo</span>
						<OptionSelect
							label="Modo de Cuby WhatsApp"
							value={draft.mode}
							onValueChange={(m) => setDraft({ ...draft, mode: m as 'live' | 'test' })}
							options={[
								{ id: 'test', label: 'Prueba: no manda nada a WhatsApp' },
								{ id: 'live', label: 'Real' },
							]}
						/>
					</label>
					<label className="field">
						<span>Llave real</span>
						<Input
							type="password"
							value={keys.live}
							onChange={(e) => setKeys({ ...keys, live: e.target.value })}
							placeholder={v.liveKey ? `Guardada · termina en …${v.liveKey}` : 'cwk_live_…'}
							autoComplete="off"
						/>
					</label>
					<label className="field">
						<span>Llave de prueba</span>
						<Input
							type="password"
							value={keys.test}
							onChange={(e) => setKeys({ ...keys, test: e.target.value })}
							placeholder={v.testKey ? `Guardada · termina en …${v.testKey}` : 'cwk_test_…'}
							autoComplete="off"
						/>
					</label>
					<label className="field">
						<span>Número de la empresa (se muestra a las personas)</span>
						<PhoneInput
							value={draft.phone as PhoneValue}
							onChange={(p) => setDraft({ ...draft, phone: p ?? '' })}
							placeholder="Número"
							aria-label="Número de Cuby WhatsApp"
						/>
					</label>
					<label className="field">
						<span>Mensajes al día por persona</span>
						<Input
							type="number"
							min={1}
							max={500}
							value={draft.daily}
							onChange={(e) => setDraft({ ...draft, daily: e.target.valueAsNumber || 0 })}
							className="w-28"
						/>
					</label>
				</div>
				<p className="muted small mt-3" role="status">
					{!v.enabled
						? 'Apagada.'
						: v.status.connected
							? `Conectada · último aviso ${time(v.status.lastPollAt)} · lista sincronizada ${time(v.status.allowlistSyncedAt)} (${v.status.allowlistCount} teléfonos)`
							: `Sin conexión${v.status.lastError ? `: ${v.status.lastError}` : ''}`}
				</p>
				{error && (
					<p role="alert" className="error">
						{error}
					</p>
				)}
				<div className="field-actions row wrap mt-3">
					<SaveButton state={saving.state} />
				</div>
			</form>
		</section>
	);
}

type Link = {
	available: boolean;
	shownPhone: string;
	linked: string | null;
};

/** Configuración → WhatsApp: your own phone on the company number. */
export function CubyWhatsAppLink() {
	const [v, setV] = useState<Link | null>(null);
	const [phone, setPhone] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const act = async (method: 'POST' | 'DELETE', body?: unknown) => {
		setBusy(true);
		setError('');
		try {
			setV(await api<Link>('/whatsapp/cuby/link', { method, body }));
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	useEffect(() => {
		api<Link>('/whatsapp/cuby/link')
			.then(setV)
			.catch(() => {});
	}, []);
	if (!v?.available) return null;
	return (
		<section className="panel" aria-label="Tu teléfono en Cuby WhatsApp">
			<h2 className="inline-flex items-center gap-2">
				Tu teléfono en Cuby WhatsApp
				<InfoTip label="Para qué vincular tu teléfono">
					Con tu teléfono aquí, el número de la empresa te mete a tus grupos «Agentes …»: uno con tus agentes y uno por
					cada persona que te compartió alguno. Ahí hablas con ellos y te llegan sus avisos. Escribe tu propio número:
					un teléfono que ya es de otra persona se rechaza.
				</InfoTip>
			</h2>
			{v.linked ? (
				<div className="row wrap items-center gap-3">
					<span>
						Vinculado: <b className="font-medium">{formatPhone(v.linked)}</b>
					</span>
					<Button variant="danger-ghost" size="sm" disabled={busy} onClick={() => void act('DELETE')}>
						Quitar
					</Button>
				</div>
			) : (
				<form
					className="row wrap items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						void act('POST', { phone });
					}}
				>
					<PhoneInput
						className="w-60"
						value={phone as PhoneValue}
						onChange={(p) => setPhone(p ?? '')}
						placeholder="Tu número"
						aria-label="Tu número de teléfono"
					/>
					<Button type="submit" size="sm" disabled={busy || !phone}>
						Guardar
					</Button>
				</form>
			)}
			{error && (
				<p role="alert" className="error mt-2">
					{error}
				</p>
			)}
		</section>
	);
}
