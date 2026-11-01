import { afterAll, beforeAll, expect, test } from 'bun:test';

// Against a throwaway database (AGENTS_TEST_DATABASE_URL, never the dev one): `just dev test`
// runs this inside the dev server container. No real provider or Docker calls.
const url = process.env.AGENTS_TEST_DATABASE_URL;
const run = url ? test : test.skip;
if (!url) console.warn('AGENTS_TEST_DATABASE_URL is not set: skipping (run `just dev test`).');
// The runner must set AGENTS_DATABASE_URL BEFORE Bun loads ANY test module.
process.env.AGENTS_DATA = '/tmp';
// A fake WhatsApp bridge, set before any module reads its address.
const waSent: { phone: string; text: string; files: unknown[] }[] = [];
const waBridge = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	async fetch(req) {
		if (req.headers.get('x-agents-secret') !== 'wa-test') return new Response(null, { status: 403 });
		if (new URL(req.url).pathname === '/send') {
			waSent.push(await req.json());
			return Response.json({ ok: true });
		}
		return Response.json({ state: 'connected', phone: '5215500000000' });
	},
});
process.env.AGENTS_WHATSAPP_URL = waBridge.url.origin;
process.env.AGENTS_WHATSAPP_SECRET = 'wa-test';
process.env.AGENTS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const { migrate, exec, row, DATABASE_URL } = await import('./db');
const { assertTestDatabase } = await import('./test-database');
const { setProxy, checkProxyModel } = await import('./providers');
const { enqueue } = await import('./tasks');
const { settings } = await import('./settings');

let status = 200;
let calls = 0;
let replyStatus = 200;
let waitReply: Promise<void> | null = null;
const modelRequests: any[] = [];
const designerReply = {
	message: 'Contrato listo para tu revisión.',
	contract: {
		name: 'Diseñado',
		prompt: '# Objetivo\nCompara fuentes y entrega evidencia.\n\n## Límites\nPide ayuda si falta información.',
	},
	ready: true,
	questions: [] as import('./interview').Question[],
	harness: null as import('../../sandbox/harness').Harness | null,
};
const proxy = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	async fetch(req) {
		calls++;
		if (req.headers.get('authorization') !== 'Bearer test-proxy-secret') return new Response(null, { status: 401 });
		if (new URL(req.url).pathname === '/v1/responses') {
			modelRequests.push(await req.json());
			if (waitReply) await waitReply;
			return Response.json(
				{
					status: 'completed',
					usage: { total_tokens: 123 },
					output: [
						{
							type: 'message',
							role: 'assistant',
							content: [{ type: 'output_text', text: JSON.stringify(designerReply) }],
						},
					],
				},
				{ status: replyStatus },
			);
		}
		if (new URL(req.url).pathname !== '/v1/models') return new Response(null, { status: 404 });
		return Response.json({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-sol' }] }, { status });
	},
});
let person = 0;
beforeAll(async () => {
	if (!url) return;
	assertTestDatabase(url, DATABASE_URL);
	const actual = (await row<{ name: string }>('select current_database() as name'))!;
	assertTestDatabase(url, DATABASE_URL, actual.name);
	await migrate();
	await exec('truncate people restart identity cascade');
	person = (await row<{ id: number }>(
		"insert into people (name, key, avatar_seed) values ('Test', 'test', 'seed') returning id",
	))!.id;
	await setProxy(person, proxy.url.origin, 'test-proxy-secret');
});
afterAll(async () => {
	proxy.stop(true);
	waBridge.stop(true);
	// The pool stays open: other test files share this process and its pool (bun runs them in one).
});

test('default catalog offers the two verified Sol model IDs', () => {
	expect(
		settings()
			.models.filter((m) => m.id.startsWith('openai/'))
			.map((m) => m.id),
	).toEqual(['openai/gpt-6.1-sol', 'openai/gpt-6-sol']);
});

run('accepts both models advertised by the proxy', async () => {
	await checkProxyModel(person, 'openai/gpt-6.1-sol');
	await checkProxyModel(person, 'openai/gpt-6-sol');
});

run('unavailable model fails before inserting a run or contacting Docker', async () => {
	await expect(
		enqueue({ id: 99, person_id: person, model: 'openai/gpt-5.4' }, 'test', { admin: false }),
	).rejects.toThrow(
		'Tu CLIProxyAPI no ofrece gpt-5.4. Cambia el modelo del agente. Disponibles: gpt-6.1-sol, gpt-6-sol.',
	);
	expect(await row('select count(*) as n from runs')).toEqual({ n: 0 });
});

run('rejects proxy authentication failure instead of creating a run', async () => {
	status = 401;
	try {
		await expect(checkProxyModel(person, 'openai/gpt-6.1-sol')).rejects.toThrow('El proxy rechazó la API key.');
	} finally {
		status = 200;
	}
});

run('direct-key accounts do not require a personal proxy', async () => {
	const before = calls;
	await checkProxyModel(person + 1, 'openai/gpt-6.1-sol');
	expect(calls).toBe(before);
});

run('one live run per agent, enforced by the database', async () => {
	const a = (await row<{ id: number }>(
		`insert into agents (person_id, name, model, seed, state_ref) values ($1, 'A', 'openai/gpt-6-sol', 's', 'v') returning id`,
		[person],
	))!.id;
	const conv = (await row<{ id: number }>(
		"insert into conversations (agent_id, pi_session_id) values ($1, 'p') returning id",
		[a],
	))!.id;
	const insert = (wf: string, status: string) =>
		exec(
			`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status) values ($1, $2, $3, $4, 'm', $5)`,
			[a, person, conv, wf, status],
		);
	await insert('t-1', 'done');
	await insert('t-2', 'running');
	await expect(insert('t-3', 'queued')).rejects.toThrow('runs_one_live_per_agent');
});

run('GPT only: the database takes no other provider key', async () => {
	await expect(
		exec("insert into provider_keys (person_id, provider, key_enc, last4) values ($1, 'anthropic', 'x', 'xxxx')", [
			person,
		]),
	).rejects.toThrow('provider_keys_provider_check');
});

run('an agent keeps its conversation; inbound reset requests store nothing and cannot rotate it', async () => {
	const { create, conversations } = await import('./agents');
	const { receive } = await import('./inbox');
	const a = await create(person, { name: 'Memoria', model: 'openai/gpt-6-sol' });
	const first = await conversations(a.id);
	expect(first.length).toBe(1);
	expect(first[0].archived_at).toBeNull();
	await expect(
		receive({ agentId: a.id, source: 'hook', text: 'Reinicia.', newConversation: true }, { routeNow: false }),
	).rejects.toThrow('No se puede reiniciar');
	expect(await conversations(a.id)).toEqual(first);
	expect(Number((await row('select count(*) as n from messages where agent_id = $1', [a.id]))!.n)).toBe(0);
});

