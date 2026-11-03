// cuby-whatsapp as a channel for everyone's agents (#18). Agents is ONE integration of that service: one
// key, one consumer (this server) that long-polls its events and hands each message to the same flow as
// Agents' own numbers (whatsapp.ts: /agentes, /agente, /terminar, a conversation per chat, sleeping). In
// Agents it is one more number, «Cuby WhatsApp» (provider 'cuby', jid 'cuby'), that any person picks for
// their agents once an admin turns it on. Its allow list is the admins'; each person links their own phone
// by writing it in Configuración → WhatsApp (no code since 2-nov-2026: Angel's call, with its tradeoff).
// API: https://whatsapp.cubytest.space/v1/guide (office network only).
import { randomUUID } from 'node:crypto';
import { row, rows, exec, tx } from './db';
import { seal, open } from './crypto';
import type { Person } from './people';

const BASE = () => (process.env.AGENTS_CUBY_WHATSAPP_URL ?? 'https://whatsapp.cubytest.space').replace(/\/$/, '');
const CONSUMER = `agents-${process.env.AGENTS_INSTANCE ?? 'dev'}`;
const PHONE = /^[0-9]{8,15}$/;
const FILE_MAX = 10 * 1024 * 1024;
/** What cuby-whatsapp takes as a document, by its extension (messages.contract.ts DocumentBody). */
const DOCUMENT = /\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip)$/i;

/** One file in a ZIP, stored (no compression): enough to carry a type the service would refuse. */
export function zipOne(name: string, data: Buffer) {
	const file = Buffer.from(name.replace(/[\\/]/g, '_'), 'utf8');
	const crc = Bun.hash.crc32(data) >>> 0;
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4); // version needed
	local.writeUInt16LE(0x0800, 6); // UTF-8 name
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(file.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(0x0800, 8);
	central.writeUInt32LE(crc, 16);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(file.length, 28);
	const directory = 30 + file.length + data.length;
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(46 + file.length, 12);
	end.writeUInt32LE(directory, 16);
	return Buffer.concat([local, file, data, central, file, end]);
}
/** One phone, one line: Mexican mobiles often come as 521 + 10 digits (see whatsapp.ts canonical). */
const canonical = (raw: unknown) => {
	const d = String(raw ?? '').replace(/\D/g, '');
	return /^521\d{10}$/.test(d) ? `52${d.slice(3)}` : d;
};

type Config = {
	enabled: boolean;
	mode: 'live' | 'test';
	live_key: string | null;
	live_last4: string | null;
	test_key: string | null;
	test_last4: string | null;
	daily_per_person: number;
	shown_phone: string;
};
let config: Config | null = null;
/** What the consumer saw last; shown in Administración. */
const status = { connected: false, lastPollAt: 0, lastError: '', allowlistSyncedAt: 0, allowlistCount: 0 };

export async function load() {
	config = await row<Config>(
		'select enabled, mode, live_key, live_last4, test_key, test_last4, daily_per_person, shown_phone from cuby_whatsapp where id = 1',
	);
	return config;
}
const keyOf = (c: Config | null) => {
	const sealed = c?.mode === 'live' ? c.live_key : c?.test_key;
	return sealed ? open(sealed) : null;
};
/** Turned on, with the key of its mode. */
export const active = () => !!config?.enabled && !!(config.mode === 'live' ? config.live_key : config.test_key);

