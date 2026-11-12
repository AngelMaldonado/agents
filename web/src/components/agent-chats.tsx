// Conversaciones (Angel 11-nov-2026): the agent's WhatsApp chats with people, as WhatsApp shows them: its chats
// on the left (the latest first, searchable), the one open on the right, the agent's lines on the right side.
// Real chats are read-only; in a simulated one its owner writes as the contact, or lets the AI answer for them.
// Pinned on top, the conversation with the agent itself: its Principal (all of its chats) or the trabajo's own (a
// trabajo's chats); opened (#/agent/:id/chat/:c), the chat with the agent and its turn take the right side.
// #/agent/:id/whatsapp[/<chat>] has all of them; #/agent/:id/job/:trabajo/conversaciones[/<chat>], a trabajo's.
import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
	ArrowLeft,
	CheckCheck,
	FlaskConical,
	Handshake,
	History,
	LoaderCircle,
	MessagesSquare,
	Crown,
	Pin,
	Search,
	Send,
	Sparkles,
	UserPen,
} from 'lucide-react';
import { api } from '@/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ChannelBadge } from '@/components/channel-icon';
import { OptionSelect } from '@/components/option-select';
import { initials, useSimChats } from '@/components/whatsapp-simulator';

type ChatRow = {
	id: string;
	kind: 'group' | 'direct' | 'external';
	role: 'owner' | 'person' | 'guest' | 'direct' | 'external';
	name: string;
	shown: string;
	simulated: boolean;
	count: number;
	last: { direction: 'in' | 'out'; author: string; text: string; at: number; actor: boolean } | null;
	encargos: number;
	active: boolean;
};
type Line = {
	id: number;
	direction: 'in' | 'out';
	author: string;
	text: string;
	files: string[] | null;
	conversation_id: number | null;
	delegation_id: number | null;
	actor: boolean;
	backfilled: boolean;
	at: number;
};

const ROLE: Record<ChatRow['role'], string> = {
	owner: 'Tú · tu grupo',
	person: 'Con quien lo compartiste · su grupo',
	guest: 'Invitado · su grupo',
	direct: 'Invitado directo',
	external: 'Contacto externo',
};
const BACKFILL =
	'Antes de este punto el historial se reconstruyó: lo que escribieron las personas y sus encargos están completos; de lo que el agente dijo en los grupos sólo quedaron sus primeras líneas, y lo que les mandó uno a uno no se guardaba.';

/** «14:05» today, «ayer», the weekday this week, else the date: as WhatsApp's list. */
function when(ms: number) {
	const d = new Date(ms),
		now = new Date();
	const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
	if (days <= 0) return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
	if (days === 1) return 'ayer';
	if (days < 7) return d.toLocaleDateString('es-MX', { weekday: 'short' });
	return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}
const time = (ms: number) => new Date(ms).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
const fold = (s: string) =>
	s
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase();

