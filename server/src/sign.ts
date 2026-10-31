// Signatures, one scheme both ways (inbound hooks and outbound webhooks):
//   X-Agents-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
// The timestamp is signed too, so a captured request can't be replayed after TOLERANCE_S.
// Links sent out (a run, its files) are signed with a key derived from AGENTS_MASTER_KEY and
// expire after LINK_DAYS; they are only reachable from the LAN/tailnet anyway.
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export const TOLERANCE_S = 300;
export const LINK_DAYS = 7;

const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest('hex');

export const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

export function signature(secret: string, body: string, t = Math.floor(Date.now() / 1000)) {
	return `t=${t},v1=${hmac(secret, `${t}.${body}`)}`;
}

/** True if `header` signs `body` with `secret` within the tolerance window. */
export function verify(header: string | undefined, secret: string, body: string, now = Math.floor(Date.now() / 1000)) {
	const parts = Object.fromEntries((header ?? '').split(',').map((p) => p.trim().split('=', 2) as [string, string]));
	const t = Number(parts.t);
	if (!Number.isInteger(t) || !parts.v1 || Math.abs(now - t) > TOLERANCE_S) return false;
	const expected = Buffer.from(hmac(secret, `${t}.${body}`), 'hex');
	const given = Buffer.from(parts.v1, 'hex');
	return given.length === expected.length && timingSafeEqual(given, expected);
}

function linkKey() {
	return createHmac('sha256', Buffer.from(process.env.AGENTS_MASTER_KEY ?? '', 'base64'))
		.update('agents-links-v1')
		.digest();
}

const base = () => (process.env.AGENTS_PUBLIC_URL ?? 'http://localhost:8787').replace(/\/+$/, '');

/** An absolute URL to `path` that works without a login until it expires. */
export function signedLink(path: string, days = LINK_DAYS) {
	const exp = Math.floor(Date.now() / 1000) + days * 86400;
	return `${base()}${path}?exp=${exp}&sig=${hmac(linkKey(), `${path}|${exp}`)}`;
}

export function checkLink(path: string, exp: string | undefined, sig: string | undefined) {
	const e = Number(exp);
	if (!Number.isInteger(e) || e < Date.now() / 1000 || !sig) return false;
	const expected = Buffer.from(hmac(linkKey(), `${path}|${e}`), 'hex');
	const given = Buffer.from(sig, 'hex');
	return given.length === expected.length && timingSafeEqual(given, expected);
}

export const publicUrl = (path: string) => `${base()}${path}`;
