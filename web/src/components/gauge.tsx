// A speedometer for one bounded value (Monitor: CPU load, memory in use, room for computers).
// A neutral track and one primary arc (magnitude: a single hue, no status colors), thin with round
// ends; the number and its labels in text inks. role="meter" carries the value for screen readers;
// the title is its hover detail.
import { cn } from '@/lib/utils';

const R = 40,
	STROKE = 8,
	LENGTH = Math.PI * R; // the half circle

export function Gauge({
	label,
	value,
	max,
	display,
	detail,
	className,
}: {
	label: string;
	value: number;
	max: number;
	display: string; // the number in the middle, already formatted
	detail: string; // under it; also the hover and screen-reader text
	className?: string;
}) {
	const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
	return (
		<figure
			role="meter"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={max}
			aria-valuenow={Math.min(value, max)}
			aria-valuetext={`${display}. ${detail}`}
			title={`${label}: ${display}. ${detail}`}
			className={cn('flex min-w-0 flex-col items-center gap-1 text-center', className)}
		>
			<svg viewBox="0 0 100 56" className="w-full max-w-44" aria-hidden="true">
				<path
					d={`M ${50 - R} 50 A ${R} ${R} 0 0 1 ${50 + R} 50`}
					fill="none"
					stroke="var(--muted)"
					strokeWidth={STROKE}
					strokeLinecap="round"
				/>
				{ratio > 0 && (
					<path
						d={`M ${50 - R} 50 A ${R} ${R} 0 0 1 ${50 + R} 50`}
						fill="none"
						stroke="var(--primary)"
						strokeWidth={STROKE}
						strokeLinecap="round"
						strokeDasharray={`${LENGTH * ratio} ${LENGTH}`}
						className="transition-[stroke-dasharray] duration-500 motion-reduce:transition-none"
					/>
				)}
				<text x="50" y="47" textAnchor="middle" className="fill-foreground text-[0.9rem] font-semibold">
					{display}
				</text>
			</svg>
			<figcaption className="grid gap-0.5">
				<span className="text-xs font-medium">{label}</span>
				<span className="text-2xs text-muted-foreground">{detail}</span>
			</figcaption>
		</figure>
	);
}
