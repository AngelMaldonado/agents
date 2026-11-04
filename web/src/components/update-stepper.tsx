// One computer's update as steps (#28), like the agent's initialization: where it is, what is done.
import { Check, Circle, LoaderCircle, XCircle } from 'lucide-react';
import type { ComputerUpdateItem, ComputerUpdateJob } from '../../../shared/computer-updates';

const STEPS = [
	{ id: 'prepare', label: 'Preparar la imagen nueva' },
	{ id: 'wait', label: 'Esperar a que la computadora esté libre' },
	{ id: 'test', label: 'Probar el harness en la imagen nueva' },
	{ id: 'apply', label: 'Guardar la revisión con la imagen nueva' },
] as const;

/** How many steps are done, and whether the current one runs or failed. Without a job: none started. */
function progress(job: ComputerUpdateJob | null, item: ComputerUpdateItem | null) {
	if (!job || !item) return { done: 0, failed: false, running: false };
	const at = {
		queued: job.status === 'preparing' || job.status === 'queued' ? 0 : 1,
		waiting: 1,
		validating: 2,
		applying: 3,
	};
	if (item.status === 'done') return { done: STEPS.length, failed: false, running: false };
	if (item.status === 'failed' || item.status === 'cancelled') {
		// The whole job failing is its image's preparation; one computer failing, its harness test.
		return { done: job.status === 'failed' ? 0 : 2, failed: true, running: false };
	}
	return { done: at[item.status], failed: false, running: true };
}

export function UpdateStepper({ job, item }: { job: ComputerUpdateJob | null; item: ComputerUpdateItem | null }) {
	const { done, failed, running } = progress(job, item);
	const percent = Math.round((done / STEPS.length) * 100);
	return (
		<section aria-label="Progreso de la actualización" className="grid gap-3">
			<div className="flex items-center justify-between text-xs">
				<span>
					{item?.status === 'done'
						? 'Actualizada'
						: failed
							? item?.status === 'cancelled'
								? 'Cancelada'
								: 'No se pudo actualizar'
							: running
								? 'Actualizando'
								: 'Lista para actualizar'}
				</span>
				<span className="tnum text-muted-foreground">
					{done}/{STEPS.length} pasos
				</span>
			</div>
			<div
				role="progressbar"
				aria-label="Actualización de la computadora"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={percent}
				className="h-1.5 overflow-hidden rounded-full bg-muted"
			>
				<div
					className={`h-full rounded-full transition-[width] duration-300 ${failed ? 'bg-destructive' : 'bg-primary'}`}
					style={{ width: `${percent}%` }}
				/>
			</div>
			<ol className="grid gap-3">
				{STEPS.map((step, i) => {
					const isDone = i < done,
						current = i === done;
					return (
						<li
							key={step.id}
							className="flex items-center gap-3 text-sm"
							aria-current={current && running ? 'step' : undefined}
						>
							{isDone ? (
								<Check className="size-4 shrink-0 text-success" aria-hidden="true" />
							) : current && failed ? (
								<XCircle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
							) : current && running ? (
								<LoaderCircle className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
							) : (
								<Circle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							)}
							<span className={isDone || current ? 'text-foreground' : 'text-muted-foreground'}>{step.label}</span>
						</li>
					);
				})}
			</ol>
			{item?.error && (
				<p role="alert" className="break-words text-xs text-destructive">
					{item.error}
				</p>
			)}
		</section>
	);
}
