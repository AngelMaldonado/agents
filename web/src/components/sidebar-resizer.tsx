// The handle on the sidebar's right edge (ported from Nova's sidebar-resizer.svelte): drag it to
// widen or narrow the sidebar, double-click it to go back to the default, or focus it and use
// ← / → (Home resets). It shows nothing of its own: hovered or focused it sets
// data-sidebar-resize="hover" on <html>, dragging "drag", and styles.css lights the main panel's
// left border, which bends round its rounded corners. Dragging also switches off the sidebar's
// width transition, so the edge follows the pointer. Desktop only, and only while unfolded.
import { useEffect, useRef } from 'react';
import { useSidebar } from '@/components/ui/sidebar';
import { SIDEBAR_MAX_REM, SIDEBAR_MIN_REM, type SidebarWidth } from '@/lib/sidebar-width';

export function SidebarResizer({ width }: { width: SidebarWidth }) {
	const { open, isMobile } = useSidebar();
	const state = useRef({ dragging: false, hovered: false, focused: false, startX: 0, startRem: 0 });
	const mark = () => {
		const s = state.current,
			root = document.documentElement;
		if (s.dragging) root.dataset.sidebarResize = 'drag';
		else if (s.hovered || s.focused) root.dataset.sidebarResize = 'hover';
		else delete root.dataset.sidebarResize;
	};
	useEffect(() => () => void delete document.documentElement.dataset.sidebarResize, []);
	if (!open || isMobile) return null;
	const rootPx = () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
	const end = () => {
		if (!state.current.dragging) return;
		state.current.dragging = false;
		mark();
		width.save();
	};
	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label="Ancho del menú"
			aria-valuemin={SIDEBAR_MIN_REM}
			aria-valuemax={SIDEBAR_MAX_REM}
			aria-valuenow={width.rem}
			title="Arrastra para cambiar el ancho · doble clic para restablecer"
			tabIndex={0}
			className="absolute inset-y-0 right-0 z-20 hidden w-3 translate-x-1/2 cursor-col-resize touch-none outline-none md:block"
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				Object.assign(state.current, { dragging: true, startX: e.clientX, startRem: width.rem });
				mark();
			}}
			onPointerMove={(e) => {
				const s = state.current;
				if (s.dragging) width.set(s.startRem + (e.clientX - s.startX) / rootPx(), false);
			}}
			onPointerUp={end}
			onPointerCancel={end}
			onLostPointerCapture={end}
			onPointerEnter={() => {
				state.current.hovered = true;
				mark();
			}}
			onPointerLeave={() => {
				state.current.hovered = false;
				mark();
			}}
			onFocus={(e) => {
				state.current.focused = e.currentTarget.matches(':focus-visible');
				mark();
			}}
			onBlur={() => {
				state.current.focused = false;
				mark();
			}}
			onDoubleClick={() => width.reset()}
			onKeyDown={(e) => {
				if (e.key === 'ArrowLeft') width.set(width.rem - 1);
				else if (e.key === 'ArrowRight') width.set(width.rem + 1);
				else if (e.key === 'Home') width.reset();
				else return;
				e.preventDefault();
			}}
		/>
	);
}
