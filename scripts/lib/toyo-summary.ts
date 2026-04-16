import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type Course,
  type EnrollmentData,
  outputDir,
  repoRoot,
} from './toyo-enrollment';
import { collectToyoNetAceAssignments, type Assignment } from './toyonet-ace';

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
  rawMarkdownPath: string | null;
};

export type DiscordSummary = {
  generatedAt: string;
  timezone: 'Asia/Tokyo';
  nextClass: DiscordCourseSummary | null;
  nextClassNotes: NextClassNotes | null;
  todayClasses: DiscordCourseSummary[];
  upcomingAssignments: Assignment[];
  sourceStatus: {
    portal: {
      available: boolean;
      fetchedAt: string | null;
      path: string;
    };
    toyonetAce: {
      available: boolean;
      fetchedAt: string | null;
    };
  };
  errors: string[];
};

const nextClassMarkdownPath = path.join(outputDir, 'next-class-summary.md');
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

function todayOccurrence(course: Course, now: Date): DiscordCourseSummary | null {
  const currentDayLabel = dayOrder[jstDayOfWeek(now)];
  if (course.day !== currentDayLabel) {
    return null;
  }

  const period = periodTimes.get(course.period);
  if (!period) {
    return null;
  }

  const datePart = formatJstDate(now);
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

async function readNextClassNotes(): Promise<NextClassNotes | null> {
  try {
    const content = await fs.readFile(nextClassMarkdownPath, 'utf8');
    const lines = content.split(/\r?\n/).map((line) => line.trim());

    const checkedAtLine = lines.find((line) => line.startsWith('- 確認日:'));
    const firstTopicIndex = lines.findIndex((line) => line === '## 初回内容');
    const syllabusIndex = lines.findIndex((line) => line === '## シラバス要点');

    const firstTopic =
      firstTopicIndex >= 0
        ? lines.slice(firstTopicIndex + 1).find((line) => line.startsWith('- '))?.replace(/^- /, '') ??
          null
        : null;

    const syllabusPoints: string[] = [];
    if (syllabusIndex >= 0) {
      for (const line of lines.slice(syllabusIndex + 1)) {
        if (line.startsWith('## ')) {
          break;
        }
        if (line.startsWith('- ')) {
          syllabusPoints.push(line.replace(/^- /, ''));
        }
      }
    }

    return {
      checkedAt: checkedAtLine?.replace(/^- 確認日:\s*/, '') ?? null,
      firstTopic,
      syllabusPoints,
      rawMarkdownPath: nextClassMarkdownPath,
    };
  } catch (error: unknown) {
    const message =
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? null
        : error instanceof Error
          ? error.message
          : String(error);
    if (message) {
      console.warn(`Failed to read next-class summary: ${message}`);
    }
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

export async function buildDiscordSummary(enrollment: EnrollmentData): Promise<DiscordSummary> {
  const now = new Date();
  const nextClass = enrollment.courses
    .map((course) => nextOccurrence(course, now))
    .filter((course): course is DiscordCourseSummary => course !== null)
    .sort((a, b) => a.startsAtEpochMs - b.startsAtEpochMs)[0] ?? null;

  const todayClasses = enrollment.courses
    .map((course) => todayOccurrence(course, now))
    .filter((course): course is DiscordCourseSummary => course !== null)
    .sort((a, b) => a.startsAtEpochMs - b.startsAtEpochMs);

  const assignmentResult = await collectToyoNetAceAssignments();
  const nextClassNotes = await readNextClassNotes();

  return {
    generatedAt: now.toISOString(),
    timezone: 'Asia/Tokyo',
    nextClass,
    nextClassNotes,
    todayClasses,
    upcomingAssignments: sortAssignments(assignmentResult.assignments),
    sourceStatus: {
      portal: {
        available: true,
        fetchedAt: enrollment.fetchedAt,
        path: path.join(outputDir, 'registration-data.json'),
      },
      toyonetAce: {
        available: assignmentResult.available,
        fetchedAt: assignmentResult.fetchedAt,
      },
    },
    errors: assignmentResult.errors,
  };
}

export async function writeDiscordSummary(summary: DiscordSummary): Promise<void> {
  await fs.mkdir(summaryOutputDir, { recursive: true });
  await fs.writeFile(discordSummaryOutputPath, JSON.stringify(summary, null, 2), 'utf8');
}
