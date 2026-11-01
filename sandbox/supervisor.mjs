// The supervisor: PID 1's child inside every task's container (no dependencies, Node 24).
//
// It dials the backend with the bootstrap token (burnt on connect), opens the browser, relays its
// frames, runs `pi --mode rpc`, passes steer/follow-up/abort through, serves agents-blocked and the
// vault plugin on 127.0.0.1:7777, and sends ~/work/out back when asked. While the owner has control
// of the browser (takeover), pi's process group is stopped and the owner's input reaches Chrome.
// If the link drops without a goodbye (the backend restarted: a deploy), it dials back with the
// session token it got at start and sends what it could not, meanwhile pi keeps working.
//
// The agent's state volume (server/src/state.ts) is mounted at ~/state and kept between runs:
// pi/ (pi's sessions, one per conversation), work/ (~/work; out/ is emptied each run) and
// browser/ (the Chrome profile, AGENT_BROWSER_PROFILE).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readdirSync,
	readFileSync,
	statSync,
	rmSync,
	symlinkSync,
	lstatSync,
} from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { defaultHarness, runtimeToolNames } from './harness.ts';
import { prepareHarness } from './harness-runtime.mjs';

const SERVER = process.env.AGENTS_SERVER_URL;
const TOKEN = process.env.AGENTS_TASK_TOKEN;
const LLM_TOKEN = process.env.AGENTS_LLM_TOKEN;
const HOME = process.env.HOME ?? '/home/agent';
const STATE = join(HOME, 'state');
const PI_SESSIONS = join(STATE, 'pi');
const PROFILE = process.env.AGENT_BROWSER_PROFILE ?? join(STATE, 'browser');
const WORK = join(HOME, 'work');
const OUT = join(WORK, 'out');
// In the volume: MCP OAuth sign-ins (mcp-auth.json) must outlive the container. models.json and
// mcp.json are rewritten at every start from what the backend sends.
const PI_DIR = join(STATE, 'pi-agent');
// CLI tools the owner approved (harness installs), installed once per list into the volume.
const TOOLS = join(STATE, 'tools');
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
let piReady = false; // the prompt went in: pi takes commands now
let harnessReady = null;
let expectedHarness = null;
const piQueue = []; // steer/follow-up/abort that arrived before that
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
			send({ t: 'caps', takeover: true }); // images before takeover never say so
			session = msg.session ?? null;
			blockedWaitMs = msg.blockedWaitMs ?? blockedWaitMs;
			void start(msg).catch((err) => send({ t: 'startup_error', message: err.message }));
			break;
		case 'resumed':
			send({ t: 'caps', takeover: true });
			log(`back on the backend; sending ${backlog.length} queued messages`);
			while (backlog.length && backend?.readyState === 1) backend.send(JSON.stringify(backlog.shift()));
			break;
		case 'bye':
			bye = true;
			break;
		case 'pi_cmd':
			// pi starts seconds after the run (the browser opens first): hold what comes before.
			if (pi?.stdin.writable && piReady) pi.stdin.write(JSON.stringify(msg.cmd) + '\n');
			else piQueue.push(msg.cmd);
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
		case 'watch':
			watched = Boolean(msg.on);
			break;
		case 'files':
			// Attachments of a message that arrives mid-run; the follow-up that names them comes next.
			writeInbox(msg.files ?? []);
			break;
		case 'purge':
			// A vault access was revoked mid-run: wipe that origin now.
			void purgeOrigins(msg.purges ?? []).then((results) => send({ t: 'purged', results }));
			break;
		case 'control':
			setControl(Boolean(msg.on));
			break;
		case 'input':
			// Already checked by the backend: only the owner's events, only while in control.
			if (control && stream?.readyState === 1) stream.send(JSON.stringify(msg.e));
			break;
		case 'nav':
			if (control) void navigate(msg);
			break;
	}
}

// ---------- takeover: the owner drives the browser ----------

let control = false;

