// The agent-browser wrapper (browser-bin/agent-browser) against a fake agent-browser: a wedged daemon
// (agent-browser #1651) restarts once, on the page it was on, and a read runs again; a click does not.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WRAPPER = join(import.meta.dir, 'browser-bin', 'agent-browser');
const dir = mkdtempSync(join(tmpdir(), 'ab-wrapper-'));
const fake = join(dir, 'fake-agent-browser');
const calls = join(dir, 'calls.log');
const wedged = join(dir, 'wedged');
const sightless = join(dir, 'blind');
let server: ReturnType<typeof Bun.serve>;
let assigned: Record<string, string> | null = null;
const CARD = {
	brand: 'visa',
	label: 'Visa',
	last4: '4242',
	exp: '08/29',
	holder: 'Angel Maldonado',
	number: '4000000000024242',
	cvv: '123',
};

beforeAll(() => {
	// Chrome's own endpoint: the page it has open.
	server = Bun.serve({
		port: 0,
		// Chrome's own endpoint, and the supervisor's /card (its assigned card, when the test gives one).
		fetch: (req) =>
			new URL(req.url).pathname === '/card'
				? Response.json(assigned ? { ok: true, card: assigned } : { ok: false })
				: Response.json([{ id: 'T1', type: 'page', url: 'https://www.heb.com.mx/cart' }]),
	});
	writeFileSync(join(dir, 'DevToolsActivePort'), `${server.port}\n/devtools/browser/x\n`);
	writeFileSync(
		fake,
		`#!/usr/bin/env bun
const { appendFileSync, existsSync, rmSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.AGENT_BROWSER_PROXY)
	appendFileSync(${JSON.stringify(join(dir, 'proxied'))}, args.join(' ') + '\\n');
const stuck = existsSync(${JSON.stringify(wedged)});
if (args[0] === 'close') {
	rmSync(${JSON.stringify(wedged)}, { force: true });
	rmSync(${JSON.stringify(sightless)}, { force: true });
	process.exit(0);
}
if (stuck) {
	process.stderr.write('✗ Failed to install browser network controls: CDP error (Page.enable): Session with given id not found.\\n');
	process.exit(1);
}
const blind = existsSync(${JSON.stringify(sightless)});
if (args[0] === 'snapshot') process.stdout.write(blind ? '(no interactive elements)\\n' : '- heading "Carrito" [level=1, ref=e4]\\n');
else if (args[0] === 'fill') process.stdout.write('✓ Done\\n');
else if (args[0] === 'get' && args[1] === 'value') process.stdout.write(${JSON.stringify(join(dir, 'echo'))} && existsSync(${JSON.stringify(join(dir, 'echo'))}) ? 'textbox "Número de tarjeta": 4000 0000 0002 4242\\nCVV: "123"\\n' : '\\n');
else if (args[0] === 'eval' && String(args[1]).includes('data-agents-card')) process.stdout.write('1\\n');
else if (args[0] === 'eval') process.stdout.write(${JSON.stringify(join(dir, 'empty-page'))} && existsSync(${JSON.stringify(join(dir, 'empty-page'))}) ? '0\\n' : '37\\n');
else if (args[0] === 'get' && args[1] === 'url') process.stdout.write('https://www.heb.com.mx/cart\\n');
else process.stdout.write('✓ Done\\n');
`,
	);
	chmodSync(fake, 0o755);
});
afterAll(() => {
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

// Async: Chrome's fake endpoint lives in this process and must answer while the wrapper runs.
async function wrap(...args: string[]) {
	return wrapWith({}, ...args);
}
async function wrapWith(extra: Record<string, string>, ...args: string[]) {
	const r = Bun.spawn(['bun', WRAPPER, ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			...process.env,
			AGENTS_BROWSER_REAL: fake,
			AGENTS_BROWSER_LOG: join(dir, 'incidents.log'),
			AGENTS_BROWSER_MARKS: dir,
			AGENT_BROWSER_PROFILE: dir,
			AGENTS_SIMULATION: '0',
			AGENTS_SUPERVISOR_URL: `http://127.0.0.1:${server.port}`,
			...extra,
		},
	});
	const [out, err, status] = await Promise.all([
		new Response(r.stdout).text(),
		new Response(r.stderr).text(),
		r.exited,
	]);
	return { out, err, status };
}
const called = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []);

test('a wedged daemon restarts on its page, a read runs again, and it never loops', async () => {
	writeFileSync(wedged, '');
	const read = await wrap('snapshot', '-i');
	expect(read.status).toBe(0);
	expect(read.out).toContain('Carrito');
	expect(read.err).toContain('lo reinicié en https://www.heb.com.mx/cart');
	expect(called()).toEqual(['snapshot -i', 'close', 'get url', 'open https://www.heb.com.mx/cart', 'snapshot -i']);
	expect(readFileSync(join(dir, 'incidents.log'), 'utf8')).toContain('"how":"restart"');

	// Wedged again within the minute: no second restart, and it says what to do.
	writeFileSync(wedged, '');
	writeFileSync(calls, '');
	const again = await wrap('snapshot', '-i');
	expect(again.status).toBe(1);
	expect(again.err).toContain('sigue trabado');
	expect(called()).toEqual(['snapshot -i']);
});

