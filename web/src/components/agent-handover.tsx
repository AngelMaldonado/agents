// Configuración → Avanzado: give the agent to someone else. Copiar makes a new agent for them with its
// configuration and no credentials (its schedules come paused). Transferir hands it over whole — chats,
// files, browser, schedules and the accesses you granted it, which they get as their own copies.
import { useEffect, useState } from 'react';
import { ArrowRightLeft, Copy } from 'lucide-react';
import { api, isLive, type Agent, type Person } from '@/api';
import { OptionSelect } from '@/components/option-select';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type Someone = Pick<Person, 'id' | 'name'>;
type Clash = { kind: 'key' | 'mcp' | 'site'; name: string };
const kinds = { key: 'API Key', mcp: 'MCP', site: 'acceso a sitio' };

export function AgentHandover({ agent, onTransferred }: { agent: Agent; onTransferred: () => void }) {
	const [people, setPeople] = useState<Someone[]>([]);
	const [to, setTo] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [done, setDone] = useState('');
	const [confirming, setConfirming] = useState(false);
	const [confirmation, setConfirmation] = useState('');
	const live = isLive(agent.task);
	useEffect(() => {
		api<{ people: Someone[] }>('/people')
			.then((r) => setPeople(r.people))
			.catch((e) => setError((e as Error).message));
	}, []);
	const others = people.filter((p) => p.id !== agent.person_id);
	const chosen = people.find((p) => String(p.id) === to);
	const run = async (fn: () => Promise<void>) => {
		setBusy(true);
		setError('');
		setDone('');
		try {
			await fn();
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const copy = () =>
		run(async () => {
			const r = await api<{ name: string; schedules: number; to: Someone }>(`/agents/${agent.id}/copy`, {
				body: { to: Number(to) },
			});
			setDone(
				`Listo: ${r.to.name} tiene «${r.name}», sin credenciales${r.schedules ? ` y con ${r.schedules} horario(s) en pausa` : ''}.`,
			);
		});
	const transfer = () =>
		run(async () => {
			const r = await api<{ clashes: Clash[] }>(`/agents/${agent.id}/transfer`, {
				body: { to: Number(to), confirmName: confirmation },
			});
			setConfirming(false);
			// It is no longer yours: a moment to read what happened, then back to the gallery.
			setDone(
				`Transferido a ${chosen?.name}.${r.clashes.length ? ` Ya tenía con el mismo nombre, y se usan los suyos: ${r.clashes.map((c) => `${kinds[c.kind]} ${c.name}`).join(', ')}.` : ''}`,
			);
			setTimeout(onTransferred, r.clashes.length ? 4000 : 1500);
		});
	return (
		<section className="panel mt-6" aria-label="Transferir o copiar">
			<h2>Transferir o copiar</h2>
			<p className="mb-4 mt-2 text-xs text-muted-foreground">
				<b>Copiar</b> le da a otra persona (o a ti) un agente nuevo con el mismo rol, harness, skills y modelo, y sus
				horarios en pausa; sin credenciales, chats, archivos ni navegador. <b>Transferir</b> se lo pasa completo: chats,
				archivos, navegador con sus sesiones, horarios y los accesos que le concediste, que pasan a ser copias suyas.
				Deja de ser tuyo.
			</p>
			<div className="row wrap items-center gap-2">
				<OptionSelect
					label="Para quién"
					placeholder="¿Para quién?"
					value={to}
					onValueChange={setTo}
					className="w-64"
					options={[
						{ id: String(agent.person_id), label: 'Para mí (sólo copiar)' },
						...others.map((p) => ({ id: String(p.id), label: p.name })),
					]}
				/>
				<Button variant="outline" disabled={!to || busy} onClick={() => void copy()}>
					<Copy aria-hidden="true" />
					Copiar
				</Button>
				<Button
					variant="outline"
					disabled={!chosen || chosen.id === agent.person_id || busy || live}
					title={live ? 'Apaga su computadora y espera a que termine su turno' : undefined}
					onClick={() => {
						setConfirmation('');
						setConfirming(true);
					}}
				>
					<ArrowRightLeft aria-hidden="true" />
					Transferir
				</Button>
			</div>
			{done && (
				<p role="status" className="mt-3 text-xs text-success">
					{done}
				</p>
			)}
			{error && (
				<p role="alert" className="error mt-3">
					{error}
				</p>
			)}
			<Dialog open={confirming} onOpenChange={(v) => !busy && setConfirming(v)}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>
							¿Transferir a {agent.name} a {chosen?.name}?
						</DialogTitle>
						<DialogDescription>
							Se lleva sus chats, archivos, su navegador con las sesiones abiertas, sus horarios y copias de las keys,
							MCP y accesos a sitios que le concediste. Tú conservas los tuyos, pero el agente deja de ser tuyo. Para
							confirmar, escribe su nombre exacto.
						</DialogDescription>
					</DialogHeader>
					<form
						className="form"
						onSubmit={(e) => {
							e.preventDefault();
							if (confirmation === agent.name) void transfer();
						}}
					>
						<Input
							aria-label="Nombre del agente para confirmar"
							autoComplete="off"
							spellCheck={false}
							value={confirmation}
							onChange={(e) => setConfirmation(e.target.value)}
							disabled={busy}
						/>
						<DialogFooter className="mt-4">
							<Button type="button" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
								Cancelar
							</Button>
							<Button type="submit" variant="destructive" disabled={busy || confirmation !== agent.name}>
								{busy ? 'Transfiriendo…' : 'Transferir'}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</section>
	);
}
