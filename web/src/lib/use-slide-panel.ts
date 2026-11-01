// A side panel that slides open and closed (the chat view's work, Automejora's contract): it stays
// mounted as a collapsible resizable panel, and while it changes size its group carries
// data-animating, which turns on a flex-grow transition (styles.css, .slide-split).
import { useLayoutEffect, useRef, useState } from 'react';
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels';

const DURATION = 260;

export function useSlidePanel(open: boolean, onDraggedClosed: () => void) {
	const ref = useRef<PanelImperativeHandle | null>(null);
	const [animating, setAnimating] = useState(false);
	const openNow = useRef(open);
	openNow.current = open;
	const sliding = useRef(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useLayoutEffect(() => {
		const panel = ref.current;
		if (!panel || open !== panel.isCollapsed()) return;
		sliding.current = true;
		setAnimating(true);
		clearTimeout(timer.current);
		// The transition has to be on before the size changes: move it on the next frame.
		const frame = requestAnimationFrame(() => (open ? panel.expand() : panel.collapse()));
		timer.current = setTimeout(() => {
			sliding.current = false;
			setAnimating(false);
		}, DURATION + 40);
		return () => cancelAnimationFrame(frame);
	}, [open]);
	useLayoutEffect(() => () => clearTimeout(timer.current), []);
	/** For the panel's onResize: it starts where the state says, and a drag that closes it closes the state. */
	const onResize = (size: PanelSize, _id: string | number | undefined, previous: PanelSize | undefined) => {
		if (!previous) {
			if (!openNow.current) ref.current?.collapse();
			return;
		}
		if (size.asPercentage === 0 && previous.asPercentage > 0 && openNow.current && !sliding.current) onDraggedClosed();
	};
	return { ref, animating, onResize };
}
