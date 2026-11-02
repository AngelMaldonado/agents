import { CronExpressionParser } from 'cron-parser';

export type Schedule = { name: string; cron: string; message: string; status: string; timezone?: string };
export type ScheduleDraft = {
	frequency: 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';
	hour: number;
	minute: number;
	days: number[];
	dayOfMonth: number;
	cron: string;
};
export const SCHEDULE_TZ = 'America/Mexico_City';

const CITIES: Record<string, string> = {
	Mexico_City: 'Ciudad de México',
	Cancun: 'Cancún',
	Merida: 'Mérida',
	Mazatlan: 'Mazatlán',
	Bogota: 'Bogotá',
	New_York: 'Nueva York',
	Los_Angeles: 'Los Ángeles',
	Sao_Paulo: 'São Paulo',
};
/** A time zone for people: «Hora de Ciudad de México (GMT-6)» instead of «America/Mexico_City». */
export function zoneLabel(timezone: string) {
	const id = timezone.split('/').pop() ?? timezone;
	const city = CITIES[id] ?? id.replace(/_/g, ' ');
	try {
		const offset = new Intl.DateTimeFormat('es-MX', { timeZone: timezone, timeZoneName: 'shortOffset' })
			.formatToParts(new Date())
			.find((p) => p.type === 'timeZoneName')?.value;
		return timezone === 'UTC' ? 'UTC' : `Hora de ${city}${offset ? ` (${offset})` : ''}`;
	} catch {
		return timezone;
	}
}
export function cronFromDraft(draft: ScheduleDraft) {
	if (draft.frequency === 'custom') {
		const cron = draft.cron.trim();
		if (cron.split(/\s+/).length !== 5) throw new Error('El cron necesita cinco campos.');
		CronExpressionParser.parse(cron, { tz: SCHEDULE_TZ });
		return cron;
	}
	if (
		!Number.isInteger(draft.hour) ||
		draft.hour < 0 ||
		draft.hour > 23 ||
		!Number.isInteger(draft.minute) ||
		draft.minute < 0 ||
		draft.minute > 59
	)
		throw new Error('Elige una hora válida.');
	const time = `${draft.minute} ${draft.hour}`;
	if (draft.frequency === 'daily') return `${time} * * *`;
	if (draft.frequency === 'weekdays') return `${time} * * 1-5`;
	if (draft.frequency === 'weekly') {
		if (!draft.days.length || draft.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
			throw new Error('Elige al menos un día de la semana.');
		return `${time} * * ${[...new Set(draft.days)].sort().join(',')}`;
	}
	if (!Number.isInteger(draft.dayOfMonth) || draft.dayOfMonth < 1 || draft.dayOfMonth > 31)
		throw new Error('El día del mes debe estar entre 1 y 31.');
	return `${time} ${draft.dayOfMonth} * *`;
}

/** More firings than this in one day are drawn as one block for the day, not one event each. */
export const DENSE_PER_DAY = 12;
const SCAN_PER_SCHEDULE = 20000; // covers every 15 min for 63 days; a per-minute rule over weeks stops here
type CalendarEvent = {
	id: string;
	title: string;
	start: string;
	end?: string;
	classNames: string[];
	extendedProps: { scheduleName: string };
};
/** Projection only. DBOS remains authoritative; no schedule is changed by browsing a range. */
export function expandSchedules(schedules: Schedule[], start: string, end: string, timezone = SCHEDULE_TZ) {
	const events: CalendarEvent[] = [];
	const limited: string[] = [],
		invalid: string[] = [];
	const from = new Date(start).getTime(),
		until = new Date(end).getTime();
	if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from || until - from > 63 * 86400000)
		return { events, limited, invalid: ['Rango de agenda inválido.'] };
	for (const schedule of schedules) {
		if (events.length >= 1000) {
			limited.push(schedule.name);
			continue;
		}
		const tz = schedule.timezone || timezone,
			paused = schedule.status === 'PAUSED',
			prefix = paused ? '(Pausa) ' : '';
		const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
		try {
			const interval = CronExpressionParser.parse(schedule.cron, {
				tz,
				currentDate: new Date(from - 1),
				endDate: new Date(until - 1),
			});
			const byDay = new Map<string, Date[]>();
			let scanned = 0;
			while (scanned < SCAN_PER_SCHEDULE && interval.hasNext()) {
				const date = interval.next().toDate(),
					key = day.format(date);
				byDay.set(key, [...(byDay.get(key) ?? []), date]);
				scanned++;
			}
			if (interval.hasNext()) limited.push(schedule.name);
			for (const [key, dates] of byDay) {
				if (events.length >= 1000) {
					if (!limited.includes(schedule.name)) limited.push(schedule.name);
					break;
				}
				if (dates.length > DENSE_PER_DAY) {
					// A dense rule (every 15 min…) covers the day as one block from its first to its last firing.
					const first = dates[0],
						last = dates[dates.length - 1];
					events.push({
						id: `${schedule.name}:${key}`,
						title: `${prefix}${dates.length}× · ${schedule.message}`,
						start: first.toISOString(),
						end: new Date(last.getTime() + 15 * 60000).toISOString(),
						classNames: ['schedule-dense', ...(paused ? ['schedule-paused'] : [])],
						extendedProps: { scheduleName: schedule.name },
					});
				} else
					for (const date of dates) {
						if (events.length >= 1000) break;
						events.push({
							id: `${schedule.name}:${date.toISOString()}`,
							title: `${prefix}${schedule.message}`,
							start: date.toISOString(),
							classNames: paused ? ['schedule-paused'] : [],
							extendedProps: { scheduleName: schedule.name },
						});
					}
			}
		} catch {
			invalid.push(schedule.name);
		}
	}
	return { events, limited, invalid };
}

/** The next `count` times a cron fires, for reading a proposal; [] when it does not parse. */
export function nextRuns(cron: string, count = 3, timezone = SCHEDULE_TZ) {
	try {
		const interval = CronExpressionParser.parse(cron, { tz: timezone });
		return Array.from({ length: count }, () => interval.next().toDate());
	} catch {
		return [];
	}
}
