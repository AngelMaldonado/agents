// Interview UI data is not an executable tool call or an authorization.
export type Question = {
	id: string;
	title: string;
	description: string;
	selectionMode: 'single' | 'multi';
	options: { id: string; label: string; description: string }[];
	recommended: string | null;
};
export type Answer = { selected: string[]; other: string };
export type Answers = { round: number; values: Record<string, Answer> };
export type InterviewMessage = {
	role: 'user' | 'assistant';
	content: string;
	questions?: Question[];
	questionRound?: number;
	answers?: Answers;
	attachments?: { id: string; name: string; mime: string; size: number }[];
	/** The model's reasoning summary for this reply (shown folded). */
	reasoning?: string;
	/** The designer's searches in this reply and what they found (cards the owner adds or skips). */
	searches?: import('./tool-search').Search[];
	findings?: import('./tool-search').Finding[];
	/** Secrets the designer asked the owner to save (a secure card; the value never reaches the model). */
	secrets?: SecretRequest[];
};
export type SecretRequest = { name: string; description: string; domains: string[]; saved?: boolean };
export type QuestionRound = { round: number; questions: Question[] };
const slug = /^[a-z][a-z0-9-]{0,39}$/;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
function keys(v: Record<string, any>, names: string[]) {
	if (Object.keys(v).some((k) => !names.includes(k))) throw new Error('El cuestionario contiene campos desconocidos.');
}
function text(v: unknown, max: number, empty = false): string {
	if (typeof v !== 'string' || (!empty && !v.trim()) || v.length > max)
		throw new Error('El cuestionario contiene texto vacío o demasiado largo.');
	return v.trim();
}
// IDs are UI metadata, not permissions: repair only fresh model output, never saved
// rounds or submitted answers. Keep valid IDs; allocate safe unique aliases otherwise.
function questionId(value: unknown, kind: 'question' | 'option', index: number, used: Set<string>) {
	if (typeof value !== 'string' || value.length > 200)
		throw new Error('La IA devolvió un identificador de cuestionario malformado.');
	let id =
		slug.test(value) &&
		!['other', 'constructor', 'prototype'].includes(value) &&
		!Object.hasOwn(Object.prototype, value)
			? value
			: `${kind}-${index + 1}`;
	let suffix = 2;
	while (used.has(id)) id = `${kind}-${index + 1}-${suffix++}`;
	used.add(id);
	return id;
}
// The designer narrows in few questions (up to 4 a round); help questions stay at 3.
export const DESIGN_QUESTIONS = 4;
export function validateQuestions(v: unknown, max = 3): Question[] {
	if (!Array.isArray(v) || v.length > max) throw new Error(`Una ronda necesita de cero a ${max} preguntas.`);
	const ids = new Set<string>();
	return v.map((q, index) => {
		if (!object(q)) throw new Error('Pregunta inválida.');
		keys(q, ['id', 'title', 'description', 'selectionMode', 'options', 'recommended']);
		const id = questionId(q.id, 'question', index, ids);
		if (
			!['single', 'multi'].includes(q.selectionMode) ||
			!Array.isArray(q.options) ||
			q.options.length < 1 ||
			q.options.length > 4
		)
			throw new Error('Cada pregunta necesita de una a cuatro opciones y un modo válido.');
		const optionIds = new Set<string>();
		const options = q.options.map((o: unknown, optionIndex: number) => {
			if (!object(o)) throw new Error('Opción inválida.');
			keys(o, ['id', 'label', 'description']);
			return {
				id: questionId(o.id, 'option', optionIndex, optionIds),
				label: text(o.label, 200),
				description: text(o.description, 400, true),
			};
		});
		if (q.recommended !== null && (typeof q.recommended !== 'string' || q.recommended.length > 200))
			throw new Error('La recomendación del cuestionario tiene un formato inválido.');
		const matches =
			q.recommended === null
				? []
				: q.options.flatMap((o: { id: string }, i: number) => (o.id === q.recommended ? [options[i].id] : []));
		// A missing/ambiguous annotation is omitted, never guessed or pre-selected.
		const recommended = matches.length === 1 ? matches[0] : null;
		return {
			id,
			title: text(q.title, 300),
			description: text(q.description, 600, true),
			selectionMode: q.selectionMode,
			options,
			recommended,
		};
	});
}
export function interview(messages: InterviewMessage[]) {
	const asked = messages.filter(
		(m) => m.role === 'assistant' && m.questions?.length && Number.isSafeInteger(m.questionRound),
	);
	const answered = new Set(
		messages
			.filter((m) => m.role === 'user' && m.answers && asked.some((q) => q.questionRound === m.answers!.round))
			.map((m) => m.answers!.round),
	);
	const last = asked.at(-1);
	return {
		completed: answered.size,
		pending:
			last && !answered.has(last.questionRound!) ? { round: last.questionRound!, questions: last.questions! } : null,
	};
}
export function validateAnswers(value: unknown, pending: QuestionRound | null): { answers: Answers; content: string } {
	if (!pending || !object(value) || value.round !== pending.round || !object(value.values))
		throw new Error('El cuestionario cambió. Recarga antes de responder.');
	keys(value, ['round', 'values']);
	const supplied = Object.keys(value.values);
	if (
		supplied.length !== pending.questions.length ||
		supplied.some((id) => !pending.questions.some((q) => q.id === id))
	)
		throw new Error('Responde todas las preguntas de esta ronda, sin añadir otras.');
	const entries = pending.questions.map((q) => {
		const a = value.values[q.id];
		if (!object(a)) throw new Error('Respuesta inválida.');
		keys(a, ['selected', 'other']);
		if (
			!Array.isArray(a.selected) ||
			!a.selected.length ||
			a.selected.length > q.options.length + 1 ||
			(q.selectionMode === 'single' && a.selected.length !== 1)
		)
			throw new Error('Selecciona una respuesta válida para cada pregunta.');
		const allowed = new Set([...q.options.map((o) => o.id), 'other']);
		if (
			a.selected.some((s: unknown) => typeof s !== 'string' || !allowed.has(s)) ||
			new Set(a.selected).size !== a.selected.length
		)
			throw new Error('Hay opciones desconocidas o repetidas.');
		const other = text(a.other, 1000, !a.selected.includes('other'));
		if (!a.selected.includes('other') && other) throw new Error('El texto libre requiere seleccionar Otra respuesta.');
		return [q.id, { selected: [...a.selected] as string[], other }] satisfies [string, Answer];
	});
	const answers: Answers = { round: pending.round, values: Object.fromEntries(entries) };
	const content = pending.questions
		.map(
			(q, i) =>
				`${i + 1}. ${q.title}\n${answers.values[q.id].selected.map((id) => (id === 'other' ? answers.values[q.id].other : q.options.find((o) => o.id === id)!.label)).join('; ')}`,
		)
		.join('\n\n');
	return { answers, content };
}
export const FALLBACK_QUESTIONS: Question[] = [
	{
		id: 'scope',
		title: '¿Cómo quieres precisar el alcance antes de generar el contrato?',
		description: 'No voy a sustituir tu objetivo por una primera versión reducida sin que lo decidas.',
		selectionMode: 'single',
		options: [
			{
				id: 'clarify',
				label: 'Resolver primero las decisiones que falten',
				description: 'Pregúntame por el objetivo, fuentes, entregable y cuándo pedir aprobación.',
			},
			{
				id: 'specified',
				label: 'Mi prompt ya define el alcance; úsalo como base',
				description: 'Conserva ese objetivo y señala aparte los permisos o conexiones que falten.',
			},
		],
		recommended: 'clarify',
	},
];
/**
 * The draft can go to review: a restored revision, or no round pending and, for a new agent, at least one
 * answered (the interview narrows what the owner needs). An improvement may be proposed straight away.
 */
