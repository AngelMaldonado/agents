// React adaptation of Nova's inset shell, with Agents' routes and permissions only.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, LayoutGrid, Moon, MoreVertical, PanelLeft, Palette, Settings2, ShieldCheck, Sun } from 'lucide-react';
import type { Person } from '@/api';
import { cn } from '@/lib/utils';
import { useTheme } from '@/lib/theme';
import logoUrl from '@/assets/agents-logo.png';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

const links = [
	{ href: '/', label: 'Agentes', icon: LayoutGrid },
	{ href: '/monitor', label: 'Monitor', icon: Activity },
	{ href: '/settings', label: 'Ajustes', icon: Settings2 },
	{ href: '/admin', label: 'Administración', icon: ShieldCheck }
];

function ProfileMenu({ me, onNavigate }: { me: Person; onNavigate: () => void }) {
	const theme = useTheme();
	return <DropdownMenu>
		<DropdownMenuTrigger asChild>
			<button type="button" className="cuby-profile" aria-label={`Menú de ${me.name}`}>
				<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-medium" aria-hidden="true">{me.name.slice(0, 2).toUpperCase()}</span>
				<span className="grid min-w-0 flex-1 gap-0.5 leading-tight"><span className="truncate text-sm font-medium">{me.name}</span><span className="truncate text-xs text-muted-foreground">{me.admin ? 'Administrador' : 'Espacio personal'}</span></span>
				<MoreVertical className="size-icon shrink-0" aria-hidden="true" />
			</button>
		</DropdownMenuTrigger>
		<DropdownMenuContent side="top" align="end" className="w-64 max-w-[calc(100vw-2rem)] rounded-lg">
			<DropdownMenuLabel className="truncate text-xs">{me.name}</DropdownMenuLabel>
			<DropdownMenuSeparator />
			<DropdownMenuItem asChild className="text-xs"><a href="#/settings" onClick={onNavigate}><Settings2 aria-hidden="true" />Ajustes</a></DropdownMenuItem>
			<DropdownMenuSeparator />
			<DropdownMenuLabel className="flex items-center gap-2 text-xs"><Palette className="size-icon" aria-hidden="true" />Apariencia</DropdownMenuLabel>
			<DropdownMenuRadioGroup value={theme.mode} onValueChange={(mode) => { if (mode === 'light' || mode === 'dark') theme.set(mode); }}>
				<DropdownMenuRadioItem value="light" className="text-xs"><Sun aria-hidden="true" />Claro</DropdownMenuRadioItem>
				<DropdownMenuRadioItem value="dark" className="text-xs"><Moon aria-hidden="true" />Oscuro</DropdownMenuRadioItem>
			</DropdownMenuRadioGroup>
		</DropdownMenuContent>
	</DropdownMenu>;
}

function Brand() {
	return <a href="#/" className="flex h-14 items-center gap-3 rounded-md px-2 outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring">
		<img src={logoUrl} alt="" width={512} height={512} className="size-10 shrink-0 object-contain" />
		<span className="grid min-w-0 gap-0.5 leading-tight"><span className="text-sm font-semibold">Agents</span><span className="truncate text-xs text-muted-foreground">Espacio de trabajo</span></span>
	</a>;
}

