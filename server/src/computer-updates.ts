// Durable computer maintenance, separate from conversations/model runs. PostgreSQL is the UI's truth;
// DBOS only orchestrates. Agent revision + item completion commit together, so step replay is safe.
import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { exec, row, rows, tx } from './db';
import { definition, digest } from './harnesses';
import * as agents from './agents';
import * as imageUpdates from './image-updates';
import * as hub from './hub';
import { requestRoute } from './inbox';
import { settings } from './settings';
import { DockerSandbox } from './sandbox/docker';
import {
	jobPending,
	updatePending,
	type ComputerImage,
	type ComputerUpdateItem,
	type ComputerUpdateJob,
	type ComputerUpdateOverview,
	type ComputerUpdateState,
} from '../../shared/computer-updates';

type Docker = Pick<
	DockerSandbox,
	'imageInfo' | 'imagePiVersion' | 'imageId' | 'imagePullRef' | 'pullImage' | 'probeHarness'
>;
type Stored = Omit<ComputerUpdateJob, 'items'> & { person_id: number; request_hash: string; pull_ref: string | null };
type Selection = { id: number; revision: number };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ACTIVE = "('queued','waiting','validating','applying')";
const docker = new DockerSandbox();
const workflowId = (id: string) => `computer-update:${id}`;
const load = (id: string) => row<Stored>('select * from computer_update_jobs where id=$1', [id]);

async function publicJob(job: Stored): Promise<ComputerUpdateJob> {
	const { id, target, status, message, created_at, updated_at } = job;
	const items = await rows<ComputerUpdateItem>(
		'select agent_id,name,revision,status,error,applied_revision from computer_update_items where job_id=$1 order by agent_id',
		[id],
	);
	return { id, target, status, message, created_at, updated_at, items };
}
export async function get(id: string, by: number) {
	if (!UUID.test(id)) throw new Error('Job no disponible.');
	const job = await load(id);
	if (!job || job.person_id !== by) throw new Error('Job no disponible.');
	return publicJob(job);
}
async function broadcast(id: string) {
	const job = await load(id);
	if (!job) return;
	const view = await publicJob(job);
	hub.toPerson(job.person_id, { t: 'computer-update', personId: job.person_id, job: view });
	for (const item of view.items) if (!updatePending(item.status)) requestRoute(item.agent_id);
}
export async function overview(by: number, engine: Docker = docker): Promise<ComputerUpdateOverview> {
	let target: ComputerImage | null = null,
		error: string | null = null;
	try {
		target = await imageUpdates.publishedImage(engine);
	} catch (e) {
		error = (e as Error).message;
	}
	const owned = await rows<{
		id: number;
		name: string;
		revision: number;
		currentImage: string | null;
		version: string | null;
		piVersion: string | null;
		development: boolean | null;
		imageRevision: string | null;
		dirty: boolean | null;
		busy: boolean;
		activeJobId: string | null;
	}>(
		`select a.id,a.name,a.config_revision as revision,a.harness_image as "currentImage",
		 i.version, i.pi_version as "piVersion", i.development, i.revision as "imageRevision", i.dirty,
		 exists(select 1 from runs where agent_id=a.id and status in ('queued','starting','running','blocked')) as busy,
		 (select job_id from computer_update_items where agent_id=a.id and status in ${ACTIVE}) as "activeJobId"
		 from agents a left join sandbox_images i on i.image_id = a.harness_image
		 where a.person_id=$1 and a.deleted_at is null order by a.name,a.id`,
		[by],
	);
	const stored = await rows<Stored>(
		`select * from computer_update_jobs where person_id=$1 and
		(status in ('queued','preparing','running') or id in
		 (select id from computer_update_jobs where person_id=$1 order by created_at desc limit 10)) order by created_at desc`,
		[by],
	);
	return {
		target,
		error,
		agents: owned.map(({ version, piVersion, development, imageRevision, dirty, ...a }) => ({
			...a,
			current: a.currentImage
				? { imageId: a.currentImage, version, piVersion, development: !!development, revision: imageRevision, dirty }
				: null,
			updateAvailable: !!target && a.currentImage !== target.imageId,
		})),
		jobs: await Promise.all(stored.map(publicJob)),
	};
}

