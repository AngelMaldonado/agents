import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, ago, isLive, isWorking, type Agent, type Artifact, type Conversation, type Person, type PublicSettings, type Task, type TaskEvent } from './api';
import { Character, STATE_LABEL } from './Character';
import { Browser } from './Browser';
import { onEvent, onTask, useTick } from './live';
import { stateOf } from './Gallery';

type Tab = 'activity' | 'terminal' | 'answer' | 'history';

export function AgentView({ agent, me, settings, onBack, onChanged }: {
	agent: Agent; me: Person; settings: PublicSettings; onBack: () => void; onChanged: () => void;
}) {
	useTick(1000);
	const mine = agent.person_id === me.id;
	const [history, setHistory] = useState<Task[]>([]);
	const [taskId, setTaskId] = useState<number | null>(agent.task?.id ?? null);
	const [task, setTask] = useState<Task | null>(agent.task);
	const [events, setEvents] = useState<TaskEvent[]>([]);
	const [files, setFiles] = useState<Artifact[]>([]);
	const [tab, setTab] = useState<Tab>('activity');
	const [editing, setEditing] = useState(false);

	const [conversations, setConversations] = useState<Conversation[]>([]);
	const [profileReset, setProfileReset] = useState(false);
	const loadHistory = () => {
		void api(`/agents/${agent.id}/conversations`).then((r) => {
			setConversations(r.conversations);
			setProfileReset(r.profileResetPending);
		});
		return api(`/agents/${agent.id}/tasks`).then((r) => setHistory(r.tasks));
	};
	useEffect(() => {
		void loadHistory();
	}, [agent.id]);

	// Follow the agent's newest task unless a past one was picked.
	useEffect(() => {
		if (agent.task && (taskId === null || isLive(agent.task))) setTaskId(agent.task.id);
	}, [agent.task?.id]);

	useEffect(() => {
		if (!taskId) return;
		let alive = true;
		api(`/tasks/${taskId}`).then((r) => {
			if (!alive) return;
			setTask(r.task);
			setEvents(r.events);
			setFiles(r.artifacts);
			if (r.task.answer) setTab((t) => (t === 'activity' && !isLive(r.task) ? 'answer' : t));
		});
		const offE = onEvent((id, e) => id === taskId && setEvents((es) => (es.some((x) => x.id === e.id) ? es : [...es, e])));
		const offT = onTask((t) => {
			if (t.id !== taskId) return;
			setTask(t);
			if (!isLive(t)) {
				api(`/tasks/${taskId}`).then((r) => setFiles(r.artifacts));
				void loadHistory();
				if (t.answer) setTab('answer');
			}
		});
		return () => {
			alive = false;
			offE();
			offT();
		};
	}, [taskId]);

	const live = isLive(task) && task!.status !== 'queued';
	const state = task && task.id === agent.task?.id ? stateOf({ ...agent, task }) : 'idle';
	const elapsed = task?.started_at ? Math.round(((task.ended_at ?? Date.now()) - task.started_at) / 1000) : 0;

	return (
		<div className="page agent-view">
			<div className="agent-head">
				<button className="ghost" onClick={onBack}>← Galería</button>
				<Character seed={agent.seed} state={state} size={112} />
				<div className="agent-id">
					<h1>{agent.name}</h1>
					<div className="muted">{agent.role || 'Sin rol'}</div>
					<div className="muted small">
						{settings.models.find((m) => m.id === agent.model)?.label ?? agent.model}
						{!mine && ` · de ${agent.owner}`}
					</div>
					<div className={`pill s-${state}`}>{task?.status === 'queued' ? 'En cola' : STATE_LABEL[state]}</div>
				</div>
				{mine && (
					<div className="agent-actions">
						<button className="ghost" onClick={() => setEditing((v) => !v)}>Editar</button>
						<button className="ghost" title="Archiva esta conversación: la siguiente tarea empieza sin memoria de las anteriores (~/work se conserva)" onClick={async () => {
							if (!confirm('¿Empezar una conversación nueva? La actual queda archivada en el historial.')) return;
							setConversations((await api(`/agents/${agent.id}/conversations`, { method: 'POST' })).conversations);
						}}>Conversación nueva</button>
						<button className="ghost danger" disabled={profileReset} title="Cookies, sesiones iniciadas y almacenamiento de todos los sitios" onClick={async () => {
							if (!confirm('¿Borrar el perfil del navegador? Se pierden las sesiones iniciadas; se aplica al empezar su siguiente tarea.')) return;
							setProfileReset((await api(`/agents/${agent.id}/profile/reset`, { method: 'POST' })).profileResetPending);
						}}>{profileReset ? 'Perfil: se borra en la siguiente tarea' : 'Borrar perfil del navegador'}</button>
					</div>
				)}
			</div>
			{editing && <EditAgent agent={agent} settings={settings} onDone={() => { setEditing(false); onChanged(); }} onDeleted={() => { onChanged(); onBack(); }} />}

			<div className="agent-main">
				<Browser agentId={agent.id} live={live} />
				<aside className="control">
					{task && (
						<div className="task-meta">
							<div className="muted small">Tarea #{task.id} · {ago(task.created_at)}</div>
							<div className="task-prompt">{task.prompt}</div>
							<div className="stats">
								<span>⏱ {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
								<span>US${task.cost.toFixed(3)}</span>
								<span>{(task.tokens / 1000).toFixed(1)}k tokens</span>
							</div>
							{task.end_reason && <div className="muted small">{task.end_reason}</div>}
						</div>
					)}
					{task && isLive(task) ? (
						<Steer task={task} canSteer={mine} canCancel={mine || me.admin} />
					) : mine ? (
						<NewTask agentId={agent.id} onStarted={(t) => { setTaskId(t.id); setTask(t); setEvents([]); setFiles([]); setTab('activity'); onChanged(); }} />
					) : (
						<p className="muted">Sólo {agent.owner} puede darle tareas.</p>
					)}
				</aside>
			</div>

			<div className="tabs">
				{(['activity', 'terminal', 'answer', 'history'] as Tab[]).map((t) => (
					<button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
						{{ activity: 'Actividad', terminal: 'Terminal', answer: 'Respuesta', history: `Historial (${history.length})` }[t]}
					</button>
				))}
			</div>
			{tab === 'activity' && <Activity events={events} />}
			{tab === 'terminal' && <Terminal events={events} />}
			{tab === 'answer' && <Answer task={task} files={files} />}
			{tab === 'history' && (
				<div className="history">
					{conversations.map((c) => {
						const runs = history.filter((t) => t.conversation_id === c.id);
						return (
							<div key={c.id} className="conversation">
								<div className="muted small">
									{c.archived_at ? `Conversación archivada · ${ago(c.started_at)} → ${ago(c.archived_at)}` : `Conversación actual · desde ${ago(c.started_at)}`} · {c.runs} {c.runs === 1 ? 'tarea' : 'tareas'}
								</div>
								{runs.map((t) => (
									<button key={t.id} className={`history-row ${t.id === taskId ? 'on' : ''}`} onClick={() => { setTaskId(t.id); setTab(t.answer ? 'answer' : 'activity'); }}>
										<span className={`pill s-${isWorking(t) ? t.state : t.status}`}>{t.status}</span>
										<span className="prompt">{t.prompt}</span>
										<span className="muted small">{ago(t.created_at)} · US${t.cost.toFixed(2)}</span>
									</button>
								))}
							</div>
						);
					})}
					{!history.length && <p className="muted">Sin tareas.</p>}
				</div>
			)}
		</div>
	);
}

function NewTask({ agentId, onStarted }: { agentId: number; onStarted: (t: Task) => void }) {
	const [prompt, setPrompt] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	return (
		<form
			className="form"
			onSubmit={async (e) => {
				e.preventDefault();
				setBusy(true);
				setError('');
				try {
					const { task } = await api(`/agents/${agentId}/tasks`, { body: { prompt } });
					setPrompt('');
					onStarted(task);
				} catch (err) {
					setError((err as Error).message);
				} finally {
					setBusy(false);
				}
			}}
		>
			<label>Nueva tarea
				<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} placeholder="Qué quieres que haga. Sigue la conversación anterior: puedes referirte a lo que ya hizo." />
			</label>
			{error && <p className="error">{error}</p>}
			<button className="primary" disabled={busy || !prompt.trim()}>Empezar</button>
		</form>
	);
}

