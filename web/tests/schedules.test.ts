import { describe, expect, test } from 'bun:test';
import { cronFromDraft, expandSchedules, SCHEDULE_TZ, type ScheduleDraft } from '../src/lib/schedules';
const base: ScheduleDraft = { frequency: 'weekdays', hour: 9, minute: 30, days: [1, 3], dayOfMonth: 31, cron: '0 9 * * 1-5' };
const schedule = { name: 'test', cron: '0 9 * * 1-5', message: 'Revisar fuentes', status: 'ACTIVE' };
describe('schedule editor', () => {
 test('daily, weekdays, sorted weekly and monthly rules preserve local time', () => {
  expect(cronFromDraft(base)).toBe('30 9 * * 1-5');
  expect(cronFromDraft({ ...base, frequency: 'daily' })).toBe('30 9 * * *');
  expect(cronFromDraft({ ...base, frequency: 'weekly', days: [3, 1, 3, 0] })).toBe('30 9 * * 0,1,3');
  expect(cronFromDraft({ ...base, frequency: 'monthly' })).toBe('30 9 31 * *');
 });
 test('does not invent weekdays or accept invalid time/month-day', () => {
  expect(() => cronFromDraft({ ...base, frequency: 'weekly', days: [] })).toThrow('al menos un día');
  expect(() => cronFromDraft({ ...base, hour: 24 })).toThrow('hora válida');
  expect(() => cronFromDraft({ ...base, minute: NaN })).toThrow('hora válida');
  expect(() => cronFromDraft({ ...base, frequency: 'monthly', dayOfMonth: 0 })).toThrow('entre 1 y 31');
 });
 test('custom cron accepts five fields and rejects malformed rules', () => {
  expect(cronFromDraft({ ...base, frequency: 'custom', cron: '  */15 8-17 * * 1-5  ' })).toBe('*/15 8-17 * * 1-5');
  expect(() => cronFromDraft({ ...base, frequency: 'custom', cron: '0 0 9 * * *' })).toThrow('cinco campos');
  expect(() => cronFromDraft({ ...base, frequency: 'custom', cron: '70 9 * * *' })).toThrow();
 });
});
describe('calendar projection, never schedule execution', () => {
 test('uses Mexico City time even after obsolete DST dates and includes range start, excludes end', () => {
  const projected = expandSchedules([schedule], '2026-10-26T09:00:00-06:00', '2026-10-28T09:00:00-06:00', SCHEDULE_TZ);
  expect(projected.events.map(event => event.start)).toEqual(['2026-10-26T15:00:00.000Z', '2026-10-27T15:00:00.000Z']);
  expect(projected.invalid).toEqual([]); expect(projected.limited).toEqual([]);
 });
 test('existing custom rules and pauses are preserved, no fictitious duration', () => {
  const existing = { ...schedule, cron: '0 8,17 * * 1', status: 'PAUSED' };
  const before = structuredClone(existing);
  const { events } = expandSchedules([existing], '2026-10-26T00:00:00-06:00', '2026-10-27T00:00:00-06:00');
  expect(events.length).toBe(2); expect(events[0].classNames).toEqual(['schedule-paused']);
  expect(events[0].title).toContain('(Pausa)'); expect('end' in events[0]).toBe(false); expect(existing).toEqual(before);
 });
 test('bounds dense rules and isolates malformed rules', () => {
  const { events, limited, invalid } = expandSchedules([{ ...schedule, cron: '* * * * *' }, { ...schedule, name: 'bad', cron: 'bad' }], '2026-10-26T00:00:00-06:00', '2026-11-02T00:00:00-06:00');
  // Seven days, one block each: a dense rule is drawn per day, never cut after the first days.
  expect(events.length).toBe(7); expect(events[0].title).toBe('1440× · Revisar fuentes'); expect(limited).toEqual([]); expect(invalid).toEqual(['bad']);
  const month = expandSchedules([{ ...schedule, cron: '* * * * *' }], '2026-10-01T00:00:00Z', '2026-11-30T00:00:00Z');
  expect(month.limited).toEqual(['test']);
 });
 test('every 15 minutes every day covers every day of the week (the agenda used to stop on Tuesday)', () => {
  const { events, limited } = expandSchedules([{ ...schedule, cron: '*/15 * * * *' }, { ...schedule, name: 'daily', cron: '45 13 * * *' }], '2026-10-26T00:00:00-06:00', '2026-11-02T00:00:00-06:00', SCHEDULE_TZ);
  const dense = events.filter(e => e.extendedProps.scheduleName === 'test');
  expect(dense.length).toBe(7); expect(dense.every(e => e.title.startsWith('96× ') && e.classNames.includes('schedule-dense'))).toBe(true);
  expect(dense[0].start).toBe('2026-10-26T06:00:00.000Z'); expect(dense[0].end).toBe('2026-10-27T06:00:00.000Z');
  expect(events.filter(e => e.extendedProps.scheduleName === 'daily').length).toBe(7); expect(limited).toEqual([]);
 });
 test('rejects invalid/excessive range rather than unbounded expansion', () => {
  expect(expandSchedules([schedule], 'bad', 'bad').events).toEqual([]);
  expect(expandSchedules([schedule], '2026-01-01', '2027-01-01').invalid.length).toBe(1);
 });
});