export function canReview(d: {
	messages: InterviewMessage[];
	restored_revision?: number | null;
	agent_id?: number | null;
}) {
	const state = interview(d.messages);
	return !!d.restored_revision || (!state.pending && (state.completed > 0 || !!d.agent_id));
}
// Model output cannot skip the human rounds or close unanswered questions.
export function interviewReply<
	T extends { message: string; questions: Question[]; contract: unknown; harness: unknown; ready: boolean },
>(messages: InterviewMessage[], reply: T, improving = false): T {
	const state = interview(messages);
	if (reply.questions.length) return { ...reply, contract: null, harness: null, ready: false };
	// An improvement may answer in plain words (no round, no proposal yet): the owner writes again.
	if (improving && !state.pending && !reply.ready) return { ...reply, contract: null, harness: null };
	if (state.pending || !reply.ready || (!state.completed && !improving))
		return {
			...reply,
			message:
				'Antes de redactar o cambiar el contrato, resolvamos estas decisiones. Puedes elegir una opción o escribir tu propia respuesta.',
			questions: state.pending?.questions ?? FALLBACK_QUESTIONS,
			contract: null,
			harness: null,
			ready: false,
		};
	return reply;
}
const QUESTION_ID_SCHEMA = {
	type: 'string',
	pattern: slug.source,
	minLength: 1,
	maxLength: 40,
	description:
		'ID técnico único: minúsculas, números y guiones, empieza por letra. Ejemplo: q-1. No usar other, constructor ni prototype.',
};
export const questionsSchema = (max: number) => ({ ...QUESTIONS_SCHEMA, maxItems: max });
export const QUESTIONS_SCHEMA = {
	type: 'array',
	maxItems: 3,
	items: {
		type: 'object',
		additionalProperties: false,
		required: ['id', 'title', 'description', 'selectionMode', 'options', 'recommended'],
		properties: {
			id: QUESTION_ID_SCHEMA,
			title: { type: 'string' },
			description: { type: 'string' },
			selectionMode: { type: 'string', enum: ['single', 'multi'] },
			recommended: { anyOf: [{ type: 'string' }, { type: 'null' }] },
			options: {
				type: 'array',
				minItems: 1,
				maxItems: 4,
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['id', 'label', 'description'],
					properties: { id: QUESTION_ID_SCHEMA, label: { type: 'string' }, description: { type: 'string' } },
				},
			},
		},
	},
};
