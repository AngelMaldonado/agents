import { expect, test } from 'bun:test';
import { validateContract, parseDesignReply, validateSchedules, INIT_STEPS } from './design-format';
const response = (value: unknown) => ({
	status: 'completed',
	output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});
test('contract validates without silently truncating the prompt', () => {
	expect(validateContract({ name: ' Compras ', prompt: '# Objetivo\nComparar fuentes.' })).toEqual({
		name: 'Compras',
		prompt: '# Objetivo\nComparar fuentes.',
	});
	expect(() => validateContract({ name: 'x'.repeat(41), prompt: 'a' })).toThrow();
	expect(() => validateContract({ name: 'a', prompt: 'x'.repeat(16001) })).toThrow();
});
test('interview can ask questions before there is a contract', () => {
	expect(parseDesignReply(response({ message: '¿Qué resultado esperas?', contract: null, ready: false })).ready).toBe(
		false,
	);
});
test('a ready response must include a non-empty contract', () => {
	expect(() => parseDesignReply(response({ message: 'Listo', contract: null, ready: true }))).toThrow('vacío');
	expect(() =>
		parseDesignReply(response({ message: 'Listo', contract: { name: 'A', prompt: '' }, ready: true })),
	).toThrow();
});
test('rejects truncation, refusals, invalid JSON and arbitrary model fields instead of applying them', () => {
	expect(() => parseDesignReply({ status: 'incomplete', output: [] })).toThrow('no terminó');
	expect(() =>
		parseDesignReply({
			status: 'completed',
			output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No.' }] }],
		}),
	).toThrow('válido');
	expect(() => parseDesignReply(response({ message: 'x', contract: null, ready: 'true' }))).toThrow();
	const parsed = parseDesignReply(
		response({
			message: 'Revisa',
			contract: { name: 'A', prompt: 'Rol', admin: true },
			ready: true,
			execute: 'rm -rf /',
		}),
	);
	expect(parsed).toEqual({
		message: 'Revisa',
		contract: { name: 'A', prompt: 'Rol' },
		harness: null,
		schedules: null,
		ready: true,
		questions: [],
		accesses: [],
		secrets: [],
		hallazgos: [],
		pensamiento: '',
	});
});
test('access suggestions keep only known kinds and named entries; a round may ask up to six questions', () => {
	const parsed = parseDesignReply(
		response({
			message: 'Propuesta',
			contract: { name: 'A', prompt: 'Rol' },
			ready: true,
			accesses: [
				{ kind: 'site', name: ' proveedor ', reason: 'Inicia sesión en el portal' },
				{ kind: 'root', name: 'x', reason: '' },
				{ kind: 'key', name: '', reason: '' },
			],
		}),
	);
	expect(parsed.accesses).toEqual([{ kind: 'site', name: 'proveedor', reason: 'Inicia sesión en el portal' }]);
	const asked = parseDesignReply(
		response({
			message: 'Guarda tu token',
			contract: null,
			ready: false,
			secrets: [
				{ name: 'github_token', description: 'Token de lectura', domains: ['API.github.com', 'no es dominio'] },
				{ name: 'mal nombre', description: '', domains: [] },
			],
		}),
	);
	expect(asked.secrets).toEqual([
		{ name: 'GITHUB_TOKEN', description: 'Token de lectura', domains: ['api.github.com'] },
	]);
	const q = (i: number) => ({
		id: `q-${i}`,
		title: `Pregunta ${i}`,
		description: '',
		selectionMode: 'single',
		options: [{ id: 'a', label: 'A', description: '' }],
		recommended: 'a',
	});
	const six = parseDesignReply(
		response({ message: 'Ronda', contract: null, ready: false, questions: [1, 2, 3, 4, 5, 6].map(q) }),
	);
	expect(six.questions).toHaveLength(6);
	expect(() =>
		parseDesignReply(
			response({ message: 'Ronda', contract: null, ready: false, questions: [1, 2, 3, 4, 5, 6, 7].map(q) }),
		),
	).toThrow();
});
test('a skill with a sloppy name or a long description is repaired; oversized instructions are not', async () => {
	const { defaultHarness } = await import('../../sandbox/harness');
	const skill = (s: object) => ({
		...defaultHarness(),
		skills: [{ name: 'Tech News Digest!', description: 'x'.repeat(400), instructions: 'Resume noticias.', ...s }],
	});
	const ok = parseDesignReply(
		response({ message: 'Propuesta', contract: { name: 'A', prompt: 'Rol' }, ready: true, harness: skill({}) }),
	);
	expect(ok.harness?.skills[0]).toMatchObject({ name: 'tech-news-digest', description: 'x'.repeat(300) });
	expect(() =>
		parseDesignReply(
			response({
				message: 'Propuesta',
				contract: { name: 'A', prompt: 'Rol' },
				ready: true,
				harness: skill({ instructions: 'y'.repeat(9000) }),
			}),
		),
	).toThrow('skill inválida');
});
test('initialization ends with readiness, not with merely opening Chrome', () => {
	expect(INIT_STEPS.map((s) => s.id)).toEqual(['contract', 'computer', 'workspace', 'tools', 'browser', 'ready']);
});
test('schedules: null keeps the current ones; proposals are checked cron by cron', () => {
	expect(validateSchedules(null)).toBeNull();
	expect(validateSchedules([])).toEqual([]);
	expect(
		validateSchedules([
			{ cron: ' 0  9 * * 1-5 ', message: ' Revisa precios ' },
			{ cron: '*/30 8-18 * * *', message: 'Vigila la cola' },
		]),
	).toEqual([
		{ cron: '0 9 * * 1-5', message: 'Revisa precios' },
		{ cron: '*/30 8-18 * * *', message: 'Vigila la cola' },
	]);
	expect(() => validateSchedules([{ cron: '0 9 * *', message: 'x' }])).toThrow('5 campos');
	expect(() => validateSchedules([{ cron: '0 25 * * *', message: 'x' }])).toThrow('inválido');
	expect(() => validateSchedules([{ cron: '0 9 * * MON', message: 'x' }])).toThrow('inválido');
	expect(() => validateSchedules([{ cron: '* * * * *', message: 'x' }])).toThrow('15 minutos');
	expect(() => validateSchedules([{ cron: '*/5 * * * *', message: 'x' }])).toThrow('15 minutos');
	expect(() => validateSchedules([{ cron: '0 9 * * *', message: ' ' }])).toThrow('mensaje');
	expect(() =>
		validateSchedules([
			{ cron: '0 9 * * *', message: 'a' },
			{ cron: '0 9 * * *', message: 'a' },
		]),
	).toThrow('repetido');
	expect(() =>
		validateSchedules(Array.from({ length: 11 }, (_, i) => ({ cron: `${i} 9 * * *`, message: 'a' }))),
	).toThrow('10');
	expect(
		parseDesignReply(
			response({
				message: 'Listo',
				contract: { name: 'A', prompt: 'Rol' },
				harness: null,
				schedules: [{ cron: '0 8 * * *', message: 'Resumen' }],
				ready: true,
				questions: [],
			}),
		).schedules,
	).toEqual([{ cron: '0 8 * * *', message: 'Resumen' }]);
});
