// Its content changes height (a list gives way to a detail, a modal opens another part): the box follows it
// smoothly instead of jumping. Without motion, it jumps.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function SmoothHeight({ children, className }: { children: ReactNode; className?: string }) {
	const inner = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState<number>();
	useLayoutEffect(() => {
		const el = inner.current;
		if (!el) return;
		const measure = () => setHeight(el.offsetHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	return (
		<div className={cn('smooth-height', className)} style={{ height }}>
			<div ref={inner} className="min-w-0">
				{children}
			</div>
		</div>
	);
}