export function AppShell({ me, connected, hash, agentName, children }: {
	me: Person; connected: boolean; hash: string; agentName?: string; children: ReactNode;
}) {
	const [mobileOpen, setMobileOpen] = useState(false);
	const [desktopOpen, setDesktopOpen] = useState(true);
	const desktopToggle = useRef<HTMLButtonElement>(null);
	const toggleDesktop = useCallback(() => {
		if (document.getElementById('desktop-navigation')?.contains(document.activeElement)) desktopToggle.current?.focus();
		setDesktopOpen((open) => !open);
	}, []);
	useEffect(() => setMobileOpen(false), [hash]);
	useEffect(() => {
		const toggle = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== 'b' || !(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return;
			event.preventDefault();
			if (matchMedia('(min-width: 768px)').matches) toggleDesktop();
			else setMobileOpen((open) => !open);
		};
		window.addEventListener('keydown', toggle);
		return () => window.removeEventListener('keydown', toggle);
	}, [toggleDesktop]);
	const current = links.find((link) => link.href === hash) ?? links[0];
	const navigation = <nav aria-label="Navegación principal" className="flex flex-col gap-1">
		{links.map(({ href, label, icon: Icon }) => {
			const active = href === '/' ? hash === '/' || hash.startsWith('/agent/') || hash.startsWith('/new') : hash === href;
			return <a key={href} href={`#${href}`} onClick={() => setMobileOpen(false)} aria-current={active ? 'page' : undefined} className="cuby-nav-link">
				<Icon className="size-icon shrink-0" aria-hidden="true" /><span>{label}</span>
				{href === '/admin' && me.admin && <span className="ml-auto size-1.5 rounded-full bg-info" aria-label="Administrador activo" />}
			</a>;
		})}
	</nav>;
	const profile = <ProfileMenu me={me} onNavigate={() => setMobileOpen(false)} />;
	return <div className="cuby-shell">
		<a href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus(); }} className="sr-only z-50 rounded-md bg-primary p-3 text-primary-foreground focus:not-sr-only focus:absolute focus:top-2 focus:left-2">Ir al contenido</a>
		<div id="desktop-navigation" data-state={desktopOpen ? 'open' : 'closed'} inert={!desktopOpen} aria-hidden={!desktopOpen} className="cuby-sidebar hidden shrink-0 overflow-hidden md:block">
			<aside aria-label="Barra lateral" className="flex h-full min-h-0 w-(--sidebar-width) flex-col p-2 text-sidebar-foreground">
				<Brand />
				<div className="min-h-0 flex-1 overflow-y-auto px-2 pt-5"><p className="mb-2 px-2.5 text-2xs font-medium text-muted-foreground">Tu espacio</p>{navigation}</div>
				<div className="mt-auto pt-2"><Separator className="mb-2 bg-sidebar-border" />{profile}</div>
			</aside>
		</div>
		<div data-slot="sidebar-inset" className={cn('cuby-inset', !desktopOpen && 'md:ml-2')}>
			<header className="cuby-header">
				<Button ref={desktopToggle} variant="ghost" size="icon" className="-ml-1 hidden md:inline-flex" onClick={toggleDesktop} aria-label={desktopOpen ? 'Ocultar menú' : 'Mostrar menú'} aria-expanded={desktopOpen} aria-controls="desktop-navigation"><PanelLeft aria-hidden="true" /></Button>
				<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
					<SheetTrigger asChild><Button variant="ghost" size="icon" className="-ml-1 md:hidden" aria-label="Abrir menú"><PanelLeft aria-hidden="true" /></Button></SheetTrigger>
					<SheetContent side="left" className="w-[min(20rem,calc(100vw-2rem))] gap-0 border-sidebar-border bg-sidebar p-2 text-sidebar-foreground">
						<SheetHeader className="p-0 pr-7"><SheetTitle className="sr-only">Agents</SheetTitle><SheetDescription className="sr-only">Espacio de trabajo de Cuby</SheetDescription><Brand /></SheetHeader>
						<div className="min-h-0 flex-1 overflow-y-auto px-2 pt-5"><p className="mb-2 px-2.5 text-2xs font-medium text-muted-foreground">Tu espacio</p>{navigation}</div>
						<div className="pt-2"><Separator className="mb-2 bg-sidebar-border" />{profile}</div>
					</SheetContent>
				</Sheet>
				<Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
				<span className="min-w-0 truncate text-sm font-semibold">{agentName ?? current.label}</span>
				<div className="ml-auto flex shrink-0 items-center gap-3">
					{location.hostname.startsWith('agents-dev.') && <Badge variant="outline" className="hidden sm:inline-flex">Desarrollo</Badge>}
					<span role="status" className="flex items-center gap-1.5 text-2xs text-muted-foreground">
						<span className={cn('size-1.5 rounded-full', connected ? 'bg-success' : 'bg-warning')} aria-hidden="true" />
						<span className="hidden sm:inline">{connected ? 'En vivo' : 'Reconectando…'}</span><span className="sr-only sm:hidden">{connected ? 'En vivo' : 'Reconectando…'}</span>
					</span>
				</div>
			</header>
			<main id="main-content" tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-y-auto outline-none">{children}</main>
		</div>
	</div>;
}
