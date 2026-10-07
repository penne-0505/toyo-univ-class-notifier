import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  getOrCreatePage,
  launchStateContext,
  recoverToyoSessionIfNeeded,
  shouldRunHeadless,
} from './toyo';
import { dataDir, outputDir, registrationDataPath, repoRoot } from './toyo-paths';

export type Course = {
  semesterLabel: string;
  day: string;
  period: string;
  term: string;
  courseCode: string;
  numbering: string;
  courseName: string;
  deliveryMode: string;
  instructor: string;
  room: string;
  campus: string;
  credits: number | null;
};

export type FetchStatus = 'success' | 'error' | 'empty';

export type EnrollmentData = {
  fetchStatus: FetchStatus;
  fetchedAt: string;
  sourceUrl: string;
  pageTitle: string;
  studentNumber: string;
  studentNameKana: string;
  studentName: string;
  academicYear: string;
  courses: Course[];
};

const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];
/** 曜日・時限を持たない科目（集中講義・オンデマンド）の day 値 */
export const INTENSIVE_DAY_LABEL = '集中';

export function isIntensiveCourse(course: Pick<Course, 'day'>): boolean {
  return course.day === INTENSIVE_DAY_LABEL;
}

function computeFetchStatus(pageTitle: string, courses: Course[]): FetchStatus {
  if (pageTitle.includes('システムエラー') || pageTitle.includes('タイムアウト')) {
    return 'error';
  }
  if (courses.length === 0) {
    return 'empty';
  }
  return 'success';
}

export { repoRoot, outputDir, dataDir };
export const spreadsheetDir = path.join(repoRoot, 'output', 'spreadsheet');
export const jsonOutputPath = registrationDataPath;
export const markdownOutputPath = path.join(outputDir, 'registration-summary.md');
export const workbookOutputPath = path.join(spreadsheetDir, 'toyo-timetable.xlsx');
const confirmationUrl = 'https://g-sys.toyo.ac.jp/univision/action/in/f08/Usin080111';

export async function ensureEnrollmentOutputDirs(): Promise<void> {
  await Promise.all([
    fs.mkdir(outputDir, { recursive: true }),
    fs.mkdir(spreadsheetDir, { recursive: true }),
  ]);
}

function normalizeDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0)
  );
}

function toCreditTotal(courses: Course[]): number {
  return courses.reduce((sum, course) => sum + (course.credits ?? 0), 0);
}

function summarizeBy<T extends string>(courses: Course[], key: keyof Course): Map<T, number> {
  const counts = new Map<T, number>();
  for (const course of courses) {
    const value = String(course[key]) as T;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function formatCounts(label: string, counts: Map<string, number>): string[] {
  const items = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ja'));
  return items.map(([name, count]) => `- ${label} ${name}: ${count}件`);
}

export function buildEnrollmentMarkdown(data: EnrollmentData): string {
  const creditTotal = toCreditTotal(data.courses);
  const byDay = summarizeBy<string>(data.courses, 'day');
  const byDeliveryMode = summarizeBy<string>(data.courses, 'deliveryMode');
  const byCampus = summarizeBy<string>(data.courses, 'campus');
  const semesterOrder = [...new Set(data.courses.map((course) => course.semesterLabel))];
  const dayOrder = [...WEEKDAYS, INTENSIVE_DAY_LABEL];
  const sortedCourses = [...data.courses].sort((a, b) => {
    return (
      semesterOrder.indexOf(a.semesterLabel) - semesterOrder.indexOf(b.semesterLabel) ||
      dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day) ||
      Number(a.period || 99) - Number(b.period || 99) ||
      a.courseName.localeCompare(b.courseName, 'ja')
    );
  });
  const intensiveCount = data.courses.filter(isIntensiveCourse).length;
  const semesterNotes = semesterOrder.map((label) => {
    const items = data.courses.filter((course) => course.semesterLabel === label);
    return `- ${label}: ${items.length}件 ${toCreditTotal(items)}単位`;
  });

  const lines = [
    '# 履修状況まとめ',
    '',
    `- 取得日時: ${data.fetchedAt}`,
    `- 参照元: ${data.pageTitle}`,
    `- 学籍番号: ${data.studentNumber}`,
    `- 氏名: ${data.studentName} (${data.studentNameKana})`,
    `- 開講年度: ${data.academicYear}`,
    `- 登録科目数: ${data.courses.length}件`,
    `- 登録単位数合計: ${creditTotal}単位`,
    '',
    '## 集計',
    ...semesterNotes,
    ...formatCounts('曜日', byDay),
    ...formatCounts('実施形態', byDeliveryMode),
    ...formatCounts('キャンパス', byCampus),
    `- 曜日時限なし（集中・オンデマンド）: ${intensiveCount}件`,
    '',
    '## 履修科目一覧',
    '| 曜日 | 時限 | 学期 | 科目名 | 授業コード | ナンバリング | 実施形態 | 担当者 | 教室 | キャンパス | 単位 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...sortedCourses.map(
      (course) =>
        `| ${course.day} | ${course.period} | ${course.semesterLabel} | ${course.courseName} | ${course.courseCode} | ${course.numbering} | ${course.deliveryMode} | ${course.instructor} | ${course.room} | ${course.campus} | ${course.credits ?? ''} |`
    ),
    '',
    '## メモ',
    '- この出力は学務ポータルの「履修登録確認表照会」をもとに作成しています。',
    `- 曜日は ${INTENSIVE_DAY_LABEL} が集中講義・オンデマンド科目（曜日時限なし）を表します。`,
  ];

  return `${lines.join('\n')}\n`;
}

