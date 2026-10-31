// Isolated API/Postgres + real sandbox/Chrome, scripted GPT and synthetic users only.
// Run through `just dev sharing`; never changes the shared dev routing or uses personal keys.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { defaultHarness, validateHarness } from '../sandbox/harness';
const require = createRequire(new URL('../server/package.json', import.meta.url)),
	{ Client } = require('pg');
const raw = process.env.AGENTS_TEST_DATABASE_URL;
if (!raw || !new URL(raw).pathname.endsWith('_test')) throw new Error('Requires a throwaway AGENTS_TEST_DATABASE_URL.');
const suffix = randomBytes(5).toString('hex'),
	database = `agents_sharing_${suffix}`,
	instance = `${process.env.AGENTS_TEST_INSTANCE_PREFIX ?? 'sharing-test'}-${suffix}`;
const url = new URL(raw);
url.pathname = `/${database}`;
const dir = mkdtempSync(join(tmpdir(), 'agents-sharing-'));
const admin = new Client({ connectionString: raw }),
	db = new Client({ connectionString: url.href });
const freePort = () => {
	const s = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: () => new Response('reserved') });
	const p = s.port!;
	s.stop(true);
	return p;
};
const port = freePort(),
	metrics = freePort();
const fake = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	async fetch(req) {
		if (req.headers.get('authorization') !== 'Bearer fixture-key') return new Response(null, { status: 401 });
		if (new URL(req.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'gpt-6-sol' }] });
		if (new URL(req.url).pathname !== '/v1/responses') return new Response(null, { status: 404 });
		const body = (await req.json()) as any;
		const lastUser = JSON.stringify((body.input ?? []).findLast((m: any) => m.role === 'user') ?? {});
		const asks = /TAREA_[AB]/.test(lastUser) && !lastUser.includes('RESPUESTA_PERMITIDA');
		const id = `fixture_${randomBytes(6).toString('hex')}`;
		const item = asks
			? {
					type: 'function_call',
					id: `fc_${id}`,
					call_id: `call_${id}`,
					name: 'request_help',
					arguments: JSON.stringify({ reason: 'Confirma para terminar esta tarea de prueba.' }),
					status: 'completed',
				}
			: {
					type: 'message',
					id: `msg_${id}`,
					role: 'assistant',
					status: 'completed',
					content: [{ type: 'output_text', text: 'Tarea terminada.', annotations: [] }],
				};
		const events: any[] = [
			{
				type: 'response.created',
				response: { id, object: 'response', status: 'in_progress', model: body.model, output: [] },
			},
		];
		if (asks)
			events.push(
				{
					type: 'response.output_item.added',
					output_index: 0,
					item: { ...item, arguments: '', status: 'in_progress' },
				},
				{ type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments },
				{ type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments },
			);
		else
			events.push(
				{ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
				{
					type: 'response.output_text.delta',
					output_index: 0,
					item_id: item.id,
					content_index: 0,
					delta: 'Tarea terminada.',
				},
			);
		events.push(
			{ type: 'response.output_item.done', output_index: 0, item },
			{
				type: 'response.completed',
				response: {
					id,
					object: 'response',
					status: 'completed',
					model: body.model,
					output: [item],
					usage: {
						input_tokens: 100,
						output_tokens: 20,
						total_tokens: 120,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens_details: { reasoning_tokens: 0 },
					},
				},
			},
		);
		return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
			headers: { 'content-type': 'text/event-stream' },
		});
	},
});
let child: ReturnType<typeof Bun.spawn> | undefined;
const masterKey = randomBytes(32).toString('base64');
const launch = () => {
	const fd = openSync(join(dir, 'server.log'), 'a');
	const serverUrl = new URL(process.env.AGENTS_SANDBOX_SERVER_URL ?? 'http://agents-dev-server:8787');
	serverUrl.port = String(port);
	const proc = Bun.spawn(['bun', 'server/src/index.ts'], {
		cwd: new URL('..', import.meta.url).pathname,
		stdout: fd,
		stderr: fd,
		env: {
			...process.env,
			AGENTS_DATABASE_URL: url.href,
			AGENTS_DATA: dir,
			AGENTS_INSTANCE: instance,
			AGENTS_MASTER_KEY: masterKey,
			AGENTS_PROXY_KEY: 'fixture-internal-key',
			AGENTS_ADMIN_PIN: '1111',
			AGENTS_COOKIE_SECURE: '0',
			AGENTS_CLIPROXY_CONFIG: join(dir, 'proxy.yaml'),
			AGENTS_CLIPROXY_URL: fake.url.origin,
			AGENTS_SANDBOX_SERVER_URL: serverUrl.href.replace(/\/$/, ''),
			PORT: String(port),
			AGENTS_METRICS_PORT: String(metrics),
		},
	});
	closeSync(fd);
	return proc;
};
const waitFor = async (fn: () => Promise<boolean>, label: string, ms = 90000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return;
		await Bun.sleep(250);
	}
	throw new Error(`Timed out: ${label}`);
};
const ready = () =>
	waitFor(
		async () => {
			try {
				return (await fetch(`http://127.0.0.1:${port}/api/me`)).ok;
			} catch {
				return false;
			}
		},
		'API startup',
		30000,
	);