run(
	'ordinary inbound messages and legacy pending resets join the same queued run without changing conversation',
	async () => {
		const { create, conversations } = await import('./agents');
		const { receive, route } = await import('./inbox');
		const a = await create(person, { name: 'Buzón persistente', model: 'openai/gpt-6-sol' });
		const first = await conversations(a.id);
		const queued = (await row<{ id: number }>(
			`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status)
  values ($1, $2, $3, $4, $5, 'queued') returning id`,
			[a.id, person, first[0].id, `memory-test-${a.id}`, a.model],
		))!;
		const ordinary = await receive(
			{
				agentId: a.id,
				source: 'hook',
				text: 'Continúa el informe.',
				newConversation: false,
				context: { bridge: 'fixture' },
				dedupeKey: 'ordinary',
			},
			{ routeNow: false },
		);
		const legacy = await receive(
			{ agentId: a.id, source: 'cron', text: 'Mensaje antiguo pendiente.' },
			{ routeNow: false },
		);
		await exec('update messages set new_conversation = true where id = $1', [legacy.message_id]);
		await route(a.id);
		for (const message of [ordinary, legacy]) {
			const stored = (await row('select run_id, routed_as, routed_at from messages where id = $1', [
				message.message_id,
			]))!;
			expect(stored.run_id).toBe(queued.id);
			expect(stored.routed_as).toBe('queued_with');
			expect(stored.routed_at).not.toBeNull();
		}
		expect((await row('select context from messages where id = $1', [ordinary.message_id]))!.context).toEqual({
			bridge: 'fixture',
		});
		const duplicate = await receive(
			{ agentId: a.id, source: 'hook', text: 'Continúa el informe.', dedupeKey: 'ordinary' },
			{ routeNow: false },
		);
		expect(duplicate.duplicate).toBe(true);
		expect(duplicate.message_id).toBe(ordinary.message_id);
		expect(await conversations(a.id)).toEqual([{ ...first[0], runs: 1 }]);
	},
);

run('explicit tabs are idempotent pi contexts; channels keep their default and messages never cross tabs', async () => {
	const agents = await import('./agents'),
		conversations = await import('./conversations'),
		inbox = await import('./inbox');
	const a = await agents.create(person, { name: 'Conversaciones aisladas', model: 'openai/gpt-6-sol' }),
		main = (await agents.conversations(a.id))[0];
	const key = crypto.randomUUID(),
		[tab, retry] = await Promise.all([conversations.create(a.id, key), conversations.create(a.id, key)]);
	expect(tab.id).toBe(retry.id);
	expect(tab.id).not.toBe(main.id);
	expect((await agents.conversations(a.id)).length).toBe(2);
	const sessions = await import('./db').then((d) =>
		d.rows<{ pi_session_id: string }>('select pi_session_id from conversations where agent_id=$1', [a.id]),
	);
	expect(new Set(sessions.map((c) => c.pi_session_id)).size).toBe(2);
	const first = (await row<{ id: number }>(
		`insert into runs(agent_id,person_id,conversation_id,workflow_id,model,status) values($1,$2,$3,$4,$5,'queued') returning id`,
		[a.id, person, main.id, `tabs-main-${a.id}`, a.model],
	))!;
	const pending = await inbox.receive(
		{
			agentId: a.id,
			source: 'web',
			personId: person,
			conversationId: tab.id,
			text: 'Sólo la otra conversación.',
			dedupeKey: 'tab-one',
		},
		{ routeNow: false },
	);
	const same = await inbox.receive(
		{
			agentId: a.id,
			source: 'web',
			personId: person,
			conversationId: tab.id,
			text: 'Sólo la otra conversación.',
			dedupeKey: 'tab-one',
		},
		{ routeNow: false },
	);
	expect(same.duplicate).toBe(true);
	expect(same.message_id).toBe(pending.message_id);
	await expect(
		inbox.receive(
			{
				agentId: a.id,
				source: 'web',
				personId: person,
				conversationId: main.id,
				text: 'Otro destino.',
				dedupeKey: 'tab-one',
			},
			{ routeNow: false },
		),
	).rejects.toThrow('otro mensaje');
	await conversations.archive(a.id, main.id, true);
	const hook = await inbox.receive(
		{ agentId: a.id, source: 'hook', text: 'Canal principal independiente.' },
		{ routeNow: false },
	);
	await inbox.route(a.id);
	expect(await row('select conversation_id,run_id,routed_at from messages where id=$1', [pending.message_id])).toEqual({
		conversation_id: tab.id,
		run_id: null,
		routed_at: null,
	});
	expect(await row('select conversation_id,run_id,routed_as from messages where id=$1', [hook.message_id])).toEqual({
		conversation_id: main.id,
		run_id: first.id,
		routed_as: 'queued_with',
	});
	await conversations.archive(a.id, tab.id, true);
	await expect(
		inbox.receive(
			{ agentId: a.id, source: 'web', personId: person, conversationId: tab.id, text: 'No reabrir implícitamente.' },
			{ routeNow: false },
		),
	).rejects.toThrow('Reabre');
	await exec("update runs set status='done' where id=$1", [first.id]);
	const second = (await row<{ id: number }>(
		`insert into runs(agent_id,person_id,conversation_id,workflow_id,model,status) values($1,$2,$3,$4,$5,'queued') returning id`,
		[a.id, person, tab.id, `tabs-next-${a.id}`, a.model],
	))!;
	await inbox.route(a.id);
	expect((await row('select run_id from messages where id=$1', [pending.message_id]))!.run_id).toBe(second.id);
	expect((await conversations.get(a.id, tab.id))!.archived_at).not.toBeNull();
	await conversations.archive(a.id, tab.id, false);
	expect((await conversations.get(a.id, tab.id))!.archived_at).toBeNull();
	const foreign = await agents.create(person, { name: 'Destino ajeno', model: a.model });
	await expect(
		inbox.receive(
			{ agentId: foreign.id, source: 'web', personId: person, conversationId: tab.id, text: 'Cruce prohibido.' },
			{ routeNow: false },
		),
	).rejects.toThrow();
	expect(await conversations.get(foreign.id, tab.id)).toBeNull();
	await expect(
		exec("insert into messages(agent_id,conversation_id,source,text) values($1,$2,'web','cruce SQL prohibido')", [
			foreign.id,
			tab.id,
		]),
	).rejects.toThrow('messages_conversation_owner');
	await expect(
		exec(
			"insert into runs(agent_id,person_id,conversation_id,workflow_id,model,status) values($1,$2,$3,$4,$5,'done')",
			[foreign.id, person, tab.id, `cross-${foreign.id}`, a.model],
		),
	).rejects.toThrow('runs_conversation_owner');
	const transcript = await conversations.transcript(a.id, tab.id);
	expect(transcript.records.map((r) => r.task.id)).toEqual([second.id]);
	expect(transcript.inputs.map((m) => m.text)).toEqual(['Sólo la otra conversación.']);
	await exec("update runs set status='done' where id=$1", [second.id]);
});

