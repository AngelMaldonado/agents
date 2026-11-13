// One structured answer from GPT, on the owner's own gateway (their quota), for the platform's own model
// calls outside an agent's computer: an encargo's turns and a trabajo's evaluation.
import { proxyCredentials, prefixOf } from './providers';
import { readResponse } from './responses-stream';

export async function askJson<T>(
	personId: number,
	agentModel: string,
	instructions: string,
	input: string,
	schema: object,
	opts: { name: string; label: string; maxTokens?: number },
): Promise<{ value: T; tokens: number }> {
	const ownProxy = await proxyCredentials(personId);
	const base = ownProxy?.url ?? process.env.AGENTS_CLIPROXY_URL ?? 'http://cliproxy:8317';
	const key = ownProxy?.key ?? process.env.AGENTS_PROXY_KEY;
	if (!key) throw new Error('El gateway GPT no está configurado.');
	const name = agentModel.split('/')[1] ?? agentModel;
	const response = await fetch(`${base}/v1/responses`, {
		method: 'POST',
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			model: ownProxy ? name : `${prefixOf(personId)}/${name}`,
			store: false,
			stream: false,
			max_output_tokens: opts.maxTokens ?? 4000,
			reasoning: { effort: 'low' },
			input: [
				{ role: 'system', content: instructions },
				{ role: 'user', content: input },
			],
			text: { format: { type: 'json_schema', name: opts.name, strict: true, schema } },
		}),
		signal: AbortSignal.timeout(180_000),
	});
	if (!response.ok) {
		// What it refused, in the server's log (the agent and the owner get the short line).
		const why = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500);
		console.error(`${opts.label}: GPT respondió ${response.status}: ${why}`);
		throw new Error(`El proveedor GPT respondió ${response.status}.`);
	}
	const r = await readResponse(response, () => {});
	const text =
		typeof r.output_text === 'string'
			? r.output_text
			: (r.output ?? []).flatMap((o: any) => o.content ?? []).find((c: any) => c.type === 'output_text')?.text;
	if (!text) throw new Error('El modelo no devolvió una respuesta.');
	return { value: JSON.parse(text) as T, tokens: Number(r.usage?.total_tokens ?? 0) };
}
