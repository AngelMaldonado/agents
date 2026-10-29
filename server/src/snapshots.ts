// One browser image per run, not a recording or a restorable computer. Kept apart from
// agent-produced files so an output named browser-snapshot.json cannot replace it.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type BrowserSnapshot = { jpeg: string; url: string; captured_at: number };
const MAX_BASE64 = 4 * 1024 * 1024;
export function browserSnapshot(jpeg: unknown, meta: unknown, at: unknown = Date.now()): BrowserSnapshot | null {
 if (typeof jpeg !== 'string' || jpeg.length > MAX_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(jpeg)) return null;
 const bytes = Buffer.from(jpeg, 'base64');
 if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
 const url = meta && typeof meta === 'object' && 'url' in meta && typeof meta.url === 'string' ? meta.url.slice(0, 4096) : '';
 return { jpeg, url, captured_at: typeof at === 'number' && Number.isFinite(at) && at > 0 ? Math.min(at, Date.now()) : Date.now() };
}
function path(data: string, runId: number) {
 if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('Invalid snapshot run id');
 return join(data, 'snapshots', `${runId}.json`);
}
export function saveSnapshot(data: string, runId: number, snapshot: BrowserSnapshot) {
 const dest = path(data, runId), temp = `${dest}.${randomUUID()}.tmp`;
 mkdirSync(join(data, 'snapshots'), { recursive: true, mode: 0o700 });
 try { writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 }); renameSync(temp, dest); }
 finally { rmSync(temp, { force: true }); }
}
export function readSnapshot(data: string, runId: number): BrowserSnapshot | null {
 try {
  const value = JSON.parse(readFileSync(path(data, runId), 'utf8'));
  const snapshot = browserSnapshot(value.jpeg, { url: value.url }, value.captured_at);
  if (!snapshot) throw new Error('Invalid saved browser snapshot');
  return snapshot;
 } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
}