/** pi and everything it started (bash, agents-blocked) freeze while the owner drives. */
function setControl(on) {
	if (on === control) return;
	control = on;
	if (pi) {
		try {
			process.kill(-pi.pid, on ? 'SIGSTOP' : 'SIGCONT');
		} catch (err) {
			log(`could not ${on ? 'stop' : 'continue'} pi: ${err.message}`);
		}
	}
	// The wait for an answer does not run out while the owner is busy in the browser.
	if (blocked) {
		clearTimeout(blocked.timer);
		if (!on) blocked.timer = setTimeout(() => releaseBlocked(false), blockedWaitMs);
	}
}

async function navigate(msg) {
	const r =
		msg.action === 'open'
			? await ab('open', String(msg.url ?? ''))
			: ['back', 'forward', 'reload'].includes(msg.action)
				? await ab(msg.action)
				: null;
	if (r?.err)
		send({ t: 'stderr', text: `navegación (${msg.action}): ${String(r.stderr || r.err.message).slice(0, 300)}` });
}

// ---------- the browser ----------

function browserCommand(args, timeout) {
	return new Promise((resolve) =>
		execFile('agent-browser', args, { cwd: WORK, timeout }, (err, stdout, stderr) => resolve({ err, stdout, stderr })),
	);
}
function ab(...args) {
	return browserCommand(args, 60_000);
}

let browserReady = false;
let lastUrl = '';
let lastBrowserFrame = null;
let pending = null;
let flushing = null;
let watched = false; // someone has this agent's view open (the backend says so)
let lastThumb = 0;
const THUMB_MS = 1000;
let stream = null;

/**
 * Frames: a thumbnail a second always (the gallery); the full stream, at most ~5 per second (~10
 * while the owner drives), only while someone watches the agent. Only takeover input is written
 * to the stream socket.
 */
function watchBrowser() {
	const ws = new WebSocket(STREAM);
	stream = ws;
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
		const meta = { ...m.metadata, url: lastUrl };
		const now = Date.now();
		lastBrowserFrame = { t: 'snapshot', jpeg: m.data, meta, at: now };
		// A frame the link cannot take now is dropped, never queued: the next one replaces it.
		const behind = (backend?.bufferedAmount ?? 0) > 512 * 1024;
		if (now - lastThumb >= THUMB_MS && !behind) {
			lastThumb = now;
			send({ t: 'thumb', jpeg: m.data, meta });
		}
		if (!watched) return;
		pending = { t: 'frame', jpeg: m.data, meta };
		if (!flushing) {
			flushing = setTimeout(
				() => {
					flushing = null;
					if (pending && watched && (backend?.bufferedAmount ?? 0) <= 512 * 1024) send(pending);
					pending = null;
				},
				control ? 66 : 200,
			);
		}
	};
	ws.onclose = () => {
		if (stream === ws) stream = null;
		setTimeout(watchBrowser, 1000);
	};
	ws.onerror = () => {};
}

// ---------- attachments ----------

