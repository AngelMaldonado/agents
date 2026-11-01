import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DOMPurify from 'dompurify';
import { Copy, Download, FileText, Image, Table2 } from 'lucide-react';
import { api, type Artifact } from '@/api';
import { artifactFileUrl, artifactUrl, csvPreview, isolatedHtml, linkedArtifact } from '@/lib/artifacts';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { ScrollArea } from './ui/scroll-area';
export type ArtifactTarget = { runId: number; name: string };
type Preview = ArtifactTarget & {
	agentId: number;
	kind: 'markdown' | 'csv' | 'html' | 'text' | 'image' | 'unsupported';
	text: string | null;
	size: number;
	notice?: string;
	artifacts: Artifact[];
};
const raster = (name: string) => /\.(png|jpe?g|webp|gif)$/i.test(name);
export function ArtifactMarkdown({
	text,
	agentId,
	runId,
	files,
}: {
	text: string;
	agentId: number;
	runId: number;
	files: Artifact[];
}) {
	const names = files.map((f) => f.name);
	return (
		<div className="markdown min-w-0">
			<Markdown
				remarkPlugins={[remarkGfm]}
				urlTransform={(url) => (linkedArtifact(url, runId, names) ? url : defaultUrlTransform(url))}
				components={{
					a: ({ node, href, ...p }) => {
						const name = linkedArtifact(href, runId, names);
						return name ? (
							<a {...p} href={artifactUrl(agentId, runId, name)} />
						) : (
							<a {...p} href={href} target="_blank" rel="noreferrer noopener" />
						);
					},
					img: ({ src, alt }) => {
						const name = typeof src === 'string' ? linkedArtifact(src, runId, names) : null;
						return name && raster(name) ? (
							<a href={artifactUrl(agentId, runId, name)}>
								<img src={artifactFileUrl(runId, name)} alt={alt ?? name} loading="lazy" />
							</a>
						) : (
							<span className="text-xs text-muted-foreground">
								{alt ? `[Imagen: ${alt}]` : '[Imagen externa omitida]'}
							</span>
						);
					},
				}}
			>
				{text}
			</Markdown>
		</div>
	);
}
export function ArtifactCards({ files, agentId, runId }: { files: Artifact[]; agentId: number; runId: number }) {
	if (!files.length) return null;
	return (
		<div className="mt-4 grid min-w-0 gap-2" aria-label="Archivos del trabajo">
			{files.map((f) => {
				const Icon = raster(f.name) ? Image : /\.csv$/i.test(f.name) ? Table2 : FileText;
				return (
					<div key={f.id} className="flex min-w-0 items-center gap-2 rounded-lg border bg-card p-3">
						<Icon aria-hidden="true" className="size-5 shrink-0 text-primary" />
						<a
							href={artifactUrl(agentId, runId, f.name)}
							aria-label={`Ver ${f.name}`}
							className="grid min-w-0 flex-1 gap-1 text-xs"
						>
							<span className="break-all font-medium text-primary underline-offset-4 hover:underline">{f.name}</span>
							<span className="text-2xs text-muted-foreground">Ver archivo · {(f.size / 1024).toFixed(1)} KB</span>
						</a>
						<Button asChild variant="ghost" size="icon-sm">
							<a
								href={`${artifactFileUrl(runId, f.name)}?download=1`}
								download={f.name}
								aria-label={`Descargar ${f.name}`}
							>
								<Download aria-hidden="true" />
							</a>
						</Button>
					</div>
				);
			})}
		</div>
	);
}
export function ArtifactDrawer({
	target,
	agentId,
	onClose,
}: {
	target: ArtifactTarget | null;
	agentId: number;
	onClose: () => void;
}) {
	const [preview, setPreview] = useState<Preview | null>(null),
		[error, setError] = useState(''),
		[version, retry] = useState(0),
		[copied, setCopied] = useState(false);
	const opener = useRef<HTMLElement | null>(null);
	useEffect(() => {
		let alive = true;
		setPreview(null);
		setError('');
		setCopied(false);
		if (target)
			void api<Preview>(`/tasks/${target.runId}/files/${encodeURIComponent(target.name)}/preview`)
				.then((p) => {
					if (p.agentId !== agentId || p.runId !== target.runId || p.name !== target.name)
						throw new Error('El archivo no pertenece a este trabajo.');
					if (alive) setPreview(p);
				})
				.catch((e) => {
					if (alive) setError(e.message);
				});
		return () => {
			alive = false;
		};
	}, [target?.runId, target?.name, agentId, version]);
	const same = preview?.runId === target?.runId && preview?.name === target?.name ? preview : null;
	return (
		<Dialog
			open={!!target}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent
				className="artifact-drawer inset-y-0 right-0 left-auto top-0 flex h-svh max-h-svh w-full max-w-full translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 sm:w-[min(90vw,64rem)] sm:max-w-none"
				onOpenAutoFocus={() => {
					opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
				}}
				onCloseAutoFocus={(e) => {
					e.preventDefault();
					const element = opener.current?.isConnected ? opener.current : document.getElementById('main-content');
					element?.focus({ preventScroll: true });
				}}
			>
				<DialogHeader className="shrink-0 border-b p-5 pr-12">
					<DialogTitle className="break-all text-sm">{target?.name ?? 'Archivo'}</DialogTitle>
					<DialogDescription>
						Archivo privado del trabajo #{target?.runId}. Sólo quienes tienen acceso a este trabajo pueden abrirlo.
					</DialogDescription>
				</DialogHeader>
				<div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
					{target && (
						<>
							<Button
								variant="outline"
								size="sm"
								onClick={async () => {
									try {
										await navigator.clipboard.writeText(
											new URL(artifactUrl(agentId, target.runId, target.name), location.href).href,
										);
										setCopied(true);
									} catch {
										setError('No se pudo copiar. Puedes copiar la URL de la barra del navegador.');
									}
								}}
							>
								<Copy aria-hidden="true" />
								{copied ? 'Enlace copiado' : 'Copiar enlace privado'}
							</Button>
							<Button asChild variant="outline" size="sm">
								<a href={`${artifactFileUrl(target.runId, target.name)}?download=1`} download={target.name}>
									<Download aria-hidden="true" />
									Descargar
								</a>
							</Button>
						</>
					)}
					{same && <span className="text-2xs text-muted-foreground">{(same.size / 1024).toFixed(1)} KB</span>}
				</div>
				{error && (
					<div role="alert" className="m-4 text-xs text-destructive">
						{error}{' '}
						<Button size="sm" variant="outline" onClick={() => retry((v) => v + 1)}>
							Reintentar archivo
						</Button>
					</div>
				)}
				{!same && !error && (
					<p role="status" className="p-5 text-xs text-muted-foreground">
						Cargando archivo…
					</p>
				)}
				{same && <PreviewContent preview={same} />}
			</DialogContent>
		</Dialog>
	);
}
function PreviewContent({ preview: p }: { preview: Preview }) {
	const csv = useMemo(() => (p.kind === 'csv' && p.text !== null ? csvPreview(p.text) : null), [p]);
	const html = useMemo(
		() =>
			p.kind === 'html' && p.text !== null && DOMPurify.isSupported
				? isolatedHtml(
						DOMPurify.sanitize(p.text, {
							USE_PROFILES: { html: true, svg: true },
							FORBID_TAGS: [
								'script',
								'iframe',
								'object',
								'embed',
								'form',
								'input',
								'button',
								'meta',
								'base',
								'link',
								'audio',
								'video',
								'source',
								'track',
								'a',
								'area',
								'foreignObject',
								'animate',
								'set',
							],
							FORBID_ATTR: [
								'href',
								'xlink:href',
								'action',
								'formaction',
								'srcset',
								'ping',
								'target',
								'download',
								'autofocus',
							],
							ALLOW_DATA_ATTR: false,
							RETURN_TRUSTED_TYPE: false,
						}),
					)
				: null,
		[p],
	);
	if (p.kind === 'html' && html)
		return (
			<>
				<p className="shrink-0 border-b px-4 py-2 text-2xs text-muted-foreground">
					HTML estático sanitizado y aislado: sin scripts, formularios, navegación ni recursos externos.
				</p>
				<iframe
					title={`Vista previa de ${p.name}`}
					sandbox=""
					referrerPolicy="no-referrer"
					srcDoc={html}
					className="min-h-0 w-full flex-1 border-0 bg-white"
				/>
			</>
		);
	return (
		<ScrollArea
			type="auto"
			className="artifact-preview-scroll min-h-0 min-w-0 flex-1"
			viewportProps={{ tabIndex: 0, 'aria-label': `Contenido de ${p.name}` }}
		>
			<div className="min-w-0 p-5">
				{p.kind === 'image' ? (
					<img
						src={artifactFileUrl(p.runId, p.name)}
						alt={p.name}
						className="mx-auto max-h-[75svh] max-w-full object-contain"
					/>
				) : p.text === null || p.kind === 'unsupported' ? (
					<p className="text-sm text-muted-foreground">
						{p.notice ?? 'Este formato no tiene vista previa. Puedes descargar el archivo original.'}
					</p>
				) : p.kind === 'markdown' ? (
					<ArtifactMarkdown text={p.text} agentId={p.agentId} runId={p.runId} files={p.artifacts} />
				) : csv && !csv.malformed ? (
					<>
						<p className="mb-3 text-2xs text-muted-foreground">
							{csv.limited
								? 'Vista parcial: máximo 200 filas y 50 columnas. Descarga el CSV para ver todos los datos.'
								: 'Vista del CSV. Las fórmulas se muestran como texto, no se ejecutan.'}
						</p>
						<div className="max-w-full overflow-x-auto">
							<table className="w-full border-collapse text-xs">
								<tbody>
									{csv.rows.map((row, i) => (
										<tr key={i}>
											{row.map((cell, j) =>
												i === 0 ? (
													<th key={j} className="border bg-muted p-2 text-left font-medium whitespace-pre-wrap">
														{cell}
													</th>
												) : (
													<td key={j} className="border p-2 whitespace-pre-wrap">
														{cell}
													</td>
												),
											)}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</>
				) : (
					<pre className="whitespace-pre-wrap break-words font-mono text-xs">{p.text}</pre>
				)}
			</div>
		</ScrollArea>
	);
}
