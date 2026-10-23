// The LLM gateway: the sandbox's only way to a model.
//
// pi inside the sandbox thinks it talks to Anthropic or OpenAI; its "API key" is the task's
// llm_token. Here the token becomes the task, the model must be the task's model, and the request
// goes to CLIProxyAPI as u<owner>/<model> with the backend's internal proxy key. The sandbox never
// holds a real key, and can't reach another person's account or another model.
import type { Context } from 'hono';
import { byLlmToken } from './tasks';
import { prefixOf } from './providers';

const CLIPROXY = process.env.BUYER_CLIPROXY_URL ?? 'http://cliproxy:8317';

const ROUTES: Record<string, { provider: 'anthropic' | 'openai'; upstream: string }> = {
	'/llm/anthropic/v1/messages': { provider: 'anthropic', upstream: '/v1/messages' },
	'/llm/openai/v1/responses': { provider: 'openai', upstream: '/v1/responses' }
};

const PASS = ['content-type', 'anthropic-version', 'anthropic-beta', 'accept', 'openai-beta'];

export async function gateway(c: Context) {
	const route = ROUTES[c.req.path];
	if (!route) return c.json({ error: { message: 'no such route' } }, 404);
	const token =
		route.provider === 'anthropic'
			? c.req.header('x-api-key')
			: c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
	const task = token ? byLlmToken(token) : null;
	if (!task) return c.json({ error: { type: 'authentication_error', message: 'invalid task token' } }, 401);

	const [provider, model] = task.model.split('/', 2);
	if (provider !== route.provider) return c.json({ error: { message: 'wrong provider for this task' } }, 403);

	let body: any;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: { message: 'invalid JSON' } }, 400);
	}
	if (body?.model !== model) return c.json({ error: { message: `this task may only use ${model}` } }, 403);
	body.model = `${prefixOf(task.person_id)}/${model}`;

	const headers = new Headers();
	for (const h of PASS) {
		const v = c.req.header(h);
		if (v) headers.set(h, v);
	}
	const key = process.env.BUYER_PROXY_KEY!;
	headers.set('authorization', `Bearer ${key}`);
	headers.set('x-api-key', key);

	const upstream = await fetch(`${CLIPROXY}${route.upstream}`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: c.req.raw.signal
	}).catch((err: Error) => err);
	if (upstream instanceof Error) {
		return c.json({ error: { type: 'api_error', message: `proxy unreachable: ${upstream.message}` } }, 502);
	}
	const out = new Headers();
	for (const h of ['content-type', 'cache-control', 'request-id', 'x-request-id']) {
		const v = upstream.headers.get(h);
		if (v) out.set(h, v);
	}
	return new Response(upstream.body, { status: upstream.status, headers: out });
}
