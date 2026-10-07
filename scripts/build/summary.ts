/**
 * 組み立て層: summary.json（今日・明日の授業、課題、お知らせ、提出状況を 1 つにまとめたもの）を作る純粋関数。
 *
 * 規則: このファイルは Playwright も fetch も import しない。入力は取得層の出力ファイルの中身（引数）だけで、
 * 欠けている入力（null）は取りに行かず、sourceStatus と errors で表す。
 * 科目の突き合わせは course-index 経由（ACE courseId → 科目名のキー → 授業コード）。名前の `===` 比較はしない。
 */
import path from 'node:path';
import { courseInSemesterOn, sessionNumberFor, type AcademicSchedule } from '../lib/toyo-academic-schedule';
import {
  buildCourseworkBrief,
  buildCourseworkSchedule,
  findCourseworkByCode,
  type CourseworkBrief,
  type CourseworkCourse,
  type CourseworkResult,
  type CourseworkScheduleEntry,
} from '../lib/coursework-model';
import { findSyllabus, type SyllabusMap, type SyllabusRecord } from '../lib/syllabus-cache';
import { outputDir, registrationDataPath } from '../lib/toyo-paths';
import type { Announcement, AnnouncementCollectionResult } from '../fetch/toyo-announcements';
import type { Course, EnrollmentData } from '../fetch/toyo-enrollment';
import type { Assignment, AssignmentCollectionResult, CourseContent, CourseContentCollectionResult } from '../fetch/toyonet-ace';
import type { CourseIndex } from './course-index';
import { aceCourseIdFrom, createCourseResolver, type CourseRef } from './course-lookup';

const JST_OFFSET_MINUTES = 9 * 60;
const dayOrder = ['日', '月', '火', '水', '木', '金', '土'] as const;
const dayNumberByLabel = new Map<string, number>([
  ['日', 0],
  ['月', 1],
  ['火', 2],
  ['水', 3],
  ['木', 4],
  ['金', 5],
  ['土', 6],
]);

const periodTimes = new Map<string, { start: string; end: string }>([
  ['1', { start: '09:00', end: '10:30' }],
  ['2', { start: '10:40', end: '12:10' }],
  ['3', { start: '13:00', end: '14:30' }],
  ['4', { start: '14:45', end: '16:15' }],
  ['5', { start: '16:30', end: '18:00' }],
  ['6', { start: '18:15', end: '19:45' }],
  ['7', { start: '19:55', end: '21:25' }],
]);

export const summaryOutputPath = path.join(outputDir, 'summary.json');

// ---------- 入力 ----------

export type AcademicCalendarInput = { nationalHolidays?: Array<{ date: string }> };

/** 取得層の出力ファイルの中身。ファイルが無い・壊れているものは null。 */
export type SummaryInputs = {
  registration: EnrollmentData | null;
  assignments: AssignmentCollectionResult | null;
  contents: CourseContentCollectionResult | null;
  announcements: AnnouncementCollectionResult | null;
  coursework: CourseworkResult | null;
  academicCalendar: AcademicCalendarInput | null;
  /** output/toyo/syllabus/ のキャッシュ（授業コード → record。キーは syllabusFileStem(授業コード)） */
  syllabi: SyllabusMap;
  academicSchedule: AcademicSchedule | null;
};

// ---------- 出力 ----------

export type CourseSummary = {
  courseName: string;
  courseCode: string;
  instructor: string;
  room: string;
  campus: string;
  day: string;
  period: string;
  deliveryMode: string;
  startsAt: string;
  endsAt: string;
  startsAtEpochMs: number;
  endsAtEpochMs: number;
};

export type NextClassNotes = {
  checkedAt: string | null;
  firstTopic: string | null;
  syllabusPoints: string[];
};

