// Actores del simulador (Angel 10-nov-2026): GPT plays one of the agent's contacts in its WhatsApp simulator, so
// a flow with people can be tested without anyone writing. On «auto», each time the agent (or its encargo)
// writes to that chat, the actor answers as that person would, through the same path as its owner typing
// (whatsapp.simulate), until it judges the conversation done, the chat's encargo ends, it reaches its cap or
// its owner stops it. A sweeper (not timers) moves it: it survives a restart.
import { row, rows, exec } from './db';
import { askJson } from './gpt';
import * as sim from './whatsapp-sim';
import type { Person } from './people';

export type Actor = {
	chat: string;
	persona: string | null;
	goal: string | null;
	auto: boolean;
	replies: number;
	max_replies: number;
	stopped: string | null;
	/** The agent's last line it already considered (it does not ask about it again); -1: an empty chat. */
	seen_id: number | null;
	/** Why it answered or kept quiet, last time. */
	note: string | null;
};
type Turn = { message: string | null; done: boolean; reason: string };

/** The agent writes several messages in a row: the actor answers once they settle (ms). */
const SETTLE_MS = 3_000;

const SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['message', 'done', 'reason'],
	properties: {
		message: {
			type: ['string', 'null'],
			description: 'Lo que esa persona contesta por WhatsApp; null si no contesta.',
		},
		done: { type: 'boolean', description: 'Ahora no hace falta contestar (lo que se buscaba ya quedó resuelto).' },
		reason: { type: 'string', description: 'Por qué sigue o por qué termina, en una frase.' },
	},
};

/** The model, replaced in tests. */
export const actorModel = {
	ask: (personId: number, agentModel: string, instructions: string, transcript: string) =>
		askJson<Turn>(personId, agentModel, instructions, transcript, SCHEMA, {
			name: 'respuesta_de_contacto',
			label: 'actor del simulador',
			maxTokens: 1500,
		}),
};

export async function list(agentId: number) {
	return rows<Actor>(
		'select chat, persona, goal, auto, replies, max_replies, stopped, seen_id, note from whatsapp_sim_actors where agent_id = $1',
		[agentId],
	);
}

/** Its owner saves who the person is and what they want, and turns it on (auto) or off. */
export async function set(
	agentId: number,
	chat: string,
	input: { persona?: unknown; goal?: unknown; auto?: unknown },
): Promise<Actor> {
	if (!sim.CHAT.test(chat)) throw new Error('Chat inválido.');
	const persona =
		input.persona === undefined
			? undefined
			: String(input.persona ?? '')
					.trim()
					.slice(0, 3000) || null;
	const goal =
		input.goal === undefined
			? undefined
			: String(input.goal ?? '')
					.trim()
					.slice(0, 1000) || null;
	const auto = typeof input.auto === 'boolean' ? input.auto : undefined;
	const a = (await row<Actor>(
		`insert into whatsapp_sim_actors (agent_id, chat, persona, goal, auto, replies, stopped)
		 values ($1, $2, $3, $4, coalesce($5::boolean, true), 0, null)
		 on conflict (agent_id, chat) do update set
		   persona = case when $6::boolean then excluded.persona else whatsapp_sim_actors.persona end,
		   goal = case when $7::boolean then excluded.goal else whatsapp_sim_actors.goal end,
		   auto = coalesce($5::boolean, whatsapp_sim_actors.auto),
		   -- Turning it on starts over; turning it off says who did.
		   replies = case when $5::boolean then 0 else whatsapp_sim_actors.replies end,
		   stopped = case when $5::boolean then null when not $5::boolean then 'lo detuviste' else whatsapp_sim_actors.stopped end,
		   seen_id = case when $5::boolean then null else whatsapp_sim_actors.seen_id end,
		   note = case when $5::boolean then null else whatsapp_sim_actors.note end,
		   updated_at = now()
		 returning chat, persona, goal, auto, replies, max_replies, stopped, seen_id, note`,
		[agentId, chat, persona ?? null, goal ?? null, auto ?? null, persona !== undefined, goal !== undefined],
	))!;
	if (a.auto) void tick(agentId, chat);
	return a;
}