async function api<T = any>(method: string, path: string, body?: unknown, timeoutMs = 30_000, signal?: AbortSignal) {
	const key = keyOf(config);
	if (!key) throw new Error('Cuby WhatsApp no tiene llave para su modo.');
	const timeout = AbortSignal.timeout(timeoutMs);
	const res = await fetch(path.startsWith('http') ? path : `${BASE()}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${key}`,
			'x-cuby-consumer': CONSUMER,
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
			...(method === 'POST' && path === '/v1/messages' ? { 'idempotency-key': randomUUID() } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!res.ok) {
		const data = (await res.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
		const err = data.error as { message?: string; code?: string } | string | undefined;
		const message = typeof err === 'string' ? err : (err?.message ?? (data.message as string | undefined));
		throw Object.assign(new Error(`Cuby WhatsApp respondió ${res.status}${message ? `: ${message}` : ''}`), {
			status: res.status,
		});
	}
	return (path.includes('/media') ? res : await res.json()) as T;
}

// ---------- administration ----------

/** The number row every agent picks: created on the first save, linked while it is on. */
async function ensureNumber(adminId: number) {
	const on = active();
	const phone = PHONE.test(config?.shown_phone ?? '') ? config!.shown_phone : null;
	const n = await row<{ id: number }>("select id from whatsapp_numbers where provider = 'cuby'");
	if (n)
		await exec(
			"update whatsapp_numbers set status = $2, phone = $3, deleted_at = null, scope = 'public' where id = $1",
			[n.id, on ? 'linked' : 'unlinked', phone],
		);
	else
		await exec(
			`insert into whatsapp_numbers (owner_id, scope, alias, jid, phone, name, status, provider)
			 values ($1, 'public', 'Cuby WhatsApp', 'cuby', $2, 'Cuby WhatsApp', $3, 'cuby')`,
			[adminId, phone, on ? 'linked' : 'unlinked'],
		);
}

export function adminView() {
	return {
		enabled: !!config?.enabled,
		mode: config?.mode ?? 'test',
		liveKey: config?.live_last4 ?? null,
		testKey: config?.test_last4 ?? null,
		dailyPerPerson: config?.daily_per_person ?? 100,
		shownPhone: config?.shown_phone ?? '',
		url: BASE(),
		status: { ...status, running: !!loop },
	};
}

/** An admin turns it on or off, sets its keys (sealed, shown only by their last digits) and its limits. */
export async function configure(
	me: Person,
	input: {
		enabled?: unknown;
		mode?: unknown;
		liveKey?: unknown;
		testKey?: unknown;
		dailyPerPerson?: unknown;
		shownPhone?: unknown;
	},
) {
	const cur = (await load())!;
	const next = { ...cur };
	if (input.mode !== undefined) {
		if (input.mode !== 'live' && input.mode !== 'test') throw new Error('El modo es Real o Prueba.');
		next.mode = input.mode;
	}
	for (const [field, prefix] of [
		['liveKey', 'cwk_live_'],
		['testKey', 'cwk_test_'],
	] as const) {
		const value = typeof input[field] === 'string' ? (input[field] as string).trim() : '';
		if (!value) continue;
		if (!value.startsWith(prefix) || value.length < prefix.length + 8)
			throw new Error(
				`Esa no es una llave ${prefix === 'cwk_live_' ? 'real (cwk_live_…)' : 'de prueba (cwk_test_…)'}.`,
			);
		if (field === 'liveKey') Object.assign(next, { live_key: seal(value), live_last4: value.slice(-4) });
		else Object.assign(next, { test_key: seal(value), test_last4: value.slice(-4) });
	}
	if (input.dailyPerPerson !== undefined) {
		const n = Number(input.dailyPerPerson);
		if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error('El tope por persona va de 1 a 500 mensajes al día.');
		next.daily_per_person = n;
	}
	if (input.shownPhone !== undefined) {
		const p = canonical(input.shownPhone);
		if (p && !PHONE.test(p)) throw new Error('El número de Cuby WhatsApp no es válido.');
		next.shown_phone = p;
	}
	if (input.enabled !== undefined) next.enabled = !!input.enabled;
	if (next.enabled && !(next.mode === 'live' ? next.live_key : next.test_key))
		throw new Error(`Falta la llave ${next.mode === 'live' ? 'real' : 'de prueba'} para activarla.`);
	const previous = config;
	config = next;
	if (next.enabled) {
		// The key answers before it is kept: a wrong one is said here, not in the logs.
		try {
			await api('GET', '/v1/me', undefined, 10_000);
		} catch (err) {
			config = previous;
			throw new Error(`No se pudo conectar con Cuby WhatsApp: ${(err as Error).message}`);
		}
	}
	await exec(
		`update cuby_whatsapp set enabled = $1, mode = $2, live_key = $3, live_last4 = $4, test_key = $5, test_last4 = $6,
		   daily_per_person = $7, shown_phone = $8, updated_at = now() where id = 1`,
		[
			next.enabled,
			next.mode,
			next.live_key,
			next.live_last4,
			next.test_key,
			next.test_last4,
			next.daily_per_person,
			next.shown_phone,
		],
	);
	await load();
	await ensureNumber(me.id);
	restart();
	return adminView();
}

// ---------- the consumer ----------

let loop: AbortController | null = null;
/** (Re)starts the consumer with the current configuration; stops it when turned off. */
export function restart() {
	loop?.abort();
	loop = null;
	status.connected = false;
	if (!active()) return;
	const ctl = new AbortController();
	loop = ctl;
	void consume(ctl.signal);
}

const wait = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const t = setTimeout(resolve, ms);
		signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
	});