function Steer({ task, canSteer, canCancel }: { task: Task; canSteer: boolean; canCancel: boolean }) {
	const [text, setText] = useState('');
	const [error, setError] = useState('');
	const send = async (kind: 'steer' | 'follow_up') => {
		setError('');
		try {
			await api(`/tasks/${task.id}/steer`, { body: { text, kind } });
			setText('');
		} catch (err) {
			setError((err as Error).message);
		}
	};
	return (
		<div className="form">
			{task.state === 'blocked' && <div className="callout">✋ Está atascado y espera tu respuesta.</div>}
			{canSteer && isWorking(task) && (
				<>
					<label>Dirigir al agente
						<textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Ignora Amazon, busca sólo en distribuidores autorizados." />
					</label>
					<div className="row">
						<button className="primary" disabled={!text.trim()} onClick={() => send('steer')} title="Lo lee al terminar el paso actual">Steer ahora</button>
						<button disabled={!text.trim()} onClick={() => send('follow_up')} title="Lo lee cuando termine lo que está haciendo">Al terminar</button>
					</div>
				</>
			)}
			{!isWorking(task) && <p className="muted">{task.status === 'queued' ? 'En cola: empieza cuando haya lugar.' : 'Prendiendo la computadora…'}</p>}
			{canCancel && (
				<button className="danger" onClick={() => confirm('¿Cancelar la tarea? Se guarda lo que lleve.') && api(`/tasks/${task.id}/cancel`, { method: 'POST' }).catch((e) => setError(e.message))}>
					Cancelar tarea
				</button>
			)}
			{error && <p className="error">{error}</p>}
		</div>
	);
}

