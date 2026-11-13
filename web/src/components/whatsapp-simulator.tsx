// Conversaciones simuladas (Angel 9-nov-2026): its owner's switch, and the simulator where they write as the
// agent's contacts. While on, what the agent would say by WhatsApp to a member's group, a direct guest or an
// external contact (its encargos too) shows here instead, and what is written here reaches it the way that
// person's message would. What it tells its owner stays real: they talk to it from their own WhatsApp. Its switch
// and its contacts' tiles live in Configuración → General → Experimental; its chats, in the agent's Conversaciones
// (agent-chats.tsx), where a simulated encargo opens its chat too (openSimulator).
import { useEffect, useState } from 'react';
import { api } from '@/api';

export type SimContact = Chat;
type Chat = {
	chat: string;
	kind: 'group' | 'direct' | 'external';
	role: 'person' | 'guest' | 'direct' | 'external';
	name: string;
	shown: string;
	last: {
		id: number;
		direction: 'in' | 'out';
		author: string;
		text: string;
		actor: boolean;
		created_at: number;
	} | null;
	/** GPT playing this contact; on «auto» it answers the agent until the conversation is done. */
	actor: Actor | null;
};
type Actor = {
	persona: string | null;
	goal: string | null;
	auto: boolean;
	replies: number;
	max_replies: number;
	stopped: string | null;
	/** Why it answered or kept quiet, last time. */
	note: string | null;
};
export const ROLE: Record<Chat['role'], string> = {
	person: 'Persona con quien lo compartiste · su grupo',
	guest: 'Invitado · su grupo',
	direct: 'Invitado directo · uno a uno',
	external: 'Contacto externo · uno a uno',
};
export const SIMULATION_EXPLAIN =
	'Mientras está encendido, lo que este agente le diría por WhatsApp a sus contactos (miembros, invitados y contactos externos, también sus encargos) aparece aquí en vez de enviarse, y lo que escribes aquí le llega como si esa persona lo hubiera mandado. Lo que te dice a ti sí te llega a tu WhatsApp. Sus conversaciones y encargos simulados quedan marcados y separados de los reales.';

/** Opens one simulated chat in the agent's Conversaciones, from anywhere: a simulated encargo, say. */
export function openSimulator(agentId: number, chat: string) {
	window.location.hash = `#/agent/${agentId}/whatsapp/s${chat}`;
}

export const initials = (name: string) =>
	name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0]!.toUpperCase())
		.join('') || '?';

/** Its simulated chats (each contact switched on for it, with its last line and its AI actor), polled while shown. */
export function useSimChats(agentId: number, enabled = true) {
	const [chats, setChats] = useState<Chat[] | null>(null);
	const [error, setError] = useState('');
	const [version, setVersion] = useState(0);
	useEffect(() => {
		if (!enabled) return;
		let gone = false;
		const load = () =>
			api<{ chats: Chat[] }>(`/agents/${agentId}/sim`)
				.then((r) => {
					if (gone) return;
					setChats(r.chats);
					setError('');
				})
				.catch((e) => !gone && setError((e as Error).message));
		void load();
		const timer = setInterval(load, 4_000);
		return () => {
			gone = true;
			clearInterval(timer);
		};
	}, [agentId, enabled, version]);
	return { chats, error, reload: () => setVersion((v) => v + 1) };
}
