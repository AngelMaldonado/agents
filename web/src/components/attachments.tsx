// Files a person attaches to a chat message before sending it: picked, pasted or dropped. Read in
// the browser as base64; the server checks the limits again and stores them.
import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { FileText, Paperclip, X } from 'lucide-react';
import { Button } from './ui/button';

export type Attachment = { id: string; name: string; mime: string; size: number; data: string };
export type Limits = { files: number; fileBytes: number; totalBytes: number; accept?: string; allow?: (f: File) => boolean; rejectMessage?: string };
const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

function read(file: File) {
 return new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(new Error(`No se pudo leer «${file.name}».`));
  r.readAsDataURL(file);
 });
}

export function useAttachments(limits: Limits) {
 const [files, setFiles] = useState<Attachment[]>([]), [error, setError] = useState('');
 const current = useRef(files); current.current = files;
 const add = async (list: FileList | File[]) => {
  setError('');
  const next = [...current.current];
  for (const f of Array.from(list)) {
   if (limits.allow && !limits.allow(f)) { setError(limits.rejectMessage ?? `No se admite «${f.name}».`); continue; }
   if (next.length >= limits.files) { setError(`Máximo ${limits.files} archivos por mensaje.`); break; }
   if (f.size > limits.fileBytes) { setError(`«${f.name}» pasa de ${mb(limits.fileBytes)}.`); continue; }
   if (next.reduce((n, x) => n + x.size, 0) + f.size > limits.totalBytes) { setError(`Los adjuntos de un mensaje suman máximo ${mb(limits.totalBytes)}.`); break; }
   try { next.push({ id: crypto.randomUUID(), name: f.name || 'pegado.png', mime: f.type || 'application/octet-stream', size: f.size, data: await read(f) }); }
   catch (e) { setError((e as Error).message); }
  }
  setFiles(next);
 };
 return {
  files, error, current, add, setError,
  remove: (id: string) => setFiles(fs => fs.filter(f => f.id !== id)),
  clear: () => { setFiles([]); setError(''); },
  /** Pasted files (a screenshot) become attachments; pasted text stays text. */
  onPaste: (e: ClipboardEvent) => { if (e.clipboardData.files.length) { e.preventDefault(); void add(e.clipboardData.files); } },
  onDrop: (e: DragEvent) => { if (e.dataTransfer.files.length) { e.preventDefault(); void add(e.dataTransfer.files); } },
  onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }
 };
}

export function AttachButton({ onFiles, accept, disabled }: { onFiles: (files: FileList) => void; accept?: string; disabled?: boolean }) {
 const input = useRef<HTMLInputElement>(null);
 return <>
  <Button type="button" variant="ghost" size="icon" className="shrink-0 rounded-full" aria-label="Adjuntar archivos" title="Adjuntar archivos o imágenes (también puedes pegar o arrastrar)" disabled={disabled} onClick={() => input.current?.click()}><Paperclip aria-hidden="true" /></Button>
  <input ref={input} type="file" multiple hidden accept={accept} onChange={e => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = ''; }} />
 </>;
}

export function AttachmentChips({ files, onRemove }: { files: Attachment[]; onRemove: (id: string) => void }) {
 if (!files.length) return null;
 return <ul className="attachment-chips" aria-label="Adjuntos del mensaje">{files.map(f => <li key={f.id} className="attachment-chip">
  {f.mime.startsWith('image/') ? <img src={`data:${f.mime};base64,${f.data}`} alt="" /> : <FileText aria-hidden="true" />}
  <span className="min-w-0 truncate" title={f.name}>{f.name}</span>
  <button type="button" aria-label={`Quitar ${f.name}`} onClick={() => onRemove(f.id)}><X aria-hidden="true" /></button>
 </li>)}</ul>;
}

/** Files already sent with a message: images as thumbnails, the rest as links. */
export function SentAttachments({ files, href }: { files: { name: string; mime: string; size?: number }[]; href: (name: string) => string }) {
 if (!files.length) return null;
 return <ul className="attachment-chips sent" aria-label="Adjuntos">{files.map(f => <li key={f.name} className="attachment-chip">
  <a href={href(f.name)} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-2">
   {f.mime.startsWith('image/') ? <img src={href(f.name)} alt={f.name} loading="lazy" /> : <FileText aria-hidden="true" />}
   <span className="min-w-0 truncate" title={f.name}>{f.name}</span>
  </a>
 </li>)}</ul>;
}
