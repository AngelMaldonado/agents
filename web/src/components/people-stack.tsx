// Who works with an agent (its owner and the people it is shared with): small overlapping initials,
// like the user menu's, at most a few and then «+N». Hover or focus lists everyone by name.
import type { Person } from '@/api';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type Someone = Pick<Person, 'id' | 'name'>;
const SHOWN = 3;
const FACE =
	'flex size-5 items-center justify-center rounded-full bg-muted text-[0.5625rem] leading-none font-medium ring-1 ring-card';
const initials = (name: string) => name.slice(0, 2).toUpperCase();

export function PeopleStack({ people, className }: { people: Someone[]; className?: string }) {
	if (!people.length) return null;
	const shown = people.length > SHOWN ? people.slice(0, SHOWN - 1) : people;
	const rest = people.length - shown.length;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					role="img"
					aria-label={`Trabajan con este agente: ${people.map((p) => p.name).join(', ')}`}
					tabIndex={0}
					className={cn(
						'relative z-20 flex shrink-0 -space-x-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring',
						className,
					)}
				>
					{shown.map((p) => (
						<span key={p.id} className={FACE} aria-hidden="true">
							{initials(p.name)}
						</span>
					))}
					{rest > 0 && (
						<span className={cn(FACE, 'text-muted-foreground')} aria-hidden="true">
							+{rest}
						</span>
					)}
				</span>
			</TooltipTrigger>
			<TooltipContent side="top" className="max-w-xs">
				<ul className="grid gap-1">
					{people.map((p) => (
						<li key={p.id} className="flex items-center gap-2">
							<span className="flex size-4 items-center justify-center rounded-full bg-background/20 text-[0.5rem] font-medium">
								{initials(p.name)}
							</span>
							<span className="truncate">{p.name}</span>
						</li>
					))}
				</ul>
			</TooltipContent>
		</Tooltip>
	);
}
