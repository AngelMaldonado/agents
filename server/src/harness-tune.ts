// Avanzado → its skill tree (Angel 12-nov-2026): its owner tunes its harness by hand (a tool off, a skill out,
// a rubric weight), and it is easy: the change is tested in the background on the agent's image, the same
// isolated test Automejora runs, and applied as a new revision only if it passes. If it fails, the agent stays
// as it was (the last revision that worked) and its owner sees why. One change at a time per agent.
import { exec, row, rows, tx } from './db';
import * as agents from './agents';
import { harnessHash, saveRevision, validateHarness, type Harness } from './harnesses';
import { runtimeToolNames } from '../../sandbox/harness';
import { claimHarnessValidation, ImageUpdateWaiting } from './image-updates';
import { DockerSandbox } from './sandbox/docker';

export type Tune = {
	id: number;
	status: 'testing' | 'waiting' | 'applied' | 'failed';
	summary: string;
	error: string | null;
	revision: number | null;
	created_at: number;
	updated_at: number;
};
const COLS = 'id, status, summary, error, revision, created_at, updated_at';

/** The tests, and when the agent is busy the wait to apply: tests replace it. */
export const tuning = {
	docker: new DockerSandbox() as Pick<DockerSandbox, 'probeHarness'>,
	pause: (ms: number) => new Promise((r) => setTimeout(r, ms)),
};

/** Its latest change (what the panel shows while it is tested, and how it ended). */
export async function latest(agentId: number) {
	return row<Tune>(`select ${COLS} from harness_tunes where agent_id = $1 order by id desc limit 1`, [agentId]);
}

/** Its owner asks for this harness: validated now, then tested and applied in the background. */
export async function request(agentId: number, personId: number, input: { harness?: unknown; summary?: unknown }) {
	const a = await agents.get(agentId);
	if (!a || a.person_id !== personId) throw new Error('No es tuyo.');
	const h = validateHarness(input.harness); // a harness the platform would not take fails here, at once
	if (harnessHash(h) === harnessHash(a.harness)) throw new Error('No hay cambios que probar.');
	if (await row("select 1 from harness_tunes where agent_id = $1 and status in ('testing', 'waiting')", [agentId]))
		throw new Error('Ya hay un cambio en prueba: espera a que termine.');
	const t = (await row<Tune>(
		`insert into harness_tunes (agent_id, person_id, base_revision, harness, summary)
		 values ($1, $2, $3, $4, $5) returning ${COLS}`,
		[agentId, personId, a.config_revision, JSON.stringify(h), String(input.summary ?? '').slice(0, 300)],
	))!;
	void run(t.id);
	return t;
}

const set = (id: number, status: Tune['status'], extra: { error?: string; revision?: number } = {}) =>
	exec('update harness_tunes set status = $2, error = $3, revision = $4, updated_at = now() where id = $1', [
		id,
		status,
		extra.error ?? null,
		extra.revision ?? null,
	]);

/** Test, then apply once its computer is free; any failure leaves the agent as it was. */
export async function run(id: number) {
	const t = await row<{ agent_id: number; person_id: number; base_revision: number; harness: Harness }>(
		'select agent_id, person_id, base_revision, harness from harness_tunes where id = $1',
		[id],
	);
	if (!t) return;
	let lease: string | null = null;
	try {
		const a = await agents.get(t.agent_id);
		if (!a) throw new Error('El agente ya no existe.');
		if (!a.harness_image || !/^sha256:[a-f0-9]{64}$/.test(a.harness_image))
			throw new Error('Su computadora no tiene una imagen fija para probar; actualízala primero.');
		const h = validateHarness(t.harness);
		// Another test (its own image update, a design) may hold the slot: wait for it a few minutes.
		for (let tries = 0; ; tries++)
			try {
				lease = await claimHarnessValidation(t.agent_id, t.person_id);
				break;
			} catch (e) {
				if (!(e instanceof ImageUpdateWaiting) || tries >= 20) throw e;
				await tuning.pause(15_000);
			}
		const probe = await tuning.docker.probeHarness(a.harness_image, h, process.env.AGENTS_INSTANCE ?? 'dev');
		if (
			probe.digest !== harnessHash(h) ||
			JSON.stringify(probe.tools) !== JSON.stringify(runtimeToolNames(h)) ||
			JSON.stringify(probe.skills) !== JSON.stringify(h.skills.map((s) => s.name)) ||
			JSON.stringify(probe.plugins) !== JSON.stringify(h.plugins)
		)
			throw new Error('Su computadora no cargó el harness con este cambio.');
		await exec('delete from sandbox_image_checks where token = $1', [lease]);
		lease = null;
		// Tested: it goes in between runs (up to half an hour of waiting for one to end).
		for (let tries = 0; ; tries++) {
			const busy = await row(
				"select 1 from runs where agent_id = $1 and status in ('queued', 'starting', 'running', 'blocked')",
				[t.agent_id],
			);
			if (!busy) break;
			if (tries === 0) await set(id, 'waiting');
			if (tries >= 120) throw new Error('Pasó media hora trabajando sin parar: no se aplicó. Vuelve a intentarlo.');
			await tuning.pause(15_000);
		}
		const revision = await tx(async (c) => {
			const now = await row<{ config_revision: number }>(
				'select config_revision from agents where id = $1 and deleted_at is null for update',
				[t.agent_id],
				c,
			);
			if (!now) throw new Error('El agente ya no existe.');
			if (now.config_revision !== t.base_revision)
				throw new Error('Su configuración cambió mientras se probaba: no se aplicó. Vuelve a intentarlo.');
			await exec(
				'update agents set harness = $2, config_revision = config_revision + 1 where id = $1',
				[t.agent_id, JSON.stringify(h)],
				c,
			);
			await saveRevision((await agents.get(t.agent_id, c))!, c);
			return now.config_revision + 1;
		});
		await set(id, 'applied', { revision });
	} catch (e) {
		// Docker's own output may carry secrets: only the first line of what the platform says.
		const message = String((e as Error).message ?? e)
			.split('\n')[0]
			.slice(0, 300);
		await set(id, 'failed', { error: message || 'La prueba falló.' }).catch(() => {});
	} finally {
		if (lease) await exec('delete from sandbox_image_checks where token = $1', [lease]).catch(() => {});
	}
}

/** At boot: a test the server did not finish never applied; its owner tries again. */
export async function recover() {
	for (const t of await rows<{ id: number }>(
		"update harness_tunes set status = 'failed', error = 'El servidor se reinició durante la prueba: no se aplicó. Vuelve a intentarlo.', updated_at = now() where status in ('testing', 'waiting') returning id",
	))
		void t;
}
