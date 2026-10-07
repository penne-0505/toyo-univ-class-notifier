#!/usr/bin/env node

/**
 * 履修登録（正規登録期間）画面の「科目一覧による科目選択」を全コマ分たどり、
 * 登録可能な科目の一覧を output/toyo/registration-candidates.json に保存する。
 *
 * Usage:
 *   npm run toyo:candidates
 *   npm run toyo:candidates -- --add        # 追加登録期間画面（Usin071611）を入口にする
 *   npm run toyo:candidates -- --syllabus      # 夜間（6・7限）・集中科目のシラバスも取得する
 *   npm run toyo:candidates -- --syllabus=all  # 全科目のシラバスを取得する（時間がかかる）
 *   npm run toyo:candidates -- --syllabus --refresh-pool  # 取得したシラバス本文で syllabus-pool を上書きする
 *
 * 保存先:
 *   registration-candidates.json            最新（期間を問わず毎回上書き）
 *   registration-candidates.<regular|add>.json  期間別（その期間の最新。配信対象外）
 *   syllabus-pool/<授業コード>.json         シラバス本文（既存は上書きしない。--refresh-pool で上書き。配信対象外）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { type Page } from 'playwright';
import { outputDir } from './lib/toyo-enrollment';
import { saveCandidatesToPool } from './lib/syllabus-pool';
import {
  getOrCreatePage,
  launchStateContext,
  recoverToyoSessionIfNeeded,
  shouldRunHeadless,
} from './lib/toyo';

const regularRegistrationUrl = 'https://g-sys.toyo.ac.jp/univision/action/in/f07/Usin070311';
const additionalRegistrationUrl = 'https://g-sys.toyo.ac.jp/univision/action/in/f07/Usin071611';
/** 登録画面が期間外などで開けないときの例外。main では stack ではなく案内文だけを表示する */
export class RegistrationScreenUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationScreenUnavailableError';
  }
}

export function describeUnavailableScreen(period: 'regular' | 'add', bodyText: string): string {
  const periodLabel = period === 'add' ? '追加登録期間' : '正規登録期間';
  const notOpen = /この機能は使用可能対象外です|Request Error/.test(bodyText);
  const hint = notOpen
    ? `${periodLabel}の画面は現在「使用可能対象外」です（期間外、または対象外の可能性）。期間になってから再実行してください。${
        period === 'add' ? '（2026秋の追加登録は 10/7 12:20〜10/9 23:59）' : ''
      }`
    : `${periodLabel}の画面を開けませんでした（セッション切れ・システムエラーの可能性）。npm run toyo:login 後に再実行してください。`;
  return `${hint}\n画面の表示: ${bodyText.replace(/\s+/g, ' ').slice(0, 120)}`;
}

const subjectListUrl = 'https://g-sys.toyo.ac.jp/univision/action/in/f07/Usin071640';
export const candidatesOutputPath = path.join(outputDir, 'registration-candidates.json');
/** 期間別の保存先（registration-candidates.regular.json / registration-candidates.add.json） */
export const candidatesPeriodOutputPath = (period: 'regular' | 'add'): string =>
  path.join(outputDir, `registration-candidates.${period}.json`);

const dayLabelMap: Record<string, string> = {
  '11': '月',
  '12': '火',
  '13': '水',
  '14': '木',
  '15': '金',
  '16': '土',
  '17': '日',
  '20': '集中その他',
};

export type RegistrationCandidate = {
  scheduleCd: string;
  courseGroup: string;
  category: string;
  gradeYears: string;
  scheduleLabel: string;
  courseName: string;
  semester: string;
  conductionType: string;
  instructor: string;
  classroom: string;
  campus: string;
  credit: number | null;
  numbering: string | null;
  syllabusOption: string | null;
  syllabusOptionEn: string | null;
  slots: { dayId: string; day: string; periodId: string; period: number | null }[];
  /** 他キャンパス開講の全学科目などは定員超過で抽選になりやすい（2026秋は赤羽台のオンデマンド4科目が落選）。確定ではない */
  lotteryRisk: boolean;
  syllabus?: CandidateSyllabus | null;
};

