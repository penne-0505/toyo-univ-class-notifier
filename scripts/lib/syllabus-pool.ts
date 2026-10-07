import fs from 'node:fs/promises';
import path from 'node:path';
import { syllabusFileStem } from './course-code';
import { outputDir } from './toyo-paths';

/**
 * syllabus-pool: 登録可能科目の取得（toyo:candidates）で得たシラバス本文を、授業コードごとに貯める場所。
 * registration-candidates.json は取得のたびに上書きされるが、プールは上書きしない（--refresh-pool のときだけ更新）。
 * 約 140 科目分あり配信には不要なので、toyo:publish の対象外。
 *
 * このファイルは playwright に依存しない（組み立て層・seed からも使える）。
 */

export const syllabusPoolDir = path.join(outputDir, 'syllabus-pool');

/** 候補ファイルの 1 件（シラバス本文つき）。形は registration-candidates.json の candidates[] と同じ。 */
export type PoolCandidate = {
  scheduleCd?: string;
  scheduleLabel?: string;
  courseName?: string;
  instructor?: string;
  classroom?: string;
  campus?: string;
  conductionType?: string;
  semester?: string;
  syllabus?: {
    sourceUrl?: string;
    courseCode?: string;
    classFormat?: string;
    learningGoals?: string;
    lectureSchedule?: string;
    instructionMethod?: string;
    preAndPostStudy?: string;
    grading?: string;
    textbook?: string;
    sections?: Record<string, string>;
  } | null;
  [key: string]: unknown;
};

export type PoolEntry = {
  /** 候補ファイルを取得した時刻（シラバス本文を取った時刻の近似） */
  fetchedAt: string;
  academicYear: string | null;
  period: 'regular' | 'add' | null;
  courseCode: string;
  candidate: PoolCandidate;
};

export function poolFileName(courseCode: string): string {
  return `${syllabusFileStem(courseCode)}.json`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** 授業コードを持つシラバス本文入りの候補だけをプールへ保存する。戻り値は { written, kept(既存で据え置き) }。 */
export async function saveCandidatesToPool(
  file: {
    fetchedAt: string;
    academicYear: string | null;
    period?: 'regular' | 'add' | null;
    candidates: PoolCandidate[];
  },
  options: { refresh?: boolean; dir?: string } = {}
): Promise<{ written: number; kept: number }> {
  const dir = options.dir ?? syllabusPoolDir;
  let written = 0;
  let kept = 0;
  for (const candidate of file.candidates) {
    const courseCode = candidate.syllabus?.courseCode;
    if (!courseCode) continue;
    const target = path.join(dir, poolFileName(courseCode));
    if (!options.refresh && (await exists(target))) {
      kept += 1;
      continue;
    }
    const entry: PoolEntry = {
      fetchedAt: file.fetchedAt,
      academicYear: file.academicYear,
      period: file.period ?? null,
      courseCode,
      candidate,
    };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    written += 1;
  }
  return { written, kept };
}

/** プールの全エントリ。ディレクトリが無ければ空。壊れたファイルは読み飛ばす。 */
export async function readPool(dir: string = syllabusPoolDir): Promise<PoolEntry[]> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const entries: PoolEntry[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as PoolEntry;
      if (parsed.courseCode && parsed.candidate) entries.push(parsed);
    } catch {
      /* 壊れたファイルは無視 */
    }
  }
  return entries;
}
