// The mini browser: the agent's live viewport, read-only. There are no handlers here on purpose:
// nothing the human does reaches the agent's browser.
import { useFrame } from './live';

export function Browser({ agentId, live, compact = false }: { agentId: number; live: boolean; compact?: boolean }) {
	const frame = useFrame(agentId);
	const url = frame?.meta?.url ?? '';
	const stale = frame && Date.now() - frame.at > 30_000;
	return (
		<div className={`browser ${compact ? 'compact' : ''}`}>
			<div className="browser-bar">
				<span className="dots">
					<i />
					<i />
					<i />
				</span>
				<span className="url" title={url}>{url ? url.replace(/^https?:\/\//, '') : live ? 'abriendo…' : 'sin navegador'}</span>
				{live && <span className={`rec ${stale ? 'idle' : ''}`}>● EN VIVO</span>}
			</div>
			<div className="browser-view">
				{frame && live ? (
					<img src={`data:image/jpeg;base64,${frame.jpeg}`} alt="Pantalla del agente" draggable={false} />
				) : frame ? (
					<>
						<img className="ended" src={`data:image/jpeg;base64,${frame.jpeg}`} alt="Última pantalla" draggable={false} />
						<span className="ended-note">Última imagen · la computadora ya se apagó</span>
					</>
				) : (
					<div className="no-signal">{live ? 'Esperando la primera imagen…' : 'El navegador se apaga entre tareas'}</div>
				)}
			</div>
		</div>
	);
}
