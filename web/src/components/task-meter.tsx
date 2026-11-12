// A trabajo's progress as a battery of segments: one per task (up to 12; more tasks, 10 proportional segments),
// colored in 8 steps of the theme (destructive, warning, success). The count beside it says the same in words.
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

export function TaskMeter({
	done,
	total,
	label = 'Avance',
	className,
}: {
	done: number;
	total: number;
	label?: string;
	className?: string;
}) {
	const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
	const segments = total > 0 && total <= 12 ? total : 10;
	// Something done always shows; all done fills it; otherwise, the nearest segment below full.
	const filled =
		ratio >= 1 ? segments : ratio > 0 ? Math.min(segments - 1, Math.max(1, Math.round(ratio * segments))) : 0;
	const level = ratio > 0 ? Math.max(1, Math.ceil(ratio * 8)) : 0;
	return (
		<span
			className={cn('task-meter', className)}
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={total}
			aria-valuenow={done}
			aria-valuetext={`${done} de ${total} tareas`}
			data-level={level}
			style={{ '--segments': segments } as CSSProperties}
		>
			{Array.from({ length: segments }, (_, i) => (
				<span key={i} data-on={i < filled || undefined} />
			))}
		</span>
	);
}
