#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  jsonOutputPath,
  outputDir,
  repoRoot,
  type EnrollmentData,
} from './lib/toyo-enrollment';
import {
  discordSummaryOutputPath,
  type DetailedClassSummary,
  type DiscordSummary,
} from './lib/toyo-summary';
import { type Assignment, type CourseContent } from './lib/toyonet-ace';
import { type Announcement } from './lib/toyo-announcements';
import {
  academicSchedulePath,
  loadAcademicSchedule,
  periodsAround,
  sessionNumberFor,
  describePeriodTime,
  type PeriodView,
} from './lib/toyo-academic-schedule';
import { findGradingRule, gradingRulesPath, type GradingRule } from './lib/toyo-grading-rules';

type OutputFormat = 'markdown' | 'json';

type CliOptions = {
  forceSync: boolean;
  noSync: boolean;
  maxAgeMinutes: number;
  horizonDays: number;
  format: OutputFormat;
};

type SyncAttempt = {
  status: 'not-needed' | 'skipped-by-option' | 'succeeded' | 'failed';
  reason: string;
  exitCode: number | null;
  outputTail: string[];
};

type AcademicCalendar = {
  fetchedAt?: string;
  available?: boolean;
  academicYear?: string;
  nationalHolidays?: { date: string; name: string }[];
  errors?: string[];
};

type AgentAssignment = Pick<
  Assignment,
  'assignmentId' | 'courseName' | 'title' | 'dueAt' | 'status' | 'sourceUrl' | 'notes'
>;

type AgentContent = Pick<
  CourseContent,
  | 'contentId'
  | 'courseName'
  | 'title'
  | 'contentUrl'
  | 'updatedAt'
  | 'listedAt'
  | 'openFrom'
  | 'openUntil'
>;

type AgentAnnouncement = Pick<
  Announcement,
  'announcementId' | 'category' | 'courseNameHint' | 'title' | 'postedAt' | 'targetDate' | 'sourceUrl'
> & {
  contentPreview: string;
};

type AgentGradingRules = Pick<GradingRule, 'reviewed' | 'components' | 'cutoffs' | 'warnings'>;

type AgentPeriod = Pick<PeriodView, 'kind' | 'semester' | 'label' | 'start' | 'end' | 'note' | 'status' | 'daysOffset'>;

type AgentClass = {
  courseName: string;
  courseCode: string;
  day: string;
  period: string;
  /** その曜日の第何回授業日か。計算できなければ null。 */
  sessionNumber: number | null;
  startsAt: string;
  endsAt: string;
  instructor: string;
  room: string;
  campus: string;
  deliveryMode: string;
  syllabus: {
    sourceUrl: string | null;
    classFormat: string | null;
    grading: string | null;
    firstTopic: string | null;
    preAndPostStudy: string | null;
    textbook: string | null;
  } | null;
  /** data/grading-rules.json にある科目だけ。無ければ null。 */
  gradingRules: AgentGradingRules | null;
  relatedAssignments: AgentAssignment[];
  relatedContents: AgentContent[];
  relatedAnnouncements: AgentAnnouncement[];
  errors: string[];
};

type AgentContext = {
  builtAt: string;
  timezone: 'Asia/Tokyo';
  sync: SyncAttempt;
  freshness: {
    summaryGeneratedAt: string | null;
    ageMinutes: number | null;
    maxAgeMinutes: number;
    stale: boolean;
  };
  today: {
    date: string;
    nationalHoliday: string | null;
    classes: AgentClass[];
  };
  tomorrow: {
    date: string;
    nationalHoliday: string | null;
    classes: AgentClass[];
  };
  /** academic-schedule.json の期間のうち、今日を含むもの（active）と 7 日以内に始まるもの（upcoming）。 */
  periods: {
    /** 基準日（実行時点の JST 今日。summary.json の生成日ではない）。 */
    date: string;
    available: boolean;
    active: AgentPeriod[];
    upcoming: AgentPeriod[];
  };
  nextClass: DiscordSummary['nextClass'];
  nextClassNotes: DiscordSummary['nextClassNotes'];
  assignments: {
    horizonDays: number;
    dueWithinHorizon: AgentAssignment[];
    deadlineUnknown: AgentAssignment[];
  };
  announcements: {
    important: AgentAnnouncement[];
    recentOther: AgentAnnouncement[];
  };
  sourceStatus: DiscordSummary['sourceStatus'];
  warnings: string[];
  sourceFiles: {
    summary: string;
    enrollment: string;
    academicCalendar: string;
    academicSchedule: string;
    gradingRules: string;
    basicInfo: string;
    contextJson: string;
    contextMarkdown: string;
  };
  agentNotes: string[];
};

