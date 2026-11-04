// The agent's computer in the human's hands (#27): a browser session, or a takeover. A small animated
// monitor instead of the spinner of an agent working (sidebar and the work's footer).
import { cn } from '@/lib/utils';

export const humanDriving = (t: { kind?: string; control?: boolean; status?: string } | null | undefined) =>
	!!t && t.status !== 'queued' && (t.kind === 'browser' || !!t.control);

export function ComputerBusy({
	className,
	label = 'Estás usando su computadora',
}: {
	className?: string;
	label?: string;
}) {
	return (
		<span role="img" aria-label={label} title={label} className={cn('computer-busy inline-flex shrink-0', className)}>
			<svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
				<rect x="1.5" y="2" width="13" height="9" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
				<path d="M6 14h4M8 11v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
				<rect className="computer-busy-line" x="3.5" y="4.3" width="6" height="1.3" rx=".6" fill="currentColor" />
				<rect className="computer-busy-line two" x="3.5" y="6.8" width="4" height="1.3" rx=".6" fill="currentColor" />
				<rect className="computer-busy-cursor" x="10.6" y="6.6" width="1.3" height="1.8" rx=".3" fill="currentColor" />
			</svg>
		</span>
	);
}
