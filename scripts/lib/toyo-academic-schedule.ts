import fsSync from 'node:fs';
import path from 'node:path';
import { dataDir, outputDir } from './toyo-enrollment';

/**
 * data/academic-schedule.json（手書きの静的データ）を読んで計算するだけのライブラリ。
 * ファイルが無い・壊れている場合は null / 空配列を返し、呼び出し側を壊さない。
 */

export type AcademicPeriodKind =
  | 'registration'
  | 'special-class'
  | 'classes-start'
  | 'lottery-announce'
  | 'lottery-result'
  | 'add-registration'
  | 'confirmation-print'
  | 'withdrawal'
  | 'withdrawal-result'
  | 'grade-release'
  | string;

export type AcademicPeriod = {
  kind: AcademicPeriodKind;
  semester: string;
  label: string;
  /** ISO8601 JST。dateOnly の場合は YYYY-MM-DD（終日扱い）。 */
  start: string;
  /** end が null のものは「その日だけの出来事 / 以降」を表し、start の日を 1 日だけの期間として扱う。 */
  end: string | null;
  dateOnly?: boolean;
  note: string;
};

export type AcademicTerm = {
  semester: string;
  classesStart: string;
  classesEnd: string | null;
  examPeriod: { start: string; end: string } | null;
  noClassDays: string[];
  makeupDays: { date: string; asWeekday: string }[];
};

export type AcademicSchedule = {
  academicYear: string;
  source: string;
  periods: AcademicPeriod[];
  terms: AcademicTerm[];
  unknown?: string[];
};

export type PeriodStatus = 'active' | 'upcoming' | 'recent';

export type PeriodView = AcademicPeriod & {
  status: PeriodStatus;
  startDate: string;
  endDate: string;
  /** 日付差（status=upcoming: 開始まで / recent: 終了から）。active は 0。 */
  daysOffset: number;
};

export const academicSchedulePath = path.join(dataDir, 'academic-schedule.json');
const academicCalendarPath = path.join(outputDir, 'academic-calendar.json');

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const;
/** classesEnd が null のときに授業期間とみなす上限日数（15 週 = 13 週 + 予備）。 */
const MAX_TERM_DAYS_WITHOUT_END = 7 * 16;

let scheduleCache: { value: AcademicSchedule | null } | undefined;
let holidayCache: { value: Set<string> } | undefined;

export function loadAcademicSchedule(): AcademicSchedule | null {
  if (scheduleCache) return scheduleCache.value;
  let value: AcademicSchedule | null = null;
  try {
    const parsed = JSON.parse(fsSync.readFileSync(academicSchedulePath, 'utf8')) as Partial<AcademicSchedule>;
    if (Array.isArray(parsed.periods) && Array.isArray(parsed.terms)) {
      value = parsed as AcademicSchedule;
    }
  } catch {
    value = null;
  }
  scheduleCache = { value };
  return value;
}

export function loadNationalHolidays(): Set<string> {
  if (holidayCache) return holidayCache.value;
  const value = new Set<string>();
  try {
    const parsed = JSON.parse(fsSync.readFileSync(academicCalendarPath, 'utf8')) as {
      nationalHolidays?: { date: string }[];
    };
    for (const holiday of parsed.nationalHolidays ?? []) value.add(holiday.date);
  } catch {
    // 祝日データなしでも計算は続ける
  }
  holidayCache = { value };
  return value;
}

// ---- 日付ユーティリティ（YYYY-MM-DD を UTC 0:00 の日番号として扱う） ----

export function jstDateString(date: Date): string {
  return new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

function dayNumber(isoDate: string): number {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return Number.NaN;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000);
}