/** Writes a message's attachments under ~/work (in/<message>/<name>); nothing outside it. */
function writeInbox(files) {
	for (const f of files) {
		const rel = String(f.path ?? '');
		if (!/^in\/\d+\/[\w.-]+$/.test(rel)) continue;
		const dest = join(WORK, rel);
		mkdirSync(join(dest, '..'), { recursive: true });
		writeFileSync(dest, Buffer.from(String(f.data ?? ''), 'base64'));
	}
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
	const sessionId = page
		? (await call('Target.attachToTarget', { targetId: page.targetId, flatten: true })).result?.sessionId
		: undefined;
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
			for (const c of doomed)
				await call('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path }, sessionId);
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
	const prepared = prepareHarness(msg.harness ?? defaultHarness(), mkdtempSync('/tmp/agents-harness-'), msg.grantedMcp);
	if (msg.harnessDigest && msg.harnessDigest !== prepared.digest)
		throw new Error('El manifiesto no coincide con la revisión fijada a la corrida.');
	expectedHarness = prepared;
	// GPT only: pi's one provider is OpenAI, through the backend's gateway.
	writeFileSync(
		join(PI_DIR, 'models.json'),
		JSON.stringify({ providers: { openai: { baseUrl: `${SERVER}/llm/openai/v1` } } }),
	);
	if (prepared.mcpConfig)
		writeFileSync(join(PI_DIR, 'mcp.json'), JSON.stringify(prepared.mcpConfig, null, 1), { mode: 0o600 });
	else rmSync(join(PI_DIR, 'mcp.json'), { force: true });
	signOut(msg.mcpLogouts);
	// The agent's own credentials (owner-set, per agent): environment of pi, its shell and MCP servers.
	const secrets =
		msg.secrets && typeof msg.secrets === 'object'
			? Object.fromEntries(
					Object.entries(msg.secrets).filter(([k, v]) => /^[A-Z][A-Z0-9_]{1,63}$/.test(k) && typeof v === 'string'),
				)
			: {};
	const toolPath = `${join(TOOLS, 'bin')}:${join(TOOLS, 'npm', 'node_modules', '.bin')}:${process.env.PATH}`;
	const systemFile = join(STATE, 'contract.md');
	writeFileSync(systemFile, msg.system);
	writeInbox(msg.files ?? []);
	if (msg.kind === 'initialize') {
		send({ t: 'initialization', step: 'workspace' });
		await new Promise((resolve, reject) =>
			execFile(
				'/bin/sh',
				[
					'-ec',
					'command -v pi; command -v agent-browser; command -v agents-login; command -v agents-blocked; pi --version; agent-browser --version',
				],
				{ cwd: WORK, timeout: 30000 },
				(err) => (err ? reject(new Error('Faltan herramientas o no arrancan en esta imagen.')) : resolve()),
			),
		);
		const probe = await new Promise((resolve, reject) =>
			execFile(
				'node',
				['/opt/agents/harness-probe.mjs'],
				{
					timeout: 30000,
					maxBuffer: 1024 * 1024,
					env: { PATH: process.env.PATH, AGENTS_HARNESS: JSON.stringify(prepared.harness) },
				},
				(err, stdout) => {
					const marker = stdout.split(/\r?\n/).find((line) => line.startsWith('AGENTS_HARNESS_PROBE '));
					try {
						const report = JSON.parse(marker?.slice('AGENTS_HARNESS_PROBE '.length) ?? 'null');
						if (err || !report?.ok || report.runtime.digest !== prepared.digest)
							throw new Error(report?.error ?? 'pi no confirmó el harness.');
						resolve(report.runtime);
					} catch (error) {
						reject(error);
					}
				},
			),
		);
		send({ t: 'harness', ...probe });
		send({ t: 'initialization', step: 'tools' });
	}

	// The profile: wiped whole if asked, and freed from the locks a previous container left
	// (Chrome refuses a profile "in use on another computer": every container has its own hostname).
	const purges = msg.purges ?? [];
	const whole = purges.filter((p) => !p.origin);
	if (whole.length) rmSync(PROFILE, { recursive: true, force: true });
	for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) rmSync(join(PROFILE, f), { force: true });

	// A blank browser from the start, so the human sees the screen before the first command.
	const opened = await ab('open', 'about:blank');
	if (opened.err) throw new Error('Chrome no pudo abrirse.');
	browserReady = true;
	watchBrowser();
	const origins = await purgeOrigins(purges.filter((p) => p.origin));
	if (purges.length) send({ t: 'purged', results: [...whole.map((p) => ({ id: p.id, ok: true })), ...origins] });
	if (msg.kind === 'initialize') {
		const probe = await ab('get', 'url');
		if (probe.err || !probe.stdout.includes('about:blank')) throw new Error('Chrome no respondió a la comprobación.');
		send({ t: 'initialization', step: 'browser' });
		send({ t: 'initialized' });
		return; // No LLM turn or work is executed until the owner gives this agent a task.
	}
	// The owner's own browser session: Chrome only, driven by the owner; pi never starts. It may be
	// for signing an MCP server in: pi's login opens its page here and the owner completes it.
	if (msg.kind === 'browser') {
		if (typeof msg.mcpLogin === 'string') mcpLogin(msg.mcpLogin);
		return;
	}
	await installTools(prepared.harness.installs, { ...process.env, PATH: toolPath });

	// pi gets only the LLM token, as its provider key. The bootstrap token stays out of its env.
	// Its session is the conversation's: same id, same history, in the agent's volume.
	const env = {
		...process.env,
		...secrets,
		...proxyEnvironment(msg.proxy),
		...prepared.env,
		PATH: toolPath,
		OPENAI_API_KEY: LLM_TOKEN,
		PI_CODING_AGENT_DIR: PI_DIR,
	};
	delete env.AGENTS_TASK_TOKEN;
	delete env.AGENTS_LLM_TOKEN;
	const session = msg.piSession ? ['--session-dir', PI_SESSIONS, '--session-id', msg.piSession] : ['--no-session'];
	const loaded = new Promise((resolve, reject) => {
		harnessReady = { resolve, reject };
	});
	pi = spawn(
		'pi',
		[
			'--mode',
			'rpc',
			...session,
			'--offline',
			...prepared.args,
			'--model',
			msg.model,
			'--append-system-prompt',
			systemFile,
		],
		// Its own process group, so a takeover can stop pi and whatever it started at once.
		{ cwd: WORK, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true },
	);
	if (control)
		setTimeout(() => {
			try {
				process.kill(-pi.pid, 'SIGSTOP');
			} catch {}
		});
	readLines(pi.stdout, onPiLine);
	let stderrLines = 0;
	readLines(pi.stderr, (line) => {
		if (line.startsWith('AGENTS_HARNESS_READY ')) onPiLine(line.slice('AGENTS_HARNESS_READY '.length));
		else if (line.trim() && stderrLines++ < 50) send({ t: 'stderr', text: line });
	});
	pi.on('error', (err) => harnessReady?.reject(err));
	pi.on('exit', (code) => {
		harnessReady?.reject(new Error(`pi terminó antes de confirmar el harness (${code}).`));
		send({ t: 'exit', code });
		pi = null;
	});
	let timer;
	try {
		await Promise.race([
			loaded,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error('pi no confirmó el harness aprobado.')), 30000);
			}),
		]);
	} finally {
		clearTimeout(timer);
		harnessReady = null;
	}
	pi.stdin.write(JSON.stringify({ id: 'task', type: 'prompt', message: msg.prompt }) + '\n');
	piReady = true;
	for (const cmd of piQueue.splice(0)) pi.stdin.write(JSON.stringify(cmd) + '\n');
}

