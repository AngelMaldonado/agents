import { beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { imageVersion } from '../../web/src/lib/image-version';
import type { SandboxImage } from './sandbox/docker';

const url = process.env.AGENTS_TEST_DATABASE_URL;
const run = url ? test : test.skip;
process.env.AGENTS_DATA ??= '/tmp';
const db = url ? await import('./db') : null;
let owner = 0,
	other = 0;
const oldImage = `sha256:${randomBytes(32).toString('hex')}`;
const newImage = `sha256:${randomBytes(32).toString('hex')}`;

beforeAll(async () => {
	if (!db || !url) return;
	(await import('./test-database')).assertTestDatabase(url, db.DATABASE_URL);
	await db.migrate();
	for (const key of ['owner', 'other']) {
		const name = `image-${key}-${crypto.randomUUID()}`;
		const person = (await db.row<{ id: number }>(
			'insert into people (name,key,avatar_seed) values ($1,$1,$1) returning id',
			[name],
		))!;
		if (key === 'owner') owner = person.id;
		else other = person.id;
	}
});

async function fixture() {
	const agents = await import('./agents');
	const { settings } = await import('./settings');
	const { harnessHash } = await import('./harnesses');
	const { runtimeToolNames } = await import('../../sandbox/harness');
	const agent = await agents.create(owner, {
		name: 'Imagen',
		role: 'Conserva mi contrato.',
		model: settings().models[0].id,
		image: oldImage,
	});
	const runtime = {
		digest: harnessHash(agent.harness),
		tools: runtimeToolNames(agent.harness),
		skills: agent.harness.skills.map((s) => s.name),
		plugins: agent.harness.plugins,
	};
	const calls: string[] = [];
	const docker = {
		imageInfo: async (ref: string): Promise<SandboxImage> => ({
			imageId: ref === settings().sandboxImage ? newImage : oldImage,
			version: ref === settings().sandboxImage ? '0.0.7-beta' : '0.0.6-beta',
			piVersion: ref === settings().sandboxImage ? '1.5.0' : '1.4.0',
			development: false,
			revision: null,
			dirty: null,
		}),
		imagePiVersion: async (_image: string): Promise<string | null> => {
			throw new Error('An image with pi metadata must not be started.');
		},
		probeHarness: async (image: string) => {
			calls.push(image);
			return runtime;
		},
	};
	return { agent, docker, calls, agents, input: { revision: agent.config_revision, imageId: newImage } };
}

run('image update: versions, exact target probed, immutable new revision; role and harness unchanged', async () => {
	const { view, update } = await import('./image-updates');
	const f = await fixture();
	const info = await view(f.agent.id, owner, f.docker);
	expect(info.updateAvailable).toBe(true);
	expect(info.current?.piVersion).toBe('1.4.0');
	expect(info.target.piVersion).toBe('1.5.0');
	expect(info.target.notesUrl).toEndWith('/v0.0.7-beta');
	const r = await update(f.agent.id, owner, f.input, f.docker);
	expect(f.calls).toEqual([newImage]);
	expect(r.agent.harness_image).toBe(newImage);
	expect(r.agent.config_revision).toBe(f.agent.config_revision + 1);
	expect(r.agent.role).toBe(f.agent.role);
	expect(r.agent.harness).toEqual(f.agent.harness);
	expect(
		(
			await db!.rows<{ image: string }>('select image from agent_revisions where agent_id=$1 order by revision', [
				f.agent.id,
			])
		).map((r) => r.image),
	).toEqual([oldImage, newImage]);
	expect((await view(f.agent.id, owner, f.docker)).updateAvailable).toBe(false);
	const pinned = await (await import('./tasks')).pinnedImages();
	expect(pinned).toContain(oldImage);
	expect(pinned).toContain(newImage);
});

test('image labels: release, dev commit/dirty, and honest legacy identity', () => {
	const image = { imageId: oldImage, version: null, development: true, revision: 'a'.repeat(40), dirty: true };
	expect(imageVersion(image)).toBe('Dev · aaaaaaa (con cambios)');
	expect(imageVersion({ ...image, dirty: false })).toBe('Dev · aaaaaaa');
	expect(imageVersion({ ...image, revision: null })).toBe(`Dev · ${oldImage.slice(7, 14)}`);
	expect(imageVersion({ ...image, version: '0.0.7-beta' })).toBe('v0.0.7-beta');
	expect(imageVersion({ ...image, development: false, revision: null })).toBe('Versión desconocida');
});

run('image metadata: recover installed pi once, retain dev identity when tag/image disappear', async () => {
	const { view } = await import('./image-updates');
	const f = await fixture();
	const id = `sha256:${randomBytes(32).toString('hex')}`;
	await db!.exec('update agents set harness_image=$2 where id=$1', [f.agent.id, id]);
	const inspect = f.docker.imageInfo;
	f.docker.imageInfo = async () => ({
		imageId: id,
		version: null,
		piVersion: null,
		development: true,
		revision: null,
		dirty: null,
	});
	const reads: string[] = [];
	f.docker.imagePiVersion = async (image) => {
		reads.push(image);
		return '1.4.0';
	};
	const info = await view(f.agent.id, owner, f.docker);
	expect(info.updateAvailable).toBe(false);
	expect(info.current?.piVersion).toBe('1.4.0');
	expect(info.current?.development).toBe(true);
	expect(info.target.notesUrl).toBeNull();
	await view(f.agent.id, owner, f.docker);
	expect(reads).toEqual([id]);
	f.docker.imageInfo = async (ref) => {
		if (ref === id) throw new Error('No such image');
		return inspect(ref);
	};
	const missing = (await view(f.agent.id, owner, f.docker)).current!;
	expect(missing.available).toBe(false);
	expect(missing.development).toBe(true);
	expect(missing.piVersion).toBe('1.4.0');
});

run('image metadata: a failed pi read does not hide versions or retry on every menu open', async () => {
	const { view } = await import('./image-updates');
	const f = await fixture();
	const id = `sha256:${randomBytes(32).toString('hex')}`;
	f.docker.imageInfo = async () => ({
		imageId: id,
		version: null,
		piVersion: null,
		development: true,
		revision: null,
		dirty: null,
	});
	let reads = 0;
	f.docker.imagePiVersion = async () => {
		reads++;
		throw new Error('missing manifest');
	};
	expect((await view(f.agent.id, owner, f.docker)).target.piVersion).toBeNull();
	await view(f.agent.id, owner, f.docker);
	expect(reads).toBe(1);
});

run('image update: one validation per owner, expired crash leases recover', async () => {
	const { update } = await import('./image-updates');
	const f = await fixture();
	await db!.exec(
		`insert into sandbox_image_checks (agent_id,person_id,token,expires_at)
	 values ($1,$2,$3,now()+interval '120 seconds')`,
		[f.agent.id, owner, crypto.randomUUID()],
	);
	try {
		await expect(update(f.agent.id, owner, f.input, f.docker)).rejects.toThrow(/validación en curso/);
		expect(f.calls).toEqual([]);
		await db!.exec("update sandbox_image_checks set expires_at=now()-interval '1 second' where agent_id=$1", [
			f.agent.id,
		]);
		await update(f.agent.id, owner, f.input, f.docker);
		expect(await db!.row('select 1 from sandbox_image_checks where person_id=$1', [owner])).toBeNull();
	} finally {
		await db!.exec('delete from sandbox_image_checks where person_id=$1', [owner]);
	}
});

run('image update: owner only, reviewed revision and target required, no probe on rejection', async () => {
	const { view, update } = await import('./image-updates');
	const f = await fixture();
	await expect(view(f.agent.id, other, f.docker)).rejects.toThrow(/dueño/);
	await expect(update(f.agent.id, other, f.input, f.docker)).rejects.toThrow(/dueño/);
	await expect(update(f.agent.id, owner, { ...f.input, revision: 999 }, f.docker)).rejects.toThrow(/configuración/);
	await expect(update(f.agent.id, owner, { ...f.input, imageId: oldImage }, f.docker)).rejects.toThrow(
		/imagen disponible/,
	);
	expect(f.calls).toEqual([]);
	expect((await f.agents.get(f.agent.id))!.harness_image).toBe(oldImage);
});

run('image update: failed runtime leaves the approved image and revision untouched', async () => {
	const { update } = await import('./image-updates');
	const f = await fixture();
	f.docker.probeHarness = async () => {
		throw new Error('pi incompatible');
	};
	await expect(update(f.agent.id, owner, f.input, f.docker)).rejects.toThrow('pi incompatible');
	const unchanged = (await f.agents.get(f.agent.id))!;
	expect(unchanged.harness_image).toBe(oldImage);
	expect(unchanged.config_revision).toBe(f.agent.config_revision);
});

run('image update: a computer session starting during validation prevents applying it', async () => {
	const { update } = await import('./image-updates');
	const f = await fixture();
	const probe = f.docker.probeHarness;
	f.docker.probeHarness = async (image) => {
		const conv = (await db!.row<{ id: number }>('select id from conversations where agent_id=$1', [f.agent.id]))!;
		await db!.exec(
			`insert into runs (agent_id,person_id,conversation_id,workflow_id,model,status,kind)
		 values ($1,$2,$3,$4,$5,'running','browser')`,
			[f.agent.id, owner, conv.id, crypto.randomUUID(), f.agent.model],
		);
		return probe(image);
	};
	try {
		await expect(update(f.agent.id, owner, f.input, f.docker)).rejects.toThrow(/Apaga/);
		expect((await f.agents.get(f.agent.id))!.harness_image).toBe(oldImage);
	} finally {
		await db!.exec('delete from runs where agent_id=$1', [f.agent.id]);
	}
});

run('image update: a concurrent edit or moving release cannot apply an obsolete probe', async () => {
	const { update } = await import('./image-updates');
	const f = await fixture();
	const probe = f.docker.probeHarness;
	f.docker.probeHarness = async (image) => {
		await db!.exec('update agents set config_revision=config_revision+1 where id=$1', [f.agent.id]);
		return probe(image);
	};
	await expect(update(f.agent.id, owner, f.input, f.docker)).rejects.toThrow(/configuración cambió/);
	expect((await f.agents.get(f.agent.id))!.harness_image).toBe(oldImage);
	const moved = await fixture();
	const inspect = moved.docker.imageInfo;
	let reads = 0;
	moved.docker.imageInfo = async (ref) => ({ ...(await inspect(ref)), imageId: ++reads > 1 ? oldImage : newImage });
	await expect(update(moved.agent.id, owner, moved.input, moved.docker)).rejects.toThrow(/release cambió/);
	expect((await moved.agents.get(moved.agent.id))!.harness_image).toBe(oldImage);
});
