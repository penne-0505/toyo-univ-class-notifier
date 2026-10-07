/**
 * data/academic-schedule.json（手書きの学年暦）を読み、指定日（既定: 今日 JST）に
 * 進行中・直近の期間と、各曜日が第何回授業日かを表示する。
 *
 * Usage:
 *   npm run toyo:schedule
 *   npm run toyo:schedule -- --date 2026-10-07
 *   npm run toyo:schedule -- --date 2026-10-07 --format json
 */

import {
  academicSchedulePath,
  describePeriodTime,
  jstDateString,
  loadAcademicSchedule,
  periodsAround,
  sessionNumberFor,
  termFor,
  weekdayLabel,
} from '../lib/toyo-academic-schedule';

export { sessionNumberFor } from '../lib/toyo-academic-schedule';

const WEEKDAYS = ['月', '火', '水', '木', '金', '土'] as const;

function usage(): string {
  return [
    'Usage:',
    '  npm run toyo:schedule',
    '  npm run toyo:schedule -- --date 2026-10-07',
    '  npm run toyo:schedule -- --date 2026-10-07 --format json',
    '',
    'Options:',
    '  --date YYYY-MM-DD       基準日（既定: 今日 JST）',
    '  --horizon-days <n>      n 日以内に始まる期間を upcoming として出す（既定 7）',
    '  --format text|json',
  ].join('\n');
}

function parseArgs(argv: string[]): { date: string; horizonDays: number; format: 'text' | 'json' } {
  let date = jstDateString(new Date());
  let horizonDays = 7;
  let format: 'text' | 'json' = 'text';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--date') {
      const value = argv[index + 1];
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('--date must be YYYY-MM-DD.');
      date = value;
      index += 1;
    } else if (arg === '--horizon-days') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 0) throw new Error('--horizon-days must be >= 0.');
      horizonDays = value;
      index += 1;
    } else if (arg === '--format') {
      const value = argv[index + 1];
      if (value !== 'text' && value !== 'json') throw new Error('--format must be text or json.');
      format = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  return { date, horizonDays, format };
}

function nearestSession(
  date: string,
  weekday: string,
  direction: 1 | -1,
  schedule: NonNullable<ReturnType<typeof loadAcademicSchedule>>
): { date: string; sessionNumber: number } | null {
  const base = Date.parse(`${date}T00:00:00Z`);
  for (let offset = direction === -1 ? 0 : 1; offset <= 14; offset += 1) {
    const candidate = new Date(base + direction * offset * 86_400_000).toISOString().slice(0, 10);
    const sessionNumber = sessionNumberFor(candidate, weekday, schedule);
    if (sessionNumber !== null) return { date: candidate, sessionNumber };
  }
  return null;
}

export function main(): void {
  const { date, horizonDays, format } = parseArgs(process.argv.slice(2));
  const schedule = loadAcademicSchedule();
  if (!schedule) {
    console.error(`academic-schedule.json が読めません: ${academicSchedulePath}`);
    process.exit(1);
  }

  const periods = periodsAround(date, { horizonDays }, schedule);
  const term = termFor(date, schedule);
  const naturalWeekday = weekdayLabel(date);
  const sessions = WEEKDAYS.map((weekday) => ({
    weekday,
    sessionNumber: sessionNumberFor(date, weekday, schedule),
    last: nearestSession(date, weekday, -1, schedule),
    next: nearestSession(date, weekday, 1, schedule),
  }));
  const todaySession = sessionNumberFor(date, naturalWeekday, schedule);

  if (format === 'json') {
    console.log(
      JSON.stringify(
        { date, weekday: naturalWeekday, term, todaySessionNumber: todaySession, sessions, periods },
        null,
        2
      )
    );
    return;
  }

  console.log(`基準日: ${date} (${naturalWeekday})`);
  console.log(
    `学期: ${term ? `${term.semester}（通常授業開始 ${term.classesStart}）` : '授業期間外 / 不明'}`
  );
  console.log(
    `今日の授業回: ${todaySession === null ? 'なし（授業日でない / 計算不可）' : `${naturalWeekday}曜 第${todaySession}回`}`
  );
  console.log('');
  console.log('各曜日の直近の授業日（基準日以前で最新 / 基準日より後で最初）:');
  for (const entry of sessions) {
    const last = nearestSession(date, entry.weekday, -1, schedule);
    const next = nearestSession(date, entry.weekday, 1, schedule);
    const fmt = (hit: { date: string; sessionNumber: number } | null): string =>
      hit ? `${hit.date.slice(5)} 第${hit.sessionNumber}回` : '-';
    console.log(`  ${entry.weekday}: 前回 ${fmt(last)} / 次回 ${fmt(next)}`);
  }
  console.log('');
  for (const [status, title] of [
    ['active', '進行中'],
    ['upcoming', `${horizonDays}日以内に開始`],
    ['recent', '直近で終了'],
  ] as const) {
    const items = periods.filter((period) => period.status === status);
    console.log(`${title}:`);
    if (items.length === 0) console.log('  なし');
    for (const period of items) {
      const offset =
        status === 'upcoming' ? ` [${period.daysOffset}日後]` : status === 'recent' ? ` [${period.daysOffset}日前${period.end ? 'に終了' : ''}]` : '';
      console.log(`  - [${period.semester}] ${period.label}: ${describePeriodTime(period)}${offset}`);
      if (period.note) console.log(`      ${period.note}`);
    }
  }
  if (schedule.unknown?.length) {
    console.log('');
    console.log(`未確認項目（unknown）: ${schedule.unknown.length} 件。詳細は academic-schedule.json を参照。`);
  }
}
