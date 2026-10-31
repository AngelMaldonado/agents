import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { decrypt, encrypt, parseMasterKey, imageRevisionPlan, inputHash, checkSourceSnapshot } from './restore.mjs';
import { defaultHarness } from '../../sandbox/harness';

const decision = JSON.parse(readFileSync(new URL('../../deploy/image-transition.json', import.meta.url), 'utf8'));
const imageId = `sha256:${'a'.repeat(64)}`;
const active = {
	id: '10',
	person_id: '2',
	deleted_at: null,
	config_revision: 2,
	harness_image: `sha256:${'b'.repeat(64)}`,
	harness: defaultHarness(),
};
const probe = { agent: 10, ok: true, image: decision.sandboxImage, imageId, inputSha256: inputHash(active.harness) };
const context = { decision, probes: [probe], imageId };

test('operator authorizes existing beta image only in active-agent rehearsal; no owner approval is invented', () => {
	const retired = { ...active, id: '16', deleted_at: '2026-10-30T12:00:00Z' };
	const agents = [structuredClone(active), retired];
	const before = structuredClone(agents);
	expect(imageRevisionPlan(agents, context)).toEqual([
		{
			agent: 10,
			fromRevision: 2,
			toRevision: 3,
			fromImage: active.harness_image,
			image: imageId,
			imageRef: decision.sandboxImage,
		},
	]);
	expect(agents).toEqual(before);
	for (const [field, value] of Object.entries({
		id: 'other',
		release: '0.0.2',
		releaseSha: 'bad',
		sandboxImage: 'agents-sandbox:latest',
		scope: 'all-agents',
		authorizedBy: 'owner',
		execution: 'apply',
		cutoverAuthorized: true,
	}))
		expect(() => imageRevisionPlan([active], { ...context, decision: { ...decision, [field]: value } })).toThrow();
	for (const invalid of ['agents-sandbox:latest', `sha256:${'a'.repeat(63)}`, null])
		expect(() => imageRevisionPlan([active], { ...context, imageId: invalid })).toThrow();
});

test('image revision requires a unique passing probe bound to this exact harness and immutable image', () => {
	for (const probes of [
		[],
		[probe, probe],
		[{ ...probe, ok: false }],
		[{ ...probe, imageId: active.harness_image }],
		[{ ...probe, image: 'agents-sandbox:dev' }],
		[{ ...probe, inputSha256: 'bad' }],
		[{ ...probe, agent: 11 }],
	])
		expect(() => imageRevisionPlan([active], { ...context, probes })).toThrow();
	for (const a of [
		{ ...active, person_id: '1' },
		{ ...active, config_revision: 0 },
		{ ...active, config_revision: 2147483647 },
		{ ...active, harness: { ...active.harness, tools: ['bash'] } },
	])
		expect(() => imageRevisionPlan([a], context)).toThrow();
	expect(inputHash({ a: 1, b: { d: true, c: ['é', 1] } })).toBe(inputHash({ b: { c: ['é', 1], d: true }, a: 1 }));
});

test('source image drift is recorded without rewriting history or accepting unrelated definition changes', () => {
	const agent = { ...active, name: 'Fixture', role: 'Fixture role', model: 'fixture-model' };
	const snapshot = { ...agent, image: agent.harness_image };
	expect(checkSourceSnapshot(agent, snapshot)).toBe(null);
	expect(checkSourceSnapshot(agent, { ...snapshot, image: null })).toEqual({
		agent: 10,
		revision: 2,
		historicalImage: null,
		effectiveSourceImage: agent.harness_image,
	});
	for (const field of ['name', 'role', 'model', 'harness'])
		expect(() => checkSourceSnapshot(agent, { ...snapshot, [field]: 'changed' })).toThrow();
	expect(() => checkSourceSnapshot(agent, undefined)).toThrow();
	expect(snapshot.image).toBe(agent.harness_image);
});

test('master keys accept generated and quoted env values, reject ambiguity without echoing keys', () => {
	const key = randomBytes(32),
		value = key.toString('base64');
	for (const encoded of [value, `"${value}"`, `'${value}'`])
		expect(parseMasterKey(`# fixture\nAGENTS_MASTER_KEY=${encoded}\n`).equals(key)).toBe(true);
	for (const invalid of ['', 'AGENTS_MASTER_KEY=invalid', `AGENTS_MASTER_KEY=${value}\nAGENTS_MASTER_KEY=${value}`])
		expect(() => parseMasterKey(invalid)).toThrow();
});

