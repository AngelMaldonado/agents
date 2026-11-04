// One update controller shared by the hub's Computer menu and the focused resource menu.
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, CircleArrowUp, Info, LoaderCircle, Power } from 'lucide-react';
import { useComputerUpdates } from '@/lib/computer-updates';
import { UpdateStepper } from '@/components/update-stepper';
import { updatePending } from '../../../shared/computer-updates';
import { api } from '@/api';
import { imageDetail, imageVersion as version, type ImageIdentity } from '@/lib/image-version';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';

type Image = ImageIdentity & {
	piVersion: string | null;
	available: boolean;
	notesUrl: string | null;
};
type Update = { revision: number; current: Image | null; target: Image; updateAvailable: boolean };

export function useComputerUpdate({
	agentId,
	revision,
	imageRef,
	mine,
	busy,
}: {
	agentId: number;
	revision: number;
	imageRef: string;
	mine: boolean;
	busy: boolean;
	onChanged: () => void;
}) {
	const [data, setData] = useState<Update | null>(null);
	const [error, setError] = useState('');
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const updates = useComputerUpdates();
	const { watch } = updates;
	useEffect(() => (open ? watch() : undefined), [open, watch]); // its stepper shows the end
	const related =
		updates.data.jobs.find((j) => j.items.some((i) => i.agent_id === agentId && updatePending(i.status))) ??
		updates.data.jobs.find((j) => j.items.some((i) => i.agent_id === agentId));
	const active = related?.items.some((i) => i.agent_id === agentId && updatePending(i.status)) ?? false;
	const requestId = useRef(crypto.randomUUID());
	const generation = useRef(0);
	const refresh = async () => {
		if (!mine) return;
		const request = ++generation.current;
		setLoading(true);
		try {
			const next = await api<Update>(`/agents/${agentId}/computer-update`);
			if (request === generation.current) {
				setData(next);
				setError('');
			}
		} catch (e) {
			if (request === generation.current) setError((e as Error).message);
		} finally {
			if (request === generation.current) setLoading(false);
		}
	};
	useEffect(() => {
		setOpen(false);
		requestId.current = crypto.randomUUID();
	}, [agentId, mine]);
	useEffect(() => {
		setData(null);
		setError('');
		void refresh();
		return () => {
			generation.current++;
		};
	}, [agentId, revision, imageRef, mine]);
	const apply = async () => {
		if (!data || saving || active) return;
		setSaving(true);
		setError('');
		try {
			await updates.start([{ id: agentId, revision: data.revision }], data.target.imageId, requestId.current, true);
			requestId.current = crypto.randomUUID();
			await refresh();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	};
	const mark = active ? (
		<LoaderCircle className="size-3.5 animate-spin text-warning" aria-label="Actualización en curso" />
	) : data?.updateAvailable ? (
		<CircleArrowUp className="size-3.5 text-warning" aria-label="Actualización disponible" />
	) : null;
	const menuItem = mine && (
		<>
			<DropdownMenuSeparator />
			<DropdownMenuItem
				onSelect={() => {
					setOpen(true);
				}}
			>
				{active ? (
					<LoaderCircle className="animate-spin text-warning" aria-hidden="true" />
				) : data?.updateAvailable ? (
					<CircleArrowUp className="text-warning" aria-hidden="true" />
				) : (
					<Info aria-hidden="true" />
				)}
				<span className="grid">
					<span>
						{active
							? 'Actualización en curso'
							: data?.updateAvailable
								? 'Actualización disponible'
								: 'Versiones de la computadora'}
					</span>
					<span className="text-2xs text-muted-foreground">
						{data
							? data.updateAvailable
								? `${version(data.current)} → ${version(data.target)}`
								: `${version(data.current)} · pi ${data.current?.piVersion ?? 'versión no disponible'}`
							: loading
								? 'Consultando versiones…'
								: 'Consultar imagen y pi'}
					</span>
				</span>
			</DropdownMenuItem>
		</>
	);
	// The stepper follows a job in progress, or one that just ended (a while ago, that one is history).
	const shown = related && (active || Date.now() - related.updated_at < 15 * 60_000) ? related : null;
	const item = shown?.items.find((i) => i.agent_id === agentId) ?? null;
	const dialog = mine && (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Actualizar computadora</DialogTitle>
					<DialogDescription>
						Se prueba con su harness antes de cambiar; si falla, se queda como está. Sus archivos y chats se conservan.
					</DialogDescription>
				</DialogHeader>
				{data && (
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2.5 text-sm">
						{data.updateAvailable && (
							<>
								<span title={imageDetail(data.current)}>{version(data.current)}</span>
								<ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
							</>
						)}
						<span className="font-medium" title={imageDetail(data.target)}>
							{version(data.target)}
						</span>
						<span className="text-muted-foreground">
							· pi {data.current?.piVersion ?? '?'}
							{data.target.piVersion !== data.current?.piVersion && ` → ${data.target.piVersion ?? '?'}`}
						</span>
						{data.target.notesUrl && (
							<a className="ml-auto text-xs underline" href={data.target.notesUrl} target="_blank" rel="noreferrer">
								Notas
							</a>
						)}
					</div>
				)}
				{data && !data.updateAvailable && !shown ? (
					<p className="flex items-center gap-2 text-sm text-muted-foreground">
						<Check className="size-4 text-success" aria-hidden="true" />
						Ya usa la versión más reciente publicada por Agents.
					</p>
				) : (
					(data || shown) && <UpdateStepper job={shown} item={item} />
				)}
				{busy && !active && data?.updateAvailable && (
					<p className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-on-soft">
						<Power className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
						Su computadora está encendida: al actualizar se apaga. Una sesión tuya se cierra guardando el navegador; una
						tarea en curso se cancela y se guarda lo que lleve.
					</p>
				)}
				{error && (
					<p role="alert" className="error text-sm">
						{error}
					</p>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>
						Cerrar
					</Button>
					{error && (
						<Button variant="outline" disabled={saving || loading} onClick={() => void refresh()}>
							Reintentar consulta
						</Button>
					)}
					{data?.updateAvailable && !active && (
						<Button variant="warning" disabled={saving || loading || !!error} onClick={() => void apply()}>
							{saving ? (
								<LoaderCircle className="animate-spin" aria-hidden="true" />
							) : (
								<CircleArrowUp aria-hidden="true" />
							)}
							{saving ? 'Programando…' : busy ? 'Apagar y actualizar' : 'Actualizar'}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
	return { mark, menuItem, dialog, refresh };
}
