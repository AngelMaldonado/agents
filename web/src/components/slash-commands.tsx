// The work chat's / menu (assistant-ui slash commands): /reload, and one /skill:<name> per skill of the
// agent's approved harness. Picking a skill leaves «/skill:<name> » in the composer to write the request
// after it; pi loads those skills (`--skill`) and the harness tells the agent what that prefix means.
import { useMemo } from 'react';
import { ComposerPrimitive, unstable_useSlashCommandAdapter, type Unstable_SlashCommand } from '@assistant-ui/react';
import type { Harness } from '@/api';

export function useWorkCommands({
	skills,
	onReload,
	onSkill,
}: {
	skills: Harness['skills'];
	onReload: () => void;
	onSkill: (name: string) => void;
}) {
	const commands = useMemo<Unstable_SlashCommand[]>(
		// Skills first: /reload stops a live run, so it is never what a bare «/» + Enter picks.
		() => [
			...skills.map((s) => ({ id: `skill:${s.name}`, description: s.description, execute: () => onSkill(s.name) })),
			{
				id: 'reload',
				description: 'Recargar la configuración vigente (contrato, herramientas, MCP); reinicia el trabajo en curso',
				execute: onReload,
			},
		],
		[skills, onReload, onSkill],
	);
	// The typed /query goes away: a skill writes plain «/skill:<name> » itself (a directive would show raw
	// in this textarea and reach the agent as `:command[…]`).
	return unstable_useSlashCommandAdapter({ commands, removeOnExecute: true });
}

export function SlashPopover({ slash }: { slash: ReturnType<typeof useWorkCommands> }) {
	return (
		<ComposerPrimitive.TriggerPopover
			char="/"
			adapter={slash.adapter}
			className="reference-popover"
			aria-label="Comandos y skills"
		>
			<ComposerPrimitive.TriggerPopover.Action
				onExecute={slash.action.onExecute}
				removeOnExecute={slash.action.removeOnExecute}
			/>
			<ComposerPrimitive.TriggerPopoverItems>
				{(items) =>
					items.map((it, i) => (
						<ComposerPrimitive.TriggerPopoverItem key={it.id} item={it} index={i} className="reference-item">
							<span className="shrink-0 font-mono">/{it.id}</span>
							{it.description && <span className="reference-description min-w-0 truncate">{it.description}</span>}
						</ComposerPrimitive.TriggerPopoverItem>
					))
				}
			</ComposerPrimitive.TriggerPopoverItems>
		</ComposerPrimitive.TriggerPopover>
	);
}
