// WhatsApp, one number for every agent (the bridge in ../../whatsapp, whatsmeow). The admin links
// it; each owner turns it on per agent and lists who may write. A phone talks to one agent at a
// time (/agente <nombre> switches). The agent's answer goes back to whoever wrote; scheduled and
// webhook work tells the contacts marked for notices how it ended.
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { row, rows, exec, tx, DATA_DIR } from './db';
import { receive } from './inbox';
import { decodeHelp } from './help';

const URL_ = process.env.AGENTS_WHATSAPP_URL ?? '';
const SECRET = process.env.AGENTS_WHATSAPP_SECRET ?? '';
export const enabled = () => !!URL_ && !!SECRET;
const PHONE = /^[0-9]{8,15}$/;
const MAX_CONTACTS = 20;

export function checkSecret(header: string | undefined) {
	if (!enabled() || !header) return false;
	const a = Buffer.from(header), b = Buffer.from(SECRET);
	return a.length === b.length && timingSafeEqual(a, b);
}

async function bridge<T = any>(path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
	if (!enabled()) throw new Error('El puente de WhatsApp no está configurado en este servidor.');
	const res = await fetch(`${URL_}${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { 'x-agents-secret': SECRET, 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs)
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error((data as { error?: string }).error ?? `El puente de WhatsApp respondió ${res.status}.`);
	return data as T;
}

export type Status = { state: 'off' | 'down' | 'unlinked' | 'pairing' | 'connecting' | 'connected'; phone?: string; name?: string; qr?: string; error?: string };

/** The admin's view; `off` when this server has no bridge, `down` when it does not answer. */
export async function status(): Promise<Status> {
	if (!enabled()) return { state: 'off' };
	try { return await bridge<Status>('/status', undefined, 5000); } // views wait on this: fail fast
	catch (err) { return { state: 'down', error: (err as Error).message }; }
}
export const pair = () => bridge('/pair', {});
export const logout = () => bridge('/logout', {});

// ---------- per agent: the owner's switch and contact list ----------

export type Contact = { phone: string; label: string; notify: boolean };

export async function agentView(agentId: number) {
	const s = await status();
	const a = await row<{ whatsapp_enabled: boolean }>('select whatsapp_enabled from agents where id = $1', [agentId]);
	const contacts = await rows<Contact>('select phone, label, notify from whatsapp_contacts where agent_id = $1 order by created_at, phone', [agentId]);
	return { available: s.state === 'connected', phone: s.state === 'connected' ? s.phone ?? null : null, enabled: !!a?.whatsapp_enabled, contacts };
}

/** Replaces the switch and the list; numbers are digits with their country code (52…). */
export async function setAgent(agentId: number, input: { enabled?: unknown; contacts?: unknown }) {
	const list = Array.isArray(input.contacts) ? input.contacts : [];
	if (list.length > MAX_CONTACTS) throw new Error(`Hasta ${MAX_CONTACTS} números por agente.`);
	const contacts = list.map((c: any) => {
		const phone = String(c?.phone ?? '').replace(/\D/g, '');
		if (!PHONE.test(phone)) throw new Error(`«${c?.phone ?? ''}» no es un número válido: escribe lada de país y número, por ejemplo 5215512345678.`);
		return { phone, label: String(c?.label ?? '').trim().slice(0, 60), notify: !!c?.notify };
	});
	if (new Set(contacts.map((c) => c.phone)).size !== contacts.length) throw new Error('Hay números repetidos.');
	await tx(async (c) => {
		await exec('update agents set whatsapp_enabled = $2 where id = $1', [agentId, !!input.enabled], c);
		await exec('delete from whatsapp_contacts where agent_id = $1', [agentId], c);
		for (const k of contacts) await exec('insert into whatsapp_contacts (agent_id, phone, label, notify) values ($1, $2, $3, $4)', [agentId, k.phone, k.label, k.notify], c);
		// A phone that may no longer write to this agent stops talking to it.
		await exec('update whatsapp_sessions set agent_id = null where agent_id = $1 and ($2 = false or not (phone = any($3::text[])))', [agentId, !!input.enabled, contacts.map((k) => k.phone)], c);
	});
	return agentView(agentId);
}

// ---------- inbound ----------

type Reachable = { id: number; name: string };
const reachable = (phone: string) =>
	rows<Reachable>(
		`select a.id, a.name from agents a join whatsapp_contacts c on c.agent_id = a.id
		 where c.phone = $1 and a.whatsapp_enabled and a.deleted_at is null order by a.name, a.id`,
		[phone]
	);

const send = (phone: string, text: string, files: { name: string; mime: string; data: string }[] = []) => bridge('/send', { phone, text, files });
const menu = (list: Reachable[], current?: number) =>
	list.map((a, i) => `${i + 1}. ${a.name}${a.id === current ? ' (activo)' : ''}`).join('\n') + '\n\nEscribe /agente y el número o el nombre para cambiar.';

/** One direct message from the bridge. Unknown numbers get no answer: nothing reveals the agents. */
export async function inbound(m: { id?: unknown; phone?: unknown; name?: unknown; text?: unknown; files?: unknown }) {
	const phone = String(m.phone ?? '');
	const id = String(m.id ?? '').slice(0, 200);
	if (!PHONE.test(phone) || !id) throw new Error('Mensaje de WhatsApp inválido.');
	const list = await reachable(phone);
	if (!list.length) return { ignored: true };
	const text = String(m.text ?? '').trim().slice(0, 20_000);
	const session = await row<{ agent_id: number | null }>('select agent_id from whatsapp_sessions where phone = $1', [phone]);
	let active = list.find((a) => a.id === session?.agent_id) ?? (list.length === 1 ? list[0] : undefined);

	const command = text.match(/^\/(agentes|agente|ayuda)\b\s*(.*)$/i);
	if (command) {
		const arg = command[2].trim().toLowerCase();
		if (command[1].toLowerCase() === 'agente' && arg) {
			const pick = /^\d+$/.test(arg) ? list[Number(arg) - 1] : list.find((a) => a.name.toLowerCase() === arg) ?? list.find((a) => a.name.toLowerCase().startsWith(arg));
			if (!pick) { await send(phone, `No encontré ese agente. Puedes hablar con:\n${menu(list, active?.id)}`); return { command: true }; }
			await setSession(phone, pick.id);
			await send(phone, `Ahora hablas con ${pick.name}.`);
			return { command: true };
		}
		await send(phone, `Puedes hablar con:\n${menu(list, active?.id)}`);
		return { command: true };
	}
	if (!active) {
		await send(phone, `¿Con qué agente quieres hablar?\n${menu(list)}`);
		return { needsAgent: true };
	}
	if (session?.agent_id !== active.id) await setSession(phone, active.id);
	const files = (Array.isArray(m.files) ? m.files : []).slice(0, 10).map((f: any) => ({ name: String(f?.name ?? 'archivo'), mime: String(f?.mime ?? 'application/octet-stream'), data: String(f?.data ?? '') }));
	if (!text && !files.length) return { ignored: true };
	const name = String(m.name ?? '').trim().slice(0, 80);
	return receive({ agentId: active.id, source: 'whatsapp', sender: name ? `${name} (+${phone})` : `+${phone}`, text, attachments: files, context: { whatsapp: { phone } }, dedupeKey: `wa:${id}` }, { routeNow: false });
}

const setSession = (phone: string, agentId: number) =>
	exec('insert into whatsapp_sessions (phone, agent_id) values ($1, $2) on conflict (phone) do update set agent_id = excluded.agent_id, updated_at = now()', [phone, agentId]);

// ---------- outbound: answers and notices ----------

const OUT_FILES = 5;
const chunk = (text: string) => (text.length > 3500 ? `${text.slice(0, 3500)}\n\n… (sigue en la web de Agents)` : text);

/**
 * How a run ended (or that it is blocked), to WhatsApp. The phones that wrote to this run get the
 * answer; when nobody wrote from WhatsApp, work from a schedule or webhook notifies the agent's
 * contacts marked for notices. Never throws: a failed send must not change how the run ended.
 */
export async function onRun(runId: number, event: 'done' | 'incomplete' | 'cancelled' | 'error' | 'blocked', reason: string | null = null) {
	if (!enabled()) return;
	try {
		const r = await row<{ agent_id: number; name: string; answer: string | null; end_reason: string | null; whatsapp_enabled: boolean }>(
			'select r.agent_id, a.name, r.answer, r.end_reason, a.whatsapp_enabled from runs r join agents a on a.id = r.agent_id where r.id = $1',
			[runId]
		);
		if (!r?.whatsapp_enabled) return;
		const sources = await rows<{ source: string; phone: string | null }>(
			"select source, context->'whatsapp'->>'phone' as phone from messages where run_id = $1",
			[runId]
		);
		const writers = [...new Set(sources.filter((s) => s.source === 'whatsapp' && s.phone).map((s) => s.phone!))];
		const unattended = !writers.length && sources.some((s) => s.source === 'cron' || s.source === 'hook');
		const phones = writers.length ? writers : unattended ? (await rows<{ phone: string }>('select phone from whatsapp_contacts where agent_id = $1 and notify', [r.agent_id])).map((c) => c.phone) : [];
		if (!phones.length) return;
		const head = writers.length ? '' : `${r.name}: `;
		let text: string;
		let files: { name: string; mime: string; data: string }[] = [];
		if (event === 'blocked') {
			const help = decodeHelp(reason);
			const questions = help.questions.map((q, i) => `${i + 1}. ${q.title}\n${q.options.map((o) => `   - ${o.label}`).join('\n')}`).join('\n\n');
			text = `${head}Necesito tu ayuda: ${help.reason}${questions ? `\n\n${questions}` : ''}\n\nResponde aquí para que siga.`;
		} else if (event === 'done') {
			text = `${head}${r.answer ?? 'Terminé.'}`;
			files = await outputs(runId);
		} else {
			text = `${head}${event === 'cancelled' ? 'Se canceló el trabajo.' : `No pude terminar: ${r.end_reason ?? 'error'}`}`;
		}
		for (const phone of phones) await send(phone, chunk(text), files).catch((err) => console.error(`whatsapp run ${runId} → ${phone}:`, (err as Error).message));
	} catch (err) {
		console.error(`whatsapp run ${runId}:`, (err as Error).message);
	}
}

/** The files the run left in ~/work/out, the first few and only those WhatsApp takes (10 MB). */
async function outputs(runId: number) {
	const files = await rows<{ name: string; mime: string; path: string; size: number }>(
		"select name, mime, path, size from files where run_id = $1 and direction = 'out' and size <= 10485760 order by id limit $2",
		[runId, OUT_FILES]
	);
	return files.flatMap((f) => {
		try { return [{ name: f.name, mime: f.mime, data: readFileSync(join(DATA_DIR, f.path)).toString('base64') }]; }
		catch { return []; }
	});
}
