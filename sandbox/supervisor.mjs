// The supervisor: PID 1's child inside every task's container (no dependencies, Node 24).
//
// It dials the backend once with the bootstrap token (burnt on connect), opens the browser,
// relays its frames read-only, runs `pi --mode rpc`, passes steer/follow-up/abort through, serves
// buyer-blocked and the vault plugin on 127.0.0.1:7777, and sends ~/work/out back when asked.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFile } from 'node:child_process';

const SERVER = process.env.BUYER_SERVER_URL;
const TOKEN = process.env.BUYER_TASK_TOKEN;
const LLM_TOKEN = process.env.BUYER_LLM_TOKEN;
const HOME = process.env.HOME ?? '/home/agent';
const WORK = join(HOME, 'work');
const OUT = join(WORK, 'out');
const PI_DIR = join(HOME, '.pi', 'agent');
const STREAM = `ws://127.0.0.1:${process.env.AGENT_BROWSER_STREAM_PORT ?? 9223}`;

mkdirSync(OUT, { recursive: true });
mkdirSync(PI_DIR, { recursive: true });

const log = (...a) => console.error('[supervisor]', ...a);
let backend = null;
let pi = null;
let blockedWaitMs = 10 * 60_000;
const send = (msg) => backend?.readyState === 1 && backend.send(JSON.stringify(msg));

// ---------- backend link ----------

async function connect() {
	const url = `${SERVER.replace(/^http/, 'ws')}/sandbox/ws?token=${encodeURIComponent(TOKEN)}`;
	for (let i = 0; i < 60; i++) {
		const ws = new WebSocket(url);
		const ok = await new Promise((resolve) => {
			ws.onopen = () => resolve(true);
			ws.onerror = () => resolve(false);
		});
		if (ok) return ws;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error('could not reach the backend');
}

function onBackend(raw) {
	let msg;
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}
	switch (msg.t) {
		case 'start':
			blockedWaitMs = msg.blockedWaitMs ?? blockedWaitMs;
			void start(msg);
			break;
		case 'pi_cmd':
			if (pi?.stdin.writable) pi.stdin.write(JSON.stringify(msg.cmd) + '\n');
			break;
		case 'unblock':
			releaseBlocked(true);
			break;
		case 'cred_res': {
			const waiter = credWaiters.get(msg.id);
			credWaiters.delete(msg.id);
			waiter?.(msg);
			break;
		}
		case 'collect':
			collect();
			break;
	}
}

// ---------- the browser ----------

