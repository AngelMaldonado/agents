// The owner updates a computer to the platform's published image, never to an arbitrary npm pi.
// Probe in isolation first; recheck ownership, idleness and revision under the same row lock runs use.
import { randomUUID } from 'node:crypto';
import { row, exec, tx, type Exec } from './db';
import * as agents from './agents';
import { settings } from './settings';
import { definition, saveRevision, validateHarness, harnessHash } from './harnesses';
import { runtimeToolNames } from '../../sandbox/harness';
import { DockerSandbox, type SandboxImage } from './sandbox/docker';
import { maintenancePending, ComputerUpdating } from './computer-maintenance';
export class ImageUpdateWaiting extends Error {
	constructor(
		public reason: 'busy' | 'capacity',
		message: string,
	) {
		super(message);
	}
}
type UpdateContext = { jobId: string; target: ImageView; onPhase: (phase: 'validating' | 'applying') => Promise<void> };

type Docker = Pick<DockerSandbox, 'imageInfo' | 'imagePiVersion' | 'probeHarness'>;
type Catalog = {
	version: string | null;
	pi_version: string | null;
	development: boolean;
	revision: string | null;
	dirty: boolean | null;
	pi_recent: boolean;
};
const catalog = (id: string) =>
	row<Catalog>(
		`select version, pi_version, development, revision, dirty,
	coalesce(pi_checked_at > now()-interval '5 minutes', false) as pi_recent from sandbox_images where image_id=$1`,
		[id],
	);
export type ImageView = SandboxImage & { available: boolean; notesUrl: string | null };
const imageId = /^sha256:[a-f0-9]{64}$/;

export async function claimHarnessValidation(id: number, by: number) {
	const token = randomUUID();
	await tx(async (c) => {
		await exec("select pg_advisory_xact_lock(hashtext('agents.harness-validation'))", [], c);
		await exec('delete from sandbox_image_checks where expires_at <= now()', [], c);
		if (
			await row(
				`select 1 from sandbox_image_checks where agent_id=$1 or person_id=$2
			union all select 1 from agent_designs where person_id=$2 and validation_pending and busy_until > now()`,
				[id, by],
				c,
			)
		)
			throw new ImageUpdateWaiting('capacity', 'Ya hay una validación en curso para esta computadora o tu cuenta.');
		const count = (await row<{ n: number }>(
			`select
			(select count(*) from sandbox_image_checks) +
			(select count(*) from agent_designs where validation_pending and busy_until > now()) as n`,
			[],
			c,
		))!;
		if (count.n >= Math.min(2, settings().maxConcurrent))
			throw new ImageUpdateWaiting('capacity', 'Hay pruebas de harness en curso; reintenta al terminar.');
		await exec(
			`insert into sandbox_image_checks (agent_id, person_id, token, expires_at)
			values ($1,$2,$3,now()+interval '120 seconds')`,
			[id, by, token],
			c,
		);
	});
	return token;
}

async function owned(id: number, by: number, on?: Exec) {
	const a = await row<agents.Agent>(
		`select * from agents where id = $1 and deleted_at is null${on ? ' for update' : ''}`,
		[id],
		on,
	);
	if (!a || a.person_id !== by) throw new Error('Sólo el dueño actualiza la computadora.');
	return a;
}

async function idle(id: number, on?: Exec) {
	if (
		await row(
			"select 1 from runs where agent_id = $1 and status in ('queued','starting','running','blocked')",
			[id],
			on,
		)
	)
		throw new ImageUpdateWaiting(
			'busy',
			'Apaga la computadora y espera a que terminen sus trabajos antes de actualizar.',
		);
}

async function remember(info: SandboxImage, docker: Docker): Promise<ImageView> {
	if (!imageId.test(info.imageId)) throw new Error('La imagen no tiene un ID Docker inmutable.');
	const old = await catalog(info.imageId);
	let piVersion = info.piVersion ?? old?.pi_version ?? null;
	const checked = !piVersion && !old?.pi_recent;
	if (checked) piVersion = await docker.imagePiVersion(info.imageId).catch(() => null);
	const saved = (await row<Catalog>(
		`insert into sandbox_images (image_id, version, pi_version, development, revision, dirty, pi_checked_at)
		 values ($1,$2,$3,$4,$5,$6,case when $7 then now() else null end)
		 on conflict (image_id) do update set version=coalesce(excluded.version, sandbox_images.version),
		 pi_version=coalesce(excluded.pi_version, sandbox_images.pi_version),
		 development=excluded.development or sandbox_images.development,
		 revision=coalesce(excluded.revision, sandbox_images.revision), dirty=coalesce(excluded.dirty, sandbox_images.dirty),
		 pi_checked_at=coalesce(excluded.pi_checked_at, sandbox_images.pi_checked_at), seen_at=now()
		 returning version, pi_version, development, revision, dirty`,
		[info.imageId, info.version, piVersion, info.development, info.revision, info.dirty, checked],
	))!;
	return present(
		{
			...info,
			version: saved.version,
			piVersion: saved.pi_version,
			development: saved.development,
			revision: saved.revision,
			dirty: saved.dirty,
		},
		true,
	);
}

