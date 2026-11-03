// Configuración → WhatsApp (#18): the WhatsApp numbers this person sees. Anyone links their own by QR; an
// admin also offers public numbers (with an alias, anyone may pick them for their agents) and private
// ones (admins only). Whoever manages a number keeps who may write to it: an allow list (attended; each
// phone may be a person of Agents) and a block list (refused). Any other phone is ignored.
import { useEffect, useState, type ReactNode } from 'react';
import { Check, Info, LoaderCircle, Plus, Smartphone, Trash2 } from 'lucide-react';
import type { Value as PhoneValue } from 'react-phone-number-input';
import { api, type Person } from './api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { OptionSelect } from '@/components/option-select';
import { PhoneInput } from '@/components/ui/phone-input';
import { CubyWhatsAppLink } from '@/components/cuby-whatsapp';
import { WhatsAppGroupPhoto } from '@/components/whatsapp-group-photo';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FormDialog, GrantToggle } from '@/components/access-ui';
import { SaveButton, useSaving } from '@/components/actions';

export type Scope = 'personal' | 'public' | 'private';
export type WhatsAppNumber = {
	id: number;
	owner_id: number;
	owner_name: string;
	scope: Scope;
	alias: string;
	phone: string | null;
	name: string;
	state: 'connected' | 'connecting' | 'down' | 'pairing' | 'linked' | 'unlinked' | 'failed';
	mine: boolean;
	manage: boolean;
	label: string;
	/** 'cuby': the company number (cuby-whatsapp), turned on and off in Administración. */
	provider: 'bridge' | 'cuby';
	/** It hosts everyone's groups «Agentes <owner>» (an admin picks it; else the company number). */
	groups: boolean;
};
type Numbers = { available: boolean; bridge: 'off' | 'up' | 'down'; numbers: WhatsAppNumber[] };
type Pairing = { state: 'pairing' | 'linked' | 'failed' | 'unlinked'; qr?: string | null; error?: string };
type Entry = {
	phone: string;
	label: string;
	personId: number | null;
	personName?: string | null;
	/** A guest the agents write to one to one (a supplier), never in a group. */
	supplier?: boolean;
};
type Lists = { allow: Entry[]; block: Entry[]; people: { id: number; name: string }[] };

export const SCOPE_LABEL: Record<Scope, string> = { personal: 'Personal', public: 'Público', private: 'Privado' };
export const STATE_LABEL: Record<WhatsAppNumber['state'], string> = {
	connected: 'Conectado',
	connecting: 'Conectando…',
	down: 'Sin respuesta del puente',
	pairing: 'Vinculando',
	linked: 'Vinculado',
	unlinked: 'Desvinculado',
	failed: 'Falló',
};
export const formatPhone = (p: string | null) => (p ? `+${p}` : '');