run(
	'chat attachments are stored with their message, listed in the transcript and readable only through their agent',
	async () => {
		const agents = await import('./agents'),
			conversations = await import('./conversations'),
			inbox = await import('./inbox');
		const a = await agents.create(person, { name: 'Adjuntos de chat', model: 'openai/gpt-6-sol' }),
			other = await agents.create(person, { name: 'Otro agente', model: 'openai/gpt-6-sol' }),
			main = (await agents.conversations(a.id))[0];
		const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
		const sent = await inbox.receive(
			{
				agentId: a.id,
				source: 'web',
				personId: person,
				conversationId: main.id,
				text: '',
				attachments: [{ name: 'mi captura.png', mime: 'image/png', data: png }],
				dedupeKey: 'attach-one',
			},
			{ routeNow: false },
		);
		const page = await conversations.transcript(a.id, main.id);
		expect(page.inputs.find((m: any) => m.id === sent.message_id).files).toEqual([
			{ name: 'mi_captura.png', mime: 'image/png', size: 8 },
		]);
		const f = await inbox.inboundFile(a.id, sent.message_id, 'mi_captura.png');
		expect(Buffer.from(await Bun.file(f!.path).arrayBuffer()).toString('base64')).toBe(png);
		expect(await inbox.inboundFile(other.id, sent.message_id, 'mi_captura.png')).toBeNull();
		expect(
			inbox.render({ id: sent.message_id, source: 'web', sender: null, schedule_name: null, text: '' }, [
				'mi_captura.png',
			]),
		).toContain(`~/work/in/${sent.message_id}/: mi_captura.png`);
	},
);
run('baseline: WhatsApp remains disabled even with bridge credentials; no writes or outbound messages', async () => {
	const whatsapp = await import('./whatsapp');
	const before = await row('select count(*) as n from messages');
	waSent.length = 0;
	expect(whatsapp.enabled()).toBe(false);
	expect(whatsapp.checkSecret('wa-test')).toBe(false);
	expect(await whatsapp.status()).toEqual({ state: 'off' });
	expect(await whatsapp.agentView(999)).toEqual({ available: false, phone: null, enabled: false, contacts: [] });
	await expect(whatsapp.setAgent(999, { enabled: true })).rejects.toThrow('fuera de esta release');
	await expect(whatsapp.inbound({ id: 'fixture', phone: '5215512345678', text: 'Hola' })).rejects.toThrow(
		'fuera de esta release',
	);
	await expect(whatsapp.pair()).rejects.toThrow('no está configurado');
	await whatsapp.onRun(999, 'done');
	expect(waSent).toEqual([]);
	expect(await row('select count(*) as n from messages')).toEqual(before);
});
run('a message sent while the agent works waits in its queue and can be removed before it is taken', async () => {
	const agents = await import('./agents'),
		inbox = await import('./inbox'),
		tasks = await import('./tasks');
	const a = await agents.create(person, { name: 'Cola de trabajo', model: 'openai/gpt-6-sol' }),
		conv = (await agents.conversations(a.id))[0].id;
	const runId = (await row<{ id: number }>(
		`insert into runs(agent_id,person_id,conversation_id,workflow_id,model,status) values($1,$2,$3,$4,$5,'running') returning id`,
		[a.id, person, conv, `queue-${a.id}`, a.model],
	))!.id;
	const one = await inbox.receive({
		agentId: a.id,
		source: 'web',
		personId: person,
		conversationId: conv,
		text: 'Y revisa precios',
		dedupeKey: 'q-1',
	});
	const two = await inbox.receive({
		agentId: a.id,
		source: 'whatsapp',
		sender: '+52155',
		text: 'También el envío',
		dedupeKey: 'q-2',
	});
	expect(await row('select run_id,routed_as from messages where id=$1', [one.message_id])).toEqual({
		run_id: runId,
		routed_as: 'queued',
	});
	expect(await row('select run_id,routed_as from messages where id=$1', [two.message_id])).toEqual({
		run_id: runId,
		routed_as: 'queued',
	});
	await tasks.removeQueued(runId, one.message_id);
	expect(await row('select 1 from messages where id=$1', [one.message_id])).toBeNull();
	await expect(tasks.removeQueued(runId, one.message_id)).rejects.toThrow('ya no está');
	await expect(tasks.sendQueuedNow(runId, two.message_id)).rejects.toThrow('ya no está trabajando');
	await exec("update runs set status='done' where id=$1", [runId]);
});
run(
	'agent credentials: sealed, names only on the way out, reserved names refused, decrypted only for its sandbox',
	async () => {
		const agents = await import('./agents'),
			secrets = await import('./secrets');
		const a = await agents.create(person, { name: 'Con credenciales', model: 'openai/gpt-6-sol' }),
			b = await agents.create(person, { name: 'Sin credenciales', model: 'openai/gpt-6-sol' });
		const listed = await secrets.set(a.id, 'github_token', 'ghp_secreto');
		expect(listed.map((s) => s.name)).toEqual(['GITHUB_TOKEN']);
		expect(JSON.stringify(listed)).not.toContain('ghp_secreto');
		expect(
			(await row<{ value_enc: string }>('select value_enc from agent_secrets where agent_id=$1', [a.id]))!.value_enc,
		).not.toContain('ghp_secreto');
		for (const bad of ['PATH', 'AGENTS_MASTER_KEY', 'PI_CODING_AGENT_DIR', 'OPENAI_API_KEY', '1TOKEN', 'token-x'])
			await expect(secrets.set(a.id, bad, 'x')).rejects.toThrow();
		expect(await secrets.forRun(a.id)).toEqual({ GITHUB_TOKEN: 'ghp_secreto' });
		expect(await secrets.forRun(b.id)).toEqual({});
		await secrets.set(a.id, 'GITHUB_TOKEN', 'ghp_nuevo');
		expect(await secrets.forRun(a.id)).toEqual({ GITHUB_TOKEN: 'ghp_nuevo' });
		expect(await secrets.remove(a.id, 'GITHUB_TOKEN')).toEqual([]);
	},
);
run('sharing: the people an owner picks see and use the agent, never improve it; unsharing takes it back', async () => {
	const agents = await import('./agents'),
		designs = await import('./designs');
	const ana = (await row<{ id: number }>(
		"insert into people (name, key, avatar_seed) values ('Ana Compartida','ana-compartida','s') returning id",
	))!.id;
	const viewer = { id: ana, name: 'Ana Compartida', avatar_seed: 's', admin: false } as any;
	const a = await agents.create(person, { name: 'Compartido', model: 'openai/gpt-6-sol' }),
		hidden = await agents.create(person, { name: 'Privado', model: 'openai/gpt-6-sol' });
	expect(await agents.seeable(viewer, a.id)).toBeNull();
	expect(await agents.usable(viewer, a.id)).toBeNull();
	expect(await agents.setShares((await agents.get(a.id))!, [ana, person, ana, 999999])).toEqual([ana]);
	expect((await agents.seeable(viewer, a.id))?.id).toBe(a.id);
	expect((await agents.usable(viewer, a.id))?.id).toBe(a.id);
	expect(await agents.seeable(viewer, hidden.id)).toBeNull();
	const list = await agents.visible(viewer);
	expect(list.map((x: any) => x.id)).toEqual([a.id]);
	expect(list[0].shares).toEqual([ana]);
	await expect(designs.create(ana, { model: 'openai/gpt-6-sol', agentId: a.id })).rejects.toThrow('Sólo el dueño');
	const shown = agents.forViewer((await agents.get(a.id))!, viewer) as any;
	expect(shown.role).toBe('');
	expect(shown.harness).toBeUndefined();
	expect(shown.shares).toEqual([ana]);
	await expect(designs.configuration(viewer, a.id)).rejects.toThrow('configuración');
	const inbox = await import('./inbox');
	expect(inbox.render({ id: 1, source: 'web', sender: 'Ana Compartida', schedule_name: null, text: 'Hola' })).toContain(
		'Mensaje de Ana Compartida, con quien tu dueño compartió este agente',
	);
	expect(inbox.render({ id: 1, source: 'web', sender: null, schedule_name: null, text: 'Hola' })).toBe('Hola');
	const conversations = await import('./conversations'),
		conv = (await conversations.list(a.id))[0] ?? (await conversations.create(a.id, 'Compartida'));
	const sent = await inbox.receive(
		{
			agentId: a.id,
			source: 'web',
			personId: ana,
			sender: 'Ana Compartida',
			text: 'Hazme un resumen',
			conversationId: conv.id,
		},
		{ routeNow: false },
	);
	expect(sent).toBeTruthy();
	const stranger = (await row<{ id: number }>(
		"insert into people (name, key, avatar_seed) values ('Ajena','ajena-compartir','s') returning id",
	))!.id;
	await expect(
		inbox.receive(
			{ agentId: a.id, source: 'web', personId: stranger, text: 'Hola', conversationId: conv.id },
			{ routeNow: false },
		),
	).rejects.toThrow('compartido');
	await agents.setShares((await agents.get(a.id))!, []);
	expect(await agents.seeable(viewer, a.id)).toBeNull();
	expect(await agents.visible(viewer)).toEqual([]);
});
for (const status of ['queued', 'starting', 'running', 'blocked'] as const)
	run(`busy (${status}): only the requester's messages join a shared task`, async () => {
		const agents = await import('./agents'),
			inbox = await import('./inbox'),
			conversations = await import('./conversations'),
			tasks = await import('./tasks');
		const ana = (await row<{ id: number }>(
			"insert into people (name, key, avatar_seed) values ('Ana Ocupada',$1,'s') returning id",
			[`ana-ocupada-${status}`],
		))!.id;
		const beto = (await row<{ id: number }>(
			"insert into people (name, key, avatar_seed) values ('Beto Ocupado',$1,'s') returning id",
			[`beto-ocupado-${status}`],
		))!.id;
		const a = await agents.create(person, { name: 'Ocupado', model: 'openai/gpt-6-sol' });
		await agents.setShares((await agents.get(a.id))!, [ana, beto]);
		const conv = (await conversations.list(a.id))[0];
		const send = (personId: number, text: string) =>
			inbox.receive({ agentId: a.id, source: 'web', personId, text, conversationId: conv.id }, { routeNow: false });
		const first = await send(ana, 'Tarea de Ana');
		const run = (await row<{ id: number }>(
			`insert into runs(agent_id,person_id,conversation_id,workflow_id,model,status) values($1,$2,$3,$4,$5,$6) returning id`,
			[a.id, person, conv.id, `busy-${a.id}`, a.model, status],
		))!.id;
		await exec("update messages set run_id=$2,routed_as='new_run',routed_at=now() where id=$1", [
			first.message_id,
			run,
		]);
		const t = (await tasks.getTask(run))!;
		expect(t.requested_by).toBe(ana);
		expect(t.requested_by_name).toBe('Ana Ocupada');
		expect((await tasks.liveRunOf(a.id))!.requested_by).toBe(ana);
		expect(tasks.directs(t, ana)).toBe(true);
		expect(tasks.directs(t, person)).toBe(true);
		expect(tasks.directs(t, beto)).toBe(false);
		const other = await send(beto, 'Tarea de Beto'),
			mine = await send(person, 'Del dueño'),
			more = await send(ana, 'Más de Ana'),
			otherMore = await send(beto, 'Más de Beto');
		const hook = await inbox.receive({ agentId: a.id, source: 'hook', text: 'Canal del dueño' }, { routeNow: false });
		await inbox.route(a.id);
		const state = async (id: number) =>
			(await row<{ run_id: number | null; routed_as: string | null }>(
				'select run_id::int,routed_as from messages where id=$1',
				[id],
			))!;
		for (const m of [other, mine, otherMore, hook])
			expect(await state(m.message_id)).toEqual({ run_id: null, routed_as: null });
		expect(await state(more.message_id)).toEqual({
			run_id: run,
			routed_as: status === 'queued' || status === 'starting' ? 'queued_with' : 'queued',
		});
		expect((await tasks.getTask(run))!.status).toBe(status); // Nobody else's message unblocks Ana's question.
		// Simulate the next admitted run; only Beto's follow-up may join Beto, never the owner's waiting task.
		await exec("update runs set status='done' where id=$1", [run]);
		const next = (await row<{ id: number }>(
			`insert into runs(agent_id,person_id,conversation_id,workflow_id,model,status) values($1,$2,$3,$4,$5,'queued') returning id`,
			[a.id, person, conv.id, `busy-next-${a.id}`, a.model],
		))!.id;
		await exec("update messages set run_id=$2,routed_as='new_run',routed_at=now() where id=$1", [
			other.message_id,
			next,
		]);
		await inbox.route(a.id);
		expect((await tasks.getTask(next))!.requested_by).toBe(beto);
		expect(await state(otherMore.message_id)).toEqual({ run_id: next, routed_as: 'queued_with' });
		expect(await state(mine.message_id)).toEqual({ run_id: null, routed_as: null });
		await exec("update runs set status='done' where id=$1", [next]);
	});
