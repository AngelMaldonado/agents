import { realpathSync, lstatSync, readlinkSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { Harness } from './harness';
// Resolve the closest existing ancestor too: new files and symlinked parents cannot escape.
export function realTarget(path: string, depth = 0): string {
 if (depth > 40) throw new Error('Demasiados enlaces simbólicos.');
 try { return realpathSync(path); }
 catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  const parent = dirname(path);
  try { if (lstatSync(path).isSymbolicLink()) return realTarget(resolve(parent, readlinkSync(path)), depth + 1); }
  catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') throw linkError; }
  if (parent === path) throw err;
  return resolve(realTarget(parent, depth + 1), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
 }
}
export function fileDenial(h: Harness, tool: string, args: Record<string, unknown>, cwd: string, workspace: string): string | null {
 const writes = ['write', 'edit', 'browser_screenshot'];
 if (h.restrictions.readOnlyFiles && writes.includes(tool)) return 'El harness aprobado limita los archivos a lectura sola.';
 if (!['read', 'write', 'edit', 'grep', 'find', 'ls', 'browser_screenshot'].includes(tool) || !h.restrictions.workspaceFilesOnly) return null;
 if (args.path !== undefined && typeof args.path !== 'string') return 'Ruta de archivo inválida.';
 const input = typeof args.path === 'string' ? args.path : '.';
 const expanded = input === '~' ? process.env.HOME! : input.startsWith('~/') ? resolve(process.env.HOME!, input.slice(2)) : resolve(cwd, input);
 try {
  const root = realpathSync(workspace), target = realTarget(expanded);
  return target === root || target.startsWith(root + sep) ? null : 'El harness aprobado sólo permite archivos dentro de ~/work (incluidos destinos de enlaces).';
 } catch { return 'No se pudo comprobar la ruta de archivo; operación rechazada.'; }
}
export function textStats(text: string) { return { characters: [...text].length, words: text.trim() ? text.trim().split(/\s+/u).length : 0, lines: text.split('\n').length }; }
export function jsonInfo(text: string) {
 try { const value = JSON.parse(text); return { valid: true, type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value, count: value !== null && typeof value === 'object' ? Object.keys(value).length : null }; }
 catch { return { valid: false, type: null, count: null }; }
}
