// A list and the detail opened from it, side by side: the detail slides in over the list and back out. While it
// slides back, the last detail stays on screen; once a slide ends, the pane out of view takes no height.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function SlideStack({ list, detail }: { list: ReactNode; detail: ReactNode | null }) {
	const open = detail !== null && detail !== undefined && detail !== false;
	const last = useRef<ReactNode>(null);
	if (open) last.current = detail;
	const [settled, setSettled] = useState(true);
	const first = useRef(true);
	useLayoutEffect(() => {
		if (first.current) {
			first.current = false;
			return;
		}
		// Without motion there is no transition to wait for.
		setSettled(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
	}, [open]);
	return (
		<div
			className="slide-stack"
			data-detail={open}
			onTransitionEnd={(e) => {
				if (e.target === e.currentTarget.firstElementChild && e.propertyName === 'transform') setSettled(true);
			}}
		>
			<div className="slide-stack-track">
				<div
					className={cn('slide-stack-pane', open && settled && 'slide-stack-hidden')}
					inert={open}
					aria-hidden={open}
				>
					{list}
				</div>
				<div
					className={cn('slide-stack-pane', !open && settled && 'slide-stack-hidden')}
					inert={!open}
					aria-hidden={!open}
				>
					{open ? detail : settled ? null : last.current}
				</div>
			</div>
		</div>
	);
}
