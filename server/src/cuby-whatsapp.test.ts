// cuby-whatsapp as a channel (#18), against a fake of the service: an admin turns it on with a key, a
// person links their phone by writing it, gets their group «Agentes <name>» with the company number, talks
// to their agent there and quotes its answers. Against the throwaway database.
import { afterAll, beforeAll, expect, test } from 'bun:test';

const url = process.env.AGENTS_TEST_DATABASE_URL;
const run = url ? test : test.skip;
process.env.AGENTS_DATA ??= '/tmp';
process.env.AGENTS_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');

// A made-up test key, built here so it never reads as a credential in the source.
const FAKE_TEST_KEY = ['cwk', 'test', 'fake-1234'].join('_');
const sent: Record<string, any>[] = [];
const closed: { id: string; text?: string }[] = [];
const groups: { title: string; members: string[]; listen: string }[] = [];
const added: { thread: string; add: string[] }[] = [];
let allowlist: { phone: string; label: string }[] = [];
let threads = 0;
const fake = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	async fetch(req) {
		if (!req.headers.get('authorization')?.startsWith('Bearer cwk_test_')) return Response.json({}, { status: 401 });
		const path = new URL(req.url).pathname;
		if (path === '/v1/me') return Response.json({ me: { id: 'x', connected: true } });
		if (path === '/v1/allowlist') {
			allowlist = (await req.json()).phones;
			return Response.json({ count: allowlist.length, added: 0, removed: 0 });
		}
		if (path === '/v1/events') {
			await Bun.sleep(200);
			return Response.json({ events: [], cursor: 0 });
		}
		if (path === '/v1/groups') {
			const body = await req.json();
			groups.push(body);
			return Response.json({
				threadId: `grp-${groups.length}`,
				group: { id: `${groups.length}@g.us`, title: body.title },
				members: body.members.map((phone: string) => ({ phone, status: 'added', reason: null })),
			});
		}
		if (path === '/v1/messages') {
			const body = await req.json();
			const id = crypto.randomUUID();
			sent.push({ ...body, id });
			return Response.json({
				id,
				status: 'queued',
				replayed: false,
				threadId: body.threadId ?? `thr-${++threads}`,
			});
		}
		const members = path.match(/^\/v1\/threads\/(.+)\/members$/);
		if (members) {
			const body = await req.json();
			added.push({ thread: members[1], add: body.add });
			return Response.json({
				threadId: members[1],
				added: body.add.map((phone: string) => ({ phone, status: 'added', reason: null })),
				removed: [],
			});
		}
		const close = path.match(/^\/v1\/threads\/(.+)\/close$/);
		if (close) {
			closed.push({ id: close[1], ...(await req.json()) });
			return Response.json({ ok: true });
		}
		return Response.json({ ok: true });
	},
});
process.env.AGENTS_CUBY_WHATSAPP_URL = `http://127.0.0.1:${fake.port}`;

const db = url ? await import('./db') : null;
let admin = 0,
	ana = 0;
beforeAll(async () => {
	if (!db || !url) return;
	const { assertTestDatabase } = await import('./test-database');
	assertTestDatabase(url, db.DATABASE_URL);
	await db.migrate();
	// The configuration is one row that outlives a run: start from a clean, switched-off one.
	await db.exec(
		"update cuby_whatsapp set enabled = false, mode = 'test', live_key = null, live_last4 = null, test_key = null, test_last4 = null, daily_per_person = 100, shown_phone = '', cursor = 0",
	);
	await db.exec('delete from whatsapp_link_codes');
	await db.exec('update whatsapp_numbers set groups = false'); // the company number hosts the groups here
	const tag = crypto.randomUUID().slice(0, 8);
	const person = async (name: string) =>
		(await db.row<{ id: number }>('insert into people (name, key, avatar_seed) values ($1, $2, $3) returning id', [
			`${name}-${tag}`,
			`${name}-${tag}`,
			's',
		]))!.id;
	admin = await person('admin');
	ana = await person('ana');
});
afterAll(async () => {
	if (!db) return;
	const cuby = await import('./cuby-whatsapp');
	await cuby.configure({ id: admin } as never, { enabled: false }).catch(() => {});
	fake.stop(true);
});

