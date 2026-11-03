// The designer streams its replies (#26) so the page can show what it is doing while it answers.
/** Reads a Responses API reply: server-sent events as they come (reasoning, calls, text), or plain JSON. */
export async function readResponse(response: Response, onEvent: (e: any) => void, onData?: () => void) {
	if (!(response.headers.get('content-type') ?? '').includes('text/event-stream'))
		return (await response.json()) as any;
	const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
	const items: unknown[] = [];
	let buffer = '',
		final: any = null;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		onData?.();
		buffer += value;
		for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
			const data = buffer
				.slice(0, i)
				.split('\n')
				.filter((l) => l.startsWith('data:'))
				.map((l) => l.slice(5).trim())
				.join('\n');
			buffer = buffer.slice(i + 2);
			if (!data || data === '[DONE]') continue;
			let e: any;
			try {
				e = JSON.parse(data);
			} catch {
				continue;
			}
			if (['response.completed', 'response.incomplete', 'response.failed'].includes(e.type)) final = e.response;
			else if (e.type === 'error') throw new Error(e.message ?? 'El proveedor GPT devolvió un error.');
			else {
				if (e.type === 'response.output_item.done' && e.item) items.push(e.item);
				onEvent(e);
			}
		}
	}
	if (!final) throw new Error('La respuesta se cortó antes de terminar. Puedes reintentar.');
	// Some proxies send the final response without its items: the ones streamed are the same.
	return Array.isArray(final.output) && final.output.length ? final : { ...final, output: items };
}
