import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type Course,
  type EnrollmentData,
  outputDir,
  repoRoot,
} from './toyo-enrollment';
import {
  collectToyoNetAceAssignments,
  collectToyoNetAceContents,
  type Assignment,
  type AssignmentCollectionResult,
  type CourseContent,
  type CourseContentCollectionResult,
} from './toyonet-ace';
import { fetchSyllabusWithCache, type SyllabusRecord } from './toyo-syllabus';
import { sessionNumberFor } from './toyo-academic-schedule';
import {
  collectToyoNetAceAnnouncements,
  type Announcement,
  type AnnouncementCollectionResult,
} from './toyo-announcements';

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

export type DiscordCourseSummary = {
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
  classInfo: DiscordCourseSummary;
  /** その曜日の第何回授業日か。academic-schedule.json が無い・集中講義・授業期間外などで計算できなければ null。 */
  sessionNumber: number | null;
  syllabus: DetailedClassNotes | null;
  relatedAssignments: Assignment[];
  relatedContents: CourseContent[];
  relatedAnnouncements: Announcement[];
  errors: string[];
};

export type DiscordSummary = {
  generatedAt: string;
  timezone: 'Asia/Tokyo';
  nextClass: DiscordCourseSummary | null;
  nextClassNotes: NextClassNotes | null;
  todayClasses: DetailedClassSummary[];
  tomorrowClasses: DetailedClassSummary[];
  upcomingAssignments: Assignment[];
  courseContents: CourseContent[];
  announcements: Announcement[];
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
    };
  };
  errors: string[];
};

const summaryOutputDir = path.join(repoRoot, 'output', 'bot');
export const discordSummaryOutputPath = path.join(summaryOutputDir, 'summary.json');

function jstDate(date: Date): Date {
  return new Date(date.getTime() + JST_OFFSET_MINUTES * 60_000);
}

