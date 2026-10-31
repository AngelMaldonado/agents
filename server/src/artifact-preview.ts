import { extname } from 'node:path';
export type PreviewKind = 'markdown' | 'csv' | 'html' | 'text' | 'image' | 'unsupported';
export const PREVIEW_BYTES = 1024 * 1024;
const images: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
};
export function previewKind(name: string): PreviewKind {
	const ext = extname(name).toLowerCase();
	if (images[ext]) return 'image';
	if (['.md', '.markdown'].includes(ext)) return 'markdown';
	if (ext === '.csv') return 'csv';
	if (['.html', '.htm', '.svg'].includes(ext)) return 'html';
	if (['.txt', '.json', '.log', '.yaml', '.yml', '.xml', '.css', '.js', '.ts', '.py', '.sh'].includes(ext))
		return 'text';
	return 'unsupported';
}
// Never serve model-supplied HTML/SVG/JS or a forged MIME as executable same-origin content.
// Signed webhook links retain access semantics, but get the same safe response headers.
export function artifactHeaders(name: string, download = false) {
	const image = images[extname(name).toLowerCase()];
	return {
		'content-type': image ?? 'application/octet-stream',
		'content-disposition': `${download || !image ? 'attachment' : 'inline'}; filename="${name.replace(/[^\w.-]/g, '_').slice(0, 100)}"`,
		'cache-control': 'private, no-store',
		'x-content-type-options': 'nosniff',
		'content-security-policy': "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
		'referrer-policy': 'no-referrer',
		'cross-origin-resource-policy': 'same-origin',
	};
}
export async function readPreview(path: string, name: string) {
	const file = Bun.file(path);
	if (!(await file.exists())) throw new Error('El archivo ya no está disponible.');
	const kind = previewKind(name),
		size = file.size;
	if (kind === 'image' || kind === 'unsupported') return { kind, name, size, text: null };
	if (size > PREVIEW_BYTES)
		return {
			kind,
			name,
			size,
			text: null,
			notice: 'El archivo supera 1 MiB. Descárgalo para ver el contenido completo.',
		};
	const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
	return { kind, name, size, text };
}
