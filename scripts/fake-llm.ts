// Dev only: a scripted stand-in for CLIProxyAPI that speaks Anthropic's /v1/messages stream.
// It drives a real sandbox through a real browsing session, steer and all, without spending a
// cent: just dev fake on | off. Each step is chosen by how many tool results the agent has sent.
// The task's prompt picks the script: "[blocked]" gets stuck and asks for help, "[vault]" logs
// in with the credential "local-test" on a page served inside the sandbox; anything else quotes.
type Step = { text: string } | { bash: string };

const BLOCKED: Step[] = [
	{ bash: 'agent-browser open https://example.com' },
	{ bash: 'buyer-blocked "El sitio pide un captcha. ¿Lo salto?"' },
	{ bash: 'echo \'{"summary":"Prueba de atasco","options":[]}\' > ~/work/out/result.json' },
	{ text: 'Terminé.' }
];

const VAULT: Step[] = [
	{
		bash: `mkdir -p ~/site && printf '%s' '<html><body><h1>Portal de prueba</h1><form action="/ok.html"><input id="u" name="u"><input id="p" name="p" type="password"><button>Entrar</button></form></body></html>' > ~/site/login.html && echo '<h1>Dentro del portal</h1>' > ~/site/ok.html && (cd ~/site && nohup python3 -m http.server 8000 >/dev/null 2>&1 &) && sleep 1 && echo listo`
	},
	{ bash: 'buyer-login local-test' },
	{ bash: 'agent-browser get url | sed "s/[?].*//"' },
	{ bash: 'buyer-login no-concedida' },
	{ bash: 'echo \'{"summary":"Prueba de vault","options":[]}\' > ~/work/out/result.json' },
	{ text: 'Entré al portal.' }
];

const QUOTE: Step[] = [
	{ bash: 'agent-browser open https://www.raspberrypi.com/products/raspberry-pi-5/' },
	{ bash: 'agent-browser scroll down' },
	{ bash: 'agent-browser screenshot ~/work/out/opcion-1.png' },
	{ bash: 'agent-browser open https://es.wikipedia.org/wiki/Raspberry_Pi' },
	{ bash: 'agent-browser screenshot ~/work/out/opcion-2.png' },
	{
		bash: `cat > ~/work/out/result.json <<'EOF'
{"summary":"Prueba guionada (LLM falso): dos páginas visitadas, precios ficticios.","recommendation":{"option":1,"why":"Es la página del fabricante."},"options":[{"product":"Raspberry Pi 5 8GB","vendor":"raspberrypi.com","price":1850,"currency":"MXN","shipping":null,"availability":"desconocido","url":"https://www.raspberrypi.com/products/raspberry-pi-5/","screenshot":"opcion-1.png","checked_at":"${new Date().toISOString()}","notes":"Precio ficticio: esto es una prueba."},{"product":"Raspberry Pi (artículo)","vendor":"Wikipedia","price":null,"currency":"MXN","shipping":null,"availability":"desconocido","url":"https://es.wikipedia.org/wiki/Raspberry_Pi","screenshot":"opcion-2.png","checked_at":"${new Date().toISOString()}","notes":"No vende nada."}]}
EOF`
	},
	{ text: 'Listo: dejé la cotización en ~/work/out/result.json.' }
];

function scriptFor(body: any): Step[] {
	const first = JSON.stringify(body.messages.find((m: any) => m.role === 'user')?.content ?? '');
	if (first.includes('[blocked]')) return BLOCKED;
	if (first.includes('[vault]')) return VAULT;
	return QUOTE;
}

function sse(events: [string, unknown][]) {
	return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}

Bun.serve({
	port: 8317,
	async fetch(req) {
		if (!req.url.endsWith('/v1/messages')) return new Response('not here', { status: 404 });
		const body = await req.json();
		const results = body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((c: any) => c.type === 'tool_result').length;
		const lastUser = [...body.messages].reverse().find((m: any) => m.role === 'user');
		const steered = JSON.stringify(lastUser?.content ?? '').includes('Steer de prueba');
		const STEPS = scriptFor(body);
		const step = STEPS[Math.min(results, STEPS.length - 1)];
		await Bun.sleep(1500); // look like thinking
		const id = `msg_fake_${Date.now()}`;
		const usage = { input_tokens: 1200, output_tokens: 80 };
		const ev: [string, unknown][] = [['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage } }]];
		let i = 0;
		if (steered) {
			ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }]);
			ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: 'Entendido, sigo tu instrucción.' } }]);
			ev.push(['content_block_stop', { type: 'content_block_stop', index: i++ }]);
		}
		if ('bash' in step) {
			ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${Date.now()}`, name: 'bash', input: {} } }]);
			ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: step.bash }) } }]);
			ev.push(['content_block_stop', { type: 'content_block_stop', index: i }]);
			ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 80 } }]);
		} else {
			ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }]);
			ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: step.text } }]);
			ev.push(['content_block_stop', { type: 'content_block_stop', index: i }]);
			ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }]);
		}
		ev.push(['message_stop', { type: 'message_stop' }]);
		return new Response(sse(ev), { headers: { 'content-type': 'text/event-stream' } });
	}
});
console.log('fake LLM on :8317');
