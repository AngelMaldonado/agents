// Cuby agents' mark: the Cuby isotype (a rounded square, #E22706) as a robot, with two eyes and two
// antennas. Drawn with Codex (gpt) from isotipo-cuby-512px.png; the same shapes are the favicon
// (public/favicon.svg). Inline so it can move: on load the robot pops up and blinks, then blinks now
// and then (styles.css, .cuby-bot). Reduced motion stills it.
import { cn } from '@/lib/utils';

export function CubyBot({ size = 32, className }: { size?: number; className?: string }) {
	return (
		<svg
			viewBox="0 0 64 64"
			width={size}
			height={size}
			className={cn('cuby-bot shrink-0', className)}
			fill="#E22706"
			stroke="#E22706"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<g className="cuby-bot-body">
				<g className="cuby-bot-antennas">
					<path d="M22 19 17 8M42 19 47 8" fill="none" strokeWidth="7" />
					<circle cx="17" cy="8" r="4.5" stroke="none" />
					<circle cx="47" cy="8" r="4.5" stroke="none" />
				</g>
				<rect x="12" y="18" width="40" height="40" rx="9" fill="none" strokeWidth="7" />
				<g className="cuby-bot-eyes" stroke="none">
					<circle cx="24" cy="38" r="4.5" />
					<circle cx="40" cy="38" r="4.5" />
				</g>
			</g>
		</svg>
	);
}
