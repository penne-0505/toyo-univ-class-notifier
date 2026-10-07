/**
 * 組み立て層: course-index.json（科目の対応表）を作る純粋関数。
 *
 * 規則: このファイルは Playwright も fetch も import しない（ファイルの中身を引数で受け取るだけ）。
 * 欠けている入力は null / 空配列で表し、取りに行かず警告にする。
 * scripts/dev/course-index.test.ts が、このモジュールを読み込んでも playwright が読み込まれないことを検査する。
 *
 * 突き合わせの順序: 授業コード → courseKey（科目名の正規化キー）。
 */
import { courseKey } from '../lib/course-key';
import { inferScheduleCd, syllabusFileStem } from '../lib/course-code';
import { courseInSemesterOn, jstDateString, semesterLabelFor, type AcademicSchedule } from '../lib/toyo-academic-schedule';

// ---------- 入力（必要なフィールドだけを持つ構造的な型。取得層の型には依存しない） ----------

export type RegistrationInput = {
  academicYear?: string;
  courses: Array<{
    courseCode: string;
    courseName: string;
    semesterLabel: string;
    day: string;
    period: string;
  }>;
};

export type CourseworkInput = {
  courses: Array<{
    courseId: string;
    courseName: string;
    aceListName: string | null;
    courseCode: string | null;
    aceCourseCodes: string[];
    portalCourseName?: string | null;
  }>;
};

export type CandidatesInput = {
  candidates: Array<{
    scheduleCd: string;
    courseCode?: string | null;
    syllabus?: { courseCode?: string | null } | null;
  }>;
};

export type GradingRulesInput = {
  courses: Array<{ courseCode: string; scheduleCd: string | null }>;
};

export type CourseIndexInputs = {
  registration: RegistrationInput | null;
  coursework: CourseworkInput | null;
  /** registration-candidates.json（最新）と期間別ファイルなど。無ければ空配列 */
  candidates: CandidatesInput[];
  /** output/toyo/syllabus/ のファイル名一覧（<授業コード>.json / .md） */
  syllabusFiles: string[];
  gradingRules: GradingRulesInput | null;
  /** 今学期の判定用（data/academic-schedule.json）。null なら全科目を今学期として扱う */
  academicSchedule: AcademicSchedule | null;
};

// ---------- 出力 ----------

export type CourseIndexEntry = {
  courseCode: string;
  semester: string;
  names: { portal: string; ace: string | null; key: string };
  aceCourseId: string | null;
  scheduleCd: string;
  /** scheduleCd が授業コードからの推定値（候補ファイルにも評価ルールにも無かった）のとき true */
  scheduleCdInferred?: true;
  slots: Array<{ day: string; period: string }>;
  /** 集中講義など、曜日・時限を持たない科目 */
  intensive: boolean;
  has: { syllabus: boolean; gradingRules: boolean; aceCourse: boolean };
  warnings: string[];
};

export type CourseIndex = {
  builtAt: string;
  academicYear: string | null;
  /** now の日付に対応する学期（判定できなければ null） */
  currentSemester: string | null;
  courses: CourseIndexEntry[];
  /** ACE にあるが、履修登録確認表のどの科目とも突き合わなかったコース */
  aceOnly: Array<{ aceCourseId: string; name: string }>;
};

export const WARNING_NO_SYLLABUS = 'シラバスのキャッシュが無い';
export const WARNING_NO_ACE_COURSE = 'ACE のコース一覧にまだ無い（登録の反映待ちの可能性）';
export const WARNING_NO_GRADING_RULES = '評価ルールが無い（data/grading-rules.json）';

type AceCourse = CourseworkInput['courses'][number];

