// Opt-in end-to-end check: isolated DB/API, fake GPT, real dev Docker + supervisor + Chrome.
// Run ONLY through `just dev design`. Does not change the shared dev model routing or use real keys.
import { createRequire } from 'node:module';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { defaultHarness, validateHarness, runtimeToolNames } from '../sandbox/harness';
import { FALLBACK_QUESTIONS } from '../server/src/interview';
import { newRunWorkflowId, admissionWorkflowId, isNewRunWorkflowId } from '../server/src/run-identity';
const malformedModelQuestions = ['Alcance', 'Fuentes'].map((title) => ({ ...FALLBACK_QUESTIONS[0], id: 'q_1', title }));
const harness = validateHarness({
	...defaultHarness(),
	tools: ['read', 'grep', 'find', 'ls', 'request_help'],
	restrictions: { workspaceFilesOnly: true, readOnlyFiles: true, guidelines: ['Cita tus fuentes.'] },
	skills: [{ name: 'research', description: 'Revisar evidencia.', instructions: 'Contrasta fuentes y cita enlaces.' }],
	plugins: [
		{ id: 'text-utils', version: '1.0.0' },
		{ id: 'json-utils', version: '1.0.0' },
	],
});
const workQuestions = [
	{
		id: 'sources',
		title: '¿Qué fuentes priorizo?',
		description: 'Decisión de prueba, sin datos reales.',
		selectionMode: 'single',
		options: [
			{ id: 'local', label: 'Distribuidores locales', description: 'Mayor cercanía' },
			{ id: 'all', label: 'Todas las fuentes', description: 'Mayor cobertura' },
		],
		recommended: 'local',
	},
];
const businessRequests: any[] = [];
function businessResponse(body: any) {
	// pi 1.4 may declare tools in Responses additional_tools items, not a top-level tools field.
	const tools = [
		...(body.tools ?? []),
		...(body.input ?? []).filter((i: any) => i.type === 'additional_tools').flatMap((i: any) => i.tools ?? []),
	];
	const main = tools.length > 0;
	if (main) {
		businessRequests.push(body);
		assert.deepEqual([...new Set(tools.map((t: any) => t.name))].sort(), runtimeToolNames(harness));
		assert(JSON.stringify(body.input).includes('Harness aprobado'));
	}
	const input = body.input ?? [],
		lastUser = input.findLastIndex((x: any) => x.role === 'user');
	const results = input.slice(lastUser + 1).filter((x: any) => x.type === 'function_call_output');
	const answered = input.some(
		(x: any) => x.role === 'user' && JSON.stringify(x.content).includes('Distribuidores locales'),
	);
	const steps = [
		{ name: 'read', args: { path: '/etc/passwd' } },
		{ name: 'write', args: { path: '/home/agent/work/out/should-not-exist.txt', content: 'denied' } },
		{ name: 'text_stats', args: { text: 'uno dos tres' } },
		{ name: 'find', args: { pattern: '*' } },
		{
			name: 'request_help',
			args: {
				reason: JSON.stringify({
					version: 1,
					reason: 'Elige las fuentes para continuar.',
					questions: workQuestions.map(({ description, ...q }) => q),
				}),
			},
		},
	];
	const id = `resp_harness_${businessRequests.length}`,
		step = main && !answered ? steps[results.length] : undefined,
		events: any[] = [
			{
				type: 'response.created',
				response: { id, object: 'response', status: 'in_progress', model: body.model, output: [] },
			},
		];
	let item: any;
	if (step) {
		const args = JSON.stringify(step.args);
		item = {
			type: 'function_call',
			id: `fc_${id}`,
			call_id: `call_${id}`,
			name: step.name,
			arguments: args,
			status: 'completed',
		};
		events.push(
			{ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
			{ type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: args },
			{ type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: args },
			{ type: 'response.output_item.done', output_index: 0, item },
		);
	} else {
		const text = 'Harness verificado: operaciones de archivos rechazadas y plugin ejecutado.';
		item = {
			type: 'message',
			id: `msg_${id}`,
			role: 'assistant',
			status: 'completed',
			content: [{ type: 'output_text', text, annotations: [] }],
		};
		events.push(
			{ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
			{ type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: text },
			{ type: 'response.output_item.done', output_index: 0, item },
		);
	}
	events.push({
		type: 'response.completed',
		response: {
			id,
			object: 'response',
			status: 'completed',
			model: body.model,
			output: [item],
			usage: {
				input_tokens: 100,
				output_tokens: 40,
				total_tokens: 140,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens_details: { reasoning_tokens: 0 },
			},
		},
	});
	return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
		headers: { 'content-type': 'text/event-stream' },
	});
}
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { Client } = require('pg');
const raw = process.env.AGENTS_TEST_DATABASE_URL;
if (!raw || !new URL(raw).pathname.endsWith('_test'))
	throw new Error('Requires the throwaway AGENTS_TEST_DATABASE_URL, never production.');
const suffix = randomBytes(5).toString('hex');
const database = `agents_design_${suffix}`,
	instance = `${process.env.AGENTS_TEST_INSTANCE_PREFIX ?? 'design-test'}-${suffix}`;
const url = new URL(raw);
url.pathname = `/${database}`;
const dir = mkdtempSync(join(tmpdir(), 'agents-design-'));
const admin = new Client({ connectionString: raw });
const freePort = () => {
	const s = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: () => new Response('reserved') });
	const p = s.port!;
	s.stop(true);
	return p;
};
const port = freePort(),
	metrics = freePort();