export async function writeEnrollmentArtifacts(data: EnrollmentData): Promise<void> {
  const markdown = buildEnrollmentMarkdown(data);
  await fs.writeFile(jsonOutputPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.writeFile(markdownOutputPath, markdown, 'utf8');
}

export async function runPythonWorkbookBuilder(): Promise<void> {
  const pythonPath = path.join(repoRoot, '.venv', 'bin', 'python');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      pythonPath,
      [
        path.join(repoRoot, 'scripts', 'toyo-build-timetable.py'),
        jsonOutputPath,
        workbookOutputPath,
      ],
      { stdio: 'inherit' }
    );
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Workbook builder exited with code ${code ?? 'null'}`));
    });
    child.on('error', reject);
  });
}

export async function scrapeEnrollmentData(): Promise<EnrollmentData> {
  const { browser, context } = await launchStateContext({
    headless: shouldRunHeadless(true),
  });
  const page = await getOrCreatePage(context);

  try {
    await page.goto(confirmationUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await recoverToyoSessionIfNeeded(page, {
      returnUrl: confirmationUrl,
      saveState: true,
      snapshotTag: 'registration-session-loss',
    });
    const bodyText = await page.locator('body').innerText();
    const pageTitle = await page.title();
    const normalizedText = bodyText.replace(/\u00A0/g, ' ');
    const lines = normalizedText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const studentNumberMatch = normalizedText.match(/学籍番号\s+([0-9]+)/);
    const academicYearMatch = normalizedText.match(/開講年度\s+([0-9]{4})/);
    const nameLineIndex = lines.findIndex((line) => line.includes('学籍番号'));
    const kanaLine = nameLineIndex >= 0 ? lines[nameLineIndex].match(/氏名\s+(.+)$/)?.[1] ?? '' : '';
    const nameLine = nameLineIndex >= 0 ? lines[nameLineIndex + 1] ?? '' : '';

    const courses: Course[] = [];
    let currentSemesterLabel = '';
    let currentDay = '';

    for (const line of lines) {
      if (
        line === '曜日 時限 学期 授業コード 科目ナンバリング 科目名 実施形態 担当者 教室 キャンパス 単位'
      ) {
        continue;
      }
      if (/学期$/.test(line) && !line.includes('授業')) {
        currentSemesterLabel = line;
        continue;
      }
      if (line.startsWith('注）')) {
        break;
      }

      // 行はタブ区切り。空欄も位置情報として意味を持つので filter せずに扱う。
      //   通常行:   曜日 \t 時限 \t 学期 \t (空) \t 授業コード \t ナンバリング \t 科目名 \t 実施形態 \t 担当者 \t 教室 \t キャンパス \t 単位
      //   集中行:   集中その他 \t (空) \t 授業コード \t ...（時限・学期なし）
      //   継続行:   (空) \t 授業コード \t ...（同じ曜日/集中ブロックの 2 件目以降）
      // 授業コード（英数字 10 桁）の位置を基準に前後を読む。
      const parts = line.split('\t').map((part) => part.trim());
      const codeIndex = parts.findIndex((part) => /^[0-9A-Z]{10}$/.test(part));
      if (codeIndex < 0 || parts.length < codeIndex + 8) {
        continue;
      }
      const head = parts.slice(0, codeIndex).filter(Boolean);
      const first = head[0] ?? '';
      let day = '';
      let period = '';
      let term = '';
      if (WEEKDAYS.includes(first)) {
        day = first;
        currentDay = day;
        period = head[1] ?? '';
        term = head[2] ?? '';
      } else if (first.startsWith('集中')) {
        day = INTENSIVE_DAY_LABEL;
        currentDay = day;
        term = head[1] ?? '';
      } else if (head.length === 0) {
        day = currentDay;
      } else {
        // 曜日を持たない継続行（時限 学期 の 2 つだけ、など）
        day = currentDay;
        if (/^[0-9０-９]+$/.test(first)) {
          period = first;
          term = head[1] ?? '';
        } else {
          term = first;
        }
      }
      if (day === INTENSIVE_DAY_LABEL) {
        period = '';
      }

      const courseCode = parts[codeIndex] || '';
      const numbering = parts[codeIndex + 1] || '';
      const courseName = parts[codeIndex + 2] || '';
      const deliveryMode = parts[codeIndex + 3] || '';
      const instructor = parts[codeIndex + 4] || '';
      const room = parts[codeIndex + 5] || '';
      const campus = parts[codeIndex + 6] || '';
      const creditsRaw = parts[codeIndex + 7] || '';

      if (!day || !courseCode || !courseName) {
        continue;
      }

      courses.push({
        semesterLabel: currentSemesterLabel,
        day,
        period: normalizeDigits(period),
        term,
        courseCode,
        numbering,
        courseName,
        deliveryMode,
        instructor,
        room,
        campus,
        credits: creditsRaw
          ? Number(normalizeDigits(creditsRaw).replace(/[^\d.-]/g, ''))
          : null,
      });
    }

    const result: EnrollmentData = {
      fetchStatus: computeFetchStatus(pageTitle, courses),
      fetchedAt: new Date().toISOString(),
      sourceUrl: page.url(),
      pageTitle,
      studentNumber: studentNumberMatch?.[1] ?? '',
      studentNameKana: kanaLine,
      studentName: nameLine,
      academicYear: academicYearMatch?.[1] ?? '',
      courses,
    };
    return result;
  } finally {
    await context.close();
    await browser.close();
  }
}