/** An (i) that shows an explanation on hover or focus. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					className="inline-flex shrink-0 rounded-full align-middle text-muted-foreground hover:text-foreground"
					aria-label={label}
				>
					<Info className="size-4" aria-hidden="true" />
				</button>
			</TooltipTrigger>
			<TooltipContent side="top" className="max-w-sm text-pretty">
				{children}
			</TooltipContent>
		</Tooltip>
	);
}

export function WhatsAppSettings({ me }: { me: Person }) {
	const [nums, setNums] = useState<Numbers | null>(null);
	const [error, setError] = useState('');
	const [adding, setAdding] = useState(false);
	const load = () =>
		api<Numbers>('/whatsapp/numbers')
			.then((v) => {
				setNums(v);
				setError('');
			})
			.catch((e) => setError((e as Error).message));
	useEffect(() => {
		void load();
	}, [me.admin]);
	return (
		<>
			<section className="panel" aria-label="Números de WhatsApp">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h2 className="inline-flex items-center gap-2">
						Números de WhatsApp
						<InfoTip label="Cómo funcionan los números de WhatsApp">
							Vincula un número escaneando un código QR desde WhatsApp o WhatsApp Business, como WhatsApp Web, y elige
							en los Canales de cada agente por cuál número habla. En «Editar» decides quién puede escribirle: la lista
							blanca se atiende y la negra se rechaza; cualquier otro número se ignora. El número sólo contesta, nunca
							escribe primero. Usa un número dedicado: es una conexión no oficial y WhatsApp puede bloquear números que
							detecte como automatizados.
						</InfoTip>
					</h2>
					<Button size="sm" onClick={() => setAdding(true)} disabled={!nums || nums.bridge === 'off'}>
						<Plus aria-hidden="true" />
						Agregar número
					</Button>
				</div>
				{error && (
					<p role="alert" className="error">
						{error}
					</p>
				)}
				{nums && !nums.available && <p className="muted">Este servidor no tiene el puente de WhatsApp configurado.</p>}
				{nums?.bridge === 'down' && (
					<p role="alert" className="error">
						El puente de WhatsApp no responde: los números no reciben ni envían mensajes hasta que vuelva.
					</p>
				)}
				{nums && <NumbersTable me={me} list={nums.numbers} onChanged={setNums} onError={setError} />}
				<AddNumber
					open={adding}
					admin={me.admin}
					onClose={() => {
						setAdding(false);
						void load();
					}}
				/>
			</section>
			<CubyWhatsAppLink />
			<WhatsAppGroupPhoto />
		</>
	);
}

function NumbersTable({
	me,
	list,
	onChanged,
	onError,
}: {
	me: Person;
	list: WhatsAppNumber[];
	onChanged: (v: Numbers) => void;
	onError: (msg: string) => void;
}) {
	const [editing, setEditing] = useState<WhatsAppNumber | null>(null);
	const remove = async (n: WhatsAppNumber) => {
		if (
			!confirm(
				`¿Quitar ${n.label}? Se desvincula de Agents y de los dispositivos vinculados del teléfono; los agentes que lo usan se quedan sin WhatsApp.`,
			)
		)
			return;
		try {
			onChanged(await api<Numbers>(`/whatsapp/numbers/${n.id}`, { method: 'DELETE' }));
		} catch (e) {
			onError((e as Error).message);
		}
	};
	return (
		<>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Número</TableHead>
						<TableHead>Tipo</TableHead>
						<TableHead>Estado</TableHead>
						<TableHead className="text-right">Acciones</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{list.map((n) => (
						<TableRow key={n.id}>
							<TableCell>
								<div className="font-medium">{n.label}</div>
								<div className="text-xs text-muted-foreground">
									{[formatPhone(n.phone), n.alias && n.name ? n.name : '', n.mine ? '' : `de ${n.owner_name}`]
										.filter(Boolean)
										.join(' · ')}
								</div>
							</TableCell>
							<TableCell>
								<Badge variant={n.scope === 'personal' ? 'secondary' : 'outline'}>{SCOPE_LABEL[n.scope]}</Badge>
								{n.groups && <Badge variant="secondary">Grupos</Badge>}
							</TableCell>
							<TableCell className="text-sm">
								<span className="inline-flex items-center gap-1.5">
									<span
										aria-hidden="true"
										className={`size-1.5 rounded-full ${n.state === 'connected' ? 'bg-success' : n.state === 'connecting' ? 'bg-warning' : 'bg-muted-foreground/50'}`}
									/>
									{STATE_LABEL[n.state]}
								</span>
							</TableCell>
							<TableCell className="text-right whitespace-nowrap">
								{n.manage && (
									<>
										<Button variant="ghost" size="sm" onClick={() => setEditing(n)}>
											Editar
										</Button>
										{n.provider !== 'cuby' && (
											<Button
												variant="danger-ghost"
												size="icon-sm"
												aria-label={`Quitar ${n.label}`}
												title="Quitar"
												onClick={() => void remove(n)}
											>
												<Trash2 aria-hidden="true" />
											</Button>
										)}
									</>
								)}
							</TableCell>
						</TableRow>
					))}
					{!list.length && (
						<TableRow>
							<TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
								Todavía no hay números. Agrega el tuyo{me.admin ? ' u ofrece uno público' : ''}.
							</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>
			<EditNumber
				number={editing}
				admin={me.admin}
				onClose={() => setEditing(null)}
				onSaved={(v) => {
					setEditing(null);
					onChanged(v);
				}}
			/>
		</>
	);
}

function ScopeFields({
	admin,
	scope,
	alias,
	setScope,
	setAlias,
}: {
	admin: boolean;
	scope: Scope;
	alias: string;
	setScope: (s: Scope) => void;
	setAlias: (s: string) => void;
}) {
	return (
		<>
			{admin && (
				<div className="grid gap-1">
					<span>Quién lo ve</span>
					<OptionSelect
						label="Quién lo ve"
						value={scope}
						onValueChange={(v) => setScope(v as Scope)}
						options={[
							{ id: 'personal', label: 'Personal: sólo tú, para tus agentes' },
							{ id: 'public', label: 'Público: cualquiera lo elige para sus agentes' },
							{ id: 'private', label: 'Privado: sólo los admins' },
						]}
					/>
				</div>
			)}
			<label>
				Alias{scope === 'public' ? '' : ' (opcional)'}
				<Input
					value={alias}
					onChange={(e) => setAlias(e.target.value)}
					maxLength={60}
					placeholder={scope === 'public' ? 'Así lo verán los demás, p. ej. «Compras Cuby»' : 'Cómo lo reconoces'}
				/>
			</label>
		</>
	);
}

function AddNumber({ open, admin, onClose }: { open: boolean; admin: boolean; onClose: () => void }) {
	const [scope, setScope] = useState<Scope>('personal');
	const [alias, setAlias] = useState('');
	const [id, setId] = useState<number | null>(null);
	const [p, setP] = useState<Pairing | null>(null);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (!open) {
			setScope('personal');
			setAlias('');
			setId(null);
			setP(null);
			setError('');
		}
	}, [open]);
	// While pairing the code changes every ~20 s: ask for it every 2 s until it links or fails.
	useEffect(() => {
		if (id === null || p?.state !== 'pairing') return;
		const t = setInterval(() => {
			api<Pairing>(`/whatsapp/numbers/${id}/pairing`)
				.then(setP)
				.catch((e) => setError((e as Error).message));
		}, 2000);
		return () => clearInterval(t);
	}, [id, p?.state]);
	const start = async () => {
		setBusy(true);
		setError('');
		try {
			const r = await api<Pairing & { id: number }>('/whatsapp/numbers', { method: 'POST', body: { scope, alias } });
			setId(r.id);
			setP(r);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	// Closing before the phone scans the code cancels the pairing (its row and the bridge's QR).
	const close = () => {
		if (id !== null && p?.state === 'pairing')
			void api(`/whatsapp/numbers/${id}`, { method: 'DELETE' }).catch(() => {});
		onClose();
	};
	return (
		<FormDialog
			open={open}
			onOpenChange={(o) => !o && close()}
			title="Agregar número de WhatsApp"
			description="En el teléfono de ese número: WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo, y escanea el código."
		>
			<div className="form">
				{!p && <ScopeFields admin={admin} scope={scope} alias={alias} setScope={setScope} setAlias={setAlias} />}
				{p?.state === 'pairing' &&
					(p.qr ? (
						<img
							src={`data:image/png;base64,${p.qr}`}
							alt="Código QR para vincular WhatsApp"
							width={240}
							height={240}
							className="justify-self-center rounded-md bg-white p-2"
						/>
					) : (
						<p role="status" className="muted inline-flex items-center gap-2">
							<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
							Preparando el código…
						</p>
					))}
				{p?.state === 'linked' && (
					<p role="status" className="inline-flex items-center gap-2 text-success">
						<Check className="size-4" aria-hidden="true" />
						Número vinculado. En «Editar» agrega quién puede escribirle y elígelo en los Canales de tus agentes.
					</p>
				)}
				{(error || p?.error) && (
					<p role="alert" className="error">
						{error || p?.error}
					</p>
				)}
				<div className="flex flex-wrap justify-end gap-2 border-t pt-4">
					<Button type="button" variant="outline" onClick={close}>
						{p?.state === 'linked' ? 'Listo' : 'Cancelar'}
					</Button>
					{(!p || p.state === 'failed') && (
						<Button type="button" disabled={busy} onClick={() => void start()}>
							<Smartphone aria-hidden="true" />
							{p?.state === 'failed' ? 'Intentar otra vez' : 'Mostrar código QR'}
						</Button>
					)}
				</div>
			</div>
		</FormDialog>
	);
}

const e164 = (digits: string) => (digits ? `+${digits}` : '');

/** Edit a number: its alias (and who sees it, for an admin) and who may write to it. */
function EditNumber({
	number,
	admin,
	onClose,
	onSaved,
}: {
	number: WhatsAppNumber | null;
	admin: boolean;
	onClose: () => void;
	onSaved: (v: Numbers) => void;
}) {
	const [scope, setScope] = useState<Scope>('personal');
	const [alias, setAlias] = useState('');
	const [groups, setGroups] = useState(false);
	const [lists, setLists] = useState<Lists | null>(null);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const saving = useSaving();
	useEffect(() => {
		setScope(number?.scope ?? 'personal');
		setAlias(number?.alias ?? '');
		setGroups(!!number?.groups);
		setError('');
		setLists(null);
		if (!number) return;
		api<Lists>(`/whatsapp/numbers/${number.id}/lists`)
			.then((l) =>
				setLists({
					...l,
					allow: l.allow.map((e) => ({ ...e, phone: e164(e.phone) })),
					block: l.block.map((e) => ({ ...e, personId: null, phone: e164(e.phone) })),
				}),
			)
			.catch((e) => setError((e as Error).message));
	}, [number]);
	const edit = (list: 'allow' | 'block', i: number, patch: Partial<Entry>) =>
		setLists((l) => l && { ...l, [list]: l[list].map((e, j) => (j === i ? { ...e, ...patch } : e)) });
	const add = (list: 'allow' | 'block') =>
		setLists((l) => l && { ...l, [list]: [...l[list], { phone: '', label: '', personId: null }] });
	const drop = (list: 'allow' | 'block', i: number) =>
		setLists((l) => l && { ...l, [list]: l[list].filter((_, j) => j !== i) });
	const section = (list: 'allow' | 'block', l: Lists) => (
		<fieldset className="grid gap-2">
			<legend className="mb-1 inline-flex items-center gap-2 text-sm font-medium">
				{list === 'allow' ? 'Lista blanca' : 'Lista negra'}
				<InfoTip label={list === 'allow' ? 'Qué es la lista blanca' : 'Qué es la lista negra'}>
					{list === 'allow'
						? 'Sus mensajes se atienden. Si el número es de una persona de Agents, habla con sus agentes y con los que le comparten en este número, y la tarea queda a su nombre; si no, es un invitado: tiene su grupo con los agentes que su dueño le encienda. Un proveedor nunca tiene grupo: los agentes que lo tengan encendido le escriben uno a uno (por ejemplo, para cotizar) y su respuesta vuelve al agente que le preguntó.'
						: 'Sus mensajes se rechazan sin respuesta. Útil para bloquear a alguien sin perder quién era.'}
				</InfoTip>
			</legend>
			{l[list].map((e, i) => (
				<div key={i} className="flex items-center gap-2">
					<PhoneInput
						className="w-52 shrink-0"
						value={e.phone as PhoneValue}
						onChange={(v) => edit(list, i, { phone: v })}
						placeholder="Número"
						aria-label="Número de teléfono"
					/>
					{list === 'allow' && (
						<OptionSelect
							className="w-32 shrink-0"
							label="Quién es"
							value={e.personId ? String(e.personId) : e.supplier ? 'supplier' : 'guest'}
							onValueChange={(v) =>
								edit(
									list,
									i,
									v === 'guest' || v === 'supplier'
										? { personId: null, supplier: v === 'supplier' }
										: { personId: Number(v), supplier: false },
								)
							}
							options={[
								{ id: 'guest', label: 'Invitado' },
								{ id: 'supplier', label: 'Proveedor' },
								...l.people.map((p) => ({ id: String(p.id), label: p.name })),
							]}
						/>
					)}
					<Input
						className="min-w-0 flex-1"
						aria-label="Nombre"
						value={e.label}
						onChange={(ev) => edit(list, i, { label: ev.target.value })}
						placeholder="Nombre (opcional)"
						maxLength={60}
					/>
					<Button
						variant="danger-ghost"
						size="icon-sm"
						type="button"
						aria-label="Quitar de la lista"
						title="Quitar"
						onClick={() => drop(list, i)}
					>
						<Trash2 aria-hidden="true" />
					</Button>
				</div>
			))}
			{!l[list].length && (
				<p className="muted small">{list === 'allow' ? 'Nadie puede escribirle todavía.' : 'Nadie bloqueado.'}</p>
			)}
			<Button variant="outline" size="sm" type="button" className="justify-self-start" onClick={() => add(list)}>
				<Plus aria-hidden="true" />
				Agregar número
			</Button>
		</fieldset>
	);
	return (
		<FormDialog open={!!number} onOpenChange={(o) => !o && !busy && onClose()} title={`Editar ${number?.label ?? ''}`}>
			<form
				className="form"
				onSubmit={async (ev) => {
					ev.preventDefault();
					if (!number || !lists) return;
					setBusy(true);
					setError('');
					try {
						const keep = (e: Entry) => ({
							phone: e.phone,
							label: e.label,
							personId: e.personId,
							supplier: !!e.supplier,
						});
						const saved = await saving.run(
							async () => {
								await api(`/whatsapp/numbers/${number.id}/lists`, {
									method: 'PUT',
									body: {
										allow: lists.allow.filter((e) => e.phone).map(keep),
										block: lists.block.filter((e) => e.phone).map(keep),
									},
								});
								return api<Numbers>(`/whatsapp/numbers/${number.id}`, {
									method: 'PATCH',
									body: admin && number.scope !== 'personal' ? { scope, alias, groups } : { alias },
								});
							},
							{ hold: true },
						);
						onSaved(saved);
					} catch (err) {
						setError((err as Error).message);
					} finally {
						setBusy(false);
					}
				}}
			>
				<ScopeFields
					admin={admin && number?.scope !== 'personal'}
					scope={scope}
					alias={alias}
					setScope={setScope}
					setAlias={setAlias}
				/>
				{admin && number && number.scope !== 'personal' && (
					<div className="flex items-center gap-2 text-sm">
						<GrantToggle
							on={groups}
							what="Aloja los grupos de agentes"
							label="Aloja los grupos de agentes"
							onChange={setGroups}
						/>
						<span className="inline-flex items-center gap-1">
							Aloja los grupos de agentes
							<InfoTip label="Qué son los grupos de agentes">
								Este número crea un grupo «Agentes &lt;dueño&gt;» con cada teléfono de su lista blanca que tenga agentes
								con quién hablar: los suyos, los que le compartieron o los que su dueño le encendió. Ahí habla con ellos
								y recibe sus avisos. Sólo un número los aloja; si ninguno está marcado, lo hace Cuby WhatsApp.
							</InfoTip>
						</span>
					</div>
				)}
				{lists ? (
					<>
						{section('allow', lists)}
						{section('block', lists)}
					</>
				) : (
					!error && (
						<p role="status" className="muted inline-flex items-center gap-2">
							<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
							Cargando quién puede escribirle…
						</p>
					)
				)}
				{error && (
					<p role="alert" className="error">
						{error}
					</p>
				)}
				<div className="flex flex-wrap justify-end gap-2 border-t pt-4">
					<Button type="button" variant="outline" onClick={onClose} disabled={busy}>
						Cancelar
					</Button>
					<SaveButton type="submit" state={saving.state} disabled={busy || !lists} />
				</div>
			</form>
		</FormDialog>
	);
}