let requests = 0,
	ready = false,
	improved = false;
const fake = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	async fetch(req) {
		if (req.headers.get('authorization') !== 'Bearer fixture-key-not-a-secret')
			return new Response(null, { status: 401 });
		if (new URL(req.url).pathname === '/v1/models')
			return Response.json({ data: [{ id: 'gpt-6-sol' }, { id: 'gpt-6.1-sol' }] });
		if (new URL(req.url).pathname !== '/v1/responses') return new Response(null, { status: 404 });
		const body = (await req.json()) as any;
		if (body.stream) return businessResponse(body);
		assert.equal(body.tools.length, 0);
		requests++;
		return Response.json({
			status: 'completed',
			usage: { total_tokens: 250 },
			output: [
				{
					type: 'message',
					role: 'assistant',
					content: [
						{
							type: 'output_text',
							text: JSON.stringify({
								message: ready
									? 'Contrato listo; revisa y aprueba.'
									: '¿Quieres un informe con enlaces? Recomiendo que sí.',
								contract: {
									name: 'Prueba de contrato',
									prompt: `# Objetivo\nCompara fuentes con evidencia.${improved ? ' Prioriza fuentes oficiales y explica contradicciones.' : ''}\n\n## Entregable\nInforme markdown con enlaces.\n\n## Límites\nPide ayuda ante bloqueos.${ready ? '' : '\n\n## Pendiente\nConfirmar entregable.'}`,
								},
								harness,
								ready,
								questions: ready ? [] : malformedModelQuestions,
							}),
						},
					],
				},
			],
		});
	},
});
let child: ReturnType<typeof Bun.spawn> | undefined;
let cookie = '';
const api = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
	const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
		method,
		headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	if (path === '/join') cookie = res.headers.get('set-cookie')!.split(';')[0];
	const data = (await res.json()) as any;
	assert.equal(res.status, 200, `${path}: ${JSON.stringify(data)}`);
	return data;
};
const waitFor = async (fn: () => Promise<boolean>, label: string, ms = 90000) => {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (await fn()) return;
		await Bun.sleep(250);
	}
	throw new Error(`Timed out: ${label}`);
};
async function docker(path: string, method = 'GET', body?: unknown) {
	const res = await fetch(`http://docker/v1.45${path}`, {
		method,
		unix: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
		headers: body ? { 'content-type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	} as RequestInit);
	if (res.status === 204 || res.status === 404) return null;
	if (!res.ok) throw new Error(`Docker test ${res.status}`);
	const text = await res.text();
	return text ? JSON.parse(text) : null;
}
try {
	await admin.connect();
	await admin.query(`create database "${database}"`);
	const serverUrl = new URL(process.env.AGENTS_SANDBOX_SERVER_URL ?? 'http://agents-dev-server:8787');
	serverUrl.port = String(port);
	const masterKey = randomBytes(32).toString('base64');
	const launch = () => {
		const fd = openSync(join(dir, 'server.log'), 'a');
		const proc = Bun.spawn(['bun', '--watch', 'server/src/index.ts'], {
			cwd: new URL('..', import.meta.url).pathname,
			stdout: fd,
			stderr: fd,
			env: {
				...process.env,
				AGENTS_DATABASE_URL: url.href,
				AGENTS_DATA: dir,
				AGENTS_INSTANCE: instance,
				AGENTS_MASTER_KEY: masterKey,
				AGENTS_PROXY_KEY: 'fixture-internal-key-not-a-secret',
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
	child = launch();
	await waitFor(
		async () => {
			try {
				return (await fetch(`http://127.0.0.1:${port}/api/me`)).ok;
			} catch {
				return false;
			}
		},
		'isolated API startup',
		30000,
	);
	await api('/join', { name: 'Contract smoke fixture' });
	await api('/proxy', { url: fake.url.origin, key: 'fixture-key-not-a-secret' }, 'PUT');
	let { design } = await api('/designs', { model: 'openai/gpt-6-sol' });
	({ design } = await api(`/designs/${design.id}/messages`, { text: 'Comparar fuentes.', version: design.version }));
	assert.equal(design.ready, false);
	assert.equal(design.contract, null);
	assert.deepEqual(
		design.interview.pending.questions.map((q: any) => q.id),
		['question-1', 'question-2'],
	);
	assert.equal((await api('/agents')).agents.length, 0);
	const beforeAnswers = requests;
	for (const answers of [
		{ round: 0, values: {} },
		{ round: design.interview.pending.round, values: { scope: { selected: ['foreign'], other: '' } } },
	]) {
		const res = await fetch(`http://127.0.0.1:${port}/api/designs/${design.id}/messages`, {
			method: 'POST',
			headers: { cookie, 'content-type': 'application/json' },
			body: JSON.stringify({ version: design.version, answers }),
		});
		assert.equal(res.status, 400);
	}
	assert.equal(requests, beforeAnswers);
	const answerBody = (d: any) => ({
		version: d.version,
		answers: {
			round: d.interview.pending.round,
			values: Object.fromEntries(
				d.interview.pending.questions.map((q: any) => [q.id, { selected: [q.options.at(-1).id], other: '' }]),
			),
		},
	});
	assert.deepEqual((await api(`/designs/${design.id}`)).design.interview, design.interview);
	ready = true;
	({ design } = await api(`/designs/${design.id}/messages`, answerBody(design)));
	assert.equal(design.ready, true);
	assert.equal((await api('/agents')).agents.length, 0);
	console.log(
		'PASS real HTTP interview-first gate, malformed/repeated model IDs repaired and persisted, strict human answers spend no extra GPT call, no agent before approval (GPT fixture)',
	);
	await api('/admin/unlock', { pin: '1111' });
	await api('/admin/settings', { sandboxImage: `agents-sandbox:missing-${suffix}` }, 'PUT');
	({ design } = await api(`/designs/${design.id}/validate`, { version: design.version }));
	assert.equal(design.harness_validation.status, 'failed');
	const rejected = await fetch(`http://127.0.0.1:${port}/api/designs/${design.id}/approve`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ version: design.version }),
	});
	assert.equal(rejected.status, 400);
	assert.equal((await api('/agents')).agents.length, 0);
	console.log('PASS missing validation image fails closed before approval; no agent or sandbox memory created');
	await api('/admin/settings', { sandboxImage: process.env.AGENTS_SANDBOX_IMAGE ?? 'agents-sandbox:dev' }, 'PUT');
	const beforeValidation = requests;
	({ design } = await api(`/designs/${design.id}/validate`, { version: design.version }));
	assert.equal(design.harness_validation.status, 'passed', JSON.stringify(design.harness_validation));
	assert.equal(requests, beforeValidation);
	assert.deepEqual(design.harness_validation.tools, runtimeToolNames(harness));
	const pinnedImage = design.harness_validation.imageId;
	await api('/admin/settings', { sandboxImage: `agents-sandbox:missing-${suffix}` }, 'PUT');
	const body = { version: design.version };
	const approvals = await Promise.all([
		api(`/designs/${design.id}/approve`, body),
		api(`/designs/${design.id}/approve`, body),
	]);
	const agentId = approvals[0].design.applied_agent_id;
	assert.equal(approvals[1].design.applied_agent_id, agentId);
	assert.equal((await api('/agents')).agents.length, 1);
	console.log(
		'PASS real isolated pi attestation and concurrent approval; immutable tested image survives an admin tag change',
	);
	await api('/admin/settings', { sandboxImage: process.env.AGENTS_SANDBOX_IMAGE ?? 'agents-sandbox:dev' }, 'PUT');
	const history = new Client({ connectionString: url.href });
	await history.connect();
	try {
		// A public sequence may restart while the durable schema survives. Preserve that
		// completed history; a genuinely new run must not deduplicate against it.
		await history.query(`insert into dbos.workflow_status (workflow_uuid,status,name,application_version,queue_name,output)
   values ('admit-1','SUCCESS','admit','v2','person:999','null'),('run-1','SUCCESS','sandboxRun','v2','sandboxes','null')`);
	} finally {
		await history.end();
	}
	const before = requests;
	({ design } = await api(`/designs/${design.id}/initialize`, {}, 'POST'));
	const seen = new Set<string>();
	await waitFor(async () => {
		({ design } = await api(`/designs/${design.id}`));
		for (const s of design.initialization.steps) if (s.done) seen.add(s.id);
		if (design.initialization?.task?.status === 'error') throw new Error(design.initialization.error);
		return design.initialization?.task?.status === 'done';
	}, 'actual sandbox and Chrome initialization');
	assert.equal(requests, before);
	assert.equal(design.initialization.steps.filter((s: any) => s.done).length, 6);
	const runId = design.init_run_id;
	await api(`/designs/${design.id}/initialize`, {}, 'POST');
	assert.equal((await api(`/designs/${design.id}`)).design.init_run_id, runId);
	const initDetail = await api(`/tasks/${runId}`);
	assert.equal(initDetail.task.definition.image, pinnedImage);
	assert(
		initDetail.events.some(
			(e: any) => e.kind === 'harness' && e.data.digest === design.harness_validation.harnessDigest,
		),
	);
	const identityDb = new Client({ connectionString: url.href });
	await identityDb.connect();
	let gapId = 0,
		orphanId = 0;
	try {
		const first = (await identityDb.query('select workflow_id from runs where id=$1', [runId])).rows[0].workflow_id;
		assert(isNewRunWorkflowId(first));
		assert.notEqual(first, `run-${runId}`);
		await waitFor(
			async () =>
				(
					await identityDb.query('select status from dbos.workflow_status where workflow_uuid=$1', [
						admissionWorkflowId(first),
					])
				).rows[0]?.status === 'SUCCESS',
			'new admission completes',
		);
		assert.deepEqual(
			(
				await identityDb.query(
					"select workflow_uuid,status,queue_name from dbos.workflow_status where workflow_uuid in ('admit-1','run-1') order by workflow_uuid",
				)
			).rows,
			[
				{ workflow_uuid: 'admit-1', status: 'SUCCESS', queue_name: 'person:999' },
				{ workflow_uuid: 'run-1', status: 'SUCCESS', queue_name: 'sandboxes' },
			],
		);
		// Simulate a crash after committing a run but before enqueueing its admission.
		gapId = Number(
			(
				await identityDb.query(
					`insert into runs (agent_id,person_id,conversation_id,workflow_id,model,priority,status,state,kind,definition)
   select agent_id,person_id,conversation_id,$2,model,priority,'queued','queued','initialize',definition from runs where id=$1 returning id`,
					[runId, newRunWorkflowId()],
				)
			).rows[0].id,
		);
		// A stale fixture must not freeze dev's watch runtime when its attach timer expires.
		const orphanAgent = (
			await identityDb.query(
				`insert into agents(person_id,name,model,seed,state_ref,deleted_at)
   select person_id,'Orphan timer fixture',model,'fixture',$2,now() from agents where id=$1 returning id`,
				[agentId, `orphan-${suffix}`],
			)
		).rows[0].id;
		const orphanConv = (
			await identityDb.query(`insert into conversations(agent_id,pi_session_id) values($1,$2) returning id`, [
				orphanAgent,
				`orphan-${suffix}`,
			])
		).rows[0].id;
		orphanId = Number(
			(
				await identityDb.query(
					`insert into runs(agent_id,person_id,conversation_id,workflow_id,model,status,state)
   select id,person_id,$2,$3,model,'running','thinking' from agents where id=$1 returning id`,
					[orphanAgent, orphanConv, `missing-fixture-${suffix}`],
				)
			).rows[0].id,
		);
	} finally {
		await identityDb.end();
	}
	console.log(
		'PASS legacy completed workflow IDs preserved; new run with reused numeric ID starts with its own durable UUID',
	);
	({ design } = await api(`/designs/${design.id}/initialize`, {}, 'POST'));
	assert.equal(design.init_run_id, gapId);
	assert.equal(design.initialization.task.status, 'queued');
	child!.kill('SIGTERM');
	await child!.exited;
	child = launch();
	await waitFor(
		async () => {
			try {
				return (await fetch(`http://127.0.0.1:${port}/api/me`)).ok;
			} catch {
				return false;
			}
		},
		'restarted isolated API',
		30000,
	);
	await waitFor(async () => {
		({ design } = await api(`/designs/${design.id}`));
		if (design.initialization?.task?.status === 'error') throw new Error(design.initialization.error);
		return design.initialization?.task?.status === 'done';
	}, 'insert/enqueue crash gap recovery');
	assert.equal(design.init_run_id, gapId);
	assert.equal(design.initialization.steps.filter((s: any) => s.done).length, 6);
	assert.equal(requests, before);
	assert.equal((await api('/agents')).agents.length, 1);
	console.log(
		'PASS restart recovers the same committed-but-not-enqueued initialization, no extra agent, no GPT call, six real completed steps',
	);
	const orphanDb = new Client({ connectionString: url.href });
	await orphanDb.connect();
	try {
		await waitFor(
			async () => (await orphanDb.query('select status from runs where id=$1', [orphanId])).rows[0].status === 'error',
			'orphan timeout under bun --watch',
			105000,
		);
	} finally {
		await orphanDb.end();
	}
	assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`)).status, 200);
	console.log(
		'PASS orphan timer settles as error after 90s under bun --watch; subsequent real queued work must still execute',
	);
	console.log(
		'PASS actual workspace/pi harness/Chrome, pinned image, six completed steps, no GPT initialization turn, retry reuses completed run',
	);
	await api('/admin/lock', {}, 'POST');
	const snapshotResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/${runId}/snapshot`, { headers: { cookie } });
	assert.equal(snapshotResponse.status, 200);
	assert.equal(snapshotResponse.headers.get('cache-control'), 'private, no-store');
	const saved = ((await snapshotResponse.json()) as any).snapshot;
	assert(
		saved && saved.jpeg.length > 1000 && saved.captured_at > 0,
		'actual Chrome frame is persisted before the run finishes',
	);
	assert.equal(readFileSync(join(dir, 'snapshots', `${runId}.json`), 'utf8'), JSON.stringify(saved));
	assert.equal((await api(`/tasks/${runId}/snapshot`)).snapshot.jpeg, saved.jpeg);
	const ownerCookie = cookie;
	await api('/join', { name: 'Snapshot stranger fixture' });
	const forbidden = await fetch(`http://127.0.0.1:${port}/api/tasks/${runId}/snapshot`, { headers: { cookie } });
	assert.equal(forbidden.status, 404);
	assert(!(await forbidden.text()).includes(saved.jpeg));
	await api('/admin/unlock', { pin: '1111' });
	assert.equal((await api(`/tasks/${runId}/snapshot`)).snapshot.jpeg, saved.jpeg);
	const anonymous = await fetch(`http://127.0.0.1:${port}/api/tasks/${runId}/snapshot`);
	assert.equal(anonymous.status, 401);
	cookie = ownerCookie;
	console.log(
		'PASS actual Chrome snapshot on disk, owner/admin access, non-owner/anonymous denied, private no-store response',
	);
	let config = await api(`/agents/${agentId}/configuration`);
	assert(config.effectivePrompt.includes('Nunca pagas'));
	assert.deepEqual(config.tools.map((t: any) => t.id).sort(), runtimeToolNames(harness));
	const firstRevision = config.agent.config_revision;
	const memoryBefore = (await api(`/agents/${agentId}/conversations`)).conversations;
	const reset = await fetch(`http://127.0.0.1:${port}/api/agents/${agentId}/conversations`, {
		method: 'POST',
		headers: { cookie },
	});
	assert.equal(reset.status, 410);
	const hook = await api(`/agents/${agentId}/channels`);
	for (const flag of [true, 'true', null]) {
		const rawBody = JSON.stringify({ text: 'No reset fixture.', new_conversation: flag });
		const t = Math.floor(Date.now() / 1000);
		const signature = createHmac('sha256', hook.inSecret).update(`${t}.${rawBody}`).digest('hex');
		const rejected = await fetch(`http://127.0.0.1:${port}${new URL(hook.inUrl).pathname}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-agents-signature': `t=${t},v1=${signature}` },
			body: rawBody,
		});
		assert.equal(rejected.status, 400);
	}
	assert.deepEqual((await api(`/agents/${agentId}/conversations`)).conversations, memoryBefore);
	const inspection = new Client({ connectionString: url.href });
	try {
		await inspection.connect();
		assert.equal(
			Number(
				(
					await inspection.query('select count(*) as n from messages where agent_id = $1 and source = $2', [
						agentId,
						'hook',
					])
				).rows[0].n,
			),
			0,
		);
	} finally {
		await inspection.end();
	}
	console.log(
		'PASS conversation reset unavailable by API (410) and signed webhook (400), no stored message or changed memory',
	);
	let improvement = (await api('/designs', { model: 'openai/gpt-6-sol', agentId })).design;
	improved = true;
	improvement = (
		await api(`/designs/${improvement.id}/messages`, {
			text: 'Prioriza fuentes oficiales y explica contradicciones.',
			version: improvement.version,
		})
	).design;
	assert.equal(improvement.ready, false);
	assert(improvement.interview.pending);
	improvement = (await api(`/designs/${improvement.id}/messages`, answerBody(improvement))).design;
	improvement = (await api(`/designs/${improvement.id}/validate`, { version: improvement.version })).design;
	assert.equal(improvement.harness_validation.status, 'passed');
	await api(`/designs/${improvement.id}/approve`, { version: improvement.version });
	config = await api(`/agents/${agentId}/configuration`);
	assert(config.agent.role.includes('fuentes oficiales'));
	assert.equal(config.agent.config_revision, firstRevision + 1);
	assert.deepEqual((await api(`/agents/${agentId}/conversations`)).conversations, memoryBefore);
	assert.deepEqual(config.harness, harness);
	assert.equal(config.revisions.length, 2);
	console.log(
		'PASS real HTTP approved improvement, prompt inspection, effective tools, revision increment and unchanged conversation',
	);
	let restored = (await api('/designs', { agentId, model: 'openai/gpt-6-sol', revision: firstRevision })).design;
	assert.equal(restored.ready, true);
	assert.equal(restored.harness_validation, null);
	assert(!restored.contract.prompt.includes('fuentes oficiales'));
	restored = (await api(`/designs/${restored.id}/validate`, { version: restored.version })).design;
	assert.equal(restored.harness_validation.status, 'passed');
	await api(`/designs/${restored.id}/approve`, { version: restored.version });
	config = await api(`/agents/${agentId}/configuration`);
	assert.equal(config.agent.config_revision, 3);
	assert.equal(config.revisions.length, 3);
	assert.deepEqual((await api(`/agents/${agentId}/conversations`)).conversations, memoryBefore);
	console.log(
		'PASS restoring a past definition requires fresh attestation/approval and creates revision 3 without conversation reset',
	);
	const work = (await api(`/agents/${agentId}/tasks`, { prompt: 'Verifica restricciones y plugin del harness.' })).task;
	await waitFor(
		async () => {
			const t = (await api(`/tasks/${work.id}`)).task;
			if (t.status === 'error') throw new Error(t.end_reason);
			return t.status === 'blocked';
		},
		'actual pi request_help through existing reason interface',
		120000,
	);
	const asking = await api(`/tasks/${work.id}`),
		blocked = asking.events.findLast((e: any) => e.kind === 'blocked');
	assert.equal(blocked.data.reason, 'Elige las fuentes para continuar.');
	assert.deepEqual(
		blocked.data.questions,
		workQuestions.map((q) => ({ ...q, description: '' })),
	);
	assert.equal(blocked.data.structured, true);
	// A tab is a new pi context, not a reset. Bind its messages now, while the original run waits.
	const conversationKey = crypto.randomUUID();
	const newTabs = await Promise.all([
		api(`/agents/${agentId}/conversations`, { requestId: conversationKey }),
		api(`/agents/${agentId}/conversations`, { requestId: conversationKey }),
	]);
	const secondConversation = newTabs[0].conversation;
	assert.equal(secondConversation.id, newTabs[1].conversation.id);
	assert.notEqual(secondConversation.id, work.conversation_id);
	const bText = 'CONTEXTO-B-AISLADO: verifica el mismo harness sin heredar el chat principal.',
		bMessage = { text: bText, requestId: crypto.randomUUID() };
	const bSends = await Promise.all([
		api(`/agents/${agentId}/conversations/${secondConversation.id}/messages`, bMessage),
		api(`/agents/${agentId}/conversations/${secondConversation.id}/messages`, bMessage),
	]);
	assert.equal(bSends[0].message_id, bSends[1].message_id);
	await api(`/agents/${agentId}/conversations/${secondConversation.id}`, { archived: true }, 'PATCH');
	const queuedConversation = await api(`/agents/${agentId}/conversations/${secondConversation.id}`);
	assert.equal(queuedConversation.records.length, 0);
	assert.equal(queuedConversation.inputs.length, 1);
	assert.equal(queuedConversation.inputs[0].run_id, null);
	assert(queuedConversation.conversation.archived_at);
	assert.equal((await api(`/tasks/${work.id}`)).task.status, 'blocked');
	console.log(
		'PASS real HTTP idempotent new conversation and message while another conversation is blocked; tab close preserves pending message, no crossing or cancellation',
	);
	const answers = { round: blocked.id, values: { sources: { selected: ['local'], other: '' } } };
	const beforeInvalid = businessRequests.length;
	for (const body of [
		{ ...answers, round: 0 },
		{ ...answers, values: { sources: { selected: ['invented'], other: '' } } },
	]) {
		const r = await fetch(`http://127.0.0.1:${port}/api/tasks/${work.id}/help`, {
			method: 'POST',
			headers: { cookie, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		assert.equal(r.status, 400);
	}
	assert.equal(businessRequests.length, beforeInvalid);
	// Test-owned fixture files bypass the read-only agent deliberately; collection still runs
	// through the real supervisor. This is not evidence that a model wrote these reports.
	const c = await docker(`/containers/agents-${instance}-run-${work.id}/json`);
	assert.equal(c.Config.Labels['agents.instance'], instance);
	const fixtureFiles = {
		'report.md': '# Informe de prueba\n\n[Datos](datos.csv)\n\n<script>bad()</script>',
		'datos.csv': 'Fuente,Estado\nEjemplo,Por validar\n',
		'static.html': '<h1>HTML de prueba</h1><script>window.evil=1</script>',
		'binary.pdf': 'PDF fixture',
	};
	const cmd = `const fs=require('node:fs');for(const [n,t] of Object.entries(${JSON.stringify(fixtureFiles)}))fs.writeFileSync('/home/agent/work/out/'+n,t);`;
	const execution = await docker(`/containers/${c.Id}/exec`, 'POST', { Cmd: ['node', '-e', cmd], User: 'agent' });
	await docker(`/exec/${execution.Id}/start`, 'POST', { Detach: true, Tty: false });
	await waitFor(
		async () => {
			const e = await docker(`/exec/${execution.Id}/json`);
			if (e.Running) return false;
			assert.equal(e.ExitCode, 0);
			return true;
		},
		'test-owned output fixtures',
		10000,
	);
	const submissions = await Promise.all([
		api(`/tasks/${work.id}/help`, answers),
		api(`/tasks/${work.id}/help`, answers),
	]);
	assert.deepEqual(submissions.map((r) => r.duplicate).sort(), [false, true]);
	await waitFor(
		async () => {
			const t = (await api(`/tasks/${work.id}`)).task;
			if (t.status === 'error') throw new Error(t.end_reason);
			return t.status === 'done';
		},
		'same actual pi run resumes after explicit choice',
		120000,
	);
	const answeredDetail = await api(`/tasks/${work.id}`);
	assert.equal(answeredDetail.events.filter((e: any) => e.kind === 'help_answer').length, 1);
	assert.equal(
		answeredDetail.events.filter((e: any) => e.kind === 'steer' && e.data.helpRound === blocked.id).length,
		1,
	);
	assert(
		businessRequests.some((r) =>
			(r.input ?? []).some(
				(m: any) => m.role === 'user' && JSON.stringify(m.content).includes('Distribuidores locales'),
			),
		),
	);
	console.log(
		'PASS real pi request_help -> structured recommendations via legacy reason -> strict round-bound HTTP answer -> same run resumes; duplicate submission stores/delivers once (simulated GPT)',
	);
	const previewPath = `/tasks/${work.id}/files/report.md/preview`;
	const previewResponse = await fetch(`http://127.0.0.1:${port}/api${previewPath}`, { headers: { cookie } });
	assert.equal(previewResponse.status, 200);
	assert.equal(previewResponse.headers.get('cache-control'), 'private, no-store');
	const preview = (await previewResponse.json()) as any;
	assert.equal(preview.kind, 'markdown');
	assert.equal(preview.agentId, agentId);
	assert(preview.text.includes('# Informe de prueba'));
	assert.equal((await api(`/tasks/${work.id}/files/datos.csv/preview`)).kind, 'csv');
	assert.equal((await api(`/tasks/${work.id}/files/static.html/preview`)).kind, 'html');
	assert.equal((await api(`/tasks/${work.id}/files/binary.pdf/preview`)).kind, 'unsupported');
	const rawHtml = await fetch(`http://127.0.0.1:${port}/api/tasks/${work.id}/files/static.html`, {
		headers: { cookie },
	});
	assert.equal(rawHtml.headers.get('content-type'), 'application/octet-stream');
	assert(rawHtml.headers.get('content-disposition')?.startsWith('attachment;'));
	assert.equal(rawHtml.headers.get('x-content-type-options'), 'nosniff');
	const workOwner = cookie;
	await api('/join', { name: 'Work artifact stranger fixture' });
	const conversationPath = `/agents/${agentId}/conversations/${secondConversation.id}`;
	assert.equal((await fetch(`http://127.0.0.1:${port}/api${conversationPath}`, { headers: { cookie } })).status, 404);
	for (const path of [previewPath, `/tasks/${work.id}/files/report.md`])
		assert.equal((await fetch(`http://127.0.0.1:${port}/api${path}`, { headers: { cookie } })).status, 404);
	assert.equal(
		(
			await fetch(`http://127.0.0.1:${port}/api/tasks/${work.id}/help`, {
				method: 'POST',
				headers: { cookie, 'content-type': 'application/json' },
				body: JSON.stringify(answers),
			})
		).status,
		403,
	);
	await api('/admin/unlock', { pin: '1111' });
	assert.equal((await api(previewPath)).kind, 'markdown');
	assert.equal((await api(conversationPath)).conversation.id, secondConversation.id);
	for (const [path, method, body] of [
		[`/agents/${agentId}/conversations`, 'POST', { requestId: crypto.randomUUID() }],
		[conversationPath, 'PATCH', { archived: false }],
		[`${conversationPath}/messages`, 'POST', { text: 'No dirigir al dueño.', requestId: crypto.randomUUID() }],
	] as const) {
		assert.equal(
			(
				await fetch(`http://127.0.0.1:${port}/api${path}`, {
					method,
					headers: { cookie, 'content-type': 'application/json' },
					body: JSON.stringify(body),
				})
			).status,
			403,
		);
	}
	assert.equal((await fetch(`http://127.0.0.1:${port}/api${conversationPath}`)).status, 401);
	assert.equal(
		(
			await fetch(`http://127.0.0.1:${port}/api/tasks/${work.id}/help`, {
				method: 'POST',
				headers: { cookie, 'content-type': 'application/json' },
				body: JSON.stringify(answers),
			})
		).status,
		403,
	);
	for (const path of [previewPath, `/tasks/${work.id}/files/report.md`])
		assert.equal((await fetch(`http://127.0.0.1:${port}/api${path}`)).status, 401);
	cookie = workOwner;
	console.log(
		'PASS real supervisor collects test-owned file fixtures; authenticated Markdown/CSV/static HTML/unsupported previews, safe raw download headers, owner/admin reads, foreign/anonymous denial, admin cannot answer for owner',
	);
	const detail = await api(`/tasks/${work.id}`);
	assert.equal(detail.task.definition.revision, 3);
	assert.equal(detail.task.definition.harnessDigest, restored.harness_validation.harnessDigest);
	assert(
		detail.events.some(
			(e: any) => e.kind === 'tool_end' && e.data.name === 'read' && e.data.isError && e.data.output.includes('~/work'),
		),
	);
	assert(
		detail.events.some(
			(e: any) =>
				e.kind === 'tool_end' && e.data.name === 'text_stats' && !e.data.isError && e.data.output.includes('"words":3'),
		),
	);
	assert(!detail.artifacts.some((f: any) => f.name === 'should-not-exist.txt'));
	assert(
		detail.events.some((e: any) => e.kind === 'tool_end' && e.data.name === 'find' && !e.data.isError),
		JSON.stringify(detail.events.filter((e: any) => e.kind === 'tool_end').map((e: any) => e.data)),
	);
	assert(businessRequests.length >= 5);
	const liveMemory = (await api(`/agents/${agentId}/conversations`)).conversations;
	assert.equal(liveMemory[0].id, memoryBefore[0].id);
	console.log(
		'PASS real pi RPC with simulated GPT: outside-workspace read denied, unavailable write not performed, catalog plugin executed, exact run definition retained',
	);
	// The closed B tab still starts when A releases the shared computer; it must have no A transcript.
	let bRun: any, bBlocked: any;
	await waitFor(
		async () => {
			const page = await api(`/agents/${agentId}/conversations/${secondConversation.id}`),
				r = page.records.at(-1);
			if (!r) return false;
			if (r.task.status === 'error') throw new Error(r.task.end_reason);
			if (r.task.status !== 'blocked') return false;
			bRun = r.task;
			bBlocked = r.events.findLast((e: any) => e.kind === 'blocked');
			return !!bBlocked;
		},
		'closed-tab pending message starts in its distinct pi context',
		120000,
	);
	const bRequests = businessRequests.filter((r) => JSON.stringify(r.input).includes(bText));
	assert(bRequests.length >= 5);
	assert(bRequests.every((r) => !JSON.stringify(r.input).includes(work.prompt)));
	const continueText = 'CONTINUACION-A-PERSISTENTE: conserva el contexto de mi primer encargo.',
		continuation = { text: continueText, requestId: crypto.randomUUID() };
	const aSend = await api(`/agents/${agentId}/conversations/${work.conversation_id}/messages`, continuation);
	const pendingA = await api(`/agents/${agentId}/conversations/${work.conversation_id}`);
	assert(pendingA.records.some((r: any) => r.task.id === work.id));
	assert(pendingA.inputs.some((m: any) => m.id === aSend.message_id && m.run_id === null));
	child!.kill('SIGTERM');
	await child!.exited;
	child = launch();
	await waitFor(
		async () => {
			try {
				return (await fetch(`http://127.0.0.1:${port}/api/me`)).ok;
			} catch {
				return false;
			}
		},
		'restart with blocked B and pending A',
		30000,
	);
	await waitFor(
		async () => {
			const t = (await api(`/tasks/${bRun.id}`)).task;
			if (t.status === 'error') throw new Error(t.end_reason);
			return t.status === 'blocked';
		},
		'recover same blocked B after API/DBOS restart',
		30000,
	);
	const afterRestart = await api(`/agents/${agentId}/conversations/${work.conversation_id}`);
	assert(afterRestart.inputs.some((m: any) => m.id === aSend.message_id && m.run_id === null));
	await api(`/agents/${agentId}/conversations/${secondConversation.id}`, { archived: false }, 'PATCH');
	const freeReply = {
		text: 'Distribuidores locales. Continúa sólo en CONTEXTO-B-AISLADO.',
		requestId: crypto.randomUUID(),
		replyTo: { runId: bRun.id, round: bBlocked.id },
	};
	const plainReplies = await Promise.all([
		api(`/agents/${agentId}/conversations/${secondConversation.id}/messages`, freeReply),
		api(`/agents/${agentId}/conversations/${secondConversation.id}/messages`, freeReply),
	]);
	assert.equal(plainReplies[0].message_id, plainReplies[1].message_id);
	await waitFor(
		async () => {
			const t = (await api(`/tasks/${bRun.id}`)).task;
			if (t.status === 'error') throw new Error(t.end_reason);
			return t.status === 'done';
		},
		'same B pi run resumes with ordinary chat answer',
		120000,
	);
	let continued: any;
	await waitFor(
		async () => {
			const page = await api(`/agents/${agentId}/conversations/${work.conversation_id}`),
				record = page.records.at(-1);
			if (record.task.id === work.id) return false;
			if (record.task.status === 'error') throw new Error(record.task.end_reason);
			continued = record;
			return record.task.status === 'done';
		},
		'pending A starts using its original pi session',
		120000,
	);
	assert.notEqual(continued.task.id, work.id);
	assert.equal(continued.task.conversation_id, work.conversation_id);
	assert.equal(continued.events.filter((e: any) => e.kind === 'blocked').length, 0);
	const continuationRequests = businessRequests.filter((r) => JSON.stringify(r.input).includes(continueText));
	assert(continuationRequests.length);
	assert(
		continuationRequests.every(
			(r) =>
				JSON.stringify(r.input).includes(work.prompt) &&
				JSON.stringify(r.input).includes('Distribuidores locales') &&
				!JSON.stringify(r.input).includes(bText),
		),
	);
	const bFinal = await api(`/agents/${agentId}/conversations/${secondConversation.id}`);
	assert.equal(bFinal.records.at(-1).task.id, bRun.id);
	assert.equal(bFinal.records.at(-1).events.filter((e: any) => e.kind === 'help_reply').length, 1);
	const stale = await fetch(
		`http://127.0.0.1:${port}/api/agents/${agentId}/conversations/${secondConversation.id}/messages`,
		{
			method: 'POST',
			headers: { cookie, 'content-type': 'application/json' },
			body: JSON.stringify({ ...freeReply, requestId: crypto.randomUUID() }),
		},
	);
	assert.equal(stale.status, 400);
	const identity = new Client({ connectionString: url.href });
	await identity.connect();
	try {
		const sessions = (
			await identity.query('select id,pi_session_id,is_default from conversations where agent_id=$1 order by id', [
				agentId,
			])
		).rows;
		assert.equal(sessions.length, 2);
		assert.equal(new Set(sessions.map((s: any) => s.pi_session_id)).size, 2);
		assert.equal(sessions.filter((s: any) => s.is_default).length, 1);
		assert.equal(Number(sessions.find((s: any) => s.is_default).id), work.conversation_id);
	} finally {
		await identity.end();
	}
	const conversationsBeforeRetirement = (await api(`/agents/${agentId}/conversations`)).conversations;
	console.log(
		'PASS real DBOS/API restart preserves blocked B and pending A; ordinary chat answer resumes original run once; A continues across executions with original pi memory, B transcript isolated, stale reply cannot create work',
	);
	const scheduled = await api(`/agents/${agentId}/schedules`, {
		cron: '0 9 * * 1-5',
		message: 'Retirement schedule fixture.',
	});
	assert.equal(scheduled.schedules.length, 1);
	for (const body of [{}, { confirmName: config.agent.name.toLowerCase() }, { confirmName: config.agent.name + ' ' }]) {
		const rejected = await fetch(`http://127.0.0.1:${port}/api/agents/${agentId}`, {
			method: 'DELETE',
			headers: { cookie, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		assert.equal(rejected.status, 400);
		assert.equal((await api('/agents')).agents.length, 1);
		assert.equal((await api(`/agents/${agentId}/channels`)).schedules.length, 1);
	}
	await api(`/agents/${agentId}`, { confirmName: config.agent.name }, 'DELETE');
	assert.equal((await api('/agents')).agents.length, 0);
	const retired = new Client({ connectionString: url.href });
	try {
		await retired.connect();
		assert((await retired.query('select deleted_at from agents where id = $1', [agentId])).rows[0].deleted_at);
		assert.equal(
			Number((await retired.query('select count(*) as n from conversations where agent_id = $1', [agentId])).rows[0].n),
			conversationsBeforeRetirement.length,
		);
		assert.equal(Number((await retired.query('select count(*) as n from dbos.workflow_schedules')).rows[0].n), 0);
	} finally {
		await retired.end();
	}
	console.log(
		'PASS typed-name retirement enforced by real API, no mutation on bad/missing confirmation, schedules deleted and conversation rows preserved',
	);
	console.log('DESIGN_E2E_OK — isolated database/API, real Docker and Chrome, simulated GPT, zero production access');
} catch (err) {
	if (child) console.error(readFileSync(join(dir, 'server.log'), 'utf8').slice(-7000));
	throw err;
} finally {
	if (child) {
		child.kill('SIGTERM');
		await child.exited;
	}
	fake.stop(true);
	const filter = encodeURIComponent(JSON.stringify({ label: [`agents.instance=${instance}`] }));
	try {
		for (const c of (await docker(`/containers/json?all=true&filters=${filter}`)) ?? [])
			if (c.Labels?.['agents.instance'] === instance) await docker(`/containers/${c.Id}?force=true&v=true`, 'DELETE');
		for (const v of (await docker(`/volumes?filters=${filter}`))?.Volumes ?? [])
			if (v.Labels?.['agents.instance'] === instance)
				await docker(`/volumes/${encodeURIComponent(v.Name)}?force=true`, 'DELETE');
	} finally {
		await admin.query(`drop database if exists "${database}" with (force)`);
		await admin.end();
		rmSync(dir, { recursive: true, force: true });
	}
	console.log('CLEANED isolated API, test database, labeled containers and test volumes');
}