async function consume(signal: AbortSignal) {
	const beat = setInterval(() => void api('POST', '/v1/events/heartbeat', undefined, 10_000).catch(() => {}), 20_000);
	let backoff = 1000,
		synced = 0;
	while (!signal.aborted) {
		try {
			if (Date.now() - synced > 3_600_000) {
				// What this integration is and who it may talk to: at start and every hour.
				await api('PUT', '/v1/me', {
					// JEV reads this to pick who gets an unclear message; the person sees personLabel when asked.
					description:
						'Agents: los agentes de IA de cada persona. Todo mensaje que empiece con /agentes, /agente, /actual, /alias, /terminar o /ayuda es para Agents, y lo que siga a un saludo «Hola, soy <agente>» también.',
					personLabel: 'tus agentes de IA (Agents)',
				});
				await syncAllowlist();
				synced = Date.now();
				Object.assign(status, { connected: true, lastError: '' }); // the service took our key and list
			}
			const after = (await row<{ cursor: number }>('select cursor from cuby_whatsapp where id = 1'))!.cursor;
			const r = await api<{ events: CubyEvent[]; cursor: number }>(
				'GET',
				`/v1/events?after=${after}&wait=25&consumer=${encodeURIComponent(CONSUMER)}`,
				undefined,
				40_000,
				signal,
			);
			Object.assign(status, { connected: true, lastPollAt: Date.now(), lastError: '' });
			for (const e of r.events)
				await handle(e).catch((err) => console.error(`cuby-whatsapp ${e.event} ${e.id}:`, (err as Error).message));
			// Asking with this cursor next time marks everything up to it as collected.
			await exec('update cuby_whatsapp set cursor = $1 where id = 1', [r.cursor]);
			backoff = 1000;
		} catch (err) {
			if (signal.aborted) break;
			const message = (err as Error).message;
			if (message !== status.lastError) console.warn(`cuby-whatsapp: ${message}`);
			Object.assign(status, { connected: false, lastError: message });
			// 409: another copy collects with this key (it is taken over a minute after that one stops).
			await wait((err as { status?: number }).status === 409 ? 30_000 : backoff, signal);
			backoff = Math.min(backoff * 2, 60_000);
		}
	}
	clearInterval(beat);
}

type CubyEvent = { id: number; event: string; mode: string; data: Record<string, any> };

