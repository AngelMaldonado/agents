import { expect, test } from 'bun:test';
import { cardLine, luhnValid, testNumber } from './simulated-card';
import { systemPrompt } from './prompt';

test('simulated card: a test number of its brand that ends in the chosen digits and passes Luhn', () => {
	for (const [brand, last4, prefix, length] of [
		['visa', '4242', '4000', 16],
		['mastercard', '4444', '5555', 16],
		['amex', '0005', '3782', 15],
		['visa', '0000', '4000', 16],
	] as const) {
		const n = testNumber(brand, last4);
		expect(n.startsWith(prefix)).toBe(true);
		expect(n).toHaveLength(length);
		expect(n.endsWith(last4)).toBe(true);
		expect(luhnValid(n)).toBe(true);
	}
	expect(luhnValid('4000000000024243')).toBe(false);
});

test('with a card assigned and purchases authorized, it pays by itself filling the card through markers', () => {
	const role = '## Compras autorizadas\nHEB, hasta $2,000.';
	const card = cardLine({ brand: 'visa', last4: '4242', exp: '08/29', holder: 'Angel Maldonado' });
	const withCard = systemPrompt({ name: 'Chef', role, card }, []);
	expect(withCard).toContain(
		'Tienes una tarjeta asignada para pagar: Visa terminación 4242, vence 08/29, a nombre de Angel Maldonado',
	);
	expect(withCard).toContain('{{tarjeta.numero}}');
	expect(withCard).not.toContain('Pagas sólo con métodos ya guardados');
	expect(withCard).not.toContain('\nCARD');
	// Without a card, as before: saved methods only, and no markers.
	const without = systemPrompt({ name: 'Chef', role }, []);
	expect(without).toContain('Pagas sólo con métodos ya guardados');
	expect(without).not.toContain('{{tarjeta.');
	expect(without).not.toContain('\nCARD');
	// Without purchases authorized, a card changes nothing: it never pays.
	const forbidden = systemPrompt({ name: 'Chef', role: 'Cocina.', card }, []);
	expect(forbidden).toContain('Nunca pagas');
	expect(forbidden).not.toContain('{{tarjeta.');
});
