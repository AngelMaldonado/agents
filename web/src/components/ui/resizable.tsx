import type { ComponentProps } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ResizablePanelGroup({ className, ...props }: ComponentProps<typeof Group>) {
	return (
		<Group data-slot="resizable-panel-group" className={cn('h-full min-h-0 w-full min-w-0', className)} {...props} />
	);
}
export function ResizablePanel({ className, ...props }: ComponentProps<typeof Panel>) {
	return <Panel data-slot="resizable-panel" className={cn('min-h-0 min-w-0', className)} {...props} />;
}
export function ResizableHandle({
	withHandle,
	className,
	...props
}: ComponentProps<typeof Separator> & { withHandle?: boolean }) {
	return (
		<Separator
			data-slot="resizable-handle"
			className={cn(
				'relative z-10 w-px shrink-0 bg-border outline-none focus-visible:bg-primary focus-visible:ring-2 focus-visible:ring-ring',
				className,
			)}
			{...props}
		>
			{withHandle && (
				<span className="absolute top-1/2 left-1/2 flex h-7 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-sm border bg-card">
					<GripVertical className="size-3" aria-hidden="true" />
				</span>
			)}
		</Separator>
	);
}
