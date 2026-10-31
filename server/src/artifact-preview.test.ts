import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactHeaders, previewKind, PREVIEW_BYTES, readPreview } from './artifact-preview';
test('artifact type comes from filename, not untrusted model MIME', () => {
	for (const [name, kind] of [
		['REPORT.MD', 'markdown'],
		['datos.csv', 'csv'],
		['pagina.html', 'html'],
		['marca.svg', 'html'],
		['code.js', 'text'],
		['foto.png', 'image'],
		['documento.pdf', 'unsupported'],
	] as const)
		expect(previewKind(name)).toBe(kind);
	for (const name of ['page.html', 'vector.svg', 'script.js', 'spoof.png.html']) {
		const h = artifactHeaders(name);
		expect(h['content-type']).toBe('application/octet-stream');
		expect(h['content-disposition']).toStartWith('attachment;');
		expect(h['cache-control']).toBe('private, no-store');
		expect(h['content-security-policy']).toContain('sandbox');
		expect(h['x-content-type-options']).toBe('nosniff');
	}
	expect(artifactHeaders('foto.png')['content-type']).toBe('image/png');
	expect(artifactHeaders('foto.png', true)['content-disposition']).toStartWith('attachment;');
	expect(artifactHeaders('a"\r\nSet-Cookie:x.html')['content-disposition']).not.toContain('\r');
});
test('text preview is bounded, private data returned as data not executable HTML', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'agents-preview-'));
	try {
		const path = join(dir, 'file');
		await Bun.write(path, '# Reporte\n\n<script>bad()</script>');
		const p = await readPreview(path, 'reporte.md');
		expect(p.kind).toBe('markdown');
		expect(p.text).toContain('<script>'); // Escaped by Markdown; never innerHTML in the app.
		await Bun.write(path, 'x'.repeat(PREVIEW_BYTES + 1));
		expect((await readPreview(path, 'large.csv')).text).toBeNull();
		expect((await readPreview(path, 'large.csv')).notice).toContain('1 MiB');
		await Bun.write(path, new Uint8Array([255, 254]));
		await expect(readPreview(path, 'bad.txt')).rejects.toThrow();
		expect((await readPreview(path, 'unknown.zip')).text).toBeNull();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