/** A message to the company number for Agents: into the same flow as Agents' own numbers. */
export async function handle(e: CubyEvent) {
	const d = e.data ?? {};
	// One short line per event (kind and the phone's last digits, never what it says): what came and what
	// Agents did with it.
	const who = d.from ? `…${String(d.from).slice(-4)}` : '';
	// Someone left or joined one of our groups: leaving the list takes a phone out of every group, and
	// coming back does not put it in again by itself (Agents does, in syncGroups).
	if (e.event === 'group.member_left' || e.event === 'group.member_joined') {
		const by = String(d.by ?? '');
		const out = e.event === 'group.member_joined' ? null : ['list', 'integration'].includes(by) ? by : 'self';
		await exec(
			`update whatsapp_groups g set member_out = $3, updated_at = now() from whatsapp_numbers n
			 where n.id = g.number_id and n.provider = 'cuby' and g.ref = $1 and g.phone = $2`,
			[String(d.threadId ?? ''), canonical(d.phone), out],
		);
		console.log(`cuby-whatsapp ← ${e.event} …${String(d.phone ?? '').slice(-4)}${out ? ` (${out})` : ''}`);
		if (out && out !== 'self') void import('./whatsapp').then((w) => w.syncGroups());
		return;
	}
	if (e.event !== 'message.received') return void console.log(`cuby-whatsapp ← ${e.event} ${who}`.trim());
	if (!d.from) return;
	let text = '';
	const files: { name: string; mime: string; data: string }[] = [];
	const fetchFile = async (url: string | null, name: string, mime: string, size: number | null) => {
		if (!url) return;
		if ((size ?? 0) > FILE_MAX) {
			text += `\n\n(«${name}» pasa de 10 MB y no se recibió.)`;
			return;
		}
		const res = await api<Response>('GET', url, undefined, 60_000);
		files.push({ name, mime, data: Buffer.from(await res.arrayBuffer()).toString('base64') });
	};
	if (d.kind === 'text') text = d.text;
	else if (d.kind === 'voice')
		text = d.transcript ? `(nota de voz) ${d.transcript}` : '(nota de voz que no se pudo transcribir)';
	else if (d.kind === 'image') {
		text = d.caption ?? '';
		const ext = String(d.image?.mimetype ?? '').includes('png') ? 'png' : 'jpg';
		await fetchFile(d.image?.url, `imagen-${d.messageId}.${ext}`, d.image?.mimetype ?? 'image/jpeg', d.image?.size);
	} else if (d.kind === 'document' || d.kind === 'video') {
		text = d.caption ?? '';
		await fetchFile(
			d.file?.url,
			d.file?.fileName ?? `${d.kind}-${d.messageId}`,
			d.file?.mimetype ?? 'application/octet-stream',
			d.file?.size,
		);
	} else return; // stickers, locations, contacts…: nothing an agent can read yet
	if (!text.trim() && !files.length) return;
	const whatsapp = await import('./whatsapp');
	const result = await whatsapp.inbound({
		number: 'cuby',
		id: d.messageId,
		phone: String(d.from).replace(/\D/g, ''),
		name: d.fromName ?? '',
		text,
		files,
		quoted: d.inReplyTo ?? '',
		// A group Agents created (one person's group with someone's agents): its thread is its address.
		...(d.group ? { group: d.threadId } : {}),
	});
	console.log(`cuby-whatsapp ← ${d.kind} ${who}: ${JSON.stringify(result).slice(0, 160)}`);
}

// ---------- sending ----------

/**
 * Sends through the company number: the text, then each file (one per message). Inside the thread of the
 * chat's awake session when there is one; `thread` opens a new one (an agent waking up) and its id comes
 * back. Counts against the daily cap of `personId` (the agent's owner) when given.
 */
export async function send(
	phone: string,
	text: string,
	files: { name: string; mime: string; data: string }[] = [],
	opts: { personId?: number; thread?: string; threadId?: string | null } = {},
) {
	if (!active()) throw new Error('Cuby WhatsApp está apagado.');
	// What the service refuses (an HTML report) goes zipped only when it is the one deliverable: next to a
	// PDF or an image it is the same result twice.
	const takes = (f: { name: string; mime: string }) => /^image\/(jpeg|png|webp)$/.test(f.mime) || DOCUMENT.test(f.name);
	if (files.some(takes)) files = files.filter(takes);
	const count = (text.trim() ? 1 : 0) + files.length;
	if (opts.personId && count) {
		const used = await row<{ sent: number }>(
			`insert into cuby_whatsapp_usage (person_id, day, sent) values ($1, current_date, $2)
			 on conflict (person_id, day) do update set sent = cuby_whatsapp_usage.sent + excluded.sent returning sent`,
			[opts.personId, count],
		);
		if (used!.sent > config!.daily_per_person)
			throw new Error(`Se llegó al tope de ${config!.daily_per_person} mensajes de Cuby WhatsApp de hoy.`);
	}
	let threadId =
		opts.threadId ??
		(opts.thread
			? null
			: ((
					await row<{ thread_id: string | null }>(
						`select c.thread_id from whatsapp_chats c join whatsapp_numbers n on n.id = c.number_id
						 where n.provider = 'cuby' and c.phone = $1 and c.awake_until > now()`,
						[canonical(phone)],
					)
				)?.thread_id ?? null));
	const to = `+${phone.replace(/\D/g, '')}`;
	const target = () =>
		threadId
			? { threadId }
			: opts.thread
				? { to, thread: { title: opts.thread.slice(0, 80), expectsReplyHours: 24 } }
				: { to };
	const post = async (body: Record<string, unknown>) => {
		const r = await api<{ threadId: string | null }>('POST', '/v1/messages', { ...target(), ...body });
		threadId ??= r.threadId;
	};
	console.log(
		`cuby-whatsapp → …${phone.slice(-4)}: ${count} mensaje(s), ${threadId ? 'en su hilo' : opts.thread ? 'hilo nuevo' : 'conversación general'}`,
	);
	if (text.trim()) await post({ text: text.slice(0, 4096) });
	for (const f of files)
		await post(
			/^image\/(jpeg|png|webp)$/.test(f.mime)
				? { image: { base64: f.data } }
				: DOCUMENT.test(f.name)
					? { document: { base64: f.data, fileName: f.name.slice(0, 200) } }
					: // The service takes only common documents: anything else (an HTML report) goes zipped.
						{
							document: {
								base64: zipOne(f.name, Buffer.from(f.data, 'base64')).toString('base64'),
								fileName: `${f.name.slice(0, 190)}.zip`,
							},
						},
		);
	return threadId;
}

