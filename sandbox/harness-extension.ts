// Platform-owned, explicitly loaded, never resolved from the mutable workspace.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateHarness, runtimeToolNames, mcpAllowed } from './harness.ts';
import { fileDenial, jsonInfo, textStats } from './harness-policy.ts';
const exec = promisify(execFile);
export default function (pi: ExtensionAPI) {
 const h = validateHarness(JSON.parse(process.env.AGENTS_HARNESS ?? 'null'));
 const workspace = join(process.env.HOME!, 'work');
 const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }], details: {} });
 async function command(bin: string, args: string[], signal?: AbortSignal, timeout = 30000) {
  const r = await exec(bin, args, { signal, timeout, maxBuffer: 1024 * 1024, cwd: workspace });
  return result(r.stdout || r.stderr || 'OK');
 }
 if (h.tools.includes('request_help')) pi.registerTool({ name: 'request_help', label: 'Pedir ayuda', description: 'Comunicar un bloqueo o decisión y esperar respuesta humana.', parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 2000 }) }),
  execute: async (_id, p, signal) => command('agents-blocked', [p.reason], signal, 60 * 60 * 1000) });
 if (h.tools.includes('login')) pi.registerTool({ name: 'login', label: 'Acceso concedido', description: 'Iniciar sesión con el nombre de un acceso ya concedido. No devuelve secretos.', parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 120, pattern: '^[^-].*$' }) }),
  execute: async (_id, p, signal) => command('agents-login', [p.name], signal, 90000) });
 if (h.tools.includes('browser')) pi.registerTool({ name: 'browser', label: 'Navegador visible', description: 'Navegar con agent-browser. snapshot devuelve referencias @e1, @e2…; click/fill usan esas referencias. screenshot guarda un PNG. get: url o title. scroll: up/down/left/right.',
  parameters: Type.Object({ action: Type.Union(['open', 'snapshot', 'click', 'fill', 'press', 'scroll', 'get', 'screenshot'].map(v => Type.Literal(v))), target: Type.Optional(Type.String({ maxLength: 4096 })), text: Type.Optional(Type.String({ maxLength: 16000 })) }),
  execute: async (_id, p, signal) => {
   let args: string[];
   switch (p.action) {
    case 'open': { const u = new URL(p.target ?? ''); if (!['https:', 'http:'].includes(u.protocol) && u.href !== 'about:blank') throw new Error('URL no admitida.'); args = ['open', u.href]; break; }
    case 'snapshot': args = ['snapshot', '-i']; break;
    case 'click': case 'fill':
     if (!/^@e\d+$/.test(p.target ?? '')) throw new Error('Usa una referencia @e del snapshot.');
     args = p.action === 'click' ? ['click', p.target!] : ['fill', p.target!, p.text ?? '']; break;
    case 'press': if (!/^[A-Za-z0-9+_-]{1,40}$/.test(p.target ?? '')) throw new Error('Tecla inválida.'); args = ['press', p.target!]; break;
    case 'scroll': if (!['up', 'down', 'left', 'right'].includes(p.target ?? '')) throw new Error('Dirección inválida.'); args = ['scroll', p.target!]; break;
    case 'get': if (!['url', 'title'].includes(p.target ?? '')) throw new Error('Usa get url o get title.'); args = ['get', p.target!]; break;
    case 'screenshot': {
     const path = p.target ?? join(workspace, 'out', 'screenshot.png');
     const denied = fileDenial(h, 'browser_screenshot', { path }, workspace, workspace); if (denied) throw new Error(denied);
     if (path.startsWith('-')) throw new Error('Ruta inválida.'); args = ['screenshot', path]; break;
    }
    default: throw new Error('Operación de navegador no admitida.');
   }
   return command('agent-browser', args, signal, 60000);
  } });
 if (h.plugins.some(p => p.id === 'text-utils')) pi.registerTool({ name: 'text_stats', label: 'Analizar texto', description: 'Contar caracteres Unicode, palabras y líneas. Sin efectos externos.', parameters: Type.Object({ text: Type.String({ maxLength: 64000 }) }), execute: async (_id, p) => result(textStats(p.text)) });
 if (h.plugins.some(p => p.id === 'json-utils')) pi.registerTool({ name: 'json_validate', label: 'Validar JSON', description: 'Comprobar sintaxis y estructura JSON. Sin ejecutar ni escribir contenido.', parameters: Type.Object({ text: Type.String({ maxLength: 64000 }) }), execute: async (_id, p) => result(jsonInfo(p.text)) });
 pi.on('tool_call', (event, ctx) => {
  if (!runtimeToolNames(h).includes(event.toolName) && !mcpAllowed(h, event.toolName)) return { block: true, reason: 'Herramienta fuera del harness aprobado.' };
  const denied = fileDenial(h, event.toolName, event.input, ctx.cwd, workspace);
  if (denied) return { block: true, reason: denied };
 });
 pi.on('session_start', () => {
  const names = runtimeToolNames(h), registered = new Set(pi.getAllTools().map(t => t.name));
  if (names.some(name => !registered.has(name))) throw new Error('Faltan herramientas del harness aprobado.');
  // MCP tools of approved servers register (and activate) as their servers connect, later on.
  pi.setActiveTools([...names, ...pi.getAllTools().map(t => t.name).filter(n => mcpAllowed(h, n))]);
  const skills = pi.getCommands().filter(c => c.source === 'skill').map(c => c.name.replace(/^skill:/, '')).sort();
  if (JSON.stringify(skills) !== JSON.stringify(h.skills.map(s => s.name))) throw new Error('No coincide la carga efectiva de skills.');
  const active = pi.getActiveTools().filter(n => !mcpAllowed(h, n)).sort();
  if (JSON.stringify(active) !== JSON.stringify(names)) throw new Error('No coincide el conjunto efectivo de herramientas.');
  if (textStats('uno dos').words !== 2 || !jsonInfo('{"ok":true}').valid || jsonInfo('{').valid) throw new Error('Falló la autoprueba de plugins.');
  process.stderr.write('AGENTS_HARNESS_READY ' + JSON.stringify({ type: 'agents_harness_ready', digest: createHash('sha256').update(JSON.stringify(h)).digest('hex'), tools: active, skills, plugins: h.plugins }) + '\n');
 });
}
