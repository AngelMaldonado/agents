// The owner's own hands on the agent's computer (#27): a real terminal (xterm.js on a pseudo-terminal
// there) and its whole desktop (noVNC on the display Chrome uses). Both go through the backend, only
// for the agent's owner and only while the computer is on (a task or a browser session).
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Button } from '@/components/ui/button';

const wsUrl = (path: string) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api${path}`;
const reasons: Record<number, string> = {
	4403: 'Sólo el dueño del agente puede abrir su terminal.',
	4409: 'La computadora del agente está apagada. Abre una sesión o espera a que trabaje.',
};

/** A login shell on the agent's computer, with the agent's own environment (minus its LLM token). */
export function LiveTerminal({
	agentId,
	onClose,
	fill = false,
}: {
	agentId: number;
	onClose: () => void;
	fill?: boolean;
}) {
	const box = useRef<HTMLDivElement>(null);
	const [ended, setEnded] = useState('');
	useEffect(() => {
		const term = new XTerm({
			cursorBlink: true,
			fontSize: 13,
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
			theme: { background: '#0b0d10' },
			scrollback: 5000,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(box.current!);
		fit.fit();
		const ws = new WebSocket(wsUrl(`/agents/${agentId}/terminal`));
		ws.binaryType = 'arraybuffer';
		const tell = (m: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
		const size = () => tell({ t: 'size', cols: term.cols, rows: term.rows });
		ws.onopen = () => {
			size();
			term.focus();
		};
		ws.onmessage = (e) => term.write(new Uint8Array(e.data as ArrayBuffer));
		ws.onclose = (e) => setEnded(reasons[e.code] ?? 'La terminal se cerró.');
		const typed = term.onData((d) => tell({ t: 'in', d }));
		const observer = new ResizeObserver(() => {
			fit.fit();
			size();
		});
		observer.observe(box.current!);
		return () => {
			observer.disconnect();
			typed.dispose();
			ws.onclose = null; // its own closing is not «the terminal closed»
			ws.close();
			term.dispose();
		};
	}, [agentId]);
	return (
		<div className={fill ? 'flex min-h-0 flex-1 flex-col gap-2' : 'grid gap-2'}>
			<div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
				<span>
					Tu terminal en la computadora del agente. Lo que instales con <code>npm -g</code>, <code>uv tool</code> o{' '}
					<code>pip --user</code> se queda para sus siguientes tareas; <code>agents-mcp add</code> pide agregar un
					servidor MCP; <code>pi</code> abre a tu agente aquí (sin tarea).
				</span>
				<Button size="sm" variant="outline" onClick={onClose}>
					<X aria-hidden="true" />
					Cerrar terminal
				</Button>
			</div>
			<div
				ref={box}
				className={`${fill ? 'min-h-[320px] flex-1' : 'h-[420px]'} min-w-0 overflow-hidden rounded-lg border bg-[#0b0d10] p-2`}
				role="application"
				aria-label="Terminal interactiva del agente"
			/>
			{ended && (
				<p role="status" className="text-xs text-muted-foreground">
					{ended}
				</p>
			)}
		</div>
	);
}

/** The agent computer's whole screen, which the owner can also drive (noVNC). */
export function Desktop({ agentId, fill = false }: { agentId: number; fill?: boolean }) {
	const box = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<'connecting' | 'on' | string>('connecting');
	useEffect(() => {
		let rfb: import('@novnc/novnc/lib/rfb').default | null = null;
		let gone = false;
		void import('@novnc/novnc/lib/rfb').then(({ default: RFB }) => {
			if (gone || !box.current) return;
			const r = new RFB(box.current, wsUrl(`/agents/${agentId}/desktop`));
			r.scaleViewport = true;
			r.resizeSession = false;
			r.addEventListener('connect', () => setState('on'));
			r.addEventListener('disconnect', () => !gone && setState('El escritorio se desconectó.'));
			rfb = r;
		});
		return () => {
			gone = true;
			rfb?.disconnect();
		};
	}, [agentId]);
	return (
		<div className={fill ? 'flex min-h-0 flex-1 flex-col gap-2' : 'grid min-h-0 gap-2'}>
			<div
				ref={box}
				className={`${fill ? 'min-h-[320px] flex-1' : 'h-[min(70vh,720px)]'} min-w-0 overflow-hidden rounded-lg border bg-black`}
				role="application"
				aria-label="Escritorio de la computadora del agente"
			/>
			{state !== 'on' && (
				<p role="status" className="text-xs text-muted-foreground">
					{state === 'connecting' ? 'Conectando al escritorio…' : state}
				</p>
			)}
		</div>
	);
}