/**
 * Granted MCP servers the owner revoked or deleted (#24, Q6): their OAuth sessions leave this
 * agent's volume. pi keys them `mcp__<server>|<url>` in mcp-auth.json; `pi mcp logout` would need the
 * server still configured, which a revoked one no longer is.
 */
function signOut(logouts) {
	if (!Array.isArray(logouts) || !logouts.length) return;
	const file = join(PI_DIR, 'mcp-auth.json');
	try {
		const auth = JSON.parse(readFileSync(file, 'utf8'));
		for (const { server } of logouts) {
			const ns = `mcp__${String(server).replace(/-/g, '_')}|`;
			for (const key of Object.keys(auth)) if (key.startsWith(ns)) delete auth[key];
		}
		writeFileSync(file, JSON.stringify(auth, null, 1), { mode: 0o600 });
	} catch {
		// No sessions stored, or unreadable: nothing to sign out of.
	}
	send({ t: 'mcp_logouts', ids: logouts.map((l) => l.id) });
}

// ---------- the egress proxy (#24) ----------

/**
 * The owner's API keys reach this computer as placeholders; the backend's egress proxy swaps each
 * for its value only towards that key's domains. Everything of pi's (its shell, CLIs, MCP servers)
 * goes out through it, trusting its CA; the backend itself is reached directly. A tool that ignores
 * the proxy just sends the placeholder: it fails, it leaks nothing. Chrome never uses it.
 */
