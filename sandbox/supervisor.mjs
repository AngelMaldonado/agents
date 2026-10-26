// The supervisor: PID 1's child inside every task's container (no dependencies, Node 24).
//
// It dials the backend with the bootstrap token (burnt on connect), opens the browser, relays its
// frames read-only, runs `pi --mode rpc`, passes steer/follow-up/abort through, serves
// agents-blocked and the vault plugin on 127.0.0.1:7777, and sends ~/work/out back when asked.
// If the link drops without a goodbye (the backend restarted: a deploy), it dials back with the
// session token it got at start and sends what it could not, meanwhile pi keeps working.
//
// The agent's state volume (server/src/state.ts) is mounted at ~/state and kept between runs:
// pi/ (pi's sessions, one per conversation), work/ (~/work; out/ is emptied each run) and
// browser/ (the Chrome profile, AGENT_BROWSER_PROFILE).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFile } from 'node:child_process';

const SERVER = process.env.AGENTS_SERVER_URL;
const TOKEN = process.env.AGENTS_TASK_TOKEN;
const LLM_TOKEN = process.env.AGENTS_LLM_TOKEN;
const HOME = process.env.HOME ?? '/home/agent';
const STATE = join(HOME, 'state');
const PI_SESSIONS = join(STATE, 'pi');
const PROFILE = process.env.AGENT_BROWSER_PROFILE ?? join(STATE, 'browser');
const WORK = join(HOME, 'work');
const OUT = join(WORK, 'out');
const PI_DIR = join(HOME, '.pi', 'agent');
const STREAM = `ws://127.0.0.1:${process.env.AGENT_BROWSER_STREAM_PORT ?? 9223}`;

// ~/work lives in the volume; out/ starts empty (the backend kept the last run's files).
mkdirSync(join(STATE, 'work'), { recursive: true });
mkdirSync(PI_SESSIONS, { recursive: true });
try {
	if (!lstatSync(WORK).isSymbolicLink()) rmSync(WORK, { recursive: true, force: true });
} catch {}
try {
	symlinkSync(join(STATE, 'work'), WORK);
} catch {}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(PI_DIR, { recursive: true });

const log = (...a) => console.error('[supervisor]', ...a);
let backend = null;
let pi = null;
let blockedWaitMs = 10 * 60_000;
let session = null; // from the backend's start message; reconnects with it
let bye = false; // the backend ended the run: a close is final
const backlog = []; // what could not be sent while the link was down (never frames)
const BACKLOG_MAX = 2000;

function send(msg) {
	if (backend?.readyState === 1) return backend.send(JSON.stringify(msg));
	if (msg.t !== 'frame' && backlog.length < BACKLOG_MAX) backlog.push(msg);
}

// ---------- backend link ----------