export type RegistrationCandidatesData = {
  fetchedAt: string;
  source: string;
  entryUrl: string;
  /** regular = 正規登録期間, add = 追加登録期間（先着順・限られた科目のみ） */
  period: 'regular' | 'add';
  studentId: string | null;
  academicYear: string | null;
  semester: string | null;
  curriculumCourseKey: string | null;
  cells: { dayId: string; periodId: string; count: number }[];
  candidates: RegistrationCandidate[];
  errors: string[];
};

type RawRow = {
  scheduleCd: string;
  courseGroup: string;
  category: string;
  gradeYears: string;
  scheduleLabel: string;
  courseName: string;
  subjectNameJs: string;
  conductionType: string;
  instructor: string;
  classroom: string;
  campus: string;
  credit: string;
  syllabusOption: string | null;
  syllabusOptionEn: string | null;
  numbering: string | null;
};

function normalize(value: string | null | undefined): string {
  return (value ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function toHalfWidthDigits(value: string): string {
  return value.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

// NOTE: tsx/esbuild injects `__name(...)` wrappers into function expressions, which breaks
// inside page.evaluate. Browser-side code is therefore passed as a string.
const readCellsScript = String.raw`(() => {
  const cells = [];
  const seen = new Set();
  for (const el of Array.from(document.querySelectorAll('[onclick*="onSubjectListButtonClick"]'))) {
    const onclick = el.getAttribute('onclick') || '';
    const match = onclick.match(/onSubjectListButtonClick\([^,]+,\s*'[^']*',\s*'[^']*',\s*'([^']*)',\s*'([^']*)'\)/);
    if (!match) continue;
    const key = match[1] + ':' + match[2];
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push({ dayId: match[1], periodId: match[2] });
  }
  return cells;
})()`;

const readRowsScript = String.raw`(() => {
  const text = (el) => (el && el.textContent ? el.textContent : '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const cellText = (row, selector) => {
    const td = row.querySelector(selector);
    if (!td) return '';
    const clone = td.cloneNode(true);
    clone.querySelectorAll('.list_detail_label, input, script').forEach((n) => n.remove());
    return text(clone);
  };
  const optionOf = (onclick) => {
    const match = (onclick || '').match(/option=([^&']+)/);
    return match ? decodeURIComponent(match[1]) : null;
  };
  const numberingOf = (onclick) => {
    const match = (onclick || '').match(/numbering=([^&']+)/);
    return match ? decodeURIComponent(match[1]) : null;
  };
  const rows = [];
  const tables = Array.from(document.querySelectorAll('table.subject_list'));
  for (const table of tables) {
    const courseGroup = text(table.querySelector('caption'));
    for (const tr of Array.from(table.querySelectorAll('tr'))) {
      const checkbox = tr.querySelector('input[type="checkbox"][name="scheduleCd"]');
      if (!checkbox) continue;
      const onclick = checkbox.getAttribute('onclick') || '';
      const m = onclick.match(/subjectName:'([^']*)'/);
      const subjectNameJs = m ? m[1] : '';
      const buttons = Array.from(tr.querySelectorAll('td.syllabus input.button'));
      const ja = buttons.find((b) => b.value === '日本語') || null;
      const en = buttons.find((b) => b.value === 'English') || null;
      rows.push({
        scheduleCd: checkbox.id || checkbox.value || '',
        courseGroup,
        category: cellText(tr, 'td.subject_group'),
        gradeYears: cellText(tr, 'td.academic_year'),
        scheduleLabel: cellText(tr, 'td.disp_schedule'),
        courseName: text(tr.querySelector('.subject_label')) || cellText(tr, 'td.subject_name'),
        subjectNameJs,
        conductionType: cellText(tr, 'td.conduction_type'),
        instructor: cellText(tr, 'td.employee_name'),
        classroom: cellText(tr, 'td.room_name'),
        campus: cellText(tr, 'td.campus'),
        credit: cellText(tr, 'td.credit'),
        syllabusOption: optionOf(ja ? ja.getAttribute('onclick') : null),
        syllabusOptionEn: optionOf(en ? en.getAttribute('onclick') : null),
        numbering: numberingOf(ja ? ja.getAttribute('onclick') : null),
      });
    }
  }
  return rows;
})()`;

const readSyllabusScript = String.raw`(() => {
  const clean = (v) => (v || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const titleTable = document.querySelector('table.head-title');
  const metaTable = document.querySelector('table.lcl-ttl2');
  const bodyTable = document.querySelector('table.sbs-show');
  const metadata = {};
  if (metaTable) {
    for (const row of Array.from(metaTable.querySelectorAll('tr'))) {
      const cells = Array.from(row.querySelectorAll('th, td')).map((c) => clean(c.textContent));
      for (let i = 0; i + 1 < cells.length; i += 2) if (cells[i]) metadata[cells[i]] = cells[i + 1];
    }
  }
  const sections = {};
  if (bodyTable) {
    const rows = Array.from(bodyTable.querySelectorAll('tr')).map((row) =>
      Array.from(row.querySelectorAll('th, td')).map((c) => clean(c.textContent)).filter(Boolean));
    for (let i = 0; i < rows.length; i += 1) {
      const cur = rows[i];
      if (cur.length !== 1) continue;
      const h = cur[0];
      if (!h.startsWith('【') || !h.endsWith('】')) continue;
      sections[h.slice(1, -1)] = (rows[i + 1] || []).join(' ').trim();
    }
  }
  return { title: clean(titleTable ? titleTable.textContent : ''), url: location.href, metadata, sections, bodyPreview: clean(document.body.innerText).slice(0, 300) };
})()`;

export type CandidateSyllabus = {
  sourceUrl: string;
  courseCode: string;
  classFormat: string;
  learningGoals: string;
  lectureSchedule: string;
  instructionMethod: string;
  preAndPostStudy: string;
  grading: string;
  textbook: string;
  sections: Record<string, string>;
};

async function readSubjectListCells(page: Page): Promise<{ dayId: string; periodId: string }[]> {
  return page.evaluate(readCellsScript) as Promise<{ dayId: string; periodId: string }[]>;
}

async function readSubjectRows(page: Page): Promise<RawRow[]> {
  return page.evaluate(readRowsScript) as Promise<RawRow[]>;
}

type CellRef = { dayId: string; periodId: string };
type SyllabusMode = 'none' | 'evening' | 'all';

export type CollectOptions = {
  additional?: boolean;
  syllabus?: SyllabusMode;
  /** true なら syllabus-pool の既存ファイルも取得したシラバス本文で上書きする */
  refreshPool?: boolean;
};

const cellButtonSelector = (cell: CellRef): string =>
  `input[onclick*="onSubjectListButtonClick"][onclick*="'${cell.dayId}', '${cell.periodId}'"]`;

async function openEntryPage(page: Page, entryUrl: string): Promise<void> {
  const period = entryUrl === additionalRegistrationUrl ? 'add' : 'regular';
  await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await recoverToyoSessionIfNeeded(page, {
    returnUrl: entryUrl,
    saveState: true,
    snapshotTag: 'registration-candidates-session-loss',
  });
  const bodyText = normalize((await page.evaluate('document.body.innerText')) as string);
  if (/この機能は使用可能対象外です|Request Error|システムエラー|不正な操作|認証エラー/.test(bodyText)) {
    throw new RegistrationScreenUnavailableError(describeUnavailableScreen(period, bodyText));
  }
}

/** 登録画面のコマボタンを押して科目一覧サブウィンドウを開く（既存のサブウィンドウがあれば location.replace される） */
async function openCellPopup(page: Page, popup: Page | null, cell: CellRef): Promise<Page> {
  const context = page.context();
  const button = page.locator(cellButtonSelector(cell)).first();
  const expected = `dayOfWeekId=${cell.dayId}&periodId=${cell.periodId}`;
  let target = popup;
  if (!target || target.isClosed()) {
    const popupPromise = context.waitForEvent('page', { timeout: 20_000 });
    await button.click();
    target = await popupPromise;
  } else {
    await button.click();
  }
  await target.waitForURL((url) => url.toString().includes(expected), { timeout: 20_000 });
  await target.waitForLoadState('domcontentloaded');
  await target.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  const text = normalize((await target.evaluate('document.body.innerText')) as string);
  if (/認証エラー|不正な操作|システムエラー|タイムアウト/.test(text)) {
    throw new Error(`popup rejected: ${text.slice(0, 120)}`);
  }
  return target;
}

function sectionValue(sections: Record<string, string>, ...labels: string[]): string {
  for (const label of labels) if (sections[label]) return sections[label];
  return '';
}

/** 科目一覧サブウィンドウの「日本語」ボタンを押してシラバスを読む。毎回新しいウィンドウが開く（前のものは閉じられる） */
async function readCandidateSyllabus(popup: Page, scheduleCd: string): Promise<CandidateSyllabus> {
  const context = popup.context();
  // 日本語版がない科目（英語開講など）は English ボタンにフォールバックする
  let button = popup.locator(`tr[class~="${scheduleCd}"] td.syllabus input.button[value="日本語"]`).first();
  if ((await button.count()) === 0) {
    button = popup.locator(`tr[class~="${scheduleCd}"] td.syllabus input.button[value="English"]`).first();
  }
  if ((await button.count()) === 0) throw new Error('syllabus button not found');
  const winPromise = context.waitForEvent('page', { timeout: 20_000 });
  await button.click();
  const win = await winPromise;
  try {
    await win.waitForLoadState('domcontentloaded');
    await win.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await win.waitForSelector('table.sbs-show, table.head-title', { timeout: 10_000 }).catch(() => {});
    const snap = (await win.evaluate(readSyllabusScript)) as {
      title: string; url: string; metadata: Record<string, string>; sections: Record<string, string>; bodyPreview: string;
    };
    if (!snap.title && Object.keys(snap.sections).length === 0) {
      throw new Error(`syllabus page unparsed: ${snap.bodyPreview.slice(0, 120)}`);
    }
    return {
      sourceUrl: snap.url,
      courseCode: snap.metadata['授業コード'] ?? '',
      classFormat: snap.metadata['授業形態'] ?? '',
      learningGoals: sectionValue(snap.sections, '学修到達目標'),
      lectureSchedule: sectionValue(snap.sections, '講義スケジュール'),
      instructionMethod: sectionValue(snap.sections, '指導方法'),
      preAndPostStudy: sectionValue(snap.sections, '事前・事後学修', '事前・事後学習'),
      grading: sectionValue(snap.sections, '成績評価の方法・基準'),
      textbook: sectionValue(snap.sections, 'テキスト'),
      sections: snap.sections,
    };
  } finally {
    await win.close().catch(() => {});
  }
}

function isAuthFailure(message: string): boolean {
  return /認証エラー|不正な操作|システムエラー|タイムアウト|popup rejected|Target page, context or browser has been closed/.test(message);
}

function wantsSyllabus(candidate: RegistrationCandidate, mode: SyllabusMode): boolean {
  if (mode === 'none' || !(candidate.syllabusOption || candidate.syllabusOptionEn)) return false;
  if (mode === 'all') return true;
  return candidate.slots.some((slot) => slot.dayId === '20' || (slot.period ?? 0) >= 6);
}

export async function collectRegistrationCandidates(options: CollectOptions = {}): Promise<RegistrationCandidatesData> {
  const entryUrl = options.additional ? additionalRegistrationUrl : regularRegistrationUrl;
  const syllabusMode: SyllabusMode = options.syllabus ?? 'none';
  const { browser, context } = await launchStateContext({ headless: shouldRunHeadless(true) });
  const page = await getOrCreatePage(context);
  const errors: string[] = [];
  const candidateMap = new Map<string, RegistrationCandidate>();
  const cellSummaries: RegistrationCandidatesData['cells'] = [];
  const cellMembers = new Map<string, string[]>();

  try {
    await openEntryPage(page, entryUrl);

    const query = (await page.evaluate('window.SUBJECT_LIST_QUERY || null')) as string | null;
    if (!query) throw new Error('SUBJECT_LIST_QUERY was not found on the registration screen.');
    const bodyText = normalize((await page.evaluate('document.body.innerText')) as string);
    const studentId = (bodyText.match(/学籍番号\s*([0-9]+)/) ?? [])[1] ?? null;
    const academicYear = (bodyText.match(/開講年度\s*([0-9]{4})/) ?? [])[1] ?? null;
    const semester = (bodyText.match(/学期\s*(春学期|秋学期|通年)/) ?? [])[1] ?? null;
    const curriculumCourseKey = (query.match(/curriculumCourseKey=([^&]+)/) ?? [])[1] ?? null;

    const cells = await readSubjectListCells(page);
    if (cells.length === 0) throw new Error('No subject list buttons were found on the registration screen.');
    console.log(`Phase 1: ${cells.length} timetable cells. Semester: ${semester ?? '?'}`);

    // ---- Phase 1: 科目一覧 ----
    let popup: Page | null = null;
    for (const cell of cells) {
      const cellKey = `${cell.dayId}:${cell.periodId}`;
      const day = dayLabelMap[cell.dayId] ?? cell.dayId;
      const periodNumber = Number.parseInt(cell.periodId, 10);
      const period = cell.dayId === '20' ? null : Number.isFinite(periodNumber) ? periodNumber - 10 : null;
      let rows: RawRow[] | null = null;
      for (let attempt = 0; attempt < 2 && rows === null; attempt += 1) {
        try {
          popup = await openCellPopup(page, popup, cell);
          rows = await readSubjectRows(popup);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt === 0 && isAuthFailure(message)) {
            console.warn(`  cell ${cellKey}: ${message.slice(0, 100)} -> re-opening entry page`);
            if (popup && !popup.isClosed()) await popup.close().catch(() => {});
            popup = null;
            await openEntryPage(page, entryUrl);
            continue;
          }
          errors.push(`cell ${cellKey}: ${message}`);
          console.warn(`  cell ${cellKey} failed: ${message.slice(0, 160)}`);
          break;
        }
      }
      if (rows === null) continue;
      cellSummaries.push({ dayId: cell.dayId, periodId: cell.periodId, count: rows.length });
      cellMembers.set(cellKey, rows.map((row) => row.scheduleCd).filter(Boolean));
      for (const row of rows) {
        if (!row.scheduleCd) continue;
        const slot = { dayId: cell.dayId, day, periodId: cell.periodId, period };
        const existing = candidateMap.get(row.scheduleCd);
        if (existing) {
          if (!existing.slots.some((s) => s.dayId === slot.dayId && s.periodId === slot.periodId)) existing.slots.push(slot);
          continue;
        }
        const semesterMark = (row.subjectNameJs.match(/^【([^】]+)】/) ?? [])[1] ?? '';
        const creditNumber = Number.parseFloat(toHalfWidthDigits(row.credit));
        candidateMap.set(row.scheduleCd, {
          scheduleCd: row.scheduleCd,
          courseGroup: row.courseGroup,
          category: row.category,
          gradeYears: row.gradeYears,
          scheduleLabel: row.scheduleLabel,
          courseName: row.courseName,
          semester: semesterMark,
          conductionType: row.conductionType,
          instructor: row.instructor,
          classroom: row.classroom,
          campus: row.campus,
          credit: Number.isFinite(creditNumber) ? creditNumber : null,
          numbering: row.numbering,
          syllabusOption: row.syllabusOption,
          syllabusOptionEn: row.syllabusOptionEn,
          slots: [slot],
          lotteryRisk: row.campus !== '' && !row.campus.startsWith('白山'),
        });
      }
      console.log(`  ${day} ${period ?? '-'}: ${rows.length} rows`);
    }

    // ---- Phase 2: シラバス ----
    if (syllabusMode !== 'none') {
      const pending = new Set([...candidateMap.values()].filter((c) => wantsSyllabus(c, syllabusMode)).map((c) => c.scheduleCd));
      console.log(`Phase 2: syllabus for ${pending.size} candidates (mode: ${syllabusMode})`);
      let consecutiveAuthFailures = 0;
      for (const cell of cells) {
        const cellKey = `${cell.dayId}:${cell.periodId}`;
        const members = (cellMembers.get(cellKey) ?? []).filter((id) => pending.has(id));
        if (members.length === 0) continue;
        try {
          popup = await openCellPopup(page, popup, cell);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`  cell ${cellKey}: ${message.slice(0, 100)} -> re-opening entry page`);
          if (popup && !popup.isClosed()) await popup.close().catch(() => {});
          popup = null;
          try {
            await openEntryPage(page, entryUrl);
            popup = await openCellPopup(page, popup, cell);
          } catch (retryError) {
            const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
            errors.push(`syllabus cell ${cellKey}: ${retryMessage}`);
            continue;
          }
        }
        for (const scheduleCd of members) {
          const candidate = candidateMap.get(scheduleCd);
          if (!candidate) continue;
          try {
            candidate.syllabus = await readCandidateSyllabus(popup, scheduleCd);
            pending.delete(scheduleCd);
            consecutiveAuthFailures = 0;
            console.log(`  syllabus ok: ${candidate.courseName}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (isAuthFailure(message)) {
              consecutiveAuthFailures += 1;
              console.warn(`  syllabus auth problem for ${candidate.courseName}: ${message.slice(0, 100)} -> recovering`);
              if (popup && !popup.isClosed()) await popup.close().catch(() => {});
              popup = null;
              try {
                await openEntryPage(page, entryUrl);
                popup = await openCellPopup(page, popup, cell);
                candidate.syllabus = await readCandidateSyllabus(popup, scheduleCd);
                pending.delete(scheduleCd);
                consecutiveAuthFailures = 0;
                console.log(`  syllabus ok (after recovery): ${candidate.courseName}`);
                continue;
              } catch (retryError) {
                const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
                errors.push(`syllabus ${scheduleCd} (${candidate.courseName}): ${retryMessage}`);
                candidate.syllabus = null;
                if (consecutiveAuthFailures >= 3) throw new Error(`Syllabus fetching keeps failing after recovery: ${retryMessage}`);
                if (!popup || popup.isClosed()) break;
                continue;
              }
            }
            errors.push(`syllabus ${scheduleCd} (${candidate.courseName}): ${message}`);
            candidate.syllabus = null;
            console.warn(`  syllabus failed for ${candidate.courseName}: ${message.slice(0, 160)}`);
          }
          await page.waitForTimeout(250);
        }
      }
      for (const scheduleCd of pending) {
        const candidate = candidateMap.get(scheduleCd);
        if (candidate && candidate.syllabus === undefined) candidate.syllabus = null;
      }
    }
    if (popup && !popup.isClosed()) await popup.close().catch(() => {});

    const data: RegistrationCandidatesData = {
      fetchedAt: new Date().toISOString(),
      source: 'g-sys 履修登録（科目一覧による科目選択）',
      entryUrl,
      period: options.additional ? 'add' : 'regular',
      studentId,
      academicYear,
      semester,
      curriculumCourseKey,
      cells: cellSummaries,
      candidates: Array.from(candidateMap.values()),
      errors,
    };
    await fs.mkdir(path.dirname(candidatesOutputPath), { recursive: true });
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    await fs.writeFile(candidatesOutputPath, serialized, 'utf8');
    await fs.writeFile(candidatesPeriodOutputPath(data.period), serialized, 'utf8');
    try {
      const pool = await saveCandidatesToPool(data, { refresh: options.refreshPool });
      if (pool.written + pool.kept > 0) console.log(`syllabus-pool: written=${pool.written} kept(existing)=${pool.kept}`);
    } catch (error) {
      // プールは補助的な保存先。失敗しても候補ファイルの取得結果は有効
      console.warn(`syllabus-pool への保存に失敗しました（続行）: ${error instanceof Error ? error.message : String(error)}`);
    }
    return data;
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function main(): Promise<void> {
  const additional = process.argv.includes('--add');
  const syllabusArg = process.argv.find((arg) => arg === '--syllabus' || arg.startsWith('--syllabus='));
  const syllabus: SyllabusMode = !syllabusArg ? 'none' : syllabusArg === '--syllabus=all' ? 'all' : 'evening';
  const refreshPool = process.argv.includes('--refresh-pool');
  const data = await collectRegistrationCandidates({ additional, syllabus, refreshPool });
  const withSyllabus = data.candidates.filter((c) => c.syllabus).length;
  console.log(`Candidates: ${data.candidates.length} (syllabus: ${withSyllabus}, errors: ${data.errors.length})`);
  console.log(`Saved: ${candidatesOutputPath}`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    if (error instanceof RegistrationScreenUnavailableError) {
      console.error(error.message);
      console.error(`既存の ${candidatesOutputPath} は更新していません。`);
      process.exit(1);
    }
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
