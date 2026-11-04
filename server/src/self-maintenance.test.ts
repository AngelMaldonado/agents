import { beforeAll, afterAll, expect, test, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { installPolicy, parseRepairDecision } from '../../shared/self-maintenance';
import { defaultHarness, runtimeToolNames } from '../../sandbox/harness';

const url = process.env.AGENTS_TEST_DATABASE_URL,
	run = url ? test : test.skip;
process.env.AGENTS_DATA ??= '/tmp';
process.env.AGENTS_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
const db = url ? await import('./db') : null;
const repair = await import('./self-maintenance'),
	agents = await import('./agents');
let by = 0,
	other = 0;
beforeAll(async () => {
	if (!db || !url) return;
	const { assertTestDatabase } = await import('./test-database');
	assertTestDatabase(url, db.DATABASE_URL, (await db.row<{ name: string }>('select current_database() as name'))!.name);
	await db.migrate();
	for (const who of ['owner', 'other']) {
		const name = `self-${who}-${randomUUID()}`;
		const p = (await db.row<{ id: number }>('insert into people(name,key,avatar_seed) values($1,$1,$1) returning id', [
			name,
		]))!;
		if (who === 'owner') by = p.id;
		else other = p.id;
	}
});
afterAll(async () => {
	if (db && by) {
		await db.exec('delete from agent_repairs where person_id=$1', [by]);
		await db.exec(
			'delete from agent_revisions where agent_id in(select id from agents where person_id=any($1::bigint[]))',
			[[by, other]],
		);
		await db.exec('delete from people where id=any($1::bigint[])', [[by, other]]);
	}
});
async function fixture(harness = defaultHarness()) {
	const a = await agents.create(by, {
		name: 'Reparador',
		role: 'Analiza documentos sin enviar nada.',
		model: (await import('./settings')).settings().models[0].id,
		harness,
		image: `sha256:${'a'.repeat(64)}`,
	});
	const conv = (await db!.row<{ id: number }>('select id from conversations where agent_id=$1', [a.id]))!.id;
	const t = (await db!.row<{ id: number }>(
		"insert into runs(agent_id,person_id,conversation_id,workflow_id,model,status,kind) values($1,$2,$3,$4,$5,'running','task') returning id",
		[a.id, by, conv, randomUUID(), a.model],
	))!;
	await db!.exec(
		"insert into messages(agent_id,person_id,conversation_id,run_id,source,text,routed_as,routed_at) values($1,$2,$3,$4,'web','Analiza','new_run',now())",
		[a.id, by, conv, t.id],
	);
	const input = {
		requestId: randomUUID(),
		reason: 'La configuración no permite la tarea; evidencia comprobada.',
		kind: 'configuration',
		role: 'Analiza documentos y conserva el avance.',
	};
	let probes = 0;
	const docker = {
		probeHarness: async (_image: string, raw: unknown) => {
			probes++;
			const h = (await import('./harnesses')).validateHarness(raw);
			return {
				digest: (await import('./harnesses')).harnessHash(h),
				tools: runtimeToolNames(h),
				skills: h.skills.map((s) => s.name),
				plugins: h.plugins,
			};
		},
	};
	return { a, conv, run: t.id, input, docker, probes: () => probes };
}

test('WhatsApp decisions must be explicit, exact, unquoted and bound to a proposal; policy is conservative', () => {
	expect(parseRepairDecision('AUTORIZAR RABCDEF123456')).toEqual({ code: 'RABCDEF123456', approve: true });
	expect(parseRepairDecision('rechazar rabcdef123456')?.approve).toBe(false);
	for (const text of [
		'sí',
		'ok',
		'> AUTORIZAR RABCDEF123456',
		'AUTORIZAR RABCDEF123456 y otra cosa',
		'Me dijo AUTORIZAR RABCDEF123456',
	])
		expect(parseRepairDecision(text)).toBeNull();
	expect(installPolicy([{ kind: 'npm', spec: 'csv-parse@6.1.0', name: null, sha256: null }]).automatic).toBe(true);
	expect(installPolicy([{ kind: 'npm', spec: 'unknown@1.0.0', name: null, sha256: null }]).automatic).toBe(false);
});
run(
	'diagnosis works without a running model, does not expose secret values, and stores only allowlisted runtime facts',
	async () => {
		const f = await fixture(),
			access = await import('./accesses');
		const keys = await access.saveKey(by, {
			name: `TEST_${f.a.id}`,
			value: 'secret-value-never-render',
			domains: ['api.example.com'],
		});
		await access.grantKey(by, keys.find((k) => k.name === `TEST_${f.a.id}`)!.id, [f.a.id]);
		const d = (await repair.agentRequest(f.run, {
			action: 'diagnosis_result',
			runtime: {
				tools: { ok: false },
				mcp: [{ name: 'fake', ok: false, detail: 'secret-value-never-render' }],
				undelivered: ['not-granted'],
			},
		})) as import('../../shared/self-maintenance').Diagnosis;
		expect(d.runtime?.toolsOk).toBe(false);
		expect(d.runtime?.mcp).toEqual([]);
		expect(d.runtime?.undelivered).toEqual([]);
		await db!.exec("update runs set status='error' where id=$1", [f.run]);
		const report = await repair.diagnose(f.a.id, by);
		expect(report.accesses.some((a) => a.granted)).toBe(true);
		expect(report.configuration.harness).toEqual(f.a.harness);
		expect(JSON.stringify(report)).not.toContain('secret-value-never-render');
		await expect(repair.diagnose(f.a.id, other)).rejects.toThrow('Sólo el dueño');
		expect((await agents.get(f.a.id))!.config_revision).toBe(f.a.config_revision);
	},
);
run('proposal is private and idempotent, concurrent duplicate requests do not create two plans', async () => {
	const f = await fixture();
	const [r, duplicate] = await Promise.all([repair.propose(f.run, f.input), repair.propose(f.run, f.input)]);
	expect(r.id).toBe(duplicate.id);
	expect(r.status).toBe('pending');
	await expect(repair.propose(f.run, { ...f.input, role: 'otro contrato' })).rejects.toThrow('otra propuesta');
	await expect(repair.getRepair(r.id, other)).rejects.toThrow('no disponible');
	await expect(repair.decide(r.id, other, true)).rejects.toThrow('no disponible');
	await expect(repair.decideCode(r.code, by, [f.a.id + 99999], true)).rejects.toThrow('grupo');
	expect((await agents.get(f.a.id))!.role).toBe(f.a.role);
});
run(
	'owner approval reserves the next idle window, validates the exact pinned image and resumes once without replaying the task',
	async () => {
		const f = await fixture(),
			r = await repair.propose(f.run, f.input);
		await repair.decideCode(r.code, by, [f.a.id], true);
		await repair.decide(r.id, by, true);
		expect(await (await import('./computer-maintenance')).maintenancePending(f.a.id)).not.toBeNull();
		expect(await repair.attemptRepair(r.id, f.docker)).toBe(false);
		expect(f.probes()).toBe(0);
		expect((await db!.row<{ status: string }>('select status from runs where id=$1', [f.run]))!.status).toBe('running');
		await db!.exec("update runs set status='done' where id=$1", [f.run]);
		expect(await repair.attemptRepair(r.id, f.docker)).toBe(true);
		expect(await repair.attemptRepair(r.id, f.docker)).toBe(true);
		const a = (await agents.get(f.a.id))!;
		expect(a.role).toBe(f.input.role);
		expect(a.harness_image).toBe(f.a.harness_image);
		expect(a.config_revision).toBe(f.a.config_revision + 1);
		expect(f.probes()).toBe(1);
		const continuations = await db!.rows<{ text: string; conversation_id: number }>(
			'select text,conversation_id from messages where dedupe_key=$1',
			[`repair:${r.id}`],
		);
		expect(continuations).toHaveLength(1);
		expect(continuations[0].conversation_id).toBe(f.conv);
		expect(continuations[0].text).toContain('No repitas envíos');
		expect(await (await import('./computer-maintenance')).maintenancePending(f.a.id)).toBeNull();
	},
);
run('stale revisions and failed probes never replace approved configuration or enqueue a continuation', async () => {
	const f = await fixture(),
		r = await repair.propose(f.run, f.input);
	await db!.exec('update agents set config_revision=config_revision+1 where id=$1', [f.a.id]);
	await expect(repair.decide(r.id, by, true)).rejects.toThrow('cambió');
	await repair.decide(r.id, by, false).catch(() => {});
	const g = await fixture(),
		p = await repair.propose(g.run, g.input);
	await repair.decide(p.id, by, true);
	await db!.exec("update runs set status='done' where id=$1", [g.run]);
	await repair.attemptRepair(p.id, {
		probeHarness: async () => {
			throw new Error('vendor body includes secret-token');
		},
	});
	const result = await repair.getRepair(p.id, by);
	expect(result.status).toBe('failed');
	expect(result.result).not.toContain('secret-token');
	expect((await agents.get(g.a.id))!.role).toBe(g.a.role);
	expect(await db!.row('select 1 from messages where dedupe_key=$1', [`repair:${p.id}`])).toBeNull();
});
run('granting an existing access only adds this agent; other grants and secret fields remain unchanged', async () => {
	const f = await fixture(),
		g = await fixture(),
		access = await import('./accesses');
	const key = (
		await access.saveKey(by, { name: `GRANT_${f.a.id}`, value: 'never-print', domains: ['api.example.com'] })
	).find((k) => k.name === `GRANT_${f.a.id}`)!;
	await access.grantKey(by, key.id, [g.a.id]);
	const r = await repair.propose(f.run, { ...f.input, kind: 'grant_key', accessId: key.id });
	expect(r.automatic).toBe(false);
	await repair.decide(r.id, by, true);
	await db!.exec("update runs set status='done' where id=$1", [f.run]);
	await repair.attemptRepair(r.id, f.docker);
	expect((await access.listKeys(by)).find((k) => k.id === key.id)!.agents.sort()).toEqual([f.a.id, g.a.id].sort());
	expect(JSON.stringify(await repair.getRepair(r.id, by))).not.toContain('never-print');
	const h = await fixture(),
		p = await repair.propose(h.run, { ...h.input, kind: 'grant_key', accessId: key.id });
	await repair.decide(p.id, by, true);
	await access.saveKey(by, { name: key.name, value: 'replacement-secret', domains: ['api.example.com'] });
	await db!.exec("update runs set status='done' where id=$1", [h.run]);
	await repair.attemptRepair(p.id, h.docker);
	expect((await repair.getRepair(p.id, by)).status).toBe('failed');
	expect((await access.listKeys(by)).find((k) => k.id === key.id)!.agents).not.toContain(h.a.id);
});
run(
	'ordinary managed installs use policy; unknown installs cannot execute before explicit approval and replay returns completed result',
	async () => {
		const f = await fixture();
		const r = await repair.propose(f.run, {
			...f.input,
			kind: 'install',
			packages: [{ kind: 'npm', spec: 'csv-parse@6.1.0', name: null, sha256: null }],
		});
		expect(r.automatic).toBe(true);
		expect(r.status).toBe('approved');
		const plan = await repair.installation(f.run, r.id);
		expect('packages' in plan).toBe(true);
		await repair.installationResult(f.run, r.id, true);
		expect('completed' in (await repair.installation(f.run, r.id))).toBe(true);
		const g = await fixture(),
			p = await repair.propose(g.run, {
				...g.input,
				kind: 'install',
				packages: [{ kind: 'npm', spec: 'large-unknown@1.0.0', name: null, sha256: null }],
			});
		await expect(repair.installation(g.run, p.id)).rejects.toThrow('no está autorizada');
		await repair.decide(p.id, by, false);
		await expect(repair.installation(g.run, p.id)).rejects.toThrow('no está autorizada');
	},
);
run(
	'WhatsApp sends the proposal only to the linked owner and accepts only that owner’s explicit decision',
	async () => {
		const f = await fixture(),
			wa = await import('./whatsapp'),
			sent: { group: string; text: string }[] = [];
		const bridge = Bun.serve({
			port: 0,
			fetch: async (req) => {
				sent.push((await req.json()) as { group: string; text: string });
				return Response.json({ ids: [] });
			},
		});
		const previousUrl = process.env.AGENTS_WHATSAPP_URL,
			previousSecret = process.env.AGENTS_WHATSAPP_SECRET;
		process.env.AGENTS_WHATSAPP_URL = bridge.url.origin;
		process.env.AGENTS_WHATSAPP_SECRET = 'test-only';
		try {
			const n = (await db!.row<{ id: number }>(
				"insert into whatsapp_numbers(owner_id,jid,status) values($1,$2,'linked') returning id",
				[by, randomUUID()],
			))!;
			const phone = '15551112222',
				guest = '15553334444',
				ownRef = randomUUID(),
				guestRef = randomUUID();
			await db!.exec(
				"insert into whatsapp_phones(number_id,phone,list,person_id) values($1,$2,'allow',$3),($1,$4,'allow',$5)",
				[n.id, phone, by, guest, other],
			);
			await db!.exec('insert into agent_shares(agent_id,person_id) values($1,$2)', [f.a.id, other]);
			const own = (await db!.row<{ id: number }>(
				"insert into whatsapp_groups(number_id,owner_id,phone,person_id,ref,title,status) values($1,$2,$3,$2,$4,'Owner','open') returning id",
				[n.id, by, phone, ownRef],
			))!;
			const shared = (await db!.row<{ id: number }>(
				"insert into whatsapp_groups(number_id,owner_id,phone,person_id,ref,title,status) values($1,$2,$3,$4,$5,'Shared','open') returning id",
				[n.id, by, guest, other, guestRef],
			))!;
			for (const g of [own, shared])
				await db!.exec(
					"insert into messages(agent_id,person_id,conversation_id,run_id,source,text,context,routed_at) values($1,$2,$3,$4,'whatsapp','context',$5,now())",
					[f.a.id, by, f.conv, f.run, JSON.stringify({ whatsapp: { number: n.id, group: g.id } })],
				);
			const r = await repair.propose(f.run, f.input);
			expect(sent.length).toBeGreaterThan(0);
			expect(sent.every((s) => s.group === ownRef)).toBe(true);
			expect(sent.map((s) => s.text).join('')).toContain(`AUTORIZAR ${r.code}`);
			const device = (await db!.row<{ jid: string }>('select jid from whatsapp_numbers where id=$1', [n.id]))!.jid;
			await wa.inbound({
				number: device,
				phone: guest,
				group: guestRef,
				id: randomUUID(),
				text: `AUTORIZAR ${r.code}`,
			});
			expect((await repair.getRepair(r.id, by)).status).toBe('pending');
			await wa.inbound({ number: device, phone, group: ownRef, id: randomUUID(), text: `AUTORIZAR ${r.code}` });
			expect((await repair.getRepair(r.id, by)).status).toBe('approved');
		} finally {
			bridge.stop(true);
			if (previousUrl === undefined) delete process.env.AGENTS_WHATSAPP_URL;
			else process.env.AGENTS_WHATSAPP_URL = previousUrl;
			if (previousSecret === undefined) delete process.env.AGENTS_WHATSAPP_SECRET;
			else process.env.AGENTS_WHATSAPP_SECRET = previousSecret;
		}
	},
);
run('a malformed stored harness is diagnosed and repairable without first validating the broken base', async () => {
	const f = await fixture();
	await db!.exec('update agents set harness=$2 where id=$1', [f.a.id, JSON.stringify({ version: 999, tools: [] })]);
	expect((await repair.diagnose(f.a.id, by)).findings.some((x) => x.code === 'harness' && x.level === 'error')).toBe(
		true,
	);
	const r = await repair.propose(f.run, { ...f.input, harness: defaultHarness() });
	await repair.decide(r.id, by, true);
	await db!.exec("update runs set status='done' where id=$1", [f.run]);
	await repair.attemptRepair(r.id, f.docker);
	expect((await repair.getRepair(r.id, by)).status).toBe('done');
	expect((await agents.get(f.a.id))!.harness.version).toBe(1);
});
run(
	'restricted harness, foreign requester, platform-runtime replacement and literal MCP secrets are rejected',
	async () => {
		const f = await fixture({
			...defaultHarness(),
			tools: ['read', 'request_help'],
			restrictions: { workspaceFilesOnly: true, readOnlyFiles: true, guidelines: [] },
		});
		await expect(
			repair.propose(f.run, {
				...f.input,
				kind: 'install',
				packages: [{ kind: 'npm', spec: 'csv-parse@6.1.0', name: null, sha256: null }],
			}),
		).rejects.toThrow('requiere bash');
		const g = await fixture();
		await db!.exec('update messages set person_id=$2 where run_id=$1', [g.run, other]);
		await expect(repair.propose(g.run, g.input)).rejects.toThrow('tarea del dueño');
		const h = await fixture();
		await expect(
			repair.propose(h.run, {
				...h.input,
				kind: 'install',
				packages: [{ kind: 'npm', spec: '@earendil-works/pi-coding-agent@1.5.0', name: null, sha256: null }],
			}),
		).rejects.toThrow('Computadora');
		await expect(
			repair.propose(h.run, {
				...h.input,
				harness: {
					...defaultHarness(),
					installs: [{ kind: 'npm', spec: '@earendil-works/pi-coding-agent@1.5.0', name: null, sha256: null }],
				},
			}),
		).rejects.toThrow('Computadora');
		await expect(
			repair.propose(h.run, {
				...h.input,
				harness: {
					...defaultHarness(),
					mcp: [
						{
							name: 'test',
							description: 'Test',
							transport: 'http',
							url: 'https://example.com',
							command: null,
							args: [],
							env: [],
							headers: [{ name: 'Authorization', value: 'secret' }],
							oauth: false,
						},
					],
				},
			}),
		).rejects.toThrow('referenciar');
	},
);
run(
	'incremental migration upgrades an already-applied initial 036 without inventing legacy request hashes',
	async () => {
		const schema = `repair_upgrade_${randomUUID().replaceAll('-', '')}`,
			id = randomUUID(),
			sql = readFileSync(new URL('../migrations/037_agent_repair_runtime.sql', import.meta.url), 'utf8');
		await db!.tx(async (c) => {
			await c.query(`create schema ${schema}`);
			await c.query(`set local search_path to ${schema},public`);
			await c.query('create table agent_repairs(id uuid primary key)');
			await c.query('insert into agent_repairs(id) values($1)', [id]);
			await c.query(sql);
			await c.query(sql);
			expect(
				(await db!.row<{ request_digest: string }>('select request_digest from agent_repairs where id=$1', [id], c))!
					.request_digest,
			).toBe(`legacy:${id}`);
			expect(await db!.row('select to_regclass($1) is not null as present', [`${schema}.agent_diagnoses`], c)).toEqual({
				present: true,
			});
			expect(
				(await db!.row<{ is_nullable: string }>(
					"select is_nullable from information_schema.columns where table_schema=$1 and table_name='agent_repairs' and column_name='request_digest'",
					[schema],
					c,
				))!.is_nullable,
			).toBe('NO');
			await c.query(`drop schema ${schema} cascade`);
		});
	},
);
run('legacy secret fields are redacted from both the chat proposal and its persisted before snapshot', async () => {
	const f = await fixture();
	const old = {
		...defaultHarness(),
		mcp: [
			{
				name: 'legacy',
				description: 'Legacy',
				transport: 'http',
				url: 'https://private-user:private-password@api.example.test/mcp?key=private-query',
				command: null,
				args: ['private-argument'],
				env: [],
				headers: [{ name: 'Authorization', value: 'private-header' }],
				oauth: false,
			},
		],
	};
	await db!.exec('update agents set harness=$2 where id=$1', [f.a.id, JSON.stringify(old)]);
	const r = await repair.propose(f.run, { ...f.input, harness: defaultHarness() });
	const diagnosis = await repair.diagnose(f.a.id, by);
	for (const value of ['private-user', 'private-password', 'private-query', 'private-header', 'private-argument']) {
		expect(JSON.stringify(r)).not.toContain(value);
		expect(JSON.stringify(diagnosis)).not.toContain(value);
		expect(JSON.stringify(await db!.row('select before from agent_repairs where id=$1', [r.id]))).not.toContain(value);
	}
});
run(
	'DBOS recovers an approved repair after restart while waiting for a run, and creates only one revision/continuation',
	async () => {
		await db!.exec(
			"update agent_repairs set status='rejected' where person_id=$1 and status in ('pending','approved','running')",
			[by],
		);
		const f = await fixture(),
			r = await repair.propose(f.run, f.input);
		await repair.decide(r.id, by, true);
		const { DBOS } = await import('@dbos-inc/dbos-sdk'),
			{ DockerSandbox } = await import('./sandbox/docker');
		const spy = spyOn(DockerSandbox.prototype, 'probeHarness').mockImplementation(f.docker.probeHarness);
		const schema = `dbos_repair_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
		const wait = async (predicate: () => Promise<boolean>) => {
			const deadline = Date.now() + 15000;
			while (!(await predicate())) {
				if (Date.now() > deadline) throw new Error('repair recovery timeout');
				await Bun.sleep(50);
			}
		};
		try {
			DBOS.setConfig({
				name: 'agents-self-repair-test',
				applicationVersion: 'repair-v1',
				systemDatabaseUrl: url!,
				systemDatabaseSchemaName: schema,
				runAdminServer: false,
				logLevel: 'error',
			});
			await DBOS.launch();
			await repair.recoverRepairs();
			await wait(async () => (await DBOS.getWorkflowStatus(`self-repair:${r.id}`))?.status === 'PENDING');
			await Bun.sleep(100);
			await DBOS.shutdown({ workflowCompletionTimeoutMS: 0 });
			expect((await repair.getRepair(r.id, by)).status).toBe('approved');
			expect(f.probes()).toBe(0);
			await db!.exec("update runs set status='done' where id=$1", [f.run]);
			await DBOS.launch();
			await repair.recoverRepairs();
			await repair.recoverRepairs();
			await wait(async () => {
				const result = await repair.getRepair(r.id, by);
				if (result.status === 'failed') throw new Error(result.result!);
				return result.status === 'done';
			});
			expect((await agents.get(f.a.id))!.config_revision).toBe(f.a.config_revision + 1);
			expect(f.probes()).toBe(1);
			expect((await db!.rows('select id from messages where dedupe_key=$1', [`repair:${r.id}`])).length).toBe(1);
		} finally {
			await DBOS.shutdown({ workflowCompletionTimeoutMS: 0 });
			spy.mockRestore();
			await db!.exec(`drop schema if exists ${schema} cascade`);
		}
	},
	30000,
);
