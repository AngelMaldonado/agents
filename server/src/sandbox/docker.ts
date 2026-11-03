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

export class DockerSandbox implements SandboxProvider {
	async imageId(image: string): Promise<string> {
		return (await call('GET', `/images/${encodeURIComponent(image)}/json`, undefined, [], 10000)).Id;
	}

	/** Only platform-owned code, fresh tmpfs, no volumes/secrets/network/model requests. */
	async probeHarness(imageId: string, harness: unknown, instance: string) {
		const created = await call(
			'POST',
			'/containers/create',
			{
				Image: imageId,
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
