import { afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mergeUpdateJob, type ComputerUpdateJob } from '../../shared/computer-updates';
import { DockerSandbox } from './sandbox/docker';

const url = process.env.AGENTS_TEST_DATABASE_URL,
	run = url ? test : test.skip;
process.env.AGENTS_DATA ??= '/tmp';
const db = url ? await import('./db') : null;
const jobs = await import('./computer-updates');
const oldImage = `sha256:${randomBytes(32).toString('hex')}`,
	newImage = `sha256:${randomBytes(32).toString('hex')}`;
let owner = 0,
	outsider = 0;

beforeAll(async () => {
	if (!db || !url) return;
	(await import('./test-database')).assertTestDatabase(url, db.DATABASE_URL);
	await db.migrate();
	for (const person of ['owner', 'outsider']) {
		const name = `computer-${person}-${crypto.randomUUID()}`;
		const r = (await db.row<{ id: number }>('insert into people(name,key,avatar_seed) values($1,$1,$1) returning id', [
			name,
		]))!;
		if (person === 'owner') owner = r.id;
		else outsider = r.id;
	}
});
afterEach(async () => {
	if (db && owner) await db.exec('delete from computer_update_jobs where person_id=$1', [owner]);
});

async function fixture(count = 1) {
	const agents = await import('./agents'),
		{ settings } = await import('./settings');
	const { harnessHash } = await import('./harnesses'),
		{ runtimeToolNames } = await import('../../sandbox/harness');
	// One after another: list order is id order, which is how a job lists its items.
	const list = [];
	for (let i = 0; i < count; i++)
		list.push(
			await agents.create(owner, {
				name: `Computadora ${i}`,
				role: `Rol ${i}`,
				model: settings().models[0].id,
				image: oldImage,
			}),
		);
	const probes: string[] = [],
		pulls: string[] = [];
	const engine = {
		imageInfo: async (ref: string) => ({
			imageId: ref === settings().sandboxImage || ref === newImage ? newImage : oldImage,
			version: '0.0.7-beta',
			piVersion: '1.4.0',
			development: false,
			revision: null,
			dirty: null,
		}),
		imagePiVersion: async () => '1.4.0',
		imageId: async (_ref: string) => newImage,
		imagePullRef: async () => `registry.example.test/agents@sha256:${'a'.repeat(64)}`,
		pullImage: async (ref: string, progress: (message: string) => Promise<void>) => {
			pulls.push(ref);
			await progress('Descarga de prueba');
		},
		probeHarness: async (image: string, raw: unknown) => {
			probes.push(image);
			const h = (await import('./harnesses')).validateHarness(raw);
			return {
				digest: harnessHash(h),
				tools: runtimeToolNames(h),
				skills: h.skills.map((s) => s.name),
				plugins: h.plugins,
			};
		},
	};
	const input = {
		requestId: crypto.randomUUID(),
		imageId: newImage,
		agents: list.map((a) => ({ id: a.id, revision: a.config_revision })),
	};
	return { agents, list, engine, probes, pulls, input };
}
async function browser(agent: Awaited<ReturnType<typeof fixture>>['list'][number]) {
	const conversation = (await db!.row<{ id: number }>('select id from conversations where agent_id=$1', [agent.id]))!;
	return (await db!.row<{ id: number }>(
		`insert into runs(agent_id,person_id,conversation_id,workflow_id,model,status,kind)
	 values($1,$2,$3,$4,$5,'running','browser') returning id`,
		[agent.id, owner, conversation.id, crypto.randomUUID(), agent.model],
	))!.id;
}

run('maintenance request is private, idempotent and reserves each selected computer once', async () => {
	const f = await fixture(2);
	const hub = await import('./hub'),
		messages: string[] = [],
		otherMessages: string[] = [];
	const own = hub.join({ id: owner, name: 'owner', admin: false, avatar_seed: '' }, (s) => messages.push(s));
	const other = hub.join({ id: outsider, name: 'admin', admin: true, avatar_seed: '' }, (s) => otherMessages.push(s));
	try {
		const job = await jobs.request(owner, f.input, f.engine);
		expect((await jobs.request(owner, f.input, f.engine)).id).toBe(job.id);
		expect((await jobs.request(owner, { ...f.input, requestId: crypto.randomUUID() }, f.engine)).id).toBe(job.id);
		expect(job.items).toHaveLength(2);
		expect(await (await import('./tasks')).pinnedImages()).toContain(newImage);
		expect(
			mergeUpdateJob([{ ...job, items: job.items.map((i) => ({ ...i, status: 'done' })) }], job)[0].items[0].status,
		).toBe('done');
		expect(f.probes).toEqual([]);
		expect(messages.some((s) => JSON.parse(s).t === 'computer-update')).toBe(true);
		expect(otherMessages).toEqual([]);
		await expect(jobs.get(job.id, outsider)).rejects.toThrow('Job no disponible');
		await expect(jobs.request(outsider, { ...f.input, requestId: crypto.randomUUID() }, f.engine)).rejects.toThrow(
			/propias/,
		);
		await expect(jobs.request(owner, { ...f.input, agents: [f.input.agents[0]] }, f.engine)).rejects.toThrow(
			/otra selección/,
		);
		expect((await jobs.overview(owner, f.engine)).agents.filter((a) => a.activeJobId === job.id)).toHaveLength(2);
	} finally {
		hub.leave(own);
		hub.leave(other);
	}
});

