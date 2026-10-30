export const artifactUrl = (agentId: number, runId: number, name: string) =>
	`#/agent/${agentId}/artifact/${runId}/${encodeURIComponent(name)}`;
export const artifactFileUrl = (runId: number, name: string) => `/api/tasks/${runId}/files/${encodeURIComponent(name)}`;
// Only known output filenames become artifact links. External URLs are never reinterpreted.
export function linkedArtifact(href: string | undefined, runId: number, names: string[]) {
	if (!href) return null;
	let path: string;
	try {
		path = decodeURIComponent(href);
	} catch {
		return null;
	}
	const api = `/api/tasks/${runId}/files/`;
	if (path.startsWith(api)) path = path.slice(api.length);
	else {
		if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !path.startsWith('sandbox:/')) return null;
		if (path.startsWith('//')) return null;
		path = path.replace(/^sandbox:/, '');
		if (!/^(?:\.\/|out\/|~\/work\/out\/|\/home\/agent\/work\/out\/|\/mnt\/data\/)?[^/?#]+$/.test(path)) return null;
		path = path.split('/').at(-1)!;
	}
	return names.includes(path) ? path : null;
}
// Opaque sandbox origin, no scripts/forms/navigation/popups and no external resources.
// Meta CSP is first in the document: later model markup cannot relax it.
export const isolatedHtml = (cleanHtml: string) =>
	`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;margin:24px;color:#171717;background:#fff;overflow-wrap:anywhere}img,svg,table{max-width:100%}pre{white-space:pre-wrap}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:8px}</style></head><body>${cleanHtml}</body></html>`;
// Bounded RFC4180 display parser, not a spreadsheet: formulas remain literal React text.
export function csvPreview(text: string, maxRows = 200, maxColumns = 50) {
	const rows: string[][] = [];
	let row: string[] = [],
		cell = '',
		quoted = false,
		limited = false;
	const pushCell = () => {
		if (row.length < maxColumns) row.push(cell);
		else limited = true;
		cell = '';
	};
	const pushRow = () => {
		pushCell();
		rows.push(row);
		row = [];
	};
	const input = text.replace(/^\uFEFF/, '');
	for (let i = 0; i < input.length; i++) {
		const c = input[i];
		if (c === '"') {
			if (quoted && input[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (quoted || !cell) quoted = !quoted;
			else cell += c;
		} else if (!quoted && c === ',') pushCell();
		else if (!quoted && (c === '\n' || c === '\r')) {
			if (c === '\r' && input[i + 1] === '\n') i++;
			pushRow();
			if (rows.length >= maxRows) {
				limited ||= i < input.length - 1;
				return { rows, limited, malformed: false };
			}
		} else cell += c;
	}
	if (cell || row.length) pushRow();
	return { rows, limited, malformed: quoted };
}
