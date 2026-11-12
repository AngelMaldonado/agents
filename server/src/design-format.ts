// Pure validation: neither a model's answer nor a browser draft is trusted as configuration.
import { HARNESS_SCHEMA, TOOLS, validateHarness, type Harness } from '../../sandbox/harness';
export type Contract = { name: string; prompt: string };
import { DESIGN_QUESTIONS, questionsSchema, validateQuestions, type Question } from './interview';
// A schedule wakes the agent with its message (cron, America/Mexico_City). null: keep what there is.
export type ScheduleProposal = { cron: string; message: string };
// Which of the person's accesses the agent should use (names only; the owner grants them).
export type AccessSuggestion = {
	kind: 'site' | 'mcp' | 'key';
	name: string;
	reason: string;
	/** The owner chose to grant it before the agent exists: granted on approval. */
	accepted?: boolean;
};
export type DesignReply = {
	/** 1–3 sentences on what it is weighing, written first so the owner reads it while it answers. */
	pensamiento: string;
	accesses: AccessSuggestion[];
	secrets: { name: string; description: string; domains: string[] }[];
	/** Ids of this reply's search results worth showing the owner (the rest stay hidden). */
	hallazgos: string[];
	message: string;
	contract: Contract | null;
	harness: Harness | null;
	schedules: ScheduleProposal[] | null;
	/** Modo objetivo: true or false to propose it; null keeps the agent's (off for a new one). */
	goalMode: boolean | null;
	ready: boolean;
	questions: Question[];
};
export const MAX_SCHEDULES = 10;
const SCHEDULES_SCHEMA = {
	anyOf: [
		{ type: 'null' },
		{
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['cron', 'message'],
				properties: { cron: { type: 'string' }, message: { type: 'string' } },
			},
		},
	],
};
const CRON_RANGES = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 7],
] as const;
function cronField(field: string, [lo, hi]: readonly [number, number]) {
	return field.split(',').every((part) => {
		const m = part.match(/^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
		if (!m) return false;
		const from = m[1] ? lo : Number(m[2]),
			to = m[1] ? hi : m[3] !== undefined ? Number(m[3]) : from,
			step = m[4] !== undefined ? Number(m[4]) : 1;
		return from >= lo && to <= hi && from <= to && step >= 1;
	});
}
/** Five numeric cron fields, at most every 15 minutes, a message each, no duplicates. */
export function validateSchedules(value: unknown): ScheduleProposal[] | null {
	if (value === null || value === undefined) return null;
	if (!Array.isArray(value) || value.length > MAX_SCHEDULES)
		throw new Error(`Hasta ${MAX_SCHEDULES} horarios por agente.`);
	const seen = new Set<string>();
	return value.map((s) => {
		const cron = String(s?.cron ?? '')
				.trim()
				.split(/\s+/)
				.join(' '),
			message = String(s?.message ?? '').trim();
		const fields = cron.split(' ');
		if (fields.length !== 5 || !fields.every((f, i) => cronField(f, CRON_RANGES[i])))
			throw new Error(
				`Horario inválido «${cron}»: usa cron de 5 campos numéricos (minuto hora día mes día-de-semana).`,
			);
		const minute = fields[0].match(/^\*(?:\/(\d+))?$/);
		if (minute && Number(minute[1] ?? 1) < 15)
			throw new Error(`«${cron}» despierta al agente demasiado seguido: como máximo cada 15 minutos.`);
		if (!message || message.length > 2000)
			throw new Error('Cada horario necesita un mensaje de hasta 2000 caracteres.');
		const key = `${cron}\n${message}`;
		if (seen.has(key)) throw new Error(`Horario repetido: «${cron}».`);
		seen.add(key);
		return { cron, message };
	});
}
export const TOOL_CATALOG = TOOLS;
export const INIT_STEPS = [
	{ id: 'contract', label: 'Guardar el contrato aprobado' },
	{ id: 'computer', label: 'Obtener turno y arrancar la computadora' },
	{ id: 'workspace', label: 'Preparar memoria y espacio de trabajo' },
	{ id: 'tools', label: 'Comprobar las herramientas' },
	{ id: 'browser', label: 'Abrir y comprobar Chrome' },
	{ id: 'ready', label: 'Cerrar la comprobación y dejarlo listo' },
] as const;
export const REPLY_FORMAT = {
	type: 'json_schema',
	name: 'agent_contract',
	strict: true,
	schema: {
		type: 'object',
		additionalProperties: false,
		required: [
			'pensamiento',
			'message',
			'contract',
			'harness',
			'schedules',
			'goalMode',
			'ready',
			'questions',
			'accesses',
			'secrets',
			'hallazgos',
		],
		// pensamiento first: the reply streams in this order and the page shows it while the rest is written.
		properties: {
			pensamiento: { type: 'string' },
			questions: questionsSchema(DESIGN_QUESTIONS),
			hallazgos: { type: 'array', maxItems: 6, items: { type: 'string' } },
			secrets: {
				type: 'array',
				maxItems: 4,
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['name', 'description', 'domains'],
					properties: {
						name: { type: 'string' },
						description: { type: 'string' },
						domains: { type: 'array', maxItems: 5, items: { type: 'string' } },
					},
				},
			},
			accesses: {
				type: 'array',
				maxItems: 12,
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['kind', 'name', 'reason'],
					properties: {
						kind: { type: 'string', enum: ['site', 'mcp', 'key'] },
						name: { type: 'string' },
						reason: { type: 'string' },
					},
				},
			},
			harness: { anyOf: [{ type: 'null' }, HARNESS_SCHEMA] },
			schedules: SCHEDULES_SCHEMA,
			goalMode: { type: ['boolean', 'null'] },
			message: { type: 'string' },
			ready: { type: 'boolean' },
			contract: {
				anyOf: [
					{ type: 'null' },
					{
						type: 'object',
						additionalProperties: false,
						required: ['name', 'prompt'],
						properties: { name: { type: 'string' }, prompt: { type: 'string' } },
					},
				],
			},
		},
	},
};
export function validateContract(value: unknown): Contract {
	const c = value as Contract;
	if (!c || typeof c.name !== 'string' || !c.name.trim() || c.name.trim().length > 40)
		throw new Error('El contrato necesita un nombre de hasta 40 caracteres.');
	// No length limit (Angel, 2-nov-2026): past 16 000 characters the panel only warns.
	if (typeof c.prompt !== 'string' || !c.prompt.trim()) throw new Error('El contrato necesita un prompt.');
	return { name: c.name.trim(), prompt: c.prompt.trim() };
}
/** The reply's text (the JSON the designer wrote). */
export function replyText(response: any): string {
	return (Array.isArray(response?.output) ? response.output : [])
		.filter((o: any) => o.type === 'message' && o.role === 'assistant')
		.flatMap((o: any) => (Array.isArray(o.content) ? o.content : []))
		.filter((c: any) => c.type === 'output_text')
		.map((c: any) => c.text)
		.join('');
}
/** What the model gets wrong harmlessly in its skills is repaired: a slug name, a description up to 300. */
export function repairSkills(harness: any) {
	if (!harness || !Array.isArray(harness.skills)) return harness;
	const used = new Set<string>();
	const skills = harness.skills.map((s: any, i: number) => {
		let name =
			String(s?.name ?? '')
				.normalize('NFD')
				.replace(/\p{M}/gu, '')
				.toLowerCase()
				.replace(/[^a-z0-9-]+/g, '-')
				.replace(/^[^a-z]+/, '')
				.replace(/-+/g, '-')
				.replace(/-$/, '')
				.slice(0, 40) || `skill-${i + 1}`;
		for (let n = 2; used.has(name); n++) name = `${name.slice(0, 37)}-${n}`;
		used.add(name);
		return s && typeof s === 'object'
			? {
					...s,
					name,
					description: String(s.description ?? '')
						.trim()
						.slice(0, 300),
				}
			: s;
	});
	return { ...harness, skills };
}
/** `proposed`: the draft already holds a proposal of its own, so a ready reply without a contract keeps it. */
export function parseDesignReply(response: any, proposed = false): DesignReply {
	if (response?.status !== 'completed')
		throw new Error('La IA no terminó la respuesta. Reintenta o pide un contrato más breve.');
	const text = replyText(response);
	let r: any;
	try {
		r = JSON.parse(text);
	} catch {
		throw new Error('La IA no devolvió un contrato válido. Reintenta la respuesta.');
	}
	if (
		!r ||
		typeof r.message !== 'string' ||
		!r.message.trim() ||
		r.message.length > 16000 ||
		typeof r.ready !== 'boolean'
	)
		throw new Error('La respuesta de la IA no tiene el formato esperado.');
	const contract = r.contract === null ? null : validateContract(r.contract);
	if (r.ready && !contract && !proposed)
		throw new Error('Declaraste listo sin enviar el contrato, y este borrador aún no tiene una propuesta tuya.');
	return {
		message: r.message.trim(),
		contract,
		harness: r.harness == null ? null : validateHarness(repairSkills(r.harness)),
		schedules: validateSchedules(r.schedules ?? null),
		goalMode: typeof r.goalMode === 'boolean' ? r.goalMode : null,
		ready: r.ready,
		questions: validateQuestions(r.questions ?? [], DESIGN_QUESTIONS),
		pensamiento: typeof r.pensamiento === 'string' ? r.pensamiento.trim().slice(0, 800) : '',
		hallazgos: (Array.isArray(r.hallazgos) ? r.hallazgos : [])
			.filter((x: unknown): x is string => typeof x === 'string')
			.slice(0, 6),
		// Names only (env-var style); the owner types the value in a secure card.
		secrets: (Array.isArray(r.secrets) ? r.secrets : []).slice(0, 4).flatMap((x: any) =>
			typeof x?.name === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(x.name.trim().toUpperCase())
				? [
						{
							name: x.name.trim().toUpperCase(),
							description: String(x.description ?? '')
								.trim()
								.slice(0, 300),
							domains: (Array.isArray(x.domains) ? x.domains : [])
								.map((d: unknown) => String(d).trim().toLowerCase())
								.filter((d: string) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
								.slice(0, 5),
						},
					]
				: [],
		),
		accesses: (Array.isArray(r.accesses) ? r.accesses : []).slice(0, 12).flatMap((a: any) =>
			['site', 'mcp', 'key'].includes(a?.kind) && typeof a?.name === 'string' && a.name.trim()
				? [
						{
							kind: a.kind,
							name: a.name.trim().slice(0, 100),
							reason: String(a.reason ?? '')
								.trim()
								.slice(0, 300),
						},
					]
				: [],
		),
	};
}
