// A procedural pixel-art worker at a desk, drawn on canvas: no sprites, no assets.
// The seed picks the look; the state picks the animation.
import { useEffect, useRef } from 'react';

export type CharState =
	| 'idle'
	| 'starting'
	| 'thinking'
	| 'browsing'
	| 'running'
	| 'writing'
	| 'blocked'
	| 'steered'
	| 'done'
	| 'incomplete'
	| 'cancelled'
	| 'error';

export const STATE_LABEL: Record<CharState, string> = {
	idle: 'Libre',
	starting: 'Arrancando',
	thinking: 'Pensando',
	browsing: 'Navegando',
	running: 'Ejecutando',
	writing: 'Escribiendo archivos',
	blocked: 'Atascado: necesita ayuda',
	steered: 'Recibió instrucciones',
	done: 'Terminado',
	incomplete: 'Incompleto',
	cancelled: 'Cancelado',
	error: 'Error',
};

const W = 32;
const H = 32;

function hash(seed: string) {
	let h = 2166136261;
	for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
	return () => {
		h = Math.imul(h ^ (h >>> 15), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		return ((h ^= h >>> 16) >>> 0) / 4294967296;
	};
}

const SKINS = ['#f1c7a3', '#e0ac85', '#c68863', '#8d5a3b', '#6b4329', '#f5d6c0'];
const HAIRS = ['#2b1d16', '#5a3a22', '#a0672e', '#d9b25f', '#1c1c24', '#7a2e2e', '#c9c9d1', '#3b5ba5'];
const SHIRTS = ['#3d7be0', '#e05a5a', '#3fae6b', '#9b59d0', '#e0a03d', '#2fb3b3', '#e06fa8', '#5d6b7a'];

function look(seed: string) {
	const r = hash(seed);
	const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
	return { skin: pick(SKINS), hair: pick(HAIRS), shirt: pick(SHIRTS), style: Math.floor(r() * 3), glasses: r() < 0.3 };
}

function draw(ctx: CanvasRenderingContext2D, seed: string, state: CharState, t: number) {
	const L = look(seed);
	ctx.clearRect(0, 0, W, H);
	const px = (x: number, y: number, w: number, h: number, c: string) => {
		ctx.fillStyle = c;
		ctx.fillRect(x, y, w, h);
	};
	const f = Math.floor(t / 160); // animation frame
	const gone = state === 'cancelled';
	const bob = state === 'idle' ? Math.floor(t / 700) % 2 : state === 'done' ? -(f % 4 < 2 ? 2 : 0) : 0;
	const lean = state === 'browsing' || state === 'running' ? 1 : 0;

	// Desk and chair.
	px(1, 24, 30, 2, '#6b4a2f');
	px(2, 26, 2, 6, '#4f3622');
	px(28, 26, 2, 6, '#4f3622');

	if (!gone) {
		const ox = 9 + lean;
		const oy = 4 + bob;
		// Body.
		px(ox, oy + 9, 10, 9, L.shirt);
		px(ox + 3, oy + 9, 4, 2, L.skin); // neck/collar
		// Head.
		px(ox + 1, oy, 8, 9, L.skin);
		// Hair.
		px(ox + 1, oy, 8, 2, L.hair);
		if (L.style === 0) {
			px(ox, oy + 1, 1, 4, L.hair);
			px(ox + 9, oy + 1, 1, 4, L.hair);
		}
		if (L.style === 1) {
			px(ox + 1, oy + 2, 2, 2, L.hair);
			px(ox + 7, oy + 2, 2, 1, L.hair);
		}
		if (L.style === 2) {
			px(ox, oy - 1, 10, 2, L.hair);
			px(ox, oy + 1, 1, 6, L.hair);
			px(ox + 9, oy + 1, 1, 6, L.hair);
		}
		// Eyes: they follow the screen when browsing, blink when idle.
		const blink = state === 'idle' && f % 25 === 0;
		const look = state === 'browsing' ? (f % 8 < 4 ? 0 : 1) : state === 'thinking' ? -1 : 0;
		const eyeY = state === 'thinking' ? oy + 3 : oy + 4;
		if (!blink) {
			px(ox + 2 + look + (look < 0 ? 1 : 0), eyeY, 2, 2, '#ffffff');
			px(ox + 6 + look + (look < 0 ? 1 : 0), eyeY, 2, 2, '#ffffff');
			px(ox + 3 + Math.max(0, look), eyeY + 1, 1, 1, '#1b1b1b');
			px(ox + 7 + Math.max(0, look), eyeY + 1, 1, 1, '#1b1b1b');
		} else {
			px(ox + 2, eyeY + 1, 2, 1, '#1b1b1b');
			px(ox + 6, eyeY + 1, 2, 1, '#1b1b1b');
		}
		if (L.glasses) px(ox + 1, eyeY, 8, 1, '#30303a');
		// Mouth.
		const mouth = state === 'done' ? '#7a2b2b' : state === 'error' || state === 'incomplete' ? '#5a3a3a' : '#9b5c4a';
		if (state === 'done') {
			px(ox + 3, oy + 7, 4, 1, mouth);
			px(ox + 3, oy + 6, 1, 1, mouth);
			px(ox + 6, oy + 6, 1, 1, mouth);
		} else if (state === 'error' || state === 'incomplete') {
			px(ox + 3, oy + 7, 4, 1, mouth);
			px(ox + 3, oy + 8, 1, 1, mouth);
			px(ox + 6, oy + 8, 1, 1, mouth);
		} else px(ox + 4, oy + 7, 2, 1, mouth);

		// Arms.
		if (state === 'blocked') {
			// Raised hand.
			const wave = f % 6 < 3 ? 0 : 1;
			px(ox + 10, oy + 2 + wave, 2, 8, L.shirt);
			px(ox + 10, oy + wave, 2, 2, L.skin);
			px(ox - 1, oy + 12, 2, 6, L.shirt);
		} else if (state === 'done') {
			px(ox - 2, oy + 4, 2, 6, L.shirt);
			px(ox - 2, oy + 2, 2, 2, L.skin);
			px(ox + 10, oy + 4, 2, 6, L.shirt);
			px(ox + 10, oy + 2, 2, 2, L.skin);
		} else if (state === 'incomplete') {
			px(ox - 2, oy + 10, 2, 3, L.shirt);
			px(ox - 3, oy + 9, 2, 2, L.skin);
			px(ox + 10, oy + 10, 2, 3, L.shirt);
			px(ox + 11, oy + 9, 2, 2, L.skin);
		} else {
			const typing = state === 'running' || state === 'writing' || state === 'browsing';
			const fast = state === 'running' ? 2 : 4;
			const lh = typing && f % fast < fast / 2 ? 1 : 0;
			const rh = typing && f % fast >= fast / 2 ? 1 : 0;
			px(ox - 1, oy + 11, 2, 9 - lh, L.shirt);
			px(ox - 1, oy + 20 - lh, 2, 1, L.skin);
			px(ox + 9, oy + 11, 2, 9 - rh, L.shirt);
			px(ox + 9, oy + 20 - rh, 2, 1, L.skin);
		}
	}

	// The laptop: its screen tells what the computer is doing.
	const screen =
		state === 'error'
			? f % 2
				? '#ff5a5a'
				: '#7a1f1f'
			: state === 'done'
				? '#59d98e'
				: state === 'blocked'
					? f % 4 < 2
						? '#ffcf4a'
						: '#8a6a12'
					: state === 'idle' || state === 'cancelled' || state === 'incomplete'
						? '#2a3140'
						: state === 'starting'
							? f % 3 === 0
								? '#2a3140'
								: '#4a78c9'
							: '#5fa8ff';
	px(18, 17, 11, 7, '#22262e');
	px(19, 18, 9, 5, screen);
	if (state === 'browsing') px(19 + (f % 9), 19, 1, 3, '#d9ecff');
	if (state === 'running') px(20, 19 + (f % 3), 6, 1, '#d9ecff');
	px(17, 24, 13, 1, '#3a404c');

	// Writing: a notebook with lines appearing.
	if (state === 'writing') {
		px(2, 20, 7, 4, '#f4f1e6');
		for (let i = 0; i < Math.min(3, (f % 8) / 2); i++) px(3, 21 + i, 5, 1, '#8892a0');
	}
	// Thought bubble.
	if (state === 'thinking' || state === 'starting') {
		px(21, 2, 9, 5, '#ffffff');
		const dots = (f % 4) + 1;
		for (let i = 0; i < Math.min(3, dots); i++) px(23 + i * 2, 4, 1, 1, '#333a48');
		px(20, 7, 2, 1, '#ffffff');
		px(19, 8, 1, 1, '#ffffff');
	}
	// Steer: a "!".
	if (state === 'steered') {
		px(25, 1, 3, 6, '#ffcf4a');
		px(25, 8, 3, 2, '#ffcf4a');
	}
	// Error: smoke from the laptop.
	if (state === 'error') {
		for (let i = 0; i < 3; i++) {
			const y = 14 - ((f + i * 3) % 10);
			px(22 + i * 2 + (f % 2), y, 2, 2, `rgba(160,160,170,${0.25 + 0.2 * i})`);
		}
	}
	// Cancelled: an empty chair with a dust puff.
	if (gone) {
		px(11, 18, 8, 6, '#3d3f48');
		if (f % 10 < 5) px(8, 20, 2, 2, 'rgba(200,200,210,0.5)');
	}
}

export function Character({ seed, state, size = 128 }: { seed: string; state: CharState; size?: number }) {
	const ref = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const ctx = ref.current?.getContext('2d');
		if (!ctx) return;
		let raf = 0;
		const loop = (t: number) => {
			draw(ctx, seed, state, t);
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [seed, state]);
	return (
		<canvas
			ref={ref}
			width={W}
			height={H}
			style={{ width: size, height: size, imageRendering: 'pixelated' }}
			aria-label={STATE_LABEL[state]}
		/>
	);
}