/** Creates the durable request first. Dispatch is separate, reconciled at boot/periodically after crashes. */
export async function request(
	by: number,
	input: { requestId?: unknown; imageId?: unknown; agents?: unknown; shutdown?: unknown },
	engine: Docker = docker,
	frozen?: { target: ComputerImage; pullRef: string | null },
	stop: Stop = stopRun,
) {
	if (
		!input ||
		typeof input.requestId !== 'string' ||
		!UUID.test(input.requestId) ||
		typeof input.imageId !== 'string' ||
		!/^sha256:[a-f0-9]{64}$/.test(input.imageId) ||
		!Array.isArray(input.agents) ||
		input.agents.length < 1 ||
		input.agents.length > 200
	)
		throw new Error('Selecciona computadoras y recarga la versión disponible.');
	const selected: Selection[] = input.agents
		.map((a) => {
			if (!a || !Number.isSafeInteger(a.id) || a.id < 1 || !Number.isSafeInteger(a.revision) || a.revision < 1)
				throw new Error('Selección de computadoras inválida.');
			return { id: a.id, revision: a.revision };
		})
		.sort((a, b) => a.id - b.id);
	if (new Set(selected.map((a) => a.id)).size !== selected.length)
		throw new Error('Una computadora aparece dos veces.');
	const hash = digest({ imageId: input.imageId, agents: selected });
	const previous = await row<Stored>('select * from computer_update_jobs where person_id=$1 and request_id=$2', [
		by,
		input.requestId,
	]);
	if (previous) {
		if (previous.request_hash !== hash) throw new Error('Esta solicitud ya se usó con otra selección.');
		return publicJob(previous);
	}
	const target = frozen?.target ?? (await imageUpdates.publishedImage(engine));
	if (target.imageId !== input.imageId) throw new Error('La imagen disponible cambió. Revisa la nueva versión.');
	const pullRef = frozen ? frozen.pullRef : await engine.imagePullRef(target.imageId, settings().sandboxImage);
	const id = await tx(async (c) => {
		await exec("select pg_advisory_xact_lock(hashtext('agents.computer-update-request:' || $1::text))", [by], c);
		const repeated = await row<Stored>(
			'select * from computer_update_jobs where person_id=$1 and request_id=$2',
			[by, input.requestId],
			c,
		);
		if (repeated) {
			if (repeated.request_hash !== hash) throw new Error('Esta solicitud ya se usó con otra selección.');
			return repeated.id;
		}
		const current = await rows<agents.Agent>(
			'select * from agents where id=any($1::integer[]) and person_id=$2 and deleted_at is null order by id for update',
			[selected.map((a) => a.id), by],
			c,
		);
		if (current.length !== selected.length) throw new Error('Sólo puedes actualizar tus propias computadoras.');
		const active = await rows<{ job_id: string; request_hash: string }>(
			`select distinct j.id as job_id,j.request_hash from computer_update_items i join computer_update_jobs j on j.id=i.job_id where i.agent_id=any($1::integer[]) and i.status in ${ACTIVE}`,
			[selected.map((a) => a.id)],
			c,
		);
		if (active.length) {
			if (active.length === 1 && active[0].request_hash === hash) return active[0].job_id;
			throw new Error('Alguna computadora ya tiene una actualización programada. Revisa el progreso existente.');
		}
		if (
			await row(
				"select 1 from agent_repairs where agent_id=any($1::bigint[]) and status in ('approved','running')",
				[selected.map((a) => a.id)],
				c,
			)
		)
			throw new Error('Hay una reparación autorizada pendiente. Espera a que termine.');
		for (const a of current) {
			if (a.config_revision !== selected.find((s) => s.id === a.id)!.revision)
				throw new Error(`La configuración de ${a.name} cambió. Recarga antes de actualizar.`);
			if (a.harness_image === target.imageId) throw new Error(`${a.name} ya usa esta imagen. Recarga la selección.`);
		}
		const jobId = randomUUID();
		await exec(
			'insert into computer_update_jobs(id,person_id,request_id,request_hash,target,pull_ref) values ($1,$2,$3,$4,$5,$6)',
			[jobId, by, input.requestId, hash, JSON.stringify(target), pullRef],
			c,
		);
		for (const a of current)
			await exec(
				'insert into computer_update_items(job_id,agent_id,name,revision,definition_digest) values ($1,$2,$3,$4,$5)',
				[jobId, a.id, a.name, a.config_revision, definition(a).digest],
				c,
			);
		return jobId;
	});
	// The owner chose to update now: a busy computer is turned off instead of waited for. After the job,
	// so its reservation already holds back any message waiting to start another run on it.
	if (input.shutdown === true)
		await shutdown(
			selected.map((a) => a.id),
			stop,
		);
	await broadcast(id);
	return get(id, by);
}

