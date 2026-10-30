// Nova's auth-card structure, adapted to Agents. No IoT links or account actions.
import type { ReactNode } from 'react';
import { LockKeyhole } from 'lucide-react';
import logoUrl from '@/assets/agents-logo.png';
import { Card } from '@/components/ui/card';
import { ThemeToggle } from '@/components/theme-toggle';

export function AuthShell({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children?: ReactNode;
}) {
	return (
		<div className="auth-shell">
			<div className="auth-background" aria-hidden="true">
				<div className="auth-glow" />
				<div className="auth-dots" />
				<div className="auth-veil" />
			</div>
			<main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-6 px-5 py-12">
				<div className="flex items-center gap-3">
					<img src={logoUrl} alt="" width={512} height={512} className="size-16 shrink-0 object-contain" />
					<div className="grid gap-0.5">
						<span className="text-2xl font-semibold tracking-tight">Agents</span>
						<span className="text-xs text-muted-foreground">Cuby Smart</span>
					</div>
				</div>
				<Card className="w-full gap-0 rounded-card py-0 shadow-xl">
					<div className="flex flex-col gap-4 px-6 pt-5 pb-6">
						<div className="flex items-center justify-between gap-3">
							<h1 className="text-lg tracking-tight">{title}</h1>
							<div className="-mr-2">
								<ThemeToggle />
							</div>
						</div>
						<p className="text-xs text-muted-foreground">{description}</p>
						{children}
					</div>
				</Card>
			</main>
			<footer className="sticky bottom-0 z-10 flex items-center justify-center gap-2 border-t border-border/60 bg-background/45 px-5 py-3 text-2xs text-muted-foreground backdrop-blur-xs">
				<LockKeyhole className="size-icon-sm" aria-hidden="true" />
				Cuby Agents · Acceso interno
			</footer>
		</div>
	);
}
