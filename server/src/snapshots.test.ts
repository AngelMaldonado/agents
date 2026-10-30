import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserSnapshot, readSnapshot, saveSnapshot } from './snapshots';
const dirs: string[] = [];
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), 'agents-snapshots-'));
	dirs.push(dir);
	return dir;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]).toString('base64'); // fixture bytes, not a visual assertion

test('normalizes only bounded JPEG images and browser metadata', () => {
	const shot = browserSnapshot(jpeg, { url: 'https://example.com', secret: 'not retained' }, 123)!;
	expect(shot).toEqual({ jpeg, url: 'https://example.com', captured_at: 123 });
	expect(browserSnapshot('bad!', {})).toBeNull();
	expect(browserSnapshot(Buffer.from('not jpeg').toString('base64'), {})).toBeNull();
	expect(browserSnapshot('A'.repeat(4 * 1024 * 1024 + 1), {})).toBeNull();
	expect(browserSnapshot(jpeg, { url: 'a'.repeat(5000) })!.url.length).toBe(4096);
	expect(browserSnapshot(jpeg, {}, Infinity)!.captured_at).toBeLessThanOrEqual(Date.now());
});
test('persists one private snapshot per run, independently of memory and other runs', () => {
	const dir = temp(),
		a = browserSnapshot(jpeg, { url: 'https://one.example' }, 123)!;
	saveSnapshot(dir, 10, a);
	saveSnapshot(dir, 20, { ...a, url: 'https://two.example' });
	a.url = 'memory changed';
	expect(readSnapshot(dir, 10)!.url).toBe('https://one.example');
	expect(readSnapshot(dir, 20)!.url).toBe('https://two.example');
	expect(readSnapshot(dir, 30)).toBeNull();
	expect(statSync(join(dir, 'snapshots', '10.json')).mode & 0o777).toBe(0o600);
	expect(readdirSync(join(dir, 'snapshots')).sort()).toEqual(['10.json', '20.json']);
});
test('atomic replacement keeps only the latest image and never a temporary file', () => {
	const dir = temp(),
		shot = browserSnapshot(jpeg, {}, 123)!;
	saveSnapshot(dir, 7, shot);
	saveSnapshot(dir, 7, { ...shot, captured_at: 456 });
	expect(readSnapshot(dir, 7)!.captured_at).toBe(456);
	expect(JSON.parse(readFileSync(join(dir, 'snapshots', '7.json'), 'utf8')).captured_at).toBe(456);
	expect(readdirSync(join(dir, 'snapshots'))).toEqual(['7.json']);
});
test('rejects invalid identifiers and does not silently disguise a corrupt snapshot as a missing one', () => {
	const dir = temp(),
		shot = browserSnapshot(jpeg, {})!;
	for (const id of [0, -1, NaN, Infinity, 1.2]) expect(() => saveSnapshot(dir, id, shot)).toThrow();
	saveSnapshot(dir, 1, shot);
	writeFileSync(join(dir, 'snapshots', '1.json'), '{}');
	expect(() => readSnapshot(dir, 1)).toThrow();
});
