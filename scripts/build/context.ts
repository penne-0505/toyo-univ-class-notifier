/**
 * 組み立て層: agent-context.json の中身（文脈データ）を作る純粋関数。Markdown への整形は context-markdown.ts。
 *
 * 規則: このファイルは Playwright も fetch も import しない。入力は summary と取得層・data/ の出力ファイルの中身（引数）だけ。
 * 古い入力を取り直しに行くことはしない。古さは freshness と warnings で表すだけ（取得は各ジョブの責任）。
 */
import path from 'node:path';
import { type CourseIndex } from './course-index';
import { type CourseworkBrief, type CourseworkScheduleEntry } from '../lib/coursework-model';
import {
  academicSchedulePath,
  jstDateString,
  periodsAround,
  sessionNumberFor,
  type AcademicSchedule,
  type PeriodView,
} from '../lib/toyo-academic-schedule';
import { gradingRulesPath, type GradingRule, type GradingRulesFile } from '../lib/toyo-grading-rules';
import { outputDir, registrationDataPath, repoRoot } from '../lib/toyo-paths';
import { summaryOutputPath, type DetailedClassSummary, type Summary } from './summary';
import type { Announcement } from '../lib/toyo-announcements';
import type { EnrollmentData } from '../lib/toyo-enrollment';
import type { Assignment, CourseContent } from '../lib/toyonet-ace';

export type AcademicCalendar = {
  fetchedAt?: string;
  available?: boolean;
  academicYear?: string;
  nationalHolidays?: { date: string; name: string }[];
  errors?: string[];
};

export type AgentAssignment = Pick<
  Assignment,
  'assignmentId' | 'courseName' | 'title' | 'dueAt' | 'status' | 'sourceUrl' | 'notes'
>;

export type AgentContent = Pick<
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

export type AgentAnnouncement = Pick<
  Announcement,
  'announcementId' | 'category' | 'courseNameHint' | 'title' | 'postedAt' | 'targetDate' | 'sourceUrl'
> & {
  contentPreview: string;
};

export type AgentGradingRules = Pick<GradingRule, 'reviewed' | 'components' | 'cutoffs' | 'warnings'>;

export type AgentPeriod = Pick<PeriodView, 'kind' | 'semester' | 'label' | 'start' | 'end' | 'note' | 'status' | 'daysOffset'>;

export type AgentClass = {
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
  /** ACE のコース別提出状況。toyo:coursework 未実行 / ACE に無い科目は null。 */
  coursework: CourseworkBrief | null;
  /** 足切りに「提出回数」がある科目のみ。remaining は基準回数までに必要な残り提出回数（概算。条件の向きは text を優先）。 */
  submissionCutoff: {
    threshold: number;
    submitted: number;
    remaining: number;
    countedTypes: string;
    text: string;
  } | null;
  relatedAssignments: AgentAssignment[];
  relatedContents: AgentContent[];
  relatedAnnouncements: AgentAnnouncement[];
  errors: string[];
};

