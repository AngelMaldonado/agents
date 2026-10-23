// Workers: stable characters owned by a person. Each task gets a fresh sandbox.
import { randomBytes } from 'node:crypto';
import { db, now } from './db';
import { settings } from './settings';
import { publicTask, type Task } from './tasks';
import type { Person } from './people';

export type Agent = {
	id: number; person_id: number; name: string; role: string; model: string; seed: string; created_at: number;
};

export function visible(viewer: Person) {
	const rows = db
		.query(
			`SELECT a.id, a.person_id, a.name, a.role, a.model, a.seed, a.created_at, p.name AS owner
			 FROM agents a JOIN people p ON p.id = a.person_id
			 WHERE a.deleted_at IS NULL ${viewer.admin ? '' : 'AND a.person_id = ?'}
			 ORDER BY a.person_id = ? DESC, a.id`
		)
		.all(...(viewer.admin ? [viewer.id] : [viewer.id, viewer.id])) as (Agent & { owner: string })[];
	return rows.map((a) => {
		const last = db.query('SELECT * FROM tasks WHERE agent_id = ? ORDER BY id DESC LIMIT 1').get(a.id) as Task | null;
		return { ...a, task: last ? publicTask(last) : null };
	});
}

export function get(id: number) {
	return db.query('SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL').get(id) as Agent | null;
}

/** The agent if the viewer may see it. */
export function seeable(viewer: Person, id: number) {
	const a = get(id);
	return a && (viewer.admin || a.person_id === viewer.id) ? a : null;
}

function checkModel(model: string) {
	if (!settings().models.some((m) => m.id === model)) throw new Error('Ese modelo no está en el catálogo.');
}

export function create(personId: number, input: { name: string; role?: string; model: string }) {
	const name = String(input.name ?? '').trim().slice(0, 40);
	if (!name) throw new Error('Falta el nombre.');
	checkModel(input.model);
	const { lastInsertRowid } = db
		.query('INSERT INTO agents (person_id, name, role, model, seed, created_at) VALUES (?, ?, ?, ?, ?, ?)')
		.run(personId, name, String(input.role ?? '').slice(0, 4000), input.model, randomBytes(6).toString('hex'), now());
	return get(Number(lastInsertRowid))!;
}

export function edit(agent: Agent, input: { name?: string; role?: string; model?: string }) {
	const name = input.name !== undefined ? String(input.name).trim().slice(0, 40) : agent.name;
	if (!name) throw new Error('Falta el nombre.');
	const model = input.model ?? agent.model;
	if (model !== agent.model) checkModel(model);
	db.query('UPDATE agents SET name = ?, role = ?, model = ? WHERE id = ?').run(
		name,
		input.role !== undefined ? String(input.role).slice(0, 4000) : agent.role,
		model,
		agent.id
	);
	return get(agent.id)!;
}

export function retire(agent: Agent) {
	db.query('UPDATE agents SET deleted_at = ? WHERE id = ?').run(now(), agent.id);
}

export function tasksOf(agentId: number) {
	return (db.query('SELECT * FROM tasks WHERE agent_id = ? ORDER BY id DESC LIMIT 50').all(agentId) as Task[]).map(publicTask);
}