function present(info: SandboxImage, available: boolean): ImageView {
	return {
		...info,
		available,
		notesUrl:
			info.version && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(info.version)
				? `https://github.com/AngelMaldonado/agents/releases/tag/v${info.version}`
				: null,
	};
}

async function metadata(ref: string, docker: Docker, required = false): Promise<ImageView> {
	let info: SandboxImage;
	try {
		info = await docker.imageInfo(ref);
	} catch (err) {
		if (required)
			throw new Error(
				`La imagen de la release no está disponible. Pide al administrador que haga Pull en Komodo. ${(err as Error).message}`,
			);
		const old = await catalog(ref);
		return present(
			{
				imageId: ref,
				version: old?.version ?? null,
				piVersion: old?.pi_version ?? null,
				development: old?.development ?? false,
				revision: old?.revision ?? null,
				dirty: old?.dirty ?? null,
			},
			false,
		);
	}
	return remember(info, docker);
}

export const publishedImage = (docker: Docker = new DockerSandbox()) => metadata(settings().sandboxImage, docker, true);

export async function view(id: number, by: number, docker: Docker = new DockerSandbox()) {
	const a = await owned(id, by);
	const target = await metadata(settings().sandboxImage, docker, true);
	const current = a.harness_image
		? a.harness_image === target.imageId
			? target
			: await metadata(a.harness_image, docker)
		: null;
	return { revision: a.config_revision, current, target, updateAvailable: current?.imageId !== target.imageId };
}

export async function update(
	id: number,
	by: number,
	input: { revision?: unknown; imageId?: unknown },
	docker: Docker = new DockerSandbox(),
	context?: UpdateContext,
) {
	if (!Number.isSafeInteger(input.revision) || typeof input.imageId !== 'string' || !imageId.test(input.imageId))
		throw new Error('Recarga las versiones de la computadora antes de actualizar.');
	const before = await owned(id, by);
	if (before.config_revision !== input.revision)
		throw new Error('La configuración cambió. Recarga antes de actualizar.');
	if (!context && (await maintenancePending(id))) throw new ComputerUpdating();
	await idle(id);
	const token = await claimHarnessValidation(id, by);
	try {
		const target = context?.target ?? (await metadata(settings().sandboxImage, docker, true));
		if (target.imageId !== input.imageId)
			throw new Error('La imagen disponible cambió. Revisa la nueva versión antes de actualizar.');
		if (before.harness_image === target.imageId) return { agent: before, image: target };
		const h = validateHarness(before.harness);
		await context?.onPhase('validating');
		const runtime = await docker.probeHarness(target.imageId, h, process.env.AGENTS_INSTANCE ?? 'dev');
		if (
			runtime.digest !== harnessHash(h) ||
			JSON.stringify(runtime.tools) !== JSON.stringify(runtimeToolNames(h)) ||
			JSON.stringify(runtime.skills) !== JSON.stringify(h.skills.map((s) => s.name)) ||
			JSON.stringify(runtime.plugins) !== JSON.stringify(h.plugins)
		)
			throw new Error('La nueva imagen no cargó el harness aprobado. La computadora anterior no cambió.');
		// Resolve the moving tag again: only apply the exact target the owner reviewed, still published.
		if ((await docker.imageInfo(context ? target.imageId : settings().sandboxImage)).imageId !== target.imageId)
			throw new Error(
				context
					? 'La imagen destino cambió durante la prueba.'
					: 'La release cambió durante la prueba. Recarga antes de actualizar.',
			);
		await context?.onPhase('applying');
		const saved = await tx(async (c) => {
			const current = await owned(id, by, c);
			if (
				!(await row(
					'select 1 from sandbox_image_checks where agent_id=$1 and token=$2 and expires_at > now()',
					[id, token],
					c,
				))
			)
				throw new Error('La prueba caducó. Vuelve a validar antes de actualizar.');
			if (definition(current).digest !== definition(before).digest)
				throw new Error('La configuración cambió durante la prueba. No se aplicó la actualización.');
			await idle(id, c);
			if (!context && (await maintenancePending(id, c))) throw new ComputerUpdating();
			if (
				context &&
				!(await row(
					`select 1 from computer_update_items where job_id=$1 and agent_id=$2
				and status in ('validating','applying') for update`,
					[context.jobId, id],
					c,
				))
			)
				throw new Error('La actualización ya no está activa.');
			await exec(
				'update agents set harness_image=$2, config_revision=config_revision+1 where id=$1',
				[id, target.imageId],
				c,
			);
			const updated = (await agents.get(id, c))!;
			await saveRevision(updated, c);
			if (context) {
				await exec(
					`update computer_update_items set status='done', applied_revision=$3,
					error=null, updated_at=now() where job_id=$1 and agent_id=$2`,
					[context.jobId, id, updated.config_revision],
					c,
				);
				await exec('update computer_update_jobs set updated_at=now() where id=$1', [context.jobId], c);
			}
			return updated;
		});
		return { agent: saved, image: target };
	} finally {
		await exec('delete from sandbox_image_checks where agent_id=$1 and token=$2', [id, token]).catch((err) =>
			console.warn('could not release computer image validation:', (err as Error).message),
		);
	}
}