/** A group of this number with one person (#18): its thread id, which is how it is written to and closed. */
export async function createGroup(title: string, phone: string, photo?: string) {
	if (!active()) throw new Error('Cuby WhatsApp está apagado.');
	const r = await api<{ threadId: string; members: { phone: string; status: string; reason: string | null }[] }>(
		'POST',
		'/v1/groups',
		{
			title: title.slice(0, 100),
			members: [`+${phone.replace(/\D/g, '')}`],
			listen: 'all',
			// Only when it is created: the service changes no photo afterwards.
			...(photo ? { photo: { base64: photo } } : {}),
		},
		60_000,
	);
	const m = r.members?.[0];
	if (m?.status === 'failed') throw new Error(`No se pudo meter al grupo (${m.reason ?? 'error'}).`);
	return r.threadId;
}

/** Puts a phone (of the integration's list) back in a group it created: added, or invited when WhatsApp
 * does not let the number add them. Throws with WhatsApp's reason when neither worked. */
export async function addMember(threadId: string, phone: string) {
	if (!active()) throw new Error('Cuby WhatsApp está apagado.');
	const r = await api<{ added: { phone: string; status: string; reason: string | null }[] }>(
		'POST',
		`/v1/threads/${encodeURIComponent(threadId)}/members`,
		{ add: [`+${phone.replace(/\D/g, '')}`] },
		60_000,
	);
	const m = r.added?.[0];
	if (!m || m.status === 'failed') throw new Error(`No se pudo meter al grupo (${m?.reason ?? 'error'}).`);
	return m.status;
}

/**
 * Into a group this integration created (by its thread; that also reopens it if it was closed): the text,
 * then each file. The ids of what went out, so a reply quoting one goes back to its agent.
 */
export async function sendGroup(
	threadId: string,
	text: string,
	files: { name: string; mime: string; data: string }[] = [],
	personId?: number,
) {
	if (!active()) throw new Error('Cuby WhatsApp está apagado.');
	const takes = (f: { name: string; mime: string }) => /^image\/(jpeg|png|webp)$/.test(f.mime) || DOCUMENT.test(f.name);
	if (files.some(takes)) files = files.filter(takes);
	const count = (text.trim() ? 1 : 0) + files.length;
	if (personId && count) {
		const used = await row<{ sent: number }>(
			`insert into cuby_whatsapp_usage (person_id, day, sent) values ($1, current_date, $2)
			 on conflict (person_id, day) do update set sent = cuby_whatsapp_usage.sent + excluded.sent returning sent`,
			[personId, count],
		);
		if (used!.sent > config!.daily_per_person)
			throw new Error(`Se llegó al tope de ${config!.daily_per_person} mensajes de Cuby WhatsApp de hoy.`);
	}
	const ids: string[] = [];
	const post = async (body: Record<string, unknown>) =>
		ids.push((await api<{ id: string }>('POST', '/v1/messages', { threadId, ...body })).id);
	if (text.trim()) await post({ text: text.slice(0, 4096) });
	for (const f of files)
		await post(
			/^image\/(jpeg|png|webp)$/.test(f.mime)
				? { image: { base64: f.data } }
				: DOCUMENT.test(f.name)
					? { document: { base64: f.data, fileName: f.name.slice(0, 200) } }
					: {
							document: {
								base64: zipOne(f.name, Buffer.from(f.data, 'base64')).toString('base64'),
								fileName: `${f.name.slice(0, 190)}.zip`,
							},
						},
		);
	console.log(`cuby-whatsapp → grupo: ${ids.length} mensaje(s)`);
	return ids;
}