const contextJsonPath = path.join(outputDir, 'agent-context.json');
const contextMarkdownPath = path.join(outputDir, 'agent-context.md');
const academicCalendarPath = path.join(outputDir, 'academic-calendar.json');
const basicInfoPath = path.join(repoRoot, 'docs', 'basic-info.md');
const defaultMaxAgeMinutes = 30;
const defaultHorizonDays = 7;

function usage(): string {
  return [
    'Usage:',
    '  npm run toyo:context',
    '  npm run toyo:context -- --no-sync',
    '  npm run toyo:context -- --sync',
    '  npm run toyo:context -- --format json',
    '',
    'Options:',
    '  --sync                    Always run npm run toyo:sync before building context.',
    '  --no-sync                 Use existing output files only, even when stale.',
    `  --max-age-minutes <n>     Refresh when summary is older than n minutes. Default: ${defaultMaxAgeMinutes}.`,
    `  --horizon-days <n>        Include assignments due within n days. Default: ${defaultHorizonDays}.`,
    '  --format markdown|json     Print format. Both output files are always written.',
  ].join('\n');
}

function parsePositiveNumber(raw: string | undefined, label: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    forceSync: false,
    noSync: false,
    maxAgeMinutes: defaultMaxAgeMinutes,
    horizonDays: defaultHorizonDays,
    format: 'markdown',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--sync') {
      options.forceSync = true;
      continue;
    }
    if (arg === '--no-sync') {
      options.noSync = true;
      continue;
    }
    if (arg === '--max-age-minutes') {
      options.maxAgeMinutes = parsePositiveNumber(argv[index + 1], '--max-age-minutes');
      index += 1;
      continue;
    }
    if (arg === '--horizon-days') {
      options.horizonDays = parsePositiveNumber(argv[index + 1], '--horizon-days');
      index += 1;
      continue;
    }
    if (arg === '--format') {
      const format = argv[index + 1];
      if (format !== 'markdown' && format !== 'json') {
        throw new Error(`--format must be markdown or json.\n\n${usage()}`);
      }
      options.format = format;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
  }

  if (options.forceSync && options.noSync) {
    throw new Error('--sync and --no-sync cannot be used together.');
  }

  return options;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

function jstDateString(date: Date): string {
  const shifted = new Date(date.getTime() + 9 * 60 * 60_000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function minutesSince(dateString: string | null, now: Date): number | null {
  if (!dateString) return null;
  const timestamp = Date.parse(dateString);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.round((now.getTime() - timestamp) / 60_000));
}

function dateFromIsoOrFallback(dateString: string | null | undefined, fallback: Date): Date {
  const timestamp = dateString ? Date.parse(dateString) : Number.NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp) : fallback;
}

function isSummaryStale(
  summary: DiscordSummary | null,
  now: Date,
  maxAgeMinutes: number
): { ageMinutes: number | null; stale: boolean } {
  if (!summary) {
    return { ageMinutes: null, stale: true };
  }
  const ageMinutes = minutesSince(summary.generatedAt, now);
  if (ageMinutes === null) {
    return { ageMinutes, stale: true };
  }
  return { ageMinutes, stale: ageMinutes > maxAgeMinutes };
}

function tailLines(value: string, maxLines: number): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-maxLines);
}