run('conversation history pages executions and keeps chat events after thousands of tool events', async () => {
	const agents = await import('./agents'),
		conversations = await import('./conversations');
	const a = await agents.create(person, { name: 'Historia paginada', model: 'openai/gpt-6-sol' }),
		conv = (await agents.conversations(a.id))[0];
	for (let i = 1; i <= 12; i++) {
		const r = (await row<{ id: number }>(
			`insert into runs(agent_id,person_id,conversation_id,workflow_id,model,status,answer) values($1,$2,$3,$4,$5,'done',$6) returning id`,
			[a.id, person, conv.id, `page-${a.id}-${i}`, a.model, `Respuesta ${i}`],
		))!;
		await exec(
			`insert into messages(agent_id,conversation_id,source,text,run_id,routed_as,routed_at) values($1,$2,'web',$3,$4,'new_run',now())`,
			[a.id, conv.id, `Pedido ${i}`, r.id],
		);
		if (i === 12) {
			await exec(
				`insert into run_events(run_id,seq,kind,data) select $1,i,'tool','{"name":"read"}'::jsonb from generate_series(1,2001) i`,
				[r.id],
			);
			await exec(
				`insert into run_events(run_id,seq,kind,data) values($1,2002,'text','{"text":"Texto posterior a 2001 herramientas"}'::jsonb)`,
				[r.id],
			);
		}
	}
	const recent = await conversations.transcript(a.id, conv.id);
	expect(recent.records).toHaveLength(10);
	expect(recent.hasEarlier).toBe(true);
	expect(recent.records.at(-1)!.events.map((e) => e.data.text)).toEqual(['Texto posterior a 2001 herramientas']);
	expect(recent.inputs.map((m) => m.text)).toEqual(Array.from({ length: 10 }, (_, i) => `Pedido ${i + 3}`));
	const older = await conversations.transcript(a.id, conv.id, recent.before!);
	expect(older.records).toHaveLength(2);
	expect(older.hasEarlier).toBe(false);
	expect(older.inputs.map((m) => m.text)).toEqual(['Pedido 1', 'Pedido 2']);
});

run(
	'repairing a pending legacy questionnaire snapshots its actual choices without rewriting answered legacy rounds',
	async () => {
		const agents = await import('./agents'),
			tasks = await import('./tasks');
		const a = await agents.create(person, { name: 'Compatibilidad de ayuda', model: 'openai/gpt-6-sol' }),
			conv = (await agents.conversations(a.id))[0];
		const actual = {
			id: 'actual',
			title: '¿Cómo continúo?',
			selectionMode: 'single',
			options: [{ id: 'reference', label: 'Usar referencia histórica' }],
		};
		const legacy = {
			reason: JSON.stringify({ version: 1, reason: 'No hay precios actuales.', questions: [actual] }),
			structured: false,
			questions: [
				{
					id: 'continue',
					title: '¿Cómo continúo?',
					description: 'Fallback anterior',
					selectionMode: 'single',
					options: [{ id: 'skip', label: 'Continúa sin ese dato o sitio', description: '' }],
					recommended: null,
				},
			],
		};
		const make = async (tag: string) =>
			(await row<{ id: number }>(
				`insert into runs(agent_id,person_id,conversation_id,workflow_id,model,status,state) values($1,$2,$3,$4,$5,'blocked','blocked') returning id`,
				[a.id, person, conv.id, `legacy-help-${a.id}-${tag}`, a.model],
			))!;
		const current = await make('pending');
		await tasks.recordEvent(current.id, 'blocked', legacy);
		const pending = (await tasks.events(current.id))[0];
		expect(pending.data.questions[0].id).toBe('actual');
		const answers = { round: pending.id, values: { actual: { selected: ['reference'], other: '' } } };
		await tasks.answerHelp(current.id, answers);
		expect((await tasks.answerHelp(current.id, answers)).duplicate).toBe(true);
		const saved = await tasks.events(current.id);
		expect(saved.find((e) => e.kind === 'blocked')!.data.questions[0].id).toBe('actual');
		expect(saved.find((e) => e.kind === 'help_answer')!.data.questions[0].id).toBe('actual');
		expect(
			(await row('select data from run_events where run_id=$1 and seq=$2', [current.id, pending.id]))!.data,
		).toEqual(legacy);
		await exec("update runs set status='done' where id=$1", [current.id]);
		expect((await tasks.answerHelp(current.id, answers)).duplicate).toBe(true);
		const historical = await make('answered');
		await tasks.recordEvent(historical.id, 'blocked', legacy);
		const oldAnswers = { round: 1, values: { continue: { selected: ['skip'], other: '' } } };
		await tasks.recordEvent(historical.id, 'help_answer', {
			round: 1,
			answers: oldAnswers,
			text: 'Respuesta histórica del fallback',
		});
		await exec("update runs set status='done' where id=$1", [historical.id]);
		expect((await tasks.events(historical.id))[0].data.questions).toEqual(legacy.questions);
		expect((await tasks.answerHelp(historical.id, oldAnswers)).duplicate).toBe(true);
	},
);

