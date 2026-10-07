// /v1/courses と /v1/assignments の科目統合ロジック（純粋関数。KV 読み出しと HTTP は index.ts 側）。
import type {
  Announcement,
  Assignment,
  CourseContent,
  CourseworkCourse,
  CourseworkFile,
  CourseworkItem,
  DiscordSummary,
  GradingComponent,
  GradingRule,
  GradingRulesFile,
  RegisteredCourse,
  RegistrationData,
  SyllabusFile,
} from './types';
import { courseKey } from './course-key';

// ---------- 科目インデックス ----------

export type CourseEntry = {
  registered: boolean;
  courseCode: string | null;
  courseName: string;
  aceCourseId: string | null;
  aceCourseName: string | null;
  semesterLabel: string | null;
  day: string | null;
  period: string | null;
  instructor: string | null;
  room: string | null;
  campus: string | null;
  deliveryMode: string | null;
  credits: number | null;
  /** 名前一致に使う表記すべて（正規化前） */
  names: string[];
  registration: RegisteredCourse | null;
  coursework: CourseworkCourse | null;
};

export function findCourseworkForCode(coursework: CourseworkFile | null, code: string): CourseworkCourse | null {
  if (!coursework) return null;
  const upper = code.toUpperCase();
  return coursework.courses.find((c) => c.courseCode?.toUpperCase() === upper || c.aceCourseCodes.some((x) => x.toUpperCase() === upper)) ?? null;
}

export function buildCourseIndex(reg: RegistrationData | null, coursework: CourseworkFile | null): CourseEntry[] {
  const entries: CourseEntry[] = [];
  const usedCourseIds = new Set<string>();
  for (const course of reg?.courses ?? []) {
    const cw = findCourseworkForCode(coursework, course.courseCode);
    if (cw) usedCourseIds.add(cw.courseId);
    entries.push({
      registered: true,
      courseCode: course.courseCode,
      courseName: course.courseName,
      aceCourseId: cw?.courseId ?? null,
      aceCourseName: cw?.courseName ?? null,
      semesterLabel: course.semesterLabel,
      day: course.day,
      period: course.period,
      instructor: course.instructor,
      room: course.room,
      campus: course.campus,
      deliveryMode: course.deliveryMode,
      credits: course.credits,
      names: [course.courseName, ...(cw ? [cw.courseName, cw.aceListName ?? ''] : [])].filter(Boolean),
      registration: course,
      coursework: cw,
    });
  }
  for (const cw of coursework?.courses ?? []) {
    if (usedCourseIds.has(cw.courseId) || cw.portalCourseName !== null) continue;
    entries.push({
      registered: false,
      courseCode: cw.courseCode,
      courseName: cw.courseName,
      aceCourseId: cw.courseId,
      aceCourseName: cw.courseName,
      semesterLabel: null,
      day: null,
      period: null,
      instructor: null,
      room: null,
      campus: null,
      deliveryMode: null,
      credits: null,
      names: [cw.courseName, cw.aceListName ?? ''].filter(Boolean),
      registration: null,
      coursework: cw,
    });
  }
  return entries;
}

export function courseSummaryLine(entry: CourseEntry) {
  return {
    courseCode: entry.courseCode,
    courseName: entry.courseName,
    aceCourseId: entry.aceCourseId,
    aceCourseName: entry.aceCourseName,
    semester: entry.semesterLabel,
    day: entry.day,
    period: entry.period,
    timetable: entry.day && entry.period !== null ? `${entry.semesterLabel ?? ''} ${entry.day}${entry.period ? entry.period + '限' : ''}`.trim() : null,
    instructor: entry.instructor,
    registered: entry.registered,
  };
}

export type Resolution =
  | { kind: 'one'; entry: CourseEntry }
  | { kind: 'many'; candidates: CourseEntry[] }
  | { kind: 'none' };

