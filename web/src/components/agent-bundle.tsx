// .cubyagent (Angel 13-nov-2026): an agent as a file (server/src/agent-bundle.ts). Exportar, in its Avanzado:
// downloads it with all its configuration, its lessons and its computer's files. Importar, beside «Nuevo agente»:
// shows what importing it would do (what it needs, matched by name and number) and creates it.
import { useRef, useState } from 'react';
import { Check, Download, PackageOpen, Upload, X } from 'lucide-react';
import { isLive, type Agent } from '@/api';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';

/** Avanzado → Exportar: the agent as a .cubyagent, downloaded. */
export function ExportAgent({ agent }: { agent: Agent }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const live = isLive(agent.task);
	const download = async () => {
		setBusy(true);
		setError('');
		try {
			const res = await fetch(`/api/agents/${agent.id}/export`, { credentials: 'same-origin' });
			if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Error ${res.status}`);
			const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'agente.cubyagent';
			const url = URL.createObjectURL(await res.blob());
			const link = Object.assign(document.createElement('a'), { href: url, download: name });
			link.click();
			URL.revokeObjectURL(url);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="panel">
			<h2>Exportar</h2>
			<p className="mb-3 mt-2 text-xs text-muted-foreground">
				Descarga el agente como archivo <code>.cubyagent</code> para montarlo en otra plataforma: su configuración, sus
				horarios, sus aprendizajes, sus contactos y los archivos de su computadora. Nunca sus contraseñas, sesiones ni
				conversaciones.
			</p>
			<Button variant="outline" size="sm" disabled={busy || live} onClick={() => void download()}>
				<Download aria-hidden="true" />
				{busy ? 'Exportando…' : 'Exportar .cubyagent'}
			</Button>
			{live && <p className="mt-2 text-xs text-muted-foreground">Se exporta con su computadora apagada.</p>}
			{error && (
				<p role="alert" className="error mt-3">
					{error}
				</p>
			)}
		</section>
	);
}

type Preview = {
	manifest: {
		agent: { name: string; model: string };
		exported: { at: string; by: string; from: string; revision: number };
	};
	contract: string;
	style: string;
	tools: string[];
	harnessError: string | null;
	missingModel: string | null;
	schedules: number;
	lessons: number;
	actors: number;
	workspaceBytes: number;
	accesses: { kind: 'site' | 'mcp' | 'key'; name: string; have: boolean }[];
	contacts: { phone: string; label: string; role: string; enabled: boolean; have: boolean }[];
};
const KIND = { site: 'Acceso a sitio', mcp: 'Servidor MCP', key: 'API key' } as const;
const ROLE: Record<string, string> = { external: 'contacto externo', direct: 'invitado directo', guest: 'invitado' };
const size = (n: number) =>
	n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Beside «Nuevo agente»: a .cubyagent, previewed, then created. */
export function ImportAgent() {
	const input = useRef<HTMLInputElement>(null);
	const [file, setFile] = useState<File | null>(null);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const send = async (path: string, f: File) => {
		const res = await fetch(`/api/agents/${path}`, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/octet-stream' },
			body: f,
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
		return data;
	};
	const pick = async (f: File | undefined) => {
		if (!f) return;
		setFile(f);
		setPreview(null);
		setError('');
		setBusy(true);
		try {
			setPreview((await send('import/inspect', f)).preview);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
			if (input.current) input.current.value = '';
		}
	};
	const create = async () => {
		if (!file) return;
		setBusy(true);
		setError('');
		try {
			const done = await send('import', file);
			setFile(null);
			location.hash = `#/agent/${done.agent.id}`;
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const blocked = !!preview && (!!preview.harnessError || !!preview.missingModel);
	return (
		<>
			<Button variant="outline" onClick={() => input.current?.click()}>
				<Upload aria-hidden="true" />
				Importar
			</Button>
			<input ref={input} type="file" accept=".cubyagent,.zip" hidden onChange={(e) => void pick(e.target.files?.[0])} />
			<Dialog open={!!file} onOpenChange={(o) => !o && !busy && setFile(null)}>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<PackageOpen aria-hidden="true" className="size-5" />
							{preview ? `Importar «${preview.manifest.agent.name}»` : 'Importar agente'}
						</DialogTitle>
						<DialogDescription>
							{preview
								? `Exportado por ${preview.manifest.exported.by} desde ${preview.manifest.exported.from} (revisión ${preview.manifest.exported.revision}).`
								: busy
									? 'Revisando el archivo…'
									: file?.name}
						</DialogDescription>
					</DialogHeader>
					{preview && (
						<div className="bundle-preview">
							<p className="text-sm">
								{preview.manifest.agent.model} · estilo {preview.style} · {preview.tools.length} herramientas
								{preview.schedules ? ` · ${preview.schedules} horarios (llegan pausados)` : ''}
								{preview.lessons ? ` · ${preview.lessons} aprendizajes` : ''}
								{preview.workspaceBytes ? ` · archivos de su computadora (${size(preview.workspaceBytes)})` : ''}
							</p>
							<pre className="bundle-contract">{preview.contract.slice(0, 600)}</pre>
							{preview.harnessError && (
								<p role="alert" className="error">
									Esta plataforma no puede con su harness: {preview.harnessError}
								</p>
							)}
							{preview.missingModel && (
								<p role="alert" className="error">
									El modelo {preview.missingModel} no está en el catálogo de esta plataforma.
								</p>
							)}
							{(preview.accesses.length > 0 || preview.contacts.length > 0) && (
								<div>
									<p className="text-xs font-medium text-muted-foreground">Lo que necesita</p>
									<ul className="bundle-needs">
										{preview.accesses.map((x) => (
											<li key={`${x.kind}-${x.name}`} data-have={x.have || undefined}>
												{x.have ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
												<span>
													{KIND[x.kind]} <strong>{x.name}</strong>
												</span>
												<span className="bundle-need-state">{x.have ? 'se concede el tuyo' : 'agrégalo después'}</span>
											</li>
										))}
										{preview.contacts.map((x) => (
											<li key={x.phone} data-have={x.have || undefined}>
												{x.have ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
												<span>
													{x.label || x.phone} <span className="text-muted-foreground">({ROLE[x.role] ?? x.role})</span>
												</span>
												<span className="bundle-need-state">
													{x.have ? 'se enciende' : 'no está en esta plataforma'}
												</span>
											</li>
										))}
									</ul>
								</div>
							)}
						</div>
					)}
					{error && (
						<p role="alert" className="error">
							{error}
						</p>
					)}
					<DialogFooter>
						<Button variant="outline" disabled={busy} onClick={() => setFile(null)}>
							Cancelar
						</Button>
						<Button disabled={busy || !preview || blocked} onClick={() => void create()}>
							{busy && preview ? 'Probando y creando…' : 'Crear agente'}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
