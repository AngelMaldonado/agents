// Pieces shared by Configuración's lists (accesos a sitios, servidores MCP, API Keys): who has an
// access (a multi-select dropdown), a security note behind a shield, a «Probar» button that shows
// its outcome, and the dialog that adds or edits an item on top of Configuración.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Loader2, Plug, Plus, ShieldCheck, X } from 'lucide-react';
import type { Agent } from '@/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** Which of the person's agents have an access: a dropdown of checkboxes that stays open while ticking. */
export function AgentPicker({
	agents,
	value,
	onChange,
	disabled,
	label = 'Agentes con acceso',
}: {
	agents: Agent[];
	value: number[];
	onChange: (next: number[]) => void;
	disabled?: boolean;
	label?: string;
}) {
	if (!agents.length) return <span className="muted small">Crea un agente primero</span>;
	const chosen = agents.filter((a) => value.includes(a.id));
	const summary = !chosen.length
		? 'Ningún agente'
		: chosen.length === 1
			? chosen[0].name
			: chosen.length === agents.length
				? 'Todos tus agentes'
				: `${chosen.length} agentes`;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={disabled}
					className="max-w-56 justify-between gap-2 font-normal"
					aria-label={`${label}: ${summary}`}
				>
					<span className={cn('truncate', !chosen.length && 'text-muted-foreground')}>{summary}</span>
					<ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-64">
				<DropdownMenuLabel className="text-xs">{label}</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{agents.map((a) => (
					<DropdownMenuCheckboxItem
						key={a.id}
						className="text-xs"
						checked={value.includes(a.id)}
						onSelect={(e) => e.preventDefault()}
						onCheckedChange={(on) => onChange(on ? [...value, a.id] : value.filter((id) => id !== a.id))}
					>
						<span className="truncate">{a.name}</span>
					</DropdownMenuCheckboxItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** One agent's grant of an access (its settings' Accesos tab): a switch, on when the agent has it. */
export function GrantToggle({
	on,
	what,
	label,
	disabled,
	onChange,
}: {
	on: boolean;
	what: string;
	/** The switch's accessible name; by default «<what> para este agente». */
	label?: string;
	disabled?: boolean;
	onChange: (on: boolean) => void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			aria-label={label ?? `${what} para este agente`}
			disabled={disabled}
			onClick={() => onChange(!on)}
			className={cn(
				'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
				on ? 'border-primary bg-primary' : 'border-border bg-muted',
			)}
		>
			<span
				className={cn(
					'block size-3.5 rounded-full bg-background shadow-sm transition-transform',
					on ? 'translate-x-4' : 'translate-x-0.5',
				)}
			/>
		</button>
	);
}

/** The security details of a section, behind a shield (hover or focus shows them). */
export function SecurityNote({ children }: { children: ReactNode }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					className="inline-flex size-6 items-center justify-center rounded-md text-success outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
					aria-label="Seguridad"
				>
					<ShieldCheck className="size-4" aria-hidden="true" />
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="max-w-xs text-xs leading-relaxed">
				{children}
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * «Agregar» in an agent's Accesos: use one of yours it does not have yet, or create a new one for
 * it alone.
 */
export function AddMenu({
	options,
	onPick,
	onNew,
	newLabel,
}: {
	options: { id: number; label: string; detail?: string }[];
	onPick: (id: number) => void;
	onNew: () => void;
	newLabel: string;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button type="button" size="sm" variant="outline" className="ml-auto">
					<Plus aria-hidden="true" />
					Agregar
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-72">
				{options.length > 0 && (
					<>
						<DropdownMenuLabel className="text-xs text-muted-foreground">Usar uno tuyo</DropdownMenuLabel>
						{options.map((o) => (
							<DropdownMenuItem key={o.id} onSelect={() => onPick(o.id)}>
								<span className="grid min-w-0">
									<code className="truncate text-xs">{o.label}</code>
									{o.detail && <span className="truncate text-2xs text-muted-foreground">{o.detail}</span>}
								</span>
							</DropdownMenuItem>
						))}
						<DropdownMenuSeparator />
					</>
				)}
				<DropdownMenuItem onSelect={onNew}>
					<Plus aria-hidden="true" />
					{newLabel}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** A section's title with its security note and its «Agregar» button (or a custom action). */
export function SectionHead({
	title,
	security,
	onAdd,
	addLabel = 'Agregar',
	action,
}: {
	title: string;
	security?: ReactNode;
	onAdd?: () => void;
	addLabel?: string;
	action?: ReactNode;
}) {
	return (
		<div className="mb-2 flex items-center gap-2">
			<h2 className="!mb-0">{title}</h2>
			{security && <SecurityNote>{security}</SecurityNote>}
			{action}
			{!action && onAdd && (
				<Button type="button" size="sm" variant="outline" className="ml-auto" onClick={onAdd}>
					<Plus aria-hidden="true" />
					{addLabel}
				</Button>
			)}
		</div>
	);
}

const DETAIL_MAX = 140;

/**
 * «Probar»: spins while testing, then turns green (or red) and shows what happened in a tooltip
 * that closes by itself after a few seconds; hovering shows it again.
 */
export function TestButton({ run }: { run: () => Promise<string> }) {
	const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle');
	const [detail, setDetail] = useState('');
	const [open, setOpen] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const show = () => {
		setOpen(true);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setOpen(false), 5000);
	};
	const click = async () => {
		setState('busy');
		setOpen(false);
		try {
			setDetail(await run());
			setState('ok');
		} catch (e) {
			setDetail((e as Error).message);
			setState('error');
		}
		show();
	};
	const text = detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX - 1)}…` : detail;
	return (
		<Tooltip open={open && !!detail} onOpenChange={(o) => (o ? detail && setOpen(true) : setOpen(false))}>
			<TooltipTrigger asChild>
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={state === 'busy'}
					onClick={() => void click()}
					aria-live="polite"
					className={cn(
						'transition-colors',
						state === 'ok' && 'border-success/50 bg-success-soft text-success-on-soft hover:bg-success-soft',
						state === 'error' && 'border-danger/50 bg-danger-soft text-danger-on-soft hover:bg-danger-soft',
					)}
				>
					{state === 'busy' ? (
						<Loader2 className="animate-spin" aria-hidden="true" />
					) : state === 'ok' ? (
						<Check aria-hidden="true" />
					) : state === 'error' ? (
						<X aria-hidden="true" />
					) : (
						<Plug aria-hidden="true" />
					)}
					{state === 'busy' ? 'Probando' : state === 'ok' ? 'Conectó' : state === 'error' ? 'Falló' : 'Probar'}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="top" className="max-w-xs">
				<span className="block truncate text-xs">{text}</span>
			</TooltipContent>
		</Tooltip>
	);
}

/** Adding or editing an item: a dialog on top of Configuración. */
export function FormDialog({
	open,
	onOpenChange,
	title,
	description,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					{description ? (
						<DialogDescription>{description}</DialogDescription>
					) : (
						<DialogDescription className="sr-only">{title}</DialogDescription>
					)}
				</DialogHeader>
				{children}
			</DialogContent>
		</Dialog>
	);
}