type Stop = (run: { id: number; kind: string }) => Promise<void>;
/** Its browser session closes (saving the profile); a task in progress is cancelled, keeping what it did. */
const stopRun: Stop = async (r) => {
	const tasks = await import('./tasks');
	await (r.kind === 'browser'
		? tasks.closeBrowser(r.id)
		: tasks.cancel(r.id, 'Se apagó su computadora para actualizarla.'));
};
async function shutdown(agentIds: number[], stop: Stop) {
	const live = await rows<{ id: number; kind: string }>(
		"select id, kind from runs where agent_id=any($1::bigint[]) and status in ('starting','running','blocked')",
		[agentIds],
	);
	for (const r of live)
		await stop(r).catch((e) => console.warn(`computer update: could not stop run ${r.id}: ${(e as Error).message}`));
}

async function setItem(id: string, agent: number, state: ComputerUpdateState, error: string | null = null) {
	const changed = await exec(
		`update computer_update_items set status=$3,error=$4,updated_at=now() where job_id=$1 and agent_id=$2 and status in ${ACTIVE}
		 and (status is distinct from $3 or error is distinct from $4)`,
		[id, agent, state, error?.slice(0, 1500) ?? null],
	);
	if (!changed)
		return !!(await row(`select 1 from computer_update_items where job_id=$1 and agent_id=$2 and status in ${ACTIVE}`, [
			id,
			agent,
		]));
	await exec('update computer_update_jobs set updated_at=now() where id=$1', [id]);
	await broadcast(id);
	return true;
}
export async function finish(id: string) {
	const items = await rows<{ status: ComputerUpdateState }>(
		'select status from computer_update_items where job_id=$1',
		[id],
	);
	if (items.some((i) => updatePending(i.status))) return;
	const done = items.filter((i) => i.status === 'done').length;
	const failed = items.filter((i) => i.status === 'failed').length;
	const status = done === items.length ? 'done' : done ? 'partial' : failed ? 'failed' : 'cancelled';
	await exec('update computer_update_jobs set status=$2,updated_at=now() where id=$1', [id, status]);
	await broadcast(id);
}
async function failJob(id: string, error: string) {
	await exec(
		`update computer_update_items set status='failed',error=$2,updated_at=now() where job_id=$1 and status in ${ACTIVE}`,
		[id, error.slice(0, 1500)],
	);
	await exec('update computer_update_jobs set message=$2,updated_at=now() where id=$1', [id, error.slice(0, 1500)]);
	await finish(id);
}

