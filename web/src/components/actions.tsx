// Row actions and form actions, the same everywhere: icon buttons with a tooltip and an accessible
// name (edit, delete, others), and a dialog form's Cancelar / Guardar, aligned to the right.
import type { ComponentProps } from 'react';
import { Pencil, Save, Trash2, X, type LucideIcon } from 'lucide-react';
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

/** A dialog form's footer: Cancelar and the submit, on the right. */
export function FormActions({
	submitLabel,
	onCancel,
	disabled,
	className,
}: {
	submitLabel: string;
	onCancel: () => void;
	disabled?: boolean;
	className?: string;
}) {
	return (
		<div className={cn('flex flex-wrap justify-end gap-2 border-t pt-4', className)}>
			<Button type="button" variant="outline" onClick={onCancel}>
				<X aria-hidden="true" />
				Cancelar
			</Button>
			<Button type="submit" disabled={disabled}>
				<Save aria-hidden="true" />
				{submitLabel}
			</Button>
		</div>
	);
}
