// An agent's state as one icon (the gallery card, left of the model): what it is doing, in the
// status colors, with its name in a tooltip and for screen readers. Never color alone: the icon
// differs per state and the label is always there.
import {
	Ban,
	CircleCheck,
	CircleDashed,
	CircleX,
	Clock,
	Coffee,
	FilePen,
	Globe,
	Hand,
	Lightbulb,
	Loader2,
	MessageSquareShare,
	SquareTerminal,
	TriangleAlert,
	Wrench,
	type LucideIcon,
} from 'lucide-react';
import type { CharState } from '@/Character';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** queued and the two setup states are not CharStates: the card derives them from the run. */
export type CardStatus = CharState | 'queued' | 'initializing' | 'review-setup';

const ICON: Record<CardStatus, { icon: LucideIcon; tone: string; spin?: boolean }> = {
	idle: { icon: Coffee, tone: 'text-muted-foreground' },
	queued: { icon: Clock, tone: 'text-muted-foreground' },
	starting: { icon: Loader2, tone: 'text-info', spin: true },
	initializing: { icon: Wrench, tone: 'text-info' },
	thinking: { icon: Lightbulb, tone: 'text-info' },
	browsing: { icon: Globe, tone: 'text-info' },
	running: { icon: SquareTerminal, tone: 'text-info' },
	writing: { icon: FilePen, tone: 'text-info' },
	steered: { icon: MessageSquareShare, tone: 'text-info' },
	blocked: { icon: Hand, tone: 'text-warning' },
	'review-setup': { icon: TriangleAlert, tone: 'text-warning' },
	done: { icon: CircleCheck, tone: 'text-success' },
	incomplete: { icon: CircleDashed, tone: 'text-muted-foreground' },
	cancelled: { icon: Ban, tone: 'text-muted-foreground' },
	error: { icon: CircleX, tone: 'text-danger' },
};

export function StatusIcon({ status, label, className }: { status: CardStatus; label: string; className?: string }) {
	const { icon: Icon, tone, spin } = ICON[status];
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					role="img"
					aria-label={label}
					tabIndex={0}
					className={cn(
						'relative z-20 inline-flex shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
						tone,
						className,
					)}
				>
					<Icon className={cn('size-3.5', spin && 'animate-spin')} aria-hidden="true" />
				</span>
			</TooltipTrigger>
			<TooltipContent side="top">{label}</TooltipContent>
		</Tooltip>
	);
}
