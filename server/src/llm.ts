// The LLM gateway: the sandbox's only way to a model. GPT only: OpenAI's Responses API.
//
// pi inside the sandbox thinks it talks to OpenAI; its "API key" is the run's llm token. Here
// the token becomes the run, the model must be the run's model, and the request goes to
// CLIProxyAPI as u<owner>/<model> with the backend's internal proxy key. The sandbox never holds
// a real key, and can't reach another person's account or another model.
// A person with their own CLIProxyAPI (Ajustes) gets their requests sent there instead, with their
// key and the plain model id.
import type { Context } from 'hono';
import { byLlmToken } from './tasks';
import { prefixOf, proxyCredentials } from './providers';

const CLIPROXY = process.env.AGENTS_CLIPROXY_URL ?? 'http://cliproxy:8317';

const ROUTES: Record<string, { upstream: string }> = {
	'/llm/openai/v1/responses': { upstream: '/v1/responses' }
};

const PASS = ['content-type', 'accept', 'openai-beta'];

export async function gateway(c: Context) {
	const route = ROUTES[c.req.path];
	if (!route) return c.json({ error: { message: 'no such route' } }, 404);
	const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
	const task = token ? await byLlmToken(token) : null;
	if (!task) return c.json({ error: { type: 'authentication_error', message: 'invalid task token' } }, 401);

	const [provider, model] = task.model.split('/', 2);
	if (provider !== 'openai') return c.json({ error: { message: 'only openai models are served' } }, 403);

	let body: any;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: { message: 'invalid JSON' } }, 400);
	}
	if (body?.model !== model) return c.json({ error: { message: `this task may only use ${model}` } }, 403);
	const own = await proxyCredentials(task.person_id);
	const base = own?.url ?? CLIPROXY;
	const key = own?.key ?? process.env.AGENTS_PROXY_KEY!;
	body.model = own ? model : `${prefixOf(task.person_id)}/${model}`;

	const headers = new Headers();
	for (const h of PASS) {
		const v = c.req.header(h);
		if (v) headers.set(h, v);
	}
	headers.set('authorization', `Bearer ${key}`);

	const upstream = await fetch(`${base}${route.upstream}`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: c.req.raw.signal
	}).catch((err: Error) => err);
	if (upstream instanceof Error) {
		return c.json({ error: { type: 'api_error', message: `${own ? 'your CLIProxyAPI' : 'proxy'} unreachable: ${upstream.message}` } }, 502);
	}
	const out = new Headers();
	for (const h of ['content-type', 'cache-control', 'request-id', 'x-request-id']) {
		const v = upstream.headers.get(h);
		if (v) out.set(h, v);
	}
	return new Response(upstream.body, { status: upstream.status, headers: out });
}
