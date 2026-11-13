import { afterAll, beforeAll, expect, test } from 'bun:test';

// Against a throwaway database (AGENTS_TEST_DATABASE_URL, never the dev one): `just dev test`
// runs this inside the dev server container. No real provider or Docker calls.
const url = process.env.AGENTS_TEST_DATABASE_URL;
const run = url ? test : test.skip;
if (!url) console.warn('AGENTS_TEST_DATABASE_URL is not set: skipping (run `just dev test`).');
// The runner must set AGENTS_DATABASE_URL BEFORE Bun loads ANY test module.
process.env.AGENTS_DATA = '/tmp';
// A fake WhatsApp bridge (the API of ../../whatsapp), set before any module reads its address.
const waSent: { jid: string; phone?: string; group?: string; text: string; files: unknown[]; resolve?: boolean }[] = [];
const waGroups: { jid: string; group: string; name: string; phones: string[] }[] = [];
const waLocks: { group: string; locked: boolean }[] = [];
const waPhotos: { group: string; photo: string }[] = [];
let waOut = 0;
const waPairings = new Map<string, { state: string; jid?: string; phone?: string; name?: string; qr?: string }>();
const waLinked = new Map<string, string>(); // jid → state
const waUnlinked: string[] = [];
const waPolls: { id: string; jid: string; phone: string; name: string; options: string[] }[] = [];
const waTyping: { jid: string; phone?: string; group?: string }[] = [];
const waBridge = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	async fetch(req) {
		if (req.headers.get('x-agents-secret') !== 'wa-test') return new Response(null, { status: 403 });
		const path = decodeURIComponent(new URL(req.url).pathname);
		const send = path.match(/^\/numbers\/(.+)\/send$/);
		if (send && req.method === 'POST') {
			const body = await req.json();
			waSent.push({ jid: send[1], ...body });
			const ids = [...(body.text?.trim() ? [`out-${++waOut}`] : []), ...(body.files ?? []).map(() => `out-${++waOut}`)];
			return Response.json({ ok: true, ids });
		}
		const photo = path.match(/^\/numbers\/(.+)\/groups\/(.+)\/photo$/);
		if (photo && req.method === 'POST') {
			waPhotos.push({ group: photo[2], ...(await req.json()) });
			return Response.json({ ok: true });
		}
		const lock = path.match(/^\/numbers\/(.+)\/groups\/(.+)\/lock$/);
		if (lock && req.method === 'POST') {
			waLocks.push({ group: lock[2], ...(await req.json()) });
			return Response.json({ ok: true });
		}
		const groups = path.match(/^\/numbers\/(.+)\/groups$/);
		if (groups && req.method === 'POST') {
			const body = await req.json();
			const group = `g-${waGroups.length + 1}@g.us`;
			waGroups.push({ jid: groups[1], group, ...body });
			return Response.json({ jid: group });
		}
		const typing = path.match(/^\/numbers\/(.+)\/typing$/);
		if (typing && req.method === 'POST') {
			waTyping.push({ jid: typing[1], ...(await req.json()) });
			return Response.json({ ok: true });
		}
		const poll = path.match(/^\/numbers\/(.+)\/poll$/);
		if (poll && req.method === 'POST') {
			const id = `poll-${waPolls.length + 1}`;
			waPolls.push({ id, jid: poll[1], ...(await req.json()) });
			return Response.json({ id });
		}
		const number = path.match(/^\/numbers\/(.+)$/);
		if (number && req.method === 'DELETE') {
			waLinked.delete(number[1]);
			waUnlinked.push(number[1]);
			return Response.json({ ok: true });
		}
		if (path === '/numbers')
			return Response.json({
				numbers: [...waLinked].map(([jid, state]) => ({ jid, state, phone: jid.split(':')[0] })),
			});
		if (path === '/pairings' && req.method === 'POST') {
			const { ref } = await req.json();
			waPairings.set(ref, { state: 'pairing', qr: 'UVI=' });
			return Response.json({ state: 'pairing' }, { status: 202 });
		}
		const pairing = path.match(/^\/pairings\/(.+)$/);
		if (pairing) {
			if (req.method === 'DELETE') waPairings.delete(pairing[1]);
			return waPairings.has(pairing[1])
				? Response.json(waPairings.get(pairing[1]))
				: Response.json({ error: 'no' }, { status: 404 });
		}
		return Response.json({ error: 'not found' }, { status: 404 });
	},
});
/** The phone scanned the QR of pairing `ref`: the bridge now has that number. */
let waDevice = 0; // every link is a new device of the account, with its own JID
const waScan = (ref: number, phone: string) => {
	const jid = `${phone}:${++waDevice}@s.whatsapp.net`;
	waPairings.set(String(ref), { state: 'linked', jid, phone, name: `WA ${phone}` });
	waLinked.set(jid, 'connected');
	return jid;
};
process.env.AGENTS_WHATSAPP_URL = waBridge.url.origin;
process.env.AGENTS_WHATSAPP_SECRET = 'wa-test';
process.env.AGENTS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const { migrate, exec, row, rows, DATABASE_URL } = await import('./db');
const { assertTestDatabase } = await import('./test-database');
const { setProxy, checkProxyModel } = await import('./providers');
const { enqueue } = await import('./tasks');
const { settings } = await import('./settings');

let status = 200;
let calls = 0;
let replyStatus = 200;
let waitReply: Promise<void> | null = null;
const modelRequests: any[] = [];
const queuedReplies: unknown[] = []; // served before designerReply, one per request
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
							content: [{ type: 'output_text', text: JSON.stringify(queuedReplies.shift() ?? designerReply) }],
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

