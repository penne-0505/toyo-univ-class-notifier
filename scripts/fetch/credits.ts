/**
 * 「単位数集計表」と「履修・修得科目一覧（過年度の不合格科目を含む）」を取得し、
 * output/toyo/credit-summary.json / .md に保存する。
 *
 * Usage:
 *   npm run toyo:credits
 *   npm run toyo:credits -- --year-from 2026 --year-to 2026   # 既定は (今年-4)〜今年
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { type Page } from 'playwright';
import { outputDir } from './toyo-enrollment';
import {
  getOrCreatePage,
  launchStateContext,
  recoverToyoSessionIfNeeded,
  shouldRunHeadless,
} from '../lib/toyo';

const creditSummaryUrl = 'https://g-sys.toyo.ac.jp/univision/action/in/f08/Usin080411';
const completedCoursesUrl = 'https://g-sys.toyo.ac.jp/univision/action/in/f08/Usin080311';
export const creditSummaryJsonPath = path.join(outputDir, 'credit-summary.json');
export const creditSummaryMarkdownPath = path.join(outputDir, 'credit-summary.md');

export type RequirementRow = {
  name: string;
  depth: number;
  required: number | null;
  earned: number | null;
  inProgress: number | null;
  judged: number | null;
  shortage: number | null;
};

export type SemesterGrades = {
  academicYear: string;
  semester: string;
  registered: number | null;
  earned: number | null;
  gpa: number | null;
  grades: Record<string, number>;
};

export type CompletedCourse = {
  courseGroup: string;
  category: string;
  courseName: string;
  instructor: string;
  credits: number | null;
  grade: string;
  gradeNote: string;
  academicYear: string;
  term: string;
  yearOfStudy: string;
  semesterIndex: string;
};

export type CreditSummaryData = {
  fetchedAt: string;
  studentNumber: string;
  requirements: RequirementRow[];
  bySemester: SemesterGrades[];
  courses: CompletedCourse[];
  errors: string[];
};

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const normalized = value.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).trim();
  if (normalized === '') return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function normalizeLines(text: string): string[] {
  return text
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .filter((line) => line.trim() !== '');
}

async function openWithRecovery(page: Page, url: string, tag: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await recoverToyoSessionIfNeeded(page, { returnUrl: url, saveState: true, snapshotTag: tag });
}

/** 単位数集計表の本文テキストから要件行と学期別成績を抜き出す */
export function parseCreditSummary(text: string): Pick<CreditSummaryData, 'requirements' | 'bySemester'> {
  const lines = normalizeLines(text);
  const requirements: RequirementRow[] = [];
  const bySemester: SemesterGrades[] = [];
  const gradeKeys = ['S', 'A', 'B', 'C', 'D', 'E', '*', 'T', '保'];

  let inRequirements = false;
  for (const line of lines) {
    if (line.startsWith('要件\t')) {
      inRequirements = true;
      continue;
    }
    if (inRequirements) {
      if (line.trim() === '' || line.includes('実施形態別')) {
        inRequirements = false;
        continue;
      }
      const parts = line.split('\t');
      if (parts.length < 6) continue;
      const rawName = parts[0];
      // 階層は先頭の全角空白の数で表される（1 個 = 1 段）
      const depth = rawName.match(/^[　 ]*/)?.[0].length ?? 0;
      requirements.push({
        name: rawName.trim(),
        depth,
        required: toNumber(parts[1]),
        earned: toNumber(parts[2]),
        inProgress: toNumber(parts[3]),
        judged: toNumber(parts[4]),
        shortage: toNumber(parts[5]),
      });
      continue;
    }
    // 単位修得状況: 年度 \t 学期 \t 履修単位 \t 修得単位 \t GPA \t S A B C D E * T 保
    const match = line.match(/^(\d{4})\t(春学期|秋学期|通年)\t(.*)$/);
    if (match) {
      const values = match[3].split('\t');
      if (values.length >= 3 + gradeKeys.length) {
        const grades: Record<string, number> = {};
        gradeKeys.forEach((key, index) => {
          grades[key] = toNumber(values[3 + index]) ?? 0;
        });
        bySemester.push({
          academicYear: match[1],
          semester: match[2],
          registered: toNumber(values[0]),
          earned: toNumber(values[1]),
          gpa: toNumber(values[2]),
          grades,
        });
      }
    }
  }
  // 同じ年度・学期が「実施形態別」「学年別」でも出るので、単位修得状況（GPA あり）だけを残す
  const seen = new Set<string>();
  return {
    requirements,
    bySemester: bySemester.filter((row) => {
      const key = `${row.academicYear}-${row.semester}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

/** 履修・修得科目一覧の本文テキストから科目行を抜き出す */
export function parseCompletedCourses(text: string): CompletedCourse[] {
  const lines = normalizeLines(text);
  const courses: CompletedCourse[] = [];
  let courseGroup = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(全学基盤教育科目|全学共通教育科目|専門教育科目|教職課程|資格|自由科目)/.test(trimmed) && !trimmed.includes('\t')) {
      courseGroup = trimmed;
      continue;
    }
    const parts = line.split('\t').map((part) => part.trim());
    // 区分 科目名 担当者 単位 成績 成績備考 開講年度 開講期間 履修学年 履修セメスタ（先頭に空欄あり）
    if (parts[0] === '' && parts.length >= 10 && /^\d{4}$/.test(parts[7] ?? '')) {
      courses.push({
        courseGroup,
        category: parts[1] ?? '',
        courseName: parts[2] ?? '',
        instructor: parts[3] ?? '',
        credits: toNumber(parts[4]),
        grade: parts[5] ?? '',
        gradeNote: parts[6] ?? '',
        academicYear: parts[7] ?? '',
        term: parts[8] ?? '',
        yearOfStudy: parts[9] ?? '',
        semesterIndex: parts[10] ?? '',
      });
      continue;
    }
  }
  return courses;
}

export function buildCreditSummaryMarkdown(data: CreditSummaryData): string {
  const lines = [
    '# 単位数集計・修得状況',
    '',
    `- 取得日時: ${data.fetchedAt}`,
    `- 学籍番号: ${data.studentNumber}`,
    '',
    '## 卒業要件',
    '| 要件 | 条件 | 修得 | 履修中 | 判定 | 不足 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...data.requirements.map(
      (row) =>
        `| ${'　'.repeat(row.depth)}${row.name} | ${row.required ?? ''} | ${row.earned ?? ''} | ${row.inProgress ?? ''} | ${row.judged ?? ''} | ${row.shortage ?? ''} |`
    ),
    '',
    '## 学期別',
    '| 年度 | 学期 | 履修 | 修得 | GPA | S | A | B | C | D | E | * |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...data.bySemester.map(
      (row) =>
        `| ${row.academicYear} | ${row.semester} | ${row.registered ?? ''} | ${row.earned ?? ''} | ${row.gpa ?? ''} | ${row.grades.S} | ${row.grades.A} | ${row.grades.B} | ${row.grades.C} | ${row.grades.D} | ${row.grades.E} | ${row.grades['*']} |`
    ),
    '',
    '## 履修・修得科目（不合格を含む）',
    '| 年度 | 期間 | 科目群 | 区分 | 科目名 | 担当者 | 単位 | 成績 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...data.courses.map(
      (course) =>
        `| ${course.academicYear} | ${course.term} | ${course.courseGroup} | ${course.category} | ${course.courseName} | ${course.instructor} | ${course.credits ?? ''} | ${course.grade}${course.gradeNote ? `（${course.gradeNote}）` : ''} |`
    ),
    '',
    '## メモ',
    '- 成績「*」は評価対象外（未受験・未提出など）、D・E は不合格。履修中の科目は成績が空欄。',
    '- 出典: 学務ポータル「単位数集計表」「履修・修得科目一覧」。',
  ];
  if (data.errors.length > 0) {
    lines.push('', '## エラー', ...data.errors.map((error) => `- ${error}`));
  }
  return `${lines.join('\n')}\n`;
}

export async function fetchCreditSummary(options: { yearFrom?: string; yearTo?: string } = {}): Promise<CreditSummaryData> {
  const { browser, context } = await launchStateContext({ headless: shouldRunHeadless(true) });
  const page = await getOrCreatePage(context);
  const errors: string[] = [];
  let requirements: RequirementRow[] = [];
  let bySemester: SemesterGrades[] = [];
  let courses: CompletedCourse[] = [];
  let studentNumber = '';

  try {
    // 単位数集計表: ラジオ既定（単位数集計表）のまま検索
    try {
      await openWithRecovery(page, creditSummaryUrl, 'credit-summary-session-loss');
      await page.locator('input[type="submit"][value="検索"]').first().click();
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      const text = (await page.evaluate('document.body.innerText')) as string;
      if (!text.includes('単位数集計表')) throw new Error(`unexpected page: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
      ({ requirements, bySemester } = parseCreditSummary(text));
    } catch (error) {
      errors.push(`単位数集計表: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 履修・修得科目一覧: 年度範囲 + 過年度の不合格科目も表示
    try {
      await openWithRecovery(page, completedCoursesUrl, 'completed-courses-session-loss');
      // 年度範囲は両方必須（空だと「開講年度の範囲を正しく入力してください」で弾かれる）
      const thisYear = String(new Date().getFullYear());
      const yearTo = options.yearTo ?? thisYear;
      const yearFrom = options.yearFrom ?? String(Number(yearTo) - 4);
      await page.fill('input[name="year_from"]', yearFrom);
      await page.fill('input[name="year_to"]', yearTo);
      await page.locator('#gradeInPastYear_1').check().catch(() => {});
      await page.locator('input[type="submit"][value="検索"]').first().click();
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      const text = (await page.evaluate('document.body.innerText')) as string;
      studentNumber = text.match(/学籍番号\s*([0-9]+)/)?.[1] ?? '';
      if (!text.includes('履修・修得科目一覧')) throw new Error(`unexpected page: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
      courses = parseCompletedCourses(text);
    } catch (error) {
      errors.push(`履修・修得科目: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const data: CreditSummaryData = {
    fetchedAt: new Date().toISOString(),
    studentNumber,
    requirements,
    bySemester,
    courses,
    errors,
  };
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(creditSummaryJsonPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.writeFile(creditSummaryMarkdownPath, buildCreditSummaryMarkdown(data), 'utf8');
  return data;
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const data = await fetchCreditSummary({ yearFrom: opt('--year-from'), yearTo: opt('--year-to') });
  const total = data.requirements.find((row) => row.name.startsWith('卒業要件'));
  console.log(`要件行 ${data.requirements.length} / 学期 ${data.bySemester.length} / 科目 ${data.courses.length}`);
  if (total) console.log(`卒業要件: 修得 ${total.earned ?? '?'} / ${total.required ?? '?'}（不足 ${total.shortage ?? '?'}）`);
  for (const row of data.bySemester) console.log(`  ${row.academicYear} ${row.semester}: 履修 ${row.registered} 修得 ${row.earned} GPA ${row.gpa}`);
  if (data.errors.length > 0) console.warn(`errors: ${data.errors.join(' | ')}`);
  console.log(`Saved: ${creditSummaryJsonPath}`);
}
