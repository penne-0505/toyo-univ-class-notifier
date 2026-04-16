import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  getOrCreatePage,
  launchStateContext,
  recoverToyoSessionIfNeeded,
  shouldRunHeadless,
} from './toyo';

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

function computeFetchStatus(pageTitle: string, courses: Course[]): FetchStatus {
  if (pageTitle.includes('システムエラー') || pageTitle.includes('タイムアウト')) {
    return 'error';
  }
  if (courses.length === 0) {
    return 'empty';
  }
  return 'success';
}

export const repoRoot = path.resolve(__dirname, '..', '..');
export const outputDir = path.join(repoRoot, 'output', 'toyo');
export const spreadsheetDir = path.join(repoRoot, 'output', 'spreadsheet');
export const jsonOutputPath = path.join(outputDir, 'registration-data.json');
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
  const sortedCourses = [...data.courses].sort((a, b) => {
    const dayOrder = ['月', '火', '水', '木', '金', '土', '日'];
    return (
      dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day) ||
      Number(a.period) - Number(b.period) ||
      a.courseName.localeCompare(b.courseName, 'ja')
    );
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
    ...formatCounts('曜日', byDay),
    ...formatCounts('実施形態', byDeliveryMode),
    ...formatCounts('キャンパス', byCampus),
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
    '- 現時点では春学期の登録科目のみが表示されていました。',
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

      const parts = line.split('\t').map((part) => part.trim()).filter(Boolean);
      if (parts.length < 10) {
        continue;
      }

      let offset = 0;
      let day = parts[offset];
      if (!['月', '火', '水', '木', '金', '土', '日'].includes(day)) {
        day = currentDay;
      } else {
        offset += 1;
        currentDay = day;
      }

      const period = parts[offset] || '';
      const term = parts[offset + 1] || '';
      const courseCode = parts[offset + 2] || '';
      const numbering = parts[offset + 3] || '';
      const courseName = parts[offset + 4] || '';
      const deliveryMode = parts[offset + 5] || '';
      const instructor = parts[offset + 6] || '';
      const room = parts[offset + 7] || '';
      const campus = parts[offset + 8] || '';
      const creditsRaw = parts[offset + 9] || '';

      if (!day || !period || !courseCode || !courseName) {
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
