import { expect, test } from 'bun:test';
import { documentKind, documentText } from './documents';

/** A one-page PDF that says `text` (no xref table: PDF.js rebuilds it). */
function pdf(text: string) {
	const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
	return Buffer.from(
		[
			'%PDF-1.4',
			'1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
			'2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
			'3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
			`4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj`,
			'5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
			'trailer<</Root 1 0 R>>',
			'%%EOF',
		].join('\n'),
	);
}

/** A zip with its files stored (no compression), as a .docx is. */
function zip(files: Record<string, string>) {
	const local: Buffer[] = [],
		central: Buffer[] = [];
	let offset = 0;
	for (const [name, body] of Object.entries(files)) {
		const data = Buffer.from(body),
			path = Buffer.from(name),
			crc = Bun.hash.crc32(data);
		const head = Buffer.alloc(30);
		head.writeUInt32LE(0x04034b50, 0);
		head.writeUInt16LE(20, 4);
		head.writeUInt32LE(crc, 14);
		head.writeUInt32LE(data.length, 18);
		head.writeUInt32LE(data.length, 22);
		head.writeUInt16LE(path.length, 26);
		local.push(head, path, data);
		const dir = Buffer.alloc(46);
		dir.writeUInt32LE(0x02014b50, 0);
		dir.writeUInt16LE(20, 4);
		dir.writeUInt16LE(20, 6);
		dir.writeUInt32LE(crc, 16);
		dir.writeUInt32LE(data.length, 20);
		dir.writeUInt32LE(data.length, 24);
		dir.writeUInt16LE(path.length, 28);
		dir.writeUInt32LE(offset, 42);
		central.push(dir, path);
		offset += head.length + path.length + data.length;
	}
	const size = central.reduce((n, b) => n + b.length, 0),
		count = Object.keys(files).length;
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(count, 8);
	end.writeUInt16LE(count, 10);
	end.writeUInt32LE(size, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, ...central, end]);
}

function docx(paragraphs: string[]) {
	const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
	return zip({
		'[Content_Types].xml':
			'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
		'_rels/.rels':
			'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
		'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${paragraphs
			.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
			.join('')}</w:body></w:document>`,
	});
}

test('documents: a PDF and a Word file are read as their text', async () => {
	expect(documentKind('menu.pdf', '')).toBe('pdf');
	expect(documentKind('x', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx');
	expect(documentKind('viejo.doc', '')).toBe('doc');
	expect(documentKind('notas.txt', 'text/plain')).toBeNull();
	expect(await documentText('pdf', 'menu.pdf', pdf('Menu semanal: tinga y arroz'))).toContain(
		'Menu semanal: tinga y arroz',
	);
	expect(await documentText('docx', 'reglas.docx', docx(['Presupuesto de 2500', 'Sin cerdo']))).toBe(
		'Presupuesto de 2500\n\nSin cerdo',
	);
	await expect(documentText('pdf', 'roto.pdf', Buffer.from('no es un pdf'))).rejects.toThrow('no se pudo leer');
	await expect(documentText('docx', 'vacio.docx', docx([]))).rejects.toThrow('está vacío');
});
