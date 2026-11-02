import { isValidElement, type ReactNode } from 'react';
import { MermaidDiagram } from './mermaid-diagram';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import { ReferenceChip, isReference, referenceLinks } from './references';
import remarkGfm from 'remark-gfm';
import type { AgentTool } from '@/api';
import {
	FileText,
	FilePen,
	FilePlus,
	Files,
	FolderSearch,
	FolderTree,
	Globe,
	Hand,
	KeyRound,
	TextSearch,
	Terminal,
	Wrench,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
const toolIcons = {
	files: Files,
	read: FileText,
	write: FilePlus,
	edit: FilePen,
	grep: TextSearch,
	find: FolderSearch,
	ls: FolderTree,
	bash: Terminal,
	browser: Globe,
	help: Hand,
	request_help: Hand,
	login: KeyRound,
};

// ```mermaid blocks are drawn (the contract's flows); every other block stays code.
const components: Components = {
	pre({ children, node: _node, ...rest }) {
		const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children.props : null;
		if (code?.className?.split(' ').includes('language-mermaid'))
			return <MermaidDiagram chart={String(code.children ?? '').trim()} />;
		return <pre {...rest}>{children}</pre>;
	},
	// A cited job or conversation (Automejora): a chip, not a link.
	a({ href, children, node: _node, ...rest }) {
		if (isReference(href)) return <ReferenceChip id={href!}>{children}</ReferenceChip>;
		return (
			<a href={href} {...rest}>
				{children}
			</a>
		);
	},
};
const keepReferences = (url: string) => (isReference(url) ? url : defaultUrlTransform(url));

export function ContractMarkdown({ text }: { text: string }) {
	return (
		<div className="markdown contract-markdown">
			<Markdown
				remarkPlugins={[remarkGfm]}
				disallowedElements={['img']}
				components={components}
				urlTransform={keepReferences}
			>
				{referenceLinks(text)}
			</Markdown>
		</div>
	);
}

/** compact: an icon and a name per tool; what it does goes in the tooltip. */
export function ToolsPanel({ tools, compact = false }: { tools: AgentTool[]; compact?: boolean }) {
	if (compact)
		return (
			<section aria-label="Herramientas disponibles" className="harness-tiles">
				{tools.map((tool) => {
					const Icon = toolIcons[tool.id as keyof typeof toolIcons] ?? Wrench;
					return (
						<Tooltip key={tool.id}>
							<TooltipTrigger asChild>
								<div className="harness-tile" tabIndex={0} aria-label={`${tool.name}: ${tool.description}`}>
									<Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
									<span className="min-w-0 truncate">{tool.name}</span>
								</div>
							</TooltipTrigger>
							<TooltipContent side="top" className="max-w-xs">
								{tool.description}
							</TooltipContent>
						</Tooltip>
					);
				})}
			</section>
		);
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
