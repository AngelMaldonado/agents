// Row actions and form actions, the same everywhere: icon buttons with a tooltip and an accessible
// name (edit, delete, others), and a dialog form's Cancelar / Guardar, aligned to the right.
import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Check, LoaderCircle, Pencil, Save, Trash2, X, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type IconButtonProps = Omit<ComponentProps<typeof Button>, 'children' | 'size' | 'variant'> & {
	icon: LucideIcon;
	label: string;
	danger?: boolean;
};

export function IconButton({ icon: Icon, label, danger, className, ...props }: IconButtonProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					size="icon-sm"
					variant={danger ? 'danger-ghost' : 'ghost'}
					aria-label={label}
					className={className}
					{...props}
				>
					<Icon aria-hidden="true" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="top">{label}</TooltipContent>
		</Tooltip>
	);
}

export const EditButton = ({
	label = 'Editar',
	...props
}: Omit<IconButtonProps, 'icon' | 'label'> & { label?: string }) => (
	<IconButton icon={Pencil} label={label} {...props} />
);

export const DeleteButton = ({
	label = 'Borrar',
	...props
}: Omit<IconButtonProps, 'icon' | 'label' | 'danger'> & { label?: string }) => (
	<IconButton icon={Trash2} label={label} danger {...props} />
);

// ---------- saving: a spinner while it saves, then a check for a moment ----------

export type SaveState = 'idle' | 'saving' | 'saved';
const SAVED_MS = 2000;
/** How long a dialog that closes after saving keeps the check in sight. */
const HOLD_MS = 700;

/**
 * The state of a save button. `run` saves: «saving» while it works, «saved» for a moment when it
 * succeeds, back to idle when it fails (it rethrows: the caller shows the error). With `hold`, it
 * resolves only after the check has been seen, for a dialog that closes when saved.
 */
export function useSaving() {
	const [state, setState] = useState<SaveState>('idle');
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const run = useCallback(async <T,>(save: () => Promise<T>, opts: { hold?: boolean } = {}): Promise<T> => {
		clearTimeout(timer.current);
		setState('saving');
		try {
			const result = await save();
			setState('saved');
			timer.current = setTimeout(() => setState('idle'), SAVED_MS);
			if (opts.hold) await new Promise((done) => setTimeout(done, HOLD_MS));
			return result;
		} catch (err) {
			setState('idle');
			throw err;
		}
	}, []);
	return { state, saving: state === 'saving', saved: state === 'saved', run };
}

/** A save button: the spinner while it saves, «Guardado» with a check for a moment after. */
export function SaveButton({
	state = 'idle',
	icon: Icon = Save,
	children = 'Guardar',
	disabled,
	...props
}: Omit<ComponentProps<typeof Button>, 'children'> & { state?: SaveState; icon?: LucideIcon; children?: ReactNode }) {
	return (
		<Button disabled={disabled || state === 'saving'} aria-busy={state === 'saving'} {...props}>
			{state === 'saving' ? (
				<LoaderCircle className="animate-spin" aria-hidden="true" />
			) : state === 'saved' ? (
				<Check aria-hidden="true" />
			) : (
				<Icon aria-hidden="true" />
			)}
			{state === 'saved' ? <span role="status">Guardado</span> : children}
		</Button>
	);
}

/** A dialog form's footer: Cancelar and the submit, on the right. */
export function FormActions({
	submitLabel,
	onCancel,
	disabled,
	state,
	className,
}: {
	submitLabel: string;
	onCancel: () => void;
	disabled?: boolean;
	/** The submit's save state (useSaving): spinner, then check. */
	state?: SaveState;
	className?: string;
}) {
	return (
		<div className={cn('flex flex-wrap justify-end gap-2 border-t pt-4', className)}>
			<Button type="button" variant="outline" onClick={onCancel} disabled={state === 'saving'}>
				<X aria-hidden="true" />
				Cancelar
			</Button>
			<SaveButton type="submit" disabled={disabled} state={state}>
				{submitLabel}
			</SaveButton>
		</div>
	);
}
