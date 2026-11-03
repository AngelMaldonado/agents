// WhatsApp with Agents' own numbers (#18), through the bridge in ../../whatsapp (whatsmeow, any number
// of linked devices). Any person links their numbers by QR; an admin also offers public numbers (with
// an alias, anyone may pick them) and private ones (admins only). Each agent talks through the number its
// owner picked. Whoever manages a number keeps its allow list (attended; each phone may be a person of
// Agents, who reaches their own and shared agents there, or a guest of the number's owner) and its block
// list (refused); any other phone is ignored. The number only answers: it never writes first.
// /agente switches between the agents of that number the phone may use.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { row, rows, exec, tx, DATA_DIR } from './db';
import { receive, SUPPLIER_ROLE } from './inbox';

/** How long a supplier's chat with an agent stays open for their answers (Cuby's longest thread: 7 days). */
const SUPPLIER_HOURS = 168;
import { whatsappConversation } from './conversations';
import { decodeHelp } from './help';
import * as cuby from './cuby-whatsapp';
import { TZ } from './channels';
import * as aliases from './aliases';
import type { Person } from './people';

// Read on each use: the bridge's address and secret come from the environment.
const URL_ = () => process.env.AGENTS_WHATSAPP_URL ?? '';
/** Where people open Agents (links in messages). */
const PUBLIC_URL = () => (process.env.AGENTS_PUBLIC_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const SECRET = () => process.env.AGENTS_WHATSAPP_SECRET ?? '';
/** Without a bridge (URL and secret) this server has no WhatsApp. */
export const enabled = () => !!URL_() && !!SECRET();
/** WhatsApp in this server: Agents' own bridge, the cuby-whatsapp integration, or both. */
export const available = () => enabled() || cuby.active();
const PHONE = /^[0-9]{8,15}$/;
const ALIAS = 60;
const LIST_MAX = 200;
/**
 * A phone as digits with its country code, one way per line: WhatsApp still names many Mexican mobiles
 * 521 + 10 digits while their E.164 number (what the web's country picker gives) is 52 + 10 digits.
 */
export const canonical = (raw: unknown) => {
	const d = String(raw ?? '').replace(/\D/g, '');
	return /^521\d{10}$/.test(d) ? `52${d.slice(3)}` : d;
};

export function checkSecret(header: string | undefined) {
	if (!enabled() || !header) return false;
	const a = Buffer.from(header),
		b = Buffer.from(SECRET());
	return a.length === b.length && timingSafeEqual(a, b);
}

async function bridge<T = any>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
	if (!enabled()) throw new Error('Este servidor no tiene el puente de WhatsApp configurado.');
	const res = await fetch(`${URL_()}${path}`, {
		method,
		headers: { 'x-agents-secret': SECRET(), 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error((data as { error?: string }).error ?? `El puente de WhatsApp respondió ${res.status}.`);
	return data as T;
}

// ---------- numbers ----------

type NumberRow = {
	id: number;
	owner_id: number;
	owner_name: string;
	scope: 'personal' | 'public' | 'private';
	alias: string;
	jid: string | null;
	phone: string | null;
	name: string;
	status: 'pairing' | 'linked' | 'unlinked' | 'failed';
	/** An awake agent sleeps after this many minutes without messages. */
	sleep_minutes: number;
	/** 'cuby': the company number through the cuby-whatsapp integration. */
	provider: 'bridge' | 'cuby';
	/** It hosts every person's groups «Agentes <owner>». */
	groups: boolean;
	created_at: number;
};
export type WhatsAppNumber = Omit<NumberRow, 'jid'> & {
	/** linked and the bridge has it connected right now */
	state: 'connected' | 'connecting' | 'down' | NumberRow['status'];
	mine: boolean;
	/** may rename, change who sees it or remove it */
	manage: boolean;
	label: string;
};

const SELECT = `select n.id, n.owner_id, p.name as owner_name, n.scope, n.alias, n.jid, n.phone, n.name, n.status, n.sleep_minutes, n.provider, n.groups,
	(extract(epoch from n.created_at)*1000)::bigint as created_at
	from whatsapp_numbers n join people p on p.id = n.owner_id`;
/** Who may see a number: its owner, everyone if public, admins if private. */
const VISIBLE = `n.deleted_at is null and (n.owner_id = $1 or n.scope = 'public' or (n.scope = 'private' and $2))`;
/**
 * Who edits a number: a personal one, its owner; a public or private one (Cuby WhatsApp too), only an
 * admin right now. Who added it does not keep it when they stop being admin (#18, Angel 2-nov-2026).
 */
const manages = (me: Person, n: Pick<NumberRow, 'owner_id' | 'scope'>) =>
	n.scope === 'personal' ? n.owner_id === me.id : me.admin;
const label = (n: Pick<NumberRow, 'alias' | 'name' | 'phone'>) =>
	n.alias || n.name || (n.phone ? `+${n.phone}` : 'Número sin vincular');

/** What the bridge says about each linked device right now, by JID; empty when it does not answer. */
async function live(): Promise<Map<string, string> | null> {
	if (!enabled()) return null;
	try {
		const r = await bridge<{ numbers: { jid: string; state: string }[] }>('GET', '/numbers', undefined, 5000);
		return new Map(r.numbers.map((n) => [n.jid, n.state]));
	} catch {
		return null;
	}
}

function view(me: Person, n: NumberRow, states: Map<string, string> | null): WhatsAppNumber {
	const { jid, ...rest } = n;
	const state: WhatsAppNumber['state'] =
		n.provider === 'cuby'
			? cuby.state()
			: n.status !== 'linked'
				? n.status
				: !states
					? 'down'
					: ((states.get(jid ?? '') as 'connected' | 'connecting' | undefined) ?? 'unlinked');
	return { ...rest, state, mine: n.owner_id === me.id, manage: manages(me, n), label: label(n) };
}

/** The numbers this person sees: theirs, the public ones and, for an admin, the private ones. */
export async function numbers(me: Person) {
	const list = await rows<NumberRow>(
		// A pairing in progress lives in its dialog, not in the list.
		`${SELECT} where ${VISIBLE} and n.status not in ('failed', 'pairing') order by (n.owner_id = $1) desc, n.scope, n.created_at`,
		[me.id, me.admin],
	);
	const states = await live();
	return {
		available: available(),
		bridge: !enabled() ? 'off' : states ? 'up' : 'down',
		numbers: list.map((n) => view(me, n, states)),
	};
}

async function own(me: Person, id: number) {
	const n = await row<NumberRow>(`${SELECT} where n.id = $1 and n.deleted_at is null`, [id]);
	if (!n || !manages(me, n)) throw new Error('Ese número no existe o no lo administras.');
	return n;
}

const cleanAlias = (alias: unknown) =>
	String(alias ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, ALIAS);
function cleanScope(me: Person, scope: unknown): NumberRow['scope'] {
	const s = scope === 'public' || scope === 'private' ? scope : 'personal';
	if (s !== 'personal' && !me.admin) throw new Error('Sólo un admin ofrece números públicos o privados.');
	return s;
}

/** Starts linking a new number: the person scans the QR that pairing() shows. */
export async function add(me: Person, input: { scope?: unknown; alias?: unknown }) {
	if (!enabled()) throw new Error('Este servidor no tiene el puente de WhatsApp configurado.');
	const scope = cleanScope(me, input.scope);
	const alias = cleanAlias(input.alias);
	if (scope === 'public' && !alias)
		throw new Error('Un número público necesita un alias para que los demás lo reconozcan.');
	// A pairing left open (the person closed the window) is replaced, not piled up.
	await exec(
		"update whatsapp_numbers set status = 'failed', deleted_at = now() where owner_id = $1 and status = 'pairing' and deleted_at is null",
		[me.id],
	);
	const n = await row<{ id: number }>(
		'insert into whatsapp_numbers (owner_id, scope, alias) values ($1, $2, $3) returning id',
		[me.id, scope, alias],
	);
	await bridge('POST', '/pairings', { ref: String(n!.id) });
	return { id: n!.id, ...(await pairing(me, n!.id)) };
}

/** A pairing's QR while it waits, and the number once it linked (or why it failed). */
export async function pairing(me: Person, id: number) {
	const n = await own(me, id);
	if (n.status !== 'pairing') return { state: n.status, number: view(me, n, await live()) };
	let p: { state: string; qr?: string; error?: string; jid?: string; phone?: string; name?: string };
	try {
		p = await bridge('GET', `/pairings/${id}`, undefined, 5000);
	} catch (err) {
		await exec("update whatsapp_numbers set status = 'failed', deleted_at = now() where id = $1", [id]);
		return { state: 'failed', error: `La vinculación se perdió: ${(err as Error).message}` };
	}
	if (p.state === 'linked') {
		const done = await linked({ ref: String(id), jid: p.jid, phone: p.phone, name: p.name });
		if (done.error) return { state: 'failed', error: done.error };
		const fresh = await own(me, id);
		return { state: 'linked', number: view(me, fresh, await live()) };
	}
	if (p.state === 'failed') {
		await exec("update whatsapp_numbers set status = 'failed', deleted_at = now() where id = $1", [id]);
		return { state: 'failed', error: p.error ?? 'La vinculación no se completó.' };
	}
	return { state: 'pairing', qr: p.qr ?? null };
}

/**
 * A pairing linked (the bridge's event, or the page that was waiting for it). A phone is linked once:
 * relinking one's own number replaces the old device; somebody else's number is refused and unlinked.
 */
export async function linked(e: { ref?: unknown; jid?: unknown; phone?: unknown; name?: unknown }) {
	const id = Number(e.ref),
		jid = String(e.jid ?? ''),
		phone = String(e.phone ?? '');
	if (!Number.isSafeInteger(id) || !jid || !PHONE.test(phone)) throw new Error('Vinculación inválida.');
	const n = await row<NumberRow>(`${SELECT} where n.id = $1 and n.deleted_at is null`, [id]);
	if (!n) return { error: 'Esa vinculación ya no existe.' };
	if (n.status === 'linked') return { ok: true }; // the event and the page both saw it
	const other = await row<{ id: number; owner_id: number; jid: string | null }>(
		"select id, owner_id, jid from whatsapp_numbers where phone = $1 and status = 'linked' and deleted_at is null and id <> $2",
		[phone, id],
	);
	if (other && other.owner_id !== n.owner_id) {
		await bridge('DELETE', `/numbers/${encodeURIComponent(jid)}`).catch(() => {});
		await exec("update whatsapp_numbers set status = 'failed', deleted_at = now() where id = $1", [id]);
		return { error: 'Ese número ya lo agregó otra persona en Agents.' };
	}
	await tx(async (c) => {
		if (other) {
			// The same person linked their number again: the new device takes the old one's place.
			await exec("update whatsapp_numbers set status = 'unlinked', deleted_at = now() where id = $1", [other.id], c);
			await exec('update agents set whatsapp_number_id = $2 where whatsapp_number_id = $1', [other.id, id], c);
			await exec(
				'insert into whatsapp_phones (number_id, phone, list, person_id, label) select $2, phone, list, person_id, label from whatsapp_phones where number_id = $1 on conflict do nothing',
				[other.id, id],
				c,
			);
		}
		await exec(
			"update whatsapp_numbers set status = 'linked', jid = $2, phone = $3, name = $4 where id = $1",
			[id, jid, phone, String(e.name ?? '').slice(0, 80)],
			c,
		);
	});
	if (other?.jid) await bridge('DELETE', `/numbers/${encodeURIComponent(other.jid)}`).catch(() => {});
	return { ok: true };
}

export async function update(
	me: Person,
	id: number,
	input: { alias?: unknown; scope?: unknown; sleepMinutes?: unknown; groups?: unknown },
) {
	const n = await own(me, id);
	// An admin picks which public or private number hosts everyone's groups (only one does).
	if (input.groups !== undefined && !!input.groups !== n.groups) {
		if (!me.admin || n.scope === 'personal')
			throw new Error('Sólo un admin elige el número de los grupos, entre los públicos o privados.');
		await tx(async (c) => {
			await exec('update whatsapp_numbers set groups = false where groups', [], c);
			if (input.groups) await exec('update whatsapp_numbers set groups = true where id = $1', [id], c);
		});
		void syncGroups();
	}
	// The company number is everyone's to pick.
	const scope = input.scope === undefined || n.provider === 'cuby' ? n.scope : cleanScope(me, input.scope);
	const alias = input.alias === undefined ? n.alias : cleanAlias(input.alias);
	if (scope === 'public' && !alias) throw new Error('Un número público necesita un alias.');
	const sleep = input.sleepMinutes === undefined ? n.sleep_minutes : Number(input.sleepMinutes);
	if (!Number.isInteger(sleep) || sleep < 5 || sleep > 1440)
		throw new Error('El agente se duerme entre 5 y 1440 minutos (24 h) sin mensajes.');
	await exec('update whatsapp_numbers set scope = $2, alias = $3, sleep_minutes = $4 where id = $1', [
		id,
		scope,
		alias,
		sleep,
	]);
	return numbers(me);
}

/** Unlinks a number from Agents (and from the phone's linked devices); its agents lose WhatsApp. */
export async function remove(me: Person, id: number) {
	const n = await own(me, id);
	if (n.provider === 'cuby') throw new Error('Cuby WhatsApp se activa y desactiva en Administración.');
	if (n.jid) await bridge('DELETE', `/numbers/${encodeURIComponent(n.jid)}`);
	else if (n.status === 'pairing') await bridge('DELETE', `/pairings/${id}`).catch(() => {});
	await tx(async (c) => {
		await exec("update whatsapp_numbers set status = 'unlinked', deleted_at = now() where id = $1", [id], c);
		await exec('update agents set whatsapp_number_id = null where whatsapp_number_id = $1', [id], c);
	});
	return numbers(me);
}

/** WhatsApp closed a number's session (unlinked from the phone, or expired). */
export async function loggedOut(e: { number?: unknown }) {
	await exec("update whatsapp_numbers set status = 'unlinked' where jid = $1 and deleted_at is null", [
		String(e.number ?? ''),
	]);
	return { ok: true };
}

// ---------- who may write: the allow and block lists ----------

type Phone = { phone: string; label: string; personId: number | null; personName: string | null; supplier: boolean };

/** A number's lists, and the people an allow entry may be (who writes from that phone). */
export async function lists(me: Person, id: number) {
	await own(me, id);
	const phones = await rows<Phone & { list: 'allow' | 'block' }>(
		`select w.phone, w.list, w.label, w.person_id as "personId", p.name as "personName", w.supplier
		 from whatsapp_phones w left join people p on p.id = w.person_id where w.number_id = $1 order by w.created_at, w.phone`,
		[id],
	);
	return {
		allow: phones.filter((p) => p.list === 'allow').map(({ list: _, ...p }) => p),
		block: phones
			.filter((p) => p.list === 'block')
			.map(({ list: _, personId: __, personName: ___, supplier: ____, ...p }) => p),
		people: await rows<{ id: number; name: string }>('select id, name from people order by name, id'),
	};
}

/** Replaces both lists. A phone is in one list at most; an allow entry may name a person. */
export async function setLists(me: Person, id: number, input: { allow?: unknown; block?: unknown }) {
	const n = await own(me, id);
	const clean = (list: unknown, kind: 'allow' | 'block') =>
		(Array.isArray(list) ? list : []).map((e: any) => {
			const phone = canonical(e?.phone);
			if (!PHONE.test(phone))
				throw new Error(`«${e?.phone ?? ''}» no es un número válido: elige el país y escribe el número.`);
			const personId = kind === 'allow' && e?.personId ? Number(e.personId) : null;
			return {
				phone,
				kind,
				personId,
				// A supplier is a guest (no person) the agents write to one to one, never in a group.
				supplier: kind === 'allow' && !personId && !!e?.supplier,
				label: String(e?.label ?? '')
					.trim()
					.slice(0, 60),
			};
		});
	const all = [...clean(input.allow, 'allow'), ...clean(input.block, 'block')];
	// The number's own phone cannot write to it: WhatsApp's «Mensaje para ti» chat is the account itself,
	// which the bridge never takes as a message.
	const self = n.phone ? canonical(n.phone) : null;
	if (self && all.some((e) => e.phone === self))
		throw new Error(
			`+${n.phone} es este mismo número: no puede escribirse a sí mismo. Agrega los teléfonos desde los que le escribirán.`,
		);
	if (all.length > LIST_MAX) throw new Error(`Hasta ${LIST_MAX} números entre las dos listas.`);
	const seen = new Set<string>();
	for (const e of all) {
		if (seen.has(e.phone)) throw new Error(`+${e.phone} está repetido: va en una sola lista, una vez.`);
		seen.add(e.phone);
	}
	const people = new Set(
		(
			await rows<{ id: number }>('select id from people where id = any($1::bigint[])', [
				all.map((e) => e.personId ?? 0),
			])
		).map((p) => Number(p.id)),
	);
	if (all.some((e) => e.personId !== null && !people.has(e.personId))) throw new Error('Esa persona ya no existe.');
	await tx(async (c) => {
		await exec('delete from whatsapp_phones where number_id = $1', [id], c);
		for (const e of all)
			await exec(
				'insert into whatsapp_phones (number_id, phone, list, person_id, label, supplier) values ($1, $2, $3, $4, $5, $6)',
				[id, e.phone, e.kind, e.personId, e.label, e.supplier],
				c,
			);
		// A phone that may no longer write stops talking to its agent.
		await exec(
			"delete from whatsapp_chats w where w.number_id = $1 and not exists (select 1 from whatsapp_phones p where p.number_id = $1 and p.phone = w.phone and p.list = 'allow')",
			[id],
			c,
		);
	});
	if (n.provider === 'cuby') await cuby.syncAllowlist(); // its allow list lives in cuby-whatsapp too
	void syncGroups(); // who has a group follows the lists
	return lists(me, id);
}

// ---------- the number of the groups ----------

/** The number that hosts everyone's groups: the one an admin marked, or the company number (Cuby). */
export async function groupNumber(): Promise<NumberRow | null> {
	const marked = await row<NumberRow>(`${SELECT} where n.deleted_at is null and n.status = 'linked' and n.groups`);
	if (marked) return marked;
	return cuby.active()
		? await row<NumberRow>(`${SELECT} where n.deleted_at is null and n.status = 'linked' and n.provider = 'cuby'`)
		: null;
}

// ---------- per agent ----------

export async function agentView(agentId: number, owner: Person) {
	const a = await row<{ whatsapp_notify: boolean }>('select whatsapp_notify from agents where id = $1', [agentId]);
	const n = await groupNumber();
	const states = n?.provider === 'bridge' ? await live() : null;
	return {
		available: available(),
		number: n ? view(owner, n, states) : null,
		notify: !!a?.whatsapp_notify,
		contacts: n ? (await contacts(agentId, owner, n)).map(({ phone: _phone, ...c }) => c) : [],
	};
}

/**
 * Who of the groups number's allow list may talk to this agent (in their group «Agentes <owner>»), as its
 * owner sees it: their own phone, the people it is shared with and the number's guests. On a number they
 * do not manage, others' phones show only their last digits (each row has an opaque key to switch it).
 */
async function contacts(agentId: number, owner: Person, n: NumberRow) {
	const sees = manages(owner, n);
	const list = await rows<{
		phone: string;
		label: string;
		person_id: number | null;
		person_name: string | null;
		reach: boolean;
		choice: boolean | null;
		supplier: boolean;
	}>(
		`select w.phone, w.label, w.person_id, p.name as person_name, x.enabled as choice, w.supplier,
		   coalesce(w.person_id = a.person_id or exists (select 1 from agent_shares s where s.agent_id = a.id and s.person_id = w.person_id), false) as reach
		 from whatsapp_phones w join agents a on a.id = $1
		 left join people p on p.id = w.person_id
		 left join whatsapp_agent_phones x on x.agent_id = a.id and x.number_id = w.number_id and x.phone = w.phone
		 where w.number_id = $2 and w.list = 'allow'
		 order by (w.person_id = a.person_id) desc nulls last, w.person_id is null, coalesce(p.name, w.label), w.phone`,
		[agentId, n.id],
	);
	return list
		.filter((c) => (c.person_id ? c.reach : true))
		.map((c) => ({
			key: createHash('sha256').update(`${n.id}:${c.phone}`).digest('hex').slice(0, 16),
			phone: c.phone,
			shown: sees || c.person_id === owner.id ? c.phone : `••••${c.phone.slice(-4)}`,
			name: c.person_name ?? (c.label || 'Invitado'),
			kind: (c.person_id === owner.id ? 'owner' : c.person_id ? 'person' : c.supplier ? 'supplier' : 'guest') as
				'owner' | 'person' | 'guest' | 'supplier',
			enabled: c.choice ?? !!c.person_id,
		}));
}

/** The agent's owner switches one contact on or off for this agent; their groups follow. */
export async function setContact(agentId: number, owner: Person, input: { key?: unknown; enabled?: unknown }) {
	const n = await groupNumber();
	if (!n) throw new Error('No hay un número de WhatsApp para los grupos.');
	const c = (await contacts(agentId, owner, n)).find((x) => x.key === String(input.key ?? ''));
	if (!c) throw new Error('Ese contacto ya no está en la lista blanca del número.');
	await exec(
		`insert into whatsapp_agent_phones (agent_id, number_id, phone, enabled) values ($1, $2, $3, $4)
		 on conflict (agent_id, number_id, phone) do update set enabled = excluded.enabled, updated_at = now()`,
		[agentId, n.id, c.phone, !!input.enabled],
	);
	void syncGroups();
	return agentView(agentId, owner);
}

/** Whether its owner hears its scheduled and webhook work, in their own group. */
export async function setAgent(agentId: number, owner: Person, input: { notify?: unknown }) {
	await exec('update agents set whatsapp_notify = $2 where id = $1', [agentId, !!input.notify]);
	return agentView(agentId, owner);
}

// ---------- the groups ----------

type Reachable = { id: number; name: string; owner_id: number };
type InboundFile = { name: string; mime: string; data: string };
type GroupRow = {
	id: number;
	number_id: number;
	owner_id: number;
	phone: string;
	person_id: number | null;
	ref: string | null;
	title: string;
	status: 'creating' | 'open' | 'closed' | 'failed';
	last_agent_id: number | null;
	last_conversation_id: number | null;
	pending: { agents: number[]; text: string } | null;
	/** Out of the group, and why (Cuby's group.member_left); null: in it. */
	member_out: 'list' | 'integration' | 'self' | null;
	error: string | null;
	updated_at: number;
};
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** The owner's agents this member may use in their group: all of them for the owner, shared or switched on. */
const groupAgents = (g: Pick<GroupRow, 'number_id' | 'owner_id' | 'phone' | 'person_id'>) =>
	rows<Reachable>(
		`select a.id, a.name, a.person_id as owner_id from agents a
		 where a.person_id = $1 and a.deleted_at is null
		   and ($4::bigint is null or $4::bigint = $1
		        or exists (select 1 from agent_shares s where s.agent_id = a.id and s.person_id = $4))
		   and coalesce((select x.enabled from whatsapp_agent_phones x where x.agent_id = a.id and x.number_id = $2 and x.phone = $3),
		                $4::bigint is not null)
		 order by a.name, a.id`,
		[g.owner_id, g.number_id, g.phone, g.person_id],
	);

/** The 1:1 send (a phone) or into a group (a group's address): the ids of what went out. */
async function deliver(
	n: Pick<NumberRow, 'jid' | 'provider'>,
	to: { phone?: string; group?: string; resolve?: boolean },
	text: string,
	files: InboundFile[] = [],
	personId?: number,
): Promise<string[]> {
	if (n.provider === 'cuby')
		return to.group
			? cuby.sendGroup(to.group, text, files, personId)
			: (await cuby.send(to.phone!, text, files, { personId }), []);
	const r = await bridge<{ ids?: string[] }>(
		'POST',
		`/numbers/${encodeURIComponent(n.jid!)}/send`,
		to.group ? { group: to.group, text, files } : { phone: to.phone, text, files, resolve: !!to.resolve },
		180_000,
	);
	return r.ids ?? [];
}

/**
 * Into a person's group. An agent's message goes under its name, and it becomes who that group's next
 * message goes to (in `conversationId` when given); a reply quoting it goes back to it.
 */
async function sayInGroup(
	n: NumberRow,
	g: GroupRow,
	agent: Reachable | null,
	text: string,
	files: InboundFile[] = [],
	conversationId: number | null = null,
) {
	const body = agent && text.trim() ? `*${agent.name}:* ${text}` : text;
	const ids = await deliver(n, { group: g.ref! }, body, files, agent?.owner_id ?? g.owner_id);
	if (!agent) return ids;
	for (const id of ids)
		await exec(
			`insert into whatsapp_outbound (number_id, message_id, group_id, agent_id, conversation_id, text)
			 values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
			[n.id, id, g.id, agent.id, conversationId, text.slice(0, 500)],
		);
	await exec(
		'update whatsapp_groups set last_agent_id = $2, last_conversation_id = $3, pending = null, updated_at = now() where id = $1',
		[g.id, agent.id, conversationId],
	);
	return ids;
}

const names = (list: Reachable[]) => list.map((a, i) => `${i + 1}. ${a.name}`).join('\n');
const welcome = (g: GroupRow, owner: string, list: Reachable[]) =>
	`Aquí hablas con ${g.person_id === g.owner_id ? 'tus agentes' : `los agentes de ${owner}`}:\n${names(list)}\n\n` +
	`Te contesta el que te habló al último. Para hablarle a otro, empieza con su nombre («${list[0]?.name ?? 'Agente'}: …») o escribe /agente y su nombre; cita un mensaje para seguir esa conversación. /agentes muestra la lista, /terminar cierra la conversación con el agente actual y /ayuda explica todo.`;

let syncing: Promise<void> | null = null,
	again = false;
/**
 * Makes the groups match who may use whose agents: a group per (owner, member) with at least one agent,
 * created when it is missing, reopened when it comes back, closed (with a line) when nothing is left.
 */
export function syncGroups(): Promise<void> {
	if (syncing) {
		again = true;
		return syncing;
	}
	syncing = (async () => {
		do {
			again = false;
			await syncOnce().catch((err) => console.error('whatsapp groups:', (err as Error).message));
		} while (again);
	})().finally(() => (syncing = null));
	return syncing;
}

async function syncOnce() {
	const n = await groupNumber();
	if (!n?.jid) return;
	// Who should have a group with whose agents.
	const want = await rows<{ owner_id: number; owner_name: string; phone: string; person_id: number | null }>(
		`select distinct a.person_id as owner_id, o.name as owner_name, w.phone, w.person_id
		 from whatsapp_phones w join agents a on a.deleted_at is null join people o on o.id = a.person_id
		 where w.number_id = $1 and w.list = 'allow' and not w.supplier
		   and (w.person_id is null or w.person_id = a.person_id
		        or exists (select 1 from agent_shares s where s.agent_id = a.id and s.person_id = w.person_id))
		   and coalesce((select x.enabled from whatsapp_agent_phones x where x.agent_id = a.id and x.number_id = $1 and x.phone = w.phone),
		                w.person_id is not null)`,
		[n.id],
	);
	const have = await rows<GroupRow>('select * from whatsapp_groups where number_id = $1', [n.id]);
	let created = 0;
	for (const w of want) {
		const g = have.find((x) => x.owner_id === w.owner_id && x.phone === w.phone);
		if (g?.status === 'open') continue;
		// One being made (unless a restart left it half-way), or one that failed lately: not again yet.
		const age = g ? Date.now() - new Date(g.updated_at).getTime() : Infinity;
		if (g?.status === 'creating' && age < 5 * 60_000) continue;
		if (g?.status === 'failed' && age < 15 * 60_000) continue;
		if (created >= 5) break; // a few per pass: the number (shared with other integrations) has a pace
		const title = `Agentes ${w.owner_name}`;
		try {
			if (g?.ref && g.status === 'closed') {
				// Back: the group opens again, with who is in it now.
				await exec("update whatsapp_groups set status = 'open', person_id = $2, updated_at = now() where id = $1", [
					g.id,
					w.person_id,
				]);
				if (n.provider === 'bridge')
					await bridge('POST', `/numbers/${encodeURIComponent(n.jid)}/groups/${encodeURIComponent(g.ref)}/lock`, {
						locked: false,
					});
				const open = { ...g, status: 'open' as const, person_id: w.person_id };
				// Out of it, whatever Cuby said (it may report a list removal as `self`): reopening is a new
				// invitation, so they go back in before the welcome. In an open group, leaving is respected.
				if (n.provider === 'cuby' && g.member_out) await putBack(g);
				await sayInGroup(n, open, null, welcome(open, w.owner_name, await groupAgents(open)));
				continue;
			}
			const id =
				g?.id ??
				(await row<{ id: number }>(
					`insert into whatsapp_groups (number_id, owner_id, phone, person_id, title) values ($1, $2, $3, $4, $5)
					 on conflict (number_id, owner_id, phone) do update set updated_at = now() returning id`,
					[n.id, w.owner_id, w.phone, w.person_id, title],
				))!.id;
			created++;
			const photo = await photoOf(w.owner_id);
			const b64 = photo?.jpeg.toString('base64');
			let ref: string,
				pictured = !!photo;
			if (n.provider === 'cuby') ref = await cuby.createGroup(title, w.phone, b64);
			else {
				const r = await bridge<{ jid: string; photo?: boolean }>(
					'POST',
					`/numbers/${encodeURIComponent(n.jid)}/groups`,
					{
						name: title,
						phones: [w.phone],
						...(b64 ? { photo: b64 } : {}),
					},
				);
				ref = r.jid;
				pictured = !!r.photo;
			}
			const open = (await row<GroupRow>(
				`update whatsapp_groups g set ref = $2, status = 'open', error = null, person_id = $3, updated_at = now(),
				   photo_at = (select p.updated_at from whatsapp_group_photos p where p.owner_id = g.owner_id and p.jpeg = $4)
				 where id = $1 returning *`,
				[id, ref, w.person_id, pictured ? photo!.jpeg : null],
			))!;
			await sayInGroup(n, open, null, welcome(open, w.owner_name, await groupAgents(open)));
		} catch (err) {
			const message = (err as Error).message;
			console.error(`whatsapp group ${title} (…${w.phone.slice(-4)}):`, message);
			await exec(
				"update whatsapp_groups set status = case when ref is null then 'failed' else status end, error = $4, updated_at = now() where number_id = $1 and owner_id = $2 and phone = $3",
				[n.id, w.owner_id, w.phone, message.slice(0, 300)],
			);
			if (/rate|overlimit|429|tope/i.test(message)) break; // WhatsApp says slow down: the next pass, later
		}
	}
	// Out of an open group that is still theirs (Cuby took them out with the list): back in, with the
	// welcome. Not who left on their own; one try every 10 minutes when WhatsApp refuses (left recently).
	if (n.provider === 'cuby') {
		const out = have.filter(
			(g) =>
				g.status === 'open' &&
				g.ref &&
				(g.member_out === 'list' || g.member_out === 'integration') &&
				(!g.error || Date.now() - new Date(g.updated_at).getTime() > 10 * 60_000) &&
				want.some((w) => w.owner_id === g.owner_id && w.phone === g.phone),
		);
		for (const g of out.slice(0, 5)) {
			try {
				await putBack(g);
				const owner = want.find((w) => w.owner_id === g.owner_id)!.owner_name;
				await sayInGroup(n, g, null, welcome(g, owner, await groupAgents(g)));
			} catch {
				// said in its error; tried again later
			}
		}
	}
	// Its owner changed (or removed) the photo: the open groups follow, on Agents' own numbers.
	if (n.provider === 'bridge') {
		const stale = await rows<{ id: number; ref: string; jpeg: Buffer | null }>(
			`select g.id, g.ref, p.jpeg from whatsapp_groups g
			 left join whatsapp_group_photos p on p.owner_id = g.owner_id
			 where g.number_id = $1 and g.status = 'open' and g.ref is not null and g.photo_at is distinct from p.updated_at
			 order by g.id limit 10`,
			[n.id],
		);
		for (const g of stale) {
			await bridge('POST', `/numbers/${encodeURIComponent(n.jid)}/groups/${encodeURIComponent(g.ref)}/photo`, {
				photo: g.jpeg ? g.jpeg.toString('base64') : '',
			}).catch((err) => console.error(`whatsapp group photo ${g.id}:`, (err as Error).message));
			// Tried once per version (the one sent: it may have changed meanwhile), so a photo WhatsApp refuses
			// is not sent again every minute.
			await exec(
				`update whatsapp_groups g set photo_at = (select p.updated_at from whatsapp_group_photos p where p.owner_id = g.owner_id and p.jpeg = $2)
				 where g.id = $1`,
				[g.id, g.jpeg],
			);
		}
	}
	// Nothing left for that person there: one line, and the group is locked until something comes back.
	for (const g of have.filter((x) => x.status === 'open' && x.ref)) {
		if (want.some((w) => w.owner_id === g.owner_id && w.phone === g.phone)) continue;
		const owner = (await row<{ name: string }>('select name from people where id = $1', [g.owner_id]))?.name ?? '';
		const bye = `Ya no hay agentes de ${owner} aquí. Si vuelven, este grupo se abre otra vez.`;
		try {
			if (n.provider === 'cuby') await cuby.closeThread(g.ref!, bye);
			else {
				await deliver(n, { group: g.ref! }, bye);
				await bridge('POST', `/numbers/${encodeURIComponent(n.jid)}/groups/${encodeURIComponent(g.ref!)}/lock`, {
					locked: true,
				});
			}
			await exec(
				"update whatsapp_groups set status = 'closed', last_agent_id = null, last_conversation_id = null, pending = null, updated_at = now() where id = $1",
				[g.id],
			);
		} catch (err) {
			console.error(`whatsapp group close ${g.id}:`, (err as Error).message);
		}
	}
}

/** Cuby: the group's member back in it (added, or invited). Its error says why not. */
async function putBack(g: Pick<GroupRow, 'id' | 'ref' | 'phone'>) {
	try {
		const status = await cuby.addMember(g.ref!, g.phone);
		console.log(
			`whatsapp group ${g.id}: …${g.phone.slice(-4)} ${status === 'invited' ? 'invitado (debe aceptar)' : 'agregado'}`,
		);
		await exec('update whatsapp_groups set member_out = null, error = null, updated_at = now() where id = $1', [g.id]);
	} catch (err) {
		const message = (err as Error).message;
		console.error(`whatsapp group ${g.id}: no pude volver a meter …${g.phone.slice(-4)}:`, message);
		await exec('update whatsapp_groups set error = $2, updated_at = now() where id = $1', [
			g.id,
			message.slice(0, 300),
		]);
		throw err;
	}
}

// ---------- the photo of a person's groups ----------

const photoOf = (ownerId: number) =>
	row<{ jpeg: Buffer; updated_at: number }>('select jpeg, updated_at from whatsapp_group_photos where owner_id = $1', [
		ownerId,
	]);

/** Configuración → WhatsApp: the photo of my groups «Agentes <me>», and whether the open ones follow it. */
export async function groupPhotoView(me: Person) {
	const p = await photoOf(me.id);
	const n = await groupNumber();
	const open = n
		? (await row<{ n: number }>(
				"select count(*)::int as n from whatsapp_groups where number_id = $1 and owner_id = $2 and status = 'open'",
				[n.id, me.id],
			))!.n
		: 0;
	return {
		available: available() && !!n,
		photo: p ? `data:image/jpeg;base64,${p.jpeg.toString('base64')}` : null,
		updatedAt: p?.updated_at ?? null,
		groups: open,
		// Cuby WhatsApp takes a photo only when it creates a group.
		updatesOpen: n?.provider === 'bridge',
	};
}

/** A square JPEG (made in the browser), at most 1 MB; null removes it. Its groups follow (see syncOnce). */
export async function setGroupPhoto(me: Person, input: { jpeg?: unknown } | null) {
	const raw = typeof input?.jpeg === 'string' ? input.jpeg.replace(/^data:image\/jpeg;base64,/, '') : null;
	if (raw === null) await exec('delete from whatsapp_group_photos where owner_id = $1', [me.id]);
	else {
		const jpeg = Buffer.from(raw, 'base64');
		if (jpeg.length < 100 || jpeg.length > 1_048_576 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff)
			throw new Error('La foto debe ser un JPEG de hasta 1 MB.');
		await exec(
			`insert into whatsapp_group_photos (owner_id, jpeg) values ($1, $2)
			 on conflict (owner_id) do update set jpeg = excluded.jpeg, updated_at = now()`,
			[me.id, jpeg],
		);
	}
	void syncGroups();
	return groupPhotoView(me);
}

/** The groups of a person (as member), for their settings page. */
export async function myGroups(me: Person) {
	return rows<{ id: number; title: string; status: string; error: string | null }>(
		'select g.id, g.title, g.status, g.error from whatsapp_groups g where g.person_id = $1 order by g.title',
		[me.id],
	);
}

// ---------- inbound ----------

/**
 * Whether the bridge may take a message: in a group, only an open group of ours and only from its member;
 * one to one, only an allow-listed phone asking where its agents are (/agentes).
 */
export async function allowed(e: { number?: unknown; phone?: unknown; text?: unknown; group?: unknown }) {
	const phone = canonical(e.phone);
	if (e.group) {
		const g = await row(
			`select 1 from whatsapp_groups g join whatsapp_numbers n on n.id = g.number_id
			 where n.jid = $1 and n.deleted_at is null and g.ref = $2 and g.status = 'open' and g.phone = $3`,
			[String(e.number ?? ''), String(e.group), phone],
		);
		return { allowed: !!g };
	}
	const hit = await row<{ supplier: boolean; asked: boolean }>(
		`select w.supplier, exists (select 1 from whatsapp_supplier_threads t where t.number_id = n.id and t.phone = w.phone
		   and t.last_at > now() - make_interval(hours => $3)) as asked
		 from whatsapp_phones w join whatsapp_numbers n on n.id = w.number_id
		 where n.jid = $1 and n.deleted_at is null and n.status = 'linked' and w.phone = $2 and w.list = 'allow'`,
		[String(e.number ?? ''), phone, SUPPLIER_HOURS],
	);
	// A supplier an agent wrote to lately: anything they answer is for that agent.
	if (hit?.supplier && hit.asked) return { allowed: true };
	return { allowed: !!hit && /^\/(agentes|agente|ayuda)\b/i.test(String(e.text ?? '').trim()) };
}

/** What the bridge saw: a message, a pairing that linked or a number WhatsApp logged out. */
export async function event(e: Record<string, unknown>) {
	if (e.type === 'linked') return linked(e);
	if (e.type === 'logged_out') return loggedOut(e);
	if (e.type === 'message') return inbound(e);
	if (e.type === 'vote') return { ignored: true }; // polls were the one-to-one menu
	throw new Error('Evento de WhatsApp desconocido.');
}

const COMMAND = /^\/(agentes|agente|terminar|ayuda|alias|actual)\b\s*([\s\S]*)$/i;

/** /ayuda in a group: the commands and how a message finds its agent, with who answers now. */
const help = (list: Reachable[], current: Reachable | undefined) =>
	[
		current ? `Ahora hablas con ${current.name}.` : 'Todavía no hablas con ningún agente.',
		'',
		'*Comandos*',
		'/agentes: la lista de agentes de este grupo; responde con el número para elegir.',
		'/agente <nombre o número>: cambia a ese agente.',
		'/actual: con qué agente hablas ahora.',
		'/terminar: cierra la conversación con el agente actual; la siguiente empieza de cero.',
		'/alias: tus alias; /alias <alias> se lo pone al agente actual; /alias quitar <alias> lo quita.',
		'/ayuda: esta ayuda.',
		'',
		'*A quién va tu mensaje*',
		`Empieza con su nombre o alias («${list[0]?.name ?? 'Agente'}: …» o «@alias …») para hablarle a uno.`,
		'Cita un mensaje de un agente para seguir esa conversación.',
		'Si no, te contesta el último que habló.',
	].join('\n');

/** What became of a message: ignored (and why), a command, or the message an agent received. */
export async function inbound(m: Record<string, unknown>): Promise<Record<string, unknown>> {
	const from = String(m.phone ?? '').replace(/\D/g, '');
	const phone = canonical(from);
	const id = String(m.id ?? '').slice(0, 200);
	if (!PHONE.test(phone) || !id) throw new Error('Mensaje de WhatsApp inválido.');
	const n = await row<NumberRow>(`${SELECT} where n.jid = $1 and n.deleted_at is null and n.status = 'linked'`, [
		String(m.number ?? ''),
	]);
	if (!n?.jid) return { ignored: true };
	const text = String(m.text ?? '')
		.trim()
		.slice(0, 20_000);
	if (m.group) return groupInbound(n, String(m.group), phone, from, id, text, m);

	// One to one: only to say where the agents are.
	const reply = (t: string) => deliver(n, { phone: from }, t);
	const entry = await row<{ supplier: boolean; label: string }>(
		"select supplier, label from whatsapp_phones where number_id = $1 and phone = $2 and list = 'allow'",
		[n.id, phone],
	);
	if (entry?.supplier) return supplierInbound(n, phone, from, id, text, m, entry.label);
	if (entry && /^\/(agentes|agente|ayuda)\b/i.test(text)) {
		await reply(
			'Los agentes están en tus grupos «Agentes …» de este número: escríbeles ahí. Dentro, /ayuda muestra los comandos.',
		);
		return { command: true };
	}
	return { ignored: true };
}

/**
 * A supplier's answer, one to one: to the agent that wrote to them (by Cuby's thread, else their latest chat
 * of the last days), in the conversation that asked. Nobody asked them, or the owner switched them off for
 * that agent: ignored. They never authorize anything (their messages are signed as a supplier's).
 */
async function supplierInbound(
	n: NumberRow,
	phone: string,
	from: string,
	id: string,
	text: string,
	m: Record<string, unknown>,
	label: string,
) {
	const thread = typeof m.thread === 'string' && m.thread ? m.thread : null;
	type Chat = { id: number; agent_id: number; conversation_id: number | null };
	const t =
		(thread
			? await row<Chat>(
					'select id, agent_id, conversation_id from whatsapp_supplier_threads where number_id = $1 and thread_id = $2 and phone = $3',
					[n.id, thread, phone],
				)
			: null) ??
		(await row<Chat>(
			`select id, agent_id, conversation_id from whatsapp_supplier_threads
			 where number_id = $1 and phone = $2 and last_at > now() - make_interval(hours => $3) order by last_at desc limit 1`,
			[n.id, phone, SUPPLIER_HOURS],
		));
	if (!t) return { ignored: true, reason: 'nadie le escribió' };
	const on = await row(
		`select 1 from agents a join whatsapp_agent_phones x on x.agent_id = a.id
		 where a.id = $1 and a.deleted_at is null and x.number_id = $2 and x.phone = $3 and x.enabled`,
		[t.agent_id, n.id, phone],
	);
	if (!on) return { ignored: true, reason: 'apagado para ese agente' };
	const files = (Array.isArray(m.files) ? m.files : []).slice(0, 10).map((f: any) => ({
		name: String(f?.name ?? 'archivo'),
		mime: String(f?.mime ?? 'application/octet-stream'),
		data: String(f?.data ?? ''),
	}));
	if (!text && !files.length) return { ignored: true };
	const who = label || String(m.name ?? '').slice(0, 80) || 'Proveedor';
	const kept = t.conversation_id
		? await row<{ id: number }>(
				'select id from conversations where id = $1 and agent_id = $2 and archived_at is null and deleted_at is null',
				[t.conversation_id, t.agent_id],
			)
		: null;
	const conversationId =
		kept?.id ?? (await whatsappConversation(t.agent_id, `s:${n.id}:${phone}`, `WhatsApp · ${who}`));
	await exec('update whatsapp_supplier_threads set last_at = now(), conversation_id = $2 where id = $1', [
		t.id,
		conversationId,
	]);
	return receive(
		{
			agentId: t.agent_id,
			conversationId,
			source: 'whatsapp',
			personId: null,
			sender: `${who} (+${phone}), ${SUPPLIER_ROLE}`,
			text,
			attachments: files,
			context: { whatsapp: { number: n.id, phone: from, supplier: t.id } },
			dedupeKey: `wa:${n.id}:${id}`,
		},
		{ routeNow: false },
	);
}

/**
 * whatsapp_notify to a supplier: one to one, in this agent's chat with them (Cuby: its thread, open up to
 * 7 days and renewed by each message; a new chat introduces the agent as an AI assistant). Their answer
 * goes back to `conversationId`.
 */
async function toSupplier(
	n: NumberRow,
	agent: { id: number; name: string; person_id: number },
	phone: string,
	text: string,
	files: InboundFile[],
	conversationId: number,
) {
	const open = await row<{ id: number; thread_id: string | null }>(
		`select id, thread_id from whatsapp_supplier_threads
		 where number_id = $1 and phone = $2 and agent_id = $3 and last_at > now() - make_interval(hours => $4)
		 order by last_at desc limit 1`,
		[n.id, phone, agent.id, SUPPLIER_HOURS],
	);
	const owner = (await row<{ name: string }>('select name from people where id = $1', [agent.person_id]))?.name ?? '';
	const hello = `Hola, soy ${agent.name}, asistente de IA${owner ? ` de ${owner}` : ''}.\n\n`;
	let threadId: string | null = open?.thread_id ?? null;
	let fresh = !open;
	if (n.provider === 'cuby') {
		const opening = () =>
			cuby.send(phone, `${hello}${text}`, files, {
				personId: agent.person_id,
				thread: agent.name,
				hours: SUPPLIER_HOURS,
			});
		if (threadId)
			threadId = await cuby.send(phone, text, files, { personId: agent.person_id, threadId }).catch(() => {
				fresh = true; // the thread closed after all: a new one, introduced again
				return opening();
			});
		else threadId = await opening();
	} else await deliver(n, { phone, resolve: true }, `${fresh ? hello : ''}${text}`, files, agent.person_id);
	if (open && !fresh)
		await exec('update whatsapp_supplier_threads set last_at = now(), conversation_id = $2 where id = $1', [
			open.id,
			conversationId,
		]);
	else
		await exec(
			`insert into whatsapp_supplier_threads (number_id, phone, agent_id, conversation_id, thread_id)
			 values ($1, $2, $3, $4, $5)`,
			[n.id, phone, agent.id, conversationId, threadId],
		);
}

async function groupInbound(
	n: NumberRow,
	ref: string,
	phone: string,
	from: string,
	id: string,
	raw: string,
	m: Record<string, unknown>,
) {
	const g = await row<GroupRow>("select * from whatsapp_groups where number_id = $1 and ref = $2 and status = 'open'", [
		n.id,
		ref,
	]);
	if (!g || g.phone !== phone) return { ignored: true }; // only its member writes for the agents
	const list = await groupAgents(g);
	if (!list.length) return { ignored: true }; // the next sync closes it
	const say = (t: string) => sayInGroup(n, g, null, t);
	let text = raw;
	// The member's own aliases pick agents too (a guest has none).
	const mine = await aliases.of(g.person_id);
	const find = (word: string) => aliases.resolve(word, list, mine);

	const command = text.match(COMMAND);
	if (command) {
		const verb = command[1].toLowerCase(),
			arg = fold(command[2]);
		const current = list.find((a) => a.id === g.last_agent_id);
		if (verb === 'ayuda') return say(help(list, current)).then(() => ({ command: true }));
		if (verb === 'actual') {
			if (!current)
				return say(
					`Todavía no hablas con ningún agente. Escribe /agente y su nombre, o empieza tu mensaje con él («${list[0]?.name ?? 'Agente'}: …»).`,
				).then(() => ({ command: true }));
			const open = g.last_conversation_id
				? await row('select 1 from conversations where id = $1 and archived_at is null and deleted_at is null', [
						g.last_conversation_id,
					])
				: null;
			const names = ['@' + aliases.handleOf(current.name), ...(mine.get(current.id) ?? []).map((x) => '@' + x)];
			await say(
				`Hablas con ${current.name}${open ? ', en una conversación abierta' : '; tu próximo mensaje empieza una conversación nueva'}. También le dices ${names.join(', ')}.`,
			);
			return { command: true };
		}
		if (verb === 'alias') {
			if (!g.person_id)
				return say(
					'Los alias son de las personas de Agents: pídele a un admin que ligue tu teléfono a tu cuenta.',
				).then(() => ({ command: true }));
			const words = command[2].trim().split(/\s+/).filter(Boolean);
			if (!words.length) {
				const lines = list.map(
					(a) =>
						`${a.name}: ${['@' + aliases.handleOf(a.name), ...(mine.get(a.id) ?? []).map((x) => '@' + x)].join(', ')}`,
				);
				return say(`Así les puedes decir:\n${lines.join('\n')}\n\n/alias <alias> le pone uno al agente actual.`).then(
					() => ({ command: true }),
				);
			}
			if (fold(words[0]) === 'quitar') {
				const gone = await aliases.remove(g.person_id, words[1] ?? '');
				return say(gone ? `Quité @${words[1].replace(/^@/, '')}.` : 'No tienes ese alias.').then(() => ({
					command: true,
				}));
			}
			if (!current)
				return say('Primero elige un agente (/agente …) y luego /alias <alias>.').then(() => ({ command: true }));
			try {
				const now = await aliases.add({ id: g.person_id, admin: false } as Person, current.id, words[0]);
				await say(`Listo: ${current.name} también responde a ${now.map((x) => '@' + x).join(', ')}.`);
			} catch (err) {
				await say((err as Error).message);
			}
			return { command: true };
		}
		if (verb === 'terminar') {
			if (!current) return say('No hay una conversación abierta con un agente.').then(() => ({ command: true }));
			await exec(
				'update conversations set archived_at = now() where agent_id = $1 and whatsapp_key = $2 and archived_at is null',
				[current.id, `g:${g.id}`],
			);
			await exec('update whatsapp_groups set last_conversation_id = null, updated_at = now() where id = $1', [g.id]);
			await say(`Terminé la conversación con ${current.name}; la próxima empieza de cero.`);
			return { command: true, ended: true };
		}
		if (verb === 'agente' && arg) {
			const pick = /^\d+$/.test(arg) ? list[Number(arg) - 1] : find(command[2]);
			if (!pick)
				return say(`No encontré ese agente. Puedes hablar con:\n${names(list)}`).then(() => ({ command: true }));
			await exec(
				'update whatsapp_groups set last_agent_id = $2, last_conversation_id = null, pending = null, updated_at = now() where id = $1',
				[g.id, pick.id],
			);
			await say(`Ahora hablas con ${pick.name}.`);
			return { command: true, agent: pick.id };
		}
		await exec('update whatsapp_groups set pending = $2 where id = $1', [
			g.id,
			JSON.stringify({ agents: list.map((a) => a.id), text: '' }),
		]);
		await say(
			`${current ? `Hablas con ${current.name}. ` : ''}Puedes hablar con:\n${names(list)}\n\nResponde con el número.`,
		);
		return { command: true };
	}

	// «¿Para qué agente?» answered with a number: what was waiting goes to it.
	if (g.pending && /^\d{1,2}$/.test(text)) {
		const offered = g.pending.agents.map((a) => list.find((x) => x.id === a)).filter((a): a is Reachable => !!a);
		const pick = offered[Number(text) - 1];
		if (pick) {
			await exec(
				'update whatsapp_groups set last_agent_id = $2, last_conversation_id = null, pending = null, updated_at = now() where id = $1',
				[g.id, pick.id],
			);
			if (!g.pending.text)
				return say(`Ahora hablas con ${pick.name}. ¿En qué te ayudo?`).then(() => ({ command: true }));
			text = g.pending.text;
			g.last_agent_id = pick.id;
			g.last_conversation_id = null;
		}
	}

	// Who it is for: the agent of the quoted message (and its conversation), one named first, or the last one.
	let agent: Reachable | undefined,
		conversation: number | null = null,
		context = '';
	const quoted = String(m.quoted ?? '');
	if (quoted) {
		const o = await row<{ agent_id: number; conversation_id: number | null; text: string }>(
			'select agent_id, conversation_id, text from whatsapp_outbound where number_id = $1 and message_id = $2 and group_id = $3',
			[n.id, quoted, g.id],
		);
		agent = o ? list.find((a) => a.id === o.agent_id) : undefined;
		if (agent) {
			conversation = o!.conversation_id;
			if (!conversation && o!.text) context = o!.text;
		}
	}
	if (!agent) {
		// «@rd revisa…», or a name or alias first: «Radar: revisa…».
		const at = text.match(/^\s*@([\p{L}\p{N}_-]+)[\s,:]+([\s\S]+)$/u);
		const named = text.match(/^\s*@?([^:,\n]{2,40}?)\s*[:,]\s+([\s\S]+)$/);
		const hit = (at && find(at[1])) || (named && find(named[1]));
		if (hit) {
			agent = hit;
			text = ((at && find(at[1]) ? at[2] : named![2]) as string).trim();
		}
	}
	if (!agent && g.last_agent_id) {
		agent = list.find((a) => a.id === g.last_agent_id);
		if (agent) {
			conversation = g.last_conversation_id;
			// What it last said here, when it spoke from outside this group's conversation (a notice).
			if (!conversation) {
				const last = await row<{ text: string; conversation_id: number | null }>(
					'select text, conversation_id from whatsapp_outbound where group_id = $1 and agent_id = $2 order by at desc limit 1',
					[g.id, agent.id],
				);
				if (last && !last.conversation_id && last.text) context = last.text;
			}
		}
	}
	if (!agent && list.length === 1) agent = list[0];
	if (!agent) {
		await exec('update whatsapp_groups set pending = $2 where id = $1', [
			g.id,
			JSON.stringify({ agents: list.map((a) => a.id), text }),
		]);
		await say(`¿Para qué agente es?\n${names(list)}\n\nResponde con el número.`);
		return { needsAgent: true };
	}

	const files = (Array.isArray(m.files) ? m.files : []).slice(0, 10).map((f: any) => ({
		name: String(f?.name ?? 'archivo'),
		mime: String(f?.mime ?? 'application/octet-stream'),
		data: String(f?.data ?? ''),
	}));
	if (!text && !files.length) return { ignored: true };
	// Its conversation: the one it wrote from (while open), or this group's with it.
	const kept = conversation
		? await row<{ id: number }>(
				'select id from conversations where id = $1 and agent_id = $2 and archived_at is null and deleted_at is null',
				[conversation, agent.id],
			)
		: null;
	const entry = await row<{ person_id: number | null; person_name: string | null; label: string }>(
		`select w.person_id, p.name as person_name, w.label from whatsapp_phones w left join people p on p.id = w.person_id
		 where w.number_id = $1 and w.phone = $2`,
		[n.id, phone],
	);
	const who = entry?.label || entry?.person_name || String(m.name ?? '').slice(0, 80);
	const conversationId =
		kept?.id ?? (await whatsappConversation(agent.id, `g:${g.id}`, `WhatsApp · ${who || `+${phone}`}`));
	await exec(
		'update whatsapp_groups set last_agent_id = $2, last_conversation_id = $3, pending = null, updated_at = now() where id = $1',
		[g.id, agent.id, conversationId],
	);
	// Busy in another conversation: say so once, without saying whose.
	const busy = await row<{ other: boolean; waiting: boolean }>(
		`select r.conversation_id <> $2 as other,
		   exists (select 1 from messages w where w.conversation_id = $2 and w.routed_at is null and w.run_id is null) as waiting
		 from runs r
		 where r.agent_id = $1 and r.status in ('queued', 'starting', 'running', 'blocked') order by r.id limit 1`,
		[agent.id, conversationId],
	);
	const role =
		entry?.person_id === agent.owner_id
			? 'tu dueño'
			: entry?.person_id
				? 'con quien tu dueño compartió este agente (no es tu dueño)'
				: 'invitado de tu dueño (no es tu dueño)';
	const result = await receive(
		{
			agentId: agent.id,
			conversationId,
			source: 'whatsapp',
			personId: entry?.person_id ?? null,
			// Who writes, for the agent: its owner may authorize what its contract asks of them; others may not.
			sender: `${who ? `${who} (+${phone})` : `+${phone}`}, ${role}`,
			text: context ? `(En respuesta a tu mensaje: «${context.slice(0, 300)}»)\n\n${text}` : text,
			attachments: files,
			context: { whatsapp: { number: n.id, group: g.id, phone: from, quoted: quoted || undefined } },
			dedupeKey: `wa:${n.id}:${id}`,
		},
		{ routeNow: false },
	);
	if (busy?.other && !busy.waiting)
		await sayInGroup(
			n,
			g,
			agent,
			'Estoy terminando otra tarea; sigo con la tuya en cuanto acabe.',
			[],
			conversationId,
		).catch(() => {});
	return result;
}

/** «escribiendo…» in the groups whose agent works now (own numbers; Cuby shows its own for a minute). */
export async function keepTyping() {
	if (!enabled()) return;
	const groups = await rows<{ jid: string; ref: string }>(
		`select distinct n.jid, g.ref from runs r join messages m on m.run_id = r.id
		 join whatsapp_groups g on g.id = (m.context->'whatsapp'->>'group')::bigint
		 join whatsapp_numbers n on n.id = g.number_id
		 where r.status in ('starting', 'running') and n.provider = 'bridge' and g.status = 'open' and g.ref is not null`,
	);
	for (const g of groups)
		await bridge('POST', `/numbers/${encodeURIComponent(g.jid)}/typing`, { group: g.ref }, 5000).catch(() => {});
}
let ticker: ReturnType<typeof setInterval> | null = null,
	typer: ReturnType<typeof setInterval> | null = null;
/** The groups follow lists, shares and agents (a minute at most), and «escribiendo…» stays while it works. */
export function startSleeper() {
	ticker ??= setInterval(() => void syncGroups(), 60_000);
	ticker.unref?.();
	typer ??= setInterval(() => void keepTyping().catch(() => {}), 10_000);
	typer.unref?.();
	void syncGroups();
}

// ---------- outbound: answers and notices ----------

const OUT_FILES = 5;
const chunk = (text: string) => (text.length > 3500 ? `${text.slice(0, 3500)}\n\n… (sigue en la web de Agents)` : text);

/**
 * How a run ended (or that it is blocked), to WhatsApp: into the groups it was asked from; scheduled or
 * webhook work, into its owner's own group when the agent says so (Canales). Never throws: a failed send
 * must not change how the run ended.
 */
export async function onRun(
	runId: number,
	event: 'done' | 'incomplete' | 'cancelled' | 'error' | 'blocked',
	reason: string | null = null,
	/** Blocked: the last picture of its browser, sent with the question when it shows a page. */
	shot: { jpeg: string; url: string } | null = null,
) {
	if (!available()) return;
	try {
		const r = await row<{
			agent_id: number;
			conversation_id: number;
			name: string;
			answer: string | null;
			end_reason: string | null;
			owner_id: number;
			notify: boolean;
		}>(
			`select r.agent_id, r.conversation_id, a.name, r.answer, r.end_reason, a.person_id as owner_id, a.whatsapp_notify as notify
			 from runs r join agents a on a.id = r.agent_id where r.id = $1`,
			[runId],
		);
		if (!r) return;
		const n = await groupNumber();
		if (!n?.jid) return;
		const sources = await rows<{ source: string; group_id: string | null }>(
			"select source, context->'whatsapp'->>'group' as group_id from messages where run_id = $1",
			[runId],
		);
		const ids = [...new Set(sources.map((s) => s.group_id).filter((x): x is string => !!x))].map(Number);
		let groups = ids.length
			? await rows<GroupRow>("select * from whatsapp_groups where id = any($1::bigint[]) and status = 'open'", [ids])
			: [];
		if (!ids.length && r.notify && sources.some((s) => s.source === 'cron' || s.source === 'hook'))
			groups = await rows<GroupRow>(
				"select * from whatsapp_groups where number_id = $1 and owner_id = $2 and person_id = $2 and status = 'open'",
				[n.id, r.owner_id],
			);
		if (!groups.length) return;
		let text: string;
		let files: InboundFile[] = [];
		if (event === 'blocked') {
			const help = decodeHelp(reason);
			const questions = help.questions
				.map((q, i) => `${i + 1}. ${q.title}\n${q.options.map((o) => `   - ${o.label}`).join('\n')}`)
				.join('\n\n');
			text = `Necesito tu ayuda: ${help.reason}${questions ? `\n\n${questions}` : ''}\n\nResponde aquí para que siga.`;
			if (shot?.jpeg && shot.url && shot.url !== 'about:blank')
				files = [{ name: 'pantalla.jpg', mime: 'image/jpeg', data: shot.jpeg }];
		} else if (event === 'done') {
			text = r.answer ?? 'Terminé.';
			files = await outputs(runId);
		} else {
			text = event === 'cancelled' ? 'Se canceló el trabajo.' : `No pude terminar: ${r.end_reason ?? 'error'}`;
		}
		const agent = { id: r.agent_id, name: r.name, owner_id: r.owner_id };
		for (const g of groups) {
			// Only its owner takes control of its browser (from the web).
			const control =
				event === 'blocked' && files.length && g.person_id === r.owner_id
					? `\n\nSi hace falta que lo hagas tú en su navegador: ${PUBLIC_URL()}/#/agent/${r.agent_id}/browser`
					: '';
			await sayInGroup(n, g, agent, chunk(text) + control, files, r.conversation_id).catch((err) =>
				console.error(`whatsapp run ${runId} → grupo ${g.id}:`, (err as Error).message),
			);
		}
	} catch (err) {
		console.error(`whatsapp run ${runId}:`, (err as Error).message);
	}
}

// ---------- notices the agent sends on its own (whatsapp_notify) ----------

const NOTICES_PER_RUN = 3,
	NOTICES_PER_DAY = 10;

export type NoticeResult = {
	ok: boolean;
	error?: string;
	enviado_a?: string[];
	no_enviado?: { para: string; motivo: string }[];
};
/** One line for the run's activity: who got the notice and who did not. */
export function noticeLine(r: NoticeResult) {
	const missed = (r.no_enviado ?? []).map((f) => `${f.para} (${f.motivo})`).join('; ');
	return r.enviado_a?.length
		? `Avisó por WhatsApp a ${r.enviado_a.join(', ')}.${missed ? ` No le llegó a: ${missed}.` : ''}`
		: `No mandó el aviso por WhatsApp: ${r.error ?? missed}`;
}
/**
 * whatsapp_notify: the agent tells contacts something, as its contract says, in each one's group
 * «Agentes <owner>»: only contacts its owner switched on, not past the caps nor at night unless urgent.
 * Says who got it and who did not, and why.
 */
export async function notify(
	runId: number,
	input: { to?: unknown; text?: unknown; urgent?: unknown; file?: { name?: unknown; data?: unknown } | null },
	now = new Date(),
): Promise<NoticeResult> {
	const a = await row<{ id: number; name: string; person_id: number; role: string; conversation_id: number }>(
		`select a.id, a.name, a.person_id, a.role, r.conversation_id from runs r join agents a on a.id = r.agent_id where r.id = $1`,
		[runId],
	);
	if (!a) return { ok: false, error: 'El trabajo ya no existe.' };
	if (!/^#{1,6}\s*avisos por whatsapp\b/im.test(a.role))
		return {
			ok: false,
			error:
				'Tu contrato no tiene la sección «Avisos por WhatsApp»: no mandes avisos; dile al dueño que lo pida en Automejora.',
		};
	const n = await groupNumber();
	if (!n?.jid) return { ok: false, error: 'No hay un número de WhatsApp para los grupos.' };
	const text = String(input.text ?? '')
		.trim()
		.slice(0, 3500);
	if (!text) return { ok: false, error: 'El aviso está vacío.' };
	const hour = Number(
		new Intl.DateTimeFormat('es-MX', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ }).format(now),
	);
	if ((hour >= 22 || hour < 7) && input.urgent !== true)
		return {
			ok: false,
			error: 'Horario de silencio (22:00 a 7:00): no se mandan avisos salvo urgentes. Déjalo en tu respuesta.',
		};
	const sent = (await row<{ n: number }>('select count(*)::int as n from whatsapp_notices where run_id = $1', [runId]))!
		.n;
	if (sent >= NOTICES_PER_RUN)
		return { ok: false, error: `Ya mandaste ${NOTICES_PER_RUN} avisos en este trabajo: es el tope.` };
	const wanted = (Array.isArray(input.to) ? input.to : [input.to])
		.map((x) => String(x ?? ''))
		.filter(Boolean)
		.slice(0, 10);
	if (!wanted.length) return { ok: false, error: 'Di a quién: el nombre de un contacto habilitado.' };
	const owner = { id: a.person_id, admin: false } as Person;
	const enabledList = (await contacts(a.id, owner, n)).filter((c) => c.enabled);
	const file = input.file?.data
		? [
				{
					name: String(input.file.name ?? 'archivo'),
					mime: mimeOf(String(input.file.name ?? '')),
					data: String(input.file.data),
				},
			]
		: [];
	const agent = { id: a.id, name: a.name, owner_id: a.person_id };
	const delivered: string[] = [],
		failed: { para: string; motivo: string }[] = [];
	for (const name of wanted) {
		const want = fold(name);
		const c =
			enabledList.find((x) => fold(x.name) === want) ??
			(['dueño', 'dueno', 'yo', 'mi dueño'].includes(want) ? enabledList.find((x) => x.kind === 'owner') : undefined) ??
			enabledList.find((x) => fold(x.name).startsWith(want));
		if (!c) {
			failed.push({
				para: name,
				motivo: 'no es un contacto habilitado para este agente (Canales → Quién le escribe por WhatsApp)',
			});
			continue;
		}
		if (c.kind === 'supplier') {
			const sentToday = (await row<{ n: number }>(
				"select count(*)::int as n from whatsapp_notices where number_id = $1 and phone = $2 and at > now() - interval '1 day'",
				[n.id, c.phone],
			))!.n;
			if (sentToday >= NOTICES_PER_DAY) {
				failed.push({ para: c.name, motivo: `ya recibió ${NOTICES_PER_DAY} avisos en las últimas 24 h` });
				continue;
			}
			try {
				await toSupplier(n, a, c.phone, text, file, a.conversation_id);
				await exec('insert into whatsapp_notices (agent_id, run_id, number_id, phone) values ($1, $2, $3, $4)', [
					a.id,
					runId,
					n.id,
					c.phone,
				]);
				delivered.push(c.name);
			} catch (err) {
				failed.push({ para: c.name, motivo: (err as Error).message.slice(0, 200) });
			}
			continue;
		}
		const find = () =>
			row<GroupRow>(
				"select * from whatsapp_groups where number_id = $1 and owner_id = $2 and phone = $3 and status = 'open'",
				[n.id, a.person_id, c.phone],
			);
		const g = (await find()) ?? (await syncGroups().then(find));
		if (!g) {
			failed.push({ para: c.name, motivo: `todavía no tiene su grupo «Agentes …» con este agente` });
			continue;
		}
		const today = (await row<{ n: number }>(
			"select count(*)::int as n from whatsapp_notices where number_id = $1 and phone = $2 and at > now() - interval '1 day'",
			[n.id, c.phone],
		))!.n;
		if (today >= NOTICES_PER_DAY) {
			failed.push({ para: c.name, motivo: `ya recibió ${NOTICES_PER_DAY} avisos en las últimas 24 h` });
			continue;
		}
		try {
			// The owner's reply goes on in this run's conversation; anyone else's, in their group's with it.
			await sayInGroup(n, g, agent, text, file, c.kind === 'owner' ? a.conversation_id : null);
			await exec('insert into whatsapp_notices (agent_id, run_id, number_id, phone) values ($1, $2, $3, $4)', [
				a.id,
				runId,
				n.id,
				c.phone,
			]);
			delivered.push(c.name);
		} catch (err) {
			failed.push({ para: c.name, motivo: (err as Error).message.slice(0, 200) });
		}
	}
	return { ok: delivered.length > 0, enviado_a: delivered, no_enviado: failed };
}
const mimeOf = (name: string) =>
	({
		pdf: 'application/pdf',
		png: 'image/png',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		webp: 'image/webp',
		csv: 'text/csv',
		txt: 'text/plain',
		html: 'text/html',
	})[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** The files the run left in ~/work/out, the first few and only those WhatsApp takes (10 MB). */
async function outputs(runId: number) {
	const files = await rows<{ name: string; mime: string; path: string; size: number }>(
		"select name, mime, path, size from files where run_id = $1 and direction = 'out' and size <= 10485760 order by id limit $2",
		[runId, OUT_FILES],
	);
	return files.flatMap((f) => {
		try {
			return [{ name: f.name, mime: f.mime, data: readFileSync(join(DATA_DIR, f.path)).toString('base64') }];
		} catch {
			return [];
		}
	});
}
