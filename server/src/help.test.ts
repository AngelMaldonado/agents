import { expect, test } from 'bun:test';
import { decodeHelp, helpData } from './help';
import { validateAnswers } from './interview';
const question = {
	id: 'source',
	title: '¿Dónde busco?',
	description: 'Fuentes permitidas',
	selectionMode: 'single' as const,
	options: [
		{ id: 'local', label: 'Distribuidores locales', description: 'Menor distancia' },
		{ id: 'all', label: 'Todas las fuentes', description: 'Más cobertura' },
	],
	recommended: 'local',
};
test('legacy help keeps human reason and offers no invented decision', () => {
	const h = decodeHelp('Falta la ciudad.');
	expect(h).toEqual({ reason: 'Falta la ciudad.', structured: false, questions: [] });
});
test('structured help keeps recommendations unselected and normalizes only fresh IDs', () => {
	const raw = JSON.stringify({ version: 1, reason: 'Elige fuentes.', questions: [{ ...question, id: 'q_1' }] });
	expect(raw.length).toBeLessThan(2000);
	const h = decodeHelp(raw);
	expect(h.structured).toBe(true);
	expect(h.reason).toBe('Elige fuentes.');
	expect(h.questions[0].id).toBe('question-1');
	expect(h.questions[0].recommended).toBe('local');
	expect(() =>
		validateAnswers(
			{ round: 8, values: { q_1: { selected: ['local'], other: '' } } },
			{ round: 8, questions: h.questions },
		),
	).toThrow();
	expect(() =>
		validateAnswers(
			{ round: 8, values: { 'question-1': { selected: [], other: '' } } },
			{ round: 8, questions: h.questions },
		),
	).toThrow();
});
test('screenshot regression: optional descriptions and recommendation do not discard actual choices', () => {
	const { description, ...q } = question;
	const h = decodeHelp(
		JSON.stringify({
			version: 1,
			reason: 'No pude verificar precios actuales.',
			questions: [{ ...q, options: q.options.map(({ description, ...o }) => o) }],
		}),
	);
	expect(h.structured).toBe(true);
	expect(h.questions[0].description).toBe('');
	expect(h.questions[0].options.map((o) => o.id)).toEqual(['local', 'all']);
	expect(h.questions[0].options[0].description).toBe('');
	const { recommended, ...plain } = q;
	expect(
		decodeHelp(JSON.stringify({ version: 1, reason: 'Elige.', questions: [plain] })).questions[0].recommended,
	).toBeNull();
});
test('invalid executable, malformed, truncated or oversized metadata never displays transport JSON or invented options', () => {
	for (const v of [
		{ version: 1, reason: 'X', questions: [question], permissions: ['purchase'] },
		{ version: 1, reason: 'X', questions: [{ ...question, execute: 'pay' }] },
		{ version: 1, reason: 'X', questions: [] },
		{ version: 1, reason: 'X'.repeat(2500), questions: [question] },
	]) {
		const h = decodeHelp(JSON.stringify(v));
		expect(h.structured).toBe(false);
		expect(h.reason.length).toBeLessThanOrEqual(2000);
		expect(h.reason).not.toContain('"questions"');
		expect(h.questions).toEqual([]);
	}
	expect(decodeHelp('{"version":1,"reason":"truncated').reason).not.toContain('{');
	expect(
		decodeHelp(
			JSON.stringify({ version: 1, reason: 'No hay acceso.', questions: [{ ...question, description: null }] }),
		).reason,
	).toBe('No hay acceso.');
});
test('answered legacy fallback keeps saved question/answer IDs while hiding raw JSON', () => {
	const raw = JSON.stringify({ version: 1, reason: 'Faltan precios.', questions: [question] });
	const stored = {
		reason: raw,
		structured: false,
		questions: [
			{
				...question,
				id: 'continue',
				options: [{ id: 'skip', label: 'Continúa sin ese dato o sitio', description: '' }],
				recommended: null,
			},
		],
	};
	expect(helpData(stored).questions[0].id).toBe('source');
	const frozen = helpData(stored, true);
	expect(frozen.reason).toBe('Faltan precios.');
	expect(frozen.questions).toEqual(stored.questions);
	expect(
		validateAnswers(
			{ round: 7, values: { continue: { selected: ['skip'], other: '' } } },
			{ round: 7, questions: frozen.questions },
		).content,
	).toContain('Continúa sin ese dato');
});
