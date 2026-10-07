/**
 * 登録可能科目の取得で得たシラバス本文（候補科目全件）から、
 * 登録中の科目の SyllabusRecord を output/toyo/syllabus/<授業コード>.json / .md に書き出す。
 * 時間割検索（Usin026411）を経由しないため、ブラウザは使わない。既存ファイルは --force 指定時のみ上書き。
 *
 * 入力（--from が無いとき）: syllabus-pool/ → 最新の registration-candidates.json の順に探す。
 *
 * Usage:
 *   npm run toyo:syllabus:seed
 *   npm run toyo:syllabus:seed -- --from <シラバス入りの registration-candidates.json>   # このファイルだけを入力にする
 *   npm run toyo:syllabus:seed -- --course-code <授業コード> [...]                       # 指定した授業コードだけ（daily の補完用）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { type EnrollmentData, jsonOutputPath, outputDir } from './toyo-enrollment';
import { formatSyllabusTimetable } from './toyo-syllabus';
import { type SyllabusRecord } from '../lib/syllabus-cache';
import { syllabusFileStem } from '../lib/course-code';
import { readPool } from '../lib/syllabus-pool';
import { writeSyllabusArtifacts } from './syllabus';

const candidatesPath = path.join(outputDir, 'registration-candidates.json');
const syllabusOutputDir = path.join(outputDir, 'syllabus');

type CandidateSyllabus = {
  sourceUrl?: string;
  courseCode?: string;
  classFormat?: string;
  learningGoals?: string;
  lectureSchedule?: string;
  instructionMethod?: string;
  preAndPostStudy?: string;
  grading?: string;
  textbook?: string;
};

type Candidate = {
  scheduleLabel?: string;
  courseName?: string;
  instructor?: string;
  classroom?: string;
  conductionType?: string;
  syllabus?: CandidateSyllabus | null;
};

type CandidatesFile = {
  fetchedAt: string;
  academicYear: string;
  candidates: Candidate[];
};

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

type Found = { candidate: Candidate; fetchedAt: string; academicYear: string };

async function readCandidatesFile(file: string): Promise<CandidatesFile | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as CandidatesFile;
  } catch {
    return null;
  }
}

/** 授業コード → シラバス本文入りの候補。先に入れたものを優先する（pool → 最新の候補ファイル）。 */
async function collectSyllabusSources(fromPath: string | null): Promise<{ byCode: Map<string, Found>; labels: string[] }> {
  const byCode = new Map<string, Found>();
  const labels: string[] = [];
  const addFile = (file: CandidatesFile, label: string): void => {
    let added = 0;
    for (const candidate of file.candidates) {
      const code = candidate.syllabus?.courseCode;
      if (!code || byCode.has(code)) continue;
      byCode.set(code, { candidate, fetchedAt: file.fetchedAt, academicYear: file.academicYear });
      added += 1;
    }
    labels.push(`${label} (${added})`);
  };

  if (fromPath) {
    const file = await readCandidatesFile(fromPath);
    if (!file) throw new Error(`--from のファイルを読めません: ${fromPath}`);
    addFile(file, fromPath);
    return { byCode, labels };
  }

  const pool = await readPool();
  let fromPool = 0;
  for (const entry of pool) {
    if (byCode.has(entry.courseCode)) continue;
    byCode.set(entry.courseCode, {
      candidate: entry.candidate as Candidate,
      fetchedAt: entry.fetchedAt,
      academicYear: entry.academicYear ?? '',
    });
    fromPool += 1;
  }
  labels.push(`syllabus-pool (${fromPool})`);
  const latest = await readCandidatesFile(candidatesPath);
  if (latest) addFile(latest, candidatesPath);
  return { byCode, labels };
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const fromIndex = argv.indexOf('--from');
  const fromPath = fromIndex >= 0 && argv[fromIndex + 1] ? path.resolve(argv[fromIndex + 1]) : null;
  const onlyCodes = new Set<string>();
  argv.forEach((arg, i) => {
    if (arg === '--course-code' && argv[i + 1]) onlyCodes.add(argv[i + 1]);
  });
  const enrollment = JSON.parse(await fs.readFile(jsonOutputPath, 'utf8')) as EnrollmentData;
  const { byCode, labels } = await collectSyllabusSources(fromPath);
  console.log(`source: ${labels.join(' + ')}`);

  let written = 0;
  let skipped = 0;
  const missing: string[] = [];
  for (const course of enrollment.courses) {
    if (onlyCodes.size > 0 && !onlyCodes.has(course.courseCode)) continue;
    const found = byCode.get(course.courseCode);
    const candidate = found?.candidate;
    const syllabus = candidate?.syllabus;
    const jsonPath = path.join(syllabusOutputDir, `${syllabusFileStem(course.courseCode)}.json`);
    if (!found || !candidate || !syllabus) {
      // 既にキャッシュがある科目（別学期など）は欠落扱いにしない
      if (!(await exists(jsonPath))) missing.push(`${course.courseCode} ${course.courseName}`);
      continue;
    }
    if (!force && (await exists(jsonPath))) {
      skipped += 1;
      continue;
    }
    const record: SyllabusRecord = {
      fetchedAt: found.fetchedAt,
      academicYear: found.academicYear,
      sourceUrl: syllabus.sourceUrl ?? '',
      courseName: candidate.courseName || course.courseName,
      instructor: candidate.instructor || course.instructor,
      courseCode: course.courseCode,
      classFormat: syllabus.classFormat ?? '',
      conductionType: candidate.conductionType || course.deliveryMode,
      timetable: formatSyllabusTimetable(candidate.scheduleLabel ?? ''),
      classroom: candidate.classroom || course.room,
      learningGoals: syllabus.learningGoals ?? '',
      lectureSchedule: syllabus.lectureSchedule ?? '',
      instructionMethod: syllabus.instructionMethod ?? '',
      preAndPostStudy: syllabus.preAndPostStudy ?? '',
      grading: syllabus.grading ?? '',
      textbook: syllabus.textbook ?? '',
    };
    const result = await writeSyllabusArtifacts(course, record);
    console.log(`wrote ${result.jsonPath}`);
    written += 1;
  }

  console.log(`seed: written=${written} skipped(existing)=${skipped} missing=${missing.length}`);
  for (const line of missing) console.log(`  no candidate syllabus: ${line}`);
}