run('busy computers wait without stopping their run; inbox and admission wait, then apply exactly once', async () => {
	const f = await fixture(),
		a = f.list[0],
		runId = await browser(a);
	const job = await jobs.request(owner, f.input, f.engine);
	try {
		expect(await jobs.prepare(job.id, f.engine)).toBe(true);
		expect(await jobs.attempt(job.id, a.id, f.engine)).toBe(false);
		expect((await jobs.get(job.id, owner)).items[0].status).toBe('waiting');
		expect((await db!.row<{ status: string }>('select status from runs where id=$1', [runId]))!.status).toBe('running');
		expect(f.probes).toEqual([]);
		await db!.exec("update runs set status='done' where id=$1", [runId]);
		const conv = (await db!.row<{ id: number }>('select id from conversations where agent_id=$1', [a.id]))!;
		const message = (await db!.row<{ id: number }>(
			"insert into messages(agent_id,conversation_id,source,person_id,text) values($1,$2,'web',$3,'espera') returning id",
			[a.id, conv.id, owner],
		))!;
		await (await import('./inbox')).route(a.id);
		expect((await db!.row('select routed_at from messages where id=$1', [message.id]))!.routed_at).toBeNull();
		await expect((await import('./tasks')).startRun(a, message.id, 10)).rejects.toThrow(/actualización programada/);
		await expect((await import('./tasks')).enqueue(a, '', { admin: false, kind: 'browser' })).rejects.toThrow(
			/actualización programada/,
		);
		expect(await jobs.attempt(job.id, a.id, f.engine)).toBe(true);
		// Simulate replay after revision/item commit but before DBOS recorded the step's return.
		expect(await jobs.attempt(job.id, a.id, f.engine)).toBe(true);
		await jobs.finish(job.id);
		const updated = (await f.agents.get(a.id))!;
		expect(updated.harness_image).toBe(newImage);
		expect(updated.config_revision).toBe(a.config_revision + 1);
		expect(f.probes).toEqual([newImage]);
		expect((await jobs.get(job.id, owner)).status).toBe('done');
		expect(await (await import('./computer-maintenance')).maintenancePending(a.id)).toBeNull();
	} finally {
		await db!.exec('delete from runs where id=$1', [runId]);
	}
});

run('updating with shutdown turns a busy computer off: its session ends instead of being waited for', async () => {
	const f = await fixture(),
		a = f.list[0],
		runId = await browser(a);
	try {
		const stopped: { id: number; kind: string }[] = [];
		const stop = async (r: { id: number; kind: string }) => {
			stopped.push(r);
			await db!.exec("update runs set status='done' where id=$1", [r.id]); // what closeBrowser ends in
		};
		// Without shutdown it waits (the test above); with it, the session is told to close, once.
		const job = await jobs.request(owner, { ...f.input, shutdown: true }, f.engine, undefined, stop);
		expect(stopped).toEqual([{ id: runId, kind: 'browser' }]);
		expect(await jobs.prepare(job.id, f.engine)).toBe(true);
		expect(await jobs.attempt(job.id, a.id, f.engine)).toBe(true);
		expect((await f.agents.get(a.id))!.harness_image).toBe(newImage);
	} finally {
		await db!.exec('delete from runs where id=$1', [runId]);
	}
});

run('one failed harness does not block the others; retry selects only failures', async () => {
	const f = await fixture(2),
		job = await jobs.request(owner, f.input, f.engine);
	await jobs.prepare(job.id, f.engine);
	const probe = f.engine.probeHarness;
	f.engine.probeHarness = async () => {
		throw new Error('pi incompatible');
	};
	await jobs.attempt(job.id, f.list[0].id, f.engine);
	f.engine.probeHarness = probe;
	await jobs.attempt(job.id, f.list[1].id, f.engine);
	await jobs.finish(job.id);
	expect((await jobs.get(job.id, owner)).status).toBe('partial');
	expect((await f.agents.get(f.list[0].id))!.harness_image).toBe(oldImage);
	expect((await f.agents.get(f.list[1].id))!.harness_image).toBe(newImage);
	const retry = await jobs.retryFailed(job.id, owner, crypto.randomUUID(), f.engine);
	expect(retry.items.map((i) => i.agent_id)).toEqual([f.list[0].id]);
	await jobs.prepare(retry.id, f.engine);
	await jobs.attempt(retry.id, f.list[0].id, f.engine);
	await jobs.finish(retry.id);
	expect((await jobs.get(retry.id, owner)).status).toBe('done');
});