export type DetailedClassNotes = {
  sourceUrl: string;
  classFormat: string;
  conductionType: string;
  timetable: string;
  classroom: string;
  learningGoals: string;
  lectureSchedule: string;
  instructionMethod: string;
  preAndPostStudy: string;
  grading: string;
  textbook: string;
  firstTopic: string | null;
};

export type DetailedClassSummary = {
  classInfo: CourseSummary;
  /** その曜日の第何回授業日か。academic-schedule.json が無い・集中講義・授業期間外などで計算できなければ null。 */
  sessionNumber: number | null;
  syllabus: DetailedClassNotes | null;
  relatedAssignments: Assignment[];
  /** ACE のコース別提出状況（toyo:coursework 実行済みで、その科目が ACE に見つかる場合のみ）。 */
  coursework: CourseworkBrief | null;
  relatedContents: CourseContent[];
  relatedAnnouncements: Announcement[];
  errors: string[];
};

/**
 * 全体の一覧に載る項目には、index で引いた授業コードを付ける。履修登録確認表の科目に引けなかったもの
 * （履修外の ACE コース、全学のお知らせなど）は courseCode: null（科目不明）のまま残す。
 */
export type WithCourseCode = { courseCode: string | null };
export type AssignmentWithCoursework = Assignment & WithCourseCode & { coursework: CourseworkBrief | null };
export type ContentWithCourseCode = CourseContent & WithCourseCode;
export type AnnouncementWithCourseCode = Announcement & WithCourseCode;

export type Summary = {
  generatedAt: string;
  timezone: 'Asia/Tokyo';
  nextClass: CourseSummary | null;
  nextClassNotes: NextClassNotes | null;
  todayClasses: DetailedClassSummary[];
  tomorrowClasses: DetailedClassSummary[];
  upcomingAssignments: AssignmentWithCoursework[];
  /** 今後 14 日に締切が来る coursework 項目（受付開始待ちを含む）を dueAt 順に。未取得なら空。 */
  courseworkSchedule: CourseworkScheduleEntry[];
  courseContents: ContentWithCourseCode[];
  announcements: AnnouncementWithCourseCode[];
  sourceStatus: {
    portal: {
      available: boolean;
      fetchStatus: string;
      fetchedAt: string | null;
      path: string;
    };
    toyonetAce: {
      available: boolean;
      fetchedAt: string | null;
      contentsAvailable: boolean;
      contentsFetchedAt: string | null;
      announcementsAvailable: boolean;
      announcementsFetchedAt: string | null;
      courseworkAvailable: boolean;
      courseworkFetchedAt: string | null;
    };
  };
  errors: string[];
};

// ---------- 日付・授業の計算 ----------

function jstDate(date: Date): Date {
  return new Date(date.getTime() + JST_OFFSET_MINUTES * 60_000);
}

function formatJstDate(date: Date): string {
  return formatShiftedDate(jstDate(date));
}

