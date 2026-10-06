import fs from 'node:fs/promises';
import path from 'node:path';
import { type Page } from 'playwright';
import { type Course, type EnrollmentData, jsonOutputPath, outputDir } from './toyo-enrollment';
import {
  getOrCreatePage,
  launchStateContext,
  recoverToyoSessionIfNeeded,
  shouldRunHeadless,
} from './toyo';
import { normalizeCourseKey, toJstIso } from './toyonet-ace';

/**
 * ToyoNet-ACE（manaba）のコース別「提出状況」の収集。
 * 各コースの _report / _query / _survey / _grade と、提出記録（home_submitlog）を読む。
 * 授業コード（コースページ先頭の coursecode）で registration-data.json の courseCode と突き合わせる。
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
  /** コース一覧（home_course_all）上の表記。見出しと違うことがある（天文学B / 天文学B7 など）。 */
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

export const courseworkOutputPath = path.join(outputDir, 'toyonet-ace-coursework.json');

const aceBase = 'https://www.ace.toyo.ac.jp/ct/';
const courseListUrl = `${aceBase}home_course_all?chglistformat=list`;
const submitLogUrl = `${aceBase}home_submitlog?daterange=30`;
const SUBMITLOG_MAX_PAGES = 5;

// ---------------------------------------------------------------------------
// ブラウザ側コード（tsx/esbuild の __name 注入を避けるため文字列で渡す）
// ---------------------------------------------------------------------------

const readCourseListScript = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const out = [];
  for (const tr of document.querySelectorAll('tr')) {
    const a = [...tr.querySelectorAll('a[href]')].find((x) => /(^|\\/)course_\\d+$/.test(x.getAttribute('href') || ''));
    if (!a) continue;
    const m = /course_(\\d+)$/.exec(a.getAttribute('href'));
    const cells = [...tr.children].map((td) => clean(td.textContent));
    const year = cells.find((c) => /^\\d{4}$/.test(c)) || null;
    const term = cells.find((c) => /学期/.test(c)) || null;
    out.push({ courseId: m[1], name: clean(a.getAttribute('title') || a.textContent), year, term });
  }
  return out;
})()`;

const readCoursePageScript = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const codeEl = document.querySelector('.coursecode');
  const nameEl = document.querySelector('#coursename');
  const body = document.querySelector('.contentbody-l');
  const bodyText = clean(body ? body.textContent : document.body.innerText);
  const rows = [];
  for (const tr of document.querySelectorAll('.contentbody-l table tr')) {
    const head = [...tr.querySelectorAll('th')].map((c) => clean(c.textContent));
    const cells = [...tr.querySelectorAll('td')].map((c) => clean(c.textContent));
    const anchors = [...tr.querySelectorAll('a[href]')].map((a) => ({ href: a.getAttribute('href') || '', text: clean(a.textContent) }));
    rows.push({ head, cells, anchors, text: clean(tr.textContent) });
  }
  return {
    url: location.href,
    codeText: codeEl ? clean(codeEl.textContent) : '',
    courseName: nameEl ? clean(nameEl.getAttribute('title') || nameEl.textContent) : '',
    bodyText,
    rows,
    nextHref: (() => { const a = [...document.querySelectorAll('.navigator a')].find((x) => /次へ/.test(x.textContent || '')); return a ? a.getAttribute('href') : null; })(),
  };
})()`;

const readGradesScript = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const out = [];
  const trs = [...document.querySelectorAll('.contentbody-l table tr')];
  trs.forEach((tr, i) => {
    const h = tr.querySelector('.grade-title');
    if (!h) return;
    const gradeCell = tr.querySelector('td.grade');
    let score = '';
    if (gradeCell) {
      const clone = gradeCell.cloneNode(true);
      clone.querySelectorAll('a').forEach((a) => a.remove());
      score = clean(clone.textContent);
    }
    const next = trs[i + 1];
    const summary = next && next.querySelector('.gradesummary') ? clean(next.querySelector('.gradesummary').textContent) : '';
    out.push({ title: clean(h.getAttribute('title') || h.textContent), score, note: summary });
  });
  return { bodyText: clean((document.querySelector('.contentbody-l') || document.body).textContent), grades: out };
})()`;

const readSubmitLogScript = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const out = [];
  let date = '';
  for (const tr of document.querySelectorAll('.submit-log tr')) {
    const d = tr.querySelector('th span');
    if (d && /\\d{4}-\\d{2}-\\d{2}/.test(d.textContent || '')) date = clean(d.textContent);
    const time = tr.querySelector('td span.eventlist-day');
    const anchors = [...tr.querySelectorAll('a[href]')].map((a) => ({ href: a.getAttribute('href') || '', text: clean(a.textContent) }));
    if (!time || anchors.length === 0) continue;
    const tds = [...tr.querySelectorAll('td')].map((c) => clean(c.textContent));
    out.push({ date, time: clean(time.textContent), type: tds.find((c) => /^\\[.+\\]$/.test(c)) || '', anchors });
  }
  return { rows: out, nextHref: (() => { const a = [...document.querySelectorAll('.navigator a')].find((x) => /次へ/.test(x.textContent || '')); return a ? a.getAttribute('href') : null; })() };
})()`;

