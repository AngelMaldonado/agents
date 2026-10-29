// Stateless boot probe: no model request, network, credentials, browser profile or agent volume.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { prepareHarness } from './harness-runtime.mjs';
const home = '/tmp/harness-home';
mkdirSync(home + '/work', { recursive: true });
const prepared = prepareHarness(JSON.parse(process.env.AGENTS_HARNESS ?? 'null'), home + '/bundle');
try {
 for (const [tool, bin] of [['grep','rg'], ['find','fd'], ['bash','bash'], ['browser','agent-browser']]) if (prepared.harness.tools.includes(tool)) execFileSync(bin, ['--version'], { timeout: 5000, stdio: 'pipe' });
 if (prepared.harness.tools.includes('find')) execFileSync('fd', ['--glob','--color=never','--hidden','--no-require-git','--max-results','1','--','*',home + '/work'], { timeout: 5000, stdio: 'pipe' });
} catch (err) { console.log('AGENTS_HARNESS_PROBE ' + JSON.stringify({ ok: false, error: `Ejecutable del harness ausente o incompatible: ${err.message}` })); process.exit(1); }
const child = spawn('pi', ['--mode', 'rpc', '--offline', '--no-session', ...prepared.args], { cwd: home + '/work', env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', PI_CODING_AGENT_DIR: home + '/pi', ...prepared.env }, stdio: ['pipe', 'pipe', 'pipe'] });
const buffers = { out: '', err: '' };
let errors = '', finished = false;
const timeout = setTimeout(() => end(false, `pi no confirmó el harness en 25 segundos: ${errors}`), 25000);
function end(ok, value) {
 if (finished) return;
 finished = true; clearTimeout(timeout); child.kill('SIGKILL');
 console.log('AGENTS_HARNESS_PROBE ' + JSON.stringify({ ok, ...(ok ? { runtime: value } : { error: value }) }));
 process.exitCode = ok ? 0 : 1;
}
function consume(channel, chunk) {
 if (channel === 'err') errors = (errors + chunk).slice(-3000);
 buffers[channel] += chunk;
 if (buffers[channel].length > 1000000) return end(false, 'Salida de pi excesiva.');
 let line;
 while ((line = buffers[channel].indexOf('\n')) >= 0) {
  const text = buffers[channel].slice(0, line); buffers[channel] = buffers[channel].slice(line + 1);
  try {
   const event = JSON.parse(text.startsWith('AGENTS_HARNESS_READY ') ? text.slice('AGENTS_HARNESS_READY '.length) : text);
   if (event.type === 'extension_error' || event.type === 'error') errors = (errors + text).slice(-3000);
   if (event.type === 'agents_harness_ready') return end(event.digest === prepared.digest, event.digest === prepared.digest ? event : 'Hash de harness distinto al solicitado.');
  } catch {}
 }
}
child.stdout.on('data', chunk => consume('out', chunk));
child.stderr.on('data', chunk => consume('err', chunk));
child.on('error', err => end(false, err.message));
child.on('exit', code => { if (!finished) end(false, `pi terminó (${code}): ${errors}`); });
