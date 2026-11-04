// Giving an agent to someone else. Transfer: it changes hands with everything it has — its chats, files,
// browser profile, MCP sign-ins, schedules and the accesses its owner had granted it, which the new owner
// gets as their own copies (a name they already have is used instead, and reported). Copy: a new agent
// for them with the same configuration (role, model, harness, schedules paused) and no credentials.
// Only the owner does either, with the computer off.
import { exec, row, rows, tx, type Exec } from './db';
import * as agents from './agents';
import * as channels from './channels';
import * as hub from './hub';

type Clash = { kind: 'key' | 'mcp' | 'site'; name: string };

async function target(agent: agents.Agent, rawTo: unknown, on?: Exec) {
	const to = Number(rawTo);
	if (!Number.isSafeInteger(to) || to <= 0) throw new Error('Elige a quién.');
	const person = await row<{ id: number; name: string }>('select id, name from people where id = $1', [to], on);
	if (!person) throw new Error('Esa persona no existe.');
	return person;
}

async function idle(agentId: number, on: Exec) {
	if (
		await row(
			"select 1 from runs where agent_id = $1 and status in ('queued','starting','running','blocked')",
			[agentId],
			on,
		)
	)
		throw new Error('Apaga su computadora y espera a que termine su trabajo antes de pasarlo a alguien.');
}

/** The accesses granted to the agent, copied into the new owner's own (same sealed values: one master key). */
async function moveAccesses(agentId: number, from: number, to: number, c: Exec) {
	const clashes: Clash[] = [];
	const moved = { keys: 0, mcp: 0, sites: 0 };
	// API keys
	for (const k of await rows<{ id: number; name: string }>(
		'select k.id, k.name from person_keys k join person_key_grants g on g.key_id = k.id where g.agent_id = $1 and k.person_id = $2',
		[agentId, from],
		c,
	)) {
		const mine = await row<{ id: number }>(
			'select id from person_keys where person_id = $1 and name = $2',
			[to, k.name],
			c,
		);
		const id = mine
			? mine.id
			: (await row<{ id: number }>(
					`insert into person_keys (person_id, name, value_enc, domains, expose_real)
					 select $2, name, value_enc, domains, expose_real from person_keys where id = $1 returning id`,
					[k.id, to],
					c,
				))!.id;
		if (mine) clashes.push({ kind: 'key', name: k.name });
		await exec('delete from person_key_grants where key_id = $1 and agent_id = $2', [k.id, agentId], c);
		await exec(
			'insert into person_key_grants (key_id, agent_id) values ($1, $2) on conflict do nothing',
			[id, agentId],
			c,
		);
		moved.keys++;
	}
	// MCP servers
	for (const m of await rows<{ id: number; name: string }>(
		'select m.id, m.name from person_mcp m join person_mcp_grants g on g.mcp_id = m.id where g.agent_id = $1 and m.person_id = $2',
		[agentId, from],
		c,
	)) {
		const mine = await row<{ id: number }>(
			'select id from person_mcp where person_id = $1 and name = $2',
			[to, m.name],
			c,
		);
		const id = mine
			? mine.id
			: (await row<{ id: number }>(
					`insert into person_mcp (person_id, name, description, transport, url, command, args, headers, env, domains, expose_real, oauth)
					 select $2, name, description, transport, url, command, args, headers, env, domains, expose_real, oauth
					 from person_mcp where id = $1 returning id`,
					[m.id, to],
					c,
				))!.id;
		if (mine) clashes.push({ kind: 'mcp', name: m.name });
		await exec('delete from person_mcp_grants where mcp_id = $1 and agent_id = $2', [m.id, agentId], c);
		await exec(
			'insert into person_mcp_grants (mcp_id, agent_id) values ($1, $2) on conflict do nothing',
			[id, agentId],
			c,
		);
		moved.mcp++;
	}
	// Site logins
	for (const s of await rows<{ id: number; name: string }>(
		'select s.id, s.name from credentials s join credential_grants g on g.credential_id = s.id where g.agent_id = $1 and s.person_id = $2',
		[agentId, from],
		c,
	)) {
		const mine = await row<{ id: number }>(
			'select id from credentials where person_id = $1 and name = $2',
			[to, s.name],
			c,
		);
		const id = mine
			? mine.id
			: (await row<{ id: number }>(
					`insert into credentials (person_id, name, origin, login_url, username_enc, password_enc, totp_enc)
					 select $2, name, origin, login_url, username_enc, password_enc, totp_enc from credentials where id = $1 returning id`,
					[s.id, to],
					c,
				))!.id;
		if (mine) clashes.push({ kind: 'site', name: s.name });
		await exec('delete from credential_grants where credential_id = $1 and agent_id = $2', [s.id, agentId], c);
		await exec(
			'insert into credential_grants (credential_id, agent_id) values ($1, $2) on conflict do nothing',
			[id, agentId],
			c,
		);
		moved.sites++;
	}
	return { moved, clashes };
}

