import { describe, expect, it } from 'vitest';
import { ScheduleError, nextRunAt, normalizeSchedule, scheduleLabel, validateCron } from '../src/scheduling/schedule';

const TZ = 'Asia/Shanghai';

describe('normalizeSchedule', () => {
  it('converts daily presets to cron', () => {
    expect(normalizeSchedule({ preset: 'daily', time: '09:05', timezone: TZ })).toMatchObject({
      cron: '5 9 * * *',
      timezone: TZ,
      preset: { preset: 'daily', time: '09:05' },
      label: '每天 09:05',
    });
  });

  it('converts weekday and weekly presets', () => {
    expect(normalizeSchedule({ preset: 'weekdays', time: '8:00', timezone: TZ }).cron).toBe('0 8 * * 1-5');
    expect(
      normalizeSchedule({ preset: 'weekly', time: '09:30', days: [5, 1, 3, 3], timezone: TZ }),
    ).toMatchObject({
      cron: '30 9 * * 1,3,5',
      preset: { preset: 'weekly', time: '09:30', days: [1, 3, 5] },
      label: '每周一、周三、周五 09:30',
    });
  });

  it('converts interval presets', () => {
    expect(normalizeSchedule({ preset: 'every_minutes', every: 15, timezone: TZ })).toMatchObject({
      cron: '*/15 * * * *',
      label: '每 15 分钟',
    });
    expect(normalizeSchedule({ preset: 'every_hours', every: 6, timezone: TZ })).toMatchObject({
      cron: '0 */6 * * *',
      label: '每 6 小时',
    });
  });

  it('accepts a raw 5-field cron and rejects seconds/macros', () => {
    expect(normalizeSchedule({ cron: '30 9 * * 1,3,5', timezone: TZ })).toMatchObject({
      cron: '30 9 * * 1,3,5',
      preset: null,
      label: '每周一、周三、周五 09:30',
    });
    expect(() => normalizeSchedule({ cron: '0 0 9 * * *', timezone: TZ })).toThrow(ScheduleError);
    expect(() => normalizeSchedule({ cron: '@daily', timezone: TZ })).toThrow(ScheduleError);
  });

  it('rejects invalid presets', () => {
    expect(() => normalizeSchedule({ preset: 'daily', time: '24:00', timezone: TZ })).toThrow(ScheduleError);
    expect(() => normalizeSchedule({ preset: 'weekly', time: '09:00', days: [], timezone: TZ })).toThrow(
      ScheduleError,
    );
    expect(() => normalizeSchedule({ preset: 'weekly', time: '09:00', days: [7], timezone: TZ })).toThrow(
      ScheduleError,
    );
    expect(() => normalizeSchedule({ preset: 'every_minutes', every: 7, timezone: TZ })).toThrow(ScheduleError);
    expect(() => normalizeSchedule({ preset: 'every_hours', every: 5, timezone: TZ })).toThrow(ScheduleError);
    expect(() => normalizeSchedule({ preset: 'daily', time: '09:00', timezone: 'Nope/Nowhere' })).toThrow(
      ScheduleError,
    );
  });
});

describe('nextRunAt', () => {
  it('returns the next occurrence strictly after the given instant', () => {
    const beforeNine = Date.parse('2026-10-23T16:00:00Z'); // 2026-10-24 00:00 +08
    expect(nextRunAt('0 9 * * *', TZ, beforeNine)).toBe(Date.parse('2026-10-24T01:00:00Z'));

    const exactlyNine = Date.parse('2026-10-24T01:00:00Z'); // 09:00 +08
    expect(nextRunAt('0 9 * * *', TZ, exactlyNine)).toBe(Date.parse('2026-10-25T01:00:00Z'));
  });

  it('skips to Monday for weekday schedules', () => {
    const saturday = Date.parse('2026-10-24T02:00:00Z'); // Sat 10:00 +08
    expect(nextRunAt('0 9 * * 1-5', TZ, saturday)).toBe(Date.parse('2026-10-26T01:00:00Z'));
  });

  it('handles minute and hour intervals', () => {
    const after = Date.parse('2026-10-24T00:07:00Z');
    expect(nextRunAt('*/15 * * * *', TZ, after)).toBe(Date.parse('2026-10-24T00:15:00Z'));
    expect(nextRunAt('0 */6 * * *', TZ, after)).toBe(Date.parse('2026-10-24T04:00:00Z')); // 12:00 +08
  });

  it('keeps wall-clock time across a DST transition', () => {
    const beforeDst = Date.parse('2026-03-07T12:00:00Z'); // 07:00 EST
    expect(nextRunAt('0 9 * * *', 'America/New_York', beforeDst)).toBe(Date.parse('2026-03-07T14:00:00Z'));
    const afterDst = Date.parse('2026-03-08T12:00:00Z'); // 08:00 EDT
    expect(nextRunAt('0 9 * * *', 'America/New_York', afterDst)).toBe(Date.parse('2026-03-08T13:00:00Z'));
  });
});

describe('validateCron / scheduleLabel', () => {
  it('normalizes whitespace and falls back for unknown shapes', () => {
    expect(validateCron('  5   9 * * *  ', TZ)).toBe('5 9 * * *');
    expect(scheduleLabel('5 9 1 * *')).toBe('cron: 5 9 1 * *');
  });
});