/** Closes a session's thread, with a last message when given (the sleep notice, the goodbye). */
export async function closeThread(threadId: string, text?: string) {
	await api('POST', `/v1/threads/${encodeURIComponent(threadId)}/close`, text ? { text } : {});
}

/** Who the integration may talk to: the number's allow list (the admins' and each person's own phone). */
export async function syncAllowlist() {
	if (!active()) return;
	const phones = await rows<{ phone: string; label: string }>(
		`select w.phone, coalesce(p.name, nullif(w.label, ''), 'Invitado') as label
		 from whatsapp_phones w join whatsapp_numbers n on n.id = w.number_id left join people p on p.id = w.person_id
		 where n.provider = 'cuby' and w.list = 'allow'`,
	);
	const r = await api<{ count: number }>('PUT', '/v1/allowlist', {
		phones: phones.map((p) => ({ phone: `+${p.phone}`, label: p.label.slice(0, 200) })),
	});
	Object.assign(status, { allowlistSyncedAt: Date.now(), allowlistCount: r.count });
}

/** The connection, as the Cuby number's state in the lists. */
export const state = () => (!active() ? 'unlinked' : status.connected ? 'connected' : 'down');

// ---------- each person's phone ----------

async function cubyNumber() {
	return row<{ id: number }>("select id from whatsapp_numbers where provider = 'cuby' and deleted_at is null");
}

export async function linkView(me: Person) {
	const n = await cubyNumber();
	const linked = n
		? await row<{ phone: string }>(
				"select phone from whatsapp_phones where number_id = $1 and person_id = $2 and list = 'allow'",
				[n.id, me.id],
			)
		: null;
	return { available: active() && !!n, shownPhone: config?.shown_phone ?? '', linked: linked?.phone ?? null };
}

/**
 * Your phone on the company number, as you write it: no code from it (Angel, 2-nov-2026). Refused when it
 * is blocked or already another person's; a guest entry of that phone becomes yours. Then your groups follow.
 */
export async function startLink(me: Person, input: { phone?: unknown }) {
	const n = await cubyNumber();
	if (!active() || !n) throw new Error('Cuby WhatsApp no está activo.');
	const phone = canonical(input.phone);
	if (!PHONE.test(phone)) throw new Error('Escribe tu teléfono con lada, p. ej. +52 444 123 4567.');
	if (phone === canonical(config?.shown_phone ?? '')) throw new Error('Ese es el número de la empresa, no el tuyo.');
	await tx(async (c) => {
		const taken = await row<{ list: string; person_id: number | null }>(
			'select list, person_id from whatsapp_phones where number_id = $1 and phone = $2',
			[n.id, phone],
			c,
		);
		if (taken?.list === 'block') throw new Error('Ese teléfono está bloqueado en Cuby WhatsApp: pídele a un admin.');
		if (taken?.person_id && taken.person_id !== me.id)
			throw new Error('Ese teléfono ya es de otra persona en Agents. Si es tuyo, pídele a un admin que lo cambie.');
		await exec(
			'delete from whatsapp_phones where number_id = $1 and (person_id = $2 or phone = $3)',
			[n.id, me.id, phone],
			c,
		);
		await exec(
			"insert into whatsapp_phones (number_id, phone, list, person_id, label) values ($1, $2, 'allow', $3, '')",
			[n.id, phone, me.id],
			c,
		);
	});
	await afterLink();
	return linkView(me);
}

export async function unlink(me: Person) {
	const n = await cubyNumber();
	if (n) await exec('delete from whatsapp_phones where number_id = $1 and person_id = $2', [n.id, me.id]);
	await afterLink();
	return linkView(me);
}

/** The service's list and the groups follow a phone that came or went. */
async function afterLink() {
	await syncAllowlist().catch((err) => console.error('cuby-whatsapp allowlist:', (err as Error).message));
	void import('./whatsapp').then((w) => w.syncGroups());
}
