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

async function call(method: string, path: string, body?: unknown, ok: number[] = []) {
	const res = await fetch(`${API}${path}`, {
		method,
		unix: SOCKET,
		headers: body ? { 'content-type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined
	} as RequestInit);
	if (!res.ok && !ok.includes(res.status)) {
		throw new Error(`docker ${method} ${path}: ${res.status} ${await res.text()}`);
	}
	const text = await res.text();
	return text ? JSON.parse(text) : null;
}

export class DockerSandbox implements SandboxProvider {
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
					VolumeOptions: { Labels: v.labels ?? {} }
				})),
				AutoRemove: false,
				LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '1' } }
			}
		});
		const id = created.Id as string;
		await call('POST', `/containers/${id}/start`, undefined, [304]);
		return id;
	}

	async destroy(id: string) {
		await call('DELETE', `/containers/${id}?force=true&v=true`, undefined, [404, 409]);
	}

	async list(label: string): Promise<SandboxInfo[]> {
		const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
		const rows = (await call('GET', `/containers/json?all=true&filters=${filters}`)) as {
			Id: string; Names: string[]; Labels: Record<string, string> | null; State: string; Created: number;
		}[];
		return rows.map((r) => ({ id: r.Id, name: (r.Names?.[0] ?? '').replace(/^\//, ''), labels: r.Labels ?? {}, state: r.State, created: r.Created * 1000 }));
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
			netTx: nets.reduce((n, x) => n + (x.tx_bytes ?? 0), 0)
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
