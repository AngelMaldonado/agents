// Read-only, except during a takeover: then the owner's mouse, wheel and keyboard on the live view
// go to the agent's Chrome (agent-browser's stream format, in the page's CSS pixels).
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react';
import { sendInput, useFrame } from './live';
import type { BrowserSnapshot } from './api';

type Nav = (action: 'open' | 'back' | 'forward' | 'reload', url?: string) => void;
const BUTTONS = ['left', 'middle', 'right'] as const;
/** Like Chrome's omnibox: an address goes there, anything else is a Google search. */
export function omnibox(input: string) {
	const text = input.trim();
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
	if (
		!/\s/.test(text) &&
		(/^localhost(:\d+)?(\/.*)?$/i.test(text) ||
			/^[^/?#:]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(text) ||
			/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/.test(text))
	)
		return `https://${text}`;
	return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}
// The remote Chrome runs on Linux: Cmd on a Mac means Ctrl there.
const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
	(e.altKey ? 1 : 0) | (e.ctrlKey || e.metaKey ? 2 : 0) | (e.shiftKey ? 8 : 0);

export function Browser({
	agentId,
	live,
	compact = false,
	fit = false,
	taskId,
	historical = false,
	snapshot,
	loading = false,
	error = false,
	control = false,
	onNavigate,
}: {
	agentId: number;
	live: boolean;
	compact?: boolean;
	fit?: boolean;
	taskId?: number | null;
	historical?: boolean;
	snapshot?: BrowserSnapshot | null;
	loading?: boolean;
	error?: boolean;
	control?: boolean;
	onNavigate?: Nav;
}) {
	const latest = useFrame(agentId);
	// A frame belongs to a run, not just an agent. Never paint a newer run in an old snapshot.
	const frame = !historical && (taskId === undefined || latest?.taskId === taskId) ? latest : null;
	const saved = !live ? snapshot : null;
	const jpeg = historical ? saved?.jpeg : live ? frame?.jpeg : (saved?.jpeg ?? frame?.jpeg);
	const url = historical
		? (saved?.url ?? '')
		: live
			? (frame?.meta?.url ?? '')
			: (saved?.url ?? frame?.meta?.url ?? '');
	const stale = frame && Date.now() - frame.at > 30_000;
	const captured = saved ? new Date(saved.captured_at).toLocaleString('es-MX') : null;
	const element = useRef<HTMLDivElement>(null),
		bar = useRef<HTMLDivElement>(null),
		view = useRef<HTMLDivElement>(null),
		image = useRef<HTMLImageElement>(null);
	const driving = control && live && !historical;

	// ---------- takeover input ----------
	const lastMove = useRef(0);
	const point = (e: { clientX: number; clientY: number }) => {
		const img = image.current,
			r = img?.getBoundingClientRect();
		if (!img || !r?.width || !r.height || !img.naturalWidth || !img.naturalHeight) return null;
		// object-contain: the picture may be letterboxed inside the element.
		const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight),
			w = img.naturalWidth * scale,
			h = img.naturalHeight * scale;
		const x = (e.clientX - r.left - (r.width - w) / 2) / w,
			y = (e.clientY - r.top - (r.height - h) / 2) / h;
		if (x < 0 || x > 1 || y < 0 || y > 1) return null;
		// The picture is the page at 1:1 (headed Chrome: 1050×557). The frame metadata claims 1280×720,
		// the viewport agent-browser asked for but does not get: trusting it put every click off by 1.22.
		return { x: Math.round(x * img.naturalWidth), y: Math.round(y * img.naturalHeight) };
	};
	const mouse = (e: PointerEvent, eventType: 'mousePressed' | 'mouseReleased' | 'mouseMoved') => {
		const p = point(e);
		if (!p) return;
		if (eventType === 'mouseMoved') {
			const now = performance.now();
			if (now - lastMove.current < 40) return;
			lastMove.current = now;
			const held = e.buttons & 1 ? 'left' : e.buttons & 2 ? 'right' : e.buttons & 4 ? 'middle' : undefined;
			return sendInput(agentId, {
				type: 'input_mouse',
				eventType,
				...p,
				...(held ? { button: held, clickCount: 1 } : {}),
			});
		}
		sendInput(agentId, {
			type: 'input_mouse',
			eventType,
			...p,
			button: BUTTONS[e.button] ?? 'left',
			clickCount: Math.max(1, Math.min(3, e.detail || 1)),
		});
	};
	const key = (e: KeyboardEvent, eventType: 'keyDown' | 'keyUp') => {
		// Paste goes through the paste event; Tab and the rest stay in the remote page.
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') return;
		e.preventDefault();
		e.stopPropagation();
		if (e.key === 'Dead' || e.key === 'Process' || e.key === 'Unidentified') return;
		const mods = modifiers(e);
		const text =
			eventType === 'keyDown' && !(mods & 2)
				? e.key.length === 1
					? e.key
					: e.key === 'Enter'
						? '\r'
						: undefined
				: undefined;
		// keyCode is the Windows virtual key code Chrome needs for editing keys (Backspace, arrows, Ctrl+A).
		sendInput(agentId, {
			type: 'input_keyboard',
			eventType,
			key: e.key,
			code: e.code,
			text,
			modifiers: mods,
			windowsVirtualKeyCode: e.nativeEvent.keyCode || undefined,
		});
	};
	useEffect(() => {
		const el = view.current;
		if (!driving || !el) return;
		el.focus({ preventScroll: true });
		const wheel = (e: WheelEvent) => {
			e.preventDefault();
			const p = point(e);
			if (p)
				sendInput(agentId, {
					type: 'input_mouse',
					eventType: 'mouseWheel',
					...p,
					deltaX: Math.round(e.deltaX),
					deltaY: Math.round(e.deltaY),
				});
		};
		el.addEventListener('wheel', wheel, { passive: false });
		return () => el.removeEventListener('wheel', wheel);
	}, [driving, agentId]);

	// Shown at once where you clicked: the page's answer comes with the next frame.
	const [ripple, setRipple] = useState<{ x: number; y: number; id: number } | null>(null);
	const [address, setAddress] = useState('');
	const [editing, setEditing] = useState(false);
	return (
		<div
			ref={element}
			className={`browser ${compact ? 'compact' : ''} ${fit ? 'fitted' : ''} ${driving ? 'driving' : ''}`}
		>
			<div ref={bar} className="browser-bar">
				{driving && onNavigate ? (
					<>
						<button
							type="button"
							className="browser-nav"
							aria-label="Atrás"
							title="Atrás"
							onClick={() => onNavigate('back')}
						>
							<ArrowLeft aria-hidden="true" />
						</button>
						<button
							type="button"
							className="browser-nav"
							aria-label="Adelante"
							title="Adelante"
							onClick={() => onNavigate('forward')}
						>
							<ArrowRight aria-hidden="true" />
						</button>
						<button
							type="button"
							className="browser-nav"
							aria-label="Recargar"
							title="Recargar"
							onClick={() => onNavigate('reload')}
						>
							<RotateCw aria-hidden="true" />
						</button>
						<form
							className="browser-address"
							onSubmit={(e) => {
								e.preventDefault();
								if (!address.trim()) return;
								onNavigate('open', omnibox(address));
								setEditing(false);
								view.current?.focus({ preventScroll: true });
							}}
						>
							<input
								aria-label="Dirección"
								value={editing ? address : url}
								placeholder="Busca en Google o escribe una dirección"
								onFocus={(e) => {
									setAddress(url);
									setEditing(true);
									requestAnimationFrame(() => e.target.select());
								}}
								onBlur={() => setEditing(false)}
								onChange={(e) => setAddress(e.target.value)}
							/>
						</form>
					</>
				) : (
					<>
						<span className="dots" aria-hidden="true">
							<i />
							<i />
							<i />
						</span>
						<span className="url" title={url}>
							{url
								? url.replace(/^https?:\/\//, '')
								: live
									? 'abriendo…'
									: historical
										? `Trabajo #${taskId}`
										: 'sin navegador'}
						</span>
					</>
				)}
				{driving ? (
					<span className="rec taking">● TU CONTROL</span>
				) : live && !historical ? (
					<span className={`rec ${stale ? 'idle' : ''}`}>● EN VIVO</span>
				) : (
					(historical || saved) && <span className="rec idle">SNAPSHOT</span>
				)}
			</div>
			<div
				ref={view}
				className="browser-view"
				tabIndex={driving ? 0 : undefined}
				aria-label={driving ? 'Navegador del agente bajo tu control: el teclado y el mouse van a la página' : undefined}
				onPointerDown={
					driving
						? (e) => {
								e.preventDefault();
								view.current?.focus({ preventScroll: true });
								e.currentTarget.setPointerCapture(e.pointerId);
								mouse(e, 'mousePressed');
								const r = e.currentTarget.getBoundingClientRect();
								setRipple({ x: e.clientX - r.left, y: e.clientY - r.top, id: e.timeStamp });
							}
						: undefined
				}
				onPointerUp={driving ? (e) => mouse(e, 'mouseReleased') : undefined}
				onPointerMove={driving ? (e) => mouse(e, 'mouseMoved') : undefined}
				onContextMenu={driving ? (e) => e.preventDefault() : undefined}
				onKeyDown={driving ? (e) => key(e, 'keyDown') : undefined}
				onKeyUp={driving ? (e) => key(e, 'keyUp') : undefined}
				onPaste={
					driving
						? (e) => {
								e.preventDefault();
								for (const ch of e.clipboardData.getData('text').slice(0, 500)) {
									sendInput(agentId, { type: 'input_keyboard', eventType: 'keyDown', key: ch, text: ch });
									sendInput(agentId, { type: 'input_keyboard', eventType: 'keyUp', key: ch });
								}
							}
						: undefined
				}
			>
				{jpeg ? (
					<>
						<img
							ref={image}
							className={!live && !historical && !saved ? 'ended' : undefined}
							src={`data:image/jpeg;base64,${jpeg}`}
							alt={historical ? `Captura del trabajo #${taskId}` : live ? 'Pantalla del agente' : 'Última pantalla'}
							draggable={false}
						/>
						{driving && ripple && (
							<span
								key={ripple.id}
								className="click-ripple"
								style={{ left: ripple.x, top: ripple.y }}
								aria-hidden="true"
							/>
						)}
						{!live && (
							<span className="ended-note">
								{captured ? `Captura · ${captured}` : 'Última imagen · la computadora ya se apagó'}
							</span>
						)}
					</>
				) : (
					<div className="no-signal" role={loading ? 'status' : undefined}>
						{loading
							? 'Cargando captura…'
							: error
								? 'No se pudo cargar la captura del trabajo.'
								: historical
									? 'Este trabajo no tiene una captura guardada.'
									: live
										? 'Esperando la primera imagen…'
										: 'El navegador se apaga entre tareas'}
					</div>
				)}
			</div>
		</div>
	);
}
