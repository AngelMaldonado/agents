// Dev only: a scripted stand-in for CLIProxyAPI that speaks OpenAI's Responses API stream (GPT
// only, like Agents). It drives a real sandbox, browser and all, without spending a cent:
// just dev fake on | off.
//
// The run's prompt picks the script; each step is chosen by how many tool results came back since
// that prompt. The conversation continues between runs, so the whole history arrives every time:
//   [blocked]     gets stuck and asks for help        [vault]       logs in with "local-test"
//   [cookie-set]  leaves a cookie on example.com      [cookie-get]  shows example.com's cookies
//   [texto]       answers without tools or files
//   "anota el número N"  writes N to ~/work/nota.txt
//   "qué número anotaste"  reads it back and quotes what the conversation says
//   anything else: visits a page and leaves a screenshot and a summary in ~/work/out/
type Step = { text: string | ((ctx: Ctx) => string) } | { bash: string | ((prompt: string) => string) };
type Ctx = { history: string; lastOutput: string };

const SITE = `mkdir -p ~/site && printf '%s' '<html><body><h1>Portal de prueba</h1><form action="/ok.html"><input id="u" name="u"><input id="p" name="p" type="password"><button>Entrar</button></form></body></html>' > ~/site/login.html && echo '<h1>Dentro del portal</h1>' > ~/site/ok.html && (cd ~/site && nohup python3 -m http.server 8000 >/dev/null 2>&1 &) && sleep 1 && echo listo`;

const SCRIPTS: { match: RegExp; steps: Step[] }[] = [
	{
		match: /\[blocked\]/,
		steps: [
			{ bash: 'agent-browser open https://example.com' },
			{ bash: 'agents-blocked "El sitio pide un captcha. ¿Lo salto?"' },
			{ text: 'Terminé: el sitio pedía captcha y seguí sin él.' }
		]
	},
	{
		match: /\[vault\]/,
		steps: [
			{ bash: SITE },
			{ bash: 'agents-login local-test' },
			{ bash: 'agent-browser get url | sed "s/[?].*//"' },
			{ bash: 'agents-login no-concedida' },
			{ text: 'Entré al portal de prueba con `local-test`; `no-concedida` me fue negada.' }
		]
	},
	{
		match: /\[cookie-set\]/,
		steps: [
			// A persistent cookie (a session one dies with the browser, like on any desktop) and a localStorage value.
			{ bash: 'agent-browser open https://example.com >/dev/null && agent-browser cookies set probe agents-v2 --url https://example.com --expires $(( $(date +%s) + 86400 )) && agent-browser eval "localStorage.setItem(\'probe\', \'agents-v2\')" >/dev/null && agent-browser cookies get' },
			{ text: 'Dejé la cookie `probe` y `localStorage.probe` en example.com.' }
		]
	},
	{
		match: /\[cookie-get\]/,
		steps: [
			{ bash: 'agent-browser open https://example.com >/dev/null && echo "cookies: $(agent-browser cookies get | tr \'\\n\' \' \')" && echo "localStorage.probe: $(agent-browser eval "localStorage.getItem(\'probe\')" | tail -1)"' },
			{ text: (c) => `En example.com:\n\n\`\`\`\n${c.lastOutput.trim() || '(nada)'}\n\`\`\`` }
		]
	},
	{ match: /\[texto\]/, steps: [{ text: '## Respuesta\n\nSin herramientas ni archivos: sólo esta respuesta en **markdown**.' }] },
	{
		match: /anota el n[uú]mero (\d+)/i,
		steps: [
			{ bash: (p) => { const n = p.match(/anota el n[uú]mero (\d+)/i)![1]; return `echo ${n} > ~/work/nota.txt && echo "anotado ${n}"`; } },
			{ text: (c) => `Anoté el **${c.lastOutput.match(/\d+/)?.[0] ?? '?'}** en \`~/work/nota.txt\`.` }
		]
	},
	{
		match: /qu[eé] n[uú]mero anotaste/i,
		steps: [
			{ bash: 'cat ~/work/nota.txt' },
			{
				text: (c) => {
					const asked = c.history.match(/anota el n[uú]mero (\d+)/i)?.[1];
					return `Me pediste anotar el **${asked ?? 'no lo encuentro en la conversación'}**, y \`~/work/nota.txt\` dice: \`${c.lastOutput.trim() || '(vacío)'}\`.`;
				}
			}
		]
	},
	{
		match: /./,
		steps: [
			{ bash: 'agent-browser open https://example.com' },
			{ bash: 'agent-browser screenshot ~/work/out/pagina.png' },
			{ bash: 'printf "# Resumen\\n\\nexample.com es un dominio de ejemplo.\\n" > ~/work/out/resumen.md && echo ok' },
			{ text: '## Listo\n\nVisité **example.com** (prueba con el LLM falso).\n\n- Captura: `pagina.png`\n- Resumen: `resumen.md`' }
		]
	}
];