function matchAceCourses(registered: RegistrationInput['courses'], aceCourses: AceCourse[]): Map<string, AceCourse> {
  const matches = new Map<string, AceCourse>();
  const used = new Set<string>();

  // 1. 授業コード（ACE は 1 コースに複数コードを持つことがある。例: 天文学B7 = 1010222007 / 2010133001）
  for (const course of registered) {
    const code = course.courseCode.toUpperCase();
    const hit = aceCourses.find(
      (ace) =>
        !used.has(ace.courseId) &&
        (ace.courseCode?.toUpperCase() === code || ace.aceCourseCodes.some((c) => c.toUpperCase() === code))
    );
    if (hit) {
      matches.set(course.courseCode, hit);
      used.add(hit.courseId);
    }
  }

  // 2. 科目名（courseKey）
  for (const course of registered) {
    if (matches.has(course.courseCode)) continue;
    const key = courseKey(course.courseName);
    const hit = aceCourses.find(
      (ace) =>
        !used.has(ace.courseId) &&
        [ace.portalCourseName, ace.courseName, ace.aceListName].some((name) => name != null && name !== '' && courseKey(name) === key)
    );
    if (hit) {
      matches.set(course.courseCode, hit);
      used.add(hit.courseId);
    }
  }
  return matches;
}

function resolveScheduleCd(
  courseCode: string,
  candidates: CandidatesInput[],
  gradingRules: GradingRulesInput | null
): { scheduleCd: string; inferred: boolean } {
  for (const file of candidates) {
    const hit = file.candidates.find((c) => c.syllabus?.courseCode === courseCode || c.courseCode === courseCode);
    if (hit?.scheduleCd) return { scheduleCd: hit.scheduleCd, inferred: false };
  }
  const rule = gradingRules?.courses.find((r) => r.courseCode === courseCode && r.scheduleCd);
  if (rule?.scheduleCd) return { scheduleCd: rule.scheduleCd, inferred: false };

  const inferred = inferScheduleCd(courseCode);
  // 候補一覧に推定値そのものがあれば、式が合っていたことが確認できる
  const confirmed = candidates.some((file) => file.candidates.some((c) => c.scheduleCd === inferred));
  return { scheduleCd: inferred, inferred: !confirmed };
}

export function buildCourseIndex(inputs: CourseIndexInputs, now: Date): CourseIndex {
  const today = jstDateString(now);
  const registered = inputs.registration?.courses ?? [];
  const aceCourses = inputs.coursework?.courses ?? [];
  const aceMatches = matchAceCourses(registered, aceCourses);
  const syllabusFiles = new Set(inputs.syllabusFiles);
  const ruleCodes = new Set((inputs.gradingRules?.courses ?? []).map((r) => r.courseCode));

  const courses: CourseIndexEntry[] = registered.map((course) => {
    const ace = aceMatches.get(course.courseCode) ?? null;
    const { scheduleCd, inferred } = resolveScheduleCd(course.courseCode, inputs.candidates, inputs.gradingRules);
    const intensive = course.day === '集中' || course.day.trim() === '';
    const has = {
      syllabus: syllabusFiles.has(`${syllabusFileStem(course.courseCode)}.json`),
      gradingRules: ruleCodes.has(course.courseCode),
      aceCourse: ace !== null,
    };

    // 警告は今学期の科目だけ。過去学期の科目（春学期のシラバスキャッシュなど）は騒がない
    const warnings: string[] = [];
    if (courseInSemesterOn(course.semesterLabel, today, inputs.academicSchedule)) {
      if (!has.syllabus) warnings.push(WARNING_NO_SYLLABUS);
      if (!has.aceCourse) warnings.push(WARNING_NO_ACE_COURSE);
      if (!has.gradingRules) warnings.push(WARNING_NO_GRADING_RULES);
    }

    const entry: CourseIndexEntry = {
      courseCode: course.courseCode,
      semester: course.semesterLabel,
      names: {
        portal: course.courseName,
        ace: ace ? (ace.aceListName ?? ace.courseName) : null,
        key: courseKey(course.courseName),
      },
      aceCourseId: ace?.courseId ?? null,
      scheduleCd,
      slots: intensive ? [] : [{ day: course.day, period: course.period }],
      intensive,
      has,
      warnings,
    };
    if (inferred) entry.scheduleCdInferred = true;
    return entry;
  });

  const matchedIds = new Set([...aceMatches.values()].map((ace) => ace.courseId));
  const aceOnly = aceCourses
    .filter((ace) => !matchedIds.has(ace.courseId))
    .map((ace) => ({ aceCourseId: ace.courseId, name: ace.aceListName ?? ace.courseName }));

  return {
    builtAt: now.toISOString(),
    academicYear: inputs.registration?.academicYear ?? null,
    currentSemester: semesterLabelFor(today, inputs.academicSchedule),
    courses,
    aceOnly,
  };
}
