// The app's frame: shadcn's Sidebar (variant inset, collapsible to icons; ⌘B toggles it) around the
// page, with a header for the page's title and the live status. The sidebar itself: app-sidebar.tsx.
import { useState, type ReactNode } from 'react';
import type { Agent, Person } from '@/api';
import { cn } from '@/lib/utils';
import { AppSidebar } from '@/components/app-sidebar';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { useSidebarWidth } from '@/lib/sidebar-width';
import { HeaderSlotContext } from '@/components/header-slot';
import type { CSSProperties } from 'react';

// shadcn's SidebarProvider writes its open/closed state to this cookie; it is read back here.
const sidebarOpen = () => !/(?:^|;\s*)sidebar_state=false(?:;|$)/.test(document.cookie);

export function AppShell({
	me,
	agents,
	connected,
	hash,
	agentName,
	onSettings,
	onLogout,
	children,
}: {
	me: Person;
	agents: Agent[];
	connected: boolean;
	hash: string;
	agentName?: string;
	onSettings: () => void;
	onLogout: () => Promise<void>;
	children: ReactNode;
}) {
	const title = agentName ?? (hash.startsWith('/new') ? 'Nuevo agente' : 'Galería');
	const width = useSidebarWidth();
	const [slot, setSlot] = useState<HTMLElement | null>(null);
	return (
		<SidebarProvider
			defaultOpen={sidebarOpen()}
			className="cuby-shell"
			style={{ '--sidebar-width': `${width.rem}rem` } as CSSProperties}
		>
			<a
				href="#main-content"
				onClick={(event) => {
					event.preventDefault();
					document.getElementById('main-content')?.focus();
				}}
				className="sr-only z-50 rounded-md bg-primary p-3 text-primary-foreground focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
			>
				Ir al contenido
			</a>
			<AppSidebar me={me} agents={agents} hash={hash} width={width} onSettings={onSettings} onLogout={onLogout} />
			<SidebarInset className="cuby-inset">
				<header className="cuby-header">
					<SidebarTrigger className="-ml-1" />
					<Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
					<span className="cuby-header-title min-w-0 truncate text-sm font-semibold">{title}</span>
					{/* A page's own bar (the chat view's breadcrumb and actions) replaces the title. */}
					<div ref={setSlot} className="cuby-header-slot" />
					<div className="flex shrink-0 items-center gap-3">
						{import.meta.env.DEV && (
							<Badge variant="outline" className="hidden sm:inline-flex">
								Desarrollo
							</Badge>
						)}
						<span role="status" className="flex items-center gap-1.5 text-2xs text-muted-foreground">
							<span
								className={cn('size-1.5 rounded-full', connected ? 'bg-success' : 'bg-warning')}
								aria-hidden="true"
							/>
							<span className="hidden sm:inline">{connected ? 'En vivo' : 'Reconectando…'}</span>
							<span className="sr-only sm:hidden">{connected ? 'En vivo' : 'Reconectando…'}</span>
						</span>
					</div>
				</header>
				<div id="main-content" tabIndex={-1} className="cuby-main min-h-0 min-w-0 flex-1 overflow-y-auto outline-none">
					<HeaderSlotContext.Provider value={slot}>{children}</HeaderSlotContext.Provider>
				</div>
			</SidebarInset>
		</SidebarProvider>
	);
}
