// An agent's face: its 8-bit character cropped to head and shoulders (units x 5–21, y 2–18 of the
// 32-unit drawing, where Character.tsx draws the person at x 7–21 from y 3 and the laptop from x 18, y 17).
import type { Agent } from '@/api';
import { Character } from '@/Character';
import { stateOf } from '@/Gallery';
import { cn } from '@/lib/utils';

export function AgentFace({
	agent,
	size,
	still = false,
	className,
}: {
	agent: Pick<Agent, 'seed' | 'task'>;
	size: number;
	still?: boolean;
	className?: string;
}) {
	const unit = size / 16;
	return (
		<span
			className={cn('relative block shrink-0 overflow-hidden rounded-md bg-muted', className)}
			style={{ width: size, height: size }}
			aria-hidden="true"
		>
			<span className="absolute" style={{ left: -5 * unit, top: -2 * unit }}>
				<Character seed={agent.seed} state={stateOf(agent as Agent)} size={32 * unit} still={still} />
			</span>
		</span>
	);
}
