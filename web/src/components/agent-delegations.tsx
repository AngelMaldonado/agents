// Encargos (#18): the conversations the agent delegated to its contacts. Configuración lists them, each leading
// to its trabajo's hub; there (DelegationDetail) one reads as a chat, like its WhatsApp, with what it gathered and
// how it ended. Its owner can stop an active one.
import { Fragment, useEffect, useRef, useState } from 'react';
import {
	ArrowLeft,
	ChevronRight,
	FileText,
	Flag,
	MessageSquare,
	MessagesSquare,
	Paperclip,
	Square,
	Table2,
	Target,
	type LucideIcon,
} from 'lucide-react';
import { useConfirm } from '@/components/confirm-dialog';
import { SlideStack } from '@/components/slide-stack';
import { openSimulator } from '@/components/whatsapp-simulator';
import { api, ago } from '@/api';
import { InfoTip } from '@/WhatsApp';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Status = 'active' | 'done' | 'expired' | 'cancelled' | 'failed';
type Item = {
	id: number;
	template: string;
	contact: string;
	status: Status;
	waiting: boolean;
	sent: number;
	tokens: number;
	created_at: string;
	ended_at: string | null;
	deadline: string;
	conversation_id: number | null;
	/** It went to a trabajo (not the Principal): it opens in that trabajo's hub. */
	job: boolean;
	/** Started with Conversaciones simuladas on: it talks with the simulator. */
	simulated: boolean;
};
type Field = { name: string; description: string; type: 'text' | 'number' | 'boolean' };
type Detail = Omit<Item, 'template'> & {
	/** The contact's phone (its chat in the simulator, when simulated). */
	phone: string;
	template: { name: string; objective: string; collect: { list: boolean; fields: Field[] }; maxMessages: number };
	params: Record<string, string>;
	context: string | null;
	data: unknown;
	summary: string | null;
	end_reason: string | null;
	messages: { role: 'contact' | 'delegate' | 'agent' | 'note'; text: string; files: string[] | null; at: string }[];
};

const STATUS: Record<Status, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
	active: { label: 'Activo', variant: 'default' },
	done: { label: 'Terminado', variant: 'secondary' },
	expired: { label: 'Vencido', variant: 'outline' },
	cancelled: { label: 'Cancelado', variant: 'outline' },
	failed: { label: 'Falló', variant: 'destructive' },
};
const when = (iso: string) => ago(new Date(iso).getTime());

