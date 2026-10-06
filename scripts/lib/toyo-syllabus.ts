import fs from 'node:fs/promises';
import path from 'node:path';
import { type Page } from 'playwright';
import { type Course, outputDir } from './toyo-enrollment';
import {
  getOrCreatePage,
  launchStateContext,
  recoverToyoSessionIfNeeded,
  shouldRunHeadless,
} from './toyo';

const syllabusOutputDir = path.join(outputDir, 'syllabus');

type TimetableCandidate = {
  rowIndex: number;
  courseName: string;
  instructor: string;
  schedule: string;
  conductionType: string;
  numbering: string;
  syllabusNo: string;
};

type SyllabusPageSnapshot = {
  courseName: string;
  sourceUrl: string;
  metadata: Record<string, string>;
  sections: Record<string, string>;
};

export type SyllabusRecord = {
  fetchedAt: string;
  academicYear: string;
  sourceUrl: string;
  courseName: string;
  instructor: string;
  courseCode: string;
  classFormat: string;
  conductionType: string;
  timetable: string;
  classroom: string;
  learningGoals: string;
  lectureSchedule: string;
  instructionMethod: string;
  preAndPostStudy: string;
  grading: string;
  textbook: string;
};

export type SyllabusLookupInput = Pick<
  Course,
  | 'courseName'
  | 'courseCode'
  | 'numbering'
  | 'semesterLabel'
  | 'day'
  | 'period'
  | 'deliveryMode'
  | 'instructor'
> & {
  academicYear?: string;
};

const timetableUrl = 'https://g-sys.toyo.ac.jp/univision/action/in/f02/Usin026411';
const fullWidthDigits = ['０', '１', '２', '３', '４', '５', '６', '７', '８', '９'] as const;
const asciiDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
const asciiUpper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const fullWidthUpper = 'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ';
const seasonLabelMap = new Map<string, string>([
  ['春', '春学期'],
  ['秋', '秋学期'],
  ['通', '通年'],
  ['１', '1Q'],
  ['２', '2Q'],
  ['３', '3Q'],
  ['４', '4Q'],
]);
const weekdayLabelMap = new Map<string, string>([
  ['月', '月曜日'],
  ['火', '火曜日'],
  ['水', '水曜日'],
  ['木', '木曜日'],
  ['金', '金曜日'],
  ['土', '土曜日'],
  ['日', '日曜日'],
  ['集', '集中'],
  ['未', '未定'],
  ['な', 'なし'],
]);

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) => {
    const index = fullWidthDigits.indexOf(char as (typeof fullWidthDigits)[number]);
    return index >= 0 ? String(index) : char;
  });
}

function toHalfWidthAlnum(value: string): string {
  return value
    .replace(/[０-９]/g, (char) => {
      const index = fullWidthDigits.indexOf(char as (typeof fullWidthDigits)[number]);
      return index >= 0 ? asciiDigits[index] : char;
    })
    .replace(/[Ａ-Ｚ]/g, (char) => {
      const index = fullWidthUpper.indexOf(char);
      return index >= 0 ? asciiUpper[index] : char;
    });
}

function normalizeCourseName(value: string): string {
  return toHalfWidthAlnum(normalizeText(value)).replace(/[　\s]+/g, '').toUpperCase();
}

function normalizeInstructor(value: string): string {
  return toHalfWidthAlnum(normalizeText(value)).replace(/[　\s]+/g, '').toUpperCase();
}

function normalizeSemesterLabel(value: string): string {
  return normalizeText(value).replace(/Spring|Autumn|Semester|Q/gi, '');
}

function normalizeSchedule(value: string): string {
  return normalizeCourseName(value);
}

function desiredSchedule(course: SyllabusLookupInput): string {
  const season = course.semesterLabel.startsWith('春')
    ? '春'
    : course.semesterLabel.startsWith('秋')
      ? '秋'
      : course.semesterLabel;
  return normalizeSchedule(`${season}${course.day}${course.period}`);
}

export function formatSyllabusTimetable(raw: string): string {
  const normalized = normalizeDigits(normalizeText(raw));
  const match = normalized.match(/^(.)(.)(\d+|集中|未定|なし)$/);
  if (!match) {
    return normalized;
  }

  const [, seasonKey, weekdayKey, period] = match;
  const season = seasonLabelMap.get(seasonKey) ?? seasonKey;
  const weekday = weekdayLabelMap.get(weekdayKey) ?? weekdayKey;
  const periodLabel = /^\d+$/.test(period) ? `${period}限` : period;
  return `${season}, ${weekday}, ${periodLabel}`;
}

function sectionValue(sections: Record<string, string>, label: string): string {
  return normalizeText(sections[label] ?? '');
}

function metadataValue(metadata: Record<string, string>, label: string): string {
  return normalizeText(metadata[label] ?? '');
}