function proxyEnvironment(proxy) {
	if (!proxy || typeof proxy.url !== 'string' || typeof proxy.ca !== 'string') return {};
	let system = '';
	try {
		system = readFileSync('/etc/ssl/certs/ca-certificates.crt', 'utf8');
	} catch {}
	const bundle = '/tmp/agents-ca.pem';
	writeFileSync(bundle, `${system.trimEnd()}\n${proxy.ca.trim()}\n`, { mode: 0o644 });
	const direct = ['localhost', '127.0.0.1', '::1', new URL(SERVER).hostname].join(',');
	return {
		HTTP_PROXY: proxy.url,
		HTTPS_PROXY: proxy.url,
		http_proxy: proxy.url,
		https_proxy: proxy.url,
		NO_PROXY: direct,
		no_proxy: direct,
		NODE_USE_ENV_PROXY: '1',
		NODE_EXTRA_CA_CERTS: bundle,
		SSL_CERT_FILE: bundle,
		REQUESTS_CA_BUNDLE: bundle,
		CURL_CA_BUNDLE: bundle,
		GIT_SSL_CAINFO: bundle,
	};
}

// ---------- CLI tools and MCP sign-in ----------

function run(bin, args, env, timeout = 10 * 60_000) {
	return new Promise((resolve, reject) =>
		execFile(bin, args, { cwd: WORK, env, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, _out, errOut) =>
			err
				? reject(
						new Error(
							`${bin} ${args.slice(0, 3).join(' ')}: ${String(errOut || err.message)
								.trim()
								.split('\n')
								.slice(-3)
								.join(' ')
								.slice(0, 400)}`,
						),
					)
				: resolve(),
		),
	);
}

/** Installs the approved list once; the same list on the next start finds it done. */
async function installTools(installs, env) {
	if (!installs?.length) return;
	const want = createHash('sha256').update(JSON.stringify(installs)).digest('hex'),
		marker = join(TOOLS, '.installed');
	try {
		if (readFileSync(marker, 'utf8') === want) return;
	} catch {}
	send({ t: 'note', message: `Instalando herramientas: ${installs.map((i) => i.name ?? i.spec).join(', ')}…` });
	rmSync(TOOLS, { recursive: true, force: true });
	mkdirSync(join(TOOLS, 'bin'), { recursive: true });
	const npm = installs.filter((i) => i.kind === 'npm').map((i) => i.spec);
	if (npm.length)
		await run(
			'npm',
			['install', '--prefix', join(TOOLS, 'npm'), '--no-audit', '--no-fund', '--loglevel=error', ...npm],
			env,
		);
	for (const i of installs.filter((x) => x.kind === 'uv')) {
		await run('uv', ['tool', 'install', i.spec], {
			...env,
			UV_TOOL_DIR: join(TOOLS, 'uv'),
			UV_TOOL_BIN_DIR: join(TOOLS, 'bin'),
			UV_CACHE_DIR: '/tmp/uv-cache',
			UV_PYTHON_PREFERENCE: 'only-system',
		});
	}
	for (const i of installs.filter((x) => x.kind === 'binary')) {
		const res = await fetch(i.spec, { signal: AbortSignal.timeout(120_000) });
		if (!res.ok) throw new Error(`${i.name}: la descarga respondió ${res.status}.`);
		const data = Buffer.from(await res.arrayBuffer());
		if (createHash('sha256').update(data).digest('hex') !== i.sha256)
			throw new Error(`${i.name}: el sha256 no coincide; no se instaló.`);
		writeFileSync(join(TOOLS, 'bin', i.name), data, { mode: 0o755 });
	}
	writeFileSync(marker, want);
	send({ t: 'note', message: 'Herramientas instaladas.' });
}