export async function prepare(id: string, engine: Docker = docker) {
	const job = await load(id);
	if (!job || !jobPending(job)) return false;
	try {
		if (
			!(await exec(
				"update computer_update_jobs set status='preparing',message='Preparando imagen destino',updated_at=now() where id=$1 and status in ('queued','preparing','running')",
				[id],
			))
		)
			return false;
		await broadcast(id);
		try {
			if ((await engine.imageId(job.target.imageId)) !== job.target.imageId) throw new Error('La imagen no coincide.');
		} catch {
			if (!job.pull_ref)
				throw new Error(
					'La imagen destino ya no está en Docker y no tiene un digest de registry recuperable. Pide al administrador que la recupere; no se eligió otra imagen.',
				);
			await engine.pullImage(job.pull_ref, async (message) => {
				await exec("update computer_update_jobs set message=$2,updated_at=now() where id=$1 and status='preparing'", [
					id,
					message.slice(0, 500),
				]);
				await broadcast(id);
			});
			if ((await engine.imageId(job.pull_ref)) !== job.target.imageId)
				throw new Error('La imagen descargada no coincide con el ID aprobado.');
		}
		const changed = await exec(
			"update computer_update_jobs set status='running',message='Imagen preparada; validación por computadora',updated_at=now() where id=$1 and status='preparing'",
			[id],
		);
		await broadcast(id);
		return !!changed;
	} catch (e) {
		await failJob(id, (e as Error).message);
		return false;
	}
}

/** One bounded attempt. Waiting for a run/validation capacity never holds a queue worker or shuts it down. */
export async function attempt(id: string, agentId: number, engine: Docker = docker): Promise<boolean> {
	const job = await load(id);
	if (!job || !jobPending(job)) return true;
	const item = await row<ComputerUpdateItem & { definition_digest: string }>(
		'select * from computer_update_items where job_id=$1 and agent_id=$2',
		[id, agentId],
	);
	if (!item || !updatePending(item.status)) {
		requestRoute(agentId);
		return true;
	}
	try {
		const a = await agents.get(agentId);
		if (!a || a.person_id !== job.person_id) throw new Error('El agente ya no existe o cambió de dueño.');
		if (definition(a).digest !== item.definition_digest)
			throw new Error('La configuración cambió desde que se programó la actualización. Revisa y vuelve a solicitarla.');
		if (
			await row("select 1 from runs where agent_id=$1 and status in ('queued','starting','running','blocked')", [
				agentId,
			])
		) {
			await setItem(id, agentId, 'waiting');
			return false;
		}
		const result = await imageUpdates.update(
			agentId,
			job.person_id,
			{ revision: item.revision, imageId: job.target.imageId },
			engine,
			{
				jobId: id,
				target: job.target,
				onPhase: async (phase) => {
					if (!(await setItem(id, agentId, phase))) throw new Error('La actualización ya no está activa.');
				},
			},
		);
		// The normal apply commits item completion with the revision; handle a no-op defensively, too.
		await exec(
			`update computer_update_items set status='done',applied_revision=$3,error=null,updated_at=now()
			where job_id=$1 and agent_id=$2 and status in ${ACTIVE}`,
			[id, agentId, result.agent.config_revision],
		);
		await exec('update computer_update_jobs set updated_at=now() where id=$1', [id]);
		await broadcast(id);
		return true;
	} catch (e) {
		if (e instanceof imageUpdates.ImageUpdateWaiting) {
			await setItem(id, agentId, e.reason === 'busy' ? 'waiting' : 'queued');
			return false;
		}
		await setItem(id, agentId, 'failed', (e as Error).message);
		return true;
	}
}

export async function cancelPending(id: string, by: number) {
	await get(id, by);
	await tx(async (c) => {
		await rows(
			'select id from agents where id in (select agent_id from computer_update_items where job_id=$1) order by id for update',
			[id],
			c,
		);
		await exec(
			"update computer_update_items set status='cancelled',updated_at=now() where job_id=$1 and status in ('queued','waiting')",
			[id],
			c,
		);
		await exec('update computer_update_jobs set updated_at=now() where id=$1', [id], c);
	});
	await finish(id);
	await broadcast(id);
	return get(id, by);
}
export async function retryFailed(id: string, by: number, requestId: unknown, engine: Docker = docker) {
	const previous = await get(id, by),
		stored = (await load(id))!;
	const failed = previous.items.filter((i) => i.status === 'failed');
	if (!failed.length) throw new Error('No hay computadoras fallidas para reintentar.');
	return request(
		by,
		{
			requestId,
			imageId: previous.target.imageId,
			agents: failed.map((i) => ({ id: i.agent_id, revision: i.revision })),
		},
		engine,
		{ target: previous.target, pullRef: stored.pull_ref },
	);
}