type PageRow = {
  head: string[];
  cells: string[];
  anchors: Array<{ href: string; text: string }>;
  text: string;
};

type CoursePageSnapshot = {
  url: string;
  codeText: string;
  courseName: string;
  bodyText: string;
  rows: PageRow[];
  nextHref: string | null;
};

type SubmitLogSnapshot = {
  rows: Array<{
    date: string;
    time: string;
    type: string;
    anchors: Array<{ href: string; text: string }>;
  }>;
  nextHref: string | null;
};

type CourseListEntry = { courseId: string; name: string; year: string | null; term: string | null };

// ---------------------------------------------------------------------------
// 解釈（純粋関数）
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/;
const SUBMITTED_RE = /提出済|提出完了|採点済|採点中|回答済|受験済|受付済|評価済|確認済|提出しました/;
/** drill（Web最終テストなど）は小テスト一覧に並ぶので query 扱いにする。 */
const ITEM_HREF_RE = /course_(\d+)_(report|query|survey|drill)_(\d+)/;

export function parseCourseCodes(codeText: string): string[] {
  return codeText
    .replace(/ /g, ' ')
    .split(/[,、\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^[0-9A-Z]{6,}$/i.test(s));
}

export function parseStatus(text: string): CourseworkStatus {
  if (/受付開始待ち/.test(text)) return 'waiting';
  if (/受付終了/.test(text)) return 'closed';
  if (/受付中/.test(text)) return 'open';
  return 'unknown';
}

export function parseItemRow(row: PageRow, courseId: string): CourseworkItem | null {
  const link = row.anchors.find((a) => ITEM_HREF_RE.test(a.href));
  if (!link) return null;
  const m = ITEM_HREF_RE.exec(link.href)!;
  if (m[1] !== courseId) return null;
  const type: CourseworkItemType = m[2] === 'drill' ? 'query' : (m[2] as CourseworkItemType);

  const statusCell = row.cells.find((c) => /受付(中|開始待ち|終了)/.test(c)) ?? '';
  const status = parseStatus(statusCell);
  const dates = row.cells.filter((c) => DATE_RE.test(c)).map((c) => toJstIso(c));
  let submitted: boolean | null = null;
  if (/未提出|未受験|未回答/.test(statusCell)) submitted = false;
  else if (SUBMITTED_RE.test(statusCell)) submitted = true;
  else if (status === 'waiting') submitted = false;

  return {
    itemId: m[3],
    type,
    title: link.text,
    url: new URL(link.href, aceBase).href,
    status,
    submitted,
    opensAt: dates[0] ?? null,
    dueAt: dates[1] ?? null,
    raw: row.text,
  };
}

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

export function parseGrades(snapshot: { grades: Array<{ title: string; score: string; note: string }> }): CourseworkGrade[] {
  return snapshot.grades
    .filter((g) => g.title)
    .map((g) => ({ title: g.title, score: g.score && g.score !== '-' ? g.score : null, note: g.note || null }));
}

function parseSubmitLog(snapshot: SubmitLogSnapshot): CourseworkSubmission[] {
  const out: CourseworkSubmission[] = [];
  for (const row of snapshot.rows) {
    const itemLink = row.anchors.find((a) => /course_\d+_(report|query|survey|drill|project)_\d+/.test(a.href));
    const courseLink = row.anchors.find((a) => /(^|\/)course_\d+$/.test(a.href));
    if (!itemLink) continue;
    const m = /course_(\d+)_([a-z]+)_(\d+)/.exec(itemLink.href)!;
    out.push({
      courseId: m[1],
      type: m[2],
      itemId: m[3],
      title: itemLink.text,
      courseName: courseLink ? courseLink.text.replace(/^\[|\]$/g, '') : null,
      submittedAt: toJstIso(`${row.date} ${row.time}`),
    });
  }
  return out;
}

function matchRegisteredCourse(
  codes: string[],
  aceName: string,
  registered: Course[]
): Course | null {
  for (const code of codes) {
    const hit = registered.find((c) => c.courseCode.toUpperCase() === code.toUpperCase());
    if (hit) return hit;
  }
  const key = normalizeCourseKey(aceName);
  return registered.find((c) => normalizeCourseKey(c.courseName) === key) ?? null;
}

// ---------------------------------------------------------------------------
// 取得
// ---------------------------------------------------------------------------

async function gotoAce(page: Page, url: string, tag: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await recoverToyoSessionIfNeeded(page, { returnUrl: url, saveState: true, snapshotTag: `toyonet-ace-coursework-${tag}` });
  if (/\/login|slink\.secioss\.com/.test(page.url())) {
    throw new Error(`ACE session lost while opening ${url} (now at ${page.url()})`);
  }
}

async function readCoursePage(page: Page, url: string, tag: string): Promise<CoursePageSnapshot> {
  await gotoAce(page, url, tag);
  return (await page.evaluate(readCoursePageScript)) as CoursePageSnapshot;
}

async function readPreviousResult(): Promise<CourseworkResult | null> {
  try {
    return JSON.parse(await fs.readFile(courseworkOutputPath, 'utf8')) as CourseworkResult;
  } catch {
    return null;
  }
}

async function readEnrollment(): Promise<EnrollmentData | null> {
  try {
    return JSON.parse(await fs.readFile(jsonOutputPath, 'utf8')) as EnrollmentData;
  } catch {
    return null;
  }
}

async function collectCourse(
  page: Page,
  entry: CourseListEntry,
  registered: Course[],
  fetchedAt: string
): Promise<CourseworkCourse> {
  const id = entry.courseId;
  const report = await readCoursePage(page, `${aceBase}course_${id}_report`, `${id}-report`);
  const aceCourseCodes = parseCourseCodes(report.codeText);
  const courseName = report.courseName || entry.name;
  const reg = matchRegisteredCourse(aceCourseCodes, courseName, registered) ?? matchRegisteredCourse([], entry.name, registered);

  const items = new Map<string, CourseworkItem>();
  const collect = (snapshot: CoursePageSnapshot): void => {
    for (const row of snapshot.rows) {
      const item = parseItemRow(row, id);
      if (item && !items.has(`${item.type}:${item.itemId}`)) items.set(`${item.type}:${item.itemId}`, item);
    }
  };
  collect(report);
  collect(await readCoursePage(page, `${aceBase}course_${id}_query`, `${id}-query`));
  collect(await readCoursePage(page, `${aceBase}course_${id}_survey`, `${id}-survey`));
  await gotoAce(page, `${aceBase}course_${id}_grade`, `${id}-grade`);
  const grades = parseGrades((await page.evaluate(readGradesScript)) as { grades: Array<{ title: string; score: string; note: string }> });

  const list = [...items.values()].sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || a.title.localeCompare(b.title, 'ja'));
  return {
    courseId: id,
    courseName,
    aceListName: entry.name || null,
    courseCode: reg?.courseCode ?? aceCourseCodes[0] ?? null,
    aceCourseCodes,
    portalCourseName: reg?.courseName ?? null,
    fetchedAt,
    items: list,
    grades,
    counts: computeCounts(list),
  };
}

