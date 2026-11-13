// Documents the owner attaches (Angel 11-nov-2026): a PDF or a Word file (.docx) is read as its text, the way the
// designer reads a text file. A scanned PDF has no text to read: it is refused, with what to do instead.
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

export const PDF = 'application/pdf';
export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Which document it is, by its type or its name; null: not one of these. */
export function documentKind(name: string, mime: string): 'pdf' | 'docx' | 'doc' | null {
	if (mime === PDF || /\.pdf$/i.test(name)) return 'pdf';
	if (mime === DOCX || /\.docx$/i.test(name)) return 'docx';
	if (mime === 'application/msword' || /\.doc$/i.test(name)) return 'doc';
	return null;
}

/** Its text, pages and paragraphs separated by blank lines. */
export async function documentText(kind: 'pdf' | 'docx', name: string, buf: Buffer): Promise<string> {
	let text: string;
	try {
		if (kind === 'pdf') {
			const pdf = await getDocumentProxy(new Uint8Array(buf));
			text = (await extractText(pdf, { mergePages: true })).text;
		} else text = (await mammoth.extractRawText({ buffer: buf })).value;
	} catch {
		throw new Error(`«${name}» no se pudo leer: ¿está dañado o protegido con contraseña?`);
	}
	text = text.replace(/\n{3,}/g, '\n\n').trim();
	if (!text)
		throw new Error(
			kind === 'pdf'
				? `«${name}» no tiene texto que leer (¿es un escaneo?): mándalo como imagen o pega su texto.`
				: `«${name}» está vacío.`,
		);
	return text;
}
