import { CronExpressionParser } from 'cron-parser';
import type { ScheduleInput, SchedulePresetInput } from '../types/api.js';

/**
 * Schedule parsing and next-occurrence math.
 *
 * Clients speak structured presets; the daemon stores and evaluates a 5-field
 * cron expression. Keeping cron as the single source of truth means API/MCP
 * callers can pass a cron directly, while the UI never has to build one.
 */

export class ScheduleError extends Error {
  readonly code = 'schedule_invalid' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ScheduleError';
  }
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;
const MINUTE_DIVISORS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30] as const;
const HOUR_DIVISORS = [1, 2, 3, 4, 6, 8, 12] as const;

export interface NormalizedSchedule {
  cron: string;
  timezone: string;
  preset: SchedulePresetInput | null;
  label: string;
}

export function daemonTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function resolveTimeZone(timezone?: string): string {
  const zone = typeof timezone === 'string' && timezone.trim() ? timezone.trim() : daemonTimeZone();
  try {
    // Throws RangeError for an unknown IANA zone.
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new ScheduleError(`unknown timezone: ${zone}`);
  }
  return zone;
}

/** Split into exactly five non-empty fields; cron-parser also accepts seconds. */
function cronFields(expression: string): string[] {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ScheduleError('cron must have exactly 5 fields (minute hour day month weekday)');
  }
  return fields;
}

export function validateCron(expression: string, timezone: string): string {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new ScheduleError('cron is required');
  }
  if (expression.trim().startsWith('@')) {
    throw new ScheduleError('predefined cron macros are not supported');
  }
  const fields = cronFields(expression);
  const normalized = fields.join(' ');
  try {
    CronExpressionParser.parse(normalized, { tz: timezone });
  } catch (err) {
    throw new ScheduleError(`invalid cron: ${err instanceof Error ? err.message : String(err)}`);
  }
  return normalized;
}

function parseTime(value: unknown): { hour: number; minute: number; text: string } {
  if (typeof value !== 'string') throw new ScheduleError('time is required (HH:MM)');
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new ScheduleError('time must be HH:MM');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new ScheduleError('time must be HH:MM');
  return { hour, minute, text: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

function parseDays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ScheduleError('days must contain at least one weekday');
  }
  const days = [...new Set(value)].map((day) => {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new ScheduleError('days must be integers 0-6 (Sunday = 0)');
    }
    return day as number;
  });
  return days.sort((a, b) => a - b);
}

function normalizePreset(input: SchedulePresetInput): SchedulePresetInput {
  switch (input.preset) {
    case 'daily':
    case 'weekdays': {
      const time = parseTime(input.time);
      return { preset: input.preset, time: time.text };
    }
    case 'weekly': {
      const time = parseTime(input.time);
      return { preset: 'weekly', time: time.text, days: parseDays(input.days) };
    }
    case 'every_minutes': {
      const every = input.every;
      if (!Number.isInteger(every) || !MINUTE_DIVISORS.includes(every as (typeof MINUTE_DIVISORS)[number])) {
        throw new ScheduleError(`every_minutes must be one of ${MINUTE_DIVISORS.join(', ')}`);
      }
      return { preset: 'every_minutes', every };
    }
    case 'every_hours': {
      const every = input.every;
      if (!Number.isInteger(every) || !HOUR_DIVISORS.includes(every as (typeof HOUR_DIVISORS)[number])) {
        throw new ScheduleError(`every_hours must be one of ${HOUR_DIVISORS.join(', ')}`);
      }
      return { preset: 'every_hours', every };
    }
    default:
      throw new ScheduleError(`unknown schedule preset: ${String((input as { preset?: unknown }).preset)}`);
  }
}

function presetToCron(preset: SchedulePresetInput): string {
  switch (preset.preset) {
    case 'daily': {
      const { hour, minute } = parseTime(preset.time);
      return `${minute} ${hour} * * *`;
    }
    case 'weekdays': {
      const { hour, minute } = parseTime(preset.time);
      return `${minute} ${hour} * * 1-5`;
    }
    case 'weekly': {
      const { hour, minute } = parseTime(preset.time);
      return `${minute} ${hour} * * ${parseDays(preset.days).join(',')}`;
    }
    case 'every_minutes':
      return `*/${preset.every} * * * *`;
    case 'every_hours':
      return `0 */${preset.every} * * *`;
  }
}

export function normalizeSchedule(input: ScheduleInput): NormalizedSchedule {
  if (!input || typeof input !== 'object') throw new ScheduleError('schedule is required');
  const timezone = resolveTimeZone((input as { timezone?: string }).timezone);
  if ('cron' in input) {
    const cron = validateCron(input.cron, timezone);
    return { cron, timezone, preset: null, label: scheduleLabel(cron) };
  }
  const preset = normalizePreset(input);
  const cron = validateCron(presetToCron(preset), timezone);
  return { cron, timezone, preset, label: scheduleLabel(cron) };
}

/** The next occurrence strictly after `afterMs`. */
export function nextRunAt(cron: string, timezone: string, afterMs: number): number {
  validateCron(cron, timezone);
  try {
    const interval = CronExpressionParser.parse(cron, {
      currentDate: new Date(afterMs),
      tz: timezone,
    });
    const next = interval.next().toDate().getTime();
    if (!Number.isFinite(next) || next <= afterMs) {
      throw new ScheduleError('cron has no future occurrence');
    }
    return next;
  } catch (err) {
    if (err instanceof ScheduleError) throw err;
    throw new ScheduleError(`invalid cron: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseClock(minute: string, hour: string): string | null {
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  const m = Number(minute);
  const h = Number(hour);
  if (m > 59 || h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Best-effort human-readable label; unknown expressions fall back to raw cron. */
export function scheduleLabel(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return `cron: ${cron}`;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  if (minute.startsWith('*/') && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `每 ${minute.slice(2)} 分钟`;
  }
  if (minute === '0' && hour.startsWith('*/') && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `每 ${hour.slice(2)} 小时`;
  }

  const clock = parseClock(minute, hour);
  if (!clock || dayOfMonth !== '*' || month !== '*') return `cron: ${cron}`;

  if (dayOfWeek === '*') return `每天 ${clock}`;
  if (dayOfWeek === '1-5') return `工作日 ${clock}`;

  const days = dayOfWeek.split(',');
  if (days.every((day) => /^[0-6]$/.test(day))) {
    const names = days.map((day) => WEEKDAY_NAMES[Number(day)]).join('、');
    return `每${names} ${clock}`;
  }
  return `cron: ${cron}`;
}
