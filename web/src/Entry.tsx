// The only login: a name. Coming back from another browser takes an admin's one-time link.
import { useEffect, useState } from 'react';
import { api } from './api';
import { Character } from './Character';

export function Entry({ onIn }: { onIn: () => void }) {
	const [name, setName] = useState('');
	const [error, setError] = useState('');
	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			await api('/join', { body: { name } });
			onIn();
		} catch (err) {
			setError((err as Error).message);
		}
	};
	return (
		<div className="entry">
			<div className="entry-chars">
				<Character seed="ana" state="browsing" size={96} />
				<Character seed="beto" state="thinking" size={96} />
				<Character seed="caro" state="done" size={96} />
			</div>
			<h1>Agents</h1>
			<p className="muted">Agentes con su propia computadora: les escribes, trabajan y te responden. Míralos trabajar en vivo.</p>
			<form onSubmit={submit} className="entry-form">
				<input value={name} onChange={(e) => setName(e.target.value)} placeholder="¿Cómo te llamas?" autoFocus maxLength={40} />
				<button className="primary" disabled={!name.trim()}>Entrar</button>
			</form>
			{error && <p className="error">{error}</p>}
		</div>
	);
}

export function Invite({ code, onIn }: { code: string; onIn: () => void }) {
	const [who, setWho] = useState<{ id: number; name: string } | null | undefined>(undefined);
	const [error, setError] = useState('');
	useEffect(() => {
		api(`/invite/${code}`).then((r) => setWho(r.person)).catch(() => setWho(null));
	}, [code]);
	if (who === undefined) return <div className="entry"><p className="muted">Revisando el link…</p></div>;
	if (!who) return <div className="entry"><h1>Link vencido</h1><p className="muted">Pídele a un admin uno nuevo.</p></div>;
	return (
		<div className="entry">
			<h1>Hola, {who.name}</h1>
			<p className="muted">Este link te deja entrar como {who.name} en este navegador. Sirve una sola vez.</p>
			<button
				className="primary"
				onClick={async () => {
					try {
						await api(`/invite/${code}`, { method: 'POST' });
						location.hash = '';
						onIn();
					} catch (err) {
						setError((err as Error).message);
					}
				}}
			>
				Entrar como {who.name}
			</button>
			{error && <p className="error">{error}</p>}
		</div>
	);
}