function scoreCandidate(candidate: TimetableCandidate, course: SyllabusLookupInput): number {
  let score = 0;
  if (normalizeCourseName(candidate.courseName) === normalizeCourseName(course.courseName)) {
    score += 12;
  }
  if (normalizeText(candidate.numbering) === normalizeText(course.numbering)) {
    score += 10;
  }
  if (normalizeSchedule(candidate.schedule) === desiredSchedule(course)) {
    score += 8;
  }
  if (normalizeInstructor(candidate.instructor) === normalizeInstructor(course.instructor)) {
    score += 6;
  }
  if (normalizeText(candidate.conductionType) === normalizeText(course.deliveryMode)) {
    score += 4;
  }
  return score;
}

async function openTimetablePage(page: Page): Promise<void> {
  await page.goto(timetableUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await recoverToyoSessionIfNeeded(page, {
    returnUrl: timetableUrl,
    saveState: true,
    snapshotTag: 'syllabus-timetable-session-loss',
  });
  // 時間割表は春・秋の全科目を 1 ページに持ち、学期タブは表示の切替に過ぎない（実機確認済み）。
  // 行の描画待ちが足りないと 0 件になるため、行が現れるまで待つ。
  await page.waitForSelector('td.subject_name a', { timeout: 20_000 }).catch(() => {});
}

/** 科目の学期（秋学期など）に合わせて時間割表の学期タブを切り替える。タブが無ければ何もしない。 */
async function selectTimetableSemester(page: Page, semesterLabel: string): Promise<void> {
  const semesterId = semesterLabel.startsWith('春') ? '1' : semesterLabel.startsWith('秋') ? '2' : null;
  if (!semesterId) return;
  await page
    .locator(`div.stab_${semesterId}`)
    .first()
    .click({ timeout: 3_000 })
    .catch(() => {});
}

async function readTimetableCandidates(page: Page): Promise<TimetableCandidate[]> {
  return page.evaluate((): TimetableCandidate[] => {
    const candidates: TimetableCandidate[] = [];
    const displayTypeValue =
      typeof (window as Window & { displayType?: string }).displayType === 'string'
        ? (window as Window & { displayType?: string }).displayType!
        : 'mobile';
    const rows = [...document.querySelectorAll('tr')];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const subjectLink = row.querySelector<HTMLAnchorElement>('td.subject_name a');
      if (!subjectLink) {
        continue;
      }

      const instructorLink = row.querySelector<HTMLAnchorElement>('td.employee_name a');
      const scheduleCell = row.querySelector<HTMLElement>('td.schedule');
      const conductionCell = row.querySelector<HTMLElement>('td.conduction_type');
      const onclick = subjectLink.getAttribute('onclick') ?? '';
      const urlMatch =
        onclick.match(/openWindow\('([^']*?)'\+displayType/) ??
        onclick.match(/openWindow\('([^']*?)'/);
      if (!urlMatch) {
        continue;
      }

      const detailUrl = new URL(urlMatch[1] + displayTypeValue, window.location.href).href;
      const syllabusNoMatch = detailUrl.match(/[?&]syllabusNo=([^&]+)/);
      const numberingMatch = detailUrl.match(/[?&]numbering=([^&]+)/);
      if (!syllabusNoMatch) {
        continue;
      }

      candidates.push({
        rowIndex,
        courseName: (subjectLink.textContent ?? '').replace(/\s+/g, ' ').trim(),
        instructor: (instructorLink?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        schedule: (scheduleCell?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        conductionType: (conductionCell?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        numbering: numberingMatch ? decodeURIComponent(numberingMatch[1]) : '',
        syllabusNo: decodeURIComponent(syllabusNoMatch[1]),
      });
    }

    return candidates;
  });
}

async function openSyllabusDetailFromTimetable(
  page: Page,
  candidate: TimetableCandidate
): Promise<Page> {
  const context = page.context();
  const chooserPromise = page.waitForEvent('popup', { timeout: 10_000 });
  await page.evaluate((rowIndex) => {
    const rows = [...document.querySelectorAll('tr')];
    const target = rows[rowIndex]?.querySelector<HTMLAnchorElement>('td.subject_name a');
    if (!target) {
      throw new Error(`Syllabus row at index ${rowIndex} was not found.`);
    }
    target.click();
  }, candidate.rowIndex);
  const chooserPage = await chooserPromise;
  await chooserPage.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});

  const publicPagePromise = context.waitForEvent('page', {
    timeout: 10_000,
    predicate: (popup) => popup !== page && popup !== chooserPage,
  });
  await chooserPage.locator('input.button[value="日本語"]').click({ force: true });
  const detailPage = await publicPagePromise;
  await detailPage.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
  await detailPage.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  if (!chooserPage.isClosed()) {
    await chooserPage.close().catch(() => {});
  }

  return detailPage;
}

async function readSyllabusPage(page: Page): Promise<SyllabusPageSnapshot> {
  return page.evaluate((): SyllabusPageSnapshot => {
    const titleTable = document.querySelector('table.head-title');
    const metaTable = document.querySelector('table.lcl-ttl2');
    const bodyTable = document.querySelector('table.sbs-show');

    const metadata: Record<string, string> = {};
    if (metaTable) {
      for (const row of metaTable.querySelectorAll('tr')) {
        const cells = [...row.querySelectorAll('th, td')].map((cell) =>
          (cell.textContent ?? '').replace(/\s+/g, ' ').trim()
        );
        for (let index = 0; index + 1 < cells.length; index += 2) {
          const key = cells[index];
          const value = cells[index + 1];
          if (key) {
            metadata[key] = value;
          }
        }
      }
    }

    const sections: Record<string, string> = {};
    if (bodyTable) {
      const rows = [...bodyTable.querySelectorAll('tr')].map((row) =>
        [...row.querySelectorAll('th, td')]
          .map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      );
      for (let index = 0; index < rows.length; index += 1) {
        const current = rows[index];
        if (current.length !== 1) {
          continue;
        }
        const heading = current[0];
        if (!heading.startsWith('【') || !heading.endsWith('】')) {
          continue;
        }
        const key = heading.slice(1, -1);
        const next = rows[index + 1] ?? [];
        sections[key] = next.join('\n').replace(/\s+/g, ' ').trim();
      }
    }

    return {
      courseName: (titleTable?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      sourceUrl: window.location.href,
      metadata,
      sections,
    };
  });
}

function buildSyllabusRecord(
  snapshot: SyllabusPageSnapshot,
  fetchedAt: string,
  academicYear: string
): SyllabusRecord {
  return {
    fetchedAt,
    academicYear,
    sourceUrl: snapshot.sourceUrl,
    courseName: snapshot.courseName,
    instructor: metadataValue(snapshot.metadata, '担当者'),
    courseCode: metadataValue(snapshot.metadata, '授業コード'),
    classFormat: metadataValue(snapshot.metadata, '授業形態'),
    conductionType: metadataValue(snapshot.metadata, '実施形態'),
    timetable: formatSyllabusTimetable(metadataValue(snapshot.metadata, '時間割')),
    classroom: metadataValue(snapshot.metadata, '教室'),
    learningGoals: sectionValue(snapshot.sections, '学修到達目標'),
    lectureSchedule: sectionValue(snapshot.sections, '講義スケジュール'),
    instructionMethod: sectionValue(snapshot.sections, '指導方法'),
    preAndPostStudy:
      sectionValue(snapshot.sections, '事前・事後学修') ||
      sectionValue(snapshot.sections, '事前・事後学習'),
    grading: sectionValue(snapshot.sections, '成績評価の方法・基準'),
    textbook: sectionValue(snapshot.sections, 'テキスト'),
  };
}

export async function fetchSyllabus(course: SyllabusLookupInput): Promise<SyllabusRecord> {
  const fetchedAt = new Date().toISOString();
  const { browser, context } = await launchStateContext({
    headless: shouldRunHeadless(true),
  });
  const page = await getOrCreatePage(context);

  try {
    await openTimetablePage(page);
    await selectTimetableSemester(page, course.semesterLabel);
    let candidates = await readTimetableCandidates(page);
    if (candidates.length === 0) {
      // 一時的な空表示への対策として、再読み込みして 1 回だけ再試行する。
      await openTimetablePage(page);
      await selectTimetableSemester(page, course.semesterLabel);
      candidates = await readTimetableCandidates(page);
    }
    if (candidates.length === 0) {
      throw new Error('No syllabus candidates were found on the timetable page.');
    }

    const rankedCandidates = [...candidates]
      .map((candidate) => ({ candidate, score: scoreCandidate(candidate, course) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);

    if (rankedCandidates.length === 0) {
      throw new Error(
        `No timetable syllabus candidates matched ${course.courseName} (${course.courseCode}).`
      );
    }

    let lastRecord: SyllabusRecord | null = null;
    for (const { candidate } of rankedCandidates.slice(0, 8)) {
      const detailPage = await openSyllabusDetailFromTimetable(page, candidate);
      try {
        const snapshot = await readSyllabusPage(detailPage);
        const record = buildSyllabusRecord(snapshot, fetchedAt, course.academicYear ?? '');
        lastRecord = record;
        if (record.courseCode === course.courseCode) {
          return record;
        }
      } finally {
        await detailPage.close();
      }
    }

    if (lastRecord) {
      throw new Error(
        `Timetable syllabus candidates were found for ${course.courseName}, but none matched course code ${course.courseCode}.`
      );
    }

    throw new Error(`Failed to read syllabus detail for ${course.courseName}.`);
  } finally {
    await context.close();
    await browser.close();
  }
}

type SyllabusFileCache = {
  fetchedAt: string;
  inputCourse: unknown;
  syllabus: SyllabusRecord;
};

export async function fetchSyllabusWithCache(course: SyllabusLookupInput): Promise<SyllabusRecord> {
  if (course.courseCode && course.academicYear) {
    const stem = course.courseCode.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
    const cachePath = path.join(syllabusOutputDir, `${stem}.json`);
    try {
      const raw = await fs.readFile(cachePath, 'utf8');
      const cached = JSON.parse(raw) as SyllabusFileCache;
      if (cached.syllabus?.academicYear === course.academicYear) {
        return cached.syllabus;
      }
    } catch {
      // cache miss — fall through to fetch
    }
  }
  return fetchSyllabus(course);
}
