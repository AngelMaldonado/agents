// El auditor de los trabajos (Angel 10-nov-2026, after Codex's completion audit and pi-goal-x's independent
// auditor): when an agent says its trabajo is done (job_done), another GPT call checks the claim against its
// objective with the trabajo's own record (what was asked, its tasks and their results, its encargos, what the
// agent answered). Its claim is not evidence. «Not yet» comes back to the agent as its next step.
import { row, rows } from './db';
import { askJson } from './gpt';

export type Verdict = { verdict: 'met' | 'not_yet' | 'impossible'; reason: string };

const SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['verdict', 'reason'],
	properties: {
		verdict: { type: 'string', enum: ['met', 'not_yet', 'impossible'] },
		reason: {
			type: 'string',
			description: 'En una o dos frases: la evidencia de que se cumplió, lo concreto que falta, o por qué no se puede.',
		},
	},
};

const INSTRUCTIONS = [
	'Eres un auditor independiente. Decides si el trabajo de un asistente de IA cumplió su objetivo, sólo con la evidencia que se te da.',
	'El resumen y el resultado que escribe el asistente son su afirmación, no evidencia: compruébalos contra lo que se pidió, sus tareas y sus resultados, sus encargos y lo que respondió.',
	'Trata el terminado como no probado. Para cada requisito explícito del objetivo, busca evidencia concreta; si es incierta o indirecta, ese requisito no está cumplido. La auditoría debe probar que se cumplió, no sólo no encontrar pendientes.',
	'No exijas más de lo que pide el objetivo ni lo redefinas por uno más fácil. Lo que su dueño decidió o autorizó en la conversación cuenta como parte del objetivo.',
	'verdict: met (cumplido, con evidencia); not_yet (falta algo concreto que el asistente puede hacer: dilo en reason como su siguiente paso); impossible (no se puede cumplir tal como está: di por qué). reason breve, en español.',
].join('\n\n');

/** The model, replaced in tests. */
export const auditor = {
	ask: (personId: number, model: string, input: string) =>
		askJson<Verdict>(personId, model, INSTRUCTIONS, input, SCHEMA, {
			name: 'auditoria_de_trabajo',
			label: 'auditor de trabajos',
			maxTokens: 1500,
		}),
};

const cut = (v: unknown, n = 400) => {
	const t = typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v);
	return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** Checks a job_done against its trabajo's record. */
export async function audit(conversationId: number, claim: { summary: string; result: unknown }): Promise<Verdict> {
	const c = (await row<{ agent_id: number; goal: string | null; title: string }>(
		'select agent_id, goal, title from conversations where id = $1',
		[conversationId],
	))!;
	const a = (await row<{ model: string; person_id: number; name: string }>(
		'select model, person_id, name from agents where id = $1',
		[c.agent_id],
	))!;
	const asked = await rows<{ source: string; sender: string | null; text: string }>(
		`select source, sender, text from (select id, source, sender, text from messages
		   where conversation_id = $1 and source <> 'flow' order by id desc limit 12) m order by id`,
		[conversationId],
	);
	const answered = await rows<{ answer: string }>(
		`select answer from (select id, answer from runs where conversation_id = $1 and answer is not null order by id desc limit 5) r order by id`,
		[conversationId],
	);
	const tasks = await rows<{ title: string; status: string; note: string | null; result: unknown }>(
		`select s.title, s.status, s.note, s.result from flow_steps s join flows f on f.id = s.flow_id
		 where f.conversation_id = $1 and s.status <> 'removed' order by f.id, s.position`,
		[conversationId],
	);
	const encargos = await rows<{ contact: string; name: string; status: string; summary: string | null; data: unknown }>(
		`select contact, template->>'name' as name, status, summary, data from delegations where conversation_id = $1 order by id`,
		[conversationId],
	);
	const input = [
		`Objetivo del trabajo: ${c.goal ?? `(no declarado; el trabajo se llama «${c.title}»)`}`,
		`Lo que pidieron (lo más reciente al final):\n${asked.map((m) => `- [${m.source}${m.sender ? `, ${cut(m.sender, 80)}` : ''}] ${cut(m.text)}`).join('\n') || '(nada)'}`,
		`Sus tareas:\n${tasks.map((t) => `- ${t.title}: ${t.status}${t.note ? ` (${cut(t.note, 200)})` : ''}${t.result ? ` → ${cut(t.result, 300)}` : ''}`).join('\n') || '(sin lista)'}`,
		`Sus encargos:\n${encargos.map((e) => `- ${e.name} con ${e.contact}: ${e.status}${e.summary ? `; ${cut(e.summary, 300)}` : ''}${e.data ? `; datos: ${cut(e.data, 300)}` : ''}`).join('\n') || '(ninguno)'}`,
		`Lo que respondió ${a.name} (lo más reciente al final):\n${answered.map((r) => `- ${cut(r.answer, 500)}`).join('\n') || '(nada)'}`,
		`Su afirmación al terminar (no es evidencia):\nResumen: ${cut(claim.summary, 1500)}${claim.result !== undefined ? `\nResultado: ${cut(claim.result, 800)}` : ''}`,
	].join('\n\n');
	return (await auditor.ask(a.person_id, a.model, input)).value;
}
