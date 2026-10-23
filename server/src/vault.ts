// The site vault. A person provisions a login (encrypted, write-only) and grants it to some of
// their agents. During a task, agent-browser's credential plugin asks the supervisor, which asks
// this backend over its socket; the login comes back only if it is granted to the task's agent
// and the page is on the credential's origin. Every attempt is logged.
import { db, now } from './db';
import { seal, open } from './crypto';

export type CredentialRow = {
	id: number; person_id: number; name: string; origin: string; login_url: string;
	created_at: number; updated_at: number;
};

export function originOf(url: string) {
	const u = new URL(url);
	if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('URL inválida');
	return u.origin;
}

export function list(personId: number) {
	const rows = db
		.query('SELECT id, person_id, name, origin, login_url, created_at, updated_at FROM credentials WHERE person_id = ? ORDER BY name')
		.all(personId) as CredentialRow[];
	return rows.map((r) => ({
		...r,
		agents: (db.query('SELECT agent_id FROM credential_grants WHERE credential_id = ?').all(r.id) as { agent_id: number }[]).map((g) => g.agent_id)
	}));
}

export function save(personId: number, input: { name: string; loginUrl: string; username: string; password: string }) {
	const name = input.name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
	if (!name) throw new Error('Nombre inválido');
	const origin = originOf(input.loginUrl);
	if (!input.username || !input.password) throw new Error('Faltan usuario o contraseña');
	const t = now();
	db.query(
		`INSERT INTO credentials (person_id, name, origin, login_url, enc_username, enc_password, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(person_id, name) DO UPDATE SET origin = excluded.origin, login_url = excluded.login_url,
		   enc_username = excluded.enc_username, enc_password = excluded.enc_password, updated_at = excluded.updated_at`
	).run(personId, name, origin, input.loginUrl, seal(input.username), seal(input.password), t, t);
	return name;
}

export function remove(personId: number, id: number) {
	db.query('DELETE FROM credentials WHERE id = ? AND person_id = ?').run(id, personId);
}

/** Replaces the agents a credential is granted to; only the owner's own agents count. */
export function grant(personId: number, id: number, agentIds: number[]) {
	const cred = db.query('SELECT id FROM credentials WHERE id = ? AND person_id = ?').get(id, personId);
	if (!cred) throw new Error('No existe');
	const own = new Set((db.query('SELECT id FROM agents WHERE person_id = ? AND deleted_at IS NULL').all(personId) as { id: number }[]).map((a) => a.id));
	db.transaction(() => {
		db.query('DELETE FROM credential_grants WHERE credential_id = ?').run(id);
		for (const a of agentIds) if (own.has(a)) db.query('INSERT INTO credential_grants (credential_id, agent_id) VALUES (?, ?)').run(id, a);
	})();
}

export function grantedNames(agentId: number) {
	return (db
		.query('SELECT c.name FROM credentials c JOIN credential_grants g ON g.credential_id = c.id WHERE g.agent_id = ? ORDER BY c.name')
		.all(agentId) as { name: string }[]).map((r) => r.name);
}

export function uses(personId: number, all = false) {
	return db
		.query(
			`SELECT u.*, p.name AS person FROM credential_uses u JOIN people p ON p.id = u.person_id
			 ${all ? '' : 'WHERE u.person_id = ?'} ORDER BY u.id DESC LIMIT 200`
		)
		.all(...(all ? [] : [personId])) as unknown[];
}

function log(task: { id: number; person_id: number; agent_id: number }, credId: number | null, name: string, ok: boolean, detail: string) {
	db.query(
		'INSERT INTO credential_uses (credential_id, credential_name, person_id, task_id, agent_id, at, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
	).run(credId, name, task.person_id, task.id, task.agent_id, now(), ok ? 1 : 0, detail);
}

export function resolveCredential(task: { id: number; person_id: number; agent_id: number }, name: string, url: string) {
	const row = db
		.query(
			`SELECT c.* FROM credentials c JOIN credential_grants g ON g.credential_id = c.id
			 WHERE g.agent_id = ? AND c.name = ? AND c.person_id = ?`
		)
		.get(task.agent_id, name, task.person_id) as (CredentialRow & { enc_username: string; enc_password: string }) | null;
	if (!row) {
		log(task, null, name, false, 'no concedida a este agente');
		return { ok: false as const, error: `No tienes acceso a "${name}".` };
	}
	if (url) {
		let origin = '';
		try {
			origin = originOf(url);
		} catch {}
		if (origin !== row.origin) {
			log(task, row.id, name, false, `origen distinto: ${origin || url}`);
			return { ok: false as const, error: `"${name}" sólo se usa en ${row.origin}.` };
		}
	}
	log(task, row.id, name, true, url || row.login_url);
	return {
		ok: true as const,
		credential: { username: open(row.enc_username), password: open(row.enc_password), url: row.login_url }
	};
}