async function halt(agentId: number, chat: string, why: string) {
	await exec(
		'update whatsapp_sim_actors set auto = false, stopped = $3, updated_at = now() where agent_id = $1 and chat = $2',
		[agentId, chat, why],
	);
}

/** It considered the agent's line `seen` (it answered or kept quiet, and why): it listens for the next one. */
async function seen(agentId: number, chat: string, seenId: number, note: string) {
	await exec(
		'update whatsapp_sim_actors set seen_id = $3, note = $4, updated_at = now() where agent_id = $1 and chat = $2',
		[agentId, chat, seenId, note.slice(0, 300)],
	);
}

const busy = new Set<string>();

/**
 * One step of one actor: if the agent spoke last (and stopped writing), the actor answers as its person, or keeps
 * quiet when nothing needs an answer; either way it keeps listening, through the whole trabajo. It starts a chat
 * nobody opened only when it has something it wants (its goal). It stops when that trabajo ends, at its cap,
 * when its owner stops it or the simulation is off.
 */
export async function tick(agentId: number, chat: string, now = Date.now()) {
	const key = `${agentId}:${chat}`;
	if (busy.has(key)) return;
	busy.add(key);
	try {
		const a = await row<Actor>(
			'select chat, persona, goal, auto, replies, max_replies, stopped, seen_id, note from whatsapp_sim_actors where agent_id = $1 and chat = $2',
			[agentId, chat],
		);
		if (!a?.auto) return;
		// Paused, not off: its switch stays as its owner left it, and it answers again once the simulation is back.
		if (!(await sim.on(agentId))) return;
		const lines = (await sim.messages(agentId, chat)).slice(-60);
		const last = lines.at(-1);
		if (last ? last.direction === 'in' : !a.goal) return; // its turn is the agent's
		if (last && now - last.created_at < SETTLE_MS) return; // the agent may still be writing
		if ((last?.id ?? -1) <= (a.seen_id ?? -2)) return; // already considered: it waits for the agent's next line
		if (a.replies >= a.max_replies) return halt(agentId, chat, `llegó a su tope de ${a.max_replies} respuestas`);
		// The chat's encargo (its latest): over, there is nobody left to answer.
		const encargoId = [...lines].reverse().find((l) => l.delegation_id)?.delegation_id ?? null;
		const encargo = encargoId
			? await row<{
					status: string;
					contact: string;
					template: { objective: string };
					params: Record<string, string>;
					conversation_id: number | null;
				}>('select status, contact, template, params, conversation_id from delegations where id = $1', [encargoId])
			: null;
		// Its trabajo (where the chat's messages land, or its encargo's) ended: it waits for the agent's next line.
		const trabajo = await row<{ status: string }>(
			`select c.status from conversations c where c.deleted_at is null and c.id = coalesce(
			   (select conversation_id from whatsapp_sim_chats where agent_id = $1 and chat = $2), $3)`,
			[agentId, chat, encargo?.conversation_id ?? null],
		);
		if (trabajo && trabajo.status !== 'open')
			return seen(agentId, chat, last?.id ?? 0, 'El trabajo terminó: espera a que el agente vuelva a escribir.');
		// Its encargo over: nothing to answer until the agent writes again (another encargo, a notice).
		if (encargo && encargo.status !== 'active')
			return seen(agentId, chat, last!.id, 'El encargo terminó: espera a que el agente vuelva a escribir.');
		const ag = (await row<{ name: string; model: string; owner_id: number; owner: string }>(
			`select a.name, a.model, a.person_id as owner_id, p.name as owner
			 from agents a join people p on p.id = a.person_id where a.id = $1`,
			[agentId],
		))!;
		const owner = { id: ag.owner_id, admin: false } as Person;
		const whatsapp = await import('./whatsapp');
		const contact = (await whatsapp.simChats(agentId, owner)).find((c) => c.chat === chat);
		if (!contact)
			return seen(agentId, chat, last?.id ?? 0, 'Ese contacto ya no está encendido para el agente: espera.');
		const objective = encargo
			? encargo.template.objective.replace(/\{(\w+)\}/g, (all, k: string) => encargo.params[k] ?? all)
			: null;
		const who = {
			person: `una persona con quien ${ag.owner} compartió a ${ag.name}`,
			guest: `un invitado de ${ag.owner} que habla con sus agentes por WhatsApp`,
			direct: `un invitado de ${ag.owner} que habla con ${ag.name} uno a uno por WhatsApp`,
			external: `un contacto externo de ${ag.owner} (un proveedor, un cliente, alguien de fuera)`,
		}[contact.role];
		const instructions = [
			`Eres ${contact.name}, ${who}. Hablas por WhatsApp con ${ag.name}, un asistente de IA de ${ag.owner}.`,
			'Contesta exactamente como lo haría esa persona real: breve, natural, en español de México y con el tono de WhatsApp (a veces una sola palabra). No digas que eres una IA ni que esto es una prueba.',
			'Tu personaje manda: sus datos (precios, horarios, condiciones) son los verdaderos; si algo dicho antes en el chat los contradice, corrígelo con naturalidad. Si te piden un dato que tu personaje no trae, invéntalo verosímil y sostenlo. No prometas ni confirmes nada que esa persona no haría sin pensarlo; puedes preguntar, negociar o corregir.',
			'Sólo existes en este chat: no te comprometas a hacer nada fuera de él (hablar con otra persona, consultar a alguien, ir a algún lugar, avisar después). Si algo depende de otra persona, dile al asistente que lo gestione él. Si te piden algo que sí puedes decidir tú, decídelo en tu respuesta.',
			'No inventes restricciones nuevas que cambien la tarea (presupuestos, topes, fechas, condiciones) salvo que estén en tu personaje.',
			`Tu personaje: ${a.persona || 'una persona común, amable y ocupada, que responde lo justo.'}`,
			a.goal ? `Lo que tú quieres de esta conversación: ${a.goal}` : '',
			objective ? `El asistente te escribe por un encargo; lo que busca: ${objective}` : '',
			'done: true cuando ahora no hace falta contestar (lo que se buscaba quedó resuelto, o ya se despidieron); entonces message va null o, si lo haría esa persona, una despedida breve. Sigues atento: si el asistente vuelve a escribir, contestas de nuevo.',
		]
			.filter(Boolean)
			.join('\n\n');
		const transcript = lines.length
			? lines.map((l) => `${l.direction === 'in' ? 'Tú' : ag.name}: ${l.text}`).join('\n')
			: '(Nadie ha escrito todavía: tú abres la conversación.)';
		const { value } = await actorModel.ask(ag.owner_id, ag.model, instructions, transcript);
		const text = value.message?.trim();
		if (text) {
			await whatsapp.simulate(agentId, owner, chat, { text }, true);
			await exec(
				'update whatsapp_sim_actors set replies = replies + 1, updated_at = now() where agent_id = $1 and chat = $2',
				[agentId, chat],
			);
		}
		await seen(
			agentId,
			chat,
			last?.id ?? -1,
			text ? value.reason || 'Contestó.' : `No hace falta contestar: ${value.reason || 'nada pendiente'}`,
		);
	} catch (err) {
		console.error(`actor del simulador ${key}:`, (err as Error).message);
		await halt(agentId, chat, `falló: ${(err as Error).message.slice(0, 200)}`).catch(() => {});
	} finally {
		busy.delete(key);
	}
}

/** Every actor on «auto» gets its step (the agent may have written to it). */
export async function sweep(now = Date.now()) {
	for (const a of await rows<{ agent_id: number; chat: string }>(
		'select agent_id, chat from whatsapp_sim_actors where auto',
	))
		await tick(a.agent_id, a.chat, now);
}

let sweeper: ReturnType<typeof setInterval> | null = null;
export function startActors() {
	sweeper ??= setInterval(
		() => void sweep().catch((err) => console.error('actores del simulador:', err.message)),
		2_000,
	);
	sweeper.unref?.();
}
