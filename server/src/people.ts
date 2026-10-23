// People: a name is the only login (ported from ~/dev/sonos/web/src/lib/server/people.ts).
// The browser keeps a session cookie; admins type the shared PIN (BUYER_ADMIN_PIN) once per
// browser and it lasts ADMIN_DAYS. Someone on a new browser gets a one-time link from an admin.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from './db';

export const COOKIE = 'buyer_session';
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
export function join(rawName: string): { person: Person; token: string } | null {
	const name = cleanName(rawName).slice(0, 40);
	const key = nameKey(name);
	if (!key) return null;
	if (db.query('SELECT 1 FROM people WHERE key = ?').get(key)) return null;
	const { lastInsertRowid } = db
		.query('INSERT INTO people (name, key, avatar_seed, created_at) VALUES (?, ?, ?, ?)')
		.run(name, key, randomBytes(8).toString('hex'), Date.now());
	const token = session(Number(lastInsertRowid));
	return { person: whoIs(token)!, token };
}

function session(personId: number) {
	const token = randomBytes(24).toString('base64url');
	db.query('INSERT INTO sessions (token, person_id, created_at) VALUES (?, ?, ?)').run(
		token,
		personId,
		Date.now()
	);
	return token;
}

export function invite(personId: number) {
	const code = randomBytes(12).toString('base64url');
	const t = Date.now();
	db.query('INSERT INTO invites (code, person_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
		code,
		personId,
		t,
		t + INVITE_HOURS * 3_600_000
	);
	return code;
}

/** The person a link is for, if it's still unused and not expired. */
export function invited(code: string) {
	return db
		.query(
			`SELECT p.id, p.name FROM invites i JOIN people p ON p.id = i.person_id
			 WHERE i.code = ? AND i.used_at IS NULL AND i.expires_at > ?`
		)
		.get(code, Date.now()) as { id: number; name: string } | null;
}

/** Uses the link once (on a click, not on opening it) and returns a session token, or null. */
export function redeem(code: string) {
	const person = invited(code);
	if (!person) return null;
	const { changes } = db
		.query('UPDATE invites SET used_at = ? WHERE code = ? AND used_at IS NULL')
		.run(Date.now(), code);
	return changes ? session(person.id) : null;
}

export function everyone() {
	return db
		.query(
			`SELECT p.id, p.name, p.avatar_seed, p.created_at,
			        (SELECT COUNT(*) FROM agents a WHERE a.person_id = p.id AND a.deleted_at IS NULL) AS agents,
			        (SELECT COUNT(*) FROM tasks t WHERE t.person_id = p.id) AS tasks
			 FROM people p ORDER BY p.name COLLATE NOCASE`
		)
		.all() as { id: number; name: string; avatar_seed: string; created_at: number; agents: number; tasks: number }[];
}

export function remove(personId: number) {
	db.query('DELETE FROM people WHERE id = ?').run(personId);
}

export function whoIs(token: string | undefined): Person | null {
	if (!token) return null;
	const row = db
		.query(
			`SELECT p.id, p.name, p.avatar_seed, s.admin_until
			 FROM sessions s JOIN people p ON p.id = s.person_id WHERE s.token = ?`
		)
		.get(token) as (Omit<Person, 'admin'> & { admin_until: number }) | null;
	if (!row) return null;
	const { admin_until, ...person } = row;
	return { ...person, admin: admin_until > Date.now() };
}

export function pinIsSet() {
	return Boolean(process.env.BUYER_ADMIN_PIN);
}

/** True, and the session becomes admin, if `pin` is the shared PIN. */
export function unlock(token: string, pin: string) {
	const expected = Buffer.from(process.env.BUYER_ADMIN_PIN ?? '');
	const given = Buffer.from(pin.trim());
	if (!expected.length || expected.length !== given.length || !timingSafeEqual(expected, given)) {
		return false;
	}
	db.query('UPDATE sessions SET admin_until = ? WHERE token = ?').run(
		Date.now() + ADMIN_DAYS * 86_400_000,
		token
	);
	return true;
}

export function lock(token: string) {
	db.query('UPDATE sessions SET admin_until = 0 WHERE token = ?').run(token);
}