async function runSync(): Promise<SyncAttempt> {
  const child = spawn('npm', ['run', 'toyo:sync'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: string[] = [];

  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    chunks.push(text);
    process.stderr.write(text);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    chunks.push(text);
    process.stderr.write(text);
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
  const outputTail = tailLines(chunks.join(''), 20);

  if (exitCode === 0) {
    return {
      status: 'succeeded',
      reason: 'summary was missing, stale, or --sync was requested',
      exitCode,
      outputTail,
    };
  }

  return {
    status: 'failed',
    reason: 'npm run toyo:sync failed; context was built from available cached files if possible',
    exitCode,
    outputTail,
  };
}

function summarizeAssignment(assignment: Assignment): AgentAssignment {
  return {
    assignmentId: assignment.assignmentId,
    courseName: assignment.courseName,
    title: truncate(assignment.title, 160),
    dueAt: assignment.dueAt,
    status: assignment.status,
    sourceUrl: assignment.sourceUrl,
    notes: assignment.notes.map((note) => truncate(note, 160)),
  };
}

function summarizeContent(content: CourseContent): AgentContent {
  return {
    contentId: content.contentId,
    courseName: content.courseName,
    title: truncate(content.title, 160),
    contentUrl: content.contentUrl,
    updatedAt: content.updatedAt,
    listedAt: content.listedAt,
    openFrom: content.openFrom,
    openUntil: content.openUntil,
  };
}

function summarizeAnnouncement(announcement: Announcement): AgentAnnouncement {
  return {
    announcementId: announcement.announcementId,
    category: announcement.category,
    courseNameHint: announcement.courseNameHint,
    title: truncate(announcement.title, 160),
    postedAt: announcement.postedAt,
    targetDate: announcement.targetDate,
    sourceUrl: announcement.sourceUrl,
    contentPreview: truncate(announcement.content, 240),
  };
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function summarizeGradingRules(courseCode: string): AgentGradingRules | null {
  const rule = findGradingRule(courseCode);
  if (!rule) return null;
  return {
    reviewed: rule.reviewed,
    components: rule.components,
    cutoffs: rule.cutoffs,
    warnings: rule.warnings,
  };
}

function summarizePeriod(period: PeriodView): AgentPeriod {
  return {
    kind: period.kind,
    semester: period.semester,
    label: period.label,
    start: period.start,
    end: period.end,
    note: truncate(period.note, 200),
    status: period.status,
    daysOffset: period.daysOffset,
  };
}

function summarizeClass(entry: DetailedClassSummary, date: string): AgentClass {
  return {
    courseName: entry.classInfo.courseName,
    courseCode: entry.classInfo.courseCode,
    day: entry.classInfo.day,
    period: entry.classInfo.period,
    // 古い summary.json（sessionNumber 追加前）でも落ちないよう、無ければその場で計算する
    sessionNumber:
      entry.sessionNumber !== undefined ? entry.sessionNumber : sessionNumberFor(date, entry.classInfo.day),
    startsAt: entry.classInfo.startsAt,
    endsAt: entry.classInfo.endsAt,
    instructor: entry.classInfo.instructor,
    room: entry.classInfo.room,
    campus: entry.classInfo.campus,
    deliveryMode: entry.classInfo.deliveryMode,
    syllabus: entry.syllabus
      ? {
          sourceUrl: entry.syllabus.sourceUrl || null,
          classFormat: entry.syllabus.classFormat || null,
          grading: entry.syllabus.grading ? truncate(entry.syllabus.grading, 240) : null,
          firstTopic: entry.syllabus.firstTopic ? truncate(entry.syllabus.firstTopic, 180) : null,
          preAndPostStudy: entry.syllabus.preAndPostStudy
            ? truncate(entry.syllabus.preAndPostStudy, 240)
            : null,
          textbook: entry.syllabus.textbook ? truncate(entry.syllabus.textbook, 180) : null,
        }
      : null,
    gradingRules: summarizeGradingRules(entry.classInfo.courseCode),
    relatedAssignments: entry.relatedAssignments.map(summarizeAssignment),
    relatedContents: entry.relatedContents.slice(0, 8).map(summarizeContent),
    relatedAnnouncements: entry.relatedAnnouncements.slice(0, 8).map(summarizeAnnouncement),
    errors: entry.errors,
  };
}

function findHoliday(calendar: AcademicCalendar | null, date: string): string | null {
  const holiday = calendar?.nationalHolidays?.find((item) => item.date === date);
  return holiday?.name ?? null;
}

function buildWarnings(
  summary: DiscordSummary,
  enrollment: EnrollmentData | null,
  calendar: AcademicCalendar | null,
  sync: SyncAttempt,
  freshness: AgentContext['freshness']
): string[] {
  const warnings: string[] = [];

  if (sync.status === 'failed') {
    warnings.push('toyo:sync failed; cached output was used. Treat freshness-sensitive answers as uncertain.');
  }
  if (freshness.stale) {
    warnings.push(
      `summary.json is stale or missing freshness metadata. ageMinutes=${freshness.ageMinutes ?? 'unknown'}, maxAgeMinutes=${freshness.maxAgeMinutes}.`
    );
  }
  if (summary.sourceStatus.portal.fetchStatus === 'error') {
    warnings.push('Portal fetchStatus is error. Do not trust class data without re-login and re-sync.');
  }
  if (summary.sourceStatus.portal.fetchStatus === 'empty') {
    warnings.push('Portal fetchStatus is empty. Distinguish this from a fetch error before advising.');
  }
  if (!summary.sourceStatus.toyonetAce.available) {
    warnings.push('ToyoNet-ACE assignments were not available.');
  }
  if (!summary.sourceStatus.toyonetAce.contentsAvailable) {
    warnings.push('ToyoNet-ACE course contents were not available.');
  }
  if (!summary.sourceStatus.toyonetAce.announcementsAvailable) {
    warnings.push('ToyoNet-ACE announcements were not available; cancellation/classroom-change checks are incomplete.');
  }
  if (summary.errors.length > 0) {
    warnings.push(`summary.json contains ${summary.errors.length} collection error(s).`);
  }
  if (!enrollment) {
    warnings.push('registration-data.json was not found; course code and enrollment checks are incomplete.');
  } else if (enrollment.fetchStatus !== summary.sourceStatus.portal.fetchStatus) {
    warnings.push(
      `registration-data.json fetchStatus (${enrollment.fetchStatus}) differs from summary portal status (${summary.sourceStatus.portal.fetchStatus}).`
    );
  }
  if (!calendar) {
    warnings.push('academic-calendar.json was not found; holiday checks are unavailable.');
  } else if (calendar.available === false || (calendar.errors?.length ?? 0) > 0) {
    warnings.push('academic-calendar.json reports errors; holiday checks may be incomplete.');
  }

  return warnings;
}

function buildAgentNotes(): string[] {
  return [
    'For current class, assignment, cancellation, or classroom questions, prefer this context only when freshness.stale is false and warnings are empty or explicitly handled.',
    'For grading, absence risk, or credit-risk questions, resolve the courseCode from today/tomorrow classes or registration-data.json, then use output/toyo/syllabus/<courseCode>.json or markdown as the primary evidence.',
    'Do not mix assignments with dueAt=null into imminent-deadline sets; treat them as deadlineUnknown and mention uncertainty.',
    'If portal.fetchStatus is error, distinguish login/session loss from no classes. Inspect artifacts/toyo/ and ask for npm run toyo:login when recovery cannot be automated.',
    'Use docs/basic-info.md for fixed campus, period-time, and access rules before relying on memory.',
    'For "what period is it now" (registration, lottery, add-registration, withdrawal), use the Periods section / data/academic-schedule.json. Dates listed under its unknown[] are not in the course guide; do not guess them.',
    'For "which session number is today" use sessionNumber on each class (null = not computable, e.g. intensive course or before classes start). Holidays are counted as no-class days; whether the university holds classes on holidays is unknown.',
    'For "can I skip this assignment / what happens if I miss it" use gradingRules on each class (data/grading-rules.json). If reviewed is false or warnings is non-empty, quote the syllabus grading text and state the uncertainty.',
  ];
}

function buildPeriods(date: string): AgentContext['periods'] {
  const schedule = loadAcademicSchedule();
  if (!schedule) return { date, available: false, active: [], upcoming: [] };
  const views = periodsAround(date, { horizonDays: 7, recentDays: 0 }, schedule);
  return {
    date,
    available: true,
    active: views.filter((view) => view.status === 'active').map(summarizePeriod),
    upcoming: views.filter((view) => view.status === 'upcoming').map(summarizePeriod),
  };
}

function dateWithinHorizon(isoDate: string, now: Date, horizonDays: number): boolean {
  const timestamp = Date.parse(isoDate);
  if (!Number.isFinite(timestamp)) return false;
  const lowerBound = now.getTime() - 60 * 60_000;
  const upperBound = now.getTime() + horizonDays * 24 * 60 * 60_000;
  return timestamp >= lowerBound && timestamp <= upperBound;
}

async function buildContext(options: CliOptions): Promise<AgentContext> {
  const now = new Date();
  let summary = await readJsonFile<DiscordSummary>(discordSummaryOutputPath);
  const initialFreshness = isSummaryStale(summary, now, options.maxAgeMinutes);

  let sync: SyncAttempt = {
    status: 'not-needed',
    reason: 'summary exists and is within max age',
    exitCode: null,
    outputTail: [],
  };

  const shouldSync =
    options.forceSync || (!options.noSync && (summary === null || initialFreshness.stale));

  if (shouldSync) {
    sync = await runSync();
    summary = await readJsonFile<DiscordSummary>(discordSummaryOutputPath);
  } else if (options.noSync) {
    sync = {
      status: 'skipped-by-option',
      reason: '--no-sync was requested',
      exitCode: null,
      outputTail: [],
    };
  }

  if (!summary) {
    throw new Error(
      [
        `summary.json was not found at ${discordSummaryOutputPath}.`,
        sync.status === 'failed' ? 'toyo:sync also failed; run npm run toyo:login and retry.' : null,
      ]
        .filter((line): line is string => line !== null)
        .join('\n')
    );
  }

  const [enrollment, calendar] = await Promise.all([
    readJsonFile<EnrollmentData>(jsonOutputPath),
    readJsonFile<AcademicCalendar>(academicCalendarPath),
  ]);
  const ageMinutes = minutesSince(summary.generatedAt, now);
  const freshness = {
    summaryGeneratedAt: summary.generatedAt ?? null,
    ageMinutes,
    maxAgeMinutes: options.maxAgeMinutes,
    stale: ageMinutes === null || ageMinutes > options.maxAgeMinutes,
  };

  const summaryBaseDate = dateFromIsoOrFallback(summary.generatedAt, now);
  const todayDate = jstDateString(summaryBaseDate);
  const tomorrowDate = jstDateString(addDays(summaryBaseDate, 1));
  const importantCategories = new Set(['休講', '補講', '教室変更']);
  const importantAnnouncements = summary.announcements
    .filter((announcement) => importantCategories.has(announcement.category))
    .slice(0, 12)
    .map(summarizeAnnouncement);
  const recentOtherAnnouncements = summary.announcements
    .filter((announcement) => !importantCategories.has(announcement.category))
    .slice(0, 6)
    .map(summarizeAnnouncement);

  const context: AgentContext = {
    builtAt: now.toISOString(),
    timezone: 'Asia/Tokyo',
    sync,
    freshness,
    today: {
      date: todayDate,
      nationalHoliday: findHoliday(calendar, todayDate),
      classes: summary.todayClasses.map((entry) => summarizeClass(entry, todayDate)),
    },
    tomorrow: {
      date: tomorrowDate,
      nationalHoliday: findHoliday(calendar, tomorrowDate),
      classes: summary.tomorrowClasses.map((entry) => summarizeClass(entry, tomorrowDate)),
    },
    periods: buildPeriods(jstDateString(now)),
    nextClass: summary.nextClass,
    nextClassNotes: summary.nextClassNotes,
    assignments: {
      horizonDays: options.horizonDays,
      dueWithinHorizon: summary.upcomingAssignments
        .filter((assignment) =>
          assignment.dueAt ? dateWithinHorizon(assignment.dueAt, now, options.horizonDays) : false
        )
        .slice(0, 20)
        .map(summarizeAssignment),
      deadlineUnknown: summary.upcomingAssignments
        .filter((assignment) => assignment.dueAt === null)
        .slice(0, 12)
        .map(summarizeAssignment),
    },
    announcements: {
      important: importantAnnouncements,
      recentOther: recentOtherAnnouncements,
    },
    sourceStatus: summary.sourceStatus,
    warnings: [],
    sourceFiles: {
      summary: discordSummaryOutputPath,
      enrollment: jsonOutputPath,
      academicCalendar: academicCalendarPath,
      academicSchedule: academicSchedulePath,
      gradingRules: gradingRulesPath,
      basicInfo: basicInfoPath,
      contextJson: contextJsonPath,
      contextMarkdown: contextMarkdownPath,
    },
    agentNotes: buildAgentNotes(),
  };

  context.warnings = buildWarnings(summary, enrollment, calendar, sync, freshness);
  return context;
}

function timeRange(startsAt: string, endsAt: string): string {
  const start = startsAt.match(/T(\d{2}:\d{2})/)?.[1] ?? startsAt;
  const end = endsAt.match(/T(\d{2}:\d{2})/)?.[1] ?? endsAt;
  return `${start}-${end}`;
}

function renderAssignment(assignment: AgentAssignment): string {
  const due = assignment.dueAt ?? '締切不明';
  return `${assignment.courseName}: ${assignment.title} (${due})`;
}

function renderAnnouncement(announcement: AgentAnnouncement): string {
  const course = announcement.courseNameHint ? `${announcement.courseNameHint}: ` : '';
  const target = announcement.targetDate ? ` target=${announcement.targetDate}` : '';
  return `[${announcement.category}] ${course}${announcement.title}${target}`;
}

function renderComponent(component: AgentGradingRules['components'][number]): string {
  const weight = component.weightPercent === null ? '配点不明' : `${component.weightPercent}%`;
  const scenario = component.scenario ? `[${component.scenario}] ` : '';
  const each = component.perSession ? '(毎回)' : '';
  return `${scenario}${component.name}${each} ${weight}`;
}

function renderPeriod(period: AgentPeriod): string {
  const when = describePeriodTime(period);
  const offset = period.status === 'upcoming' ? ` [${period.daysOffset}日後に開始]` : '';
  return `- [${period.semester}] ${period.label}: ${when}${offset}${period.note ? ` — ${period.note}` : ''}`;
}

function appendClassSection(lines: string[], title: string, classes: AgentClass[]): void {
  lines.push(`## ${title}`);
  if (classes.length === 0) {
    lines.push('- なし');
    lines.push('');
    return;
  }

  for (const entry of classes) {
    const session = entry.sessionNumber === null ? '' : ` 第${entry.sessionNumber}回`;
    lines.push(
      `- ${entry.period}限 ${timeRange(entry.startsAt, entry.endsAt)} ${entry.courseName} (${entry.courseCode})${session}`
    );
    lines.push(
      `  - ${entry.campus} ${entry.room || '教室不明'} / ${entry.deliveryMode || '形態不明'} / ${entry.instructor || '担当不明'}`
    );
    if (entry.syllabus?.grading) {
      lines.push(`  - 評価: ${entry.syllabus.grading}`);
    }
    if (entry.gradingRules) {
      const rules = entry.gradingRules;
      const tag = rules.reviewed ? '' : '（未レビュー）';
      if (rules.components.length > 0) {
        lines.push(`  - 配分${tag}: ${rules.components.map(renderComponent).join(' / ')}`);
      }
      if (rules.cutoffs.length > 0) {
        lines.push(`  - 足切り${tag}: ${rules.cutoffs.map((cutoff) => `[${cutoff.type}] ${truncate(cutoff.text, 100)}`).join(' / ')}`);
      }
      if (rules.warnings.length > 0) {
        lines.push(`  - 成績ルールの注意: ${rules.warnings.map((warning) => truncate(warning, 100)).join(' / ')}`);
      }
    }
    if (entry.syllabus?.firstTopic) {
      lines.push(`  - シラバス先頭トピック: ${entry.syllabus.firstTopic}`);
    }
    if (entry.relatedAssignments.length > 0) {
      lines.push(`  - 関連課題: ${entry.relatedAssignments.map(renderAssignment).join(' / ')}`);
    }
    if (entry.relatedContents.length > 0) {
      lines.push(
        `  - 関連コンテンツ: ${entry.relatedContents.map((item) => item.title).join(' / ')}`
      );
    }
    if (entry.relatedAnnouncements.length > 0) {
      lines.push(
        `  - 関連お知らせ: ${entry.relatedAnnouncements.map(renderAnnouncement).join(' / ')}`
      );
    }
    if (entry.errors.length > 0) {
      lines.push(`  - 取得エラー: ${entry.errors.join(' / ')}`);
    }
  }
  lines.push('');
}

function buildMarkdown(context: AgentContext): string {
  const lines: string[] = [
    '# Toyo Agent Context',
    '',
    `- builtAt: ${context.builtAt}`,
    `- timezone: ${context.timezone}`,
    `- sync: ${context.sync.status} (${context.sync.reason})`,
    `- summaryGeneratedAt: ${context.freshness.summaryGeneratedAt ?? 'unknown'}`,
    `- ageMinutes: ${context.freshness.ageMinutes ?? 'unknown'} / maxAgeMinutes: ${context.freshness.maxAgeMinutes}`,
    `- stale: ${context.freshness.stale}`,
    '',
    '## Status',
    `- portal: ${context.sourceStatus.portal.fetchStatus}, available=${context.sourceStatus.portal.available}, fetchedAt=${context.sourceStatus.portal.fetchedAt ?? 'unknown'}`,
    `- ToyoNet-ACE assignments: available=${context.sourceStatus.toyonetAce.available}, fetchedAt=${context.sourceStatus.toyonetAce.fetchedAt ?? 'unknown'}`,
    `- ToyoNet-ACE contents: available=${context.sourceStatus.toyonetAce.contentsAvailable}, fetchedAt=${context.sourceStatus.toyonetAce.contentsFetchedAt ?? 'unknown'}`,
    `- ToyoNet-ACE announcements: available=${context.sourceStatus.toyonetAce.announcementsAvailable}, fetchedAt=${context.sourceStatus.toyonetAce.announcementsFetchedAt ?? 'unknown'}`,
    '',
    '## Warnings',
  ];

  if (context.warnings.length === 0) {
    lines.push('- なし');
  } else {
    lines.push(...context.warnings.map((warning) => `- ${warning}`));
  }
  lines.push('');

  lines.push(`## Periods (${context.periods.date})`);
  if (!context.periods.available) {
    lines.push('- academic-schedule.json がありません（期間情報なし）');
  } else if (context.periods.active.length === 0 && context.periods.upcoming.length === 0) {
    lines.push('- 進行中・7日以内に始まる期間はなし');
  } else {
    if (context.periods.active.length > 0) {
      lines.push('進行中:');
      lines.push(...context.periods.active.map(renderPeriod));
    }
    if (context.periods.upcoming.length > 0) {
      lines.push('7日以内に開始:');
      lines.push(...context.periods.upcoming.map(renderPeriod));
    }
  }
  lines.push('');

  lines.push(`## Today (${context.today.date})`);
  lines.push(`- nationalHoliday: ${context.today.nationalHoliday ?? 'なし'}`);
  lines.push('');
  appendClassSection(lines, 'Today Classes', context.today.classes);

  lines.push(`## Tomorrow (${context.tomorrow.date})`);
  lines.push(`- nationalHoliday: ${context.tomorrow.nationalHoliday ?? 'なし'}`);
  lines.push('');
  appendClassSection(lines, 'Tomorrow Classes', context.tomorrow.classes);

  lines.push('## Next Class');
  if (context.nextClass) {
    lines.push(
      `- ${context.nextClass.startsAt} ${context.nextClass.courseName} (${context.nextClass.courseCode})`
    );
    if (context.nextClassNotes?.syllabusPoints.length) {
      lines.push(...context.nextClassNotes.syllabusPoints.map((point) => `  - ${point}`));
    }
  } else {
    lines.push('- なし');
  }
  lines.push('');

  lines.push(`## Assignments Due Within ${context.assignments.horizonDays} Days`);
  if (context.assignments.dueWithinHorizon.length === 0) {
    lines.push('- なし');
  } else {
    lines.push(
      ...context.assignments.dueWithinHorizon.map((assignment) => `- ${renderAssignment(assignment)}`)
    );
  }
  lines.push('');

  lines.push('## Deadline Unknown Assignments');
  if (context.assignments.deadlineUnknown.length === 0) {
    lines.push('- なし');
  } else {
    lines.push(
      ...context.assignments.deadlineUnknown.map((assignment) => `- ${renderAssignment(assignment)}`)
    );
  }
  lines.push('');

  lines.push('## Important Announcements');
  if (context.announcements.important.length === 0) {
    lines.push('- なし');
  } else {
    lines.push(
      ...context.announcements.important.map((announcement) => `- ${renderAnnouncement(announcement)}`)
    );
  }
  lines.push('');

  lines.push('## Recent Other Announcements');
  if (context.announcements.recentOther.length === 0) {
    lines.push('- なし');
  } else {
    lines.push(
      ...context.announcements.recentOther.map((announcement) => `- ${renderAnnouncement(announcement)}`)
    );
  }
  lines.push('');

  lines.push('## Agent Notes');
  lines.push(...context.agentNotes.map((note) => `- ${note}`));
  lines.push('');

  lines.push('## Source Files');
  for (const [key, value] of Object.entries(context.sourceFiles)) {
    lines.push(`- ${key}: ${value}`);
  }

  return `${lines.join('\n')}\n`;
}

async function writeContext(context: AgentContext, markdown: string): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  await Promise.all([
    fs.writeFile(contextJsonPath, JSON.stringify(context, null, 2), 'utf8'),
    fs.writeFile(contextMarkdownPath, markdown, 'utf8'),
  ]);
}

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const context = await buildContext(options);
  const markdown = buildMarkdown(context);
  await writeContext(context, markdown);

  if (options.format === 'json') {
    console.log(JSON.stringify(context, null, 2));
  } else {
    console.log(markdown);
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