async function collectSubmitLog(page: Page): Promise<CourseworkSubmission[]> {
  const out: CourseworkSubmission[] = [];
  let url: string | null = submitLogUrl;
  for (let i = 0; i < SUBMITLOG_MAX_PAGES && url; i += 1) {
    await gotoAce(page, url, `submitlog-${i + 1}`);
    const snap = (await page.evaluate(readSubmitLogScript)) as SubmitLogSnapshot;
    out.push(...parseSubmitLog(snap));
    url = snap.nextHref ? new URL(snap.nextHref, page.url()).href : null;
  }
  return out;
}

/** 提出記録に itemId が載っていれば、一覧で判別できなかった / 未提出と読んだ項目も提出済みに直す。 */
function reconcileWithSubmissions(courses: CourseworkCourse[], submissions: CourseworkSubmission[]): void {
  const done = new Set(submissions.filter((s) => s.itemId).map((s) => `${s.courseId}:${s.itemId}`));
  for (const course of courses) {
    let changed = false;
    for (const item of course.items) {
      if (item.submitted !== true && done.has(`${course.courseId}:${item.itemId}`)) {
        item.submitted = true;
        changed = true;
      }
    }
    if (changed) course.counts = computeCounts(course.items);
  }
}

export type CollectCourseworkOptions = {
  /** 取得しなかったコースの前回データを引き継ぐ（コース単位の失敗時）。 */
  keepPreviousOnError?: boolean;
};