export async function transfer(agent: agents.Agent, rawTo: unknown, by: number) {
	const result = await tx(async (c) => {
		const current = await row<{ person_id: number }>(
			'select person_id from agents where id = $1 and deleted_at is null for update',
			[agent.id],
			c,
		);
		if (!current || current.person_id !== by) throw new Error('Sólo su dueño lo transfiere.');
		const to = await target(agent, rawTo, c);
		if (to.id === by) throw new Error('Ya es tuyo.');
		await idle(agent.id, c);
		const accesses = await moveAccesses(agent.id, by, to.id, c);
		await exec('update agents set person_id = $2 where id = $1', [agent.id, to.id], c);
		// Who it was shared with was the old owner's choice; their own marks of it go with them.
		await exec('delete from agent_shares where agent_id = $1', [agent.id], c);
		await exec('delete from agent_aliases where agent_id = $1 and person_id = $2', [agent.id, by], c);
		await exec(
			`delete from pins where person_id = $1 and ((kind = 'agent' and ref_id = $2)
			   or (kind = 'conversation' and ref_id in (select id from conversations where agent_id = $2)))`,
			[by, agent.id],
			c,
		);
		await exec("delete from agent_designs where agent_id = $1 and status <> 'approved'", [agent.id], c);
		await exec(
			`insert into agent_transfers (kind, agent_id, from_person, to_person, by_person, detail)
			 values ('transfer', $1, $2, $3, $2, $4)`,
			[agent.id, by, to.id, JSON.stringify(accesses)],
			c,
		);
		return { to, ...accesses };
	});
	hub.setShares(agent.id, []);
	hub.forgetAgent(agent.id); // its last frames were cached for its old owner's viewers
	return result;
}

export async function copy(agent: agents.Agent, rawTo: unknown, by: number) {
	if (agent.person_id !== by) throw new Error('Sólo su dueño lo copia.');
	const to = await target(agent, rawTo);
	const name = to.id === by ? `${agent.name.slice(0, 32)} (copia)` : agent.name;
	const made = await tx(async (c) => {
		const created = await agents.create(
			to.id,
			{ name, role: agent.role, model: agent.model, harness: agent.harness, image: agent.harness_image ?? undefined },
			c,
		);
		await exec(
			`insert into agent_transfers (kind, agent_id, copy_id, from_person, to_person, by_person)
			 values ('copy', $1, $2, $3, $4, $3)`,
			[agent.id, created.id, by, to.id],
			c,
		);
		return created;
	});
	// Its schedules come paused: they would spend the new owner's quota before they look at them.
	for (const s of await channels.schedulesIfRunning(agent.id)) await channels.addSchedule(made.id, s.cron, s.message);
	const copied = await channels.schedulesIfRunning(made.id);
	for (const s of copied) await channels.pauseSchedule(made.id, s.name, true);
	return { to, agent: made, schedules: copied.length };
}