run('plain chat help is durable, exact-round-bound and cannot race structured or stale replies', async () => {
	const agents = await import('./agents'),
		tasks = await import('./tasks'),
		inbox = await import('./inbox');
	const a = await agents.create(person, { name: 'Ayuda libre', model: 'openai/gpt-6-sol' }),
		conv = (await agents.conversations(a.id))[0];
	const r = (await row<{ id: number }>(
		`insert into runs(agent_id,person_id,conversation_id,workflow_id,model,status,state) values($1,$2,$3,$4,$5,'blocked','blocked') returning id`,
		[a.id, person, conv.id, `text-help-${a.id}`, a.model],
	))!;
	await tasks.recordEvent(r.id, 'blocked', { reason: 'Escribe tu ciudad.' });
	const round = (await tasks.events(r.id))[0].id,
		key = crypto.randomUUID();
	expect((await tasks.events(r.id))[0].data.questions).toEqual([]);
	const result = await Promise.all([
		tasks.answerHelpText(r.id, round, 'Guadalajara', key),
		tasks.answerHelpText(r.id, round, 'Guadalajara', key),
	]);
	expect(result.map((x) => x.duplicate).sort()).toEqual([false, true]);
	await expect(tasks.answerHelpText(r.id, round, 'Monterrey', key)).rejects.toThrow('otra respuesta');
	await expect(tasks.answerHelpText(r.id, round, 'Monterrey', crypto.randomUUID())).rejects.toThrow('cambió');
	await expect(tasks.answerHelp(r.id, { round, values: {} })).rejects.toThrow('cambió');
	const message = (await row('select * from messages where run_id=$1', [r.id]))!;
	expect(message.conversation_id).toBe(conv.id);
	await tasks.recordEvent(r.id, 'blocked', { reason: 'Otra decisión.' });
	await inbox.route(a.id);
	expect((await row('select routed_at from messages where id=$1', [message.id]))!.routed_at).not.toBeNull();
	expect((await tasks.events(r.id)).filter((e) => e.kind === 'help_reply')).toHaveLength(1);
	expect((await tasks.events(r.id)).some((e) => e.kind === 'help_expired')).toBe(true);
	expect((await row('select count(*) as n from runs where agent_id=$1', [a.id]))!.n).toBe(1);
	await exec("update runs set status='done' where id=$1", [r.id]);
	expect((await tasks.answerHelpText(r.id, round, 'Guadalajara', key)).duplicate).toBe(true);
});