const request = async (cookie: string, path: string, body?: unknown, method = body ? 'POST' : 'GET', status = 200) => {
	const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
		method,
		headers: { cookie, 'content-type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = (await res.json()) as any;
	assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
	return data;
};
const login = async (name: string) => {
	const res = await fetch(`http://127.0.0.1:${port}/api/join`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name }),
	});
	assert.equal(res.status, 200);
	return { cookie: res.headers.get('set-cookie')!.split(';')[0], ...((await res.json()) as any).me };
};
const docker = async (path: string, method = 'GET') => {
	const res = await fetch(`http://docker/v1.45${path}`, {
		method,
		unix: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
	} as RequestInit);
	if ([204, 404].includes(res.status)) return null;
	if (!res.ok) throw new Error(`Docker ${method} ${path}: ${res.status}`);
	return res.json() as Promise<any>;
};
try {
	await admin.connect();
	await admin.query(`create database "${database}"`);
	child = launch();
	await ready();
	await db.connect();
	const owner = await login('Dueño fixture'),
		ana = await login('Ana fixture'),
		beto = await login('Beto fixture'),
		carla = await login('Carla fixture');
	await request(owner.cookie, '/proxy', { url: fake.url.origin, key: 'fixture-key' }, 'PUT');
	// A ready agent fixture bypasses the designer, not the actual task/router/sandbox path.
	const harness = validateHarness({ ...defaultHarness(), tools: ['request_help'] });
	const agent = Number(
		(
			await db.query(
				`insert into agents(person_id,name,role,model,seed,state_ref,harness,harness_image) values($1,'Compartido fixture','Resuelve una tarea por persona.','openai/gpt-6-sol','fixture','',$2,$3) returning id`,
				[owner.id, JSON.stringify(harness), process.env.AGENTS_SANDBOX_IMAGE ?? 'agents-sandbox:dev'],
			)
		).rows[0].id,
	);
	await db.query('update agents set state_ref=$2 where id=$1', [agent, `agents-${instance}-agent-${agent}`]);
	await request(owner.cookie, `/agents/${agent}/shares`, { people: [ana.id, beto.id, carla.id] }, 'PUT');
	const conv = (await request(owner.cookie, `/agents/${agent}/conversations`, { requestId: crypto.randomUUID() }))
		.conversation.id;
	const messages = `/agents/${agent}/conversations/${conv}/messages`;
	const send = (cookie: string, text: string) => request(cookie, messages, { text, requestId: crypto.randomUUID() });
	const state = async (id: number) =>
		(await db.query('select run_id::int,routed_as from messages where id=$1', [id])).rows[0];
	const a = await send(ana.cookie, 'TAREA_A: primera tarea, de Ana.');
	let aRun: any,
		aRound: number = 0;
	await waitFor(async () => {
		const s = await state(a.message_id);
		if (!s.run_id) return false;
		const d = await request(ana.cookie, `/tasks/${s.run_id}`);
		if (d.task.status === 'error') throw new Error(d.task.end_reason);
		aRun = d.task;
		aRound = d.events.findLast((e: any) => e.kind === 'blocked')?.id;
		return d.task.status === 'blocked' && !!aRound;
	}, 'Ana blocks in actual pi');
	assert.equal(aRun.requested_by, ana.id);
	assert.equal(aRun.requested_by_name, ana.name);
	assert.equal(aRun.person_id, owner.id);
	const b = await send(beto.cookie, 'TAREA_B: segunda tarea, de Beto.'),
		c = await send(carla.cookie, 'TAREA_C: tercera tarea, de Carla.');
	await Bun.sleep(750);
	for (const m of [b, c]) assert.deepEqual(await state(m.message_id), { run_id: null, routed_as: null });
	for (const path of [
		`/tasks/${aRun.id}/steer`,
		`/tasks/${aRun.id}/help`,
		`/tasks/${aRun.id}/cancel`,
		`/tasks/${aRun.id}/control`,
	])
		await request(beto.cookie, path, { text: 'No autorizado', round: aRound, on: true }, 'POST', 403);
	await request(
		beto.cookie,
		messages,
		{ text: 'No responder por Ana', requestId: crypto.randomUUID(), replyTo: { runId: aRun.id, round: aRound } },
		'POST',
		400,
	);
	const follow = await send(ana.cookie, 'Seguimiento para Ana');
	await waitFor(async () => (await state(follow.message_id)).routed_as === 'queued', 'Ana follow-up queued');
	await request(beto.cookie, `${messages}/${follow.message_id}/send`, {}, 'POST', 400);
	await request(beto.cookie, `${messages}/${follow.message_id}`, undefined, 'DELETE', 400);
	await request(ana.cookie, `${messages}/${follow.message_id}`, undefined, 'DELETE');
	console.log(
		'PASS actual shared task: requester metadata, other users wait, cannot steer/answer/cancel/take over or edit someone else’s queue',
	);
	child.kill('SIGTERM');
	await child.exited;
	child = launch();
	await ready();
	await waitFor(
		async () => (await request(ana.cookie, `/tasks/${aRun.id}`)).task.status === 'blocked',
		'blocked task reconnects',
	);
	for (const m of [b, c]) assert.deepEqual(await state(m.message_id), { run_id: null, routed_as: null });
	await request(ana.cookie, messages, {
		text: 'RESPUESTA_PERMITIDA: termina Ana.',
		requestId: crypto.randomUUID(),
		replyTo: { runId: aRun.id, round: aRound },
	});
	let bRun: any,
		bRound: number = 0;
	await waitFor(async () => {
		const s = await state(b.message_id);
		if (!s.run_id) return false;
		const d = await request(beto.cookie, `/tasks/${s.run_id}`);
		if (d.task.status === 'error') throw new Error(d.task.end_reason);
		bRun = d.task;
		bRound = d.events.findLast((e: any) => e.kind === 'blocked')?.id;
		return d.task.status === 'blocked' && !!bRound;
	}, 'Beto starts after Ana finishes');
	assert.equal((await request(ana.cookie, `/tasks/${aRun.id}`)).task.status, 'done');
	assert.notEqual(bRun.id, aRun.id);
	assert.equal(bRun.requested_by, beto.id);
	assert.deepEqual(await state(c.message_id), { run_id: null, routed_as: null });
	await request(carla.cookie, `/tasks/${bRun.id}/cancel`, {}, 'POST', 403);
	// The owner retains the explicit ability to intervene in a shared task.
	await request(owner.cookie, messages, {
		text: 'RESPUESTA_PERMITIDA: el dueño termina Beto.',
		requestId: crypto.randomUUID(),
		replyTo: { runId: bRun.id, round: bRound },
	});
	let cRun: any;
	await waitFor(async () => {
		const s = await state(c.message_id);
		if (!s.run_id) return false;
		cRun = (await request(carla.cookie, `/tasks/${s.run_id}`)).task;
		if (cRun.status === 'error') throw new Error(cRun.end_reason);
		return cRun.status === 'done';
	}, 'Carla finishes third');
	assert.equal((await request(beto.cookie, `/tasks/${bRun.id}`)).task.status, 'done');
	assert.equal(cRun.requested_by, carla.id);
	assert(aRun.id < bRun.id && bRun.id < cRun.id);
	const runs = (await db.query('select id::int,person_id::int,status from runs where agent_id=$1 order by id', [agent]))
		.rows;
	assert.deepEqual(
		runs,
		[aRun, bRun, cRun].map((t) => ({ id: t.id, person_id: owner.id, status: 'done' })),
	);
	console.log(
		'PASS restart preserves pending users; real pi/DBOS completes Ana → Beto → Carla, separate runs in arrival order, owner intervention retained, owner quota/account unchanged',
	);
} catch (err) {
	console.error(readFileSync(join(dir, 'server.log'), 'utf8').slice(-10000));
	throw err;
} finally {
	child?.kill('SIGTERM');
	if (child) await child.exited;
	fake.stop(true);
	await db.end().catch(() => {});
	const filters = encodeURIComponent(JSON.stringify({ label: [`agents.instance=${instance}`] }));
	for (const c of (await docker(`/containers/json?all=1&filters=${filters}`)) ?? [])
		await docker(`/containers/${c.Id}?force=1`, 'DELETE');
	const volumes = await docker(`/volumes?filters=${filters}`);
	for (const v of volumes?.Volumes ?? []) await docker(`/volumes/${encodeURIComponent(v.Name)}?force=1`, 'DELETE');
	await admin
		.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1', [database])
		.catch(() => {});
	await admin.query(`drop database if exists "${database}"`).catch(() => {});
	await admin.end();
	rmSync(dir, { recursive: true, force: true });
}
