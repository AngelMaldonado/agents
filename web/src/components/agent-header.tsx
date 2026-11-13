import { BrainCircuit } from 'lucide-react';
import type { PublicSettings } from '@/api';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** The model's label as the admin named it, or its id. */
export const modelLabel = (settings: PublicSettings, model: string) =>
	settings.models.find((m) => m.id === model)?.label ?? model;

/** Automejora: a button with its name in the hub's header, an icon in the chat view's bar. */
export function AutomejoraLink({
	agentId,
	active = false,
	designId,
	iconOnly = false,
}: {
	agentId: number;
	active?: boolean;
	designId?: string;
	iconOnly?: boolean;
}) {
	const link = (
		<Button
			asChild
			variant={iconOnly ? 'ghost' : 'outline'}
			size={iconOnly ? 'icon-sm' : 'sm'}
			className="automejora-action"
		>
			<a
				href={`#/agent/${agentId}/improve${designId ? `/${designId}` : ''}`}
				aria-label="Abrir Automejora"
				aria-current={active ? 'page' : undefined}
			>
				<BrainCircuit aria-hidden="true" />
				{!iconOnly && <span className="agent-action-label">Automejora</span>}
			</a>
		</Button>
	);
	return (
		<Tooltip>
			<TooltipTrigger asChild>{link}</TooltipTrigger>
			<TooltipContent side="bottom">Automejora</TooltipContent>
		</Tooltip>
	);
}
