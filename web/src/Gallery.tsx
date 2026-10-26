import { useState } from 'react';
import { api, isLive, ago, type Agent, type Person, type PublicSettings } from './api';
import { Character, STATE_LABEL, type CharState } from './Character';
import { Browser } from './Browser';
import { useTick } from './live';

export function stateOf(a: Agent): CharState {
	if (!a.task) return 'idle';
	if (a.task.status === 'queued') return 'idle';
	return a.task.state;
}

export function Gallery({ agents, me, settings, onOpen, onChanged }: {
	agents: Agent[]; me: Person; settings: PublicSettings; onOpen: (id: number) => void; onChanged: () => void;
}) {
	useTick(5000);
	const [creating, setCreating] = useState(false);
	const mine = agents.filter((a) => a.person_id === me.id);
	const others = agents.filter((a) => a.person_id !== me.id);
	const running = agents.filter((a) => isLive(a.task) && a.task!.status !== 'queued').length;
	return (
		<div className="page">
			<div className="page-head">
				<div>
					<h1>Tus agentes</h1>
					<p className="muted">{running} trabajando ahora · hasta {settings.maxConcurrent} a la vez</p>
				</div>
				<button className="primary" onClick={() => setCreating(true)}>+ Nuevo agente</button>
			</div>
			{creating && <NewAgent settings={settings} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); onChanged(); onOpen(id); }} />}
			{!mine.length && !creating && (
				<div className="empty">
					<p>Aún no tienes agentes. Crea uno, dale un rol (p. ej. «investiga proveedores y resume lo que encuentres») y escríbele una tarea.</p>
				</div>
			)}
			<div className="grid">{mine.map((a) => <Card key={a.id} agent={a} onOpen={onOpen} />)}</div>
			{others.length > 0 && (
				<>
					<h2 className="section">De otras personas <span className="muted">(admin)</span></h2>
					<div className="grid">{others.map((a) => <Card key={a.id} agent={a} onOpen={onOpen} showOwner />)}</div>
				</>
			)}
		</div>
	);
}

function Card({ agent, onOpen, showOwner }: { agent: Agent; onOpen: (id: number) => void; showOwner?: boolean }) {
	const state = stateOf(agent);
	const t = agent.task;
	const live = isLive(t) && t!.status !== 'queued';
	return (
		<button className={`card state-${state}`} onClick={() => onOpen(agent.id)}>
			<div className="card-top">
				<Character seed={agent.seed} state={state} size={88} />
				<div className="card-id">
					<div className="name">{agent.name}</div>
					{showOwner && <div className="muted small">de {agent.owner}</div>}
					<div className={`pill s-${state}`}>{t?.status === 'queued' ? 'En cola' : STATE_LABEL[state]}</div>
					<div className="muted small">{agent.model.split('/')[1]}</div>
				</div>
			</div>
			<Browser agentId={agent.id} live={live} compact />
			<div className="card-foot">
				{t ? (
					<>
						<span className="prompt" title={t.prompt}>{t.prompt}</span>
						<span className="muted small">{ago(t.created_at)}</span>
					</>
				) : (
					<span className="muted">{agent.role || 'Sin tareas todavía'}</span>
				)}
			</div>
		</button>
	);
}

function NewAgent({ settings, onClose, onCreated }: { settings: PublicSettings; onClose: () => void; onCreated: (id: number) => void }) {
	const [name, setName] = useState('');
	const [role, setRole] = useState('');
	const [model, setModel] = useState(settings.models[0]?.id ?? '');
	const [error, setError] = useState('');
	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			const { agent } = await api('/agents', { body: { name, role, model } });
			onCreated(agent.id);
		} catch (err) {
			setError((err as Error).message);
		}
	};
	return (
		<form className="panel form" onSubmit={submit}>
			<h3>Nuevo agente</h3>
			<label>Nombre<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ana" autoFocus maxLength={40} /></label>
			<label>Rol e instrucciones<textarea value={role} onChange={(e) => setRole(e.target.value)} rows={3} placeholder="Compras de electrónica y componentes. Prefiere distribuidores autorizados en México." /></label>
			<label>Modelo
				<select value={model} onChange={(e) => setModel(e.target.value)}>
					{settings.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
				</select>
			</label>
			{error && <p className="error">{error}</p>}
			<div className="row">
				<button type="button" onClick={onClose}>Cancelar</button>
				<button className="primary" disabled={!name.trim()}>Crear</button>
			</div>
		</form>
	);
}
