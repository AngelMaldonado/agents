import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentTool } from '@/api';
import { Files, Globe, Hand, KeyRound, Terminal, Wrench } from 'lucide-react';
const toolIcons = { files: Files, bash: Terminal, browser: Globe, help: Hand, login: KeyRound };

export function ContractMarkdown({ text }: { text: string }) {
	return (
		<div className="markdown contract-markdown">
			<Markdown remarkPlugins={[remarkGfm]} disallowedElements={['img']}>
				{text}
			</Markdown>
		</div>
	);
}

export function ToolsPanel({ tools }: { tools: AgentTool[] }) {
	return (
		<section
			aria-label="Herramientas disponibles"
			className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-2"
		>
			{tools.map((tool) => {
				const Icon = toolIcons[tool.id as keyof typeof toolIcons] ?? Wrench;
				return (
					<div key={tool.id} className="rounded-lg border bg-card p-3">
						<h3 className="flex items-center gap-2 text-xs font-semibold">
							<Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
							{tool.name}
						</h3>
						<p className="mt-2 text-xs text-muted-foreground">{tool.description}</p>
					</div>
				);
			})}
		</section>
	);
}
