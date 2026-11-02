// Configuración: everything that is not an agent, in one modal from the person's tile, like
// Claude.ai's settings: sections on the left, the content on the right. Same primitives and
// classes as the agent's own modal (AgentSettings.tsx): Radix Dialog + vertical Radix Tabs.
import { useState, type ReactNode } from 'react';
import { Activity, KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react';
import type { Agent, Person } from '@/api';
import { Monitor } from '@/Monitor';
import { Admin } from '@/Admin';
import { ProviderSettings, Accesses } from '@/Settings';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export type SettingsTab = 'ai' | 'access' | 'monitor' | 'admin';

const TABS: { value: SettingsTab; label: string; icon: typeof Activity }[] = [
	{ value: 'ai', label: 'API Key', icon: KeyRound },
	{ value: 'access', label: 'Accesos', icon: LockKeyhole },
	{ value: 'monitor', label: 'Monitor', icon: Activity },
	{ value: 'admin', label: 'Administración', icon: ShieldCheck },
];

export function AppSettings({
	tab,
	onTab,
	onClose,
	me,
	agents,
	pinIsSet,
	onChanged,
}: {
	tab: SettingsTab | null; // null: closed
	onTab: (tab: SettingsTab) => void;
	onClose: () => void;
	me: Person;
	agents: Agent[];
	pinIsSet: boolean;
	onChanged: () => void;
}) {
	// Forms keep what was typed while the modal stays open; the monitor only runs while shown
	// (it subscribes to the live feed).
	const [visited, setVisited] = useState(new Set<SettingsTab>());
	if (tab && !visited.has(tab)) setVisited(new Set([...visited, tab]));
	const active = tab ?? 'ai';
	return (
		<Dialog
			open={tab !== null}
			onOpenChange={(open) => {
				if (open) return;
				setVisited(new Set());
				onClose();
			}}
		>
			<DialogContent
				aria-describedby={undefined}
				className="agent-settings-dialog app-settings flex h-[min(46rem,calc(100svh-2rem))] w-[calc(100vw-2rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
			>
				<DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
					<DialogTitle>Configuración</DialogTitle>
				</DialogHeader>
				<Tabs
					orientation="vertical"
					value={active}
					onValueChange={(v) => onTab(v as SettingsTab)}
					className="agent-settings-tabs min-h-0 flex-1 gap-0"
				>
					<div className="agent-settings-nav">
						<TabsList aria-label="Secciones de configuración" className="w-full items-stretch bg-transparent p-0">
							{TABS.map(({ value, label, icon: Icon }) => (
								<TabsTrigger key={value} value={value} aria-label={label}>
									<Icon />
									<span>{label}</span>
									{value === 'admin' && me.admin && (
										<span className="ml-auto size-1.5 rounded-full bg-info" aria-label="Administrador activo" />
									)}
								</TabsTrigger>
							))}
						</TabsList>
					</div>
					{visited.has('ai') && (
						<Panel value="ai" active={active}>
							<ProviderSettings />
						</Panel>
					)}
					{visited.has('access') && (
						<Panel value="access" active={active}>
							<Accesses agents={agents.filter((a) => a.person_id === me.id)} />
						</Panel>
					)}
					{active === 'monitor' && (
						<Panel value="monitor" active={active}>
							<Monitor key={String(me.admin)} me={me} />
						</Panel>
					)}
					{visited.has('admin') && (
						<Panel value="admin" active={active}>
							<Admin me={me} pinIsSet={pinIsSet} onChanged={onChanged} />
						</Panel>
					)}
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}

function Panel({ value, active, children }: { value: SettingsTab; active: SettingsTab; children: ReactNode }) {
	return (
		<TabsContent value={value} forceMount hidden={active !== value} className="agent-settings-panel">
			<ScrollArea type="auto" className="agent-settings-scroll h-full min-w-0">
				<div className="agent-settings-content">{children}</div>
			</ScrollArea>
		</TabsContent>
	);
}