function ab(...args) {
	return new Promise((resolve) => execFile('agent-browser', args, { cwd: WORK, timeout: 60_000 }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
}

let lastUrl = '';
let pending = null;
let flushing = null;

/** Frames, read-only: nothing is ever written to the stream socket. At most ~5 per second. */
function watchBrowser() {
	const ws = new WebSocket(STREAM);
	ws.onmessage = (e) => {
		let m;
		try {
			m = JSON.parse(e.data);
		} catch {
			return;
		}
		if (m.type === 'url' && m.url) lastUrl = m.url;
		if (m.type === 'tabs') lastUrl = m.tabs?.find((t) => t.active)?.url ?? lastUrl;
		if (m.type !== 'frame') return;
		pending = { t: 'frame', jpeg: m.data, meta: { ...m.metadata, url: lastUrl } };
		if (!flushing) {
			flushing = setTimeout(() => {
				flushing = null;
				if (pending) send(pending);
				pending = null;
			}, 200);
		}
	};
	ws.onclose = () => setTimeout(watchBrowser, 1000);
	ws.onerror = () => {};
}

// ---------- pi ----------

async function start(msg) {
	writeFileSync(
		join(PI_DIR, 'models.json'),
		JSON.stringify({
			providers: {
				anthropic: { baseUrl: `${SERVER}/llm/anthropic` },
				openai: { baseUrl: `${SERVER}/llm/openai/v1` }
			}
		})
	);
	const systemFile = join(HOME, '.pi', 'buyer-system.md');
	writeFileSync(systemFile, msg.system);

	// A blank browser from the start, so the human sees the screen before the first command.
	await ab('open', 'about:blank');
	watchBrowser();

	// pi gets only the LLM token, as its provider keys. The bootstrap token stays out of its env.
	const env = { ...process.env, ANTHROPIC_API_KEY: LLM_TOKEN, OPENAI_API_KEY: LLM_TOKEN, PI_CODING_AGENT_DIR: PI_DIR };
	delete env.BUYER_TASK_TOKEN;
	delete env.BUYER_LLM_TOKEN;
	pi = spawn(
		'pi',
		['--mode', 'rpc', '--no-session', '--offline', '-ne', '-ns', '-nc', '--no-mcp', '--model', msg.model, '--append-system-prompt', systemFile],
		{ cwd: WORK, env, stdio: ['pipe', 'pipe', 'pipe'] }
	);
	readLines(pi.stdout, onPiLine);
	let stderrLines = 0;
	readLines(pi.stderr, (line) => {
		if (line.trim() && stderrLines++ < 50) send({ t: 'stderr', text: line });
	});
	pi.on('exit', (code) => {
		send({ t: 'exit', code });
		pi = null;
	});
	pi.stdin.write(JSON.stringify({ id: 'task', type: 'prompt', message: msg.prompt }) + '\n');
}

/** Strict JSONL: split on LF only (U+2028/9 are valid inside JSON strings). */
function readLines(stream, onLine) {
	let buf = '';
	stream.setEncoding('utf8');
	stream.on('data', (chunk) => {
		buf += chunk;
		let i;
		while ((i = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, i).replace(/\r$/, '');
			buf = buf.slice(i + 1);
			if (line) onLine(line);
		}
	});
}

const FORWARD = new Set(['message_end', 'tool_execution_start', 'tool_execution_end', 'agent_settled', 'auto_retry_start', 'agent_start']);
let lastUpdate = 0;

function onPiLine(line) {
	let ev;
	try {
		ev = JSON.parse(line);
	} catch {
		return;
	}
	if (ev.type === 'response') {
		if (!ev.success) send({ t: 'stderr', text: `pi ${ev.command}: ${ev.error}` });
		return;
	}
	if (ev.type === 'message_update') {
		// Only the kind of update matters to the character; the text arrives whole in message_end.
		const now = Date.now();
		if (now - lastUpdate < 500) return;
		lastUpdate = now;
		send({ t: 'pi', ev: { type: 'message_update', assistantMessageEvent: { type: ev.assistantMessageEvent?.type } } });
		return;
	}
	if (ev.type === 'message_end' && ev.message?.role !== 'assistant') return;
	if (FORWARD.has(ev.type)) send({ t: 'pi', ev });
}

// ---------- local services for the agent's commands ----------

let blocked = null;
function releaseBlocked(steered) {
	if (!blocked) return;
	const b = blocked;
	blocked = null;
	clearTimeout(b.timer);
	send({ t: 'unblocked', steered });
	b.res.end(
		steered
			? 'El humano respondió. Sus instrucciones te llegan en cuanto termine este comando: síguelas.\n'
			: `Nadie respondió en ${Math.round(blockedWaitMs / 60000)} minutos. Salta este sitio y continúa con otros.\n`
	);
}

const credWaiters = new Map();
let credSeq = 0;

createServer((req, res) => {
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', () => {
		if (req.method === 'POST' && req.url === '/blocked') {
			releaseBlocked(false);
			send({ t: 'blocked', reason: body.slice(0, 2000) });
			blocked = { res, timer: setTimeout(() => releaseBlocked(false), blockedWaitMs) };
			return;
		}
		if (req.method === 'POST' && req.url === '/credential') {
			let q = {};
			try {
				q = JSON.parse(body);
			} catch {}
			const id = ++credSeq;
			const timer = setTimeout(() => {
				credWaiters.delete(id);
				res.end(JSON.stringify({ ok: false, error: 'timeout' }));
			}, 15_000);
			credWaiters.set(id, (r) => {
				clearTimeout(timer);
				res.end(JSON.stringify(r));
			});
			send({ t: 'cred', id, name: String(q.name ?? ''), url: String(q.url ?? '') });
			return;
		}
		res.statusCode = 404;
		res.end();
	});
}).listen(7777, '127.0.0.1');

// ---------- results ----------

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.csv': 'text/csv', '.md': 'text/markdown', '.txt': 'text/plain', '.pdf': 'application/pdf' };

function collect() {
	let files = [];
	try {
		files = readdirSync(OUT).filter((f) => statSync(join(OUT, f)).isFile()).slice(0, 40);
	} catch {}
	for (const name of files) {
		const path = join(OUT, name);
		if (statSync(path).size > 10 * 1024 * 1024) continue;
		send({ t: 'file', name, mime: MIME[extname(name).toLowerCase()] ?? 'application/octet-stream', data: readFileSync(path).toString('base64') });
	}
	send({ t: 'collected' });
}

// ---------- main ----------

try {
	backend = await connect();
} catch (err) {
	log(err.message);
	process.exit(1);
}
backend.onmessage = (e) => onBackend(typeof e.data === 'string' ? e.data : '');
backend.onclose = () => {
	log('backend closed the link; stopping');
	pi?.kill('SIGTERM');
	setTimeout(() => process.exit(0), 500);
};