test('a click on a wedged daemon is not repeated after the restart', async () => {
	rmSync(join(dir, 'agents-browser-restart'), { force: true });
	writeFileSync(wedged, '');
	writeFileSync(calls, '');
	const click = await wrap('click', '@e12');
	expect(click.status).toBe(1);
	expect(click.err).toContain('Este comando no se hizo');
	expect(called().filter((c) => c === 'click @e12')).toHaveLength(1);
});

test('a blind read of a real page (it has buttons, the snapshot sees none) restarts it too', async () => {
	rmSync(join(dir, 'agents-browser-restart'), { force: true });
	writeFileSync(sightless, '');
	writeFileSync(calls, '');
	const read = await wrap('snapshot', '-i');
	expect(read.out).toContain('Carrito');
	expect(read.err).toContain('lo reinicié');
	expect(called()).toContain('close');
});

test('a page that really has nothing to click is left alone', async () => {
	rmSync(join(dir, 'agents-browser-restart'), { force: true });
	writeFileSync(sightless, '');
	writeFileSync(join(dir, 'empty-page'), '');
	writeFileSync(calls, '');
	const read = await wrap('snapshot', '-i');
	expect(read.out).toContain('(no interactive elements)');
	expect(called()).not.toContain('close');
	rmSync(join(dir, 'empty-page'), { force: true });
	rmSync(sightless, { force: true });
});

test('agent-browser never gets the egress proxy (its credentials turn on the controls that wedge it)', async () => {
	rmSync(join(dir, 'proxied'), { force: true });
	writeFileSync(calls, '');
	const r = Bun.spawn(['bun', WRAPPER, 'get', 'url'], {
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			...process.env,
			AGENTS_BROWSER_REAL: fake,
			AGENTS_BROWSER_LOG: join(dir, 'incidents.log'),
			AGENTS_BROWSER_MARKS: dir,
			AGENT_BROWSER_PROFILE: dir,
			HTTPS_PROXY: 'http://run:token@proxy:3128',
			HTTP_PROXY: 'http://run:token@proxy:3128',
			https_proxy: 'http://run:token@proxy:3128',
		},
	});
	expect(await new Response(r.stdout).text()).toContain('https://www.heb.com.mx/cart');
	await r.exited;
	expect(called()).toEqual(['get url']);
	expect(existsSync(join(dir, 'proxied'))).toBe(false);
});

test("without Chrome's endpoint, a restart goes back to the last page it showed", async () => {
	rmSync(join(dir, 'agents-browser-restart'), { force: true });
	const port = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8');
	writeFileSync(join(dir, 'DevToolsActivePort'), 'none\n');
	writeFileSync(join(dir, 'agents-browser-url'), 'https://www.heb.com.mx/search?q=papa');
	writeFileSync(wedged, '');
	writeFileSync(calls, '');
	const read = await wrap('snapshot', '-i');
	expect(read.err).toContain('lo reinicié en https://www.heb.com.mx/search?q=papa');
	expect(called()).toContain('open https://www.heb.com.mx/search?q=papa');
	writeFileSync(join(dir, 'DevToolsActivePort'), port);
});

test('its card markers are filled here; the model never sees the number, and without a card it is told so', async () => {
	assigned = CARD;
	writeFileSync(calls, '');
	const fill = await wrap('fill', '@e12', '{{tarjeta.numero}}');
	expect(fill.status).toBe(0);
	await wrap('fill', '@e13', '{{tarjeta.mes}}/{{tarjeta.año}}');
	await wrap('fill', '@e14', '{{ tarjeta.cvv }}');
	expect(called()).toEqual(['fill @e12 4000000000024242', 'fill @e13 08/29', 'fill @e14 123']);
	// A field that echoes it back: hidden.
	writeFileSync(join(dir, 'echo'), '');
	const read = await wrap('get', 'value', '@e12');
	expect(read.out).toContain('•••• 4242');
	expect(read.out).not.toContain('4000 0000 0002 4242');
	expect(read.out).toContain('CVV: "•••');
	rmSync(join(dir, 'echo'), { force: true });
	// The incident log keeps the marker, never the value.
	assigned = null;
	writeFileSync(calls, '');
	const none = await wrap('fill', '@e12', '{{tarjeta.numero}}');
	expect(none.status).toBe(1);
	expect(none.err).toContain('No tienes una tarjeta asignada');
	expect(called()).toEqual([]);
});

test('with simulated payments its saved card is drawn on the page before each read', async () => {
	assigned = CARD;
	writeFileSync(calls, '');
	const read = await wrapWith({ AGENTS_SIMULATION: '1' }, 'snapshot', '-i');
	expect(read.out).toContain('Carrito');
	const drawn = readFileSync(calls, 'utf8');
	expect(drawn).toContain('data-agents-card');
	expect(drawn).toContain('"last4":"4242"');
	expect(drawn).not.toContain('4000000000024242');
	// Without simulation it is not drawn.
	writeFileSync(calls, '');
	await wrap('snapshot', '-i');
	expect(readFileSync(calls, 'utf8')).not.toContain('data-agents-card');
	assigned = null;
});
