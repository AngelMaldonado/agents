// Pagos simulados (Angel 6-nov-2026): its owner's switch (Configuración → General → Experimental) to test flows
// that pay. While on, every payment of the agent is simulated in its browser and it believes it paid (it sees the
// store's confirmation); people it talks to are not told either. Only the run's activity and the list's history
// say what was simulated.
import { useEffect, useState } from 'react';
import { CreditCard, Pencil } from 'lucide-react';
import { api } from '@/api';
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
import { Label } from '@/components/ui/label';
import { OptionSelect } from '@/components/option-select';

export const PAYMENTS_EXPLAIN =
	'Mientras está encendido, ningún pago de este agente llega a la tienda: el clic de pagar se intercepta y Chrome bloquea las peticiones que cobran o crean el pedido. El agente ve una confirmación como si hubiera pagado y sigue su flujo con normalidad; tampoco se les dice a las personas con quienes habla. Lo simulado queda en la actividad de cada turno y en las tareas del trabajo.';

// Tarjeta simulada (Angel 11-nov-2026): the card its simulated payments use. The store's payment page shows it
// as saved, and where a site asks to type a card the agent fills it through the platform (never seeing it).

type Card = { brand: 'visa' | 'mastercard' | 'amex'; last4: string; exp: string; holder: string };
const BRANDS = [
	{ id: 'visa', label: 'Visa' },
	{ id: 'mastercard', label: 'Mastercard' },
	{ id: 'amex', label: 'American Express' },
] as const;
const brandLabel = (b: Card['brand']) => BRANDS.find((x) => x.id === b)?.label ?? b;
export const CARD_EXPLAIN =
	'La tarjeta con que paga mientras los pagos son simulados. La página de pago de la tienda la muestra como guardada y, si un sitio pide capturar una tarjeta, el agente la llena por medio de la plataforma, sin ver sus datos. Su número es uno de prueba hecho con estos dígitos: nunca guardes aquí una tarjeta real.';

export function SimulatedCard({ agentId }: { agentId: number }) {
	const [card, setCard] = useState<Card | null>(null);
	const [draft, setDraft] = useState<Card | null>(null);
	const [error, setError] = useState(''),
		[busy, setBusy] = useState(false);
	useEffect(() => {
		let gone = false;
		api<{ card: Card }>(`/agents/${agentId}/simulated-card`)
			.then((r) => !gone && setCard(r.card))
			.catch((e) => !gone && setError((e as Error).message));
		return () => {
			gone = true;
		};
	}, [agentId]);
	const save = async () => {
		if (!draft) return;
		setBusy(true);
		setError('');
		try {
			const r = await api<{ card: Card }>(`/agents/${agentId}/simulated-card`, { method: 'PUT', body: draft });
			setCard(r.card);
			setDraft(null);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="sim-card">
			<CreditCard className="sim-card-icon" aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium">Tarjeta simulada</p>
				<p className="truncate text-xs text-muted-foreground">
					{card ? `${brandLabel(card.brand)} •••• ${card.last4} · vence ${card.exp} · ${card.holder}` : 'Cargando…'}
				</p>
			</div>
			<Button variant="ghost" size="sm" disabled={!card} onClick={() => card && setDraft(card)}>
				<Pencil aria-hidden="true" />
				Editar
			</Button>
			{error && !draft && (
				<p role="alert" className="error w-full">
					{error}
				</p>
			)}
			<Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Tarjeta simulada</DialogTitle>
						<DialogDescription>{CARD_EXPLAIN}</DialogDescription>
					</DialogHeader>
					{draft && (
						<div className="grid gap-3">
							<div className="grid gap-1.5">
								<Label>Marca</Label>
								<OptionSelect
									label="Marca"
									value={draft.brand}
									onValueChange={(v) => setDraft({ ...draft, brand: v as Card['brand'] })}
									options={BRANDS}
								/>
							</div>
							<div className="grid grid-cols-2 gap-3">
								<div className="grid gap-1.5">
									<Label htmlFor="sim-card-last4">Últimos 4 dígitos</Label>
									<Input
										id="sim-card-last4"
										inputMode="numeric"
										maxLength={4}
										value={draft.last4}
										onChange={(e) => setDraft({ ...draft, last4: e.target.value.replace(/\D/g, '') })}
									/>
								</div>
								<div className="grid gap-1.5">
									<Label htmlFor="sim-card-exp">Vencimiento (MM/AA)</Label>
									<Input
										id="sim-card-exp"
										maxLength={5}
										placeholder="08/29"
										value={draft.exp}
										onChange={(e) => setDraft({ ...draft, exp: e.target.value })}
									/>
								</div>
							</div>
							<div className="grid gap-1.5">
								<Label htmlFor="sim-card-holder">Titular</Label>
								<Input
									id="sim-card-holder"
									maxLength={60}
									value={draft.holder}
									onChange={(e) => setDraft({ ...draft, holder: e.target.value })}
								/>
							</div>
							{error && (
								<p role="alert" className="error">
									{error}
								</p>
							)}
						</div>
					)}
					<DialogFooter>
						<Button variant="ghost" onClick={() => setDraft(null)}>
							Cancelar
						</Button>
						<Button disabled={busy} onClick={() => void save()}>
							Guardar
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