async function connect(query, tries) {
	const url = `${SERVER.replace(/^http/, 'ws')}/sandbox/ws?${query}`;
	for (let i = 0; i < tries; i++) {
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
			session = msg.session ?? null;
			blockedWaitMs = msg.blockedWaitMs ?? blockedWaitMs;
			void start(msg);
			break;
		case 'resumed':
			log(`back on the backend; sending ${backlog.length} queued messages`);
			while (backlog.length && backend?.readyState === 1) backend.send(JSON.stringify(backlog.shift()));
			break;
		case 'bye':
			bye = true;
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
			void collect();
			break;
		case 'purge':
			// A vault access was revoked mid-run: wipe that origin now.
			void purgeOrigins(msg.purges ?? []).then((results) => send({ t: 'purged', results }));
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

// ---------- the browser profile: wiping one origin ----------

/**
 * Over Chrome's DevTools socket: Storage.clearDataForOrigin (cookies, localStorage, IndexedDB,
 * caches…) plus the cookies of parent domains that this host also receives.
 */
async function purgeOrigins(purges) {
	if (!purges.length) return [];
	const { stdout } = await ab('get', 'cdp-url');
	const url = stdout.trim().split('\n').pop();
	let ws;
	try {
		ws = new WebSocket(url);
		await new Promise((resolve, reject) => {
			ws.onopen = resolve;
			ws.onerror = () => reject(new Error(`no DevTools socket at ${url}`));
		});
	} catch (err) {
		return purges.map((p) => ({ id: p.id, ok: false, detail: err.message }));
	}
	let seq = 0;
	const waiting = new Map();
	ws.onmessage = (e) => {
		const m = JSON.parse(e.data);
		waiting.get(m.id)?.(m);
		waiting.delete(m.id);
	};
	const call = (method, params = {}, sessionId) =>
		new Promise((resolve) => {
			const id = ++seq;
			waiting.set(id, resolve);
			ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	const page = (await call('Target.getTargets')).result?.targetInfos?.find((t) => t.type === 'page');
	const sessionId = page ? (await call('Target.attachToTarget', { targetId: page.targetId, flatten: true })).result?.sessionId : undefined;
	const results = [];
	for (const p of purges) {
		try {
			const host = new URL(p.origin).hostname;
			// Chrome 156 answers "Internal error" to this on the browser target; on a page session it works.
			const cleared = await call('Storage.clearDataForOrigin', { origin: p.origin, storageTypes: 'all' }, sessionId);
			if (cleared.error) throw new Error(cleared.error.message);
			const cookies = (await call('Storage.getCookies')).result?.cookies ?? [];
			const doomed = cookies.filter((c) => {
				const d = c.domain.replace(/^\./, '');
				return host === d || host.endsWith(`.${d}`);
			});
			for (const c of doomed) await call('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path }, sessionId);
			results.push({ id: p.id, ok: true, detail: `${doomed.length} cookies más` });
		} catch (err) {
			results.push({ id: p.id, ok: false, detail: err.message });
		}
	}
	ws.close();
	return results;
}

// ---------- pi ----------

async function start(msg) {
	// GPT only: pi's one provider is OpenAI, through the backend's gateway.
	writeFileSync(join(PI_DIR, 'models.json'), JSON.stringify({ providers: { openai: { baseUrl: `${SERVER}/llm/openai/v1` } } }));
	const systemFile = join(HOME, '.pi', 'agents-system.md');
	writeFileSync(systemFile, msg.system);

	// The profile: wiped whole if asked, and freed from the locks a previous container left
	// (Chrome refuses a profile "in use on another computer": every container has its own hostname).
	const purges = msg.purges ?? [];
	const whole = purges.filter((p) => !p.origin);
	if (whole.length) rmSync(PROFILE, { recursive: true, force: true });
	for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) rmSync(join(PROFILE, f), { force: true });

	// A blank browser from the start, so the human sees the screen before the first command.
	await ab('open', 'about:blank');
	watchBrowser();
	const origins = await purgeOrigins(purges.filter((p) => p.origin));
	if (purges.length) send({ t: 'purged', results: [...whole.map((p) => ({ id: p.id, ok: true })), ...origins] });

	// pi gets only the LLM token, as its provider key. The bootstrap token stays out of its env.
	// Its session is the conversation's: same id, same history, in the agent's volume.
	const env = { ...process.env, OPENAI_API_KEY: LLM_TOKEN, PI_CODING_AGENT_DIR: PI_DIR };
	delete env.AGENTS_TASK_TOKEN;
	delete env.AGENTS_LLM_TOKEN;
	const session = msg.piSession ? ['--session-dir', PI_SESSIONS, '--session-id', msg.piSession] : ['--no-session'];
	pi = spawn(
		'pi',
		['--mode', 'rpc', ...session, '--offline', '-ne', '-ns', '-nc', '--no-mcp', '--model', msg.model, '--append-system-prompt', systemFile],
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

async function collect() {
	let files = [];
	try {
		files = readdirSync(OUT).filter((f) => statSync(join(OUT, f)).isFile()).slice(0, 40);
	} catch {}
	for (const name of files) {
		const path = join(OUT, name);
		if (statSync(path).size > 10 * 1024 * 1024) continue;
		send({ t: 'file', name, mime: MIME[extname(name).toLowerCase()] ?? 'application/octet-stream', data: readFileSync(path).toString('base64') });
	}
	// The container is removed right after: close Chrome cleanly so cookies and storage reach the
	// profile on disk (it writes them lazily, and a killed Chrome loses the last ones).
	await ab('close');
	send({ t: 'collected' });
}

// ---------- main ----------

function stop(why) {
	log(why);
	pi?.kill('SIGTERM');
	setTimeout(() => process.exit(0), 500);
}

function link(ws) {
	backend = ws;
	ws.onmessage = (e) => onBackend(typeof e.data === 'string' ? e.data : '');
	ws.onclose = async (e) => {
		backend = null;
		if (bye || !session || e.code === 4401) return stop('backend closed the link; stopping');
		// A dropped link, not a goodbye: the backend is probably restarting. Ten minutes to return.
		log('link dropped; reconnecting with the session token');
		try {
			link(await connect(`session=${encodeURIComponent(session)}`, 600));
		} catch (err) {
			stop(`${err.message}; stopping`);
		}
	};
}

try {
	link(await connect(`token=${encodeURIComponent(TOKEN)}`, 60));
} catch (err) {
	log(err.message);
	process.exit(1);
}
