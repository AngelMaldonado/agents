import { expect, test } from 'bun:test';

process.env.AGENTS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.AGENTS_PUBLIC_URL = 'https://agents.test';
const { signature, verify, signedLink, checkLink, TOLERANCE_S } = await import('./sign');

const secret = 'whsec_test';
const body = '{"text":"hola"}';

test('a signature made with the secret verifies', () => {
	expect(verify(signature(secret, body), secret, body)).toBe(true);
});

test('a changed body, a wrong secret or a missing header do not', () => {
	const sig = signature(secret, body);
	expect(verify(sig, secret, '{"text":"adios"}')).toBe(false);
	expect(verify(sig, 'whsec_other', body)).toBe(false);
	expect(verify(undefined, secret, body)).toBe(false);
	expect(verify('t=1,v1=zz', secret, body)).toBe(false);
});

test('an old signature is refused (replay window)', () => {
	const now = Math.floor(Date.now() / 1000);
	expect(verify(signature(secret, body, now - TOLERANCE_S - 1), secret, body, now)).toBe(false);
	expect(verify(signature(secret, body, now - TOLERANCE_S + 5), secret, body, now)).toBe(true);
});

test('signed links work for their path only, until they expire', () => {
	const url = new URL(signedLink('/api/public/runs/7'));
	expect(url.origin).toBe('https://agents.test');
	const exp = url.searchParams.get('exp')!;
	const sig = url.searchParams.get('sig')!;
	expect(checkLink('/api/public/runs/7', exp, sig)).toBe(true);
	expect(checkLink('/api/public/runs/8', exp, sig)).toBe(false);
	expect(checkLink('/api/public/runs/7', String(Math.floor(Date.now() / 1000) - 1), sig)).toBe(false);
});
