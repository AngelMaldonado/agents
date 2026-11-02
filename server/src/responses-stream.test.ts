import { expect, test } from 'bun:test';
import { readResponse } from './responses-stream';

const sse = (events: unknown[]) =>
	new Response(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
		headers: { 'content-type': 'text/event-stream' },
	});

test('server-sent events: deltas reach the page, the final response keeps the streamed items', async () => {
	const seen: string[] = [];
	const call = { type: 'function_call', call_id: 'c1', name: 'buscar_mcp', arguments: '{"consulta":"linear"}' };
	const r = await readResponse(
		sse([
			{ type: 'response.reasoning_summary_text.delta', delta: 'Pienso ' },
			{ type: 'response.reasoning_summary_text.delta', delta: 'en Linear.' },
			{ type: 'response.output_item.added', item: { type: 'function_call' } },
			{ type: 'response.output_item.done', item: call },
			{ type: 'response.completed', response: { status: 'completed', output: [], usage: { total_tokens: 7 } } },
		]),
		(e) => seen.push(e.delta ?? e.type),
	);
	expect(seen).toEqual(['Pienso ', 'en Linear.', 'response.output_item.added', 'response.output_item.done']);
	expect(r.output).toEqual([call]);
	expect(r.usage.total_tokens).toBe(7);
});

test('a plain JSON reply still works; a stream cut short or an error event fails', async () => {
	expect(await readResponse(Response.json({ status: 'completed', output: [1] }), () => {})).toEqual({
		status: 'completed',
		output: [1],
	});
	await expect(readResponse(sse([{ type: 'response.output_text.delta', delta: '{' }]), () => {})).rejects.toThrow(
		'cortó',
	);
	await expect(readResponse(sse([{ type: 'error', message: 'límite' }]), () => {})).rejects.toThrow('límite');
});