export type AgentContext = {
  builtAt: string;
  timezone: 'Asia/Tokyo';
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
  nextClass: Summary['nextClass'];
  nextClassNotes: Summary['nextClassNotes'];
  assignments: {
    horizonDays: number;
    dueWithinHorizon: AgentAssignment[];
    deadlineUnknown: AgentAssignment[];
  };
  /** 今後 14 日に締切が来る coursework 項目（受付開始待ちを含む）。summary.courseworkSchedule を実行時点で絞り直したもの。 */
  courseworkSchedule: {
    horizonDays: number;
    items: CourseworkScheduleEntry[];
  };
  announcements: {
    important: AgentAnnouncement[];
    recentOther: AgentAnnouncement[];
  };
  sourceStatus: Summary['sourceStatus'];
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

export const contextJsonPath = path.join(outputDir, 'agent-context.json');
export const contextMarkdownPath = path.join(outputDir, 'agent-context.md');
const academicCalendarPath = path.join(outputDir, 'academic-calendar.json');
const basicInfoPath = path.join(repoRoot, 'docs', 'basic-info.md');
export const defaultMaxAgeMinutes = 30;
export const defaultHorizonDays = 7;

export type ContextOptions = {
  maxAgeMinutes: number;
  horizonDays: number;
};

/** 取得層・data/ の出力ファイルの中身。ファイルが無い・壊れているものは null。 */
export type ContextInputs = {
  summary: Summary;
  registration: EnrollmentData | null;
  academicCalendar: AcademicCalendar | null;
  academicSchedule: AcademicSchedule | null;
  gradingRules: GradingRulesFile | null;
  courseIndex: CourseIndex | null;
  /** ジョブ（systemd タイマー）の失敗・停止の警告文。lib/toyo-health の healthWarnings の結果を呼び出し側が渡す */
  healthWarnings: string[];
};

type ClassEnv = {
  gradingRules: GradingRulesFile | null;
  academicSchedule: AcademicSchedule | null;
  holidays: Set<string>;
};

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

export function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function summarizeGradingRules(rules: GradingRulesFile | null, courseCode: string): AgentGradingRules | null {
  const rule = rules?.courses.find((course) => course.courseCode === courseCode) ?? null;
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

function computeSubmissionCutoff(
  gradingRules: AgentGradingRules | null,
  coursework: CourseworkBrief | null
): AgentClass['submissionCutoff'] {
  if (!gradingRules || !coursework) return null;
  const cutoff = gradingRules.cutoffs.find(
    (item) => item.type === 'submission-count' && item.unit === 'count' && item.threshold !== null
  );
  if (!cutoff || cutoff.threshold === null) return null;
  const byType = coursework.submittedByType ?? { report: 0, query: 0 };
  const mentionsReport = /レポート/.test(cutoff.text);
  const mentionsQuery = /小テスト|確認テスト|テスト/.test(cutoff.text);
  let submitted = coursework.submitted;
  let countedTypes = 'report+query';
  if (mentionsReport && !mentionsQuery) {
    submitted = byType.report;
    countedTypes = 'report';
  } else if (mentionsQuery && !mentionsReport) {
    submitted = byType.query;
    countedTypes = 'query';
  }
  return {
    threshold: cutoff.threshold,
    submitted,
    remaining: Math.max(0, cutoff.threshold - submitted),
    countedTypes,
    text: truncate(cutoff.text, 160),
  };
}

function summarizeClass(entry: DetailedClassSummary, date: string, env: ClassEnv): AgentClass {
  const gradingRules = summarizeGradingRules(env.gradingRules, entry.classInfo.courseCode);
  const coursework = entry.coursework ?? null;
  return {
    courseName: entry.classInfo.courseName,
    courseCode: entry.classInfo.courseCode,
    day: entry.classInfo.day,
    period: entry.classInfo.period,
    // 古い summary.json（sessionNumber 追加前）でも落ちないよう、無ければその場で計算する
    sessionNumber:
      entry.sessionNumber !== undefined
        ? entry.sessionNumber
        : sessionNumberFor(date, entry.classInfo.day, env.academicSchedule, env.holidays),
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
    gradingRules,
    coursework,
    submissionCutoff: computeSubmissionCutoff(gradingRules, coursework),
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
  summary: Summary,
  enrollment: EnrollmentData | null,
  calendar: AcademicCalendar | null,
  freshness: AgentContext['freshness'],
  healthWarnings: string[],
  courseIndex: CourseIndex | null
): string[] {
  const warnings: string[] = [];

  if (freshness.stale) {
    warnings.push(
      `summary.json is stale or missing freshness metadata. ageMinutes=${freshness.ageMinutes ?? 'unknown'}, maxAgeMinutes=${freshness.maxAgeMinutes}.`
    );
  }
  if (summary.sourceStatus.portal.fetchStatus === 'error') {
    warnings.push('Portal fetchStatus is error. Do not trust class data without re-login and a fresh toyo:daily / toyo:sync.');
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
  // 定期ジョブ（systemd タイマー）の失敗・停止。toyo:health が output/toyo/health.json に書く
  warnings.push(...healthWarnings);
  // 科目の対応表（course-index.json）が見つけた欠け。今学期の科目だけが warnings を持つ
  for (const course of courseIndex?.courses ?? []) {
    for (const warning of course.warnings) warnings.push(`${course.names.portal}: ${warning}`);
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
    'For quizzes/reports that are not yet open (受付開始待ち) or per-course submission counts, use courseworkSchedule / each class coursework (output/toyo/toyonet-ace-coursework.json). submitted=null means the ACE list did not show a submission state. The submission-count cutoff remaining is approximate: read the cutoff text for the direction of the condition.',
  ];
}

function buildPeriods(date: string, schedule: AcademicSchedule | null): AgentContext['periods'] {
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

export function buildContext(inputs: ContextInputs, options: ContextOptions, now: Date): AgentContext {
  const { summary, registration, academicCalendar: calendar, academicSchedule, gradingRules, courseIndex } = inputs;
  const ageMinutes = minutesSince(summary.generatedAt, now);
  const freshness = {
    summaryGeneratedAt: summary.generatedAt ?? null,
    ageMinutes,
    maxAgeMinutes: options.maxAgeMinutes,
    stale: ageMinutes === null || ageMinutes > options.maxAgeMinutes,
  };
  const classEnv: ClassEnv = {
    gradingRules,
    academicSchedule,
    holidays: new Set((calendar?.nationalHolidays ?? []).map((holiday) => holiday.date)),
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
    freshness,
    today: {
      date: todayDate,
      nationalHoliday: findHoliday(calendar, todayDate),
      classes: summary.todayClasses.map((entry) => summarizeClass(entry, todayDate, classEnv)),
    },
    tomorrow: {
      date: tomorrowDate,
      nationalHoliday: findHoliday(calendar, tomorrowDate),
      classes: summary.tomorrowClasses.map((entry) => summarizeClass(entry, tomorrowDate, classEnv)),
    },
    periods: buildPeriods(jstDateString(now), academicSchedule),
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
    courseworkSchedule: {
      horizonDays: 14,
      items: (summary.courseworkSchedule ?? []).filter((item) => {
        const due = Date.parse(item.dueAt);
        return due >= now.getTime() && due <= now.getTime() + 14 * 24 * 60 * 60 * 1000;
      }),
    },
    announcements: {
      important: importantAnnouncements,
      recentOther: recentOtherAnnouncements,
    },
    sourceStatus: summary.sourceStatus,
    warnings: [],
    sourceFiles: {
      summary: summaryOutputPath,
      enrollment: registrationDataPath,
      academicCalendar: academicCalendarPath,
      academicSchedule: academicSchedulePath,
      gradingRules: gradingRulesPath,
      basicInfo: basicInfoPath,
      contextJson: contextJsonPath,
      contextMarkdown: contextMarkdownPath,
    },
    agentNotes: buildAgentNotes(),
  };

  context.warnings = buildWarnings(summary, registration, calendar, freshness, inputs.healthWarnings, courseIndex);
  return context;
}