function useAutoScroll(dep: unknown) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
	}, [dep]);
	return ref;
}

function Activity({ events }: { events: TaskEvent[] }) {
	const shown = events.filter((e) => e.kind !== 'tool_end' && !(e.kind === 'system' && e.data?.stderr));
	const ref = useAutoScroll(shown.length);
	return (
		<div className="log" ref={ref}>
			{shown.map((e) => (
				<div key={e.id} className={`ev ev-${e.kind}`}>
					<span className="t">{new Date(e.at).toLocaleTimeString('es-MX')}</span>
					<EventBody e={e} />
				</div>
			))}
			{!shown.length && <p className="muted">Nada todavía.</p>}
		</div>
	);
}

function EventBody({ e }: { e: TaskEvent }) {
	switch (e.kind) {
		case 'text':
			return <span className="say">{e.data.text}</span>;
		case 'tool':
			return <span className="tool"><b>{e.data.name === 'bash' && /agent-browser/.test(e.data.summary) ? '🌐' : e.data.name === 'bash' ? '$' : '✎'}</b> {e.data.summary}</span>;
		case 'steer':
			return <span className="human">🧭 Steer: {e.data.text}</span>;
		case 'follow_up':
			return <span className="human">➕ Al terminar: {e.data.text}</span>;
		case 'blocked':
			return <span className="blocked">✋ Atascado: {e.data.reason}</span>;
		case 'credential':
			return <span className={e.data.ok ? 'tool' : 'error'}>🔑 {e.data.ok ? `Usó el acceso «${e.data.name}»` : `Pidió «${e.data.name}»: ${e.data.error}`}</span>;
		case 'status':
			return <span className="status">— {e.data.status}{e.data.reason ? `: ${e.data.reason}` : ''}</span>;
		case 'error':
			return <span className="error">⚠ {e.data.message}</span>;
		default:
			return <span className="muted">{e.data.message ?? JSON.stringify(e.data)}</span>;
	}
}

