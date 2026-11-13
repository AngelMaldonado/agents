import { lazy, Suspense } from 'react';
import { useAgentChannels } from './Channels';
import { Button } from '@/components/ui/button';

const ScheduleCalendar = lazy(() =>
	import('@/components/schedule-calendar').then((module) => ({ default: module.ScheduleCalendar })),
);

/** Owner-only settings content; DBOS remains authoritative for schedule execution. */
export function AgentSchedules({ agentId }: { agentId: number }) {
	const { v, error, call } = useAgentChannels(agentId);
	if (!v)
		return (
			<div className="py-4">
				{error ? (
					<p role="alert" className="error">
						{error}{' '}
						<Button variant="outline" size="sm" onClick={() => void call('/channels', 'GET')}>
							Reintentar horarios
						</Button>
					</p>
				) : (
					<p role="status" className="muted">
						Cargando horarios…
					</p>
				)}
			</div>
		);
	return (
		<>
			{error && (
				<p role="alert" className="error mb-4">
					{error}
				</p>
			)}
			<Suspense
				fallback={
					<p role="status" className="muted">
						Cargando agenda…
					</p>
				}
			>
				<ScheduleCalendar
					// As big as the settings let it: the calendar is the whole tab.
					height={Math.max(560, window.innerHeight - 280)}
					schedules={v.schedules}
					timezone={v.timezone}
					add={(cron, message) => call('/schedules', 'POST', { cron, message })}
					toggle={(schedule) =>
						call(
							`/schedules/${encodeURIComponent(schedule.name)}/${schedule.status === 'PAUSED' ? 'resume' : 'pause'}`,
							'POST',
						)
					}
					remove={(schedule) => call(`/schedules/${encodeURIComponent(schedule.name)}`, 'DELETE')}
				/>
			</Suspense>
		</>
	);
}