function offsetJstDate(date: Date, days: number): Date {
  const shifted = jstDate(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function formatShiftedDate(shiftedDate: Date): string {
  const year = shiftedDate.getUTCFullYear();
  const month = String(shiftedDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shiftedDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function jstDayOfWeek(date: Date): number {
  return jstDate(date).getUTCDay();
}

function jstMinutes(date: Date): number {
  const shifted = jstDate(date);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function withJstIso(date: string, time: string): string {
  return `${date}T${time}:00+09:00`;
}

function toCourseSummary(course: Course, datePart: string, period: { start: string; end: string }): CourseSummary {
  const startsAt = withJstIso(datePart, period.start);
  const endsAt = withJstIso(datePart, period.end);
  return {
    courseName: course.courseName,
    courseCode: course.courseCode,
    instructor: course.instructor,
    room: course.room,
    campus: course.campus,
    day: course.day,
    period: course.period,
    deliveryMode: course.deliveryMode,
    startsAt,
    endsAt,
    startsAtEpochMs: Date.parse(startsAt),
    endsAtEpochMs: Date.parse(endsAt),
  };
}

function nextOccurrence(course: Course, now: Date): CourseSummary | null {
  const targetDay = dayNumberByLabel.get(course.day);
  const period = periodTimes.get(course.period);
  if (targetDay === undefined || !period) {
    return null;
  }

  const currentDay = jstDayOfWeek(now);
  const currentMinutes = jstMinutes(now);
  const [startHour, startMinute] = period.start.split(':').map(Number);
  const startMinutes = startHour * 60 + startMinute;

  let daysAhead = (targetDay - currentDay + 7) % 7;
  if (daysAhead === 0 && currentMinutes >= startMinutes) {
    daysAhead = 7;
  }

  const shifted = jstDate(now);
  shifted.setUTCDate(shifted.getUTCDate() + daysAhead);
  return toCourseSummary(course, formatShiftedDate(shifted), period);
}

function occurrenceOnOffsetDay(course: Course, now: Date, dayOffset: number): CourseSummary | null {
  const targetDate = offsetJstDate(now, dayOffset);
  const currentDayLabel = dayOrder[targetDate.getUTCDay()];
  if (course.day !== currentDayLabel) {
    return null;
  }

  const period = periodTimes.get(course.period);
  if (!period) {
    return null;
  }
  return toCourseSummary(course, formatShiftedDate(targetDate), period);
}

/** 授業日が属する学期の科目（または通年）だけを通す。春学期科目が秋に出るのを防ぐ。 */
function inSemester(course: Course, occurrence: CourseSummary | null, schedule: AcademicSchedule | null): CourseSummary | null {
  if (!occurrence) return null;
  return courseInSemesterOn(course.semesterLabel, occurrence.startsAt.slice(0, 10), schedule) ? occurrence : null;
}

// ---------- 並べ替え・シラバス ----------

function sortAssignments<T extends Assignment>(assignments: T[]): T[] {
  return [...assignments].sort((a, b) => {
    if (a.dueAt && b.dueAt) {
      return Date.parse(a.dueAt) - Date.parse(b.dueAt);
    }
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return a.title.localeCompare(b.title, 'ja');
  });
}

function sortCourseContents<T extends CourseContent>(contents: T[]): T[] {
  return [...contents].sort((a, b) => {
    const left = a.updatedAt ?? a.listedAt ?? '';
    const right = b.updatedAt ?? b.listedAt ?? '';
    if (left && right) {
      return right.localeCompare(left);
    }
    if (left) return -1;
    if (right) return 1;
    return a.title.localeCompare(b.title, 'ja');
  });
}

function extractFirstTopic(lectureSchedule: string): string | null {
  const normalized = lectureSchedule.replace(/\s+/g, ' ').trim();
  const match = normalized.match(
    /(第[0-9０-９一二三四五六七八九十]+[項回](?:[:：︓]\s*|\s+).*?)(?=第[0-9０-９一二三四五六七八九十]+[項回](?:[:：︓]\s*|\s+)|※|$)/
  );
  return match?.[1]?.replace(/\s+/g, ' ').replace(/[（(]\s*$/, '').trim() ?? null;
}

function buildNextClassNotes(nextClass: CourseSummary | null, record: SyllabusRecord | null, now: Date): NextClassNotes | null {
  if (!nextClass || !record) return null;
  return {
    checkedAt: formatJstDate(now),
    firstTopic: extractFirstTopic(record.lectureSchedule),
    syllabusPoints: [
      record.grading ? `評価: ${record.grading}` : null,
      record.preAndPostStudy ? `予習復習: ${record.preAndPostStudy}` : null,
      record.textbook ? `教科書: ${record.textbook}` : null,
    ].filter((p): p is string => p !== null),
  };
}

function buildDetailedClassNotes(record: SyllabusRecord): DetailedClassNotes {
  return {
    sourceUrl: record.sourceUrl,
    classFormat: record.classFormat,
    conductionType: record.conductionType,
    timetable: record.timetable,
    classroom: record.classroom,
    learningGoals: record.learningGoals,
    lectureSchedule: record.lectureSchedule,
    instructionMethod: record.instructionMethod,
    preAndPostStudy: record.preAndPostStudy,
    grading: record.grading,
    textbook: record.textbook,
    firstTopic: extractFirstTopic(record.lectureSchedule),
  };
}

// ---------- 組み立て ----------

const missingSourceError = (file: string, hint: string): string => `${file} がありません（${hint}）`;


export function buildSummary(inputs: SummaryInputs, index: CourseIndex, now: Date): Summary {
  const { registration, assignments, contents, announcements, coursework, academicSchedule, syllabi } = inputs;
  const holidays = new Set((inputs.academicCalendar?.nationalHolidays ?? []).map((holiday) => holiday.date));
  const courses = registration?.courses ?? [];
  const academicYear = registration?.academicYear ?? null;
  const resolver = createCourseResolver(index, coursework);
  const indexByCode = new Map(index.courses.map((entry) => [entry.courseCode, entry]));

  // 全体の一覧: 授業コードを付けて残す（引けなければ null = 科目不明）。
  const refOf = (ref: CourseRef): string | null => ref.courseCode;
  const assignmentRefs = new Map<string, CourseRef>();
  const sortedAssignments = sortAssignments(assignments?.assignments ?? []).map((assignment) => {
    const ref = resolver.resolve(assignment.courseName, aceCourseIdFrom(assignment.assignmentId));
    assignmentRefs.set(assignment.assignmentId, ref);
    return assignment;
  });
  const contentRefs = new Map<string, CourseRef>();
  const sortedContents = sortCourseContents(contents?.contents ?? []).map((content) => {
    const ref = resolver.resolve(content.courseName, aceCourseIdFrom(content.courseUrl) ?? aceCourseIdFrom(content.contentUrl));
    contentRefs.set(content.contentId, ref);
    return content;
  });
  const announcementRefs = new Map<string, CourseRef>();
  const sortedAnnouncements = (announcements?.announcements ?? []).map((announcement) => {
    let ref = resolver.resolve(announcement.courseNameHint, aceCourseIdFrom(announcement.sourceUrl));
    if (ref.courseCode === null && !announcement.courseNameHint) ref = resolver.resolveFromTitle(announcement.title);
    announcementRefs.set(announcement.announcementId, ref);
    return announcement;
  });

  const nextClass =
    courses
      .map((course) => inSemester(course, nextOccurrence(course, now), academicSchedule))
      .filter((course): course is CourseSummary => course !== null)
      .sort((a, b) => a.startsAtEpochMs - b.startsAtEpochMs)[0] ?? null;

  const nextClassRecord = nextClass ? findSyllabus(syllabi, nextClass.courseCode, academicYear) : null;
  const nextClassNotes = buildNextClassNotes(nextClass, nextClassRecord, now);

  const classesForOffset = (dayOffset: number): { classes: DetailedClassSummary[]; errors: string[] } => {
    const occurrences = courses
      .map((course) => ({
        course,
        classInfo: inSemester(course, occurrenceOnOffsetDay(course, now, dayOffset), academicSchedule),
      }))
      .filter((entry): entry is { course: Course; classInfo: CourseSummary } => entry.classInfo !== null)
      .sort((left, right) => left.classInfo.startsAtEpochMs - right.classInfo.startsAtEpochMs);

    const classes = occurrences.map(({ course, classInfo }): DetailedClassSummary => {
      const errors: string[] = [];
      const code = course.courseCode;
      const record = findSyllabus(syllabi, code, academicYear);
      if (!record) {
        errors.push(
          `Failed to load syllabus for ${course.courseName} (${code}): syllabus cache missing (toyo:daily が index の欠けを補完します)`
        );
      }

      const aceCourseId = indexByCode.get(code)?.aceCourseId ?? null;
      const courseworkCourse: CourseworkCourse | null =
        (aceCourseId ? coursework?.courses.find((c) => c.courseId === aceCourseId) : undefined) ??
        findCourseworkByCode(coursework, code);
      const belongs = (refs: Map<string, CourseRef>, id: string): boolean => refOf(refs.get(id) ?? { courseCode: null, aceCourseId: null }) === code;

      return {
        classInfo,
        coursework: courseworkCourse ? buildCourseworkBrief(courseworkCourse, now) : null,
        sessionNumber: sessionNumberFor(classInfo.startsAt.slice(0, 10), classInfo.day, academicSchedule, holidays),
        syllabus: record ? buildDetailedClassNotes(record) : null,
        relatedAssignments: sortedAssignments.filter((a) => belongs(assignmentRefs, a.assignmentId)),
        relatedContents: sortedContents.filter((c) => belongs(contentRefs, c.contentId)),
        relatedAnnouncements: sortedAnnouncements.filter((a) => belongs(announcementRefs, a.announcementId)),
        errors,
      };
    });
    return { classes, errors: classes.flatMap((item) => item.errors) };
  };

  const todayResult = classesForOffset(0);
  const tomorrowResult = classesForOffset(1);

  const missingErrors = [
    ...(registration ? [] : [missingSourceError('registration-data.json', 'toyo:sync で取得されます')]),
    ...(assignments ? [] : [missingSourceError('toyonet-ace-assignments.json', 'toyo:watch / toyo:daily で取得されます')]),
    ...(contents ? [] : [missingSourceError('toyonet-ace-contents.json', 'toyo:daily で取得されます')]),
    ...(announcements ? [] : [missingSourceError('announcements.json', 'toyo:watch / toyo:daily で取得されます')]),
  ];

  return {
    generatedAt: now.toISOString(),
    timezone: 'Asia/Tokyo',
    nextClass,
    nextClassNotes,
    todayClasses: todayResult.classes,
    tomorrowClasses: tomorrowResult.classes,
    upcomingAssignments: sortedAssignments.map((assignment) => {
      const ref = assignmentRefs.get(assignment.assignmentId) ?? { courseCode: null, aceCourseId: null };
      const course = ref.aceCourseId ? coursework?.courses.find((c) => c.courseId === ref.aceCourseId) : undefined;
      return { ...assignment, courseCode: refOf(ref), coursework: course ? buildCourseworkBrief(course, now) : null };
    }),
    courseworkSchedule: buildCourseworkSchedule(coursework, now, 14),
    courseContents: sortedContents.map((content) => ({ ...content, courseCode: refOf(contentRefs.get(content.contentId)!) })),
    announcements: sortedAnnouncements.map((announcement) => ({
      ...announcement,
      courseCode: refOf(announcementRefs.get(announcement.announcementId)!),
    })),
    sourceStatus: {
      portal: {
        available: registration ? registration.fetchStatus !== 'error' : false,
        fetchStatus: registration?.fetchStatus ?? 'error',
        fetchedAt: registration?.fetchedAt ?? null,
        path: registrationDataPath,
      },
      toyonetAce: {
        available: assignments?.available ?? false,
        fetchedAt: assignments?.fetchedAt ?? null,
        contentsAvailable: contents?.available ?? false,
        contentsFetchedAt: contents?.fetchedAt ?? null,
        announcementsAvailable: announcements?.available ?? false,
        announcementsFetchedAt: announcements?.fetchedAt ?? null,
        courseworkAvailable: coursework?.available ?? false,
        courseworkFetchedAt: coursework?.fetchedAt ?? null,
      },
    },
    errors: [
      ...missingErrors,
      ...(assignments?.errors ?? []),
      ...(contents?.errors ?? []),
      ...(announcements?.errors ?? []),
      ...todayResult.errors,
      ...tomorrowResult.errors,
    ],
  };
}