function Terminal({ events }: { events: TaskEvent[] }) {
	const lines = useMemo(() => events.filter((e) => (e.kind === 'tool' || e.kind === 'tool_end')), [events]);
	const ref = useAutoScroll(lines.length);
	return (
		<div className="terminal" ref={ref}>
			{lines.map((e) =>
				e.kind === 'tool' ? (
					<div key={e.id} className="cmd">
						<span className="prompt-sign">{e.data.name === 'bash' ? 'agent@agents:~/work$' : `[${e.data.name}]`}</span> {e.data.summary}
					</div>
				) : (
					<pre key={e.id} className={e.data.isError ? 'out err' : 'out'}>{e.data.output || ' '}</pre>
				)
			)}
			{!lines.length && <span className="muted">La terminal es del agente: aquí sólo se ve lo que ejecuta.</span>}
		</div>
	);
}

/** The answer: the agent's last message, as markdown (no raw HTML), and the files it left in ~/work/out. */
function Answer({ task, files }: { task: Task | null; files: Artifact[] }) {
	if (!task) return <p className="muted pad">Sin tarea.</p>;
	const imgs = files.filter((f) => f.mime.startsWith('image/'));
	return (
		<div className="result">
			{task.answer ? (
				<div className="markdown">
					<Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ node, ...p }) => <a {...p} target="_blank" rel="noreferrer noopener" /> }}>{task.answer}</Markdown>
				</div>
			) : (
				<p className="muted">{isLive(task) ? 'Todavía trabajando: la respuesta aparece cuando el agente escribe.' : 'Esta tarea terminó sin respuesta.'}</p>
			)}
			{files.length > 0 && (
				<>
					<h3>Archivos</h3>
					<ul className="files">
						{files.map((f) => (
							<li key={f.id}><a href={`/api/tasks/${task.id}/files/${f.name}`} target="_blank" rel="noreferrer">{f.name}</a> <span className="muted small">{(f.size / 1024).toFixed(1)} KB</span></li>
						))}
					</ul>
				</>
			)}
			{imgs.length > 0 && <Shots task={task} imgs={imgs} />}
		</div>
	);
}

function Shots({ task, imgs }: { task: Task; imgs: Artifact[] }) {
	return (
		<div className="shots">
			{imgs.map((f) => (
				<a key={f.id} href={`/api/tasks/${task.id}/files/${f.name}`} target="_blank" rel="noreferrer"><img src={`/api/tasks/${task.id}/files/${f.name}`} alt={f.name} /></a>
			))}
		</div>
	);
}

function EditAgent({ agent, settings, onDone, onDeleted }: { agent: Agent; settings: PublicSettings; onDone: () => void; onDeleted: () => void }) {
	const [name, setName] = useState(agent.name);
	const [role, setRole] = useState(agent.role);
	const [model, setModel] = useState(agent.model);
	const [error, setError] = useState('');
	return (
		<form className="panel form" onSubmit={async (e) => {
			e.preventDefault();
			try {
				await api(`/agents/${agent.id}`, { method: 'PATCH', body: { name, role, model } });
				onDone();
			} catch (err) {
				setError((err as Error).message);
			}
		}}>
			<label>Nombre<input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} /></label>
			<label>Rol e instrucciones<textarea value={role} onChange={(e) => setRole(e.target.value)} rows={3} /></label>
			<label>Modelo
				<select value={model} onChange={(e) => setModel(e.target.value)}>
					{settings.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
				</select>
			</label>
			{error && <p className="error">{error}</p>}
			<div className="row">
				<button type="button" className="danger" onClick={async () => { if (confirm(`¿Retirar a ${agent.name}?`)) { await api(`/agents/${agent.id}`, { method: 'DELETE' }); onDeleted(); } }}>Retirar agente</button>
				<span className="spacer" />
				<button type="button" onClick={onDone}>Cerrar</button>
				<button className="primary">Guardar</button>
			</div>
		</form>
	);
}