/** pi signs the MCP server in: its authorization page opens in this browser for the owner. */
function mcpLogin(server) {
	send({
		t: 'note',
		message: `Iniciar sesión en el servidor MCP «${server}»: completa la autorización en el navegador.`,
	});
	const child = spawn('pi', ['mcp', 'login', server, '--timeout', '600'], {
		cwd: WORK,
		env: { ...process.env, PI_CODING_AGENT_DIR: PI_DIR, BROWSER: 'agents-open' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let opened = false,
		tail = '';
	const watch = (chunk) => {
		const text = chunk.toString();
		tail = (tail + text).slice(-2000);
		const url = text.match(/https?:\/\/[^\s"'<>]+/)?.[0];
		// The authorization page, not pi's own callback on this machine.
		if (url && !opened && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(url)) {
			opened = true;
			void ab('open', url);
		}
	};
	child.stdout.on('data', watch);
	child.stderr.on('data', watch);
	child.on('exit', (code) =>
		send({ t: 'mcp_login', server, ok: code === 0, detail: code === 0 ? '' : tail.trim().slice(-400) }),
	);
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

const FORWARD = new Set([
	'message_end',
	'tool_execution_start',
	'tool_execution_end',
	'agent_settled',
	'auto_retry_start',
	'agent_start',
]);
let lastUpdate = 0;

function onPiLine(line) {
	let ev;
	try {
		ev = JSON.parse(line);
	} catch {
		return;
	}
	if (ev.type === 'agents_harness_ready') {
		if (
			!expectedHarness ||
			ev.digest !== expectedHarness.digest ||
			JSON.stringify(ev.tools) !== JSON.stringify(runtimeToolNames(expectedHarness.harness))
		)
			harnessReady?.reject(new Error('Las herramientas efectivas no coinciden con el harness aprobado.'));
		else {
			send({ t: 'harness', digest: ev.digest, tools: ev.tools, skills: ev.skills, plugins: ev.plugins });
			harnessReady?.resolve();
		}
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
			: `Nadie respondió en ${Math.round(blockedWaitMs / 60000)} minutos. Salta este sitio y continúa con otros.\n`,
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

const MIME = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.json': 'application/json',
	'.csv': 'text/csv',
	'.md': 'text/markdown',
	'.txt': 'text/plain',
	'.pdf': 'application/pdf',
};

async function collect() {
	let files = [];
	try {
		files = readdirSync(OUT)
			.filter((f) => statSync(join(OUT, f)).isFile())
			.slice(0, 40);
	} catch {}
	for (const name of files) {
		const path = join(OUT, name);
		if (statSync(path).size > 10 * 1024 * 1024) continue;
		send({
			t: 'file',
			name,
			mime: MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
			data: readFileSync(path).toString('base64'),
		});
	}
	// A quick initialization can finish before the stream's first frame. Capture the already
	// opened browser in that case (5 s bound), without manufacturing an image or agent output.
	if (!lastBrowserFrame && browserReady) {
		const temp = mkdtempSync('/tmp/agents-final-browser-'),
			path = join(temp, 'screen.jpg');
		try {
			const [shot, url] = await Promise.all([
				browserCommand(['screenshot', '--screenshot-format', 'jpeg', '--screenshot-quality', '70', path], 5000),
				browserCommand(['get', 'url'], 1500),
			]);
			if (!shot.err && statSync(path).size <= 3 * 1024 * 1024)
				lastBrowserFrame = {
					t: 'snapshot',
					jpeg: readFileSync(path).toString('base64'),
					meta: { url: url.err ? lastUrl : url.stdout.trim() },
					at: Date.now(),
				};
		} catch (err) {
			log(`No final browser capture: ${err.message}`);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	}
	// Preserve the last observed image even with no web viewer. It is not an agent output file.
	if (lastBrowserFrame) send(lastBrowserFrame);
	// The container is removed right after: close Chrome cleanly so cookies and storage reach the
	// profile on disk (it writes them lazily, and a killed Chrome loses the last ones).
	await ab('close');
	send({ t: 'collected' });
}

// ---------- main ----------

function stop(why) {
	log(why);
	if (control) setControl(false);
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
