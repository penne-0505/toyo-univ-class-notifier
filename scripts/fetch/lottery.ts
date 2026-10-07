/**
 * 「抽選実施科目一覧」（履修登録期間終了後に定員超過で抽選になった科目と、その当落）を取得し、
 * output/toyo/lottery-results.json / .md に保存する。
 *
 * 履修登録の送信が「正常に完了」でも、抽選実施科目は申込が受理されただけで確定ではない。
 * 落選した科目は履修と ToyoNet-ACE のコースから削除され、追加登録期間にも追加できない。
 *
 * Usage:
 *   npm run toyo:lottery
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { outputDir } from './toyo-enrollment';
import {
  getOrCreatePage,
  launchStateContext,
  recoverToyoSessionIfNeeded,
  shouldRunHeadless,
} from '../lib/toyo';

const lotteryUrl = 'https://g-sys.toyo.ac.jp/univision/action/in/f07/Usin07Z211';
export const lotteryJsonPath = path.join(outputDir, 'lottery-results.json');
export const lotteryMarkdownPath = path.join(outputDir, 'lottery-results.md');

export type LotteryEntry = {
  result: 'won' | 'lost' | 'pending' | 'unknown';
  resultMark: string;
  courseCode: string;
  category: string;
  courseName: string;
  scheduleLabel: string;
  instructor: string;
  classroom: string;
  campus: string;
  credits: number | null;
};

export type LotteryData = {
  fetchedAt: string;
  available: boolean;
  academicYear: string | null;
  semester: string | null;
  entries: LotteryEntry[];
  errors: string[];
};

function toResult(mark: string): LotteryEntry['result'] {
  if (mark === '○' || mark === '〇' || mark === '◯') return 'won';
  if (mark === '×' || mark === '✕') return 'lost';
  if (mark === '') return 'pending';
  return 'unknown';
}

/** 抽選実施科目一覧ページの本文テキストから科目行を抜き出す */
export function parseLotteryText(text: string): Pick<LotteryData, 'academicYear' | 'semester' | 'entries'> {
  const normalized = text.replace(/ /g, ' ');
  const academicYear = normalized.match(/開講年度\s*([0-9]{4})/)?.[1] ?? null;
  const semester = normalized.match(/学期\s*(春学期|秋学期|通年)/)?.[1] ?? null;
  const entries: LotteryEntry[] = [];
  for (const line of normalized.split('\n')) {
    const parts = line.split('\t').map((part) => part.trim());
    // 抽選結果 授業コード 区分 科目名 時間割 担当者 教室 キャンパス 単位
    const codeIndex = parts.findIndex((part) => /^[0-9A-Z]{10}$/.test(part));
    if (codeIndex !== 1 || parts.length < 9) continue;
    const mark = parts[0];
    entries.push({
      result: toResult(mark),
      resultMark: mark,
      courseCode: parts[1],
      category: parts[2] ?? '',
      courseName: parts[3] ?? '',
      scheduleLabel: parts[4] ?? '',
      instructor: parts[5] ?? '',
      classroom: parts[6] ?? '',
      campus: parts[7] ?? '',
      credits: Number.isFinite(Number(parts[8])) && parts[8] !== '' ? Number(parts[8]) : null,
    });
  }
  return { academicYear, semester, entries };
}

export function buildLotteryMarkdown(data: LotteryData): string {
  const label = { won: '当選', lost: '落選', pending: '未発表', unknown: '不明' } as const;
  const lines = [
    '# 抽選実施科目一覧',
    '',
    `- 取得日時: ${data.fetchedAt}`,
    `- 開講: ${data.academicYear ?? '?'} ${data.semester ?? ''}`,
    `- 取得状況: ${data.available ? '取得できた' : '画面が開けなかった（期間外など）'}`,
    '',
    '| 結果 | 科目名 | 区分 | 授業コード | 担当者 | キャンパス | 単位 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...data.entries.map(
      (entry) =>
        `| ${label[entry.result]}${entry.resultMark ? `（${entry.resultMark}）` : ''} | ${entry.courseName} | ${entry.category} | ${entry.courseCode} | ${entry.instructor} | ${entry.campus} | ${entry.credits ?? ''} |`
    ),
    '',
    '## メモ',
    '- 履修登録の送信が成功しても、抽選実施科目は抽選結果（○）が出るまで確定ではない。',
    '- 落選（×）した科目は履修と ToyoNet-ACE のコースから削除され、追加登録期間にも追加できない。',
  ];
  if (data.errors.length > 0) lines.push('', '## エラー', ...data.errors.map((error) => `- ${error}`));
  return `${lines.join('\n')}\n`;
}

export async function fetchLotteryResults(): Promise<LotteryData> {
  const { browser, context } = await launchStateContext({ headless: shouldRunHeadless(true) });
  const page = await getOrCreatePage(context);
  const data: LotteryData = {
    fetchedAt: new Date().toISOString(),
    available: false,
    academicYear: null,
    semester: null,
    entries: [],
    errors: [],
  };
  try {
    await page.goto(lotteryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await recoverToyoSessionIfNeeded(page, { returnUrl: lotteryUrl, saveState: true, snapshotTag: 'lottery-session-loss' });
    const text = (await page.evaluate('document.body.innerText')) as string;
    if (/この機能は使用可能対象外です|Request Error/.test(text)) {
      data.errors.push('抽選実施科目一覧は現在使用可能対象外です（発表前または期間外）。');
    } else if (/システムエラー|不正な操作/.test(text)) {
      data.errors.push(`画面を開けませんでした: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
    } else {
      Object.assign(data, parseLotteryText(text));
      data.available = true;
    }
  } catch (error) {
    data.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    await context.close();
    await browser.close();
  }
  // 取得できなかったときは、以前の正常な結果を上書きしない
  if (!data.available) return data;
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(lotteryJsonPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.writeFile(lotteryMarkdownPath, buildLotteryMarkdown(data), 'utf8');
  return data;
}

export async function main(): Promise<void> {
  const data = await fetchLotteryResults();
  if (!data.available) {
    console.error(data.errors.join('\n'));
    console.error(`既存の ${lotteryJsonPath} は更新していません。`);
    process.exitCode = 1;
    return;
  } else if (data.entries.length === 0) {
    console.log('抽選実施科目はありません（登録科目はすべて確定）。');
  } else {
    for (const entry of data.entries) {
      const mark = entry.result === 'won' ? '○ 当選' : entry.result === 'lost' ? '× 落選' : entry.result === 'pending' ? '　 未発表' : `? ${entry.resultMark}`;
      console.log(`${mark}  ${entry.courseName} (${entry.courseCode}) ${entry.instructor} ${entry.campus} ${entry.credits ?? ''}単位`);
    }
    const lost = data.entries.filter((entry) => entry.result === 'lost').length;
    const pending = data.entries.filter((entry) => entry.result === 'pending').length;
    if (lost > 0) console.log(`落選 ${lost} 科目: 履修から削除されています。追加登録期間に別科目で補充が必要です。`);
    if (pending > 0) console.log(`未発表 ${pending} 科目: 結果発表日時に再確認してください。`);
  }
  console.log(`Saved: ${lotteryJsonPath}`);
}