async function proposal(agentId?: number) {
	const designs = await import('./designs');
	const d = await designs.create(person, { model: 'openai/gpt-6-sol', ...(agentId ? { agentId } : {}) });
	const asked = await designs.message(person, d.id, {
		text: 'Quiero comparar fuentes y entregar un informe con evidencia.',
		version: d.version,
	});
	const pending = asked.interview.pending!;
	return designs.message(person, d.id, {
		version: asked.version,
		answers: {
			round: pending.round,
			values: Object.fromEntries(pending.questions.map((q) => [q.id, { selected: [q.options.at(-1)!.id], other: '' }])),
		},
	});
}
run('interview persists a structured draft but creates no agent or run', async () => {
	const designs = await import('./designs');
	const before = await row('select count(*) as n from agents');
	const d = await proposal();
	expect(d.ready).toBe(true);
	expect(d.version).toBe(2);
	expect(d.messages.length).toBe(4);
	expect(d.tokens).toBe(246);
	expect(d.interview).toMatchObject({ phase: 'review', completed: 1, pending: null });
	expect(d.contract).toEqual(designerReply.contract);
	expect(await row('select count(*) as n from agents')).toEqual(before);
	expect((await designs.get(person, d.id)).messages).toEqual(d.messages);
	const request = modelRequests.at(-1);
	expect(request.model).toBe('gpt-6-sol');
	expect(request.store).toBe(false);
	expect(request.tools).toEqual([]);
	expect(request.input[0].content).toContain('frontera');
	expect(request.text.format.type).toBe('json_schema');
	expect(request.input[1].questions).toBeUndefined(); // provider messages carry only role/content, not UI metadata
	expect(request.input.some((m: any) => m.content.includes('Preguntas de esta ronda'))).toBe(true);
	expect(d.effectivePrompt).toContain('Nunca pagas');
});
run('draft ownership and GPT catalog are enforced before model calls', async () => {
	const designs = await import('./designs');
	const d = await designs.create(person, { model: 'openai/gpt-6-sol' });
	const count = modelRequests.length;
	await expect(designs.get(person + 1000, d.id)).rejects.toThrow('no es tuyo');
	await expect(designs.message(person + 1000, d.id, { text: 'x', version: 0 })).rejects.toThrow('no es tuyo');
	await expect(designs.approve(person + 1000, d.id, 0)).rejects.toThrow('no es tuyo');
	await expect(designs.create(person, { model: 'anthropic/x' })).rejects.toThrow('GPT');
	await expect(designs.create(person + 1000, { model: 'openai/gpt-6-sol', agentId: 1 })).rejects.toThrow('dueño');
	expect(modelRequests.length).toBe(count);
});
run('provider failure preserves the previous version and releases the lease', async () => {
	const designs = await import('./designs');
	const d = await designs.create(person, { model: 'openai/gpt-6-sol' });
	replyStatus = 429;
	try {
		await expect(designs.message(person, d.id, { text: 'Quiero un agente.', version: 0 })).rejects.toThrow('429');
	} finally {
		replyStatus = 200;
	}
	const after = await designs.own(person, d.id);
	expect(after.messages).toEqual([]);
	expect(after.version).toBe(0);
	expect(after.busy_token).toBeNull();
	expect((await designs.message(person, d.id, { text: 'Reintento', version: 0 })).version).toBe(1);
});
run(
	'interview attachments: images reach the model as images, text files inline, nothing else is accepted',
	async () => {
		const designs = await import('./designs');
		const d = await designs.create(person, { model: 'openai/gpt-6-sol' });
		const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'),
			csv = Buffer.from('dia,monto\n1,100').toString('base64');
		await expect(
			designs.message(person, d.id, {
				text: 'x',
				version: 0,
				attachments: [{ name: 'a.pdf', mime: 'application/pdf', data: png }],
			}),
		).rejects.toThrow('imágenes');
		const before = modelRequests.length;
		const after = await designs.message(person, d.id, {
			text: '',
			version: 0,
			attachments: [
				{ name: 'captura.png', mime: 'image/png', data: png },
				{ name: 'gastos.csv', mime: 'text/csv', data: csv },
			],
		});
		expect(modelRequests.length).toBe(before + 1);
		const user = modelRequests.at(-1).input.at(-1);
		expect(user.content.map((p: any) => p.type)).toEqual(['input_text', 'input_image', 'input_text']);
		expect(user.content[1].image_url).toBe(`data:image/png;base64,${png}`);
		expect(user.content[2].text).toContain('dia,monto');
		const sent = after.messages.find((m: any) => m.attachments)!.attachments!;
		expect(sent.map((f: any) => [f.name, f.mime])).toEqual([
			['captura.png', 'image/png'],
			['gastos.csv', 'text/plain'],
		]);
		expect(
			Buffer.from(await Bun.file((await designs.file(person, d.id, sent[0].id))!.path).arrayBuffer()).toString(
				'base64',
			),
		).toBe(png);
		await expect(designs.file(person + 1, d.id, sent[0].id)).rejects.toThrow();
	},
);
run('automejora: cited jobs reach the designer with their timeline, and only the agent own jobs', async () => {
	const agents = await import('./agents'),
		designs = await import('./designs');
	const a = await agents.create(person, { name: 'Citado', model: 'openai/gpt-6-sol' }),
		other = await agents.create(person, { name: 'Ajeno', model: 'openai/gpt-6-sol' });
	const conv = (await agents.conversations(a.id))[0].id,
		otherConv = (await agents.conversations(other.id))[0].id;
	const mk = async (agentId: number, c: number, answer: string) =>
		(await row<{ id: number }>(
			`insert into runs(agent_id,person_id,conversation_id,workflow_id,model,status,answer,end_reason) values($1,$2,$3,$4,'openai/gpt-6-sol','incomplete',$5,'Se acabó el tiempo (30 min).') returning id`,
			[agentId, person, c, `ref-${agentId}-${Date.now()}`, answer],
		))!.id;
	const mine = await mk(a.id, conv, 'Me atoré en el captcha.'),
		foreign = await mk(other.id, otherConv, 'Secreto ajeno.');
	await exec(`insert into run_events(run_id,seq,kind,data) values($1,1,'tool',$2),($1,2,'blocked',$3)`, [
		mine,
		JSON.stringify({ name: 'bash', summary: 'agent-browser open https://tienda' }),
		JSON.stringify({ reason: 'Captcha en la tienda' }),
	]);
	const cited = await designs.referenced(a.id, [
		`Revisa @[#${mine} pedido](run:${mine}) y @[#${foreign} otro](run:${foreign})`,
	]);
	expect(cited.map((c) => c.trabajo)).toEqual([mine]);
	expect(cited[0].linea_de_tiempo).toEqual([
		'paso: agent-browser open https://tienda',
		'blocked: Captcha en la tienda',
	]);
	expect(cited[0].respuesta).toBe('Me atoré en el captcha.');
	expect(cited[0].motivo).toContain('Se acabó el tiempo');
	const d = await designs.create(person, { model: 'openai/gpt-6-sol', agentId: a.id });
	await designs.message(person, d.id, {
		text: `¿Qué salió mal en @[#${mine} pedido](run:${mine})?`,
		version: d.version,
	});
	const system = modelRequests.at(-1).input[0].content as string;
	expect(system).toContain('Trabajos citados por el dueño');
	expect(system).toContain('Captcha en la tienda');
	expect(system).not.toContain('Secreto ajeno');
});
run('stale chat revisions are rejected without spending another model request', async () => {
	const designs = await import('./designs');
	const d = await proposal();
	const before = modelRequests.length;
	await expect(designs.message(person, d.id, { text: 'Otro', version: 0 })).rejects.toThrow('otra pestaña');
	expect(modelRequests.length).toBe(before);
});
run('one request per owner across tabs; concurrent calls cannot overwrite history', async () => {
	const designs = await import('./designs');
	const a = await designs.create(person, { model: 'openai/gpt-6-sol' });
	const b = await designs.create(person, { model: 'openai/gpt-6-sol' });
	const before = modelRequests.length;
	let release!: () => void;
	waitReply = new Promise<void>((resolve) => {
		release = resolve;
	});
	const first = designs.message(person, a.id, { text: 'Primera', version: 0 });
	try {
		for (let i = 0; i < 200 && modelRequests.length === before; i++) await Bun.sleep(10);
		expect(modelRequests.length).toBe(before + 1);
		await expect(designs.message(person, a.id, { text: 'Carrera', version: 0 })).rejects.toThrow('respondiendo');
		await expect(designs.message(person, b.id, { text: 'Otra pestaña', version: 0 })).rejects.toThrow('en curso');
	} finally {
		waitReply = null;
		release();
	}
	expect((await first).messages.length).toBe(2);
	expect((await designs.own(person, b.id)).messages.length).toBe(0);
});
// DB-only tests seed an explicit runtime attestation; real Docker attestation is covered by design-smoke.
async function attest(d: Awaited<ReturnType<typeof proposal>>) {
	const { proposalDigest, harnessHash } = await import('./harnesses');
	await exec('update agent_designs set harness_validation=$2 where id=$1', [
		d.id,
		JSON.stringify({
			status: 'passed',
			version: d.version,
			digest: proposalDigest(d),
			harnessDigest: harnessHash(d.harness),
			imageId: 'sha256:' + 'a'.repeat(64),
			at: Date.now(),
			tools: [],
			checks: ['DB test fixture, not a runtime test'],
		}),
	]);
}
run('approval creates exactly one agent, preserves the full contract and is idempotent', async () => {
	const designs = await import('./designs');
	const d = await proposal();
	const before = (await row<{ n: number }>('select count(*) as n from agents'))!.n;
	await expect(designs.approve(person, d.id, d.version)).rejects.toThrow('Prueba el harness');
	await attest(d);
	const [a, b] = await Promise.all([
		designs.approve(person, d.id, d.version),
		designs.approve(person, d.id, d.version),
	]);
	expect(a.applied_agent_id).toBe(b.applied_agent_id);
	expect((await row<{ n: number }>('select count(*) as n from agents'))!.n).toBe(before + 1);
	await expect((await import('./agents')).get(a.applied_agent_id!)).resolves.toMatchObject({
		role: d.contract!.prompt,
		config_revision: 1,
	});
	const requests = modelRequests.length;
	await expect(designs.message(person, d.id, { text: 'Aplicar sin revisión', version: d.version })).rejects.toThrow();
	expect(modelRequests.length).toBe(requests);
	await expect(
		enqueue({ id: a.applied_agent_id!, person_id: person, model: d.model }, 'Trabajo prematuro', { admin: false }),
	).rejects.toThrow('inicialización');
});
run('approval requires a ready contract and its exact latest revision', async () => {
	const designs = await import('./designs');
	const d = await designs.create(person, { model: 'openai/gpt-6-sol' });
	await expect(designs.approve(person, d.id, 0)).rejects.toThrow('no está listo');
	const ready = await designs.message(person, d.id, { text: 'Contrato', version: 0 });
	await expect(designs.approve(person, d.id, 0)).rejects.toThrow('cambió');
	expect((await designs.own(person, ready.id)).status).toBe('draft');
});
run('improvement cannot mutate a live agent, then applies once without losing its memory', async () => {
	const agents = await import('./agents');
	const designs = await import('./designs');
	const agent = await agents.create(person, { name: 'Mejorable', role: 'Prompt original', model: 'openai/gpt-6-sol' });
	const d = await proposal(agent.id);
	await attest(d);
	const conversation = (await agents.conversations(agent.id))[0];
	await exec(
		"insert into runs (agent_id,person_id,conversation_id,workflow_id,model,status) values ($1,$2,$3,'busy-improvement','m','running')",
		[agent.id, person, conversation.id],
	);
	await expect(designs.approve(person, d.id, d.version)).rejects.toThrow('corrida');
	await exec("update runs set status='done',ended_at=now() where workflow_id='busy-improvement'");
	const result = await designs.approve(person, d.id, d.version);
	expect(result.applied_agent_id).toBe(agent.id);
	expect((await agents.get(agent.id))?.role).toBe(d.contract!.prompt);
	expect((await agents.get(agent.id))?.config_revision).toBe(2);
	expect((await agents.conversations(agent.id))[0].id).toBe(conversation.id);
	await designs.approve(person, d.id, d.version);
	expect((await agents.get(agent.id))?.config_revision).toBe(2);
});
run('an obsolete improvement cannot overwrite a newer manual configuration', async () => {
	const agents = await import('./agents');
	const designs = await import('./designs');
	const agent = await agents.create(person, { name: 'Revisión', role: 'Inicial', model: 'openai/gpt-6-sol' });
	const d = await proposal(agent.id);
	await attest(d);
	await agents.edit(agent, { role: 'Cambio manual', revision: 1 });
	expect((await designs.get(person, d.id)).stale).toBe(true);
	await expect(designs.approve(person, d.id, d.version)).rejects.toThrow('cambió');
	expect((await agents.get(agent.id))?.role).toBe('Cambio manual');
});