// Recovery may begin inside DBOS.launch(), before tasks.recover() has swept old containers.
// Gate physical work inside every replayable step until startup reconciliation is finished.
let enableWork!: () => void;
const operational = new Promise<void>((resolve) => {
	enableWork = resolve;
});
const prepareWorkflow = DBOS.registerWorkflow(
	async (id: string) =>
		DBOS.runStep(
			async () => {
				await operational;
				return prepare(id);
			},
			{ name: 'prepare-image', retriesAllowed: true, maxAttempts: 3 },
		),
	{ name: 'computerUpdatePrepareV1' },
);
const attemptWorkflow = DBOS.registerWorkflow(
	async (id: string, agent: number) =>
		DBOS.runStep(
			async () => {
				await operational;
				return attempt(id, agent);
			},
			{ name: 'update-computer', retriesAllowed: true, maxAttempts: 3 },
		),
	{ name: 'computerUpdateAttemptV1' },
);
const jobWorkflow = DBOS.registerWorkflow(
	async (id: string) => {
		const prep = await DBOS.startWorkflow(prepareWorkflow, {
			workflowID: `${workflowId(id)}:prepare`,
			queueName: 'computer-image-preparation',
		})(id);
		if (!(await prep.getResult())) return;
		for (let round = 0; ; round++) {
			const pending = await DBOS.runStep(
				() =>
					rows<{ agent_id: number }>(
						`select agent_id from computer_update_items where job_id=$1 and status in ${ACTIVE} order by agent_id`,
						[id],
					),
				{ name: `pending-${round}` },
			);
			if (!pending.length) break;
			const handles = [];
			for (const i of pending)
				handles.push(
					await DBOS.startWorkflow(attemptWorkflow, {
						workflowID: `${workflowId(id)}:${i.agent_id}:${round}`,
						queueName: 'computer-updates',
					})(id, i.agent_id),
				);
			const finished = await Promise.all(handles.map((h) => h.getResult()));
			if (finished.every(Boolean)) break;
			await DBOS.sleep(5000);
		}
		await DBOS.runStep(() => finish(id), { name: 'finish' });
	},
	{ name: 'computerUpdateJobV1' },
);

export const dispatch = (id: string) => DBOS.startWorkflow(jobWorkflow, { workflowID: workflowId(id) })(id);
export async function recover() {
	await DBOS.registerQueue('computer-image-preparation', { concurrency: 1, onConflict: 'always_update' });
	await DBOS.registerQueue('computer-updates', {
		concurrency: Math.min(2, settings().maxConcurrent),
		onConflict: 'always_update',
	});
	enableWork();
	for (const job of await rows<{ id: string }>(
		"select id from computer_update_jobs where status in ('queued','preparing','running')",
	)) {
		try {
			const status = await DBOS.getWorkflowStatus(workflowId(job.id));
			if (status?.status === 'ERROR' || status?.status === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED')
				await failJob(
					job.id,
					'El job no pudo continuar. Las revisiones ya aplicadas se conservan; puedes reintentar las fallidas.',
				);
			else if (status?.status === 'CANCELLED') await failJob(job.id, 'El servidor canceló este job.');
			else await dispatch(job.id);
		} catch (e) {
			console.warn('computer update dispatch:', (e as Error).message);
		}
	}
}
let reconciling = false;
export function startReconciler() {
	const timer = setInterval(async () => {
		if (reconciling) return;
		reconciling = true;
		try {
			await recover();
		} catch (e) {
			console.warn('computer update recovery:', (e as Error).message);
		} finally {
			reconciling = false;
		}
	}, 15000);
	timer.unref();
}
