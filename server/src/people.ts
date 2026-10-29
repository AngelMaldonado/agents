// People: a name is the only login (ported from ~/dev/sonos/web/src/lib/server/people.ts).
// The browser keeps a session cookie; admins type the shared PIN (AGENTS_ADMIN_PIN) once per
// browser and it lasts ADMIN_DAYS. Someone on a new browser gets a one-time link from an admin.
// Session tokens and invite codes are stored as their sha256 only.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { row, rows, exec, hash } from './db';

export const COOKIE = 'agents_session';
export const ADMIN_DAYS = 30;
export const INVITE_HOURS = 24;

export type Person = { id: number; name: string; avatar_seed: string; admin: boolean };

/** The name without case, accents or repeated spaces: two names that read the same are one. */
export function nameKey(name: string) {
	return name
		.normalize('NFKD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}

export function cleanName(name: string) {
	return name.replace(/\s+/g, ' ').trim();
}

/** Creates the person and a session; null if the name is taken or empty. */
export async function join(rawName: string): Promise<{ person: Person; token: string } | null> {
	const name = cleanName(rawName).slice(0, 40);
	const key = nameKey(name);
	if (!key) return null;
	const p = await row<{ id: number }>(
		'insert into people (name, key, avatar_seed) values ($1, $2, $3) on conflict (key) do nothing returning id',
		[name, key, randomBytes(8).toString('hex')]
	);
	if (!p) return null;
	const token = await session(p.id);
	return { person: (await whoIs(token))!, token };
}

async function session(personId: number) {
	const token = randomBytes(24).toString('base64url');
	await exec('insert into sessions (token_hash, person_id) values ($1, $2)', [hash(token), personId]);
	return token;
}

export async function invite(personId: number) {
	const code = randomBytes(12).toString('base64url');
	await exec(
		`insert into invites (code_hash, person_id, expires_at) values ($1, $2, now() + make_interval(hours => $3))`,
		[hash(code), personId, INVITE_HOURS]
	);
	return code;
}

/** The person a link is for, if it's still unused and not expired. */
export function invited(code: string) {
	return row<{ id: number; name: string }>(
		`select p.id, p.name from invites i join people p on p.id = i.person_id
		 where i.code_hash = $1 and i.used_at is null and i.expires_at > now()`,
		[hash(code)]
	);
}

/** Uses the link once (on a click, not on opening it) and returns a session token, or null. */
export async function redeem(code: string) {
	const used = await row<{ person_id: number }>(
		`update invites set used_at = now() where code_hash = $1 and used_at is null and expires_at > now() returning person_id`,
		[hash(code)]
	);
	return used ? session(used.person_id) : null;
}

/** Who can be picked to share an agent with: names only. */
export function directory() {
	return rows<{ id: number; name: string; avatar_seed: string }>('select id, name, avatar_seed from people order by lower(name)');
}

export function everyone() {
	return rows<{ id: number; name: string; avatar_seed: string; created_at: number; run_quota: number; agents: number; tasks: number }>(
		`select p.id, p.name, p.avatar_seed, p.created_at, p.run_quota,
		        (select count(*) from agents a where a.person_id = p.id and a.deleted_at is null) as agents,
		        (select count(*) from runs r where r.person_id = p.id) as tasks
		 from people p order by lower(p.name)`
	);
}

export async function quotaOf(personId: number) {
	return (await row<{ run_quota: number }>('select run_quota from people where id = $1', [personId]))?.run_quota ?? 0;
}

export async function setQuota(personId: number, quota: number) {
	if (!Number.isInteger(quota) || quota < 0 || quota > 60) throw new Error('La cuota va de 0 a 60.');
	if (!(await exec('update people set run_quota = $2 where id = $1', [personId, quota]))) throw new Error('No existe.');
}

export async function remove(personId: number) {
	await exec('delete from people where id = $1', [personId]);
}

export async function whoIs(token: string | undefined): Promise<Person | null> {
	if (!token) return null;
	const r = await row<Omit<Person, 'admin'> & { admin_until: number | null }>(
		`update sessions s set last_seen_at = now() from people p
		 where s.token_hash = $1 and p.id = s.person_id
		 returning p.id, p.name, p.avatar_seed, s.admin_until`,
		[hash(token)]
	);
	if (!r) return null;
	const { admin_until, ...person } = r;
	return { ...person, admin: (admin_until ?? 0) > Date.now() };
}

export function pinIsSet() {
	return Boolean(process.env.AGENTS_ADMIN_PIN);
}

/** True, and the session becomes admin, if `pin` is the shared PIN. */
export async function unlock(token: string, pin: string) {
	const expected = Buffer.from(process.env.AGENTS_ADMIN_PIN ?? '');
	const given = Buffer.from(pin.trim());
	if (!expected.length || expected.length !== given.length || !timingSafeEqual(expected, given)) {
		return false;
	}
	await exec(`update sessions set admin_until = now() + make_interval(days => $2) where token_hash = $1`, [hash(token), ADMIN_DAYS]);
	return true;
}

export async function lock(token: string) {
	await exec('update sessions set admin_until = null where token_hash = $1', [hash(token)]);
}