run('a queued job keeps its frozen target, and a changed definition fails without overwriting it', async () => {
	const f = await fixture(2),
		job = await jobs.request(owner, f.input, f.engine);
	const inspect = f.engine.imageInfo;
	f.engine.imageInfo = async (ref) => ({
		...(await inspect(ref)),
		imageId: ref === (await import('./settings')).settings().sandboxImage ? oldImage : newImage,
	});
	await jobs.prepare(job.id, f.engine);
	await jobs.attempt(job.id, f.list[0].id, f.engine);
	expect((await f.agents.get(f.list[0].id))!.harness_image).toBe(newImage);
	await db!.exec('update agents set config_revision=config_revision+1 where id=$1', [f.list[1].id]);
	await jobs.attempt(job.id, f.list[1].id, f.engine);
	const changed = (await jobs.get(job.id, owner)).items.find((i) => i.agent_id === f.list[1].id)!;
	expect(changed.error).toContain('configuración cambió');
	expect((await f.agents.get(f.list[1].id))!.harness_image).toBe(oldImage);
});

run('prepare recovers the exact registry digest if missing; cancellation releases waiting reservations', async () => {
	const f = await fixture(),
		job = await jobs.request(owner, f.input, f.engine);
	f.engine.imageId = async (ref) => {
		if (ref === newImage) throw new Error('No such image');
		return newImage;
	};
	expect(await jobs.prepare(job.id, f.engine)).toBe(true);
	expect(f.pulls).toEqual([await f.engine.imagePullRef()]);
	const cancelled = await jobs.cancelPending(job.id, owner);
	expect(cancelled.status).toBe('cancelled');
	expect(cancelled.items[0].status).toBe('cancelled');
	expect(await jobs.attempt(job.id, f.list[0].id, f.engine)).toBe(true);
	expect((await f.agents.get(f.list[0].id))!.harness_image).toBe(oldImage);
	expect(await (await import('./computer-maintenance')).maintenancePending(f.list[0].id)).toBeNull();
});

run(
	'DBOS resumes a waiting batch after shutdown; a duplicate dispatch never applies twice',
	async () => {
		const f = await fixture(),
			a = f.list[0],
			runId = await browser(a);
		const spies = [
			spyOn(DockerSandbox.prototype, 'imageInfo').mockImplementation(f.engine.imageInfo),
			spyOn(DockerSandbox.prototype, 'imagePiVersion').mockImplementation(f.engine.imagePiVersion),
			spyOn(DockerSandbox.prototype, 'imageId').mockImplementation(f.engine.imageId),
			spyOn(DockerSandbox.prototype, 'imagePullRef').mockImplementation(f.engine.imagePullRef),
			spyOn(DockerSandbox.prototype, 'pullImage').mockImplementation(f.engine.pullImage),
			spyOn(DockerSandbox.prototype, 'probeHarness').mockImplementation(f.engine.probeHarness),
		];
		const { DBOS } = await import('@dbos-inc/dbos-sdk');
		const schema = `dbos_computer_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
		const wait = async (predicate: () => Promise<boolean>) => {
			const deadline = Date.now() + 20_000;
			while (!(await predicate())) {
				if (Date.now() > deadline) throw new Error('job timeout');
				await Bun.sleep(100);
			}
		};
		try {
			DBOS.setConfig({
				name: 'agents-computer-test',
				applicationVersion: 'computer-jobs-v1',
				systemDatabaseUrl: url!,
				systemDatabaseSchemaName: schema,
				runAdminServer: false,
				logLevel: 'error',
			});
			await DBOS.launch();
			const job: ComputerUpdateJob = await jobs.request(owner, f.input, f.engine);
			await jobs.recover();
			await jobs.dispatch(job.id);
			await wait(async () => (await jobs.get(job.id, owner)).items[0].status === 'waiting');
			await DBOS.shutdown({ workflowCompletionTimeoutMS: 0 });
			expect((await f.agents.get(a.id))!.harness_image).toBe(oldImage);
			await db!.exec("update runs set status='done' where id=$1", [runId]);
			await DBOS.launch();
			await jobs.recover();
			await jobs.dispatch(job.id);
			await wait(async () => {
				const state = await jobs.get(job.id, owner);
				if (['failed', 'partial', 'cancelled'].includes(state.status)) throw new Error(JSON.stringify(state));
				return state.status === 'done';
			}).catch(async (e) => {
				console.error(
					'Recovered job:',
					await jobs.get(job.id, owner),
					'Workflow:',
					await DBOS.getWorkflowStatus(`computer-update:${job.id}`),
				);
				throw e;
			});
			expect(f.probes).toEqual([newImage]);
			expect((await f.agents.get(a.id))!.config_revision).toBe(a.config_revision + 1);
		} finally {
			await DBOS.shutdown({ workflowCompletionTimeoutMS: 0 });
			for (const spy of spies) spy.mockRestore();
			await db!.exec('delete from runs where id=$1', [runId]);
			await db!.exec(`drop schema if exists ${schema} cascade`);
		}
	},
	40_000,
);