export async function collectToyoNetAceCoursework(
  options: CollectCourseworkOptions = {}
): Promise<CourseworkResult> {
  const fetchedAt = new Date().toISOString();
  const errors: string[] = [];
  const enrollment = await readEnrollment();
  const registered = enrollment?.courses ?? [];
  const academicYear = enrollment?.academicYear ?? String(new Date().getFullYear());
  const previous = await readPreviousResult();

  const { browser, context } = await launchStateContext({ headless: shouldRunHeadless(true) });
  const page = await getOrCreatePage(context);
  const courses: CourseworkCourse[] = [];
  let submissions: CourseworkSubmission[] = [];

  try {
    await gotoAce(page, courseListUrl, 'course-list');
    const entries = ((await page.evaluate(readCourseListScript)) as CourseListEntry[]).filter(
      (e) => e.year === academicYear
    );
    const unique = [...new Map(entries.map((e) => [e.courseId, e])).values()];
    if (unique.length === 0) {
      throw new Error(`ACE のコース一覧に ${academicYear} 年度のコースが見つかりません`);
    }

    for (const entry of unique) {
      try {
        const course = await collectCourse(page, entry, registered, fetchedAt);
        // 授業コードが無く登録科目にも当たらないコース（学部のお知らせ用コース等）は対象外
        if (course.aceCourseCodes.length === 0 && course.portalCourseName === null) continue;
        courses.push(course);
      } catch (error: unknown) {
        errors.push(`course ${entry.courseId} (${entry.name}): ${error instanceof Error ? error.message : String(error)}`);
        const old = previous?.courses.find((c) => c.courseId === entry.courseId);
        if (old && options.keepPreviousOnError !== false) courses.push(old);
      }
    }

    try {
      submissions = await collectSubmitLog(page);
    } catch (error: unknown) {
      errors.push(`submitlog: ${error instanceof Error ? error.message : String(error)}`);
      submissions = previous?.submissions ?? [];
    }
    reconcileWithSubmissions(courses, submissions);

    const result: CourseworkResult = {
      fetchedAt,
      source: 'toyonet-ace',
      available: courses.length > 0,
      courses,
      submissions,
      errors,
    };
    await fs.mkdir(path.dirname(courseworkOutputPath), { recursive: true });
    await fs.writeFile(courseworkOutputPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
    return result;
  } catch (error: unknown) {
    // 全体失敗では前回の正常データを壊さない（書き込まない）
    return {
      fetchedAt,
      source: 'toyonet-ace',
      available: false,
      courses: [],
      submissions: [],
      errors: [...errors, `Failed to collect ToyoNet-ACE coursework: ${error instanceof Error ? error.message : String(error)}`],
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// 読み出し側ヘルパ（summary / context 用）
// ---------------------------------------------------------------------------

export async function loadCoursework(): Promise<CourseworkResult | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(courseworkOutputPath, 'utf8')) as CourseworkResult;
    return Array.isArray(parsed.courses) ? parsed : null;
  } catch {
    return null;
  }
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

/** assignmentId（course_<id>_<type>_<itemId>）または ACE 表記のコース名で突き合わせる。 */
export function findCourseworkForAssignment(
  result: CourseworkResult | null,
  assignmentId: string,
  courseName: string
): CourseworkCourse | null {
  if (!result) return null;
  const m = /^course_(\d+)_/.exec(assignmentId);
  if (m) {
    const byId = result.courses.find((c) => c.courseId === m[1]);
    if (byId) return byId;
  }
  const key = normalizeCourseKey(courseName);
  return (
    result.courses.find(
      (c) => normalizeCourseKey(c.courseName) === key || (c.aceListName !== null && normalizeCourseKey(c.aceListName) === key)
    ) ?? null
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
