// A harness piece as a tile: an icon and a name (and a detail); what it is goes in the tooltip.
// Shared by Configuración → Avanzado → Harness and the designer's Harness tab.
import type { ComponentType } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function Tile({
	icon: Icon,
	title,
	detail,
	hint,
	onClick,
}: {
	icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
	title: string;
	detail?: string;
	hint: string;
	/** A tile that opens something (a skill's instructions) is a button. */
	onClick?: () => void;
}) {
	const body = (
		<>
			<Icon className="size-5 shrink-0 text-primary" aria-hidden="true" />
			<span className="grid min-w-0">
				<span className="truncate">{title}</span>
				{detail && <span className="truncate font-mono text-2xs font-normal text-muted-foreground">{detail}</span>}
			</span>
		</>
	);
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{onClick ? (
					<button type="button" className="harness-tile" onClick={onClick} aria-label={`Abrir ${title}`}>
						{body}
					</button>
				) : (
					<div className="harness-tile" tabIndex={0}>
						{body}
					</div>
				)}
			</TooltipTrigger>
			<TooltipContent side="top" className="max-w-xs">
				{hint}
			</TooltipContent>
		</Tooltip>
	);
}
