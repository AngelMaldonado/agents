import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export function OptionSelect({
	label,
	value,
	options,
	onValueChange,
	disabled,
	id,
	className,
	size = 'default',
	placeholder,
}: {
	label: string;
	value: string;
	options: readonly { id: string; label: string }[];
	onValueChange: (value: string) => void;
	disabled?: boolean;
	id?: string;
	className?: string;
	size?: 'sm' | 'default';
	/** Shown while nothing is chosen. */
	placeholder?: string;
}) {
	return (
		<Select value={value} onValueChange={onValueChange} disabled={disabled}>
			<SelectTrigger size={size} id={id} aria-label={label} className={cn('w-full min-w-0', className)}>
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent position="popper" className="max-w-[calc(100vw-2rem)]">
				{options.map((option) => (
					<SelectItem key={option.id} value={option.id}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
