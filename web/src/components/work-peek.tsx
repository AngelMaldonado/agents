// The hidden work panel's peek in the chat view: a small live view (the browser, or the latest
// activity when the work does not use it) that opens the panel on click and can be dragged anywhere
// in the chat; let go, it glides to the nearer side. Its place is remembered per browser, as a
// fraction of the room it has, so it stays put (and inside) when the window or the chat changes size.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';

const KEY = 'agents:work-peek';
const MARGIN = 8;
type Place = { fx: number; fy: number };
const read = (): Place | null => {
	try {
		const p = JSON.parse(localStorage.getItem(KEY) ?? 'null');
		return p && Number.isFinite(p.fx) && Number.isFinite(p.fy) ? p : null;
	} catch {
		return null;
	}
};
const clamp = (v: number) => Math.min(1, Math.max(0, v));

export function WorkPeek({
	container,
	onOpen,
	onClose,
	children,
}: {
	container: RefObject<HTMLElement | null>;
	onOpen: () => void;
	onClose: () => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [place, setPlace] = useState<Place | null>(read);
	const [, setSize] = useState(0); // re-render when the room changes
	const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
	const dragged = useRef(false);
	const [snapping, setSnapping] = useState(false);
	useLayoutEffect(() => {
		const room = container.current;
		if (!room) return;
		const observer = new ResizeObserver(() => setSize((n) => n + 1));
		observer.observe(room);
		return () => observer.disconnect();
	}, [container]);
	// How far it can move inside its container.
	const room = () => {
		const c = container.current,
			el = ref.current;
		if (!c || !el) return null;
		return { w: c.clientWidth - el.offsetWidth - 2 * MARGIN, h: c.clientHeight - el.offsetHeight - 2 * MARGIN };
	};
	const r = room();
	const style =
		place && r && r.w > 0 && r.h > 0
			? { left: MARGIN + place.fx * r.w, top: MARGIN + place.fy * r.h, right: 'auto' }
			: undefined;
	useEffect(() => {
		if (place && !style) setSize((n) => n + 1); // measured after mounting
	}, [place, style]);
	return (
		<div
			ref={ref}
			className="work-peek"
			style={style}
			data-dragging={drag.current?.moved || undefined}
			data-snapping={snapping || undefined}
			onPointerDown={(e) => {
				if (e.button !== 0 || (e.target as Element).closest('.work-peek-close')) return;
				const el = ref.current!;
				drag.current = { x: e.clientX, y: e.clientY, left: el.offsetLeft, top: el.offsetTop, moved: false };
				try {
					el.setPointerCapture(e.pointerId); // keep the moves even when the pointer leaves it
				} catch {
					// a pointer that is already gone: the drag simply ends
				}
			}}
			onPointerMove={(e) => {
				const d = drag.current,
					r = room();
				if (!d || !r) return;
				const dx = e.clientX - d.x,
					dy = e.clientY - d.y;
				if (!d.moved && Math.hypot(dx, dy) < 4) return; // a click, not a drag
				d.moved = true;
				setPlace({
					fx: r.w > 0 ? clamp((d.left + dx - MARGIN) / r.w) : 0,
					fy: r.h > 0 ? clamp((d.top + dy - MARGIN) / r.h) : 0,
				});
			}}
			onPointerUp={(e) => {
				const d = drag.current;
				drag.current = null;
				try {
					ref.current?.releasePointerCapture(e.pointerId);
				} catch {
					// not captured
				}
				if (!d?.moved) return;
				dragged.current = true; // the click that follows a drag does not open the panel
				// Released: it glides to the nearer side (left or right) at the height it was left.
				setSnapping(true);
				setTimeout(() => setSnapping(false), 280);
				setPlace((p) => {
					const snapped = p && { fx: p.fx < 0.5 ? 0 : 1, fy: p.fy };
					try {
						if (snapped) localStorage.setItem(KEY, JSON.stringify(snapped));
					} catch {
						// storage may be blocked: the place lasts for this page
					}
					return snapped;
				});
			}}
		>
			<button
				type="button"
				className="work-peek-open"
				aria-label="Mostrar el turno"
				title="Mostrar el turno (arrástrala para moverla)"
				onClick={() => {
					if (dragged.current) {
						dragged.current = false;
						return;
					}
					onOpen();
				}}
			>
				{children}
			</button>
			<button
				type="button"
				className="work-peek-close"
				aria-label="Cerrar la vista previa"
				title="Cerrar la vista previa"
				onClick={onClose}
			>
				<X aria-hidden="true" />
			</button>
		</div>
	);
}