function dateFromDayNumber(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

function weekdayOfDayNumber(day: number): number {
  return new Date(day * 86_400_000).getUTCDay();
}

export function normalizeWeekday(weekday: string | number): number | null {
  if (typeof weekday === 'number') {
    return Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday : null;
  }
  const index = WEEKDAY_LABELS.indexOf(weekday.trim().slice(0, 1) as (typeof WEEKDAY_LABELS)[number]);
  return index >= 0 ? index : null;
}

export function weekdayLabel(isoDate: string): string {
  return WEEKDAY_LABELS[weekdayOfDayNumber(dayNumber(isoDate))] ?? '?';
}

/** その日を含む学期（term）。classesStart 以降で最も新しい term のうち、終了を過ぎていないもの。 */
export function termFor(isoDate: string, schedule: AcademicSchedule | null = loadAcademicSchedule()): AcademicTerm | null {
  if (!schedule) return null;
  const target = dayNumber(isoDate);
  if (!Number.isFinite(target)) return null;
  const candidates = schedule.terms
    .filter((term) => Number.isFinite(dayNumber(term.classesStart)) && dayNumber(term.classesStart) <= target)
    .sort((a, b) => dayNumber(b.classesStart) - dayNumber(a.classesStart));
  const term = candidates[0];
  if (!term) return null;
  const end = term.classesEnd
    ? dayNumber(term.classesEnd)
    : dayNumber(term.classesStart) + MAX_TERM_DAYS_WITHOUT_END;
  return target <= end ? term : null;
}

/**
 * date が weekday 曜日の「第何回授業日」か。通常授業開始日から数え、祝日と noClassDays を除き、
 * makeupDays（date を asWeekday として扱う）を考慮する。
 * date がその曜日の授業日でない（祝日・休講日・曜日違い・授業開始前・期間外）場合は null。
 */
export function sessionNumberFor(
  date: string | Date,
  weekday: string | number,
  schedule: AcademicSchedule | null = loadAcademicSchedule(),
  holidays: Set<string> = loadNationalHolidays()
): number | null {
  const isoDate = typeof date === 'string' ? date.slice(0, 10) : jstDateString(date);
  const target = normalizeWeekday(weekday);
  if (target === null) return null;
  const term = termFor(isoDate, schedule);
  if (!term) return null;

  const noClass = new Set(term.noClassDays);
  const makeup = new Map<string, number>();
  for (const day of term.makeupDays) {
    const asWeekday = normalizeWeekday(day.asWeekday);
    if (asWeekday !== null) makeup.set(day.date, asWeekday);
  }

  const classWeekday = (isoDay: string, day: number): number | null => {
    const forced = makeup.get(isoDay);
    if (forced !== undefined) return forced; // 振替日は祝日・休講扱いより優先
    if (noClass.has(isoDay) || holidays.has(isoDay)) return null;
    return weekdayOfDayNumber(day);
  };

  const targetDay = dayNumber(isoDate);
  if (classWeekday(isoDate, targetDay) !== target) return null;

  let count = 0;
  for (let day = dayNumber(term.classesStart); day <= targetDay; day += 1) {
    if (classWeekday(dateFromDayNumber(day), day) === target) count += 1;
  }
  return count > 0 ? count : null;
}

function periodDayRange(period: AcademicPeriod): { start: number; end: number } | null {
  const start = dayNumber(period.start);
  if (!Number.isFinite(start)) return null;
  const end = period.end ? dayNumber(period.end) : start;
  return { start, end: Number.isFinite(end) ? end : start };
}

/**
 * 日単位で期間を分類する。active: その日を含む / upcoming: horizonDays 日以内に始まる /
 * recent: recentDays 日以内に終わった。
 */
export function periodsAround(
  date: string | Date,
  options: { horizonDays?: number; recentDays?: number } = {},
  schedule: AcademicSchedule | null = loadAcademicSchedule()
): PeriodView[] {
  if (!schedule) return [];
  const horizonDays = options.horizonDays ?? 7;
  const recentDays = options.recentDays ?? 7;
  const today = dayNumber(typeof date === 'string' ? date : jstDateString(date));
  if (!Number.isFinite(today)) return [];

  const views: PeriodView[] = [];
  for (const period of schedule.periods) {
    const range = periodDayRange(period);
    if (!range) continue;
    const base = {
      ...period,
      startDate: dateFromDayNumber(range.start),
      endDate: dateFromDayNumber(range.end),
    };
    if (range.start <= today && today <= range.end) {
      views.push({ ...base, status: 'active', daysOffset: 0 });
    } else if (range.start > today && range.start - today <= horizonDays) {
      views.push({ ...base, status: 'upcoming', daysOffset: range.start - today });
    } else if (range.end < today && today - range.end <= recentDays) {
      views.push({ ...base, status: 'recent', daysOffset: today - range.end });
    }
  }
  return views.sort((a, b) => a.start.localeCompare(b.start));
}

export function describePeriodTime(period: AcademicPeriod): string {
  const fmt = (value: string): string => {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/);
    if (!match) return value;
    const md = `${Number(match[2])}/${Number(match[3])}(${weekdayLabel(value)})`;
    return match[4] ? `${md} ${match[4]}` : md;
  };
  if (!period.end) return `${fmt(period.start)}〜`;
  return `${fmt(period.start)} 〜 ${fmt(period.end)}`;
}