export function resolveCourse(index: CourseEntry[], rawKey: string): Resolution {
  const key = rawKey.trim();
  const upper = key.toUpperCase();
  const byCode = index.filter((e) => e.courseCode?.toUpperCase() === upper || e.coursework?.aceCourseCodes.some((c) => c.toUpperCase() === upper));
  if (byCode.length === 1) return { kind: 'one', entry: byCode[0]! };
  if (byCode.length > 1) return { kind: 'many', candidates: byCode };
  if (/^\d+$/.test(key)) {
    const byId = index.filter((e) => e.aceCourseId === key);
    if (byId.length === 1) return { kind: 'one', entry: byId[0]! };
    if (byId.length > 1) return { kind: 'many', candidates: byId };
  }
  const nk = courseKey(key);
  if (nk === '') return { kind: 'none' };
  const exact = index.filter((e) => e.names.some((n) => courseKey(n) === nk));
  if (exact.length === 1) return { kind: 'one', entry: exact[0]! };
  if (exact.length > 1) return { kind: 'many', candidates: exact };
  const partial = index.filter((e) => e.names.some((n) => {
    const nn = courseKey(n);
    return nn.includes(nk) || (nn.length >= 3 && nk.includes(nn));
  }));
  if (partial.length === 1) return { kind: 'one', entry: partial[0]! };
  if (partial.length > 1) return { kind: 'many', candidates: partial };
  return { kind: 'none' };
}

// ---------- シラバス ----------

export type LectureSession = { session: number; text: string };

function toAsciiDigits(s: string): number {
  return Number(s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
}

/**
 * 「第１回 … 第２回 …」が連結された講義スケジュールを回ごとに分ける。
 * 「第１回目映画紹介」のような本文中の言及を拾わないよう、1 から順番に増える「第N回」だけを区切りとして採用する。
 */
export function splitLectureSchedule(text: string): { preface: string; sessions: LectureSession[] } {
  const re = /第([0-9０-９]{1,2})回/g;
  const marks: Array<{ n: number; index: number; end: number }> = [];
  let expect = 1;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const n = toAsciiDigits(m[1]!);
    const end = m.index + m[0].length;
    if (n === expect && text[end] !== '目') {
      marks.push({ n, index: m.index, end });
      expect += 1;
    }
  }
  if (marks.length === 0) return { preface: text.trim(), sessions: [] };
  const sessions: LectureSession[] = marks.map((mark, i) => ({
    session: mark.n,
    text: text.slice(mark.index, i + 1 < marks.length ? marks[i + 1]!.index : text.length).trim(),
  }));
  return { preface: text.slice(0, marks[0]!.index).trim(), sessions };
}

// ---------- 成績ルールと課題の紐づけ ----------

export function findGradingRule(rules: GradingRulesFile | null, courseCode: string | null): GradingRule | null {
  if (!rules || !courseCode) return null;
  return rules.courses.find((c) => c.courseCode === courseCode) ?? null;
}

export type ItemKind = 'report' | 'query' | 'drill' | 'survey' | 'unknown';

export function itemKindFromId(assignmentId: string, sourceUrl: string | null): ItemKind {
  const m = /course_\d+_(report|query|drill|survey)_\d+/.exec(sourceUrl ?? assignmentId) ?? /course_\d+_(report|query|drill|survey)_\d+/.exec(assignmentId);
  return (m?.[1] as ItemKind | undefined) ?? 'unknown';
}

/** 課題の種別・題名から、成績ルールのどの要素に当たるか（見つからなければ null）。 */
export function matchGradingComponent(rule: GradingRule | null, kind: ItemKind, title: string): GradingComponent | null {
  if (!rule) return null;
  const finalish = /最終|期末|final/i.test(title);
  const preferred: string[] =
    finalish ? ['final-exam', 'quiz', 'assignment'] :
    kind === 'report' ? ['report', 'assignment'] :
    kind === 'query' ? ['quiz', 'assignment', 'midterm'] :
    kind === 'drill' ? ['final-exam', 'quiz'] : [];
  for (const k of preferred) {
    const hit = rule.components.find((c) => c.kind === k);
    if (hit) return hit;
  }
  return null;
}