test('re-encryption retains plaintext with a distinct key and rejects the wrong key/tampering', () => {
	const source = randomBytes(32),
		destination = randomBytes(32);
	for (const plain of [Buffer.from('fixture-only-token'), Buffer.alloc(0)]) {
		const original = encrypt(plain, source);
		const migrated = encrypt(decrypt(original, source), destination);
		expect(decrypt(migrated, destination).equals(plain)).toBe(true);
		expect(migrated).not.toBe(original);
		expect(() => decrypt(migrated, source)).toThrow();
		const parts = migrated.split('.');
		parts[2] = randomBytes(16).toString('base64url');
		expect(() => decrypt(parts.join('.'), destination)).toThrow();
	}
});

test('Python guardrails only admit source containers and readonly source mounts', () => {
	const source = `
import importlib.util
spec=importlib.util.spec_from_file_location('migration','scripts/deploy/remote.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
seen=[]
m.docker=lambda *a,**k:seen.append(a) or b'[]'
assert m.mount_arg({'Type':'volume','Name':'agents-dev-agent-10'},'/input').endswith(',readonly')
assert seen==[('volume','inspect','agents-dev-agent-10')]
assert m.mount_arg({'Type':'bind','Source':'/srv/agents/data'},'/input').endswith(',readonly')
for value in [{'Type':'bind','Source':'/tmp/a,b'},{'Type':'bind','Source':'relative'},{'Type':'unknown'}]:
 try:m.mount_arg(value,'/input');raise AssertionError('unsafe mount admitted')
 except ValueError:pass
for name in ['agents-server-1','postgres','agents-migration-123']:
 try:m.sql(name,'SELECT 1');raise AssertionError('unsafe source admitted')
 except ValueError:pass
m.sql('agents-dev-postgres-1','SELECT 1')
assert 'default_transaction_read_only=on' in seen[-1][3]
assert m.approved_data_mount('agents-dev-server-1',{'Type':'volume','Name':'agents-dev_data','Destination':'/data'})
assert m.approved_data_mount('agents-server-1',{'Type':'bind','Source':'/srv/agents/data','Destination':'/data'})
try:m.approved_data_mount('agents-server-1',{'Type':'bind','Source':'/','Destination':'/data'});raise AssertionError('host root admitted')
except ValueError:pass
seen.clear()
payload={'program':'fixture','worker':'fixture','tools':'not-approved','app':'not-approved','sandbox':'not-approved'}
r=m.main(payload)
assert not r['ok'] and not seen and not r['cleanupFailures']
`;
	const result = spawnSync('python3', ['-B', '-c', source], {
		encoding: 'utf8',
		cwd: new URL('../..', import.meta.url),
	});
	expect(result.stderr).toBe('');
	expect(result.status).toBe(0);
});

test('no application launch or cutover, isolated socket and pinned tools only', () => {
	const remote = readFileSync(new URL('./remote.py', import.meta.url), 'utf8');
	const worker = readFileSync(new URL('./restore.mjs', import.meta.url), 'utf8');
	expect(remote).toContain('"readyForCutover": False');
	expect(remote).toContain('"--network", "none"');
	expect(remote).not.toContain('/var/run/docker.sock');
	expect(remote).not.toContain('compose", "up');
	expect(remote.indexOf('"probe-release-sandbox-before-image-transition"')).toBeLessThan(
		remote.indexOf('"isolated-database-transform"'),
	);
	expect(remote).toContain('where person_id<>1');
	expect(worker.indexOf("phase = 'new-image-revisions'")).toBeLessThan(worker.indexOf("db.query('COMMIT')"));
	expect(worker).toContain('historicalRevisionsUnchanged: true');
	expect(worker).toContain('retiredAgentsUnchanged: true');
	expect(worker).toContain('ownerApprovalsFabricated: false');
	expect(worker).toContain("host: '/socket'");
	expect(worker).toContain('r.db !== expected || r.addr !== null');
	expect(worker).not.toContain('DBOS.launch');
	expect(worker).not.toContain('src/index');
	expect(worker).toContain('select to_jsonb(p) as data');
	expect(worker).toContain('select to_jsonb(x) as data');
});
