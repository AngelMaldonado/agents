// The site vault. A person provisions a login (encrypted, write-only) and grants it to some of
// their agents. During a task, agent-browser's credential plugin asks the supervisor, which asks
// this backend over its socket; the login comes back only if it is granted to the task's agent
// and the page is on the credential's origin. Every attempt is logged.
import { row, rows, exec, tx, type Exec } from './db';
import { seal, open } from './crypto';

export type CredentialRow = {
	id: number;
	person_id: number;
	name: string;
	origin: string;
	login_url: string;
	created_at: number;
	updated_at: number;
};

type RunRef = { id: number; person_id: number; agent_id: number };

export function originOf(url: string) {
	const u = new URL(url);
	if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('URL inválida');
	return u.origin;
}

export function list(personId: number) {
	return rows<CredentialRow & { agents: number[] }>(
		`select c.id, c.person_id, c.name, c.origin, c.login_url, c.created_at, c.updated_at,
		        coalesce(array_agg(g.agent_id) filter (where g.agent_id is not null), '{}') as agents
		 from credentials c left join credential_grants g on g.credential_id = c.id
		 where c.person_id = $1 group by c.id order by c.name`,
		[personId],
	);
}

export async function save(
	personId: number,
	input: { name: string; loginUrl: string; username: string; password: string },
) {
	const name = String(input.name ?? '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40);
	if (!name) throw new Error('Nombre inválido');
	const origin = originOf(input.loginUrl);
	if (!input.username || !input.password) throw new Error('Faltan usuario o contraseña');
	await exec(
		`insert into credentials (person_id, name, origin, login_url, username_enc, password_enc)
		 values ($1, $2, $3, $4, $5, $6)
		 on conflict (person_id, name) do update set origin = excluded.origin, login_url = excluded.login_url,
		   username_enc = excluded.username_enc, password_enc = excluded.password_enc, updated_at = now()`,
		[personId, name, origin, input.loginUrl, seal(input.username), seal(input.password)],
	);
	return name;
}

/**
 * An agent that loses a credential (revoked or deleted) gets that origin's cookies and storage
 * wiped from its browser profile (Q14). Returns the agents affected.
 */
async function purgeLost(c: Exec, personId: number, credId: number, lostAgents: number[]) {
	if (!lostAgents.length) return [];
	await exec(
		`insert into profile_purges (agent_id, origin, credential_name, person_id)
		 select a, c.origin, c.name, $3 from credentials c, unnest($2::bigint[]) a where c.id = $1`,
		[credId, lostAgents, personId],
		c,
	);
	return lostAgents;
}

export async function remove(personId: number, id: number) {
	return tx(async (c) => {
		const had = await rows<{ agent_id: number }>(
			`select g.agent_id from credential_grants g join credentials cr on cr.id = g.credential_id
			 where cr.id = $1 and cr.person_id = $2`,
			[id, personId],
			c,
		);
		const affected = await purgeLost(
			c,
			personId,
			id,
			had.map((g) => g.agent_id),
		);
		await exec('delete from credentials where id = $1 and person_id = $2', [id, personId], c);
		return affected;
	});
}

/** Replaces the agents a credential is granted to; only the owner's own agents count. */
export async function grant(personId: number, id: number, agentIds: number[]) {
	return tx(async (c) => {
		if (!(await row('select 1 from credentials where id = $1 and person_id = $2 for update', [id, personId], c)))
			throw new Error('No existe');
		const before = (
			await rows<{ agent_id: number }>('select agent_id from credential_grants where credential_id = $1', [id], c)
		).map((g) => g.agent_id);
		await exec('delete from credential_grants where credential_id = $1', [id], c);
		await exec(
			`insert into credential_grants (credential_id, agent_id)
			 select $1, a.id from agents a where a.person_id = $2 and a.deleted_at is null and a.id = any($3::bigint[])`,
			[id, personId, agentIds],
			c,
		);
		const after = new Set(
			(
				await rows<{ agent_id: number }>('select agent_id from credential_grants where credential_id = $1', [id], c)
			).map((g) => g.agent_id),
		);
		return purgeLost(
			c,
			personId,
			id,
			before.filter((a) => !after.has(a)),
		);
	});
}

export async function grantedNames(agentId: number) {
	return (
		await rows<{ name: string }>(
			'select c.name from credentials c join credential_grants g on g.credential_id = c.id where g.agent_id = $1 order by c.name',
			[agentId],
		)
	).map((r) => r.name);
}

export function uses(personId: number, all = false) {
	return rows(
		`select u.id, u.credential_id, u.credential_name, u.action, u.person_id, u.run_id as task_id, u.agent_id, u.at, u.ok, u.detail,
		        p.name as person
		 from credential_uses u join people p on p.id = u.person_id
		 ${all ? '' : 'where u.person_id = $1'} order by u.id desc limit 200`,
		all ? [] : [personId],
	);
}

async function log(run: RunRef, credId: number | null, name: string, ok: boolean, detail: string) {
	await exec(
		`insert into credential_uses (credential_id, credential_name, action, person_id, run_id, agent_id, ok, detail)
		 values ($1, $2, 'login', $3, $4, $5, $6, $7)`,
		[credId, name, run.person_id, run.id, run.agent_id, ok, detail],
	);
}

export async function resolveCredential(run: RunRef, name: string, url: string) {
	const r = await row<CredentialRow & { username_enc: string; password_enc: string }>(
		`select c.* from credentials c join credential_grants g on g.credential_id = c.id
		 where g.agent_id = $1 and c.name = $2 and c.person_id = $3`,
		[run.agent_id, name, run.person_id],
	);
	if (!r) {
		await log(run, null, name, false, 'no concedida a este agente');
		return { ok: false as const, error: `No tienes acceso a "${name}".` };
	}
	if (url) {
		let origin = '';
		try {
			origin = originOf(url);
		} catch {}
		if (origin !== r.origin) {
			await log(run, r.id, name, false, `origen distinto: ${origin || url}`);
			return { ok: false as const, error: `"${name}" sólo se usa en ${r.origin}.` };
		}
	}
	await log(run, r.id, name, true, url || r.login_url);
	return {
		ok: true as const,
		credential: { username: open(r.username_enc), password: open(r.password_enc), url: r.login_url },
	};
}
