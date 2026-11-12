// Configuración → General: how the agent behaves (Comportamiento) and what is still experimental (Experimental),
// each option in one row with its explanation behind an «i».
import { useState, type ComponentProps, type ReactNode } from 'react';
import { FlaskConical, Sparkles, Trash2 } from 'lucide-react';
import { ago, api, type Agent } from '@/api';
import { cn } from '@/lib/utils';
import { InfoTip } from '@/WhatsApp';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useConfirm } from '@/components/confirm-dialog';
import { GOAL_MODE_EXPLAIN } from '@/components/goal-mode';
import { PAYMENTS_EXPLAIN, SimulatedCard } from '@/components/simulated-payments';
import { initials, openSimulator, ROLE, SIMULATION_EXPLAIN, useSimChats } from '@/components/whatsapp-simulator';

/** One option: its name and «i», what it is in a line, and its control on the right. */
function Row({ label, info, hint, children }: { label: string; info: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<div className="setting-row">
			<div className="min-w-0">
				<p className="setting-row-label">
					{label}
					<InfoTip label={`Qué es ${label.toLowerCase()}`}>{info}</InfoTip>
				</p>
				{hint && <p className="setting-row-hint">{hint}</p>}
			</div>
			<div className="setting-row-control">{children}</div>
		</div>
	);
}

