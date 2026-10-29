import { CronExpressionParser } from 'cron-parser';

export type Schedule = { name: string; cron: string; message: string; status: string; timezone?: string };
export type ScheduleDraft = { frequency: 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom'; hour: number; minute: number; days: number[]; dayOfMonth: number; cron: string };
export const SCHEDULE_TZ = 'America/Mexico_City';
export function cronFromDraft(draft: ScheduleDraft) {
 if (draft.frequency === 'custom') {
  const cron = draft.cron.trim();
  if (cron.split(/\s+/).length !== 5) throw new Error('El cron necesita cinco campos.');
  CronExpressionParser.parse(cron, { tz: SCHEDULE_TZ });
  return cron;
 }
 if (!Number.isInteger(draft.hour) || draft.hour < 0 || draft.hour > 23 || !Number.isInteger(draft.minute) || draft.minute < 0 || draft.minute > 59) throw new Error('Elige una hora válida.');
 const time = `${draft.minute} ${draft.hour}`;
 if (draft.frequency === 'daily') return `${time} * * *`;
 if (draft.frequency === 'weekdays') return `${time} * * 1-5`;
 if (draft.frequency === 'weekly') {
  if (!draft.days.length || draft.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('Elige al menos un día de la semana.');
  return `${time} * * ${[...new Set(draft.days)].sort().join(',')}`;
 }
 if (!Number.isInteger(draft.dayOfMonth) || draft.dayOfMonth < 1 || draft.dayOfMonth > 31) throw new Error('El día del mes debe estar entre 1 y 31.');
 return `${time} ${draft.dayOfMonth} * *`;
}

/** Projection only. DBOS remains authoritative; no schedule is changed by browsing a range. */
export function expandSchedules(schedules: Schedule[], start: string, end: string, timezone = SCHEDULE_TZ) {
 const events: { id: string; title: string; start: string; classNames: string[]; extendedProps: { scheduleName: string } }[] = [];
 const limited: string[] = [], invalid: string[] = [];
 const from = new Date(start).getTime(), until = new Date(end).getTime();
 if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from || until - from > 63 * 86400000) return { events, limited, invalid: ['Rango de agenda inválido.'] };
 for (const schedule of schedules) {
  if (events.length >= 1000) { limited.push(schedule.name); continue; }
  try {
   const interval = CronExpressionParser.parse(schedule.cron, { tz: schedule.timezone || timezone, currentDate: new Date(from - 1), endDate: new Date(until - 1) });
   let count = 0;
   while (count < 200 && events.length < 1000 && interval.hasNext()) {
    const date = interval.next().toISOString();
    events.push({ id: `${schedule.name}:${date}`, title: `${schedule.status === 'PAUSED' ? '(Pausa) ' : ''}${schedule.message}`, start: date!, classNames: schedule.status === 'PAUSED' ? ['schedule-paused'] : [], extendedProps: { scheduleName: schedule.name } });
    count++;
   }
   if (interval.hasNext()) limited.push(schedule.name);
  } catch { invalid.push(schedule.name); }
 }
 return { events, limited, invalid };
}
