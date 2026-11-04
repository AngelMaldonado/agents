// Initialization's check of the agent's MCP servers, run with the agent's own environment (its keys
// as placeholders, the egress proxy and its CA): each server is asked `initialize` and `tools/list`,
// as pi would. A server that signs in with OAuth is not tried here: it needs the owner's sign-in.
// Input: AGENTS_MCP_CHECK (the servers). Output: one line `AGENTS_MCP_CHECK <json>`.
import { spawn } from 'node:child_process';

const servers = JSON.parse(process.env.AGENTS_MCP_CHECK ?? '[]');
const LIMIT = 20_000;
const expand = (v) => String(v ?? '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => process.env[n] ?? '');
const INIT = {
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agents-check', version: '1' } },
};
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const READY = { jsonrpc: '2.0', method: 'notifications/initialized' };
const short = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 200);

function reply(id, msg) {
	if (msg?.id !== id) return null;
	if (msg.error) throw new Error(short(msg.error.message ?? JSON.stringify(msg.error)));
	return msg.result;
}

async function http(s) {
	const headers = Object.fromEntries((s.headers ?? []).map((h) => [h.name, expand(h.value)]));
	let session = null;
	const post = async (body) => {
		const res = await fetch(s.url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				...headers,
				...(session ? { 'mcp-session-id': session } : {}),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(LIMIT),
		});
		session = res.headers.get('mcp-session-id') ?? session;
		if (res.status === 401 || res.status === 403) throw new Error(`rechazó las credenciales (HTTP ${res.status})`);
		if (!res.ok && res.status !== 202) throw new Error(`respondió HTTP ${res.status}`);
		if (!('id' in body)) return null;
		const text = await res.text();
		const found = (res.headers.get('content-type') ?? '').includes('text/event-stream')
			? text
					.split('\n')
					.filter((l) => l.startsWith('data:'))
					.map((l) => {
						try {
							return JSON.parse(l.slice(5));
						} catch {
							return null;
						}
					})
					.find((m) => m?.id === body.id)
			: JSON.parse(text);
		const result = reply(body.id, found);
		if (!result) throw new Error('no respondió como servidor MCP');
		return result;
	};
	await post(INIT);
	await post(READY);
	return (await post(LIST)).tools ?? [];
}

function stdio(s) {
	return new Promise((resolve, reject) => {
		const env = { ...process.env, ...Object.fromEntries((s.env ?? []).map((p) => [p.name, expand(p.value)])) };
		const child = spawn(s.command, s.args ?? [], { env, cwd: process.env.HOME, stdio: ['pipe', 'pipe', 'pipe'] });
		let buf = '',
			err = '';
		const done = (fn, v) => {
			clearTimeout(timer);
			child.kill('SIGKILL');
			fn(v);
		};
		const timer = setTimeout(() => done(reject, new Error(`no respondió en ${LIMIT / 1000} s ${short(err)}`)), LIMIT);
		child.on('error', (e) => done(reject, new Error(`no arrancó: ${short(e.message)}`)));
		child.on('exit', (code) => done(reject, new Error(`terminó (${code}) ${short(err)}`)));
		child.stderr.on('data', (c) => (err = (err + c).slice(-1000)));
		child.stdout.on('data', (c) => {
			buf += c;
			let i;
			while ((i = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				try {
					if (reply(1, msg)) child.stdin.write(`${JSON.stringify(READY)}\n${JSON.stringify(LIST)}\n`);
					const list = reply(2, msg);
					if (list) done(resolve, list.tools ?? []);
				} catch (e) {
					done(reject, e);
				}
			}
		});
		child.stdin.write(`${JSON.stringify(INIT)}\n`);
	});
}

const results = [];
for (const s of servers) {
	if (s.oauth) {
		results.push({ name: s.name, ok: null, detail: 'inicia sesión desde Herramientas del agente' });
		continue;
	}
	try {
		const tools = s.transport === 'http' ? await http(s) : await stdio(s);
		results.push({ name: s.name, ok: true, tools: tools.length });
	} catch (e) {
		results.push({ name: s.name, ok: false, detail: short(e.message) });
	}
}
console.log(`AGENTS_MCP_CHECK ${JSON.stringify(results)}`);
