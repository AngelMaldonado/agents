// SandboxProvider on the Docker Engine API, over the unix socket with Bun's fetch.
// The sandbox dials out to the backend (see sandbox/supervisor.mjs), so nothing here attaches
// to a container's stdio or reaches into its ports.
import type { SandboxProvider, SandboxSpec } from './provider';

const SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';
const API = 'http://docker/v1.45';
const NETWORK = process.env.BUYER_SANDBOX_NETWORK ?? 'buyer-sandbox';

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

	async list(label: string) {
		const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
		const rows = (await call('GET', `/containers/json?all=true&filters=${filters}`)) as { Id: string }[];
		return rows.map((r) => r.Id);
	}
}