// ---------- reading what pi sent ----------

const textOf = (item: any): string =>
	typeof item?.content === 'string'
		? item.content
		: Array.isArray(item?.content)
			? item.content.map((c: any) => c?.text ?? '').join('')
			: '';
const isUser = (item: any) => item?.role === 'user';
const isSteer = (item: any) => textOf(item).includes('Steer de prueba');

function plan(input: any[]) {
	// The run's prompt: the last user message that is not a test steer.
	let at = -1;
	for (let i = input.length - 1; i >= 0; i--) if (isUser(input[i]) && !isSteer(input[i])) { at = i; break; }
	const prompt = at >= 0 ? textOf(input[at]) : '';
	const since = input.slice(at + 1);
	const results = since.filter((i) => i?.type === 'function_call_output');
	const steps = SCRIPTS.find((s) => s.match.test(prompt))!.steps;
	const ctx: Ctx = {
		history: input.slice(0, at >= 0 ? at : input.length).filter(isUser).map(textOf).join('\n'),
		lastOutput: String(results.at(-1)?.output ?? '')
	};
	const steered = since.some((i) => isUser(i) && isSteer(i)) && !since.slice(since.findLastIndex((i) => isUser(i) && isSteer(i))).some((i) => i?.type === 'message' && i?.role === 'assistant');
	return { prompt, step: steps[Math.min(results.length, steps.length - 1)], ctx, steered };
}

// ---------- the Responses stream ----------

function sse(events: unknown[]) {
	return events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

let seq = 0;
Bun.serve({
	port: 8317,
	async fetch(req) {
		// Also plays a person's own CLIProxyAPI in Ajustes: URL http://fake-llm:8317, key fake-proxy-key.
		if (req.url.endsWith('/v1/models')) {
			if (req.headers.get('authorization') !== 'Bearer fake-proxy-key') return Response.json({ error: 'bad key' }, { status: 401 });
			return Response.json({ object: 'list', data: ['gpt-6.1-sol', 'gpt-6-sol'].map((id) => ({ id, object: 'model' })) });
		}
		if (!req.url.endsWith('/v1/responses')) return new Response('not here', { status: 404 });
		const body = await req.json();
		const input: any[] = Array.isArray(body.input) ? body.input : [];
		const { prompt, step, ctx, steered } = plan(input);
		await Bun.sleep(1500); // look like thinking

		const id = `resp_fake_${Date.now()}_${++seq}`;
		const usage = { input_tokens: 1200, output_tokens: 80, total_tokens: 1280, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
		const ev: unknown[] = [{ type: 'response.created', response: { id, object: 'response', status: 'in_progress', model: body.model, output: [] } }];
		const output: unknown[] = [];
		const message = (text: string) => {
			const idx = output.length;
			const item = { type: 'message', id: `msg_${id}_${idx}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
			ev.push({ type: 'response.output_item.added', output_index: idx, item: { ...item, status: 'in_progress', content: [] } });
			ev.push({ type: 'response.output_text.delta', output_index: idx, item_id: item.id, content_index: 0, delta: text });
			ev.push({ type: 'response.output_item.done', output_index: idx, item });
			output.push(item);
		};
		if (steered) message('Entendido, sigo tu instrucción.');
		if ('bash' in step) {
			const idx = output.length;
			const command = typeof step.bash === 'function' ? step.bash(prompt) : step.bash;
			const args = JSON.stringify({ command });
			const item = { type: 'function_call', id: `fc_${id}_${idx}`, call_id: `call_${id}_${idx}`, name: 'bash', arguments: args, status: 'completed' };
			ev.push({ type: 'response.output_item.added', output_index: idx, item: { ...item, arguments: '', status: 'in_progress' } });
			ev.push({ type: 'response.function_call_arguments.delta', output_index: idx, item_id: item.id, delta: args });
			ev.push({ type: 'response.function_call_arguments.done', output_index: idx, item_id: item.id, arguments: args });
			ev.push({ type: 'response.output_item.done', output_index: idx, item });
			output.push(item);
		} else {
			message(typeof step.text === 'function' ? step.text(ctx) : step.text);
		}
		ev.push({ type: 'response.completed', response: { id, object: 'response', status: 'completed', model: body.model, output, usage } });
		return new Response(sse(ev), { headers: { 'content-type': 'text/event-stream' } });
	}
});
console.log('fake LLM (OpenAI Responses) on :8317');
