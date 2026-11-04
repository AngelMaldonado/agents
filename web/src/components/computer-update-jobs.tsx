import { useRef, useState } from 'react';
import { CheckCircle2, CircleArrowUp, Clock3, LoaderCircle, Power, XCircle } from 'lucide-react';
import { useComputerUpdates } from '@/lib/computer-updates';
import { imageDetail, imageVersion } from '@/lib/image-version';
import { jobPending, UPDATE_LABEL, type ComputerUpdateJob } from '../../../shared/computer-updates';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';

export function ComputerUpdateProgress({ job }: { job: ComputerUpdateJob }) {
	const actions = useComputerUpdates();
	const [busy, setBusy] = useState(false),
		[error, setError] = useState('');
	const requestId = useRef(crypto.randomUUID());
	const done = job.items.filter((i) => i.status === 'done').length;
	const failed = job.items.filter((i) => i.status === 'failed').length;
	const act = async (retry: boolean) => {
		setBusy(true);
		setError('');
		try {
			if (retry) {
				await actions.retry(job.id, requestId.current);
				requestId.current = crypto.randomUUID();
			} else await actions.cancel(job.id);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="grid gap-3 rounded-lg border p-3 text-sm" aria-label="Progreso de actualización">
			<div className="flex items-start justify-between gap-3">
				<div>
					<p className="font-medium">
						{jobPending(job)
							? 'Actualizando computadoras'
							: job.status === 'done'
								? 'Computadoras actualizadas'
								: 'Actualización finalizada'}{' '}
						· {imageVersion(job.target)}
					</p>
				</div>
				<span className="tnum shrink-0 text-xs text-muted-foreground" role="status">
					{done}/{job.items.length} actualizadas{failed > 0 ? ` · ${failed} fallidas` : ''}
				</span>
			</div>
			{/* Updated computers; failures show in red after them. */}
			<div
				role="progressbar"
				aria-label="Computadoras actualizadas"
				aria-valuemin={0}
				aria-valuemax={job.items.length}
				aria-valuenow={done}
				className="flex h-1.5 overflow-hidden rounded-full bg-muted"
			>
				<div
					className="h-full bg-success transition-[width] duration-300"
					style={{ width: `${(done / (job.items.length || 1)) * 100}%` }}
				/>
				<div
					className="h-full bg-destructive transition-[width] duration-300"
					style={{ width: `${(failed / (job.items.length || 1)) * 100}%` }}
				/>
			</div>
			<ul className="grid gap-1.5">
				{job.items.map((item) => {
					const Icon =
						item.status === 'done'
							? CheckCircle2
							: item.status === 'failed' || item.status === 'cancelled'
								? XCircle
								: item.status === 'validating' || item.status === 'applying'
									? LoaderCircle
									: Clock3;
					return (
						<li key={item.agent_id} className="grid gap-0.5">
							<div className="flex items-center gap-2">
								<Icon
									className={`size-4 shrink-0 ${item.status === 'failed' ? 'text-destructive' : item.status === 'done' ? 'text-success' : 'text-muted-foreground'} ${item.status === 'validating' || item.status === 'applying' ? 'animate-spin' : ''}`}
									aria-hidden="true"
								/>
								<span className="min-w-0 flex-1 truncate">{item.name}</span>
								<span className="shrink-0 text-xs text-muted-foreground">{UPDATE_LABEL[item.status]}</span>
							</div>
							{item.error && <p className="break-words pl-6 text-xs text-destructive">{item.error}</p>}
						</li>
					);
				})}
			</ul>
			{jobPending(job) && (
				<p className="text-xs text-muted-foreground">Puedes cerrar esta ventana: sigue en el servidor.</p>
			)}
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				{failed > 0 && (
					<Button size="sm" variant="outline" disabled={busy} onClick={() => void act(true)}>
						Reintentar fallidas
					</Button>
				)}
				{job.items.some((i) => i.status === 'queued' || i.status === 'waiting') && (
					<Button size="sm" variant="outline" disabled={busy} onClick={() => void act(false)}>
						Cancelar pendientes
					</Button>
				)}
			</div>
		</section>
	);
}

export function ComputerUpdatesButton() {
	const { data, start, refresh } = useComputerUpdates();
	const [open, setOpen] = useState(false),
		[selected, setSelected] = useState<number[]>([]);
	const [saving, setSaving] = useState(false),
		[error, setError] = useState('');
	const requestId = useRef(crypto.randomUUID());
	const available = data.agents.filter((a) => a.updateAvailable && !a.activeJobId);
	const active = data.jobs.filter(jobPending);
	const chosen = available.filter((a) => selected.includes(a.id));
	const target = data.target;
	const pi = (v: string | null | undefined) => (v ? `pi ${v}` : 'pi ?');
	const show = () => {
		requestId.current = crypto.randomUUID();
		setSelected(available.map((a) => a.id));
		setOpen(true);
		setError('');
		void refresh();
	};
	const choose = (ids: number[]) => {
		requestId.current = crypto.randomUUID(); // another selection is another request
		setSelected(ids);
	};
	const apply = async () => {
		if (!target || !chosen.length) return;
		setSaving(true);
		setError('');
		try {
			await start(
				chosen.map((a) => ({ id: a.id, revision: a.revision })),
				target.imageId,
				requestId.current,
				true,
			);
			requestId.current = crypto.randomUUID();
			setSelected([]);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	};
	if (!available.length && !active.length && !data.error) return null;
	return (
		<>
			{/* The gallery's header: amber while there is something to update, its count; a spinner while it runs. */}
			<Button
				variant="warning"
				onClick={show}
				title={data.error ?? (target ? `A ${imageVersion(target)} · ${pi(target.piVersion)}` : undefined)}
			>
				{active.length ? (
					<LoaderCircle className="animate-spin" aria-hidden="true" />
				) : (
					<CircleArrowUp aria-hidden="true" />
				)}
				{active.length
					? 'Actualizando computadoras'
					: `Actualizar ${available.length} ${available.length === 1 ? 'computadora' : 'computadoras'}`}
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="flex max-h-[85svh] flex-col sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>Actualizar computadoras</DialogTitle>
						<DialogDescription>
							Cada una se prueba con su harness antes de cambiar; si la prueba falla, se queda como está. Las que están
							encendidas se apagan: una sesión tuya se cierra guardando el navegador, una tarea en curso se cancela.
						</DialogDescription>
					</DialogHeader>
					<ScrollArea className="min-h-0 flex-1">
						<div className="grid gap-4 pr-3">
							{target && available.length > 0 && (
								<>
									<div className="flex flex-wrap items-center justify-between gap-2 text-sm">
										<span title={imageDetail(target)}>
											Nueva: <strong>{imageVersion(target)}</strong> · {pi(target.piVersion)}
										</span>
										{target.notesUrl && (
											<a className="text-xs underline" href={target.notesUrl} target="_blank" rel="noreferrer">
												Notas de la versión
											</a>
										)}
									</div>
									<div className="flex items-center justify-between text-xs text-muted-foreground">
										<span>
											{chosen.length} de {available.length} seleccionadas
										</span>
										<button
											type="button"
											className="underline-offset-2 hover:underline"
											disabled={saving}
											onClick={() => choose(chosen.length === available.length ? [] : available.map((a) => a.id))}
										>
											{chosen.length === available.length ? 'Quitar todas' : 'Seleccionar todas'}
										</button>
									</div>
									<ul className="divide-y rounded-lg border">
										{available.map((a) => (
											<li key={a.id}>
												<label
													data-slot="label"
													className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/40"
												>
													<input
														type="checkbox"
														className="size-4 shrink-0 accent-primary"
														checked={selected.includes(a.id)}
														disabled={saving}
														onChange={(e) =>
															choose(e.target.checked ? [...selected, a.id] : selected.filter((id) => id !== a.id))
														}
													/>
													<span className="min-w-0 flex-1 truncate">{a.name}</span>
													{a.busy && (
														<span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
															<Power className="size-3.5" aria-hidden="true" />
															se apagará
														</span>
													)}
													<span
														className="shrink-0 font-mono text-2xs text-muted-foreground"
														title={imageDetail(a.current)}
													>
														{imageVersion(a.current)}
													</span>
												</label>
											</li>
										))}
									</ul>
								</>
							)}
							{(error || data.error) && (
								<p role="alert" className="text-sm text-destructive">
									{error || data.error}
								</p>
							)}
							{/* Only what is running: a finished job is said in a toast, and its computers leave the list. */}
							{active.map((job) => (
								<ComputerUpdateProgress key={job.id} job={job} />
							))}
						</div>
					</ScrollArea>
					<DialogFooter>
						<Button variant="outline" onClick={() => setOpen(false)}>
							Cerrar
						</Button>
						{available.length > 0 && (
							<Button disabled={saving || !chosen.length || !target || !!data.error} onClick={() => void apply()}>
								{saving ? (
									<LoaderCircle className="animate-spin" aria-hidden="true" />
								) : (
									<CircleArrowUp aria-hidden="true" />
								)}
								{saving ? 'Programando…' : `Actualizar ${chosen.length}`}
							</Button>
						)}
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