function formatJstDate(date: Date): string {
  const shifted = jstDate(date);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

function nextOccurrence(course: Course, now: Date): DiscordCourseSummary | null {
  const targetDay = dayNumberByLabel.get(course.day);
  const period = periodTimes.get(course.period);
  if (targetDay === undefined || !period) {
    return null;
  }

  const currentDay = jstDayOfWeek(now);
  const currentMinutes = jstMinutes(now);
  const [startHour, startMinute] = period.start.split(':').map(Number);
  const [endHour, endMinute] = period.end.split(':').map(Number);
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;

  let daysAhead = (targetDay - currentDay + 7) % 7;
  if (daysAhead === 0 && currentMinutes >= startMinutes) {
    daysAhead = 7;
  }

  const shifted = jstDate(now);
  shifted.setUTCDate(shifted.getUTCDate() + daysAhead);
  const datePart = [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0'),
  ].join('-');

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

function occurrenceOnOffsetDay(
  course: Course,
  now: Date,
  dayOffset: number
): DiscordCourseSummary | null {
  const targetDate = offsetJstDate(now, dayOffset);
  const currentDayLabel = dayOrder[targetDate.getUTCDay()];
  if (course.day !== currentDayLabel) {
    return null;
  }

  const period = periodTimes.get(course.period);
  if (!period) {
    return null;
  }

  const datePart = formatShiftedDate(targetDate);
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

function todayOccurrence(course: Course, now: Date): DiscordCourseSummary | null {
  return occurrenceOnOffsetDay(course, now, 0);
}

function tomorrowOccurrence(course: Course, now: Date): DiscordCourseSummary | null {
  return occurrenceOnOffsetDay(course, now, 1);
}

async function buildNextClassNotes(
  nextClass: DiscordCourseSummary | null,
  enrollment: EnrollmentData
): Promise<NextClassNotes | null> {
  if (!nextClass) return null;

  const course = enrollment.courses.find((c) => c.courseCode === nextClass.courseCode);
  if (!course) return null;

  try {
    const record = await fetchSyllabusWithCache({
      ...course,
      academicYear: enrollment.academicYear,
    });

    return {
      checkedAt: formatJstDate(new Date()),
      firstTopic: extractFirstTopic(record.lectureSchedule),
      syllabusPoints: [
        record.grading ? `評価: ${record.grading}` : null,
        record.preAndPostStudy ? `予習復習: ${record.preAndPostStudy}` : null,
        record.textbook ? `教科書: ${record.textbook}` : null,
      ].filter((p): p is string => p !== null),
    };
  } catch (error: unknown) {
    console.warn(
      `Failed to build next-class notes for ${course.courseName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

function sortAssignments(assignments: Assignment[]): Assignment[] {
  return [...assignments].sort((a, b) => {
    if (a.dueAt && b.dueAt) {
      return Date.parse(a.dueAt) - Date.parse(b.dueAt);
    }
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return a.title.localeCompare(b.title, 'ja');
  });
}

function relatedAssignments(assignments: Assignment[], courseName: string): Assignment[] {
  return sortAssignments(assignments).filter((assignment) => assignment.courseName === courseName);
}

function sortCourseContents(contents: CourseContent[]): CourseContent[] {
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

function relatedContents(contents: CourseContent[], courseName: string): CourseContent[] {
  return sortCourseContents(contents).filter((item) => item.courseName === courseName);
}

function extractFirstTopic(lectureSchedule: string): string | null {
  const normalized = lectureSchedule.replace(/\s+/g, ' ').trim();
  const match = normalized.match(
    /(第[0-9０-９一二三四五六七八九十]+[項回](?:[:：︓]\s*|\s+).*?)(?=第[0-9０-９一二三四五六七八九十]+[項回](?:[:：︓]\s*|\s+)|※|$)/
  );
  return match?.[1]?.replace(/\s+/g, ' ').replace(/[（(]\s*$/, '').trim() ?? null;
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

function relatedAnnouncements(announcements: Announcement[], courseName: string): Announcement[] {
  return announcements.filter(
    (a) =>
      a.courseNameHint === courseName ||
      a.title.includes(courseName) ||
      (courseName.length >= 4 && a.title.includes(courseName.slice(0, 4)))
  );
}

async function buildDetailedClassesForOffset(
  enrollment: EnrollmentData,
  assignments: Assignment[],
  contents: CourseContent[],
  announcements: Announcement[],
  now: Date,
  dayOffset: number
): Promise<{ classes: DetailedClassSummary[]; errors: string[] }> {
  const classes = enrollment.courses
    .map((course) => ({
      course,
      classInfo: dayOffset === 0 ? todayOccurrence(course, now) : tomorrowOccurrence(course, now),
    }))
    .filter(
      (entry): entry is { course: Course; classInfo: DiscordCourseSummary } => entry.classInfo !== null
    )
    .sort((left, right) => left.classInfo.startsAtEpochMs - right.classInfo.startsAtEpochMs);

  const syllabusCache = new Map<string, Promise<SyllabusRecord>>();
  const detailedClasses = await Promise.all(
    classes.map(async ({ course, classInfo }) => {
      const errors: string[] = [];
      let syllabus: DetailedClassNotes | null = null;

      try {
        let syllabusPromise = syllabusCache.get(course.courseCode);
        if (!syllabusPromise) {
          syllabusPromise = fetchSyllabusWithCache({
            ...course,
            academicYear: enrollment.academicYear,
          });
          syllabusCache.set(course.courseCode, syllabusPromise);
        }
        const record = await syllabusPromise;
        syllabus = buildDetailedClassNotes(record);
      } catch (error: unknown) {
        errors.push(
          `Failed to fetch syllabus for ${course.courseName} (${course.courseCode}): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      return {
        classInfo,
        sessionNumber: sessionNumberFor(classInfo.startsAt.slice(0, 10), classInfo.day),
        syllabus,
        relatedAssignments: relatedAssignments(assignments, classInfo.courseName),
        relatedContents: relatedContents(contents, classInfo.courseName),
        relatedAnnouncements: relatedAnnouncements(announcements, classInfo.courseName),
        errors,
      } satisfies DetailedClassSummary;
    })
  );

  return {
    classes: detailedClasses,
    errors: detailedClasses.flatMap((item) => item.errors),
  };
}

/** 取得済みの ACE 結果を渡すと、ポータルへ再アクセスせずに summary を組み立てる（toyo:watch 用）。 */
export type PrefetchedAceResults = {
  assignments: AssignmentCollectionResult;
  contents: CourseContentCollectionResult;
  announcements: AnnouncementCollectionResult;
};

export async function buildDiscordSummary(
  enrollment: EnrollmentData,
  prefetched?: PrefetchedAceResults
): Promise<DiscordSummary> {
  const now = new Date();
  const courseNames = enrollment.courses.map((course) => course.courseName);

  const nextClass = enrollment.courses
    .map((course) => nextOccurrence(course, now))
    .filter((course): course is DiscordCourseSummary => course !== null)
    .sort((a, b) => a.startsAtEpochMs - b.startsAtEpochMs)[0] ?? null;

  const [assignmentResult, contentResult, announcementResult] = prefetched
    ? [prefetched.assignments, prefetched.contents, prefetched.announcements]
    : await Promise.all([
        collectToyoNetAceAssignments(),
        collectToyoNetAceContents(courseNames),
        collectToyoNetAceAnnouncements(courseNames),
      ]);

  const nextClassNotes = await buildNextClassNotes(nextClass, enrollment);
  const sortedAssignments = sortAssignments(assignmentResult.assignments);
  const sortedContents = sortCourseContents(contentResult.contents);
  const sortedAnnouncements = announcementResult.announcements;

  const todayResult = await buildDetailedClassesForOffset(
    enrollment,
    sortedAssignments,
    sortedContents,
    sortedAnnouncements,
    now,
    0
  );
  const tomorrowResult = await buildDetailedClassesForOffset(
    enrollment,
    sortedAssignments,
    sortedContents,
    sortedAnnouncements,
    now,
    1
  );

  return {
    generatedAt: now.toISOString(),
    timezone: 'Asia/Tokyo',
    nextClass,
    nextClassNotes,
    todayClasses: todayResult.classes,
    tomorrowClasses: tomorrowResult.classes,
    upcomingAssignments: sortedAssignments,
    courseContents: sortedContents,
    announcements: sortedAnnouncements,
    sourceStatus: {
      portal: {
        available: enrollment.fetchStatus !== 'error',
        fetchStatus: enrollment.fetchStatus,
        fetchedAt: enrollment.fetchedAt,
        path: path.join(outputDir, 'registration-data.json'),
      },
      toyonetAce: {
        available: assignmentResult.available,
        fetchedAt: assignmentResult.fetchedAt,
        contentsAvailable: contentResult.available,
        contentsFetchedAt: contentResult.fetchedAt,
        announcementsAvailable: announcementResult.available,
        announcementsFetchedAt: announcementResult.fetchedAt,
      },
    },
    errors: [
      ...assignmentResult.errors,
      ...contentResult.errors,
      ...announcementResult.errors,
      ...todayResult.errors,
      ...tomorrowResult.errors,
    ],
  };
}

export async function writeDiscordSummary(summary: DiscordSummary): Promise<void> {
  await fs.mkdir(summaryOutputDir, { recursive: true });
  await fs.writeFile(discordSummaryOutputPath, JSON.stringify(summary, null, 2), 'utf8');
}