run('a new proposal invalidates exact-revision attestation and rejects approval without a fresh test', async () => {
	const designs = await import('./designs');
	const d = await proposal();
	await attest(d);
	const next = await designs.message(person, d.id, { text: 'Revisa también la presentación.', version: d.version });
	expect(next.harness_validation).toBeNull();
	expect(next.harness).toEqual(d.harness);
	await expect(designs.approve(person, next.id, next.version)).rejects.toThrow('Prueba el harness');
});
run('restoration is an owned untested draft based on the current revision, never an implicit rollback', async () => {
	const agents = await import('./agents'),
		designs = await import('./designs');
	const a = await agents.create(person, { name: 'Historial', role: 'Original', model: 'openai/gpt-6-sol' });
	const before = await agents.conversations(a.id);
	await agents.edit(a, { role: 'Segundo', revision: 1 });
	const d = await designs.create(person, { agentId: a.id, model: a.model, revision: 1 });
	expect(d.contract?.prompt).toBe('Original');
	expect(d.ready).toBe(true);
	expect(d.harness_validation).toBeNull();
	expect((await designs.own(person, d.id)).base_revision).toBe(2);
	expect((await agents.get(a.id))?.role).toBe('Segundo');
	expect(await agents.conversations(a.id)).toEqual(before);
	await expect(designs.create(person + 1000, { agentId: a.id, model: a.model, revision: 1 })).rejects.toThrow('dueño');
	await expect(designs.create(person, { agentId: a.id, model: a.model, revision: 999 })).rejects.toThrow('no existe');
	await expect(designs.testHarness(person + 1000, d.id, d.version)).rejects.toThrow('no es tuyo');
	const config = await designs.configuration({ id: person, admin: false } as any, a.id);
	expect(config.revisions.map((r) => r.revision)).toEqual([2, 1]);
});
run('improvement changes effective tools, skills and pinned plugins together, not only the role', async () => {
	const agents = await import('./agents'),
		designs = await import('./designs'),
		{ defaultHarness } = await import('./harnesses');
	const a = await agents.create(person, { name: 'Harness editable', role: 'Original', model: 'openai/gpt-6-sol' });
	designerReply.harness = {
		...defaultHarness(),
		tools: ['read', 'request_help'],
		restrictions: { workspaceFilesOnly: true, readOnlyFiles: true, guidelines: ['Cita fuentes.'] },
		skills: [{ name: 'audit', description: 'Auditar evidencia.', instructions: 'Compara citas.' }],
		plugins: [{ id: 'text-utils', version: '1.0.0' }],
	};
	try {
		const d = await proposal(a.id);
		expect(d.tools.map((t) => t.id).sort()).toEqual(['read', 'request_help', 'text_stats']);
		expect((await agents.get(a.id))?.harness.tools).toContain('bash');
		await attest(d);
		await designs.approve(person, d.id, d.version);
		const current = (await agents.get(a.id))!;
		expect(current.harness).toEqual(d.harness);
		expect(current.config_revision).toBe(2);
		const restore = await designs.create(person, { agentId: a.id, model: a.model, revision: 1 });
		expect(restore.harness.tools).toContain('bash');
		expect(restore.harness.plugins).toEqual([]);
		expect(restore.harness_validation).toBeNull();
	} finally {
		designerReply.harness = null;
	}
});
run('expired validation lease is recoverable in the transaction that clears it', async () => {
	const designs = await import('./designs'),
		{ tx } = await import('./db');
	const d = await proposal();
	await exec(
		"update agent_designs set busy_token=gen_random_uuid(),busy_until=now()-interval '1 second',validation_pending=true where id=$1",
		[d.id],
	);
	await tx(async (c) => {
		await exec(
			'update agent_designs set busy_token=null,busy_until=null,validation_pending=false where id=$1',
			[d.id],
			c,
		);
		const recovered = await designs.own(person, d.id, c);
		expect(recovered.busy_token).toBeNull();
		expect(recovered.validation_pending).toBe(false);
	});
});
run('provider structured questions override premature contract/harness and persist independently', async () => {
	const designs = await import('./designs'),
		{ FALLBACK_QUESTIONS } = await import('./interview');
	designerReply.questions = [
		{ ...FALLBACK_QUESTIONS[0], id: 'goal', title: '¿Qué resultado necesitas?' },
		{ ...FALLBACK_QUESTIONS[0], id: 'sources', title: '¿Qué fuentes están disponibles?', selectionMode: 'multi' },
	];
	try {
		const d = await designs.create(person, { model: 'openai/gpt-6-sol' });
		const asked = await designs.message(person, d.id, { text: 'Necesito definir el alcance.', version: 0 });
		expect(asked.contract).toBeNull();
		expect(asked.ready).toBe(false);
		expect(asked.interview.pending?.questions).toEqual(designerReply.questions);
		expect((await designs.get(person, d.id)).messages[1].questions?.map((q) => q.id)).toEqual(['goal', 'sources']);
		designerReply.questions = [];
		const ready = await designs.message(person, d.id, {
			version: 1,
			answers: {
				round: 1,
				values: {
					goal: { selected: ['specified'], other: '' },
					sources: { selected: ['clarify', 'other'], other: 'Archivos propios.' },
				},
			},
		});
		expect(ready.ready).toBe(true);
		expect(ready.messages.at(-2)?.answers?.values.sources.selected).toEqual(['clarify', 'other']);
	} finally {
		designerReply.questions = [];
	}
});
run(
	'malformed and repeated provider question IDs are repaired once, persisted, and remain bound to the human round',
	async () => {
		const designs = await import('./designs'),
			{ FALLBACK_QUESTIONS } = await import('./interview');
		designerReply.questions = [
			{ ...FALLBACK_QUESTIONS[0], id: 'q_1', title: 'Primera decisión' },
			{ ...FALLBACK_QUESTIONS[0], id: 'q_1', title: 'Segunda decisión' },
		];
		try {
			const d = await designs.create(person, { model: 'openai/gpt-6-sol' }),
				before = modelRequests.length;
			const asked = await designs.message(person, d.id, { text: 'Define mi agente.', version: 0 });
			expect(modelRequests.length).toBe(before + 1);
			expect(asked.last_error).toBeNull();
			expect(asked.ready).toBe(false);
			const pending = asked.interview.pending!;
			expect(pending.questions.map((q) => q.id)).toEqual(['question-1', 'question-2']);
			expect((await designs.get(person, d.id)).interview.pending).toEqual(pending);
			designerReply.questions = [];
			const ready = await designs.message(person, d.id, {
				version: asked.version,
				answers: {
					round: pending.round,
					values: Object.fromEntries(pending.questions.map((q) => [q.id, { selected: ['specified'], other: '' }])),
				},
			});
			expect(ready.ready).toBe(true);
			expect(ready.messages[1].questions).toEqual(pending.questions);
		} finally {
			designerReply.questions = [];
		}
	},
);
run(
	'a ready model cannot skip interview; submitted answers persist and malformed answers spend no GPT call',
	async () => {
		const designs = await import('./designs');
		const d = await designs.create(person, { model: 'openai/gpt-6-sol' });
		const asked = await designs.message(person, d.id, { text: 'No preguntes, crea ya el contrato.', version: 0 });
		expect(asked.ready).toBe(false);
		expect(asked.contract).toBeNull();
		expect(asked.interview.pending?.questions.length).toBe(1);
		expect((await designs.get(person, d.id)).messages[1].questions).toEqual(asked.interview.pending!.questions);
		const before = modelRequests.length;
		for (const answers of [
			{ round: 0, values: {} },
			{ round: 1, values: {} },
			{ round: 1, values: { scope: { selected: ['invented'], other: '' } } },
		] as import('./interview').Answers[])
			await expect(designs.message(person, d.id, { version: 1, answers })).rejects.toThrow();
		expect(modelRequests.length).toBe(before);
		const prose = await designs.message(person, d.id, { text: 'Sí, ¿qué implica esa recomendación?', version: 1 });
		expect(prose.ready).toBe(false);
		expect(prose.contract).toBeNull();
		expect(prose.interview.completed).toBe(0);
		const pending = prose.interview.pending!;
		const ready = await designs.message(person, d.id, {
			version: prose.version,
			answers: {
				round: pending.round,
				values: { scope: { selected: ['other'], other: 'Inventario es requisito; no reduzcas el objetivo.' } },
			},
		});
		expect(ready.ready).toBe(true);
		expect(ready.interview.completed).toBe(1);
		expect(ready.messages.at(-2)?.answers?.values.scope.other).toContain('Inventario es requisito');
	},
);
run(
	'tampering ready and attestation cannot bypass unresolved interview, and editing a restore starts questions',
	async () => {
		const designs = await import('./designs'),
			agents = await import('./agents');
		const d = await designs.create(person, { model: 'openai/gpt-6-sol' });
		await exec('update agent_designs set ready=true,contract=$2 where id=$1', [
			d.id,
			JSON.stringify(designerReply.contract),
		]);
		const forged = await designs.get(person, d.id);
		await attest(forged);
		expect(forged.ready).toBe(false);
		await expect(designs.testHarness(person, d.id, d.version)).rejects.toThrow('cuestionario');
		await expect(designs.approve(person, d.id, d.version)).rejects.toThrow('cuestionario');
		const a = await agents.create(person, { name: 'Restaurable', role: 'Original', model: 'openai/gpt-6-sol' });
		const restore = await designs.create(person, { agentId: a.id, model: a.model, revision: 1 });
		expect(restore.interview.phase).toBe('restore');
		const changed = await designs.message(person, restore.id, { version: 0, text: 'Además cambia el objetivo.' });
		expect(changed.restored_revision).toBeNull();
		expect(changed.ready).toBe(false);
		expect(changed.interview.pending).not.toBeNull();
	},
);
run('work help answers are round-bound, idempotent, durable and never replay as another task', async () => {
	const agents = await import('./agents'),
		tasks = await import('./tasks'),
		inbox = await import('./inbox');
	const a = await agents.create(person, { name: 'Ayuda aislada', model: 'openai/gpt-6-sol' });
	const conv = (await agents.conversations(a.id))[0];
	const r = (await row<{ id: number }>(
		`insert into runs (agent_id,person_id,conversation_id,workflow_id,model,status,state) values ($1,$2,$3,$4,$5,'blocked','blocked') returning id`,
		[a.id, person, conv.id, `help-fixture-${a.id}`, a.model],
	))!;
	await tasks.recordEvent(r.id, 'blocked', { reason: 'Necesito la ciudad.' });
	// Model omitted presentation-only fields: preserve its real alternatives, not a fabricated fallback.
	await exec(`update run_events set data=$2 where run_id=$1 and seq=1`, [
		r.id,
		JSON.stringify({
			reason: JSON.stringify({
				version: 1,
				reason: 'Necesito la ciudad.',
				questions: [
					{
						id: 'continue',
						title: '¿Cómo continúo?',
						selectionMode: 'single',
						options: [{ id: 'skip', label: 'Continuar sin ciudad' }],
					},
				],
			}),
		}),
	]);
	const pending = (await tasks.events(r.id))[0];
	expect(pending.data.questions[0].recommended).toBeNull();
	const answers = { round: pending.id, values: { continue: { selected: ['other'], other: 'Guadalajara' } } };
	const before = calls;
	await expect(tasks.answerHelp(r.id, { ...answers, round: 0 })).rejects.toThrow();
	const results = await Promise.all([tasks.answerHelp(r.id, answers), tasks.answerHelp(r.id, answers)]);
	expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
	expect(calls).toBe(before);
	expect((await tasks.events(r.id)).filter((e) => e.kind === 'help_answer')).toHaveLength(1);
	await expect(
		tasks.answerHelp(r.id, { ...answers, values: { continue: { selected: ['skip'], other: '' } } }),
	).rejects.toThrow('respuesta distinta');
	const message = (await row('select * from messages where run_id=$1', [r.id]))!;
	expect(message.routed_as).toBe('unblock');
	expect(message.routed_at).toBeNull();
	await inbox.route(a.id);
	expect((await row('select routed_at from messages where id=$1', [message.id]))!.routed_at).toBeNull(); // reconnecting, not lost
	await tasks.recordEvent(r.id, 'blocked', { reason: 'Otra decisión posterior.' });
	await inbox.route(a.id); // MUST NOT steer the new round or create any task
	expect((await row('select routed_at from messages where id=$1', [message.id]))!.routed_at).not.toBeNull();
	expect((await tasks.events(r.id)).some((e) => e.kind === 'help_expired')).toBe(true);
	expect((await row('select count(*) as n from runs where agent_id=$1', [a.id]))!.n).toBe(1);
	const latest = (await tasks.events(r.id)).filter((e) => e.kind === 'blocked').at(-1)!;
	await tasks.recordEvent(r.id, 'steer', { text: 'Respuesta libre.' });
	await expect(tasks.answerHelp(r.id, { ...answers, round: latest.id })).rejects.toThrow('cambió');
	await exec("update runs set status='done' where id=$1", [r.id]);
});
run('tampering with attested contract or harness cannot authorize application', async () => {
	const designs = await import('./designs'),
		{ defaultHarness } = await import('./harnesses');
	const d = await proposal();
	await attest(d);
	const changed = defaultHarness();
	changed.restrictions.guidelines = ['Una pauta nueva.'];
	await exec('update agent_designs set harness=$2 where id=$1', [d.id, JSON.stringify(changed)]);
	await expect(designs.approve(person, d.id, d.version)).rejects.toThrow('Prueba el harness');
});