export function assignmentCourseInfo(
  assignment: Assignment,
  index: CourseEntry[],
  rules: GradingRulesFile | null
) {
  const idMatch = /^course_(\d+)_/.exec(assignment.assignmentId);
  let entry = idMatch ? index.find((e) => e.aceCourseId === idMatch[1]) : undefined;
  if (!entry) {
    const nk = courseKey(assignment.courseName);
    entry = index.find((e) => e.names.some((n) => courseKey(n) === nk));
  }
  if (!entry) return null;
  const rule = findGradingRule(rules, entry.courseCode);
  const component = matchGradingComponent(rule, itemKindFromId(assignment.assignmentId, assignment.sourceUrl), assignment.title);
  const cw = entry.coursework;
  const counts = cw?.counts;
  return {
    courseCode: entry.courseCode,
    courseName: entry.courseName,
    gradingWeight: component ? { name: component.name, weightPercent: component.weightPercent, kind: component.kind, perSession: component.perSession, scenario: component.scenario ?? null } : null,
    cutoffs: rule?.cutoffs ?? [],
    coursework: counts ? { submitted: counts.submitted, notSubmitted: counts.notSubmittedOpen + counts.closedNotSubmitted } : null,
  };
}

/** includeWaiting=1 用: 受付開始待ちの report / query を課題の形にして返す。 */
export function waitingAssignments(coursework: CourseworkFile | null): Array<Assignment & { waiting: true; opensAt: string | null }> {
  const out: Array<Assignment & { waiting: true; opensAt: string | null }> = [];
  for (const course of coursework?.courses ?? []) {
    for (const item of course.items) {
      if (item.status !== 'waiting' || item.type === 'survey') continue;
      const idPart = /course_\d+_[a-z]+_\d+/.exec(item.url)?.[0] ?? `course_${course.courseId}_${item.type}_${item.itemId}`;
      out.push({
        assignmentId: idPart,
        courseName: course.courseName,
        title: item.title,
        dueAt: item.dueAt,
        status: 'pending',
        sourceUrl: item.url,
        notes: [`タイプ: ${item.type === 'report' ? 'レポート' : '小テスト'}`, ...(item.opensAt ? [`受付開始: ${item.opensAt}`] : []), '受付開始待ち（未提出一覧には未掲載）'],
        waiting: true,
        opensAt: item.opensAt,
      });
    }
  }
  return out;
}

// ---------- 科目詳細 ----------

function relatedAnnouncements(all: Announcement[], names: string[]): Announcement[] {
  const keys = names.map(courseKey).filter((k) => k !== '');
  const hit = all.filter((a) => {
    const hint = a.courseNameHint ? courseKey(a.courseNameHint) : null;
    if (hint !== null && keys.includes(hint)) return true;
    const title = courseKey(a.title);
    return keys.some((k) => k.length >= 3 && title.includes(k));
  });
  return hit.sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? '')).slice(0, 5);
}

function relatedContents(all: CourseContent[], courseId: string | null, names: string[]): CourseContent[] {
  const keys = names.map(courseKey);
  const hit = all.filter((c) => (courseId !== null && new RegExp(`course_${courseId}(?:\\D|$)`).test(c.courseUrl)) || keys.includes(courseKey(c.courseName)));
  return hit.sort((a, b) => (b.updatedAt ?? b.listedAt ?? '').localeCompare(a.updatedAt ?? a.listedAt ?? '')).slice(0, 5);
}

