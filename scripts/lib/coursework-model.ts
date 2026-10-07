/**
 * ACE コース別提出状況（coursework）の型と、取得済みデータから組み立てる純粋な関数。
 * playwright に依存しないので、組み立て層（scripts/build/）からも使える。取得そのものは toyonet-ace-coursework.ts。
 */

export type CourseworkItemType = 'report' | 'query' | 'survey';
export type CourseworkStatus = 'open' | 'waiting' | 'closed' | 'unknown';

export type CourseworkItem = {
  itemId: string;
  type: CourseworkItemType;
  title: string;
  url: string;
  status: CourseworkStatus;
  /** true: 提出済み / false: 未提出（受付開始待ちを含む） / null: 一覧から判別できなかった */
  submitted: boolean | null;
  opensAt: string | null;
  dueAt: string | null;
  /** 一覧の行テキスト（解釈の根拠）。 */
  raw: string;
};

export type CourseworkGrade = { title: string; score: string | null; note: string | null };

/** report + query のみの集計（アンケートは成績に関わらないので含めない）。 */
export type CourseworkCounts = {
  submitted: number;
  notSubmittedOpen: number;
  closedNotSubmitted: number;
  waiting: number;
};

export type CourseworkCourse = {
  courseId: string;
  /** コースページ見出しの ACE 表記 */
  courseName: string;
  /** コース一覧（home_course_all）上の表記。見出しと違うことがある（サンプル地理学B / サンプル地理学B7 など）。 */
  aceListName: string | null;
  /** 登録科目（registration-data.json）に突き合わせた授業コード。無ければ ACE 上の最初の授業コード。 */
  courseCode: string | null;
  /** ACE のコースページにある授業コードすべて（合併コースは複数） */
  aceCourseCodes: string[];
  /** registration-data.json 側の科目名。突き合わせできなければ null（自己登録コースなど）。 */
  portalCourseName: string | null;
  fetchedAt: string;
  items: CourseworkItem[];
  grades: CourseworkGrade[];
  counts: CourseworkCounts;
};

export type CourseworkSubmission = {
  courseId: string;
  type: string;
  itemId: string | null;
  title: string;
  courseName: string | null;
  submittedAt: string | null;
};

export type CourseworkResult = {
  fetchedAt: string;
  source: 'toyonet-ace';
  available: boolean;
  courses: CourseworkCourse[];
  submissions: CourseworkSubmission[];
  errors: string[];
};

export function computeCounts(items: CourseworkItem[]): CourseworkCounts {
  const counts: CourseworkCounts = { submitted: 0, notSubmittedOpen: 0, closedNotSubmitted: 0, waiting: 0 };
  for (const item of items) {
    if (item.type === 'survey') continue;
    if (item.status === 'waiting') counts.waiting += 1;
    else if (item.submitted === true) counts.submitted += 1;
    else if (item.submitted === false && item.status === 'open') counts.notSubmittedOpen += 1;
    else if (item.submitted === false && item.status === 'closed') counts.closedNotSubmitted += 1;
  }
  return counts;
}

export type CourseworkBrief = {
  courseId: string;
  submitted: number;
  /** 受付中の未提出 + 受付終了の未提出 */
  notSubmitted: number;
  notSubmittedOpen: number;
  closedNotSubmitted: number;
  waiting: number;
  /** 提出済みの種別内訳（足切りの回数カウント用。アンケートは除く） */
  submittedByType: { report: number; query: number };
  /** これから受付が始まる項目のうち最も早い受付開始日時 */
  nextOpensAt: string | null;
  fetchedAt: string;
};

export function buildCourseworkBrief(course: CourseworkCourse, now: Date): CourseworkBrief {
  const counts = computeCounts(course.items);
  const nowMs = now.getTime();
  const upcomingOpens = course.items
    .filter((i) => i.type !== 'survey' && i.status === 'waiting' && i.opensAt && Date.parse(i.opensAt) > nowMs)
    .map((i) => i.opensAt as string)
    .sort();
  return {
    courseId: course.courseId,
    submitted: counts.submitted,
    notSubmitted: counts.notSubmittedOpen + counts.closedNotSubmitted,
    notSubmittedOpen: counts.notSubmittedOpen,
    closedNotSubmitted: counts.closedNotSubmitted,
    waiting: counts.waiting,
    submittedByType: {
      report: course.items.filter((i) => i.type === 'report' && i.submitted === true).length,
      query: course.items.filter((i) => i.type === 'query' && i.submitted === true).length,
    },
    nextOpensAt: upcomingOpens[0] ?? null,
    fetchedAt: course.fetchedAt,
  };
}

export function findCourseworkByCode(result: CourseworkResult | null, courseCode: string): CourseworkCourse | null {
  if (!result) return null;
  return (
    result.courses.find((c) => c.courseCode === courseCode || c.aceCourseCodes.includes(courseCode)) ?? null
  );
}

export type CourseworkScheduleEntry = {
  courseId: string;
  courseName: string;
  courseCode: string | null;
  portalCourseName: string | null;
  type: CourseworkItemType;
  itemId: string;
  title: string;
  url: string;
  status: CourseworkStatus;
  submitted: boolean | null;
  opensAt: string | null;
  dueAt: string;
};

/** 今から horizonDays 日以内に締切が来る項目（受付開始待ちを含む）を dueAt 順に。 */
export function buildCourseworkSchedule(
  result: CourseworkResult | null,
  now: Date,
  horizonDays = 14
): CourseworkScheduleEntry[] {
  if (!result) return [];
  const from = now.getTime();
  const to = from + horizonDays * 24 * 60 * 60 * 1000;
  const out: CourseworkScheduleEntry[] = [];
  for (const course of result.courses) {
    for (const item of course.items) {
      const due = item.dueAt ? Date.parse(item.dueAt) : NaN;
      if (Number.isNaN(due) || due < from || due > to) continue;
      out.push({
        courseId: course.courseId,
        courseName: course.courseName,
        courseCode: course.courseCode,
        portalCourseName: course.portalCourseName,
        type: item.type,
        itemId: item.itemId,
        title: item.title,
        url: item.url,
        status: item.status,
        submitted: item.submitted,
        opensAt: item.opensAt,
        dueAt: item.dueAt as string,
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.courseName.localeCompare(b.courseName, 'ja'));
}