export function AgentChats({
	agentId,
	agentName,
	conversationId,
	chat,
	onChat,
	pinned,
	pinnedOpen = false,
	children,
}: {
	agentId: number;
	agentName: string;
	/** Only this trabajo's chats (and, in each, its lines unless «todo el chat»). */
	conversationId?: number;
	chat?: string;
	onChat: (chat: string | null) => void;
	/** The conversation with the agent, pinned on top: its Principal, or the trabajo's. */
	pinned?: { href: string; title: string; sub: string; principal: boolean; live?: boolean; origin?: string | null };
	/** It is the one open: `children` (its chat and turn) take the right side. */
	pinnedOpen?: boolean;
	children?: ReactNode;
}) {
	const [chats, setChats] = useState<ChatRow[] | null>(null);
	const [trabajos, setTrabajos] = useState<{ id: number; title: string; status: string }[]>([]);
	// In all of its chats, one trabajo picked (a trabajo's page has its own).
	const [picked, setPicked] = useState<number | null>(null);
	const trabajo = conversationId ?? picked ?? undefined;
	const [error, setError] = useState('');
	const [query, setQuery] = useState('');
	const [filter, setFilter] = useState<'all' | 'real' | 'sim'>('all');
	useEffect(() => {
		let gone = false;
		const load = () =>
			api<{ chats: ChatRow[]; trabajos: { id: number; title: string; status: string }[] }>(
				`/agents/${agentId}/chats${trabajo ? `?conversation=${trabajo}` : ''}`,
			)
				.then((r) => {
					if (gone) return;
					setChats(r.chats);
					setTrabajos(r.trabajos);
					setError('');
				})
				.catch((e) => !gone && setError((e as Error).message));
		void load();
		const timer = setInterval(load, 5_000);
		return () => {
			gone = true;
			clearInterval(timer);
		};
	}, [agentId, trabajo]);
	const anySim = !!chats?.some((c) => c.simulated);
	const shown = useMemo(() => {
		const q = fold(query.trim());
		return (chats ?? []).filter(
			(c) =>
				(filter === 'all' || (filter === 'sim') === c.simulated) &&
				(!q || fold(`${c.name} ${c.last?.text ?? ''}`).includes(q)),
		);
	}, [chats, query, filter]);
	const open = pinnedOpen ? null : (chats?.find((c) => c.id === chat) ?? null);
	return (
		<div className="chats" data-open={open || pinnedOpen ? '' : undefined}>
			<aside className="chats-list" aria-label="Chats">
				<div className="chats-list-head">
					<div className="relative">
						<Search className="chats-search-icon" aria-hidden="true" />
						<Input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Buscar un chat o mensaje"
							aria-label="Buscar un chat o mensaje"
							className="pl-8"
						/>
					</div>
					{!conversationId && trabajos.length > 0 && (
						<OptionSelect
							label="Trabajo"
							value={picked ? String(picked) : 'all'}
							onValueChange={(v) => {
								setChats(null);
								setPicked(v === 'all' ? null : Number(v));
							}}
							options={[
								{ id: 'all', label: 'Todos los trabajos' },
								...trabajos.map((t) => ({
									id: String(t.id),
									label: `#${t.id} · ${t.title}${t.status === 'open' ? '' : ' (terminado)'}`,
								})),
							]}
						/>
					)}
					{anySim && (
						<Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
							<TabsList aria-label="Qué chats" className="w-full">
								<TabsTrigger value="all">Todos</TabsTrigger>
								<TabsTrigger value="real">Reales</TabsTrigger>
								<TabsTrigger value="sim">Simulados</TabsTrigger>
							</TabsList>
						</Tabs>
					)}
				</div>
				{error && (
					<p role="alert" className="error px-3">
						{error}
					</p>
				)}
				{pinned && !query.trim() && filter !== 'sim' && (
					<a href={pinned.href} className="chats-row chats-row-pinned" aria-current={pinnedOpen ? 'true' : undefined}>
						<span className="chats-avatar">
							<span className="encargo-avatar is-agent" aria-hidden="true">
								{initials(agentName)}
							</span>
							<ChannelBadge origin={pinned.origin} />
						</span>
						<span className="min-w-0 flex-1">
							<span className="chats-row-top">
								<span className="chats-row-name">{pinned.title}</span>
								{pinned.principal ? (
									<Crown className="chats-row-crown" aria-label="Conversación principal" />
								) : (
									<Pin className="chats-row-pin" aria-label="Fijada" />
								)}
							</span>
							<span className="chats-row-bottom">
								<span className="chats-row-last">
									{pinned.live && <LoaderCircle className="animate-spin" aria-label="Trabajando" />}
									<span className="truncate">{pinned.sub}</span>
								</span>
							</span>
						</span>
					</a>
				)}
				{!chats ? (
					<p role="status" className="muted small px-3 py-2">
						Cargando sus chats…
					</p>
				) : !shown.length ? (
					<p className="muted small px-3 py-2">
						{chats.length
							? 'Ningún chat coincide.'
							: trabajo
								? 'En este trabajo el agente no ha hablado por WhatsApp con nadie.'
								: 'El agente todavía no ha hablado por WhatsApp con nadie.'}
					</p>
				) : (
					<ul className="chats-rows">
						{shown.map((c) => (
							<li key={c.id}>
								<button
									type="button"
									className="chats-row"
									aria-current={c.id === chat ? 'true' : undefined}
									onClick={() => onChat(c.id)}
								>
									<span className="chats-avatar">
										<span className={cn('encargo-avatar', c.simulated && 'is-sim')} aria-hidden="true">
											{initials(c.name)}
										</span>
										<ChannelBadge origin="whatsapp" />
									</span>
									<span className="min-w-0 flex-1">
										<span className="chats-row-top">
											<span className="chats-row-name">{c.name}</span>
											{c.last && <span className="chats-row-when">{when(c.last.at)}</span>}
										</span>
										<span className="chats-row-bottom">
											<span className="chats-row-last">
												{c.last?.direction === 'out' && <CheckCheck aria-label="El agente:" />}
												<span className="truncate">
													{c.last
														? `${c.last.direction === 'in' && c.kind === 'group' && c.last.author !== c.name ? `${c.last.author}: ` : ''}${c.last.text}`
														: 'Sin mensajes'}
												</span>
											</span>
											{c.simulated && <FlaskConical className="chats-row-sim" aria-label="Simulado" />}
											{c.active && <Handshake className="chats-row-encargo" aria-label="Encargo activo" />}
										</span>
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</aside>
			<section className="chats-pane" aria-label={open ? `Chat con ${open.name}` : 'Chat'}>
				{pinnedOpen ? (
					<>
						<button type="button" className="chats-pane-back" onClick={() => onChat(null)}>
							<ArrowLeft aria-hidden="true" />
							Chats
						</button>
						{children}
					</>
				) : open ? (
					<ChatThread
						key={open.id}
						agentId={agentId}
						agentName={agentName}
						chat={open}
						conversationId={trabajo}
						onBack={() => onChat(null)}
					/>
				) : (
					<div className="chats-empty">
						<MessagesSquare aria-hidden="true" />
						<p>{chat && chats ? 'Ese chat no está aquí.' : 'Elige un chat para verlo.'}</p>
					</div>
				)}
			</section>
		</div>
	);
}

function ChatThread({
	agentId,
	agentName,
	chat,
	conversationId,
	onBack,
}: {
	agentId: number;
	agentName: string;
	chat: ChatRow;
	conversationId?: number;
	onBack: () => void;
}) {
	const [lines, setLines] = useState<Line[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [completeSince, setCompleteSince] = useState<number | null>(null);
	const [error, setError] = useState('');
	const [whole, setWhole] = useState(!conversationId);
	const lastId = useRef(0);
	const thread = useRef<HTMLDivElement>(null);
	const [version, setVersion] = useState(0);
	useEffect(() => {
		let gone = false;
		lastId.current = 0;
		setLines([]);
		setLoaded(false);
		const load = () =>
			api<{ lines: Line[]; completeSince: number | null }>(
				`/agents/${agentId}/chats/${encodeURIComponent(chat.id)}?after=${lastId.current}`,
			)
				.then((r) => {
					if (gone) return;
					setLoaded(true);
					setCompleteSince(r.completeSince);
					if (!r.lines.length) return;
					lastId.current = Math.max(lastId.current, ...r.lines.map((l) => l.id));
					setLines((cur) => [...cur, ...r.lines.filter((m) => !cur.some((x) => x.id === m.id))]);
				})
				.catch((e) => !gone && setError((e as Error).message));
		void load();
		const timer = setInterval(load, 2_500);
		return () => {
			gone = true;
			clearInterval(timer);
		};
	}, [agentId, chat.id, version]);
	const visible = whole || !conversationId ? lines : lines.filter((l) => l.conversation_id === conversationId);
	useEffect(() => {
		thread.current?.scrollTo({ top: thread.current.scrollHeight });
	}, [visible.length]);
	const day = (ms: number) => new Date(ms).toDateString();
	// Where the complete history starts: before its first line not rebuilt (or at its end, if none is).
	const boundary = completeSince === null ? -1 : visible.findIndex((l) => !l.backfilled);
	return (
		<div className="chats-thread">
			<header className="chats-thread-head">
				<Button variant="ghost" size="icon-sm" className="chats-back" aria-label="Chats" onClick={onBack}>
					<ArrowLeft aria-hidden="true" />
				</Button>
				<span className="chats-avatar">
					<span className={cn('encargo-avatar', chat.simulated && 'is-sim')} aria-hidden="true">
						{initials(chat.name)}
					</span>
					<ChannelBadge origin="whatsapp" />
				</span>
				<div className="min-w-0 flex-1">
					<p className="flex min-w-0 items-center gap-2 text-sm font-medium">
						<span className="truncate">{chat.name}</span>
						{chat.simulated && <Badge variant="warning">Simulado</Badge>}
						{chat.active && <Badge variant="default">Encargo activo</Badge>}
					</p>
					<p className="truncate text-xs text-muted-foreground">
						{ROLE[chat.role]}
						{chat.kind !== 'group' || chat.role !== 'owner' ? ` · ${chat.shown}` : ''}
						{chat.encargos ? ` · ${chat.encargos} ${chat.encargos === 1 ? 'encargo' : 'encargos'}` : ''}
					</p>
				</div>
				{conversationId && (
					<Button variant="ghost" size="sm" aria-pressed={whole} onClick={() => setWhole((w) => !w)}>
						<History aria-hidden="true" />
						{whole ? 'Sólo este trabajo' : 'Todo el chat'}
					</Button>
				)}
			</header>
			{chat.simulated && <SimControls agentId={agentId} chat={chat} />}
			<div ref={thread} className="chats-messages" aria-label={`Mensajes con ${chat.name}`} aria-live="polite">
				{!loaded ? (
					<p role="status" className="encargo-note">
						Cargando el chat…
					</p>
				) : !visible.length ? (
					<p className="encargo-note">
						{lines.length ? 'En este trabajo no hay mensajes de este chat.' : 'Sin mensajes todavía.'}
					</p>
				) : (
					visible.map((m, i) => {
						const prev = visible[i - 1];
						const grouped =
							!!prev &&
							prev.direction === m.direction &&
							prev.author === m.author &&
							day(prev.at) === day(m.at) &&
							prev.conversation_id === m.conversation_id &&
							prev.delegation_id === m.delegation_id;
						const ours = m.direction === 'out';
						return (
							<Fragment key={m.id}>
								{i === boundary && i > 0 && <p className="chats-backfill">{BACKFILL}</p>}
								{(!prev || day(prev.at) !== day(m.at)) && (
									<p className="encargo-day">
										<span>
											{new Date(m.at).toLocaleDateString('es-MX', {
												weekday: 'long',
												day: 'numeric',
												month: 'long',
											})}
										</span>
									</p>
								)}
								{m.conversation_id && (!prev || prev.conversation_id !== m.conversation_id) && (
									<p className="chats-context">
										<a href={`#/agent/${agentId}/job/${m.conversation_id}`}>Trabajo #{m.conversation_id}</a>
									</p>
								)}
								{m.delegation_id && (!prev || prev.delegation_id !== m.delegation_id) && (
									<p className="chats-context">
										<Handshake aria-hidden="true" />
										{m.conversation_id ? (
											<a href={`#/agent/${agentId}/job/${m.conversation_id}/encargos/${m.delegation_id}`}>
												Encargo #{m.delegation_id}
											</a>
										) : (
											`Encargo #${m.delegation_id}`
										)}
									</p>
								)}
								<div className={`encargo-row ${ours ? 'is-ours' : 'is-theirs'} ${grouped ? 'is-grouped' : ''}`}>
									{!ours && (
										<span className="encargo-avatar is-small" aria-hidden="true">
											{grouped ? '' : initials(m.author)}
										</span>
									)}
									<div className={cn('encargo-bubble', m.backfilled && ours && 'is-partial')}>
										{!grouped && (
											<p className="encargo-author">
												{ours
													? m.author === agentName
														? agentName
														: `${agentName} · ${m.author}`
													: chat.simulated
														? `${m.actor ? 'IA' : 'Tú'} (como ${chat.name})`
														: m.author}
											</p>
										)}
										<p className="break-words whitespace-pre-wrap">{m.text}</p>
										{m.files?.length ? <p className="encargo-files">{m.files.join(', ')}</p> : null}
										<p className="encargo-time">
											{m.backfilled && ours && <span title="Sólo se guardó su inicio">inicio · </span>}
											{time(m.at)}
										</p>
									</div>
								</div>
							</Fragment>
						);
					})
				)}
				{loaded && completeSince !== null && boundary === -1 && visible.length > 0 && (
					<p className="chats-backfill">{BACKFILL.replace('Antes de este punto', 'Hasta aquí')}</p>
				)}
			</div>
			{chat.simulated ? (
				<SimComposer agentId={agentId} chat={chat} onSent={() => setVersion((v) => v + 1)} />
			) : (
				<p className="chats-readonly">Sólo lectura: es su chat real de WhatsApp.</p>
			)}
			{error && (
				<p role="alert" className="error px-3 pb-2">
					{error}
				</p>
			)}
		</div>
	);
}

/** A simulated chat: whether the AI answers as the contact, and who that contact is for it. */
function SimControls({ agentId, chat }: { agentId: number; chat: ChatRow }) {
	const sim = useSimChats(agentId);
	const c = sim.chats?.find((x) => `s${x.chat}` === chat.id) ?? null;
	const actor = c?.actor ?? null;
	const auto = actor ? actor.auto : true;
	const [editing, setEditing] = useState<{ persona: string; goal: string } | null>(null);
	const [error, setError] = useState('');
	const set = async (body: Record<string, unknown>) => {
		setError('');
		try {
			await api(`/agents/${agentId}/sim/${encodeURIComponent(chat.id.slice(1))}/actor`, { method: 'PUT', body });
			sim.reload();
		} catch (e) {
			setError((e as Error).message);
		}
	};
	if (!c) return null;
	return (
		<div className="chats-sim">
			<label className="chats-sim-ai">
				<Sparkles aria-hidden="true" />
				<span>La IA responde como {chat.name}</span>
				<Switch
					checked={auto}
					onCheckedChange={(on) => void set({ auto: on })}
					className="data-[state=checked]:bg-warning"
					aria-label={`La IA responde como ${chat.name}`}
				/>
			</label>
			{auto && (
				<span className="chats-sim-state" role="status">
					{actor && !actor.stopped ? (
						<>
							<LoaderCircle className="animate-spin" aria-hidden="true" />
							{actor.replies} de {actor.max_replies} respuestas
						</>
					) : (
						'Contesta cuando el agente le escriba'
					)}
				</span>
			)}
			{!auto && actor?.stopped && <span className="chats-sim-state">Se detuvo: {actor.stopped}</span>}
			<Button
				variant="ghost"
				size="sm"
				className="ml-auto"
				onClick={() => setEditing({ persona: actor?.persona ?? '', goal: actor?.goal ?? '' })}
			>
				<UserPen aria-hidden="true" />
				Personaje
			</Button>
			{error && (
				<p role="alert" className="error w-full">
					{error}
				</p>
			)}
			<Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Personaje de {chat.name}</DialogTitle>
						<DialogDescription>Lo que la IA sabe de esta persona cuando contesta por ella.</DialogDescription>
					</DialogHeader>
					<div className="grid gap-3">
						<Textarea
							aria-label="Quién es y qué sabe"
							value={editing?.persona ?? ''}
							onChange={(e) => setEditing((x) => (x ? { ...x, persona: e.target.value } : x))}
							rows={4}
							maxLength={3000}
							placeholder="Quién es y qué sabe: p. ej. «Carnicero de Las Dos Marías. Pechuga a $255/kg. Entrega martes y jueves de 9 a 15.»"
						/>
						<Input
							aria-label="Qué quiere de la conversación"
							value={editing?.goal ?? ''}
							onChange={(e) => setEditing((x) => (x ? { ...x, goal: e.target.value } : x))}
							maxLength={1000}
							placeholder="Qué quiere de la conversación (opcional; con esto también puede escribir primero)"
						/>
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setEditing(null)}>
							Cancelar
						</Button>
						<Button
							onClick={async () => {
								if (!editing) return;
								await set({ persona: editing.persona, goal: editing.goal });
								setEditing(null);
							}}
						>
							Guardar
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

/** What its owner writes as the simulated contact: it reaches the agent as that person's WhatsApp. */
function SimComposer({ agentId, chat, onSent }: { agentId: number; chat: ChatRow; onSent: () => void }) {
	const [text, setText] = useState('');
	const [busy, setBusy] = useState(false),
		[error, setError] = useState('');
	const send = async (e?: FormEvent) => {
		e?.preventDefault();
		const body = text.trim();
		if (!body || busy) return;
		setBusy(true);
		setError('');
		try {
			await api(`/agents/${agentId}/sim/${encodeURIComponent(chat.id.slice(1))}`, { body: { text: body } });
			setText('');
			onSent();
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<form className="chats-composer" onSubmit={send}>
			<Textarea
				aria-label={`Mensaje como ${chat.name}`}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault();
						void send();
					}
				}}
				placeholder={`Escribe como ${chat.name}… (/terminar cierra la conversación)`}
				rows={1}
				maxLength={4000}
			/>
			<Button type="submit" size="icon" aria-label="Enviar" disabled={busy || !text.trim()}>
				<Send aria-hidden="true" />
			</Button>
			{error && (
				<p role="alert" className="error w-full">
					{error}
				</p>
			)}
		</form>
	);
}
