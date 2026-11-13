// Tarjeta simulada (Angel 11-nov-2026): with Pagos simulados, the agent has a card assigned, as it would with a
// real one: the store's payment page shows it as saved (its browser wrapper draws it there) and, where a site
// asks to type a card, the agent fills {{tarjeta.*}} and the platform puts the values in, never the model.
// Its owner picks brand, last four digits, expiry and holder; the full number is a test one (Luhn-valid,
// from those digits), so nothing of a real card is stored here.
import { exec, row } from './db';

export type Brand = 'visa' | 'mastercard' | 'amex';
export type Card = { brand: Brand; last4: string; exp: string; holder: string };
export type FullCard = Card & { label: string; number: string; cvv: string };

const LABEL: Record<Brand, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express' };
// Each brand's test prefix (as the processors' own test cards begin) and its length.
const SHAPE: Record<Brand, { prefix: string; length: number }> = {
	visa: { prefix: '4000', length: 16 },
	mastercard: { prefix: '5555', length: 16 },
	amex: { prefix: '3782', length: 15 },
};

/** The Luhn check digit that makes `digits` + it valid. */
function luhnDigit(digits: string) {
	let sum = 0;
	for (let i = 0; i < digits.length; i++) {
		let d = Number(digits[digits.length - 1 - i]);
		if (i % 2 === 0) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
	}
	return String((10 - (sum % 10)) % 10);
}
export function luhnValid(number: string) {
	return /^\d{12,19}$/.test(number) && luhnDigit(number.slice(0, -1)) === number.at(-1);
}

/**
 * A test number of that brand ending in `last4`: prefix, filler, then a digit chosen so the whole passes Luhn,
 * placed just before the last four (they stay as the owner chose them).
 */
export function testNumber(brand: Brand, last4: string) {
	const { prefix, length } = SHAPE[brand];
	const head = prefix + '0'.repeat(length - prefix.length - 5);
	for (let d = 0; d <= 9; d++) {
		const n = `${head}${d}${last4}`;
		if (luhnValid(n)) return n;
	}
	throw new Error('No se pudo formar el número de prueba.');
}

const DEFAULT = (holder: string): Card => ({ brand: 'visa', last4: '4242', exp: '08/29', holder });

/** Its card as its owner set it (or the default), without the full number. */
export async function cardOf(agentId: number): Promise<Card> {
	const r = await row<{ card: Partial<Card> | null; owner: string }>(
		'select a.simulated_card as card, p.name as owner from agents a join people p on p.id = a.person_id where a.id = $1',
		[agentId],
	);
	const base = DEFAULT(r?.owner ?? 'Titular');
	return { ...base, ...(r?.card ?? {}) } as Card;
}

/** What the agent's computer gets (and only with Pagos simulados on): the card, whole. */
export async function fullCard(agentId: number): Promise<FullCard> {
	const c = await cardOf(agentId);
	return {
		...c,
		label: LABEL[c.brand],
		number: testNumber(c.brand, c.last4),
		cvv: c.brand === 'amex' ? '1234' : '123',
	};
}

/** Its owner changes it. */
export async function setCard(agentId: number, input: Record<string, unknown>): Promise<Card> {
	const brand = String(input.brand ?? '') as Brand;
	if (!(brand in LABEL)) throw new Error('Marca: Visa, Mastercard o American Express.');
	const last4 = String(input.last4 ?? '').trim();
	if (!/^\d{4}$/.test(last4)) throw new Error('Los últimos 4 dígitos son 4 números.');
	const exp = String(input.exp ?? '').trim();
	const m = exp.match(/^(0[1-9]|1[0-2])\/(\d{2})$/);
	if (!m) throw new Error('Vencimiento como MM/AA, p. ej. 08/29.');
	const holder = String(input.holder ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 60);
	if (!holder) throw new Error('Escribe el nombre del titular.');
	const card: Card = { brand, last4, exp, holder };
	await exec('update agents set simulated_card = $2 where id = $1', [agentId, JSON.stringify(card)]);
	return card;
}

/** How the agent is told about it: the same words a real assigned card would use. */
export function cardLine(c: Card) {
	return `${LABEL[c.brand]} terminación ${c.last4}, vence ${c.exp}, a nombre de ${c.holder}`;
}