export function AgentDelegations({
	agentId,
	conversationId,
	onOpenJob,
	onOpen,
}: {
	agentId: number;
	/** Only one trabajo's encargos (its hub), without the section's title. */
	conversationId?: number;
	/** Opens the trabajo's hub at this encargo (closing Configuración). */
	onOpenJob?: (conversationId: number, delegationId: number) => void;
	/** Opens one in place of the table (the trabajo's hub keeps it in its route). */
	onOpen?: (delegationId: number) => void;
}) {
	const [items, setItems] = useState<Item[] | null>(null);
	const [open, setOpen] = useState<number | null>(null);
	const [error, setError] = useState('');
	useEffect(() => {
		let gone = false;
		const load = () =>
			api<{ delegations: Item[] }>(
				`/agents/${agentId}/delegations${conversationId ? `?conversation=${conversationId}` : ''}`,
			)
				.then((r) => !gone && setItems(r.delegations))
				.catch((e) => !gone && setError((e as Error).message));
		void load();
		// While one is active its state changes on its own.
		const timer = setInterval(load, 10_000);
		return () => {
			gone = true;
			clearInterval(timer);
		};
	}, [agentId, conversationId]);
	const choose = (d: Item) =>
		onOpen
			? onOpen(d.id)
			: d.job && d.conversation_id && onOpenJob
				? onOpenJob(d.conversation_id, d.id)
				: setOpen(d.id);
	return (
		<SlideStack
			list={
				<section className={conversationId ? 'min-w-0' : 'panel min-w-0'} aria-label="Encargos">
					<h2 className={conversationId ? 'sr-only' : 'inline-flex items-center gap-2'}>
						Encargos
						<InfoTip label="Qué es un encargo">
							Una conversación por WhatsApp que el agente delega a la plataforma, con una plantilla de su contrato: la
							plataforma habla con el contacto por su cuenta, sin el nombre del agente ni mensajes de sistema, y le
							devuelve al agente lo que obtuvo. Las plantillas se agregan en Automejora; el contacto, en Canales → Quién
							le escribe por WhatsApp (contacto externo).
						</InfoTip>
					</h2>
					{error && (
						<p role="alert" className="error">
							{error}
						</p>
					)}
					{!items ? (
						!error && (
							<p role="status" className="muted">
								Cargando encargos…
							</p>
						)
					) : items.length ? (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Encargo</TableHead>
									<TableHead>Contacto</TableHead>
									<TableHead>Estado</TableHead>
									<TableHead className="text-right">Mensajes</TableHead>
									<TableHead className="text-right">Cuándo</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{items.map((d) => (
									<TableRow key={d.id} className="cursor-pointer" onClick={() => choose(d)}>
										<TableCell>
											<button type="button" className="font-medium underline-offset-4 hover:underline">
												#{d.id} · {d.template}
											</button>
										</TableCell>
										<TableCell>{d.contact}</TableCell>
										<TableCell>
											<Badge variant={STATUS[d.status].variant}>{STATUS[d.status].label}</Badge>
											{d.waiting && <span className="muted small"> · espera al agente</span>}
										</TableCell>
										<TableCell className="text-right tabular-nums">{d.sent}</TableCell>
										<TableCell className="muted small text-right">{when(d.created_at)}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					) : (
						<p className="muted">
							{conversationId
								? 'En este trabajo no ha lanzado encargos.'
								: 'Este agente no ha lanzado encargos. Para que pueda, pídele en Automejora una plantilla de encargo (por ejemplo, «cotizar con la carnicería») y enciende al contacto en Canales.'}
						</p>
					)}
				</section>
			}
			detail={open ? <DelegationDetail key={open} agentId={agentId} id={open} onBack={() => setOpen(null)} /> : null}
		/>
	);
}

type Message = Detail['messages'][number];
const initials = (name: string) =>
	name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0]!.toUpperCase())
		.join('') || '?';
const time = (iso: string) => new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => {
	const d = new Date(iso),
		today = new Date();
	const yesterday = new Date(today);
	yesterday.setDate(today.getDate() - 1);
	if (d.toDateString() === today.toDateString()) return 'Hoy';
	if (d.toDateString() === yesterday.toDateString()) return 'Ayer';
	return d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
};

/**
 * One encargo as a chat, like its WhatsApp: what the encargo wrote (for the agent) on the right, the contact on
 * the left, the agent's instructions and the platform's notes in the middle; what it gathered, its context
 * and how it ended around it.
 */
export function DelegationDetail({ agentId, id, onBack }: { agentId: number; id: number; onBack?: () => void }) {
	const [d, setD] = useState<Detail | null>(null);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const thread = useRef<HTMLDivElement>(null);
	// The part open: it slides in over the list of parts.
	const [part, setPart] = useState<Part | null>(null);
	const [ask, confirmDialog] = useConfirm();
	useEffect(() => {
		let gone = false;
		const load = () =>
			api<{ delegation: Detail }>(`/agents/${agentId}/delegations/${id}`)
				.then((r) => !gone && setD(r.delegation))
				.catch((e) => !gone && setError((e as Error).message));
		void load();
		const timer = setInterval(load, 5_000);
		return () => {
			gone = true;
			clearInterval(timer);
		};
	}, [agentId, id]);
	// Its latest message in view, as a chat opens (and as new ones arrive).
	const count = d?.messages.length ?? 0;
	useEffect(() => {
		thread.current?.scrollTo({ top: thread.current.scrollHeight });
	}, [count, part]);
	const stop = async () => {
		if (
			!(await ask({
				title: '¿Detener este encargo?',
				description: 'El contacto no recibe ningún mensaje; el agente recibe lo que llevaba.',
				action: 'Detener',
				destructive: true,
			}))
		)
			return;
		setBusy(true);
		setError('');
		try {
			setD(
				(await api<{ delegation: Detail }>(`/agents/${agentId}/delegations/${id}/stop`, { method: 'POST' })).delegation,
			);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	if (!d)
		return (
			<section className="encargo" aria-label={`Encargo ${id}`}>
				{onBack && (
					<Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
						<ArrowLeft aria-hidden="true" />
						Encargos
					</Button>
				)}
				<p role={error ? 'alert' : 'status'} className={error ? 'error' : 'muted small'}>
					{error || 'Cargando…'}
				</p>
			</section>
		);
	return (
		<section className="encargo" aria-label={`Encargo ${d.id} con ${d.contact}`}>
			<header className="encargo-head">
				{onBack && (
					<Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Volver a los encargos">
						<ArrowLeft aria-hidden="true" />
					</Button>
				)}
				<span className="encargo-avatar" aria-hidden="true">
					{initials(d.contact)}
				</span>
				<div className="min-w-0 flex-1">
					<p className="encargo-name">
						{d.contact}
						<Badge variant={STATUS[d.status].variant}>{STATUS[d.status].label}</Badge>
						{d.simulated && <Badge variant="warning">Simulación</Badge>}
					</p>
					<p className="encargo-sub">
						Encargo #{d.id} · {d.template.name} · {d.sent} de {d.template.maxMessages} mensajes ·{' '}
						{d.status === 'active'
							? `vence ${new Date(d.deadline).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })}`
							: `${d.end_reason ?? 'terminó'}${d.ended_at ? `, ${when(d.ended_at)}` : ''}`}
					</p>
				</div>
				{d.simulated && d.status === 'active' && (
					<Button variant="outline" size="sm" onClick={() => openSimulator(agentId, `e:${d.phone}`)}>
						<MessagesSquare aria-hidden="true" />
						Responder como {d.contact}
					</Button>
				)}
				{d.status === 'active' && (
					<Button variant="danger-ghost" size="sm" disabled={busy} onClick={() => void stop()}>
						<Square aria-hidden="true" />
						Detener
					</Button>
				)}
			</header>
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
			<SlideStack
				list={
					<ul className="encargo-parts" aria-label="Del encargo">
						{parts(d).map((x) => (
							<li key={x.key}>
								<button type="button" className="job-hub-conv" onClick={() => setPart(x.key)}>
									<x.icon className="job-hub-conv-icon" aria-hidden="true" />
									<span className="min-w-0 flex-1">
										<span className="job-hub-conv-title">{x.title}</span>
										<span className="job-hub-conv-sub">{x.preview}</span>
									</span>
									<ChevronRight className="job-eval-arrow" aria-hidden="true" />
								</button>
							</li>
						))}
					</ul>
				}
				detail={
					part ? (
						<div className="encargo-part">
							<div className="encargo-part-head">
								<Button variant="ghost" size="sm" onClick={() => setPart(null)}>
									<ArrowLeft aria-hidden="true" />
									{d.contact}
								</Button>
								<h3 className="text-sm font-medium">{PART_TITLE[part]}</h3>
							</div>
							{part === 'chat' && (
								<div ref={thread} className="encargo-thread" aria-label="Conversación">
									{d.messages.length ? (
										d.messages.map((m, i) => {
											const prev = d.messages[i - 1];
											return (
												<Fragment key={i}>
													{(!prev || day(prev.at) !== day(m.at)) && (
														<p className="encargo-day">
															<span>{day(m.at)}</span>
														</p>
													)}
													<EncargoMessage
														m={m}
														contact={d.contact}
														grouped={!!prev && prev.role === m.role && day(prev.at) === day(m.at)}
													/>
												</Fragment>
											);
										})
									) : (
										<p className="encargo-note">
											Todavía no escribe{d.status === 'active' ? ' (fuera de 7:00 a 22:00 espera a la mañana)' : ''}.
										</p>
									)}
								</div>
							)}
							{part === 'data' && <Data template={d.template} data={d.data} />}
							{part === 'objective' && <p className="encargo-text">{objective(d)}</p>}
							{part === 'context' && <p className="encargo-text">{d.context}</p>}
							{part === 'summary' && <p className="encargo-text">{d.summary}</p>}
						</div>
					) : null
				}
			/>
			{confirmDialog}
		</section>
	);
}

type Part = 'chat' | 'data' | 'objective' | 'context' | 'summary';
const PART_TITLE: Record<Part, string> = {
	chat: 'Conversación',
	data: 'Datos obtenidos',
	objective: 'Objetivo',
	context: 'Contexto que le dio el agente',
	summary: 'Cómo terminó',
};
/** Its template's objective, with its parameters in place. */
const objective = (d: Detail) => d.template.objective.replace(/\{(\w+)\}/g, (all, k: string) => d.params[k] ?? all);
const show1 = (v: unknown) =>
	v === null || v === undefined ? '—' : typeof v === 'boolean' ? (v ? 'Sí' : 'No') : String(v);

/** The encargo's parts as quick accesses: each with one line of what it holds. */
function parts(d: Detail): { key: Part; title: string; preview: string; icon: LucideIcon }[] {
	const last = d.messages.filter((m) => m.role === 'contact' || m.role === 'delegate').at(-1);
	const rows = (Array.isArray(d.data) ? d.data : d.data ? [d.data] : []) as Record<string, unknown>[];
	return [
		{
			key: 'chat',
			title: 'Conversación',
			icon: MessageSquare,
			preview: last
				? `${d.messages.length} ${d.messages.length === 1 ? 'mensaje' : 'mensajes'} · ${last.role === 'contact' ? d.contact : 'Encargo'}: ${last.text}`
				: 'Todavía no escribe',
		},
		{
			key: 'data',
			title: 'Datos obtenidos',
			icon: Table2,
			preview: rows.length
				? rows.length > 1
					? `${rows.length} filas`
					: d.template.collect.fields
							.slice(0, 3)
							.map((f) => `${f.name}: ${show1(rows[0]?.[f.name])}`)
							.join(' · ')
				: 'Todavía nada',
		},
		{ key: 'objective', title: 'Objetivo', icon: Target, preview: objective(d) },
		...(d.context
			? [{ key: 'context' as const, title: 'Contexto que le dio el agente', icon: FileText, preview: d.context }]
			: []),
		...(d.summary && d.status !== 'active'
			? [{ key: 'summary' as const, title: 'Cómo terminó', icon: Flag, preview: d.summary }]
			: []),
	];
}

/** One line of the encargo's WhatsApp. */
function EncargoMessage({ m, contact, grouped }: { m: Message; contact: string; grouped: boolean }) {
	if (m.role === 'agent' || m.role === 'note')
		return (
			<p className={m.role === 'agent' ? 'encargo-instruction' : 'encargo-note'}>
				{m.role === 'agent' && <span className="font-medium">Instrucción del agente · </span>}
				<span className="break-words whitespace-pre-wrap">{m.text}</span>
				<span className="encargo-time"> · {time(m.at)}</span>
			</p>
		);
	const mine = m.role === 'delegate';
	return (
		<div className={`encargo-row ${mine ? 'is-ours' : 'is-theirs'} ${grouped ? 'is-grouped' : ''}`}>
			{!mine && (
				<span className="encargo-avatar is-small" aria-hidden="true">
					{grouped ? '' : initials(contact)}
				</span>
			)}
			<div className="encargo-bubble">
				{!grouped && <p className="encargo-author">{mine ? 'Encargo (por el agente)' : contact}</p>}
				<p className="break-words whitespace-pre-wrap">{m.text}</p>
				{m.files?.length ? (
					<p className="encargo-files">
						<Paperclip aria-hidden="true" />
						{m.files.join(', ')}
					</p>
				) : null}
				<p className="encargo-time" title={new Date(m.at).toLocaleString('es-MX')}>
					{time(m.at)}
				</p>
			</div>
		</div>
	);
}

/** What it gathered, in the template's fields: a table of rows, or one record. */
function Data({ template, data }: { template: Detail['template']; data: unknown }) {
	const fields = template.collect.fields;
	const rows = (Array.isArray(data) ? data : data ? [data] : []) as Record<string, unknown>[];
	const show = (v: unknown) =>
		v === null || v === undefined ? '—' : typeof v === 'boolean' ? (v ? 'Sí' : 'No') : String(v);
	return (
		<div className="grid min-w-0 gap-2" aria-label="Datos obtenidos">
			<h3 className="sr-only">Datos obtenidos</h3>
			{rows.length ? (
				<Table>
					<TableHeader>
						<TableRow>
							{fields.map((f) => (
								<TableHead key={f.name} title={f.description}>
									{f.name}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((r, i) => (
							<TableRow key={i}>
								{fields.map((f) => (
									<TableCell key={f.name} className={f.type === 'number' ? 'tabular-nums' : ''}>
										{show(r?.[f.name])}
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			) : (
				<p className="muted small">Todavía nada.</p>
			)}
		</div>
	);
}