run('a message waits for a proxy that does not answer, and fails only after 6 h or for other reasons', async () => {
	const agents = await import('./agents'),
		inbox = await import('./inbox');
	const a = await agents.create(person, { name: 'Espera al proxy', model: 'openai/gpt-6-sol' });
	const runsOf = () =>
		rows<{ status: string; end_reason: string | null }>('select status, end_reason from runs where agent_id = $1', [
			a.id,
		]);
	const start = Date.now();
	inbox.routerClock.now = () => start;
	status = 503;
	try {
		const m = await inbox.receive(
			{ agentId: a.id, source: 'web', personId: person, text: 'Hola' },
			{ routeNow: false },
		);
		await inbox.route(a.id);
		expect(await runsOf()).toEqual([]);
		expect(await row('select run_id, routed_at from messages where id = $1', [m.message_id])).toEqual({
			run_id: null,
			routed_at: null,
		});
		expect(inbox.retryOf(a.id)).toEqual({ n: 1, at: start + 60_000 });
		await inbox.route(a.id);
		expect(inbox.retryOf(a.id)).toEqual({ n: 2, at: start + 120_000 });
		// After 6 h without the proxy, it ends in error so its sender hears why.
		inbox.routerClock.now = () => start + inbox.RETRY_FOR_MS + 1;
		await inbox.route(a.id);
		expect(await runsOf()).toEqual([
			{ status: 'error', end_reason: expect.stringContaining('El proxy respondió 503') },
		]);
		expect(inbox.retryOf(a.id)).toBeNull();
		// A rejected key is not worth waiting for.
		inbox.routerClock.now = () => start;
		status = 401;
		const b = await agents.create(person, { name: 'Llave rechazada', model: 'openai/gpt-6-sol' });
		await inbox.receive({ agentId: b.id, source: 'web', personId: person, text: 'Hola' }, { routeNow: false });
		await inbox.route(b.id);
		expect(await rows('select status, end_reason from runs where agent_id = $1', [b.id])).toEqual([
			{ status: 'error', end_reason: 'El proxy rechazó la API key.' },
		]);
		expect(inbox.retryOf(b.id)).toBeNull();
	} finally {
		status = 200;
		inbox.routerClock.now = () => Date.now();
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
		// Its queued run makes it «live» (working or waiting).
		expect(await conversations(a.id)).toEqual([{ ...first[0], runs: 1, last_at: expect.any(Number), live: true }]);
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
run('WhatsApp: numbers, lists, and one group per (owner of agents, person) where they talk', async () => {
	const whatsapp = await import('./whatsapp'),
		agents = await import('./agents');
	const mk = async (name: string, admin = false) => ({
		id: (await row<{ id: number }>("insert into people (name, key, avatar_seed) values ($1, $2, 's') returning id", [
			name,
			`${name.toLowerCase()}-wa-${Date.now()}`,
		]))!.id,
		name,
		avatar_seed: 's',
		admin,
	});
	const ana = await mk('Ana'),
		beto = await mk('Beto'),
		admin = await mk('Admin', true);
	waSent.length = 0;
	expect(whatsapp.enabled()).toBe(true);
	expect(whatsapp.checkSecret('wa-test')).toBe(true);
	expect(whatsapp.checkSecret('otro')).toBe(false);

	// Ana links her number: QR while pairing, linked once the phone scans it (the page or the event).
	const started = await whatsapp.add(ana, { alias: 'Mi número' });
	expect(started).toMatchObject({ state: 'pairing', qr: 'UVI=' });
	const jid = waScan(started.id, '5214441110000');
	expect(await whatsapp.pairing(ana, started.id)).toMatchObject({
		state: 'linked',
		number: { phone: '5214441110000' },
	});
	expect(await whatsapp.event({ type: 'linked', ref: String(started.id), jid, phone: '5214441110000' })).toEqual({
		ok: true,
	});
	// Only an admin offers public and private numbers; a public one needs an alias.
	await expect(whatsapp.add(ana, { scope: 'public', alias: 'Todos' })).rejects.toThrow('Sólo un admin');
	await expect(whatsapp.add(admin, { scope: 'public' })).rejects.toThrow('alias');
	const pub = await whatsapp.add(admin, { scope: 'public', alias: 'Compras Cuby' });
	waScan(pub.id, '5214442220000');
	await whatsapp.pairing(admin, pub.id);
	const priv = await whatsapp.add(admin, { scope: 'private', alias: 'Interno' });
	waScan(priv.id, '5214443330000');
	await whatsapp.pairing(admin, priv.id);
	// Somebody else's number is refused (and unlinked from the bridge).
	const steal = await whatsapp.add(beto, {});
	const stolen = waScan(steal.id, '5214441110000');
	expect(await whatsapp.pairing(beto, steal.id)).toMatchObject({
		state: 'failed',
		error: expect.stringContaining('otra persona'),
	});
	expect(waUnlinked).toContain(stolen);

	// Who sees what: personal → its owner; public → everyone; private → admins.
	const seen = async (p: typeof ana) => (await whatsapp.numbers(p)).numbers.map((n) => n.label).sort();
	expect(await seen(ana)).toEqual(['Compras Cuby', 'Mi número']);
	expect(await seen(beto)).toEqual(['Compras Cuby']);
	expect(await seen(admin)).toEqual(['Compras Cuby', 'Interno']);
	await expect(whatsapp.update(beto, pub.id, { alias: 'Mío' })).rejects.toThrow('no lo administras');
	// Who added a public number does not keep it once their admin session ends.
	await expect(whatsapp.update({ ...admin, admin: false }, pub.id, { alias: 'Mío' })).rejects.toThrow(
		'no lo administras',
	);

	// The groups live on one number an admin marks (public or private); nobody else picks it.
	await expect(whatsapp.update(ana, started.id, { groups: true })).rejects.toThrow('Sólo un admin');
	await whatsapp.update(admin, pub.id, { groups: true });
	expect((await whatsapp.groupNumber())?.id).toBe(pub.id);

	// Agents of Ana's (Compras, Radar) and of Beto's (Ajeno); Compras is shared with Beto.
	const compras = await agents.create(ana.id, { name: 'Compras', model: 'openai/gpt-6-sol' });
	const radar = await agents.create(ana.id, { name: 'Radar', model: 'openai/gpt-6-sol' });
	const ajeno = await agents.create(beto.id, { name: 'Ajeno', model: 'openai/gpt-6-sol' });
	await exec('insert into agent_shares (agent_id, person_id) values ($1, $2)', [compras.id, beto.id]);

	// Who may write is the number's lists: a phone in neither is ignored, the block list refused.
	const pubJid = [...waLinked.keys()].find((j) => j.startsWith('5214442220000'))!;
	const msg = (phone: string, text: string, extra: Record<string, unknown> = {}) =>
		whatsapp.event({ type: 'message', number: pubJid, id: `m-${Math.random()}`, phone, name: 'X', text, ...extra });
	await expect(whatsapp.lists(beto, pub.id)).rejects.toThrow('no lo administras');
	await expect(
		whatsapp.setLists(admin, pub.id, { allow: [{ phone: '+52 444 555 6666' }], block: [{ phone: '524445556666' }] }),
	).rejects.toThrow('repetido');
	await expect(whatsapp.setLists(admin, pub.id, { allow: [{ phone: '123' }] })).rejects.toThrow(
		'no es un número válido',
	);
	await expect(whatsapp.setLists(admin, pub.id, { allow: [{ phone: '+52 444 222 0000' }] })).rejects.toThrow(
		'es este mismo número',
	);
	const saved = await whatsapp.setLists(admin, pub.id, {
		allow: [
			{ phone: '+52 444 111 2222', personId: ana.id },
			{ phone: '+52 444 555 6666', personId: beto.id },
			{ phone: '+52 444 777 8888', label: 'Invitada' },
		],
		block: [{ phone: '+52 444 999 0000', label: 'Spam', personId: beto.id }],
	});
	expect(saved.block).toEqual([{ phone: '524449990000', label: 'Spam' }]); // no person on a blocked phone

	// One group per (owner, person) with at least one agent: Ana with hers, Beto with Ana's shared one and
	// Beto with his own. The guest has none until Ana switches her on.
	await whatsapp.syncGroups();
	const made = () => waGroups.filter((g) => g.jid === pubJid).map((g) => [g.name, g.phones[0]]);
	expect(made().sort()).toEqual([
		['Agentes Ana', '524441112222'],
		['Agentes Ana', '524445556666'],
		['Agentes Beto', '524445556666'],
	]);
	const groupOf = async (owner: number, phone: string) =>
		(await row<{ id: number; ref: string; status: string }>(
			'select id, ref, status from whatsapp_groups where number_id = $1 and owner_id = $2 and phone = $3',
			[pub.id, owner, phone],
		))!;
	const anaGroup = await groupOf(ana.id, '524441112222'),
		betoInAna = await groupOf(ana.id, '524445556666');
	expect(waSent.find((m) => m.group === anaGroup.ref)?.text).toContain(
		'Aquí hablas con tus agentes:\n1. Compras\n2. Radar',
	);
	expect(waSent.find((m) => m.group === betoInAna.ref)?.text).toContain('los agentes de Ana:\n1. Compras');
	const contacts = (await whatsapp.agentView(compras.id, ana)).contacts;
	expect(contacts.map((c) => [c.name, c.kind, c.enabled])).toEqual([
		['Ana', 'owner', true],
		['Beto', 'person', true],
		['Invitada', 'guest', false],
	]);
	expect(JSON.stringify(contacts)).not.toContain('"phone"'); // only the opaque key leaves the server

	// The bridge takes a group's messages only from its member; one to one, only «where are my agents».
	expect(await whatsapp.allowed({ number: pubJid, phone: '5214445556666', group: betoInAna.ref })).toEqual({
		allowed: true,
	});
	expect(await whatsapp.allowed({ number: pubJid, phone: '5214441112222', group: betoInAna.ref })).toEqual({
		allowed: false,
	});
	expect(await whatsapp.allowed({ number: pubJid, phone: '5214445556666', text: 'Hola' })).toEqual({ allowed: false });
	expect(await whatsapp.allowed({ number: pubJid, phone: '5214445556666', text: '/agentes' })).toEqual({
		allowed: true,
	});
	expect(await msg('5214445556666', '/agentes')).toEqual({ command: true });
	expect(waSent.at(-1)).toMatchObject({ phone: '5214445556666', text: expect.stringContaining('grupos «Agentes …»') });
	expect(await msg('5214449990000', 'Hola')).toEqual({ ignored: true });

	// In Beto's group with Ana's agents there is one (Compras): his message is a task of his for it.
	const inBeto = (text: string, extra: Record<string, unknown> = {}) =>
		msg('5214445556666', text, { group: betoInAna.ref, ...extra }) as Promise<{ message_id: number }>;
	const task = await inBeto('Revisa el súper');
	expect(
		await row("select agent_id, person_id, sender, context->'whatsapp'->>'group' as grp from messages where id = $1", [
			task.message_id,
		]),
	).toEqual({
		agent_id: compras.id,
		person_id: beto.id,
		sender: 'Beto (+524445556666), con quien tu dueño compartió este agente (no es tu dueño)',
		grp: String(betoInAna.id),
	});
	// The answer goes back into that group, under the agent's name.
	const runId = (await row<{ id: number }>(
		`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status, answer)
		 values ($1, $2, (select conversation_id from messages where id = $3), $4, 'openai/gpt-6-sol', 'done', 'Listo, ya está.') returning id`,
		[compras.id, ana.id, task.message_id, `wa-run-${compras.id}`],
	))!.id;
	await exec('update messages set run_id = $2 where id = $1', [task.message_id, runId]);
	waSent.length = 0;
	await whatsapp.onRun(runId, 'done');
	expect(waSent).toEqual([{ jid: pubJid, group: betoInAna.ref, text: '*Compras:* Listo, ya está.', files: [] }]);
	// Stuck on a page: the picture of its browser goes too; the link to take control is only for its owner.
	waSent.length = 0;
	await whatsapp.onRun(runId, 'blocked', 'No carga el sitio.', { jpeg: 'AAAA', url: 'https://super.mx' });
	expect(waSent[0].text).toContain('*Compras:* No carga el sitio.');
	expect(waSent[0].text).not.toContain('/browser');
	expect(waSent[0].files).toEqual([{ name: 'pantalla.jpg', mime: 'image/jpeg', data: 'AAAA' }]);
	// While it works on his message, «escribiendo…» stays in that group.
	await exec("update runs set status = 'running' where id = $1", [runId]);
	waTyping.length = 0;
	await whatsapp.keepTyping();
	expect(waTyping).toEqual([{ jid: pubJid, group: betoInAna.ref }]);
	await exec("update runs set status = 'done' where id = $1", [runId]);

	// In Ana's group there are two: with nobody spoken to yet, it asks which; the message waits for the answer.
	const inAna = (text: string, extra: Record<string, unknown> = {}) =>
		msg('5214441112222', text, { group: anaGroup.ref, ...extra }) as Promise<Record<string, any>>;
	expect(await inAna('Hola, ¿qué hay de nuevo?')).toEqual({ needsAgent: true });
	expect(waSent.at(-1)?.text).toContain('¿Para qué agente es?\n1. Compras\n2. Radar');
	const toRadar = await inAna('2');
	expect(await row('select agent_id, text from messages where id = $1', [toRadar.message_id])).toEqual({
		agent_id: radar.id,
		text: 'Hola, ¿qué hay de nuevo?',
	});
	// The last one spoken to gets the next one; a name first switches (and is taken off the message).
	expect(
		(await row<{ agent_id: number }>('select agent_id from messages where id = $1', [
			(await inAna('¿Y el clima?')).message_id,
		]))!.agent_id,
	).toBe(radar.id);
	const named = await inAna('Compras: el precio del huevo');
	expect(await row('select agent_id, text from messages where id = $1', [named.message_id])).toEqual({
		agent_id: compras.id,
		text: 'el precio del huevo',
	});
	expect(
		(await row<{ agent_id: number }>('select agent_id from messages where id = $1', [
			(await inAna('y del aceite')).message_id,
		]))!.agent_id,
	).toBe(compras.id);

	// A notice of Radar's to its owner, from a scheduled run: quoting it goes back to Radar, in that run's
	// conversation (where it has what it asked), whoever was spoken to last.
	await exec('update agents set role = $2 where id = $1', [
		radar.id,
		'# Radar\n\n## Avisos por WhatsApp\nAvisa a tu dueño.',
	]);
	const noon = new Date('2026-11-02T18:00:00Z'),
		night = new Date('2026-11-03T05:00:00Z');
	const radarRun = (await row<{ id: number; conversation_id: number }>(
		`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status)
		 values ($1, $2, (select id from conversations where agent_id = $1 and is_default), $3, 'openai/gpt-6-sol', 'running') returning id, conversation_id`,
		[radar.id, ana.id, `wa-radar-${radar.id}`],
	))!;
	// At night it is not refused: it waits for 7:00 and goes out by itself, checked again then.
	const nightRun = (await row<{ id: number }>(
		`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status)
		 values ($1, $2, $3, $4, 'openai/gpt-6-sol', 'done') returning id`,
		[radar.id, ana.id, radarRun.conversation_id, `wa-radar-night-${radar.id}`],
	))!;
	const held = await whatsapp.notify(nightRun.id, { to: ['dueño'], text: 'Hay novedades' }, night);
	// Its line first: toMatchObject below swaps programado for its matcher.
	const heldLine = whatsapp.noticeLine(held);
	expect(held).toMatchObject({ ok: true, programado: expect.stringContaining('7:00') });
	expect(heldLine).toMatch(/^Programó el aviso por WhatsApp para el .*7:00.*: es horario de silencio\.$/);
	expect(whatsapp.quietUntil(night)!.toISOString()).toBe('2026-11-03T13:00:00.000Z');
	expect(whatsapp.quietUntil(noon)).toBeNull();
	waSent.length = 0;
	expect(await whatsapp.sendDeferred(new Date('2026-11-03T12:59:00Z'))).toBe(0);
	expect(await whatsapp.sendDeferred(new Date('2026-11-03T13:00:00Z'))).toBe(1);
	expect(waSent.map((m) => m.text)).toEqual(['*Radar:* Hay novedades']);
	expect(await whatsapp.sendDeferred(new Date('2026-11-03T13:05:00Z'))).toBe(0);
	// Urgent goes at once, even at night.
	expect(
		(await whatsapp.notify(nightRun.id, { to: ['dueño'], text: 'Urgente', urgent: true }, night)).enviado_a,
	).toEqual(['Ana']);
	expect((await whatsapp.notify(radarRun.id, { to: ['Nadie'], text: 'x' }, noon)).no_enviado).toEqual([
		{ para: 'Nadie', motivo: expect.stringContaining('no es un contacto habilitado') },
	]);
	waSent.length = 0;
	const notice = await whatsapp.notify(radarRun.id, { to: ['Ana'], text: '¿Sigo con el radar?' }, noon);
	expect(notice.enviado_a).toEqual(['Ana']);
	expect(waSent).toEqual([{ jid: pubJid, group: anaGroup.ref, text: '*Radar:* ¿Sigo con el radar?', files: [] }]);
	expect(whatsapp.noticeLine(notice)).toBe('Avisó por WhatsApp a Ana.');
	await exec("update runs set status = 'done' where id = $1", [radarRun.id]);
	const noticeId = `out-${waOut}`;
	await inAna('Compras: ¿y el azúcar?'); // somebody else spoken to meanwhile
	const quoted = await inAna('Sí, sigue por ahora', { quoted: noticeId });
	expect(await row('select agent_id, conversation_id from messages where id = $1', [quoted.message_id])).toEqual({
		agent_id: radar.id,
		conversation_id: radarRun.conversation_id,
	});
	// The agent is not told who it is with: /agente switches, /terminar closes its conversation here.
	expect(await inAna('/agente comp')).toEqual({ command: true, agent: compras.id });
	expect(waSent.at(-1)?.text).toBe('Ahora hablas con Compras.');
	expect(await inAna('/terminar')).toEqual({ command: true, ended: true });
	// /ayuda: the commands and who answers now (after /terminar, still Compras).
	expect(await inAna('/ayuda')).toEqual({ command: true });
	expect(waSent.at(-1)?.text).toContain('Ahora hablas con Compras.');
	expect(waSent.at(-1)?.text).toContain('/agente <nombre o número>');

	// Ana's own aliases: /alias puts one on the current agent; @alias or «alias: …» picks it, and the handle
	// (the name with dashes) works without any alias.
	expect(await inAna('/alias cp')).toEqual({ command: true });
	expect(waSent.at(-1)?.text).toBe('Listo: Compras también responde a @cp.');
	const viaAlias = await inAna('@cp ¿y la leche?');
	expect(await row('select agent_id, text from messages where id = $1', [viaAlias.message_id])).toEqual({
		agent_id: compras.id,
		text: '¿y la leche?',
	});
	const viaHandle = await inAna('@radar ¿novedades?');
	expect(
		(await row<{ agent_id: number }>('select agent_id from messages where id = $1', [viaHandle.message_id]))!.agent_id,
	).toBe(radar.id);
	expect(await inAna('/alias')).toEqual({ command: true });
	expect(waSent.at(-1)?.text).toContain('Compras: @compras, @cp');
	// An alias is one agent's: Radar cannot take «cp», nor Compras the handle of Radar.
	const aliases = await import('./aliases');
	await expect(aliases.set(ana, radar.id, ['cp'])).rejects.toThrow('ya es de Compras');
	await expect(aliases.set(ana, compras.id, ['radar'])).rejects.toThrow('ya es de Radar');
	await expect(aliases.set(beto, radar.id, ['r'])).rejects.toThrow('Sólo pones alias'); // not shared with Beto
	// They are personal: Beto's «cp» is his own (Compras is shared with him).
	expect(await aliases.set(beto, compras.id, ['CP', '@súper'])).toEqual(['cp', 'super']);
	// In the web, a message that starts with @mentions is for those agents.
	expect(await aliases.mentions(ana, '@cp @radar revisen el súper')).toEqual({
		agents: [expect.objectContaining({ id: compras.id }), expect.objectContaining({ id: radar.id })],
		text: 'revisen el súper',
	});
	await expect(aliases.mentions(ana, '@nadie hola')).rejects.toThrow('No tienes un agente @nadie');
	expect(await aliases.mentions(ana, 'hola @cp')).toBeNull(); // only at the start
	expect(await inAna('/alias quitar cp')).toEqual({ command: true });
	expect(waSent.at(-1)?.text).toBe('Quité @cp.');
	// /actual: who answers now, and whether its conversation here is open.
	expect(await inAna('/actual')).toEqual({ command: true });
	expect(waSent.at(-1)?.text).toMatch(/^Hablas con Radar, en una conversación abierta\. También le dices @radar\.$/);

	// A external (a guest marked as such): never a group; Radar writes to them one to one once Ana switches
	// them on, and their answer goes back to the conversation that asked, signed as an external contact's.
	await whatsapp.setLists(admin, pub.id, {
		allow: [
			{ phone: '+52 444 111 2222', personId: ana.id },
			{ phone: '+52 444 555 6666', personId: beto.id },
			{ phone: '+52 444 777 8888', label: 'Invitada' },
			{ phone: '+52 444 666 7777', label: 'Ferretería', external: true },
		],
		block: [{ phone: '+52 444 999 0000', label: 'Spam' }],
	});
	await whatsapp.syncGroups();
	expect(waGroups.some((g) => g.phones.includes('524446667777'))).toBe(false);
	const external = (await whatsapp.agentView(radar.id, ana)).contacts.find((c) => c.name === 'Ferretería')!;
	expect(external).toMatchObject({ kind: 'external', enabled: false });
	expect(
		(await whatsapp.notify(radarRun.id, { to: ['Ferretería'], text: '¿Precio del cemento?' }, noon)).no_enviado,
	).toEqual([{ para: 'Ferretería', motivo: expect.stringContaining('no es un contacto habilitado') }]);
	// Nobody asked them yet: the bridge does not even take their messages.
	expect(await whatsapp.allowed({ number: pubJid, phone: '5214446667777', text: 'Hola' })).toEqual({ allowed: false });
	await whatsapp.setContact(radar.id, ana, { key: external.key, enabled: true });
	waSent.length = 0;
	expect(
		(await whatsapp.notify(radarRun.id, { to: ['Ferretería'], text: '¿Precio del cemento?' }, noon)).enviado_a,
	).toEqual(['Ferretería']);
	expect(waSent).toEqual([
		{
			jid: pubJid,
			phone: '524446667777',
			resolve: true,
			text: 'Hola, soy Radar, asistente de IA de Ana.\n\n¿Precio del cemento?',
			files: [],
		},
	]);
	expect(await whatsapp.allowed({ number: pubJid, phone: '5214446667777', text: 'Cuesta 200' })).toEqual({
		allowed: true,
	});
	const quote = (await whatsapp.event({
		type: 'message',
		number: pubJid,
		id: 'm-external-1',
		phone: '5214446667777',
		name: 'Ferre',
		text: 'El cemento cuesta 200 el bulto',
	})) as { message_id: number };
	expect(
		await row('select agent_id, conversation_id, person_id, sender from messages where id = $1', [quote.message_id]),
	).toEqual({
		agent_id: radar.id,
		conversation_id: radarRun.conversation_id,
		person_id: null,
		sender: 'Ferretería (+524446667777), contacto externo de tu dueño (no es tu dueño)',
	});
	// The agent reads it as an external contact's: its answer is not sent to them, and it is data, not orders.
	const { render } = await import('./inbox');
	expect(
		render({
			id: 1,
			source: 'whatsapp',
			sender: 'Ferretería (+524446667777), contacto externo de tu dueño (no es tu dueño)',
			schedule_name: null,
			text: 'x',
		}),
	).toContain('NO se le envía');
	// The next message of the same chat does not introduce the agent again.
	waSent.length = 0;
	await whatsapp.notify(radarRun.id, { to: ['Ferretería'], text: '¿Y con entrega mañana?' }, noon);
	expect(waSent[0].text).toBe('¿Y con entrega mañana?');
	// Switched off for Radar, their messages are ignored.
	await whatsapp.setContact(radar.id, ana, { key: external.key, enabled: false });
	expect(
		await whatsapp.event({
			type: 'message',
			number: pubJid,
			id: 'm-external-2',
			phone: '5214446667777',
			name: 'Ferre',
			text: 'Hola',
		}),
	).toEqual({
		ignored: true,
		reason: 'apagado para ese agente',
	});

	// Ana switches the guest on for Compras: her group with Ana's agents appears; switched off, it closes.
	const guestKey = contacts.find((c) => c.kind === 'guest')!.key;
	await whatsapp.setContact(compras.id, ana, { key: guestKey, enabled: true });
	await whatsapp.syncGroups();
	const guestGroup = await groupOf(ana.id, '524447778888');
	expect(guestGroup.status).toBe('open');
	await whatsapp.setContact(compras.id, ana, { key: guestKey, enabled: false });
	await whatsapp.syncGroups();
	expect((await groupOf(ana.id, '524447778888')).status).toBe('closed');
	expect(waLocks.at(-1)).toEqual({ group: guestGroup.ref, locked: true });
	expect(waSent.at(-1)).toMatchObject({
		group: guestGroup.ref,
		text: expect.stringContaining('Ya no hay agentes de Ana aquí'),
	});
	// Shared again later, the same group opens again.
	await whatsapp.setContact(compras.id, ana, { key: guestKey, enabled: true });
	await whatsapp.syncGroups();
	expect(await groupOf(ana.id, '524447778888')).toMatchObject({ status: 'open', ref: guestGroup.ref });
	expect(waLocks.at(-1)).toEqual({ group: guestGroup.ref, locked: false });
	// A closed group takes nothing.
	expect(await whatsapp.allowed({ number: pubJid, phone: '5214445556666', group: 'g-999@g.us' })).toEqual({
		allowed: false,
	});
	void ajeno;

	// A photo for Ana's groups (a JPEG the browser made square): her open groups on this number get it,
	// once per version; removed, it is taken off them.
	await expect(whatsapp.setGroupPhoto(ana, { jpeg: Buffer.from('no es foto').toString('base64') })).rejects.toThrow(
		'JPEG',
	);
	const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]).toString('base64');
	expect(await whatsapp.setGroupPhoto(ana, { jpeg })).toMatchObject({
		photo: `data:image/jpeg;base64,${jpeg}`,
		updatesOpen: true,
		groups: 3,
	});
	await whatsapp.syncGroups();
	const anaGroups = [anaGroup.ref, betoInAna.ref, guestGroup.ref].sort();
	expect(waPhotos.map((p) => p.group).sort()).toEqual(anaGroups);
	expect(waPhotos.every((p) => p.photo === jpeg)).toBe(true);
	waPhotos.length = 0;
	await whatsapp.syncGroups();
	expect(waPhotos).toEqual([]);
	await whatsapp.setGroupPhoto(ana, null);
	await whatsapp.syncGroups();
	expect(waPhotos.map((p) => [p.group, p.photo]).sort()).toEqual(anaGroups.map((g) => [g, '']));

	// A direct guest: never a group; they talk one to one with the single agent switched on for them, and
	// its answers, notices and /terminar go in that chat.
	const lists = (extra: Record<string, unknown>) =>
		whatsapp.setLists(admin, pub.id, {
			allow: [
				{ phone: '+52 444 111 2222', personId: ana.id },
				{ phone: '+52 444 555 6666', personId: beto.id },
				{ phone: '+52 444 777 8888', label: 'Invitada' },
				{ phone: '+52 444 666 7777', label: 'Ferretería', external: true },
				{ phone: '+52 444 333 4444', label: 'Cliente', ...extra },
			],
			block: [{ phone: '+52 444 999 0000', label: 'Spam' }],
		});
	await lists({ direct: true });
	await whatsapp.syncGroups();
	expect(waGroups.some((g) => g.phones.includes('524443334444'))).toBe(false);
	const client = (await whatsapp.agentView(radar.id, ana)).contacts.find((c) => c.name === 'Cliente')!;
	expect(client).toMatchObject({ kind: 'direct', enabled: false });
	const fromClient = (id: string, text: string) =>
		whatsapp.event({ type: 'message', number: pubJid, id, phone: '5214443334444', name: 'C', text });
	// Switched on for nobody: the bridge does not take their messages.
	expect(await whatsapp.allowed({ number: pubJid, phone: '5214443334444', text: 'Hola' })).toEqual({ allowed: false });
	expect(await fromClient('m-direct-0', 'Hola')).toEqual({ ignored: true, reason: 'sin agente' });
	await whatsapp.setContact(radar.id, ana, { key: client.key, enabled: true });
	// One agent only.
	await expect(whatsapp.setContact(compras.id, ana, { key: client.key, enabled: true })).rejects.toThrow('«Radar»');
	expect(await whatsapp.allowed({ number: pubJid, phone: '5214443334444', text: 'Hola' })).toEqual({ allowed: true });
	const asked = (await fromClient('m-direct-1', '¿Tienen envío a Monterrey?')) as { message_id: number };
	const first = (await row<{ agent_id: number; person_id: number | null; sender: string; conversation_id: number }>(
		'select agent_id, person_id, sender, conversation_id from messages where id = $1',
		[asked.message_id],
	))!;
	expect(first).toMatchObject({
		agent_id: radar.id,
		person_id: null,
		sender: 'Cliente (+524443334444), invitado de tu dueño (no es tu dueño)',
	});
	expect(first.conversation_id).not.toBe(radarRun.conversation_id);
	// The answer goes back to their phone, under the agent's name.
	const clientRun = (await row<{ id: number }>(
		`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status, answer)
		 values ($1, $2, $3, $4, 'openai/gpt-6-sol', 'done', 'Sí, llega en 3 días.') returning id`,
		[radar.id, ana.id, first.conversation_id, `wa-direct-${radar.id}`],
	))!.id;
	await exec('update messages set run_id = $2 where id = $1', [asked.message_id, clientRun]);
	waSent.length = 0;
	await whatsapp.onRun(clientRun, 'done');
	expect(waSent).toEqual([
		{ jid: pubJid, phone: '524443334444', resolve: true, text: '*Radar:* Sí, llega en 3 días.', files: [] },
	]);
	// A notice from another conversation (a schedule's): their reply carries what it said, in their chat.
	const scheduled = (await row<{ id: number }>(
		`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status)
		 values ($1, $2, $3, $4, 'openai/gpt-6-sol', 'done') returning id`,
		[radar.id, ana.id, radarRun.conversation_id, `wa-direct-notice-${radar.id}`],
	))!.id;
	waSent.length = 0;
	expect((await whatsapp.notify(scheduled, { to: ['Cliente'], text: 'Ya salió tu pedido' }, noon)).enviado_a).toEqual([
		'Cliente',
	]);
	expect(waSent).toMatchObject([{ phone: '524443334444', text: '*Radar:* Ya salió tu pedido' }]);
	const thanks = (await fromClient('m-direct-2', 'Gracias')) as { message_id: number };
	expect(await row('select conversation_id, text from messages where id = $1', [thanks.message_id])).toEqual({
		conversation_id: first.conversation_id,
		text: '(En respuesta a tu mensaje: «Ya salió tu pedido»)\n\nGracias',
	});
	// /terminar closes their conversation; the next message opens another.
	waSent.length = 0;
	expect(await fromClient('m-direct-3', '/terminar')).toEqual({ command: true, ended: true });
	expect(waSent.at(-1)).toMatchObject({
		phone: '524443334444',
		text: '*Radar:* Terminé nuestra conversación; la próxima empieza de cero.',
	});
	const again = (await fromClient('m-direct-4', 'Otra pregunta')) as { message_id: number };
	expect(
		(await row<{ conversation_id: number }>('select conversation_id from messages where id = $1', [again.message_id]))!
			.conversation_id,
	).not.toBe(first.conversation_id);
	// A guest switched on for two agents cannot become direct.
	await lists({});
	await whatsapp.setContact(compras.id, ana, { key: client.key, enabled: true });
	await expect(lists({ direct: true })).rejects.toThrow('habla con uno solo');
	await whatsapp.setContact(compras.id, ana, { key: client.key, enabled: false });
	await lists({ direct: true });

	// Encargos: Radar delegates a job to the ferretería (an external contact). The platform talks to them
	// with its own context and no agent's name; their messages go to it; a question comes back at once; the
	// results of the work's encargos come back together.
	const delegations = await import('./delegations');
	const { validateHarness } = await import('../../sandbox/harness');
	const { defaultHarness } = await import('./harnesses');
	const template = {
		name: 'cotizar',
		description: 'Cotiza con un contacto externo.',
		objective: 'Cotiza {lista} con entrega el {fecha}.',
		intro: 'Buen día, le escribo de parte de Ana.',
		rules: ['No aceptes anticipos sin preguntar.'],
		collect: {
			list: true,
			fields: [
				{ name: 'producto', description: 'Qué', type: 'text' },
				{ name: 'precio', description: 'Por bulto, en pesos', type: 'number' },
			],
		},
		escalate: ['Si pide anticipo.'],
		files: true,
		maxMessages: 5,
		maxHours: 48,
	};
	await exec('update agents set harness = $2 where id = $1', [
		radar.id,
		JSON.stringify(
			validateHarness({
				...defaultHarness(),
				tools: [...defaultHarness().tools, 'delegations'],
				delegations: [template, { ...template, name: 'avisar', files: false }],
			}),
		),
	]);
	const ferreKey = (await whatsapp.agentView(radar.id, ana)).contacts.find((c) => c.name === 'Ferretería')!.key;
	await whatsapp.setContact(radar.id, ana, { key: ferreKey, enabled: true });
	// The model, scripted per contact: what each turn decides, and what it was told.
	type Turn = Awaited<ReturnType<typeof delegations.model.ask>>['value'];
	const script: Record<string, Turn[]> = {};
	const told: { instructions: string; transcript: string }[] = [];
	const realAsk = delegations.model.ask;
	delegations.model.ask = async (_p, _m, instructions, transcript) => {
		told.push({ instructions, transcript });
		const who = Object.keys(script).find((name) => instructions.includes(`con ${name} de parte`))!;
		return { value: script[who].shift()!, tokens: 100 };
	};
	delegations.clock.now = () => noon;
	const job = (await row<{ id: number; conversation_id: number }>(
		`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status)
		 values ($1, $2, $3, $4, 'openai/gpt-6-sol', 'running') returning id, conversation_id`,
		[radar.id, ana.id, radarRun.conversation_id, `wa-delegation-${radar.id}`],
	))!;
	const params = { lista: '10 bultos de cemento', fecha: 'lunes' };
	expect((await delegations.start(job.id, { plantilla: 'otra', contacto: 'Ferretería' })).error).toContain('cotizar');
	expect((await delegations.start(job.id, { plantilla: 'cotizar', contacto: 'Ferretería' })).error).toContain(
		'lista, fecha',
	);
	expect(
		(await delegations.start(job.id, { plantilla: 'cotizar', contacto: 'Nadie', parametros: params })).error,
	).toContain('no es un contacto encendido');
	expect(
		(await delegations.start(job.id, { plantilla: 'cotizar', contacto: 'Ana', parametros: params })).error,
	).toContain('contacto externo');
	waSent.length = 0;
	script['Ferretería'] = [
		{
			message: 'Buen día, le escribo de parte de Ana. ¿Me cotiza 10 bultos de cemento para el lunes?',
			data: [],
			status: 'continue',
			question: null,
			summary: 'Pedí precio.',
		},
	];
	// The agent tells it about its work and gives it the order to send; a template without files refuses them.
	const order = { name: 'pedido.pdf', data: Buffer.from('%PDF-1.4 pedido').toString('base64') };
	expect(
		(
			await delegations.start(job.id, {
				plantilla: 'avisar',
				contacto: 'Ferretería',
				parametros: params,
				files: [order],
			})
		).error,
	).toContain('no manda archivos');
	script['Ferretería'][0].attach = ['pedido.pdf', 'otro.pdf'];
	const a1 = await delegations.start(job.id, {
		plantilla: 'cotizar',
		contacto: 'Ferretería',
		parametros: params,
		contexto: 'En el HEB el bulto está a 210.',
		files: [order],
	});
	expect(a1).toMatchObject({ ok: true, contacto: 'Ferretería', archivos: ['pedido.pdf'] });
	await delegations.idle(a1.id as number);
	expect(told[0].instructions).toContain('Cotiza 10 bultos de cemento con entrega el lunes.');
	expect(told[0].instructions).toContain('En el HEB el bulto está a 210.');
	expect(told[0].instructions).toContain('Puedes mandarle estos archivos: pedido.pdf');
	// As it is: no agent's name, nothing added.
	expect(waSent).toEqual([
		{
			jid: pubJid,
			phone: '524446667777',
			resolve: true,
			text: 'Buen día, le escribo de parte de Ana. ¿Me cotiza 10 bultos de cemento para el lunes?',
			// Only the agent's file; a name it made up is dropped.
			files: [{ name: 'pedido.pdf', mime: 'application/pdf', data: order.data }],
		},
	]);
	// One active encargo per contact; and no notices to them meanwhile.
	expect(
		(await delegations.start(job.id, { plantilla: 'cotizar', contacto: 'Ferretería', parametros: params })).error,
	).toContain('ya tiene un encargo activo');
	expect((await whatsapp.notify(job.id, { to: ['Ferretería'], text: 'Hola' }, noon)).no_enviado).toEqual([
		{ para: 'Ferretería', motivo: expect.stringContaining('encargo activo') },
	]);
	// Anything they write is for the encargo, even with nobody having asked lately.
	expect(await whatsapp.allowed({ number: pubJid, phone: '5214446667777', text: 'Buenas' })).toEqual({ allowed: true });
	script['Ferretería'].push({
		message: 'Déjeme confirmarlo y le aviso.',
		data: [{ producto: 'cemento', precio: 200 }],
		status: 'escalate',
		question: 'Pide 50 % de anticipo, ¿lo acepto?',
		summary: 'Cotizó a 200 y pide anticipo.',
	});
	waSent.length = 0;
	expect(
		await whatsapp.event({
			type: 'message',
			number: pubJid,
			id: 'm-delegation-1',
			phone: '5214446667777',
			name: 'Ferre',
			text: 'A 200 el bulto, con 50 % de anticipo',
		}),
	).toEqual({ delegation: a1.id, duplicate: false });
	await delegations.idle(a1.id as number);
	expect(told[1].transcript).toContain('Ferretería: A 200 el bulto, con 50 % de anticipo');
	expect(waSent.map((m) => m.text)).toEqual(['Déjeme confirmarlo y le aviso.']);
	// Its question reaches the conversation that started it, at once.
	const question = await row<{ text: string; conversation_id: number }>(
		"select text, conversation_id from messages where agent_id = $1 and source = 'delegation' order by id desc limit 1",
		[radar.id],
	);
	expect(question).toMatchObject({
		conversation_id: job.conversation_id,
		text: expect.stringContaining('te pregunta: Pide 50 %'),
	});
	// A second encargo of the same work, with the direct guest: the results wait for both.
	script['Cliente'] = [
		{
			message: 'Buen día, ¿le confirmo la entrega del lunes?',
			data: [],
			status: 'continue',
			question: null,
			summary: 'Pregunté.',
		},
	];
	const a2 = await delegations.start(job.id, { plantilla: 'cotizar', contacto: 'Cliente', parametros: params });
	await delegations.idle(a2.id as number);
	// The agent answers the question; the encargo goes on with it and ends.
	script['Ferretería'].push({
		message: 'Sin anticipo no podemos esta vez, gracias por la cotización.',
		data: [{ producto: 'cemento', precio: 200 }],
		status: 'done',
		question: null,
		summary: 'Cotizó cemento a 200 el bulto; no aceptamos anticipo.',
	});
	expect(await delegations.message(job.id, { id: a1.id, texto: 'No aceptes anticipo.' })).toMatchObject({ ok: true });
	await delegations.idle(a1.id as number);
	expect(told.at(-1)!.transcript).toContain('[Instrucción de quien te mandó: No aceptes anticipo.]');
	expect((await delegations.status(job.id, { id: a1.id })).encargos).toMatchObject([
		{ estado: 'done', datos: [{ producto: 'cemento', precio: 200 }] },
	]);
	const results = () =>
		rows<{ text: string }>(
			"select text from messages where agent_id = $1 and source = 'delegation' and text like 'Encargo #%' order by id",
			[radar.id],
		);
	expect(await results()).toEqual([]); // the other one is still active
	expect(await delegations.cancel(job.id, { id: a2.id })).toMatchObject({ ok: true });
	const [together] = await results();
	expect(together.text).toContain(`Encargo #${a1.id} · cotizar · con Ferretería · terminado`);
	expect(together.text).toContain('"precio":200');
	expect(together.text).toContain(`Encargo #${a2.id} · cotizar · con Cliente · cancelado`);
	// After it ended, what the ferretería writes is no longer the encargo's (it goes as before it).
	expect(
		await whatsapp.event({
			type: 'message',
			number: pubJid,
			id: 'm-delegation-2',
			phone: '5214446667777',
			name: 'F',
			text: '¿Entonces?',
		}),
	).not.toHaveProperty('delegation');
	// At night it does not open a chat: the first message waits for the morning.
	delegations.clock.now = () => night;
	waSent.length = 0;
	const late = await delegations.start(job.id, { plantilla: 'cotizar', contacto: 'Ferretería', parametros: params });
	expect(late.aviso).toContain('7:00');
	await delegations.idle(late.id as number);
	expect(waSent).toEqual([]);
	await delegations.cancel(job.id, { id: late.id });
	// A new encargo with someone it already talked to picks up from there: no introduction again, and it knows
	// what was said and obtained (the one that never wrote does not count).
	delegations.clock.now = () => noon;
	script['Ferretería'].push({
		message: '¿El precio de 200 sigue en pie?',
		data: null,
		status: 'continue',
		question: null,
		summary: 'Preguntó.',
		attach: [],
	});
	const resume = await delegations.start(job.id, { plantilla: 'cotizar', contacto: 'Ferretería', parametros: params });
	await delegations.idle(resume.id as number);
	const resumed = told.at(-1)!.instructions;
	expect(resumed).toContain('Ya platicaste antes con Ferretería por este mismo chat');
	expect(resumed).not.toContain('El primer mensaje empieza con esta presentación');
	expect(resumed).toContain('## Lo que ya platicaron');
	expect(resumed).toContain('"precio":200');
	expect(resumed).toContain('Tú: Buen día, le escribo de parte de Ana. ¿Me cotiza 10 bultos de cemento para el lunes?');
	expect(told[0].instructions).toContain('El primer mensaje empieza con esta presentación');
	await delegations.cancel(job.id, { id: resume.id });

	// Tareas from a recipe: in its own trabajo, the recipe preloads the list. The platform launches its
	// encargo with the list's parameters, the agent does its tasks and adjusts the list (saying why), the
	// owner is asked by their group and answers in the web, and the agent hands in the result in the
	// recipe's shape; the saga has all of it.
	const flows = await import('./flows');
	const jobsMod = await import('./jobs');
	const step = (key: string, kind: string, depends: string[], extra: Record<string, unknown> = {}) => ({
		key,
		title: key,
		kind,
		depends,
		instructions: kind === 'delegation' ? '' : `Haz ${key}.`,
		optional: false,
		hours: null,
		delegation: null,
		...extra,
	});
	const recipe = {
		name: 'carrito',
		description: 'El carrito de la semana.',
		objective: 'Arma el carrito de la semana {semana}.',
		produces: {
			list: true,
			fields: [
				{ name: 'producto', description: 'Qué', type: 'text' },
				{ name: 'precio', description: 'Pesos', type: 'number' },
			],
		},
		steps: [
			step('heb', 'subagent', [], { instructions: 'Cotiza la lista en HEB.' }),
			step('carne', 'delegation', [], {
				delegation: {
					template: 'cotizar',
					contact: 'Ferretería',
					params: [
						{ name: 'lista', value: 'lo de la semana {semana}' },
						{ name: 'fecha', value: 'lunes' },
					],
				},
			}),
			step('armar', 'agent', ['heb', 'carne'], { instructions: 'Combina las cotizaciones.' }),
			step('confirmar', 'question', ['armar'], { instructions: '¿Compro el carrito?' }),
		],
		maxHours: 48,
		maxDelegations: 2,
		maxWakes: 10,
	};
	await exec('update agents set harness = $2 where id = $1', [
		radar.id,
		JSON.stringify(
			validateHarness({
				...defaultHarness(),
				tools: [...defaultHarness().tools, 'delegations', 'flows', 'subagents'],
				delegations: [template],
				flows: [recipe],
			}),
		),
	]);
	// A trabajo of its own, and a work in it (the Principal has no list).
	const trabajo = async (title: string) => {
		const conv = (await row<{ id: number }>(
			'insert into conversations (agent_id, pi_session_id, title, person_id) values ($1, gen_random_uuid()::text, $2, $3) returning id',
			[radar.id, title, ana.id],
		))!.id;
		const run = (await row<{ id: number }>(
			`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status)
			 values ($1, $2, $3, $4, 'openai/gpt-6-sol', 'done') returning id`,
			[radar.id, ana.id, conv, `tareas-${conv}`],
		))!.id;
		return { conv, run };
	};
	expect((await flows.plan(job.id, { receta: 'carrito', parametros: { semana: '46' } })).error).toContain('Principal');
	const cart = await trabajo('Carrito');
	delegations.clock.now = () => noon;
	script['Ferretería'] = [
		{
			message: 'Buen día, ¿me cotiza lo de la semana 46?',
			data: [{ producto: 'cemento', precio: 200 }],
			status: 'done',
			question: null,
			summary: 'Cemento a 200.',
			attach: [],
		},
	];
	expect((await flows.plan(cart.run, { receta: 'carrito' })).error).toContain('semana');
	const fr = await flows.plan(cart.run, {
		receta: 'carrito',
		parametros: { semana: '46' },
		titulo: 'Carrito semana 46',
	});
	// Its own task comes back right away (it is in its work); the encargo goes on its own.
	expect(fr).toMatchObject({ ok: true, trabajo: cart.conv, tareas_tuyas: [{ tarea: 'heb', tipo: 'subagent' }] });
	// The recipe states the trabajo's objective.
	expect((await jobsMod.get(cart.conv))!.goal).toBe('Arma el carrito de la semana 46.');
	expect((await flows.plan(cart.run, { receta: 'carrito', parametros: { semana: '47' } })).error).toContain(
		'ya tiene su lista',
	);
	const flowId = (await flows.tasksOf(radar.id, cart.conv)).list!.id;
	const carne = async () =>
		(await row<{ status: string; delegation_id: number | null; result: { datos: unknown } }>(
			"select status, delegation_id, result from flow_steps where flow_id = $1 and key = 'carne'",
			[flowId],
		))!;
	await delegations.idle((await carne()).delegation_id!);
	await flows.idle(flowId);
	expect(told.at(-1)!.instructions).toContain('Cotiza lo de la semana 46 con entrega el lunes.');
	expect(await carne()).toMatchObject({ status: 'done', result: { datos: [{ producto: 'cemento', precio: 200 }] } });
	// The agent registers its task; the next one is its.
	const u1 = await flows.update(cart.run, { tarea: 'heb', resultado: [{ producto: 'leche', precio: 25 }] });
	expect(u1.tareas_tuyas).toEqual([expect.objectContaining({ tarea: 'armar' })]);
	// It may adjust the list, always saying why, never undoing what is done, only with what its contract has.
	const extra = { key: 'revisar', titulo: 'Revisar precios', tipo: 'agent', depende: ['armar'] };
	expect((await flows.plan(cart.run, { agregar: [extra] })).error).toContain('motivo');
	expect((await flows.plan(cart.run, { motivo: 'x', quitar: ['heb'] })).error).toContain('terminó');
	expect(
		(
			await flows.plan(cart.run, {
				motivo: 'x',
				agregar: [
					{ key: 'otra', titulo: 'Otra', tipo: 'delegation', encargo: { plantilla: 'nope', contacto: 'Cliente' } },
				],
			})
		).error,
	).toContain('plantilla de encargo');
	expect(
		await flows.plan(cart.run, { motivo: 'Conviene revisar antes de preguntar.', agregar: [extra] }),
	).toMatchObject({ ok: true });
	expect(await flows.plan(cart.run, { motivo: 'Ya no hace falta.', quitar: ['revisar'] })).toMatchObject({ ok: true });
	// Done with its task, the question is its to write: short, with the report attached; then it reaches
	// its owner's group, as the agent wrote it (never the recipe's instructions), and waits.
	const u2 = await flows.update(cart.run, { tarea: 'armar', resultado: 'Carrito armado: leche y cemento.' });
	expect(u2.tareas_tuyas).toEqual([expect.objectContaining({ tarea: 'confirmar', tipo: 'question' })]);
	expect((await flows.ask(cart.run, { tarea: 'confirmar', pregunta: 'x'.repeat(700) })).error).toContain(
		'600 caracteres',
	);
	// Pagos simulados: a payment the browser stopped goes to the list's saga (for people, with what it would
	// have cost); nothing the agent reads says it was a simulation.
	const simulatedLine = await flows.simulated(cart.run, {
		action: 'click @e7',
		label: 'Completar pedido',
		total: '$1,385.38',
		order: '48213907',
		how: 'click',
	});
	expect(simulatedLine).toBe(
		'Pago simulado: «Completar pedido» por $1,385.38. No se cobró nada; el agente vio la confirmación del pedido #48213907 como si hubiera pagado.',
	);
	expect((await flows.detail(radar.id, flowId))!.events.at(-1)!.text).toBe(simulatedLine);
	expect(await flows.activeBlock(radar.id, cart.conv)).not.toMatch(/simula/i);
	waSent.length = 0;
	const report = { name: 'reporte.pdf', data: Buffer.from('%PDF-1.4 reporte').toString('base64') };
	expect(
		await flows.ask(cart.run, {
			tarea: 'confirmar',
			pregunta: '¿Compro el carrito? Son leche y cemento por $225; el detalle va en el PDF.',
			files: [report],
		}),
	).toMatchObject({ ok: true, tarea: 'confirmar', archivos: ['reporte.pdf'] });
	await flows.idle(flowId);
	const toOwner = waSent.filter((m) => m.group === anaGroup.ref);
	expect(toOwner.map((m) => m.text)).toEqual([
		'*Radar:* ¿Compro el carrito? Son leche y cemento por $225; el detalle va en el PDF.',
	]);
	expect(toOwner[0].files).toEqual([{ name: 'reporte.pdf', mime: 'application/pdf', data: report.data }]);
	// Its work in this trabajo starts with the whole list; any other, with it in short.
	const here = await flows.activeBlock(radar.id, cart.conv);
	expect(here).toContain('## Tus tareas');
	expect(here).toContain(`Tareas del trabajo #${cart.conv} (receta carrito) · 3 de 4`);
	expect(here).toContain('Espera a: tu respuesta');
	expect(await flows.activeBlock(radar.id, radarRun.conversation_id)).toContain(
		`- Trabajo #${cart.conv} · Carrito semana 46 (receta carrito): 3 de 4; espera a tu respuesta.`,
	);
	// The owner answers in the web: it becomes a fact, and the agent is woken to hand in the result.
	await flows.answer(radar.id, flowId, 'confirmar', 'Sí, cómpralo');
	await flows.idle(flowId);
	const lastWake = async () =>
		(await row<{ text: string; conversation_id: number }>(
			"select text, conversation_id from messages where agent_id = $1 and source = 'flow' order by id desc limit 1",
			[radar.id],
		))!;
	const wakeText = (await lastWake()).text;
	expect(wakeText).toContain('entrega el resultado con task_update sin tarea');
	expect(wakeText).toContain(
		'¿Compro el carrito? Son leche y cemento por $225; el detalle va en el PDF. → Sí, cómpralo',
	);
	// The trabajo does not end with its result still to hand in.
	expect((await jobsMod.done(cart.run, { resumen: 'Listo.' })).error).toContain('resultado de la receta');
	// The result has the recipe's shape, or it is refused.
	expect((await flows.update(cart.run, { resultado: [{ producto: 'leche' }] })).error).toContain('precio');
	waSent.length = 0;
	expect(
		await flows.update(cart.run, {
			resultado: [
				{ producto: 'leche', precio: 25 },
				{ producto: 'cemento', precio: 200 },
			],
			nota: 'Carrito listo.',
		}),
	).toMatchObject({ ok: true, terminado: true });
	expect((await row<{ status: string }>('select status from flows where id = $1', [flowId]))!.status).toBe('done');
	// Done, its agent tells it: the platform adds no note of its own (only when a recipe does not finish).
	expect(waSent.some((m) => m.group === anaGroup.ref && /receta/.test(m.text))).toBe(false);
	// The saga: every task, the encargo's messages, the change with its reason, the question, the end.
	const sagaKinds = (await flows.detail(radar.id, flowId))!.events.map((e) => e.kind);
	for (const k of ['started', 'delegation', 'message', 'step', 'planned', 'question', 'answer', 'wake', 'ended'])
		expect(sagaKinds).toContain(k);
	expect((await flows.detail(radar.id, flowId))!.events.find((e) => e.kind === 'planned')!.text).toContain(
		'Conviene revisar antes de preguntar.',
	);

	// A free list: the agent writes it for a trabajo of several steps; its tasks are its one at a time.
	const trip = await trabajo('Viaje');
	const free = await flows.plan(trip.run, {
		agregar: [
			{ key: 'vuelos', titulo: 'Cotizar vuelos' },
			{ key: 'hotel', titulo: 'Cotizar hotel' },
			{ key: 'visto-bueno', titulo: 'Visto bueno de Ana', tipo: 'wait', persona: 'Ana', depende: ['vuelos', 'hotel'] },
			{ key: 'reservar', titulo: 'Reservar', depende: ['visto-bueno'] },
		],
	});
	expect(free).toMatchObject({ ok: true, tareas_tuyas: [{ tarea: 'vuelos' }] });
	expect((await flows.tasksOf(radar.id, trip.conv)).list!.recipe).toBeNull();
	// Up to 12 tasks.
	expect(
		(
			await flows.plan(trip.run, {
				motivo: 'Muchas.',
				agregar: Array.from({ length: 9 }, (_, i) => ({ key: `extra-${i}`, titulo: `Extra ${i}` })),
			})
		).error,
	).toContain('hasta 12 tareas');
	// Blocked, with its reason: the next one is its meanwhile.
	expect((await flows.update(trip.run, { tarea: 'vuelos', estado: 'blocked' })).error).toContain('nota');
	expect(
		await flows.update(trip.run, { tarea: 'vuelos', estado: 'blocked', nota: 'La aerolínea no carga.' }),
	).toMatchObject({ ok: true, tareas_tuyas: [{ tarea: 'hotel' }] });
	expect(await flows.activeBlock(radar.id, trip.conv)).toContain('[bloqueada] vuelos · Cotizar vuelos');
	// The trabajo does not end while its tasks are open.
	expect((await jobsMod.done(trip.run, { resumen: 'Listo.' })).error).toContain('Faltan tareas: vuelos (blocked');
	await flows.update(trip.run, { tarea: 'vuelos', resultado: 'Volaris $2,100' });
	await flows.update(trip.run, { tarea: 'hotel', resultado: 'Hotel $1,500' });
	await flows.idle((await flows.tasksOf(radar.id, trip.conv)).list!.id);
	const tripList = (await flows.tasksOf(radar.id, trip.conv)).list!;
	expect(tripList.waiting_for).toBe('Ana');
	// Its owner edits the list from the web: the agent hears it as an instruction.
	const edited = await flows.ownerEdit(radar.id, trip.conv, { op: 'add', titulo: 'Avisar a la oficina' });
	// Nothing else of its going on: it is its right away.
	expect(edited.tasks.find((t) => t.key === 'avisar-a-la-oficina')).toMatchObject({
		status: 'working',
		spec: { by: 'owner' },
	});
	await flows.idle(tripList.id);
	const heard = await lastWake();
	expect(heard.conversation_id).toBe(trip.conv);
	expect(heard.text).toContain(
		'Tu dueño cambió tus tareas: agregó la tarea «Avisar a la oficina» (avisar-a-la-oficina)',
	);
	await expect(flows.ownerEdit(radar.id, trip.conv, { op: 'remove', tarea: 'vuelos' })).rejects.toThrow('ya empezó');
	// The reply the wait was for lands in this trabajo (not the group's), and closes the wait with what she said.
	const reply = await inAna('Radar: sí, adelante con los dos');
	expect(await row('select conversation_id from messages where id = $1', [reply.message_id])).toEqual({
		conversation_id: trip.conv,
	});
	await flows.idle(tripList.id);
	expect(
		await row("select status, result from flow_steps where flow_id = $1 and key = 'visto-bueno'", [tripList.id]),
	).toEqual({ status: 'done', result: { respuesta: 'sí, adelante con los dos', de: 'Ana' } });
	// A task after one that failed waits blocked, saying why; replacing the failed one lets it go again.
	const chain = await trabajo('Cadena');
	await flows.plan(chain.run, {
		agregar: [
			{ key: 'a', titulo: 'Primero' },
			{ key: 'b', titulo: 'Después', depende: ['a'] },
		],
	});
	expect(await flows.update(chain.run, { tarea: 'a', estado: 'failed', nota: 'No cargó.' })).toMatchObject({
		bloqueadas: ['b (depende de a)'],
	});
	const chainList = (await flows.tasksOf(radar.id, chain.conv)).list!;
	expect(await row("select status, note from flow_steps where flow_id = $1 and key = 'b'", [chainList.id])).toEqual({
		status: 'blocked',
		note: 'depende de a, que falló',
	});
	expect((await flows.tasksOf(radar.id, chain.conv)).list!.waiting_for).toBe(
		'el agente (bloqueada: depende de a, que falló)',
	);
	await flows.update(chain.run, { tarea: 'a', estado: 'skipped', nota: 'Lo hago por otro lado.' });
	expect(await row("select status from flow_steps where flow_id = $1 and key = 'b'", [chainList.id])).toEqual({
		status: 'working',
	});
	// The trabajo ends: its list ends with it (cancelled, since tasks were still open).
	await jobsMod.close(trip.conv, 'closed', 'lo dio por terminado Ana');
	expect((await row<{ status: string }>('select status from flows where id = $1', [tripList.id]))!.status).toBe(
		'cancelled',
	);
	delegations.model.ask = realAsk;
	delegations.clock.now = () => new Date();

	// Conversaciones simuladas: with its switch on, what Radar says to its contacts stays in the simulator, where
	// its owner writes as them, through the same paths, in conversations and encargos of their own. What it
	// tells its owner stays real.
	const waSim = await import('./whatsapp-sim');
	await whatsapp.setContact(radar.id, ana, { key: ferreKey, enabled: true });
	await waSim.setOn(radar.id, true);
	waSent.length = 0;
	const simChats = await whatsapp.simChats(radar.id, ana);
	expect(simChats.map((c) => c.name)).not.toContain('Ana');
	expect(simChats.find((c) => c.name === 'Ferretería')).toMatchObject({ chat: 'e:524446667777', kind: 'external' });
	expect(simChats.find((c) => c.name === 'Cliente')).toMatchObject({ chat: 'd:524443334444', kind: 'direct' });
	// To its owner: real, in her group.
	const simJob = await trabajo('Simulación');
	expect(await whatsapp.tellOwner(radar.id, '¿Sigo con el pedido?', simJob.conv)).toBe(true);
	expect(waSent.map((m) => m.group)).toEqual([anaGroup.ref]);
	waSent.length = 0;
	const realGroup = await row('select last_agent_id, last_conversation_id from whatsapp_groups where id = $1', [
		anaGroup.id,
	]);
	// To a contact: in the simulator; written as them, it reaches the agent in a simulated conversation.
	expect((await whatsapp.notify(scheduled, { to: ['Cliente'], text: '¿Ya llegó su pedido?' }, noon)).enviado_a).toEqual(
		['Cliente'],
	);
	expect(waSent).toEqual([]);
	expect((await waSim.messages(radar.id, 'd:524443334444')).at(-1)).toMatchObject({
		direction: 'out',
		author: 'Radar',
		text: '¿Ya llegó su pedido?',
	});
	const answered = await whatsapp.simulate(radar.id, ana, 'd:524443334444', { text: 'Sí, gracias' });
	const simMessage = await row<{ conversation_id: number; context: unknown }>(
		'select conversation_id, context from messages where id = $1',
		[answered.message_id],
	);
	expect(simMessage!.context).toMatchObject({ whatsapp: { sim: 'd:524443334444' } });
	expect(
		await row('select title, whatsapp_key from conversations where id = $1', [simMessage!.conversation_id]),
	).toEqual({ title: 'WhatsApp · Cliente (simulación)', whatsapp_key: 'sim:d:524443334444' });
	expect(
		await row('select last_agent_id, last_conversation_id from whatsapp_groups where id = $1', [anaGroup.id]),
	).toEqual(realGroup);
	await expect(whatsapp.simulate(radar.id, ana, 'g:owner', { text: 'x' })).rejects.toThrow('no está habilitado');
	await expect(whatsapp.simulate(radar.id, ana, 'e:524440000000', { text: 'x' })).rejects.toThrow('no está habilitado');
	// A simulated encargo: it talks with the simulator, and only what is written there reaches it.
	delegations.clock.now = () => noon;
	delegations.model.ask = async () => ({
		value: {
			message: 'Hola, ¿me cotiza 5 bultos?',
			data: [],
			status: 'continue',
			question: null,
			summary: 'Pedí precio.',
		},
		tokens: 10,
	});
	const simEncargo = await delegations.start(job.id, {
		plantilla: 'cotizar',
		contacto: 'Ferretería',
		parametros: params,
	});
	expect(simEncargo.ok).toBe(true);
	await delegations.idle(simEncargo.id as number);
	expect(waSent).toEqual([]);
	expect(await row('select simulated from delegations where id = $1', [simEncargo.id])).toEqual({ simulated: true });
	expect((await waSim.messages(radar.id, 'e:524446667777')).at(-1)).toMatchObject({
		author: 'Encargo',
		text: 'Hola, ¿me cotiza 5 bultos?',
		delegation_id: simEncargo.id,
	});
	await whatsapp.inbound({ number: pubJid, phone: '524446667777', id: 'real-to-sim', text: 'Mensaje real' });
	delegations.model.ask = async () => ({
		value: {
			message: 'Gracias',
			data: [{ producto: 'cemento', precio: 190 }],
			status: 'done',
			question: null,
			summary: 'Cotizó a 190.',
		},
		tokens: 10,
	});
	await whatsapp.simulate(radar.id, ana, 'e:524446667777', { text: 'A 190 el bulto' });
	await delegations.idle(simEncargo.id as number);
	expect(
		(
			await rows<{ text: string }>(
				"select text from delegation_messages where delegation_id = $1 and role = 'contact'",
				[simEncargo.id],
			)
		).map((m) => m.text),
	).toEqual(['A 190 el bulto']);
	expect(waSent).toEqual([]);
	// Written from an open trabajo, a contact's reply goes back to it (its saga), not to a conversation of its own.
	expect(
		(await whatsapp.notify(simJob.run, { to: ['Cliente'], text: '¿Le confirmo el lunes?' }, noon)).enviado_a,
	).toEqual(['Cliente']);
	const back = await whatsapp.simulate(radar.id, ana, 'd:524443334444', { text: 'Sí, el lunes' });
	expect(
		(await row<{ c: number }>('select conversation_id as c from messages where id = $1', [back.message_id]))!.c,
	).toBe(simJob.conv);
	// An actor plays Ferretería: on «auto» it answers the encargo as them, and stops once it judges it done.
	const waActor = await import('./whatsapp-actor');
	const realActor = waActor.actorModel.ask;
	const actorSaw: string[] = [];
	waActor.actorModel.ask = async (_p, _m, instructions, transcript) => {
		actorSaw.push(`${instructions}\n---\n${transcript}`);
		return { value: { message: 'Le queda en 185 el bulto', done: true, reason: 'ya cotizó' }, tokens: 10 };
	};
	delegations.model.ask = async () => ({
		value: { message: '¿A cuánto los 5 bultos?', data: [], status: 'continue', question: null, summary: 'Pregunté.' },
		tokens: 10,
	});
	const acted = await delegations.start(job.id, { plantilla: 'cotizar', contacto: 'Ferretería', parametros: params });
	await delegations.idle(acted.id as number);
	await waActor.set(radar.id, 'e:524446667777', { persona: 'Ferretero de El Martillo; el cemento a 185.', auto: true });
	await Bun.sleep(300); // its first step waits for the agent to stop writing
	delegations.model.ask = async () => ({
		value: {
			message: 'Gracias',
			data: [{ producto: 'cemento', precio: 185 }],
			status: 'done',
			question: null,
			summary: 'Cotizó a 185.',
		},
		tokens: 10,
	});
	await waActor.tick(radar.id, 'e:524446667777', Date.now() + 10_000);
	await delegations.idle(acted.id as number);
	expect(
		(
			await rows<{ text: string }>(
				"select text from delegation_messages where delegation_id = $1 and role = 'contact'",
				[acted.id],
			)
		).map((m) => m.text),
	).toEqual(['Le queda en 185 el bulto']);
	expect(actorSaw[0]).toContain('Ferretero de El Martillo');
	expect(actorSaw[0]).toContain('te escribe por un encargo');
	expect(actorSaw[0]).toContain('Radar: ¿A cuánto los 5 bultos?');
	// It answered and keeps listening (the trabajo goes on); once its encargo ended, it waits without asking again.
	expect((await waActor.list(radar.id)).find((x) => x.chat === 'e:524446667777')).toMatchObject({
		auto: true,
		replies: 1,
	});
	await waActor.tick(radar.id, 'e:524446667777', Date.now() + 20_000);
	await waActor.tick(radar.id, 'e:524446667777', Date.now() + 30_000);
	expect(actorSaw).toHaveLength(1);
	expect((await waActor.list(radar.id)).find((x) => x.chat === 'e:524446667777')).toMatchObject({
		auto: true,
		replies: 1,
		note: 'El encargo terminó: espera a que el agente vuelva a escribir.',
	});
	// A chat that followed a closed trabajo does not silence a line of another trabajo (its encargo's): the
	// line's own trabajo decides (here, open; its encargo is what ended).
	const closedConv = (await row<{ id: number }>(
		"insert into conversations (agent_id, pi_session_id, status) values ($1, gen_random_uuid()::text, 'closed') returning id",
		[radar.id],
	))!.id;
	await waSim.follow(radar.id, 'e:524446667777', closedConv);
	await waSim.out(radar.id, 'e:524446667777', 'Encargo', '¿Y para el lunes?', [], { delegationId: acted.id as number });
	await waActor.tick(radar.id, 'e:524446667777', Date.now() + 40_000);
	expect((await waActor.list(radar.id)).find((x) => x.chat === 'e:524446667777')!.note).toBe(
		'El encargo terminó: espera a que el agente vuelva a escribir.',
	);
	expect(waSent).toEqual([]);
	// By default the AI answers: the agent writing to a chat turns its actor on, not when its owner turned it off.
	await waSim.out(radar.id, 'e:524445556666', 'Radar', 'Hola, ¿tiene varilla?');
	expect((await waActor.list(radar.id)).find((x) => x.chat === 'e:524445556666')).toMatchObject({ auto: true });
	await waActor.set(radar.id, 'e:524445556666', { auto: false });
	await waSim.out(radar.id, 'e:524445556666', 'Radar', '¿Sigue ahí?');
	expect((await waActor.list(radar.id)).find((x) => x.chat === 'e:524445556666')).toMatchObject({
		auto: false,
		stopped: 'lo detuviste',
	});
	waActor.actorModel.ask = realActor;
	await waSim.setOn(radar.id, false);
	// The same for real: a direct guest's reply lands in the trabajo the agent wrote to them from.
	waSent.length = 0;
	await whatsapp.notify(simJob.run, { to: ['Cliente'], text: '¿Y el martes?' }, noon);
	expect(waSent.at(-1)).toMatchObject({ phone: '524443334444' });
	const realBack = await whatsapp.inbound({
		number: pubJid,
		phone: '524443334444',
		id: 'reply-to-trabajo',
		text: 'También',
	});
	expect(
		(await row<{ c: number }>('select conversation_id as c from messages where id = $1', [realBack.message_id]))!.c,
	).toBe(simJob.conv);
	// Conversaciones: the real chat keeps both sides, in the trabajo; the simulated encargo chat is listed apart.
	const waLog = await import('./whatsapp-log');
	const direct = await waLog.messages(radar.id, 'd:524443334444');
	expect(direct.lines.slice(-2).map((l) => [l.direction, l.text, l.conversation_id])).toEqual([
		['out', '¿Y el martes?', simJob.conv],
		['in', 'También', simJob.conv],
	]);
	expect(direct.completeSince).toBeNull();
	const listed = await waLog.chats(radar.id, ana, simJob.conv);
	expect(listed.find((c) => c.id === 'd:524443334444')).toMatchObject({ kind: 'direct', simulated: false });
	expect((await waLog.chats(radar.id, ana)).find((c) => c.id === 'se:524446667777')).toMatchObject({
		kind: 'external',
		simulated: true,
		name: 'Ferretería',
		encargos: 2,
	});
	// A repeat of what came in is not logged twice.
	await whatsapp
		.inbound({ number: pubJid, phone: '524443334444', id: 'reply-to-trabajo', text: 'También' })
		.catch(() => {}); // the inbox refuses it too (its notice was answered the first time)
	expect((await waLog.messages(radar.id, 'd:524443334444')).lines.filter((l) => l.text === 'También')).toHaveLength(1);
	delegations.model.ask = realAsk;
	delegations.clock.now = () => new Date();

	// A question for its owner (request_help para: dueño) in a work a guest asked for: it goes, whole, to its owner's
	// group; the guest only hears that it is being asked.
	const guestRun = (await row<{ id: number }>(
		`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status)
		 values ($1, $2, $3, $4, 'openai/gpt-6-sol', 'done') returning id`,
		[radar.id, ana.id, simJob.conv, `para-dueno-${radar.id}`],
	))!.id;
	await exec(
		`insert into messages (agent_id, conversation_id, source, text, run_id, routed_as, routed_at, context)
		 values ($1, $2, 'whatsapp', 'Cámbialo al 19', $3, 'new_run', now(), $4)`,
		[
			radar.id,
			simJob.conv,
			guestRun,
			JSON.stringify({ whatsapp: { number: pub.id, phone: '524443334444', direct: true } }),
		],
	);
	waSent.length = 0;
	await whatsapp.onRun(
		guestRun,
		'blocked',
		JSON.stringify({ version: 1, para: 'dueño', reason: 'La entrega del 19 pasa tu límite del 13.', questions: [] }),
	);
	expect(waSent.find((m) => m.group === anaGroup.ref)?.text).toContain('La entrega del 19 pasa tu límite del 13.');
	expect(waSent.find((m) => m.phone === '524443334444')?.text).toContain('Esto lo tiene que decidir Ana');
	expect(waSent.find((m) => m.phone === '524443334444')?.text).not.toContain('La entrega del 19');

	// A stalled list (nothing in progress, nobody waited for, its agent idle): first its agent is woken to ask for
	// what it needs; still stalled, its owner hears by WhatsApp what is stuck; then nothing more.
	await exec(
		"update runs set status = 'done' where agent_id = $1 and status in ('queued', 'starting', 'running', 'blocked')",
		[radar.id],
	);
	const stall = await trabajo('Detenida');
	await flows.plan(stall.run, {
		agregar: [
			{ key: 'cobertura', titulo: 'Validar cobertura' },
			{ key: 'confirmar', titulo: 'Confirmar carnes', depende: ['cobertura'] },
		],
	});
	await flows.update(stall.run, {
		tarea: 'cobertura',
		estado: 'blocked',
		nota: 'Falta que Ana diga si comparto el CP.',
	});
	const stallList = (await flows.tasksOf(radar.id, stall.conv)).list!;
	const aged = () => exec("update flows set updated_at = now() - interval '20 minutes' where id = $1", [stallList.id]);
	const lastEvent = () =>
		row('select kind, data from flow_events where flow_id = $1 order by id desc limit 1', [stallList.id]);
	await aged();
	await flows.sweep();
	expect(await lastEvent()).toEqual({ kind: 'idle', data: { level: 1 } });
	expect(
		(await row<{ text: string }>(
			"select text from messages where conversation_id = $1 and source = 'flow' order by id desc limit 1",
			[stall.conv],
		))!.text,
	).toContain('Tu lista quedó detenida');
	waSent.length = 0;
	await aged();
	await flows.sweep();
	expect(await lastEvent()).toEqual({ kind: 'idle', data: { level: 2 } });
	expect(waSent.find((m) => m.group === anaGroup.ref)?.text).toContain(
		'quedó detenida y no he podido moverla. Está bloqueado: Validar cobertura (Falta que Ana diga si comparto el CP.)',
	);
	waSent.length = 0;
	await aged();
	await flows.sweep();
	expect(waSent).toEqual([]);

	// Modo objetivo: after a turn, a list with a task of its own goes on right away; three autonomous turns without
	// progress stall it (its owner hears); at its budget it stops going on by itself (its owner hears).
	await exec('update agents set goal_mode = true where id = $1', [radar.id]);
	const goalJob = await trabajo('Objetivo');
	await flows.plan(goalJob.run, { agregar: [{ key: 'cotizar', titulo: 'Cotizar la ferretería' }] });
	const turnOf = async (since: string, cost = 0.1) => {
		const id = (await row<{ id: number }>(
			`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status, kind, cost, started_at, ended_at)
			 values ($1, $2, $3, $4, 'openai/gpt-6-sol', 'done', 'task', $5, now() - $6::interval, now()) returning id`,
			[radar.id, ana.id, goalJob.conv, `goal-${crypto.randomUUID()}`, cost, since],
		))!.id;
		// The wake it was woken by is its message (an autonomous turn).
		await exec(
			"update messages set run_id = $3, routed_as = 'new_run', routed_at = now() where agent_id = $1 and conversation_id = $2 and run_id is null",
			[radar.id, goalJob.conv, id],
		);
		if (!(await row('select 1 from messages where run_id = $1', [id])))
			await exec(
				"insert into messages (agent_id, conversation_id, source, text, run_id, routed_as, routed_at) values ($1, $2, 'flow', 'sigue', $3, 'new_run', now())",
				[radar.id, goalJob.conv, id],
			);
		return id;
	};
	const woken = () =>
		row<{ n: number }>(
			"select count(*)::int as n from messages where conversation_id = $1 and source = 'flow' and run_id is null",
			[goalJob.conv],
		);
	await flows.afterRun(await turnOf('1 minute')); // it planned: progress
	expect((await woken())!.n).toBe(1);
	expect(
		(await row<{ text: string }>(
			"select text from messages where conversation_id = $1 and source = 'flow' and run_id is null",
			[goalJob.conv],
		))!.text,
	).toContain('Sigue con tu trabajo hasta cumplir su objetivo');
	waSent.length = 0;
	for (let i = 0; i < 3; i++) await flows.afterRun(await turnOf('0 seconds')); // nothing changed in its list
	expect((await row<{ n: number }>('select idle_turns as n from conversations where id = $1', [goalJob.conv]))!.n).toBe(
		3,
	);
	expect(waSent.find((m) => m.group === anaGroup.ref)?.text).toContain(
		`La lista del trabajo #${goalJob.conv} quedó detenida`,
	);
	await exec('update conversations set budget_usd = 0.2, idle_turns = 0 where id = $1', [goalJob.conv]);
	waSent.length = 0;
	await flows.afterRun(await turnOf('0 seconds'));
	expect(waSent.find((m) => m.group === anaGroup.ref)?.text).toContain(
		`El trabajo #${goalJob.conv} llegó a su presupuesto`,
	);
	expect((await woken())!.n).toBe(0);

	// WhatsApp closed the session: the number shows unlinked.
	await whatsapp.event({ type: 'logged_out', number: jid });
	waLinked.delete(jid);
	expect((await whatsapp.numbers(ana)).numbers.find((n) => n.id === started.id)?.state).toBe('unlinked');
	await whatsapp.remove(ana, started.id);
	await expect(whatsapp.event({ type: 'nope' })).rejects.toThrow('desconocido');
	await whatsapp.update(admin, pub.id, { groups: false });
});
run('/reload tells the agent, in the same chat, that its current configuration wins', async () => {
	const agents = await import('./agents'),
		tasks = await import('./tasks');
	const a = await agents.create(person, { name: 'Recarga', model: 'openai/gpt-6-sol' }),
		conv = (await agents.conversations(a.id))[0].id;
	const r = (await tasks.reloadConversation(a.id, conv, { id: person, name: 'Yo' }, true)) as { message_id: number };
	const m = await row<{ conversation_id: number; source: string; text: string }>(
		'select conversation_id, source, text from messages where id = $1',
		[r.message_id],
	);
	expect(m).toMatchObject({ conversation_id: conv, source: 'web' });
	expect(m!.text).toContain('Configuración recargada (revisión 1)');
	expect(m!.text).toContain('confirma en una línea');
	// The owner's live browser session has no harness to reload: it is not stopped.
	await exec('delete from messages where id = $1', [r.message_id]);
	await exec(
		`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status, kind) values ($1, $2, $3, $4, $5, 'running', 'browser')`,
		[a.id, person, conv, `reload-browser-${a.id}`, a.model],
	);
	await expect(tasks.reloadConversation(a.id, conv, { id: person, name: 'Yo' }, true)).rejects.toThrow(
		'Cierra el navegador',
	);
	await exec("update runs set status = 'done', ended_at = now() where workflow_id = $1", [`reload-browser-${a.id}`]);
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
	'lessons are curated by rule: repeats count as useful, the harmful and the excess go, the pinned stay',
	async () => {
		const agents = await import('./agents'),
			lessons = await import('./lessons');
		const a = await agents.create(person, { name: 'Aprende', model: 'openai/gpt-6-sol' });
		await lessons.apply(a.id, null, [
			{ op: 'add', id: null, text: 'Hay refrigerador con espacio: no lo preguntes.' },
			{ op: 'add', id: null, text: 'Las Dos Marías reparte martes y jueves de 9 a 15 h.' },
			{ op: 'helpful', id: 999999, text: '' }, // not its own: ignored
		]);
		let list = await lessons.list(a.id);
		const [fridge, meat] = ['refrigerador', 'Dos Marías'].map((w) => list.find((l) => l.text.includes(w))!);
		await lessons.apply(a.id, null, [
			{ op: 'add', id: null, text: 'hay REFRIGERADOR con espacio, no lo preguntes' },
			{ op: 'update', id: meat.id, text: 'Las Dos Marías reparte martes y jueves de 9 a 14 h.' },
		]);
		list = await lessons.list(a.id);
		expect(list).toHaveLength(2);
		expect(list.find((l) => l.id === fridge.id)!.helpful).toBe(1);
		expect(list.find((l) => l.id === meat.id)!.text).toContain('9 a 14 h');
		// Harmful twice over its useful marks: it goes, unless its owner pinned it.
		await lessons.pin(a.id, meat.id, true);
		for (let i = 0; i < 3; i++)
			await lessons.apply(a.id, null, [
				{ op: 'harmful', id: fridge.id, text: '' },
				{ op: 'harmful', id: meat.id, text: '' },
			]);
		expect((await lessons.list(a.id)).map((l) => l.id)).toEqual([meat.id]);
		await lessons.apply(a.id, null, [{ op: 'remove', id: meat.id, text: '' }]);
		expect((await lessons.list(a.id)).map((l) => l.id)).toEqual([meat.id]);
		// Past the cap of the bank, the least useful go; a playbook carries what fits.
		for (let k = 0; k * 12 < lessons.MAX_LESSONS + 12; k++)
			await lessons.apply(
				a.id,
				null,
				Array.from({ length: 12 }, (_, i) => ({ op: 'add' as const, id: null, text: `Lección ${k}-${i} de prueba.` })),
			);
		list = await lessons.list(a.id);
		expect(list).toHaveLength(lessons.MAX_LESSONS);
		expect(list[0].id).toBe(meat.id); // pinned first
		const picked = await lessons.assemble(a.id, '');
		expect(picked[0]).toEqual({ id: meat.id, why: 'fijado' });
		expect(picked.reduce((n, p) => n + list.find((l) => l.id === p.id)!.text.length + 3, 0)).toBeLessThanOrEqual(
			lessons.PLAYBOOK_CHARS,
		);
		await lessons.remove(a.id, meat.id);
		await expect(lessons.remove(a.id, meat.id)).rejects.toThrow('ya no está');
		// Its owner teaches it something on a trabajo (Aprender): pinned, the trabajo shows it; again, only pinned.
		const conv = (await agents.conversations(a.id))[0].id;
		const taught = await lessons.teach(a.id, conv, '  Miguel paga las carnes en efectivo al recibirlas. ');
		expect((await lessons.list(a.id))[0]).toMatchObject({ id: taught, pinned: true, conversation_id: conv });
		expect((await lessons.ofTrabajo(conv)).taught).toMatchObject([
			{ op: 'teach', text: 'Miguel paga las carnes en efectivo al recibirlas.' },
		]);
		expect(await lessons.teach(a.id, null, 'miguel paga las carnes en efectivo al recibirlas')).toBe(taught);
		expect(await lessons.list(a.id)).toHaveLength(lessons.MAX_LESSONS);
		await expect(lessons.teach(a.id, conv, '   ')).rejects.toThrow('Escribe');
		// Its owner deletes several, or all of them.
		const two = (await lessons.list(a.id)).slice(-2).map((l) => l.id);
		expect(await lessons.removeMany(a.id, { ids: two })).toBe(2);
		await expect(lessons.removeMany(a.id, { ids: [] })).rejects.toThrow('Elige');
		expect(await lessons.removeMany(a.id, { all: true })).toBe(lessons.MAX_LESSONS - 2);
	},
);
run('a turn its pi lost in a restart is taken up: not while it waits for the model, twice at most', async () => {
	const agents = await import('./agents'),
		tasks = await import('./tasks');
	const a = await agents.create(person, { name: 'Turno perdido', model: 'openai/gpt-6-sol' }),
		conv = (await agents.conversations(a.id))[0].id;
	const runId = (await row<{ id: number }>(
		`insert into runs(agent_id,person_id,conversation_id,workflow_id,model,status,state) values($1,$2,$3,$4,$5,'running','thinking') returning id`,
		[a.id, person, conv, `lost-${a.id}`, a.model],
	))!.id;
	const sent: any[] = [];
	const base = Date.now();
	const l: any = {
		ref: { id: runId, person_id: person, agent_id: a.id },
		sup: { send: (d: string) => sent.push(JSON.parse(d).cmd), close() {} },
		chain: Promise.resolve(),
		kind: 'task',
		piAt: base,
	};
	tasks.liveRuns.set(runId, l);
	try {
		const at = (min: number) => (tasks.lostTurnClock.now = () => base + min * 60_000);
		at(1);
		expect(await tasks.takeUpLostTurns()).toBe(0); // a minute of silence is thinking
		const end = tasks.llmCall(runId);
		at(10);
		expect(await tasks.takeUpLostTurns()).toBe(0); // its call to the model is still open
		end();
		l.piAt = base; // that call ended long ago
		// pi still «processes» a turn whose answer died with the old process: it is aborted first...
		expect(await tasks.takeUpLostTurns()).toBe(1);
		expect(sent.at(-1)).toEqual({ type: 'abort' });
		// ...and an idle pi that never settles is told to go on at the next pass.
		at(13);
		expect(await tasks.takeUpLostTurns()).toBe(0);
		expect(sent.at(-1)).toMatchObject({ type: 'prompt' });
		expect(sent.at(-1).message).toContain('Continúa donde ibas');
		at(16);
		expect(await tasks.takeUpLostTurns()).toBe(1);
		at(19);
		await tasks.takeUpLostTurns();
		at(22);
		expect(await tasks.takeUpLostTurns()).toBe(0); // twice at most: then its deadline ends it
		expect((await tasks.events(runId)).filter((e) => e.kind === 'system')).toHaveLength(2);
	} finally {
		tasks.lostTurnClock.now = () => Date.now();
		tasks.liveRuns.delete(runId);
		await exec("update runs set status='done' where id=$1", [runId]);
	}
});
run('Conversaciones shows its agent writing only while a run asked from that chat thinks or writes', async () => {
	const agents = await import('./agents'),
		waLog = await import('./whatsapp-log');
	const a = await agents.create(person, { name: 'Escribiendo', model: 'openai/gpt-6-sol' }),
		conv = (await agents.conversations(a.id))[0].id;
	const runId = (await row<{ id: number }>(
		`insert into runs(agent_id,person_id,conversation_id,workflow_id,model,status,state) values($1,$2,$3,$4,$5,'running','thinking') returning id`,
		[a.id, person, conv, `typing-${a.id}`, a.model],
	))!.id;
	await exec(
		`insert into messages (agent_id, source, sender, text, context, run_id, routed_as, routed_at, conversation_id)
		 values ($1, 'whatsapp', 'Miguel', 'Va', $2, $3, 'new_run', now(), $4)`,
		[a.id, JSON.stringify({ whatsapp: { sim: 'g:524443428337', phone: '524443428337' } }), runId, conv],
	);
	expect(await waLog.agentTyping(a.id, 'sg:524443428337')).toBe(true);
	expect(await waLog.agentTyping(a.id, 'g:524443428337')).toBe(false); // the real chat is another one
	expect(await waLog.agentTyping(a.id, 'sg:524445346488')).toBe(false); // so is someone else's
	await exec("update runs set state = 'browsing' where id = $1", [runId]);
	expect(await waLog.agentTyping(a.id, 'sg:524443428337')).toBe(false); // working, not writing
	await exec("update runs set status = 'done', state = 'done' where id = $1", [runId]);
	expect(await waLog.agentTyping(a.id, 'sg:524443428337')).toBe(false);
});
run(
	'an agent goes to a .cubyagent and back: its configuration, lessons, contacts and files, never its secrets',
	async () => {
		const agents = await import('./agents'),
			bundle = await import('./agent-bundle'),
			accesses = await import('./accesses'),
			lessons = await import('./lessons'),
			{ harnessHash, defaultHarness } = await import('./harnesses'),
			{ runtimeToolNames } = await import('../../sandbox/harness'),
			{ unzipSync, zipSync, strToU8 } = await import('fflate');
		const tag = crypto.randomUUID().slice(0, 8);
		const a = await agents.create(person, {
			name: 'Exportable',
			role: '# Rol\nHace el súper.',
			model: 'openai/gpt-6-sol',
			harness: defaultHarness(),
			image: `sha256:${'a'.repeat(64)}`,
		});
		await exec(
			"update agents set goal_mode = true, personality = $2, style = 'pirate', soul = 'Hablo así.' where id = $1",
			[a.id, JSON.stringify({ autonomia: 5 })],
		);
		await lessons.teach(a.id, null, 'Miguel da el visto bueno.');
		const keyName = `BUNDLE_${tag}`.toUpperCase().replace(/-/g, '_');
		const key = (
			await accesses.saveKey(person, { name: keyName, value: 'secreto-xyz', domains: 'api.example.com' })
		).find((k) => k.name === keyName)!;
		await accesses.grantKey(person, key.id, [a.id]);
		const number = (await row<{ id: number }>(
			"insert into whatsapp_numbers (owner_id, jid, status) values ($1, $2, 'linked') returning id",
			[person, `bundle-${tag}@s.whatsapp.net`],
		))!.id;
		const phone = `52444${String(Date.now()).slice(-7)}`;
		await exec(
			"insert into whatsapp_phones (number_id, phone, list, label, external) values ($1, $2, 'allow', 'Proveedor', true)",
			[number, phone],
		);
		await exec('insert into whatsapp_agent_phones (agent_id, number_id, phone, enabled) values ($1, $2, $3, true)', [
			a.id,
			number,
			phone,
		]);
		const written: { volume: string; path: string; tar: number[] }[] = [];
		const real = bundle.bundleEngine.docker;
		bundle.bundleEngine.docker = {
			readVolume: async () => new Uint8Array([1, 2, 3]),
			writeVolume: async (v: { name: string }, _image: string, path: string, tar: Uint8Array) =>
				void written.push({ volume: v.name, path, tar: [...tar] }),
			imageId: async () => `sha256:${'b'.repeat(64)}`,
			probeHarness: async (_image: string, h: any) => ({
				digest: harnessHash(h),
				tools: runtimeToolNames(h),
				skills: h.skills.map((s: any) => s.name),
				plugins: h.plugins,
			}),
		} as any;
		try {
			const file = await bundle.exportAgent((await agents.get(a.id))!, { id: person, name: 'Yo' });
			expect(file.name).toMatch(/^exportable-r\d+\.cubyagent$/);
			expect(Buffer.from(file.bytes).includes(Buffer.from('secreto-xyz'))).toBe(false); // never its secrets
			// An altered file is refused.
			const files = unzipSync(file.bytes);
			files['CONTRACT.md'] = strToU8('Otro contrato');
			await expect(bundle.inspect(zipSync(files), person)).rejects.toThrow('alterado');
			await expect(bundle.inspect(strToU8('hola'), person)).rejects.toThrow('no es un .cubyagent');
			// What importing it would do: what it needs, matched by name and by number.
			const preview = await bundle.inspect(file.bytes, person);
			expect(preview).toMatchObject({
				lessons: 1,
				harnessError: null,
				missingModel: null,
				workspaceBytes: 3,
				style: 'Pirata',
			});
			expect(preview.accesses).toEqual([{ kind: 'key', name: keyName, have: true }]);
			expect(preview.contacts).toMatchObject([{ phone, role: 'external', enabled: true, have: true }]);
			// Imported: all of its configuration, its lessons, its accesses and contacts matched, its files in its volume.
			const done = await bundle.importAgent(file.bytes, { id: person });
			const b = done.agent!;
			expect(b.id).not.toBe(a.id);
			expect(b).toMatchObject({
				name: 'Exportable',
				role: '# Rol\nHace el súper.',
				style: 'pirate',
				soul: 'Hablo así.',
				harness_image: `sha256:${'b'.repeat(64)}`,
			});
			expect(b.personality).toEqual({ autonomia: 5 });
			expect((await row<{ goal_mode: boolean }>('select goal_mode from agents where id = $1', [b.id]))!.goal_mode).toBe(
				true,
			);
			expect((await lessons.list(b.id)).map((l) => [l.text, l.pinned])).toEqual([['Miguel da el visto bueno.', true]]);
			expect((await accesses.grantedTo(b.id)).keys.map((k) => k.name)).toEqual([keyName]);
			expect(
				await row('select enabled from whatsapp_agent_phones where agent_id = $1 and phone = $2', [b.id, phone]),
			).toEqual({ enabled: true });
			expect(written).toEqual([
				{ volume: expect.stringContaining(`agent-${b.id}`), path: '/home/agent/state', tar: [1, 2, 3] },
			]);
			expect(done).toMatchObject({ granted: [keyName], missing: [], contacts: 1, workspace: true });
		} finally {
			bundle.bundleEngine.docker = real;
		}
	},
);
run("someone else's WhatsApp waits for its own run: a run's answer goes to whoever asked it", async () => {
	const agents = await import('./agents'),
		inbox = await import('./inbox'),
		{ EXTERNAL_ROLE } = await import('./inbox');
	const a = await agents.create(person, { name: 'Sin cruces', model: 'openai/gpt-6-sol' }),
		conv = (await agents.conversations(a.id))[0].id;
	const owner = { whatsapp: { group: 3, phone: '524445346488', number: 9 } };
	const asked = await inbox.receive(
		{ agentId: a.id, source: 'whatsapp', personId: person, conversationId: conv, text: 'Pídelo', context: owner },
		{ routeNow: false },
	);
	const runId = (await row<{ id: number }>(
		`insert into runs(agent_id,person_id,conversation_id,workflow_id,model,status) values($1,$2,$3,$4,$5,'running') returning id`,
		[a.id, person, conv, `cross-${a.id}`, a.model],
	))!.id;
	await exec("update messages set run_id=$2,routed_as='new_run',routed_at=now() where id=$1", [
		asked.message_id,
		runId,
	]);
	const from = (sender: string, text: string, context: unknown) =>
		inbox.receive(
			{ agentId: a.id, source: 'whatsapp', sender, conversationId: conv, text, context },
			{ routeNow: false },
		);
	// Miguel answers a notice (Chefsito, 12-nov-2026): he waits, so the owner never gets the reply meant for him.
	const miguel = await from('Miguel (+524443428337), invitado de tu dueño (no es tu dueño)', 'Va, pásame el pedido', {
		whatsapp: { sim: 'g:524443428337', phone: '524443428337', number: 9 },
	});
	const external = await from(`Cortez (+524444408882), ${EXTERNAL_ROLE}`, 'A $125 el kilo', {
		whatsapp: { sim: 'e:524444408882', phone: '524444408882', number: 9 },
	});
	const mine = await inbox.receive(
		{ agentId: a.id, source: 'whatsapp', personId: person, conversationId: conv, text: 'Y avísale', context: owner },
		{ routeNow: false },
	);
	await inbox.route(a.id);
	const state = async (id: number) =>
		(await row<{ run_id: number | null; routed_as: string | null }>(
			'select run_id::int,routed_as from messages where id=$1',
			[id],
		))!;
	expect(await state(miguel.message_id)).toEqual({ run_id: null, routed_as: null });
	expect(await state(external.message_id)).toEqual({ run_id: runId, routed_as: 'queued' });
	expect(await state(mine.message_id)).toEqual({ run_id: runId, routed_as: 'queued' });
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
	const pending = asked.interview.pending;
	if (!pending) return asked; // an improvement may be proposed straight away
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
	expect(d.version).toBe(2); // question round, proposal: no platform round after the owner's
	expect(d.messages.length).toBe(4);
	expect(d.tokens).toBe(246); // two model calls: the round and the proposal
	expect(d.interview).toMatchObject({ phase: 'review', completed: 1, pending: null });
	expect(d.contract).toEqual(designerReply.contract);
	expect(await row('select count(*) as n from agents')).toEqual(before);
	expect((await designs.get(person, d.id)).messages).toEqual(d.messages);
	const request = modelRequests.at(-1);
	expect(request.model).toBe('gpt-6-sol');
	expect(request.store).toBe(false);
	expect(request.tools.map((t: any) => t.name)).toEqual(['buscar_mcp', 'buscar_cli', 'buscar_skills']); // searches only, read only
	expect(request.input[0].content).toContain('acotar');
	expect(request.input[0].content).toContain('Canales de entrega de esta versión'); // what a deliverable can use
	expect(request.text.format.type).toBe('json_schema');
	expect(request.input[1].questions).toBeUndefined(); // provider messages carry only role/content, not UI metadata
	expect(request.input.some((m: any) => m.content.includes('Preguntas de esta ronda'))).toBe(true);
	expect(d.effectivePrompt).toContain('Nunca pagas');
});
run('drafts are listed, renamed without losing a passed harness test, and discarded', async () => {
	const designs = await import('./designs'),
		{ proposalDigest } = await import('./harnesses');
	const d = await proposal();
	expect((await designs.drafts(person)).find((x) => x.id === d.id)?.name).toBe('Diseñado');
	const stored = (await row<any>('select * from agent_designs where id = $1', [d.id]))!;
	await exec('update agent_designs set harness_validation = $2 where id = $1', [
		d.id,
		JSON.stringify({
			status: 'passed',
			version: d.version,
			digest: proposalDigest(stored),
			harnessDigest: 'h',
			imageId: `sha256:${'a'.repeat(64)}`,
			at: 0,
			checks: [],
			tools: [],
		}),
	]);
	const renamed = await designs.rename(person, d.id, { name: 'Comparador', version: d.version });
	expect(renamed.contract?.name).toBe('Comparador');
	expect(renamed.version).toBe(d.version + 1);
	const after = (await row<any>('select * from agent_designs where id = $1', [d.id]))!;
	expect(renamed.harness_validation).toMatchObject({
		status: 'passed',
		version: renamed.version,
		digest: proposalDigest(after),
	});
	await expect(designs.rename(person, d.id, { name: 'Otro', version: d.version })).rejects.toThrow('cambió');
	await expect(designs.rename(person, d.id, { name: 'x'.repeat(41), version: renamed.version })).rejects.toThrow('40');
	expect((await designs.drafts(person)).find((x) => x.id === d.id)?.name).toBe('Comparador');
	await designs.remove(person, d.id);
	expect((await designs.drafts(person)).some((x) => x.id === d.id)).toBe(false);
	await expect(designs.get(person, d.id)).rejects.toThrow();
});
run("suggested accesses are only the person's, and granting one adds the agent to it", async () => {
	const designs = await import('./designs'),
		agents = await import('./agents'),
		accesses = await import('./accesses');
	const agent = await agents.create(person, { name: 'Con accesos', role: 'Inicial', model: 'openai/gpt-6-sol' });
	const other = await agents.create(person, { name: 'Otro', role: 'Inicial', model: 'openai/gpt-6-sol' });
	const key = (await accesses.saveKey(person, { name: 'DOCS_TOKEN', value: 'x', domains: 'api.example.com' })).find(
		(k) => k.name === 'DOCS_TOKEN',
	)!;
	await accesses.grantKey(person, key.id, [other.id]);
	const reply = designerReply as typeof designerReply & { accesses?: unknown };
	reply.accesses = [
		{ kind: 'key', name: 'docs_token', reason: 'Lee la documentación privada' },
		{ kind: 'key', name: 'NO_EXISTE', reason: '' },
		{ kind: 'mcp', name: 'DOCS_TOKEN', reason: 'otro tipo' },
	];
	try {
		const d = await proposal(agent.id);
		expect(d.accessSuggestions).toEqual([
			{
				kind: 'key',
				id: key.id,
				name: 'DOCS_TOKEN',
				detail: 'api.example.com',
				reason: 'Lee la documentación privada',
				granted: false,
				accepted: false,
			},
		]);
		const granted = await designs.grantSuggested(person, d.id, { kind: 'key', id: key.id });
		expect(granted.accessSuggestions?.[0].granted).toBe(true);
		expect((await accesses.listKeys(person)).find((k) => k.id === key.id)?.agents.sort()).toEqual(
			[agent.id, other.id].sort(),
		);
		const stranger = (await accesses.saveKey(person, { name: 'OTRA', value: 'y', domains: 'x.example.com' })).find(
			(k) => k.name === 'OTRA',
		)!;
		await expect(designs.grantSuggested(person, d.id, { kind: 'key', id: stranger.id })).rejects.toThrow('sugeridos');
	} finally {
		delete reply.accesses;
	}
});
run("found tools: an MCP becomes the owner's access with its secret, and secrets never reach the model", async () => {
	const designs = await import('./designs'),
		accesses = await import('./accesses');
	const d = await proposal();
	const at = d.messages.length - 1;
	await exec(
		`update agent_designs set messages = jsonb_set(jsonb_set(messages, $2, $3::jsonb), $4, $5::jsonb) where id = $1`,
		[
			d.id,
			`{${at},findings}`,
			JSON.stringify([
				{
					id: 'mcp:io.example/docs',
					kind: 'mcp',
					name: 'io.example/docs',
					title: 'docs',
					description: 'Documentación por MCP',
					version: '1.0.0',
					url: null,
					fields: [
						{
							name: 'Authorization',
							description: 'Token',
							secret: true,
							target: 'header',
							template: 'Bearer {token}',
							value: null,
						},
					],
					mcp: { transport: 'http', url: 'https://mcp.example.com/mcp' },
					status: 'pending',
				},
				{
					id: 'cli:pdf-tool',
					kind: 'cli',
					name: 'pdf-tool',
					title: 'pdf-tool',
					description: '',
					version: '2.0.0',
					url: null,
					fields: [],
					status: 'pending',
				},
			]),
			`{${at},secrets}`,
			JSON.stringify([{ name: 'DOCS_TOKEN', description: 'Para la API de documentos', domains: ['api.example.com'] }]),
		],
	);
	const card = { message: at, finding: 'mcp:io.example/docs', choice: 'added' };
	await expect(designs.decideFinding(person, d.id, { ...card, values: {} })).rejects.toThrow('Falta Authorization');
	const added = await designs.decideFinding(person, d.id, { ...card, values: { Authorization: 'secreto-123' } });
	expect(added.messages[at].findings?.[0]).toMatchObject({ status: 'added', added: { access: 'docs' } });
	const mcp = (await accesses.listMcp(person)).find((m) => m.name === 'docs')!;
	expect(mcp.url).toBe('https://mcp.example.com/mcp');
	expect(mcp.headers).toEqual([{ name: 'Authorization', secret: true, value: null }]);
	expect(added.accessSuggestions?.some((x) => x.kind === 'mcp' && x.name === 'docs')).toBe(true);
	const skipped = await designs.decideFinding(person, d.id, {
		message: at,
		finding: 'cli:pdf-tool',
		choice: 'skipped',
	});
	expect(skipped.messages[at].findings?.[1].status).toBe('skipped');
	await expect(designs.decideFinding(person, d.id, card)).rejects.toThrow('Ya lo agregaste');
	const saved = await designs.saveSecret(person, d.id, {
		message: at,
		name: 'DOCS_TOKEN',
		value: 'valor-del-token',
		domains: ['api.example.com'],
	});
	expect(saved.messages[at].secrets?.[0].saved).toBe(true);
	expect((await accesses.listKeys(person)).some((k) => k.name === 'DOCS_TOKEN')).toBe(true);
	// The next reply: the designer reads the decisions, the added accesses stay suggested, no secret is sent.
	const next = await designs.message(person, d.id, { text: 'Ajusta el alcance.', version: saved.version });
	const sent = JSON.stringify(modelRequests.at(-1));
	expect(sent).toContain('Hallazgos de tus búsquedas');
	expect(sent).toContain('descartado por el dueño');
	expect(sent).not.toContain('secreto-123');
	expect(sent).not.toContain('valor-del-token');
	expect(JSON.stringify(next)).not.toContain('secreto-123');
	expect(next.accessSuggestions?.map((x) => `${x.kind}:${x.name}`).sort()).toEqual(['key:DOCS_TOKEN', 'mcp:docs']);
	expect(modelRequests.at(-1).tools.map((t: any) => t.name)).toEqual(['buscar_mcp', 'buscar_cli', 'buscar_skills']);
	await accesses.removeMcp(person, mcp.id);
	await accesses.removeKey(person, (await accesses.listKeys(person)).find((k) => k.name === 'DOCS_TOKEN')!.id);
});
run('a reply the server refuses gets one corrective turn with the reason', async () => {
	const designs = await import('./designs'),
		{ defaultHarness } = await import('../../sandbox/harness');
	const d = await proposal();
	queuedReplies.push({
		...designerReply,
		harness: { ...defaultHarness(), skills: [{ name: 'larga', description: 'd', instructions: 'z'.repeat(9000) }] },
	});
	const before = modelRequests.length;
	const fixed = await designs.message(person, d.id, { text: 'Agrega una skill de resumen.', version: d.version });
	expect(modelRequests.length).toBe(before + 2);
	const retry = JSON.stringify(modelRequests.at(-1).input.slice(-2));
	expect(retry).toContain('El servidor rechazó tu respuesta anterior');
	expect(retry).toContain('skill inválida');
	expect(fixed.last_error).toBeNull();
	expect(fixed.contract).toEqual(designerReply.contract);
	// A long contract is not refused (the panel only warns): no corrective turn.
	const long = { ...designerReply, contract: { ...designerReply.contract, prompt: 'x'.repeat(17000) } };
	queuedReplies.push(long);
	let count = modelRequests.length;
	const kept = await designs.message(person, d.id, { text: 'Detalla todo.', version: fixed.version });
	expect(modelRequests.length).toBe(count + 1);
	expect(kept.contract?.prompt.length).toBe(17000);
	// Two refusals in a row still get there; a third gives up with the reason.
	const bad = {
		...designerReply,
		harness: { ...defaultHarness(), skills: [{ name: 'larga', description: 'd', instructions: 'z'.repeat(9000) }] },
	};
	queuedReplies.push(bad, bad);
	count = modelRequests.length;
	const twice = await designs.message(person, d.id, { text: 'Más detalle.', version: kept.version });
	expect(modelRequests.length).toBe(count + 3);
	queuedReplies.push(bad, bad, bad);
	await expect(designs.message(person, d.id, { text: 'Todavía más.', version: twice.version })).rejects.toThrow(
		'skill inválida',
	);
	queuedReplies.length = 0;
});
run('an improvement declared ready without a contract is sent back: it would apply nothing', async () => {
	const designs = await import('./designs'),
		agents = await import('./agents');
	const a = await agents.create(person, {
		name: 'Sin cambios',
		model: 'openai/gpt-6-sol',
		role: 'Revisa PRs por API.',
	});
	const d = await designs.create(person, { model: 'openai/gpt-6-sol', agentId: a.id });
	queuedReplies.push({ ...designerReply, contract: null, ready: true });
	const before = modelRequests.length;
	const fixed = await designs.message(person, d.id, { text: 'Usa el navegador para el monorepo.', version: d.version });
	expect(modelRequests.length).toBe(before + 2);
	expect(JSON.stringify(modelRequests.at(-1).input.slice(-1))).toContain('sin enviar el contrato');
	// Once the draft holds its own proposal, ready without a contract keeps it (no extra call).
	await exec('update agent_designs set contract = $2 where id = $1', [
		d.id,
		JSON.stringify({ name: 'Sin cambios', prompt: 'Revisa PRs del monorepo con el navegador.' }),
	]);
	queuedReplies.push({ ...designerReply, contract: null, ready: true });
	await designs.message(person, d.id, { text: 'Así está bien.', version: fixed.version });
	expect(modelRequests.length).toBe(before + 3);
	queuedReplies.length = 0;
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
	'interview attachments: images reach the model as images, text files inline (PDF and .docx: documents.test), nothing else is accepted',
	async () => {
		const designs = await import('./designs');
		const d = await designs.create(person, { model: 'openai/gpt-6-sol' });
		const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'),
			csv = Buffer.from('dia,monto\n1,100').toString('base64');
		await expect(
			designs.message(person, d.id, {
				text: 'x',
				version: 0,
				attachments: [{ name: 'a.zip', mime: 'application/zip', data: png }],
			}),
		).rejects.toThrow('imágenes');
		await expect(
			designs.message(person, d.id, {
				text: 'x',
				version: 0,
				attachments: [{ name: 'viejo.doc', mime: 'application/msword', data: png }],
			}),
		).rejects.toThrow('guárdalo como .docx o PDF');
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
		// A PDF: the designer reads its text; its file stays as it came.
		const stream = 'BT /F1 18 Tf 20 100 Td (Presupuesto semanal 2500) Tj ET';
		const pdf = Buffer.from(
			`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF`,
		).toString('base64');
		const withPdf = await designs.message(person, d.id, {
			text: 'Mis reglas',
			version: after.version,
			attachments: [{ name: 'reglas.pdf', mime: 'application/pdf', data: pdf }],
		});
		const read = modelRequests.at(-1).input.at(-1);
		expect(read.content.map((p: any) => p.type)).toEqual(['input_text', 'input_text']);
		expect(read.content[1].text).toContain('Presupuesto semanal 2500');
		expect(withPdf.messages.at(-2)!.attachments).toMatchObject([{ name: 'reglas.pdf', mime: 'application/pdf' }]);
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
run('a suggested access granted before the agent exists is granted when it is approved', async () => {
	const designs = await import('./designs'),
		accesses = await import('./accesses');
	const key = (await accesses.saveKey(person, { name: 'PRE_TOKEN', value: 'x', domains: 'api.example.com' })).find(
		(k) => k.name === 'PRE_TOKEN',
	)!;
	const reply = designerReply as typeof designerReply & { accesses?: unknown };
	reply.accesses = [{ kind: 'key', name: 'PRE_TOKEN', reason: 'Para la API' }];
	try {
		const d = await proposal();
		const accepted = await designs.grantSuggested(person, d.id, { kind: 'key', id: key.id });
		expect(accepted.accessSuggestions?.[0]).toMatchObject({ name: 'PRE_TOKEN', granted: false, accepted: true });
		expect((await accesses.listKeys(person)).find((k) => k.id === key.id)?.agents).toEqual([]);
		await attest(accepted as any);
		const approved = await designs.approve(person, d.id, accepted.version);
		expect((await accesses.listKeys(person)).find((k) => k.id === key.id)?.agents).toEqual([
			approved.applied_agent_id!,
		]);
		expect(approved.accessSuggestions?.[0]).toMatchObject({ granted: true });
	} finally {
		delete reply.accesses;
		await accesses.removeKey(person, key.id);
	}
});
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
		expect(ready.messages.find((m) => m.answers?.round === 1)?.answers?.values.sources.selected).toEqual([
			'clarify',
			'other',
		]);
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
		const first = await designs.message(person, d.id, {
			version: prose.version,
			answers: {
				round: pending.round,
				values: { scope: { selected: ['other'], other: 'Inventario es requisito; no reduzcas el objetivo.' } },
			},
		});
		// A new agent: one answered round is enough, with no platform round after it.
		const ready = first;
		expect(ready.ready).toBe(true);
		expect(ready.interview.completed).toBe(1);
		expect(ready.messages.find((m) => m.answers?.round === pending.round)?.answers?.values.scope.other).toContain(
			'Inventario es requisito',
		);
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
		// Editing a restore makes it an ordinary improvement (proposed straight away when it is clear).
		const changed = await designs.message(person, restore.id, { version: 0, text: 'Además cambia el objetivo.' });
		expect(changed.restored_revision).toBeNull();
		expect(changed.interview.phase).not.toBe('restore');
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

run(
	'trabajos: one objective per conversation; it ends, is evaluated by another agent, and the next one knows',
	async () => {
		const agents = await import('./agents');
		const inbox = await import('./inbox');
		const jobs = await import('./jobs');
		const evaluations = await import('./evaluations');
		const tag = crypto.randomUUID().slice(0, 8);
		const owner = (await row<{ id: number }>(
			"insert into people (name, key, avatar_seed) values ($1, $2, 's') returning id",
			[`Dueña ${tag}`, `job-${tag}`],
		))!.id;
		const model = (await import('./settings')).settings().models[0].id;
		const a = await agents.create(owner, { name: `Contratado ${tag}`, model });
		// A schedule's tick is a trabajo of its own: a new conversation, not the Principal.
		const tick = (await inbox.receive(
			{
				agentId: a.id,
				source: 'cron',
				text: 'Arma el reporte semanal.',
				scheduleName: 'semanal',
				job: { origin: 'cron', title: 'Reporte semanal' },
			},
			{ routeNow: false },
		))!;
		const first = (await row<{ conversation_id: number }>('select conversation_id from messages where id = $1', [
			tick.message_id,
		]))!.conversation_id;
		expect(await jobs.get(first)).toMatchObject({ status: 'open', origin: 'cron', is_default: false, goal: null });
		expect(await jobs.jobBlock(first)).toContain('Todavía no tiene objetivo declarado');
		// /goal from its owner sets the objective (the agent still reads the message).
		await inbox.receive(
			{
				agentId: a.id,
				source: 'web',
				personId: owner,
				conversationId: first,
				text: '/goal El reporte con ventas por región, en PDF',
			},
			{ routeNow: false },
		);
		expect((await jobs.get(first))!.goal).toBe('El reporte con ventas por región, en PDF');
		// /goal also turns on Modo objetivo, and the trabajo's list starts with its objective.
		const flowsMod = await import('./flows');
		expect((await row<{ on: boolean }>('select goal_mode as on from agents where id = $1', [a.id]))!.on).toBe(true);
		expect((await flowsMod.tasksOf(a.id, first)).tasks.map((t) => [t.key, t.status])).toEqual([
			['objetivo', 'pending'],
		]);
		// The agent meets it in a work and closes it with its summary; another agent evaluates it.
		const turn = (await row<{ id: number }>(
			`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status, tokens, started_at, ended_at, answer)
		 values ($1, $2, $3, $4, $5, 'done', 1200, now() - interval '5 minutes', now(), 'Listo: reporte.pdf') returning id`,
			[a.id, owner, first, `job-${tag}`, model],
		))!.id;
		await flowsMod.update(turn, { tarea: 'objetivo', estado: 'done', resultado: 'reporte.pdf' });
		const realAsk = evaluations.evaluator.ask;
		let evidence = '';
		evaluations.evaluator.ask = async (_p, _m, instructions, ev) => {
			evidence = ev;
			expect(instructions).toContain('no es evidencia');
			return {
				value: {
					scores: [
						{ key: 'correct', score: 4, justification: 'Entregó el PDF pedido.', evidence: [`turno #${turn}`] },
						{
							key: 'honesty',
							score: 2,
							justification: 'Dijo que incluía todas las regiones y faltó una.',
							evidence: ['resultado'],
						},
						{ key: 'third_parties', score: null, justification: 'Sin contactos externos.', evidence: [] },
					],
					comment: 'Cumplió, con un reporte incompleto.',
					suggestions: ['Que el contrato pida verificar las regiones antes de entregar.'],
					summary: 'Reporte semanal entregado en PDF; faltó una región.',
					lessons: [
						{ op: 'add', id: null, text: 'Antes de entregar el reporte, comprueba que estén todas las regiones.' },
					],
				},
				tokens: 900,
			};
		};
		expect((await jobs.done(turn, { resumen: '' })).error).toContain('resumen');
		// An independent auditor checks job_done against its objective: «not yet» comes back as its next step.
		const auditMod = await import('./audit');
		const realAudit = auditMod.auditor.ask;
		const verdicts: { verdict: 'met' | 'not_yet' | 'impossible'; reason: string }[] = [
			{ verdict: 'not_yet', reason: 'Falta la región norte en el reporte.' },
			{ verdict: 'met', reason: 'Entregó el reporte en PDF.' },
		];
		const audited: string[] = [];
		auditMod.auditor.ask = async (_p, _m, input) => {
			audited.push(input);
			return { value: verdicts.shift()!, tokens: 10 };
		};
		expect((await jobs.done(turn, { resumen: 'Hice el reporte de ventas por región en PDF.' })).error).toContain(
			'todavía no lo da por cumplido: Falta la región norte en el reporte.',
		);
		expect(audited[0]).toContain('Su afirmación al terminar (no es evidencia)');
		expect(
			await jobs.done(turn, {
				resumen: 'Hice el reporte de ventas por región en PDF.',
				resultado: { archivo: 'reporte.pdf' },
			}),
		).toMatchObject({
			ok: true,
			trabajo: first,
		});
		auditMod.auditor.ask = realAudit;
		await evaluations.idle(first);
		expect(evidence).toContain('El reporte con ventas por región');
		expect(evidence).toContain('su versión; no es evidencia');
		const e = (await evaluations.of(first))!;
		expect(e).toMatchObject({ status: 'done', comment: 'Cumplió, con un reporte incompleto.' });
		// Weighted over what it scored: correct 4 (weight 5) and honesty 2 (weight 5) → 30 of 40.
		expect(Number(e.overall)).toBe(75);
		expect((e.metrics as Record<string, number>).turns).toBe(1);
		// What it learned: a lesson of its own, in its next prompt, apart from its contract.
		const lessonsMod = await import('./lessons');
		expect(evidence).toContain('## Su playbook en este trabajo');
		expect((await lessonsMod.list(a.id)).map((l) => [l.text, l.conversation_id])).toEqual([
			['Antes de entregar el reporte, comprueba que estén todas las regiones.', first],
		]);
		expect((await lessonsMod.ofTrabajo(first)).taught).toMatchObject([
			{ op: 'add', text: 'Antes de entregar el reporte, comprueba que estén todas las regiones.' },
		]); // shown on the trabajo
		expect(await lessonsMod.countOf(first)).toBe(1); // its card
		// It ended: the web takes nothing more there until its owner reopens it.
		await expect(
			inbox.receive(
				{ agentId: a.id, source: 'web', personId: owner, conversationId: first, text: 'Y otra cosa' },
				{ routeNow: false },
			),
		).rejects.toThrow('ya terminó');
		expect(await jobs.reopen(first)).toBe(true);
		expect(await evaluations.of(first)).toBeNull(); // it will have another when it ends again
		await jobs.closeByPerson(first, 'Dueña');
		await evaluations.idle(first);
		expect((await jobs.get(first))!.end_reason).toBe('lo dio por terminado Dueña');
		// Learned again: the evaluator saw it (with its id) and the repeat counts as useful, not as a copy.
		expect(evidence).toMatch(/- \[\d+\] Antes de entregar el reporte/);
		expect((await lessonsMod.list(a.id)).map((l) => l.helpful)).toEqual([1]);
		expect(await lessonsMod.countOf(first)).toBe(1); // a repeat is not something new
		expect((await lessonsMod.ofTrabajo(first)).taught.map((t) => t.op)).toEqual(['add', 'helpful']);
		// The next trabajo, for the same person, starts knowing the one before.
		const next = (await inbox.receive(
			{ agentId: a.id, source: 'cron', text: 'Otro', scheduleName: 'semanal', job: { origin: 'cron', title: 'Otro' } },
			{ routeNow: false },
		))!;
		const second = (await row<{ conversation_id: number }>('select conversation_id from messages where id = $1', [
			next.message_id,
		]))!.conversation_id;
		expect(second).not.toBe(first);
		const block = await jobs.jobBlock(second);
		expect(block).toContain(`#${first}`);
		expect(block).toContain('Hice el reporte de ventas por región en PDF.');
		// The Principal is not a trabajo: it neither closes nor has an objective.
		const principal = (await row<{ id: number }>('select id from conversations where agent_id = $1 and is_default', [
			a.id,
		]))!.id;
		expect(await jobs.close(principal, 'closed', 'x')).toBe(false);
		expect(await jobs.jobBlock(principal)).toContain('no es un trabajo');
		// A day without activity closes it (not while something waits for someone).
		jobs.clock.now = () => new Date(Date.now() + 25 * 3600_000);
		expect(await jobs.sweep()).toBeGreaterThanOrEqual(1);
		expect((await jobs.get(second))!).toMatchObject({ status: 'closed', end_reason: 'sin actividad por 24 h' });
		jobs.clock.now = () => new Date();
		await evaluations.idle(second);
		evaluations.evaluator.ask = realAsk;
	},
);

run('a trabajo gets its playbook from the bank when it starts, and again when its objective changes', async () => {
	const agents = await import('./agents'),
		lessons = await import('./lessons');
	const a = await agents.create(person, { name: 'Playbook', model: 'openai/gpt-6-sol' });
	const conv = (await row<{ id: number }>(
		"insert into conversations (agent_id, pi_session_id, goal) values ($1, gen_random_uuid()::text, 'Cotizar las carnes de diciembre con Las Dos Marías') returning id",
		[a.id],
	))!.id;
	// The agent saves while it works; its owner teaches; secrets never go in; the same again is a confirmation.
	expect(await lessons.learn(a.id, conv, 'Las Dos Marías reparte martes y jueves de 9 a 15 h.')).toMatchObject({
		ok: true,
	});
	expect(await lessons.learn(a.id, conv, 'El cliente prefiere reportes en PDF.')).toMatchObject({ ok: true });
	expect((await lessons.learn(a.id, conv, 'La tarjeta es 4111 1111 1111 1111')).error).toContain('secreto');
	expect((await lessons.learn(a.id, conv, 'las dos marias reparte martes y jueves de 9 a 15 h')).nota).toContain(
		'Ya lo sabías',
	);
	await lessons.teach(a.id, conv, 'Miguel da el visto bueno; no pidas aprobación a Angel.');
	expect((await lessons.ofTrabajo(conv)).taught.map((t) => t.op)).toEqual(['learn', 'learn', 'teach']);
	// Its playbook: the pinned one, then what is about its objective, then the rest that fits.
	const first = await lessons.playbookFor(conv);
	expect(first.map((e) => [e.text.slice(0, 12), e.why])).toEqual([
		['Miguel da el', 'fijado'],
		['Las Dos Marí', 'relevante'],
		['El cliente p', 'reciente'],
	]);
	expect(lessons.playbookSection(first)).toContain('## Playbook');
	// A lesson learned later waits for the next picture; one pinned now is in it at once.
	await lessons.learn(a.id, null, 'Costco sólo arma carrito, no paga.');
	const pinned = await lessons.teach(a.id, null, 'Mensajes de una o dos frases.');
	const again = await lessons.playbookFor(conv);
	expect(again.some((e) => e.text.startsWith('Costco'))).toBe(false);
	expect(again.find((e) => e.id === pinned)?.why).toBe('fijado');
	// Its objective changes: it is put together again.
	await exec("update conversations set goal = 'Armar el carrito de Costco' where id = $1", [conv]);
	expect((await lessons.playbookFor(conv)).find((e) => e.text.startsWith('Costco'))?.why).toBe('relevante');
	expect(await lessons.countOf(conv)).toBe(3);
});
run(
	'avanzado: a harness tuned by hand is tested first; it applies if it passes and stays as it was if not',
	async () => {
		const agents = await import('./agents');
		const tune = await import('./harness-tune');
		const { defaultHarness } = await import('./harnesses');
		const { personalitySection } = await import('./personality');
		const a = await agents.create(person, { name: 'Afinado a mano', model: 'openai/gpt-6-sol' });
		await exec('update agents set harness_image = $2 where id = $1', [a.id, `sha256:${'a'.repeat(64)}`]);
		const realDocker = tune.tuning.docker,
			realPause = tune.tuning.pause;
		tune.tuning.pause = async () => {};
		const settle = async () => {
			for (let i = 0; i < 50; i++) {
				const t = await tune.latest(a.id);
				if (t && ['applied', 'failed'].includes(t.status)) return t;
				await Bun.sleep(20);
			}
			throw new Error('la prueba no terminó');
		};
		// It passes: its computer loads the harness as asked; a new revision, without the browser.
		const { harnessHash } = await import('./harnesses');
		const { runtimeToolNames } = await import('../../sandbox/harness');
		tune.tuning.docker = {
			probeHarness: async (_image: string, h: any) => ({
				digest: harnessHash(h),
				tools: runtimeToolNames(h),
				skills: h.skills.map((s: any) => s.name),
				plugins: h.plugins,
			}),
		} as any;
		const before = (await agents.get(a.id))!;
		const lean = { ...defaultHarness(), tools: defaultHarness().tools.filter((t) => t !== 'browser' && t !== 'login') };
		await tune.request(a.id, person, { harness: lean, summary: 'Quitó Navegador' });
		await expect(tune.request(a.id, person, { harness: lean })).rejects.toThrow('Ya hay un cambio en prueba');
		expect(await settle()).toMatchObject({
			status: 'applied',
			summary: 'Quitó Navegador',
			revision: before.config_revision + 1,
		});
		const after = (await agents.get(a.id))!;
		expect(after.harness.tools).not.toContain('browser');
		expect(after.config_revision).toBe(before.config_revision + 1);
		// It fails: the agent stays as it was, and its owner sees why.
		tune.tuning.docker = {
			probeHarness: async () => {
				throw new Error('El contenedor no arrancó\ndetalle con secretos');
			},
		} as any;
		await tune.request(a.id, person, { harness: defaultHarness() });
		expect(await settle()).toMatchObject({ status: 'failed', error: 'El contenedor no arrancó' });
		expect((await agents.get(a.id))!.config_revision).toBe(after.config_revision);
		expect((await agents.get(a.id))!.harness.tools).not.toContain('browser');
		// One the platform would not take fails at once, without a test.
		await expect(tune.request(a.id, person, { harness: { ...defaultHarness(), tools: ['read'] } })).rejects.toThrow();
		await expect(tune.request(a.id, person, { harness: after.harness })).rejects.toThrow('No hay cambios');
		tune.tuning.docker = realDocker;
		tune.tuning.pause = realPause;
		// Its personality: off the middle, a line each; at the middle, nothing.
		expect(personalitySection({ rigor: 5, proactividad: 3, autonomia: 4 })).toBe(
			'## Tu personalidad (la ajustó tu dueño)\n\n- Si tu contrato no lo dice, decide tú lo razonable y avisa después.\n- Sé meticuloso: comprueba dos veces cada dato, suma y fuente.',
		);
		expect(personalitySection({ proactividad: 3 })).toBe('');
		// How it sounds is its style: Cuby YOLO unless its owner picked another or wrote their own.
		const { soulOf, styleOf } = await import('../../shared/souls');
		expect(soulOf({})).toBe(styleOf('cuby-yolo').text);
		expect(soulOf({ style: 'pirate' })).toContain('Arrr');
		expect(soulOf({ style: 'pirate', soul: 'Hablas como yo.' })).toBe('Hablas como yo.');
		expect(styleOf('nada').key).toBe('cuby-yolo');
		// Its rank: the average of its evaluated trabajos, and each criterion's average.
		const evaluations = await import('./evaluations');
		expect(await evaluations.rank(a.id)).toBeNull();
		for (const [overall, score] of [
			[80, 3],
			[90, 4],
		]) {
			const conv = (await row<{ id: number }>(
				'insert into conversations (agent_id, pi_session_id) values ($1, gen_random_uuid()::text) returning id',
				[a.id],
			))!.id;
			await exec(
				"insert into job_evaluations (conversation_id, agent_id, status, overall, scores, done_at) values ($1, $2, 'done', $3, $4, now())",
				[
					conv,
					a.id,
					overall,
					JSON.stringify([
						{ key: 'correct', score, justification: '', evidence: [] },
						{ key: 'cost', score: null, justification: '', evidence: [] },
					]),
				],
			);
		}
		expect(await evaluations.rank(a.id)).toEqual({
			overall: 85,
			trabajos: 2,
			criteria: [{ key: 'correct', score: 3.5 }],
		});
	},
);
