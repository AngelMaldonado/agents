// SandboxProvider on the Docker Engine API, over the unix socket with Bun's fetch.
// The sandbox dials out to the backend (see sandbox/supervisor.mjs), so nothing here attaches
// to a container's stdio or reaches into its ports.
import { readFile } from 'node:fs/promises';
import type { SandboxProvider, SandboxSpec, SandboxInfo, SandboxStats, HostInfo } from './provider';

const SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';
const API = 'http://docker/v1.45';
const NETWORK = process.env.AGENTS_SANDBOX_NETWORK ?? 'agents-sandbox';
// Public resolvers: the sandbox bridge is egress-locked away from the LAN, its DNS included.
const DNS = (process.env.AGENTS_SANDBOX_DNS ?? '1.1.1.1,9.9.9.9').split(',').filter(Boolean);

async function call(method: string, path: string, body?: unknown, ok: number[] = [], timeout?: number) {
	const res = await fetch(`${API}${path}`, {
		method,
		signal: timeout ? AbortSignal.timeout(timeout) : undefined,
		unix: SOCKET,
		headers: body ? { 'content-type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	} as RequestInit);
	if (!res.ok && !ok.includes(res.status)) {
		throw new Error(`docker ${method} ${path}: ${res.status} ${await res.text()}`);
	}
	const text = await res.text();
	return text ? JSON.parse(text) : null;
}

export type SandboxImage = {
	imageId: string;
	version: string | null;
	piVersion: string | null;
	development: boolean;
	revision: string | null;
	dirty: boolean | null;
};
const semver = (value: unknown) =>
	typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value) ? value : null;
const piReads = new Map<string, Promise<string | null>>();

export class DockerSandbox implements SandboxProvider {
	/** Local Docker image identity, distinct from a registry manifest digest. No pull or execution. */
	async imageInfo(image: string): Promise<SandboxImage> {
		const info = await call('GET', `/images/${encodeURIComponent(image)}/json`, undefined, [], 10000);
		const labels = info.Config?.Labels ?? {};
		const version = semver(labels['org.opencontainers.image.version']);
		const revision = labels['org.opencontainers.image.revision'];
		return {
			imageId: info.Id,
			version,
			piVersion: semver(labels['io.cuby.agents.pi.version']),
			development:
				!version &&
				(labels['org.opencontainers.image.version'] === 'dev' ||
					(info.RepoTags ?? []).some((tag: string) => tag.endsWith(':dev'))),
			revision: typeof revision === 'string' && /^[a-f0-9]{40}$/.test(revision) ? revision : null,
			dirty: ['true', 'false'].includes(labels['io.cuby.agents.dirty'])
				? labels['io.cuby.agents.dirty'] === 'true'
				: null,
		};
	}

	/**
	 * Read the installed package manifest, not pi's CLI or the supervisor. No network, state or secrets. Images
	 * on Bun keep pi among Bun's global packages and answer `node` with Bun; older ones ran on Node and npm.
	 */
	async imagePiVersion(image: string): Promise<string | null> {
		if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Se requiere el ID inmutable de la imagen.');
		const pending = piReads.get(image);
		if (pending) return pending;
		if (piReads.size >= 2) throw new Error('Hay lecturas de versión en curso.');
		const read = this.readImagePiVersion(image);
		piReads.set(image, read);
		try {
			return await read;
		} finally {
			piReads.delete(image);
		}
	}

	private async readImagePiVersion(image: string): Promise<string | null> {
		const created = await call(
			'POST',
			'/containers/create',
			{
				Image: image,
				Entrypoint: ['node'],
				Cmd: [
					'--input-type=commonjs',
					'-e',
					`const fs=require('node:fs'),f=['/usr/local/lib/bun-global/node_modules','/usr/local/lib/node_modules'].map((d)=>d+'/@earendil-works/pi-coding-agent/package.json').find((x)=>fs.existsSync(x)); if(!f)process.exit(1); const p=JSON.parse(fs.readFileSync(f,'utf8')); if(p.name!=='@earendil-works/pi-coding-agent')process.exit(1); process.stdout.write(String(p.version));`,
				],
				User: 'agent',
				Tty: true,
				WorkingDir: '/tmp',
				Healthcheck: { Test: ['NONE'] },
				Labels: { 'agents.image-metadata': process.env.AGENTS_INSTANCE ?? 'dev' },
				HostConfig: {
					NetworkMode: 'none',
					ReadonlyRootfs: true,
					CapDrop: ['ALL'],
					SecurityOpt: ['no-new-privileges'],
					Memory: 128 * 1024 * 1024,
					MemorySwap: 128 * 1024 * 1024,
					NanoCpus: 5e8,
					PidsLimit: 16,
					LogConfig: { Type: 'json-file', Config: { 'max-size': '16k', 'max-file': '1' } },
				},
			},
			[],
			5000,
		);
		try {
			await call('POST', `/containers/${created.Id}/start`, undefined, [], 5000);
			const deadline = Date.now() + 5000;
			let state;
			do {
				state = (await call('GET', `/containers/${created.Id}/json`, undefined, [], 5000)).State;
				if (!state.Running) break;
				if (Date.now() >= deadline) throw new Error('La lectura de versión agotó 5 segundos.');
				await new Promise((resolve) => setTimeout(resolve, 100));
			} while (true);
			if (state.ExitCode !== 0) return null;
			const logs = await fetch(`${API}/containers/${created.Id}/logs?stdout=true&tail=1`, {
				unix: SOCKET,
				signal: AbortSignal.timeout(5000),
			} as RequestInit);
			if (!logs.ok) throw new Error('No se pudo leer la versión instalada.');
			return semver((await logs.text()).trim());
		} finally {
			await call('DELETE', `/containers/${created.Id}?force=true&v=true`, undefined, [404], 5000);
		}
	}

	async imageId(image: string): Promise<string> {
		return (await call('GET', `/images/${encodeURIComponent(image)}/json`, undefined, [], 10000)).Id;
	}

	/** Only a digest already associated with the platform's local image; never a caller-supplied registry. */
	async imagePullRef(imageId: string, platformRef: string): Promise<string | null> {
		const image = await call('GET', `/images/${encodeURIComponent(imageId)}/json`, undefined, [], 10000);
		const repo = platformRef.split('@')[0].replace(/:[^/:]+$/, '');
		return (
			(image.RepoDigests ?? []).find(
				(ref: string) => ref.startsWith(`${repo}@`) && /@sha256:[a-f0-9]{64}$/.test(ref),
			) ?? null
		);
	}

	async pullImage(ref: string, progress: (message: string) => Promise<void>) {
		if (!/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(ref))
			throw new Error('La descarga requiere un digest de registry fijo.');
		const response = await fetch(`${API}/images/create?fromImage=${encodeURIComponent(ref)}`, {
			unix: SOCKET,
			method: 'POST',
			signal: AbortSignal.timeout(10 * 60_000),
		} as RequestInit);
		if (!response.ok || !response.body)
			throw new Error(
				`No se pudo descargar la imagen (${response.status}). Si el registry requiere acceso, pide Pull en Komodo.`,
			);
		const reader = response.body.getReader(),
			decoder = new TextDecoder();
		let buffer = '',
			last = 0;
		const line = async (text: string) => {
			if (!text.trim()) return;
			const event = JSON.parse(text);
			if (event.errorDetail?.message || event.error)
				throw new Error(String(event.errorDetail?.message ?? event.error).slice(0, 1000));
			if (Date.now() - last < 1000 || !event.status) return;
			last = Date.now();
			const bytes = event.progressDetail;
			const detail =
				Number.isFinite(bytes?.current) && Number.isFinite(bytes?.total) && bytes.total > 0
					? ` · ${bytes.current} / ${bytes.total} bytes`
					: '';
			await progress(
				`${String(event.status).slice(0, 120)}${event.id ? ` · ${String(event.id).slice(0, 64)}` : ''}${detail}`,
			);
		};
		try {
			while (true) {
				const { value, done } = await reader.read();
				buffer += decoder.decode(value, { stream: !done });
				if (buffer.length > 1024 * 1024) throw new Error('Respuesta de descarga demasiado grande.');
				let end;
				while ((end = buffer.indexOf('\n')) >= 0) {
					await line(buffer.slice(0, end));
					buffer = buffer.slice(end + 1);
				}
				if (done) {
					await line(buffer);
					break;
				}
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
	}

	/** Only platform-owned code, fresh tmpfs, no volumes/secrets/network/model requests. */
	async probeHarness(imageId: string, harness: unknown, instance: string) {
		const created = await call(
			'POST',
			'/containers/create',
			{
				Image: imageId,
				// `node` is Node in older images and Bun's stand-in in newer ones: the same call probes both.
				Entrypoint: ['node', '/opt/agents/harness-probe.mjs'],
				Cmd: [],
				User: 'agent',
				Tty: true,
				Env: [`AGENTS_HARNESS=${JSON.stringify(harness)}`],
				Labels: { 'agents.instance': instance, 'agents.harness-validation': 'true' },
				HostConfig: {
					NetworkMode: 'none',
					ReadonlyRootfs: true,
					CapDrop: ['ALL'],
					SecurityOpt: ['no-new-privileges'],
					Memory: 512 * 1024 * 1024,
					MemorySwap: 512 * 1024 * 1024,
					NanoCpus: 1e9,
					PidsLimit: 64,
					Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=64m,mode=1777' },
					LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
				},
			},
			[],
			10000,
		);
		try {
			await call('POST', `/containers/${created.Id}/start`, undefined, [], 10000);
			const deadline = Date.now() + 35000;
			while ((await call('GET', `/containers/${created.Id}/json`, undefined, [], 5000)).State.Running) {
				if (Date.now() > deadline) throw new Error('La prueba aislada agotó 35 segundos.');
				await new Promise((r) => setTimeout(r, 200));
			}
			const response = await fetch(`${API}/containers/${created.Id}/logs?stdout=true&stderr=true&tail=100`, {
				unix: SOCKET,
				signal: AbortSignal.timeout(10000),
			} as RequestInit);
			const logs = await response.text();
			const marker = logs.split(/\r?\n/).find((line) => line.startsWith('AGENTS_HARNESS_PROBE '));
			// An image older than the contract does not know its newer parts (encargos, flujos, a new tool):
			// its own validation refuses the whole manifest. Said so, not as a stack trace.
			if (!marker && /Harness: (campos no admitidos|elige herramientas del catálogo)/.test(logs))
				throw new Error(
					`La imagen de computadora con que se probó (${imageId.replace(/^sha256:/, '').slice(0, 12)}) es anterior a este contrato: no conoce algo de él (por ejemplo, encargos, flujos o una herramienta nueva). Hay que construir o publicar la imagen nueva (en dev: just sandbox build) y volver a probar.`,
				);
			if (!marker) throw new Error(`La imagen no confirmó la prueba del harness: ${logs.slice(-1000)}`);
			const report = JSON.parse(marker.slice('AGENTS_HARNESS_PROBE '.length));
			if (!report.ok) throw new Error(String(report.error ?? 'pi no cargó el harness.').slice(0, 1000));
			return report.runtime as { digest: string; tools: string[]; skills: string[]; plugins: unknown[] };
		} finally {
			await call('DELETE', `/containers/${created.Id}?force=true&v=true`, undefined, [404, 409], 10000);
		}
	}

	async start(spec: SandboxSpec) {
		const created = await call('POST', `/containers/create?name=${encodeURIComponent(spec.name)}`, {
			Image: spec.image,
			Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
			Labels: spec.labels,
			User: 'agent',
			HostConfig: {
				Memory: spec.memoryBytes,
				MemorySwap: spec.memoryBytes,
				NanoCpus: Math.round(spec.cpus * 1e9),
				PidsLimit: 512,
				ShmSize: 512 * 1024 * 1024,
				SecurityOpt: ['no-new-privileges'],
				CapDrop: ['ALL'],
				NetworkMode: NETWORK,
				Dns: DNS,
				Mounts: (spec.volumes ?? []).map((v) => ({
					Type: 'volume',
					Source: v.name,
					Target: v.target,
					VolumeOptions: { Labels: v.labels ?? {} },
				})),
				AutoRemove: false,
				LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '1' } },
			},
		});
		const id = created.Id as string;
		await call('POST', `/containers/${id}/start`, undefined, [304]);
		return id;
	}

	/**
	 * One created, never started container per image to keep: `docker image prune -a` (by hand or Komodo's)
	 * only removes images no container uses, and an agent's pinned image has no container between its runs.
	 * Keepers of images no longer listed go. They carry `agents.keep`, not `agents.instance`, so the sweeps of
	 * old sandboxes leave them alone.
	 */
	async keepImages(images: string[], instance: string) {
		const wanted = new Set(images);
		const existing = await this.list(`agents.keep=${instance}`);
		for (const c of existing) if (!wanted.has(c.labels['agents.keep.image'] ?? '')) await this.destroy(c.id);
		const have = new Set(existing.map((c) => c.labels['agents.keep.image']));
		for (const image of wanted) {
			if (have.has(image)) continue;
			const name = `agents-${instance}-keep-${image.replace(/^sha256:/, '').slice(0, 12)}`;
			await call(
				'POST',
				`/containers/create?name=${encodeURIComponent(name)}`,
				{
					Image: image,
					Entrypoint: ['true'],
					Labels: { 'agents.keep': instance, 'agents.keep.image': image },
					User: 'agent',
					NetworkDisabled: true,
					HostConfig: { NetworkMode: 'none', AutoRemove: false },
				},
				[409],
			);
		}
	}

	async destroy(id: string) {
		await call('DELETE', `/containers/${id}?force=true&v=true`, undefined, [404, 409]);
	}

	async list(label: string): Promise<SandboxInfo[]> {
		const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
		const rows = (await call('GET', `/containers/json?all=true&filters=${filters}`)) as {
			Id: string;
			Names: string[];
			Labels: Record<string, string> | null;
			State: string;
			Created: number;
		}[];
		return rows.map((r) => ({
			id: r.Id,
			name: (r.Names?.[0] ?? '').replace(/^\//, ''),
			labels: r.Labels ?? {},
			state: r.State,
			created: r.Created * 1000,
		}));
	}

	/** One sample (Docker waits ~1 s to compute the CPU delta). */
	async stats(id: string): Promise<SandboxStats | null> {
		const s = await call('GET', `/containers/${id}/stats?stream=false`, undefined, [404, 409]).catch(() => null);
		if (!s?.cpu_stats) return null;
		const cpuDelta = (s.cpu_stats.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
		const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
		const cpus = s.cpu_stats.online_cpus ?? 1;
		const nets = Object.values((s.networks ?? {}) as Record<string, { rx_bytes: number; tx_bytes: number }>);
		const usage = s.memory_stats?.usage ?? 0;
		return {
			cpuPercent: sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0,
			memoryBytes: Math.max(0, usage - (s.memory_stats?.stats?.inactive_file ?? 0)),
			memoryLimit: s.memory_stats?.limit ?? 0,
			netRx: nets.reduce((n, x) => n + (x.rx_bytes ?? 0), 0),
			netTx: nets.reduce((n, x) => n + (x.tx_bytes ?? 0), 0),
		};
	}

	/** Docker's view of the host, plus /proc (the container sees the host's memory and load). */
	async host(): Promise<HostInfo> {
		const info = await call('GET', '/info');
		const proc = (path: string) => readFile(path, 'utf8').catch(() => '');
		const available = Number((await proc('/proc/meminfo')).match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0) * 1024;
		const load1 = Number((await proc('/proc/loadavg')).split(' ')[0] || 0);
		return { cpus: info.NCPU ?? 0, memoryTotal: info.MemTotal ?? 0, memoryAvailable: available, load1 };
	}
}
