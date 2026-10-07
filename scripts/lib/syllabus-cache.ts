import fs from 'node:fs/promises';
import path from 'node:path';
import { syllabusFileStem } from './course-code';
import { outputDir } from './toyo-paths';

/**
 * シラバスのキャッシュ（output/toyo/syllabus/<授業コード>.json）の型と読み出し。
 * playwright に依存しないので、組み立て層（scripts/build/）の入力を読む側からも使える。
 * 書き込み（取得結果の保存）は fetch/syllabus.ts の writeSyllabusArtifacts。
 */

export const syllabusCacheDir = path.join(outputDir, 'syllabus');

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

/** キャッシュファイルの中身（writeSyllabusArtifacts が書く形）。 */
export type SyllabusCacheFile = {
  fetchedAt: string;
  inputCourse?: unknown;
  syllabus: SyllabusRecord;
};

/** 授業コード → シラバス。キーはファイル名の語幹（syllabusFileStem(授業コード)）。壊れたファイルは読み飛ばす。 */
export type SyllabusMap = Record<string, SyllabusRecord>;

/** キャッシュディレクトリの全 .json を読む。ディレクトリが無ければ空。 */
export async function readSyllabusCache(dir: string = syllabusCacheDir): Promise<SyllabusMap> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return {};
  }
  const map: SyllabusMap = {};
  for (const name of names) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as Partial<SyllabusCacheFile>;
      if (parsed.syllabus && typeof parsed.syllabus === 'object') map[name.slice(0, -'.json'.length)] = parsed.syllabus;
    } catch {
      /* 壊れたファイルは無視 */
    }
  }
  return map;
}

/** 授業コードでシラバスを引く。academicYear を渡すと、年度が違うキャッシュ（前年度のもの）は無いものとして扱う。 */
export function findSyllabus(map: SyllabusMap, courseCode: string, academicYear?: string | null): SyllabusRecord | null {
  const record = map[syllabusFileStem(courseCode)];
  if (!record) return null;
  if (academicYear && record.academicYear !== academicYear) return null;
  return record;
}
