import { expect, spyOn, test } from 'bun:test';
import { DockerSandbox } from './docker';

const id = `sha256:${'a'.repeat(64)}`;
const mockFetch = (handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) =>
	spyOn(globalThis, 'fetch').mockImplementation(Object.assign(handler, { preconnect: globalThis.fetch.preconnect }));

test('Docker metadata distinguishes a release, labeled dev, and legacy :dev without inventing a commit', async () => {
	let labels: Record<string, string> = {
		'org.opencontainers.image.version': 'dev',
		'org.opencontainers.image.revision': 'b'.repeat(40),
		'io.cuby.agents.dirty': 'true',
	};
	const fetch = mockFetch(
		async () =>
			new Response(
				JSON.stringify({
					Id: id,
					Config: { Labels: labels },
					RepoTags: ['agents-sandbox:dev'],
				}),
			),
	);
	try {
		const docker = new DockerSandbox();
		expect(await docker.imageInfo(id)).toEqual({
			imageId: id,
			version: null,
			piVersion: null,
			development: true,
			revision: 'b'.repeat(40),
			dirty: true,
		});
		labels = {};
		expect(await docker.imageInfo(id)).toMatchObject({ development: true, revision: null, dirty: null });
		labels = { 'org.opencontainers.image.version': '0.0.7-beta', 'io.cuby.agents.pi.version': '1.4.0' };
		expect(await docker.imageInfo(id)).toMatchObject({ version: '0.0.7-beta', piVersion: '1.4.0', development: false });
	} finally {
		fetch.mockRestore();
	}
});

test('legacy pi version is read from an isolated immutable image and its container is removed', async () => {
	const calls: { path: string; init?: RequestInit }[] = [];
	const fetch = mockFetch(async (url, init) => {
		const path = String(url);
		calls.push({ path, init });
		if (path.endsWith('/containers/create')) return new Response(JSON.stringify({ Id: 'metadata-test' }));
		if (path.endsWith('/json')) return new Response(JSON.stringify({ State: { Running: false, ExitCode: 0 } }));
		if (path.includes('/logs?')) return new Response('1.4.0\r\n');
		return new Response('');
	});
	try {
		expect(await new DockerSandbox().imagePiVersion(id)).toBe('1.4.0');
		const body = JSON.parse(String(calls[0].init?.body));
		expect(body.Image).toBe(id);
		expect(body.Entrypoint).toEqual(['node']);
		expect(body.Cmd.join(' ')).toContain('/pi-coding-agent/package.json');
		expect(body.HostConfig).toMatchObject({
			NetworkMode: 'none',
			ReadonlyRootfs: true,
			CapDrop: ['ALL'],
			PidsLimit: 16,
		});
		expect(body.HostConfig.Binds).toBeUndefined();
		expect(body.HostConfig.Mounts).toBeUndefined();
		expect(body.Env).toBeUndefined();
		expect(calls.at(-1)?.init?.method).toBe('DELETE');
		expect(calls.at(-1)?.path).toEndWith('/metadata-test?force=true&v=true');
	} finally {
		fetch.mockRestore();
	}
});

test('image preparation pins the known registry digest and consumes real streamed layer progress', async () => {
	const ref = `registry.example.test/agents@sha256:${'b'.repeat(64)}`;
	const messages: string[] = [];
	const fetch = mockFetch(async (url, init) => {
		if (String(url).endsWith('/json')) return new Response(JSON.stringify({ RepoDigests: [ref] }));
		expect(init?.method).toBe('POST');
		expect(String(url)).toContain(encodeURIComponent(ref));
		const text =
			JSON.stringify({ status: 'Downloading', id: 'layer', progressDetail: { current: 12, total: 100 } }) + '\n';
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(text.slice(0, 20)));
					controller.enqueue(new TextEncoder().encode(text.slice(20)));
					controller.close();
				},
			}),
		);
	});
	try {
		const docker = new DockerSandbox();
		expect(await docker.imagePullRef(id, 'registry.example.test/agents:beta')).toBe(ref);
		await docker.pullImage(ref, async (message) => {
			messages.push(message);
		});
		expect(messages).toEqual(['Downloading · layer · 12 / 100 bytes']);
		await expect(docker.pullImage('registry.example.test/agents:beta', async () => {})).rejects.toThrow(/digest/);
	} finally {
		fetch.mockRestore();
	}
});

test('an error inside a successful HTTP pull stream fails preparation instead of reporting success', async () => {
	const fetch = mockFetch(async () => new Response('{"errorDetail":{"message":"access denied"}}\n'));
	try {
		await expect(
			new DockerSandbox().pullImage(`registry.example.test/agents@sha256:${'b'.repeat(64)}`, async () => {}),
		).rejects.toThrow('access denied');
	} finally {
		fetch.mockRestore();
	}
});

test('a failed metadata container start still cleans up', async () => {
	const fetch = mockFetch(async (url, init) => {
		if (String(url).endsWith('/create')) return new Response(JSON.stringify({ Id: 'metadata-failed' }));
		if (String(url).endsWith('/start')) return new Response('failed', { status: 500 });
		expect(init?.method).toBe('DELETE');
		expect(String(url)).toEndWith('/metadata-failed?force=true&v=true');
		return new Response('');
	});
	try {
		await expect(new DockerSandbox().imagePiVersion(id)).rejects.toThrow('500');
		expect(fetch).toHaveBeenCalledTimes(3);
	} finally {
		fetch.mockRestore();
	}
});