/** A switch saved on change; `ask` confirms the direction that has consequences. */
function useToggle(agent: Agent, path: string, onChanged: () => void) {
	const [busy, setBusy] = useState(false),
		[error, setError] = useState('');
	const set = async (on: boolean) => {
		setBusy(true);
		setError('');
		try {
			await api(`/agents/${agent.id}/${path}`, { method: 'PUT', body: { on } });
			onChanged();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return { busy, error, set };
}

export function BehaviorSection({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
	const goal = useToggle(agent, 'goal-mode', onChanged);
	const [hours, setHours] = useState(String(agent.inactivity_hours ?? 24));
	const [saving, setSaving] = useState(false),
		[error, setError] = useState('');
	const saveHours = async () => {
		setSaving(true);
		setError('');
		try {
			await api(`/agents/${agent.id}/inactivity`, { method: 'PUT', body: { hours: Number(hours) } });
			onChanged();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	};
	return (
		<section className="panel" aria-label="Comportamiento">
			<h2>Comportamiento</h2>
			<div className="setting-rows">
				<Row label="Modo objetivo" info={GOAL_MODE_EXPLAIN} hint="Trabaja cada trabajo hasta cumplir su objetivo.">
					<Switch
						checked={!!agent.goal_mode}
						disabled={goal.busy}
						onCheckedChange={(on) => void goal.set(on)}
						aria-label="Modo objetivo"
					/>
				</Row>
				<Row
					label="Cerrar trabajos sin actividad"
					info="Un trabajo se cierra tras estas horas sin actividad. No cuenta el tiempo esperando a un encargo o a una lista de tareas. Lo siguiente que le pidas empieza un trabajo nuevo, y otro agente evalúa el que cerró."
					hint="Horas sin actividad."
				>
					<Input
						type="number"
						min={1}
						max={720}
						value={hours}
						onChange={(e) => setHours(e.target.value)}
						className="w-20"
						aria-label="Horas sin actividad para cerrar un trabajo"
					/>
					<Button
						size="sm"
						variant="outline"
						disabled={saving || Number(hours) === (agent.inactivity_hours ?? 24)}
						onClick={() => void saveHours()}
					>
						Guardar
					</Button>
				</Row>
			</div>
			{(goal.error || error) && (
				<p role="alert" className="error">
					{goal.error || error}
				</p>
			)}
		</section>
	);
}

/** Experimental's switches wear its warning theme too. */
function WarnSwitch(props: ComponentProps<typeof Switch>) {
	return <Switch {...props} className="data-[state=checked]:bg-warning" />;
}

export function ExperimentalSection({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
	const payments = useToggle(agent, 'simulated-payments', onChanged);
	const chats = useToggle(agent, 'simulated-conversations', onChanged);
	const [ask, confirmDialog] = useConfirm();
	const simulating = !!agent.simulated_conversations;
	const sim = useSimChats(agent.id, simulating);
	const [error, setError] = useState('');
	const auto = async (chat: string, on: boolean) => {
		setError('');
		try {
			await api(`/agents/${agent.id}/sim/${encodeURIComponent(chat)}/actor`, { method: 'PUT', body: { auto: on } });
			sim.reload();
		} catch (e) {
			setError((e as Error).message);
		}
	};
	const clear = async () => {
		if (
			!(await ask({
				title: '¿Limpiar el simulador?',
				description: 'Se borran los mensajes de sus chats simulados. Sus conversaciones y encargos se quedan.',
				action: 'Limpiar',
				destructive: true,
			}))
		)
			return;
		await api(`/agents/${agent.id}/sim`, { method: 'DELETE' }).catch((e) => setError((e as Error).message));
		sim.reload();
	};
	const off = (title: string, description: string) => ask({ title, description, action: 'Apagar', destructive: true });
	const failure = payments.error || chats.error || error || sim.error;
	return (
		<section className="panel is-experimental" aria-label="Experimental">
			{confirmDialog}
			<h2 className="flex items-center gap-2">
				<FlaskConical className="size-4 text-warning-on-soft" aria-hidden="true" />
				Experimental
				<Badge variant="warning">Para probar</Badge>
			</h2>
			<div className="setting-rows">
				<Row
					label="Pagos simulados"
					info={PAYMENTS_EXPLAIN}
					hint="Ningún pago llega a la tienda; el agente lo ve como hecho."
				>
					<WarnSwitch
						checked={!!agent.simulated_payments}
						disabled={payments.busy}
						onCheckedChange={async (on) => {
							if (
								!on &&
								!(await off(
									'¿Apagar los pagos simulados?',
									'Desde el siguiente turno, los pagos de este agente serán reales.',
								))
							)
								return;
							void payments.set(on);
						}}
						aria-label="Pagos simulados"
					/>
				</Row>
				{agent.simulated_payments && (
					<div className="setting-sub">
						<SimulatedCard agentId={agent.id} />
					</div>
				)}
				<Row
					label="Conversaciones simuladas"
					info={SIMULATION_EXPLAIN}
					hint="Escribes tú (o la IA) como sus contactos; a ti sí te llega lo tuyo."
				>
					<WarnSwitch
						checked={simulating}
						disabled={chats.busy}
						onCheckedChange={async (on) => {
							if (
								!on &&
								!(await off(
									'¿Apagar las conversaciones simuladas?',
									'Desde ahora, lo que diga este agente por WhatsApp sí les llega a las personas.',
								))
							)
								return;
							void chats.set(on);
						}}
						aria-label="Conversaciones simuladas"
					/>
				</Row>
				{simulating && (
					<div className="setting-sub">
						<div className="flex min-w-0 items-center justify-between gap-2">
							<p className="setting-row-label">
								Sus contactos simulados
								<InfoTip label="Cómo se usan sus contactos simulados">
									Abre un contacto para escribir como esa persona: le llega al agente como si lo mandara por WhatsApp.
									Con «La IA responde», GPT contesta por ese contacto cada vez que el agente le escribe, mientras dure
									el trabajo; su personaje (quién es, qué sabe) se edita dentro de su chat.
								</InfoTip>
							</p>
							<Button variant="danger-ghost" size="sm" onClick={() => void clear()}>
								<Trash2 aria-hidden="true" />
								Limpiar
							</Button>
						</div>
						{!sim.chats ? (
							<p role="status" className="muted small">
								Cargando sus contactos…
							</p>
						) : !sim.chats.length ? (
							<p className="muted small">No tiene contactos encendidos en Canales → Quién le escribe por WhatsApp.</p>
						) : (
							<ul className="sim-tiles" aria-label="Contactos simulados">
								{sim.chats.map((c) => (
									<li key={c.chat} className={cn('sim-tile', (c.actor ? c.actor.auto : true) && 'is-ai')}>
										<button
											type="button"
											className="sim-tile-open"
											onClick={() => openSimulator(agent.id, c.chat)}
											aria-label={`Abrir el chat simulado con ${c.name}`}
										>
											<span className="encargo-avatar" aria-hidden="true">
												{initials(c.name)}
											</span>
											<span className="min-w-0 flex-1">
												<span className="sim-tile-name">
													{c.name}
													<span className="sim-tile-role">{ROLE[c.role]}</span>
												</span>
												<span className="sim-tile-last">
													{c.last
														? `${c.last.direction === 'in' ? (c.last.actor ? 'IA' : 'Tú') : c.last.author}: ${c.last.text}`
														: 'Sin mensajes todavía'}
												</span>
											</span>
											{c.last && <span className="sim-tile-when">{ago(c.last.created_at)}</span>}
										</button>
										<label className="sim-tile-ai" title="La IA responde como este contacto">
											<Sparkles aria-hidden="true" />
											<span className="sr-only">La IA responde</span>
											<span aria-hidden="true">IA</span>
											<WarnSwitch
												checked={c.actor ? c.actor.auto : true}
												onCheckedChange={(on) => void auto(c.chat, on)}
												aria-label={`La IA responde como ${c.name}`}
											/>
										</label>
									</li>
								))}
							</ul>
						)}
					</div>
				)}
			</div>
			{failure && (
				<p role="alert" className="error">
					{failure}
				</p>
			)}
		</section>
	);
}