export function buildCourseDetail(args: {
  entry: CourseEntry;
  summary: DiscordSummary | null;
  coursework: CourseworkFile | null;
  rules: GradingRulesFile | null;
  syllabusFile: SyllabusFile | null;
  nowMs: number;
  todayString: string;
}) {
  const { entry, summary, coursework, rules, syllabusFile, todayString } = args;
  const code = entry.courseCode;

  // 今日の第 N 回: summary が今日のものでなければ null（古い summary の「今日」を信用しない）
  const generated = summary ? Date.parse(summary.generatedAt) : NaN;
  const summaryDateMismatch = summary === null || Number.isNaN(generated) ? null : new Date(generated + 9 * 3600_000).toISOString().slice(0, 10) !== todayString;
  const todayEntry = code && summary && summaryDateMismatch === false ? summary.todayClasses.find((c) => c.classInfo.courseCode === code) : undefined;
  const tomorrowEntry = code && summary && summaryDateMismatch === false ? summary.tomorrowClasses.find((c) => c.classInfo.courseCode === code) : undefined;
  const sessionNumberToday = todayEntry?.sessionNumber ?? null;
  const nextSessionNumber = sessionNumberToday !== null ? sessionNumberToday + 1 : (tomorrowEntry?.sessionNumber ?? null);

  const raw = syllabusFile?.syllabus;
  let syllabus: Record<string, unknown> | null = null;
  if (raw) {
    const split = splitLectureSchedule(raw.lectureSchedule ?? '');
    const pick = (n: number | null) => (n === null ? null : (split.sessions.find((s) => s.session === n) ?? null));
    syllabus = {
      fetchedAt: raw.fetchedAt ?? syllabusFile?.fetchedAt ?? null,
      sourceUrl: raw.sourceUrl ?? null,
      classFormat: raw.classFormat ?? null,
      conductionType: raw.conductionType ?? null,
      timetable: raw.timetable ?? null,
      classroom: raw.classroom ?? null,
      learningGoals: raw.learningGoals ?? null,
      instructionMethod: raw.instructionMethod ?? null,
      preAndPostStudy: raw.preAndPostStudy ?? null,
      grading: raw.grading ?? null,
      textbook: raw.textbook ?? null,
      lectureSchedulePreface: split.preface,
      lectureSchedule: split.sessions,
      lectureScheduleSplit: split.sessions.length > 0,
      lectureScheduleRaw: split.sessions.length === 0 ? (raw.lectureSchedule ?? null) : undefined,
      today: pick(sessionNumberToday),
      next: pick(nextSessionNumber),
    };
  }

  const names = entry.names;
  const courseId = entry.aceCourseId;
  const allAssignments: Assignment[] = summary ? [...summary.upcomingAssignments, ...(summary.deadlineUnknownAssignments ?? [])] : [];
  const nameKeys = names.map(courseKey);
  const assignments = allAssignments.filter((a) => {
    const m = /^course_(\d+)_/.exec(a.assignmentId);
    if (m && courseId !== null) return m[1] === courseId;
    return nameKeys.includes(courseKey(a.courseName));
  });

  const cw = entry.coursework;
  const submissions = cw && coursework ? coursework.submissions.filter((s) => s.courseId === cw.courseId) : [];

  return {
    summaryGeneratedAt: summary?.generatedAt ?? null,
    summaryDateMismatch,
    course: courseSummaryLine(entry),
    timetable: entry.registration,
    sessionNumberToday,
    nextSessionNumber,
    syllabus,
    syllabusAvailable: syllabus !== null,
    gradingRules: findGradingRule(rules, code),
    coursework: cw
      ? {
          courseId: cw.courseId,
          fetchedAt: cw.fetchedAt,
          counts: cw.counts,
          items: cw.items as CourseworkItem[],
          grades: cw.grades,
          recentSubmissions: submissions,
        }
      : null,
    courseworkFetchedAt: coursework?.fetchedAt ?? null,
    assignments,
    announcements: summary ? relatedAnnouncements(summary.announcements, names) : [],
    contents: summary ? relatedContents(summary.courseContents, courseId, names) : [],
  };
}
