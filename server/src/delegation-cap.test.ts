import { expect, test } from 'bun:test';
import { instructions } from './delegations';

const template = {
	name: 'cotizar',
	description: 'Cotiza.',
	objective: 'Cotiza {lista}.',
	intro: 'Hola, de parte de {dueno}.',
	rules: [],
	collect: { list: false, fields: [{ name: 'precio', description: 'Pesos', type: 'number' as const }] },
	escalate: [],
	files: false,
	maxHours: 48,
};
const encargo = (maxMessages: number | null) =>
	({
		contact: 'Cortez',
		template: { ...template, maxMessages },
		params: { lista: 'res', dueno: 'Ana' },
		context: null,
	}) as never;

test('an encargo without a cap of messages is not told how many it has left', () => {
	expect(instructions(encargo(null), 'Ana', null)).not.toContain('Te quedan');
	expect(instructions(encargo(10), 'Ana', 4)).toContain('Te quedan 4 mensajes.');
});
