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
import { connect as tcpConnect } from 'node:net';
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
	realpathSync,
} from 'node:fs';
import { join, extname, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { defaultHarness, runtimeToolNames } from './harness.ts';
import { prepareHarness } from './harness-runtime.mjs';
import { installAuthorized } from './self-maintenance.mjs';

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
// CLI tools installed by hand (the owner's terminal, or the agent itself): bun add -g, uv tool, pip --user.
// In the volume and on the PATH, so they are there at the next run (#27). The computer runs on Bun: there
// is no Node.js nor npm (`node` and `npx` are Bun's stand-ins, at the end of the PATH).
const LOCAL = join(STATE, 'local');
const localEnv = {
	BUN_INSTALL_GLOBAL_DIR: join(LOCAL, 'bun'),
	BUN_INSTALL_BIN: join(LOCAL, 'bin'),
	PYTHONUSERBASE: LOCAL,
	UV_TOOL_DIR: join(LOCAL, 'uv'),
	UV_TOOL_BIN_DIR: join(LOCAL, 'bin'),
};
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
let assignedCard = null; // Pagos simulados: the run's card, for the browser wrapper (GET /card)
let bye = false; // the backend ended the run: a close is final
const backlog = []; // what could not be sent while the link was down (never frames)
const BACKLOG_MAX = 2000;

function send(msg) {
	if (backend?.readyState === 1) return backend.send(JSON.stringify(msg));
	if (msg.t !== 'frame' && msg.t !== 'chan_out' && backlog.length < BACKLOG_MAX) backlog.push(msg);
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
			// Its assigned card for this run (Pagos simulados), whole: only the browser wrapper asks for it.
			assignedCard = msg.card ?? null;
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
		case 'self_result': {
			const waiter = selfWaiters.get(msg.id);
			selfWaiters.delete(msg.id);
			waiter?.(msg.result);
			break;
		}
		case 'notify_res': {
			const waiter = notifyWaiters.get(msg.id);
			notifyWaiters.delete(msg.id);
			waiter?.(msg);
			break;
		}
		case 'job_res': {
			const waiter = jobWaiters.get(msg.id);
			jobWaiters.delete(msg.id);
			waiter?.(msg.result);
			break;
		}
		case 'memory_res': {
			const waiter = memoryWaiters.get(msg.id);
			memoryWaiters.delete(msg.id);
			waiter?.(msg.result);
			break;
		}
		case 'flow_res': {
			const waiter = flowWaiters.get(msg.id);
			flowWaiters.delete(msg.id);
			waiter?.(msg.result);
			break;
		}
		case 'delegation_res': {
			const waiter = delegationWaiters.get(msg.id);
			delegationWaiters.delete(msg.id);
			waiter?.(msg.result);
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
		case 'chan':
			// The owner's terminal or desktop (#27); the backend already checked who it is.
			channel(msg);
			break;
		case 'mcp_request_done':
			mcpRequests.get(msg.id)?.(msg);
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
	// Our own display first: Chrome, pi's shell and the owner's terminal share it, and the owner's
	// desktop view shows it (#27).
	await startDisplay();
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
	if (Array.isArray(msg.undelivered) && msg.undelivered.length)
		send({
			t: 'note',
			message: `Concedido pero no entregado en esta tarea (falta el proxy de salida): ${msg.undelivered.join(', ')}.`,
		});
	// The agent's own credentials (owner-set, per agent): environment of pi, its shell and MCP servers.
	const secrets =
		msg.secrets && typeof msg.secrets === 'object'
			? Object.fromEntries(
					Object.entries(msg.secrets).filter(([k, v]) => /^[A-Z][A-Z0-9_]{1,63}$/.test(k) && typeof v === 'string'),
				)
			: {};
	const toolPath = `${join(LOCAL, 'bin')}:${join(TOOLS, 'bin')}:${join(TOOLS, 'npm', 'node_modules', '.bin')}:${process.env.PATH}`;
	// What pi, its shell and its MCP servers get. The bootstrap and LLM tokens stay out of it.
	const env = {
		...process.env,
		...secrets,
		...proxyEnvironment(msg.proxy),
		...prepared.env,
		...localEnv,
		// agent-browser passes through its wrapper first: it heals a lost tab and, in a simulated list of
		// tasks (AGENTS_SIMULATION), intercepts clicks to pay.
		PATH: `/opt/agents/browser-bin:${toolPath}`,
		...(msg.simulation ? { AGENTS_SIMULATION: '1' } : {}),
		OPENAI_API_KEY: LLM_TOKEN,
		// The harness' subagents run pi again with the agent's own model and system prompt.
		AGENTS_MODEL: msg.model,
		AGENTS_CONTRACT: join(STATE, 'contract.md'),
		PI_CODING_AGENT_DIR: PI_DIR,
	};
	delete env.AGENTS_TASK_TOKEN;
	delete env.AGENTS_LLM_TOKEN;
	// The owner's terminal: the agent's own environment, minus its LLM token.
	// `pi` there is your agent (agents-pi, from /opt/agents/owner-bin); the agent's own PATH lacks it.
	terminalEnv = { ...env, PATH: `${OWNER_BIN}:${env.PATH}` };
	delete terminalEnv.OPENAI_API_KEY;
	checkContext = { prepared, msg, env, secrets };
	writeConfig(prepared, msg);
	const systemFile = join(STATE, 'contract.md');
	writeFileSync(systemFile, msg.system);
	// agents-pi: the same pi as the agent's (its harness, prompt and model), interactive, on its main chat.
	piLaunch = {
		kind: msg.kind,
		args: [
			...(msg.mainPiSession ? ['--session-dir', PI_SESSIONS, '--session-id', msg.mainPiSession] : ['--no-session']),
			'--offline',
			...prepared.args,
			'--model',
			msg.model,
			'--append-system-prompt',
			systemFile,
		],
		env: { ...prepared.env, OPENAI_API_KEY: LLM_TOKEN, PI_CODING_AGENT_DIR: PI_DIR, AGENTS_INTERACTIVE: '1' },
	};
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
				process.execPath,
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
		send({ t: 'access_check', ...(await checkAccess(prepared, msg, env, secrets)) });
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

	// pi gets only the LLM token, as its provider key (env, above).
	// Its session is the conversation's: same id, same history, in the agent's volume.
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
	// Packages from the npm registry, installed with Bun into their own project (its node_modules/.bin is on the PATH).
	const npm = installs.filter((i) => i.kind === 'npm').map((i) => i.spec);
	if (npm.length) {
		mkdirSync(join(TOOLS, 'npm'), { recursive: true });
		writeFileSync(join(TOOLS, 'npm', 'package.json'), JSON.stringify({ private: true }));
		await run('bun', ['add', '--cwd', join(TOOLS, 'npm'), '--exact', '--no-progress', ...npm], env);
	}
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

/**
 * Initialization proves what the agent was given instead of only promising it: the CLI tools are
 * installed (kept for its first task), each MCP server answers `tools/list` with the agent's own
 * environment, and the granted keys are in it (names only). Failures are reported, not fatal.
 */
async function checkAccess(prepared, msg, env, secrets, install = true) {
	const toolPath = env.PATH;
	const installs = prepared.harness.installs ?? [];
	let tools = { ok: true, names: installs.map((i) => i.name ?? i.spec) };
	try {
		if (install) await installTools(installs, { ...process.env, PATH: toolPath });
		else if (
			installs.length &&
			readFileSync(join(TOOLS, '.installed'), 'utf8') !==
				createHash('sha256').update(JSON.stringify(installs)).digest('hex')
		)
			throw new Error('Las herramientas aprobadas no están preparadas.');
	} catch (err) {
		tools = { ...tools, ok: false, detail: err.message.slice(0, 400) };
	}
	const servers = [...(prepared.harness.mcp ?? []), ...(Array.isArray(msg.grantedMcp) ? msg.grantedMcp : [])];
	let mcp = [];
	if (servers.length)
		mcp = await new Promise((resolve) =>
			execFile(
				process.execPath,
				['/opt/agents/harness-check.mjs'],
				{
					cwd: WORK,
					timeout: 30_000 * servers.length,
					maxBuffer: 1024 * 1024,
					env: { ...env, AGENTS_MCP_CHECK: JSON.stringify(servers) },
				},
				(_err, stdout) => {
					const line = String(stdout)
						.split('\n')
						.find((l) => l.startsWith('AGENTS_MCP_CHECK '));
					try {
						resolve(JSON.parse(line.slice('AGENTS_MCP_CHECK '.length)));
					} catch {
						resolve(servers.map((s) => ({ name: s.name, ok: false, detail: 'la comprobación no terminó' })));
					}
				},
			),
		);
	return {
		tools,
		mcp,
		keys: Object.keys(secrets).sort(),
		undelivered: Array.isArray(msg.undelivered) ? msg.undelivered : [],
	};
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

const selfWaiters = new Map();
let selfSeq = 0,
	selfBusy = false;
function selfRequest(request) {
	return new Promise((resolve) => {
		const id = ++selfSeq;
		const timer = setTimeout(() => {
			selfWaiters.delete(id);
			resolve({ error: 'La plataforma no respondió; consulta el estado antes de repetir.' });
		}, 45000);
		selfWaiters.set(id, (r) => {
			clearTimeout(timer);
			resolve(r);
		});
		send({ t: 'self_request', id, request });
	});
}
async function selfOperation(request) {
	// Install receipts and runtime facts come only from this supervisor, not the agent's HTTP payload.
	if (!request || !['diagnose', 'propose', 'status', 'execute'].includes(request.action))
		return { error: 'Operación de mantenimiento no disponible.' };
	if (request.action === 'execute') {
		if (selfBusy) return { error: 'Ya hay una instalación en curso.' };
		selfBusy = true;
		try {
			const plan = await selfRequest({ action: 'install_begin', id: request.id });
			if (plan.error) return plan;
			if (plan.completed) return plan.completed;
			const installed = await installAuthorized(plan, { work: WORK, env: checkContext?.env ?? process.env });
			const saved = await selfRequest({ action: 'install_result', id: request.id, ok: installed.ok });
			return { ...saved, installation: installed };
		} finally {
			selfBusy = false;
		}
	}
	const response = await selfRequest(request);
	if (request.action === 'diagnose' && !response.error && checkContext) {
		const { prepared, msg, env, secrets } = checkContext;
		const local = await checkAccess(prepared, msg, env, secrets, false);
		const runtime = {
			tools: { ok: local.tools.ok, names: local.tools.names },
			mcp: local.mcp.map((m) => ({
				name: m.name,
				ok: m.ok,
				detail: m.ok
					? 'tools/list respondió'
					: m.ok === null
						? 'Requiere iniciar sesión; revisa OAuth en Accesos.'
						: 'No se pudo listar herramientas. Revisa URL, autenticación y permisos; no se demuestra una clave inválida.',
			})),
			keys: local.keys,
			undelivered: local.undelivered,
		};
		return selfRequest({ action: 'diagnosis_result', runtime });
	}
	return response;
}
const credWaiters = new Map();
const notifyWaiters = new Map();
let notifySeq = 0;
const delegationWaiters = new Map();
let delegationSeq = 0;
const flowWaiters = new Map();
let flowSeq = 0;
const memoryWaiters = new Map();
let memorySeq = 0;
const jobWaiters = new Map();
let jobSeq = 0;
let credSeq = 0;

createServer((req, res) => {
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', () => {
		if (req.method === 'POST' && req.url === '/self-maintenance') {
			if (body.length > 64000) {
				res.statusCode = 413;
				return res.end(JSON.stringify({ error: 'Petición demasiado grande.' }));
			}
			let request;
			try {
				request = JSON.parse(body);
			} catch {
				return res.end(JSON.stringify({ error: 'JSON inválido.' }));
			}
			void selfOperation(request)
				.then((r) => res.end(JSON.stringify(r)))
				.catch(() =>
					res.end(
						JSON.stringify({ error: 'No se pudo completar el mantenimiento. Consulta el estado antes de repetir.' }),
					),
				);
			return;
		}
		if (req.method === 'GET' && req.url === '/card') {
			// The browser wrapper fills {{tarjeta.*}} with it; the model never gets it.
			res.end(JSON.stringify(assignedCard ? { ok: true, card: assignedCard } : { ok: false }));
			return;
		}
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
		if (req.method === 'POST' && req.url === '/notify') {
			// whatsapp_notify: the server decides (contract, contacts, limits) and sends; a file goes along.
			let q = {};
			try {
				q = JSON.parse(body);
			} catch {}
			const id = ++notifySeq;
			const done = (r) => res.end(JSON.stringify(r));
			let file;
			if (q.archivo) {
				const path = resolve(WORK, String(q.archivo));
				if (!path.startsWith(`${WORK}/`)) return done({ ok: false, error: 'El archivo debe estar dentro de ~/work.' });
				try {
					const data = readFileSync(path);
					if (data.length > 8 * 1024 * 1024) return done({ ok: false, error: 'El archivo pasa de 8 MB.' });
					file = { name: basename(path), data: data.toString('base64') };
				} catch {
					return done({ ok: false, error: `No encontré ${q.archivo}.` });
				}
			}
			const timer = setTimeout(() => {
				notifyWaiters.delete(id);
				done({ ok: false, error: 'La plataforma no respondió a tiempo; no se sabe si el aviso salió.' });
			}, 80_000);
			notifyWaiters.set(id, (r) => {
				clearTimeout(timer);
				const { t: _t, id: _id, ...result } = r;
				done(result);
			});
			send({ t: 'notify', id, to: q.para, text: q.texto, urgent: !!q.urgente, file });
			return;
		}
		if (req.method === 'POST' && req.url === '/simulated') {
			// Simulación: the interceptor stopped a click to pay; the platform records it.
			let q = {};
			try {
				q = JSON.parse(body);
			} catch {}
			send({
				t: 'simulated',
				action: String(q.action ?? '').slice(0, 300),
				label: String(q.label ?? '').slice(0, 200),
			});
			return res.end(JSON.stringify({ ok: true }));
		}
		const jobOp = req.method === 'POST' && req.url?.match(/^\/job\/(done|goal)$/);
		if (jobOp) {
			// The trabajo it works on: the server keeps its objective and closes it.
			let args = {};
			try {
				args = JSON.parse(body);
			} catch {}
			const id = ++jobSeq;
			const timer = setTimeout(() => {
				jobWaiters.delete(id);
				res.end(JSON.stringify({ ok: false, error: 'La plataforma no respondió a tiempo.' }));
			}, 25_000);
			jobWaiters.set(id, (r) => {
				clearTimeout(timer);
				res.end(JSON.stringify(r ?? { ok: false, error: 'Sin respuesta.' }));
			});
			send({ t: 'job', id, op: jobOp[1], args });
			return;
		}
		const flowOp = req.method === 'POST' && req.url?.match(/^\/flow\/(plan|update|ask|list)$/);
		if (flowOp) {
			// Tareas: the server checks the list, the recipe and the budget, and keeps the tasks.
			let args = {};
			try {
				args = JSON.parse(body);
			} catch {}
			// A question's files (a report) go along, read here from ~/work.
			if (Array.isArray(args.archivos)) {
				const files = [];
				for (const path of args.archivos.slice(0, 5)) {
					const full = resolve(WORK, String(path));
					if (!full.startsWith(`${WORK}/`))
						return res.end(JSON.stringify({ ok: false, error: 'Los archivos deben estar dentro de ~/work.' }));
					try {
						const data = readFileSync(full);
						if (data.length > 8 * 1024 * 1024)
							return res.end(JSON.stringify({ ok: false, error: `${path} pasa de 8 MB.` }));
						files.push({ name: basename(full), data: data.toString('base64') });
					} catch {
						return res.end(JSON.stringify({ ok: false, error: `No encontré ${path}.` }));
					}
				}
				delete args.archivos;
				args.files = files;
			}
			const id = ++flowSeq;
			const timer = setTimeout(() => {
				flowWaiters.delete(id);
				res.end(JSON.stringify({ ok: false, error: 'La plataforma no respondió a tiempo; consulta task_list.' }));
			}, 50_000);
			flowWaiters.set(id, (r) => {
				clearTimeout(timer);
				res.end(JSON.stringify(r ?? { ok: false, error: 'Sin respuesta.' }));
			});
			send({ t: 'flow', id, op: flowOp[1], args });
			return;
		}
		const memoryOp = req.method === 'POST' && req.url?.match(/^\/memory\/(learn)$/);
		if (memoryOp) {
			// Aprendizajes (learn): the server keeps what the agent learns for other trabajos.
			let args = {};
			try {
				args = JSON.parse(body);
			} catch {}
			const id = ++memorySeq;
			const timer = setTimeout(() => {
				memoryWaiters.delete(id);
				res.end(
					JSON.stringify({
						ok: false,
						error: 'La plataforma no respondió a tiempo; no repitas el mismo aprendizaje.',
					}),
				);
			}, 25_000);
			memoryWaiters.set(id, (r) => {
				clearTimeout(timer);
				res.end(JSON.stringify(r ?? { ok: false, error: 'Sin respuesta.' }));
			});
			send({ t: 'memory', id, op: memoryOp[1], args });
			return;
		}
		const delegationOp = req.method === 'POST' && req.url?.match(/^\/delegation\/(start|status|message|cancel)$/);
		if (delegationOp) {
			// Encargos: the server checks the template, the contact and the limits, and runs them.
			let args = {};
			try {
				args = JSON.parse(body);
			} catch {}
			// Files of ~/work it may send the contact go along, read here (the server never reads this disk).
			if (Array.isArray(args.archivos)) {
				const files = [];
				for (const path of args.archivos.slice(0, 5)) {
					const full = resolve(WORK, String(path));
					if (!full.startsWith(`${WORK}/`))
						return res.end(JSON.stringify({ ok: false, error: 'Los archivos deben estar dentro de ~/work.' }));
					try {
						const data = readFileSync(full);
						if (data.length > 8 * 1024 * 1024)
							return res.end(JSON.stringify({ ok: false, error: `${path} pasa de 8 MB.` }));
						files.push({ name: basename(full), data: data.toString('base64') });
					} catch {
						return res.end(JSON.stringify({ ok: false, error: `No encontré ${path}.` }));
					}
				}
				delete args.archivos;
				args.files = files;
			}
			const id = ++delegationSeq;
			const timer = setTimeout(() => {
				delegationWaiters.delete(id);
				res.end(
					JSON.stringify({ ok: false, error: 'La plataforma no respondió a tiempo; consulta delegation_status.' }),
				);
			}, 50_000);
			delegationWaiters.set(id, (r) => {
				clearTimeout(timer);
				res.end(JSON.stringify(r ?? { ok: false, error: 'Sin respuesta.' }));
			});
			send({ t: 'delegation', id, op: delegationOp[1], args });
			return;
		}
		if (req.method === 'POST' && req.url === '/pi-launch') {
			// Only in a computer session (no task): pi and the agent never share the chat or the browser.
			return res.end(
				JSON.stringify(
					!piLaunch
						? { ok: false, error: 'La computadora todavía no arrancó.' }
						: piLaunch.kind !== 'browser'
							? {
									ok: false,
									error:
										'El agente está trabajando en una tarea. Usa pi cuando termine: Computadora → Terminal con el agente libre.',
								}
							: { ok: true, args: piLaunch.args, env: piLaunch.env },
				),
			);
		}
		if (req.method === 'POST' && req.url === '/check') {
			void fullCheck()
				.then((r) => res.end(JSON.stringify(r)))
				.catch((err) => res.end(JSON.stringify({ error: err.message })));
			return;
		}
		if (req.method === 'POST' && req.url === '/mcp-request') {
			let q = {};
			try {
				q = JSON.parse(body);
			} catch {}
			const id = ++mcpSeq;
			const done = (r) => res.end(JSON.stringify(r));
			const timer = setTimeout(() => {
				mcpRequests.delete(id);
				done({ ok: false, error: 'La plataforma no respondió a tiempo.' });
			}, 15_000);
			mcpRequests.set(id, (r) => {
				clearTimeout(timer);
				mcpRequests.delete(id);
				done({ ok: !!r.ok, ...(r.error ? { error: r.error } : {}) });
			});
			send({
				t: 'mcp_request',
				id,
				name: String(q.name ?? '').slice(0, 40),
				url: String(q.url ?? '').slice(0, 500),
				description: String(q.description ?? '').slice(0, 300),
			});
			return;
		}
		res.statusCode = 404;
		res.end();
	});
}).listen(7777, '127.0.0.1');

// ---------- the owner's terminal and desktop (#27) ----------
//
// Both are channels the backend opens only for the agent's owner: bytes in, bytes out, base64 over
// this same link (never queued while it is down). The terminal is a login bash on a pseudo-terminal
// (agents-pty) with the agent's environment; the desktop is x11vnc on the display Chrome uses.

const DISPLAY = ':99';
const OWNER_BIN = '/opt/agents/owner-bin'; // only on the owner's terminals' PATH: `pi` → agents-pi
let terminalEnv = null;
let displayUp = null;
let vnc = null;
const chans = new Map(); // id -> { write, resize?, close }

function startDisplay() {
	displayUp ??= (async () => {
		if (process.env.DISPLAY) return true;
		const x = spawn('Xvfb', [DISPLAY, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
		x.on('error', () => {});
		for (let i = 0; i < 40; i++) {
			try {
				statSync(`/tmp/.X11-unix/X${DISPLAY.slice(1)}`);
				process.env.DISPLAY = DISPLAY;
				// The desktop: a plain background, openbox and a bar. Without the run's tokens: a terminal
				// opened from its menu inherits this environment (the agent's tools on the PATH, no keys).
				const desk = {
					...process.env,
					PATH: `${OWNER_BIN}:${join(LOCAL, 'bin')}:${join(TOOLS, 'bin')}:${process.env.PATH}`,
					...localEnv,
					GTK2_RC_FILES: '/opt/agents/desktop/gtkrc-2.0',
					GSETTINGS_BACKEND: 'keyfile', // no dbus: the editor's settings in a file (agents-theme)
				};
				delete desk.AGENTS_TASK_TOKEN;
				delete desk.AGENTS_LLM_TOKEN;
				const run = (bin, args) => spawn(bin, args, { stdio: 'ignore', env: desk }).on('error', () => {});
				// The owner's theme (kept in the volume): its bar, menus and window decorations, generated
				// into /tmp/agents-desktop before openbox and tint2 read them.
				await new Promise((r) => execFile('agents-theme', ['init'], { env: desk, timeout: 10_000 }, () => r()));
				run('openbox', ['--config-file', '/tmp/agents-desktop/rc.xml']);
				run('tint2', ['-c', '/tmp/agents-desktop/tint2rc']);
				// The background once openbox holds the screen (painted before it, it is lost).
				for (const ms of [800, 3000]) setTimeout(() => run('agents-theme', ['bg']), ms);
				return true;
			} catch {}
			await new Promise((r) => setTimeout(r, 100));
		}
		// No display of our own (an older image): agent-browser starts its private one, as before.
		x.kill();
		return false;
	})();
	return displayUp;
}

async function vncPort() {
	if (!(await startDisplay())) throw new Error('no display');
	if (!vnc || vnc.exitCode !== null) {
		vnc = spawn(
			'x11vnc',
			['-display', DISPLAY, '-localhost', '-rfbport', '5900', '-shared', '-forever', '-nopw', '-quiet', '-noxdamage'],
			{
				stdio: 'ignore',
			},
		);
		vnc.on('error', () => {});
	}
	for (let i = 0; i < 50; i++) {
		const ok = await new Promise((r) => {
			const s = tcpConnect(5900, '127.0.0.1', () => {
				s.destroy();
				r(true);
			});
			s.on('error', () => r(false));
		});
		if (ok) return;
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error('x11vnc did not start');
}

function channel(msg) {
	const id = String(msg.id ?? '').slice(0, 64);
	if (!id) return;
	if (msg.op === 'in') return chans.get(id)?.write(Buffer.from(String(msg.data ?? ''), 'base64'));
	if (msg.op === 'size') return chans.get(id)?.resize?.(msg.cols, msg.rows);
	if (msg.op === 'close') return chans.get(id)?.close();
	if (msg.op !== 'open' || chans.has(id)) return;
	const out = (data) => send({ t: 'chan_out', id, data: data.toString('base64') });
	const closed = () => {
		if (chans.delete(id)) send({ t: 'chan_closed', id });
	};
	if (msg.kind === 'pty') {
		const env = { ...(terminalEnv ?? process.env) };
		delete env.AGENTS_TASK_TOKEN;
		delete env.AGENTS_LLM_TOKEN;
		const p = spawn('agents-pty', [], { cwd: HOME, env, stdio: ['pipe', 'pipe', 'ignore', 'pipe'] });
		p.stdout.on('data', out);
		p.on('exit', closed);
		p.on('error', closed);
		const resize = (cols, rows) => p.stdio[3].write(`${Number(cols) || 80} ${Number(rows) || 24}\n`);
		chans.set(id, { write: (b) => p.stdin.write(b), resize, close: () => p.kill('SIGTERM') });
		if (msg.cols) resize(msg.cols, msg.rows);
		return;
	}
	if (msg.kind === 'vnc') {
		const early = [];
		let socket = null;
		chans.set(id, {
			write: (b) => (socket ? socket.write(b) : early.push(b)),
			close: () => (socket ? socket.destroy() : closed()),
		});
		vncPort()
			.then(() => {
				if (!chans.has(id)) return;
				socket = tcpConnect(5900, '127.0.0.1', () => {
					for (const b of early.splice(0)) socket.write(b);
				});
				socket.on('data', out);
				socket.on('close', closed);
				socket.on('error', closed);
			})
			.catch(closed);
		return;
	}
	send({ t: 'chan_closed', id });
}

// ---------- ~/config and agents-config check (#27) ----------
//
// ~/config is what the web (Postgres) has for this run, readable: rewritten at every start, never read
// back (changes go through Automejora or Accesos). Secret values never land here: only names.

const CONFIG = join(HOME, 'config');
let checkContext = null;
let piLaunch = null;

function writeConfig(prepared, msg) {
	const c = msg.config ?? {};
	const h = prepared.harness;
	const md = (lines) => lines.filter((l) => l !== null).join('\n') + '\n';
	const yes = (b) => (b ? 'sí' : 'no');
	try {
		rmSync(CONFIG, { recursive: true, force: true });
		mkdirSync(join(CONFIG, 'skills'), { recursive: true });
		writeFileSync(
			join(CONFIG, 'README.md'),
			md([
				'# Configuración del agente',
				'',
				`Lo que la web tiene para **${c.name ?? 'este agente'}** en esta tarea. Se reescribe al empezar cada tarea: editar aquí no cambia nada. Los cambios van en Automejora (rol, herramientas, skills, MCP propios, CLI) o en Configuración → Accesos (API Keys, MCP, sitios).`,
				'',
				'Para probar que todo funciona: `agents-config check` (o Inicio → Comprobar accesos).',
				'',
				'| Archivo | Qué es |',
				'|---|---|',
				'| `agente.md` | nombre, modelo, revisión aprobada, imagen y digest |',
				'| `rol.md` | el rol que escribiste en Automejora |',
				'| `prompt.md` | el system prompt completo que recibe pi (rol + reglas de la plataforma + accesos) |',
				'| `harness.json` | herramientas, restricciones, skills, plugins, MCP propios y CLI aprobados |',
				'| `skills/` | cada skill aprobada |',
				'| `accesos.md` | API Keys, MCP y sitios concedidos (sin valores) |',
				'| `cli.md` | herramientas CLI aprobadas |',
			]),
		);
		writeFileSync(
			join(CONFIG, 'agente.md'),
			md([
				`# ${c.name ?? 'Agente'}`,
				'',
				`- **Modelo:** ${c.model ?? msg.model ?? '—'}`,
				`- **Revisión aprobada:** ${c.revision ?? '—'}`,
				`- **Tipo de corrida:** ${msg.kind ?? 'task'}`,
				`- **Imagen validada:** ${c.image ?? '—'}`,
				`- **Digest de la definición:** ${c.digest ?? '—'}`,
				`- **Digest del harness:** ${c.harnessDigest ?? prepared.digest}`,
				`- **Herramientas:** ${h.tools.join(', ')}`,
				`- **Restricciones:** archivos sólo del workspace ${yes(h.restrictions.workspaceFilesOnly)}, sólo lectura ${yes(h.restrictions.readOnlyFiles)}`,
				...(h.restrictions.guidelines.length
					? ['', '## Pautas', '', ...h.restrictions.guidelines.map((g) => `- ${g}`)]
					: []),
			]),
		);
		writeFileSync(join(CONFIG, 'rol.md'), `${c.role ?? ''}\n`);
		writeFileSync(join(CONFIG, 'prompt.md'), `${msg.system ?? ''}\n`);
		writeFileSync(join(CONFIG, 'harness.json'), `${JSON.stringify(h, null, 2)}\n`);
		for (const s of h.skills)
			writeFileSync(
				join(CONFIG, 'skills', `${s.name}.md`),
				md([`# ${s.name}`, '', `> ${s.description}`, '', s.instructions]),
			);
		const own = (h.mcp ?? []).map((s) => ({ ...s, origin: 'harness (Automejora)' }));
		const granted = (Array.isArray(msg.grantedMcp) ? msg.grantedMcp : []).map((s) => ({
			...s,
			origin: 'concedido (Accesos)',
		}));
		const keys = c.keys ?? [];
		writeFileSync(
			join(CONFIG, 'accesos.md'),
			md([
				'# Accesos',
				'',
				'## API Keys',
				'',
				...(keys.length
					? [
							'| Variable | Dominios | Valor | Entregada |',
							'|---|---|---|---|',
							...keys.map(
								(k) =>
									`| \`${k.name}\` | ${k.domains?.length ? k.domains.join(', ') : '—'} | ${k.expose_real ? 'real (el agente la puede leer)' : 'marcador agk_ (el proxy pone la real)'} | ${k.delivered ? 'sí' : 'no: falta el proxy de salida'} |`,
							),
						]
					: ['Ninguna concedida.']),
				'',
				'## Servidores MCP',
				'',
				...(own.length + granted.length
					? [
							'| Nombre | Origen | Dónde | Credenciales | OAuth |',
							'|---|---|---|---|---|',
							...[...own, ...granted].map(
								(s) =>
									`| \`${s.name}\` | ${s.origin} | ${s.transport === 'http' ? s.url : [s.command, ...(s.args ?? [])].join(' ')} | ${[...(s.headers ?? []), ...(s.env ?? [])].map((p) => p.name).join(', ') || '—'} | ${yes(s.oauth)} |`,
							),
						]
					: ['Ninguno.']),
				...((c.mcp ?? []).filter((m) => !m.delivered).length
					? [
							'',
							`No entregados en esta tarea (falta el proxy de salida): ${c.mcp
								.filter((m) => !m.delivered)
								.map((m) => m.name)
								.join(', ')}.`,
						]
					: []),
				'',
				'## Accesos a sitios',
				'',
				...((c.sites ?? []).length
					? c.sites.map((s) => `- \`${s}\` (se usa con \`agents-login ${s}\`)`)
					: ['Ninguno.']),
			]),
		);
		const installs = h.installs ?? [];
		writeFileSync(
			join(CONFIG, 'cli.md'),
			md([
				'# Herramientas CLI',
				'',
				...(installs.length
					? installs.map((i) => `- **${i.kind}**: \`${i.name ?? i.spec}\`${i.kind === 'binary' ? ` (${i.spec})` : ''}`)
					: ['Ninguna aprobada.']),
				'',
				'Se instalan en `~/state/tools` (aprobadas) y lo que instales a mano en `~/state/local` (bun add -g, uv tool, pip --user). La computadora corre con Bun: no hay Node.js ni npm (`node` y `npx` son Bun).',
			]),
		);
	} catch (err) {
		log('config', err.message);
	}
}

/** agents-config check: each MCP answers, each key reaches its domain through the proxy, each CLI runs. */
async function fullCheck() {
	if (!checkContext) return { error: 'La computadora todavía no arrancó una tarea o sesión.' };
	const { prepared, msg, env, secrets } = checkContext;
	const base = await checkAccess(prepared, msg, env, secrets);
	const sh = (cmd, args, timeout = 8000) =>
		new Promise((r) =>
			execFile(cmd, args, { env, cwd: WORK, timeout }, (err, out, errOut) =>
				r({
					ok: !err,
					out: String(out || errOut || err?.message || '')
						.trim()
						.split('\n')[0]
						.slice(0, 160),
				}),
			),
		);
	const keys = [];
	for (const k of msg.config?.keys ?? []) {
		const entry = {
			name: k.name,
			delivered: !!k.delivered,
			inEnv: k.name in env,
			real: !!k.expose_real,
			domains: k.domains ?? [],
		};
		if (k.delivered && !k.expose_real && k.domains?.length && env.HTTPS_PROXY) {
			const r = await sh('curl', [
				'-sS',
				'-o',
				'/dev/null',
				'-w',
				'%{http_code}',
				'--max-time',
				'8',
				`https://${k.domains[0]}/`,
			]);
			entry.proxy = r.ok ? `HTTPS a ${k.domains[0]} por el proxy: ${r.out}` : `no llegó a ${k.domains[0]}: ${r.out}`;
			entry.proxyOk = r.ok;
		}
		keys.push(entry);
	}
	const cli = [];
	for (const i of prepared.harness.installs ?? []) {
		const bins =
			i.kind === 'binary'
				? [join(TOOLS, 'bin', i.name)]
				: i.kind === 'npm'
					? (() => {
							try {
								const pkg = i.spec.replace(/@[^@/]+$/, '');
								const meta = JSON.parse(readFileSync(join(TOOLS, 'npm', 'node_modules', pkg, 'package.json'), 'utf8'));
								const b = typeof meta.bin === 'string' ? [meta.name.split('/').pop()] : Object.keys(meta.bin ?? {});
								return b.map((n) => join(TOOLS, 'npm', 'node_modules', '.bin', n));
							} catch {
								return [];
							}
						})()
					: // uv links each tool's commands into tools/bin from tools/uv/<package>/
						readdirSafe(join(TOOLS, 'bin')).filter((b) => {
							try {
								return realpathSync(b).includes(`/uv/${i.spec.split(/[=[]/)[0].toLowerCase()}/`);
							} catch {
								return false;
							}
						});
		if (!bins.length) {
			cli.push({ name: i.name ?? i.spec, ok: false, detail: 'no está instalada' });
			continue;
		}
		const r = await sh(bins[0], ['--version'], 5000);
		cli.push({
			name: i.name ?? i.spec,
			ok: true,
			detail: r.ok
				? `${basename(bins[0])} --version: ${r.out}`
				: `${basename(bins[0])} existe (no respondió a --version)`,
		});
	}
	return { ...base, keys, cli, tools: base.tools };
}

function readdirSafe(dir) {
	try {
		return readdirSync(dir).map((n) => join(dir, n));
	} catch {
		return [];
	}
}

// agents-mcp add: a request the owner confirms in the web. Nothing is registered from here.
const mcpRequests = new Map();
let mcpSeq = 0;

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