run('the company number: link a phone, get a group «Agentes …» with your agents, talk and quote there', async () => {
	const cuby = await import('./cuby-whatsapp'),
		whatsapp = await import('./whatsapp'),
		agents = await import('./agents');
	const me = { id: admin, admin: true } as never;
	await expect(cuby.configure(me, { enabled: true, mode: 'test' })).rejects.toThrow('Falta la llave de prueba');
	await expect(cuby.configure(me, { testKey: 'cwk_live_x' })).rejects.toThrow('no es una llave de prueba');
	const view = await cuby.configure(me, {
		testKey: FAKE_TEST_KEY,
		mode: 'test',
		enabled: true,
		shownPhone: '+52 444 000 1111',
	});
	expect(view).toMatchObject({
		enabled: true,
		mode: 'test',
		testKey: '1234',
		liveKey: null,
		shownPhone: '524440001111',
	});
	expect(JSON.stringify(view)).not.toContain(FAKE_TEST_KEY); // the key never comes back
	const number = (await db!.row<{ id: number }>("select id from whatsapp_numbers where provider = 'cuby'"))!.id;

	// Ana links her phone by writing it (no code): it is hers in the integration's list at once.
	const anaP = { id: ana, admin: false } as never;
	expect((await cuby.startLink(anaP, { phone: '+52 444 222 3333' })).linked).toBe('524442223333');
	expect(allowlist.map((p) => p.phone)).toContain('+524442223333');
	// Nobody else takes it, nor the company number itself.
	await expect(cuby.startLink({ id: admin, admin: true } as never, { phone: '+52 444 222 3333' })).rejects.toThrow(
		'otra persona',
	);
	await expect(cuby.startLink({ id: admin, admin: true } as never, { phone: '+52 444 000 1111' })).rejects.toThrow(
		'número de la empresa',
	);
	const event = (text: string, id = crypto.randomUUID()) =>
		cuby.handle({
			id: 1,
			event: 'message.received',
			mode: 'test',
			data: { messageId: id, from: '+5214442223333', kind: 'text', text, fromName: 'Ana' },
		});

	// With an agent of hers, her group with the company number appears, titled with her name.
	const a = await agents.create(ana, { name: 'Cuby Compras', model: 'openai/gpt-6-sol' });
	await whatsapp.syncGroups();
	const mine = groups.find((g) => g.members[0] === '+524442223333');
	expect(mine).toMatchObject({ title: expect.stringMatching(/^Agentes ana-/), listen: 'all' });
	const thread = `grp-${groups.indexOf(mine!) + 1}`;
	expect(sent.at(-1)).toMatchObject({ threadId: thread, text: expect.stringContaining('1. Cuby Compras') });
	// One to one, the company number only says where the agents are.
	await event('/agentes');
	expect(sent.at(-1)).toMatchObject({ to: '+5214442223333', text: expect.stringContaining('grupos «Agentes …»') });
	// In the group, what she writes goes to her only agent, and she is its owner.
	const inGroup = (text: string, inReplyTo?: string) =>
		cuby.handle({
			id: 2,
			event: 'message.received',
			mode: 'test',
			data: {
				messageId: crypto.randomUUID(),
				from: '+5214442223333',
				threadId: thread,
				group: { id: 'x@g.us', name: 'Agentes' },
				kind: 'text',
				text,
				fromName: 'Ana',
				inReplyTo,
			},
		});
	await inGroup('Revisa el súper');
	const msg = await db!.row<{
		agent_id: number;
		person_id: number;
		source: string;
		sender: string;
		conversation_id: number;
	}>(
		'select agent_id, person_id, source, sender, conversation_id from messages where agent_id = $1 order by id desc limit 1',
		[a.id],
	);
	expect(msg).toMatchObject({
		agent_id: a.id,
		person_id: ana,
		source: 'whatsapp',
		sender: expect.stringMatching(/ \(\+524442223333\), tu dueño$/), // she owns it: it may take her authorizations
	});
	// Its answers go into the group under its name; quoting one goes back to its conversation.
	const runId = (await db!.row<{ id: number }>(
		`insert into runs (agent_id, person_id, conversation_id, workflow_id, model, status, answer)
		 values ($1, $2, $3, $4, 'openai/gpt-6-sol', 'done', 'Ya revisé.') returning id`,
		[a.id, ana, msg!.conversation_id, `cuby-run-${a.id}`],
	))!.id;
	await db!.exec('update messages set run_id = $2 where agent_id = $1 and run_id is null', [a.id, runId]);
	await whatsapp.onRun(runId, 'done');
	const answer = sent.at(-1)!;
	expect(answer).toMatchObject({ threadId: thread, text: '*Cuby Compras:* Ya revisé.' });
	await inGroup('¿Y los precios?', answer.id);
	expect(
		(await db!.row<{ conversation_id: number }>(
			'select conversation_id from messages where agent_id = $1 order by id desc limit 1',
			[a.id],
		))!.conversation_id,
	).toBe(msg!.conversation_id);
	// A file the service would refuse (an HTML report) goes zipped when it is the only one…
	const html = { name: 'reporte.html', mime: 'text/html', data: Buffer.from('<h1>Hola</h1>').toString('base64') };
	await cuby.sendGroup(thread, '', [html]);
	expect(sent.at(-1)?.document.fileName).toBe('reporte.html.zip');
	expect(Buffer.from(sent.at(-1)!.document.base64, 'base64').subarray(0, 4).toString('hex')).toBe('504b0304');
	// …and is left out next to a PDF of the same result.
	const before = sent.length;
	await cuby.sendGroup(thread, '', [
		html,
		{ name: 'reporte.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64') },
	]);
	expect(sent.slice(before).map((m) => m.document.fileName)).toEqual(['reporte.pdf']);
	// Out of it by the list (her phone left and came back): the next pass puts her back, with the welcome.
	// Not when she left on her own.
	const left = (by: string) =>
		cuby.handle({
			id: 3,
			event: 'group.member_left',
			mode: 'test',
			data: { threadId: thread, phone: '+5214442223333', by, group: { id: 'x', name: 'Agentes', size: 1 } },
		});
	await left('self');
	await whatsapp.syncGroups();
	expect(added).toEqual([]);
	await left('list');
	await whatsapp.syncGroups();
	expect(added).toEqual([{ thread, add: ['+524442223333'] }]);
	expect(sent.at(-1)).toMatchObject({ threadId: thread, text: expect.stringContaining('1. Cuby Compras') });
	expect(await db!.row('select member_out from whatsapp_groups where ref = $1', [thread])).toEqual({
		member_out: null,
	});

	// Her phone leaves and comes back (Cuby may say `self` for that): the reopened group takes her back.
	added.length = 0;
	await cuby.unlink(anaP);
	await whatsapp.syncGroups();
	await left('self');
	await cuby.startLink(anaP, { phone: '+52 444 222 3333' });
	await whatsapp.syncGroups();
	expect(added).toEqual([{ thread, add: ['+524442223333'] }]);

	// Without agents of hers, the group closes with a line.
	await db!.exec('update agents set deleted_at = now() where id = $1', [a.id]);
	await whatsapp.syncGroups();
	expect(closed.at(-1)).toEqual({ id: thread, text: expect.stringContaining('Ya no hay agentes de') });

	// Agents' own cap per person and day.
	await cuby.configure(me, { dailyPerPerson: 1 });
	await db!.exec('delete from cuby_whatsapp_usage where person_id = $1', [ana]);
	await cuby.send('524442223333', 'uno', [], { personId: ana });
	await expect(cuby.send('524442223333', 'dos', [], { personId: ana })).rejects.toThrow('tope de 1');
	// The admins switch the company number off here, not by removing it.
	await expect(whatsapp.remove(me, number)).rejects.toThrow('Administración');
});
