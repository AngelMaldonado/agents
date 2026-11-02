// One line that changes like a ticker: when its key changes, the new line fades in from below and
// pushes the old one up and out. Re-renders under the same key (a clock that ticks) do not animate.
// Reduced motion: the global rule cuts the animation to nothing and the swap is instant.
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Line = { key: string; node: ReactNode };

export function Ticker({ itemKey, children, className }: { itemKey: string; children: ReactNode; className?: string }) {
	const [old, setOld] = useState<Line | null>(null);
	const [current, setCurrent] = useState<Line>({ key: itemKey, node: children });
	// Adjusting state while rendering (React's pattern for "derive from a changed prop").
	if (current.key !== itemKey) {
		setOld(current);
		setCurrent({ key: itemKey, node: children });
	}
	return (
		<div className={cn('ticker', className)}>
			{old && (
				<div
					key={`old-${old.key}`}
					className="ticker-line ticker-out"
					aria-hidden="true"
					onAnimationEnd={() => setOld(null)}
				>
					{old.node}
				</div>
			)}
			<div key={itemKey} className={cn('ticker-line', old && 'ticker-in')}>
				{children}
			</div>
		</div>
	);
}
