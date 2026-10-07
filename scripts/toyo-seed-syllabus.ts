#!/usr/bin/env node

/**
 * registration-candidates.json の candidates[].syllabus（候補科目全件のシラバス本文）から、
 * 登録中の科目の SyllabusRecord を output/toyo/syllabus/<授業コード>.json / .md に書き出す。
 * 時間割検索（Usin026411）を経由しないため、ブラウザは使わない。既存ファイルは --force 指定時のみ上書き。
 *
 * Usage:
 *   npm run toyo:syllabus:seed
 *   npm run toyo:syllabus:seed -- --from <シラバス入りの registration-candidates.json>   # 追加登録期間の取得で上書きされた場合など
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { type EnrollmentData, jsonOutputPath, outputDir } from './lib/toyo-enrollment';
import { formatSyllabusTimetable, type SyllabusRecord } from './lib/toyo-syllabus';
import { writeSyllabusArtifacts } from './toyo-fetch-syllabus';

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

function safeStem(code: string): string {
  return code.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const fromIndex = argv.indexOf('--from');
  const sourcePath = fromIndex >= 0 && argv[fromIndex + 1] ? path.resolve(argv[fromIndex + 1]) : candidatesPath;
  const enrollment = JSON.parse(await fs.readFile(jsonOutputPath, 'utf8')) as EnrollmentData;
  const candidates = JSON.parse(await fs.readFile(sourcePath, 'utf8')) as CandidatesFile;
  console.log(`source: ${sourcePath}`);

  const byCode = new Map<string, Candidate>();
  for (const candidate of candidates.candidates) {
    const code = candidate.syllabus?.courseCode;
    if (code && !byCode.has(code)) byCode.set(code, candidate);
  }

  let written = 0;
  let skipped = 0;
  const missing: string[] = [];
  for (const course of enrollment.courses) {
    const candidate = byCode.get(course.courseCode);
    const syllabus = candidate?.syllabus;
    const jsonPath = path.join(syllabusOutputDir, `${safeStem(course.courseCode)}.json`);
    if (!candidate || !syllabus) {
      // 既にキャッシュがある科目（別学期など）は欠落扱いにしない
      if (!(await exists(jsonPath))) missing.push(`${course.courseCode} ${course.courseName}`);
      continue;
    }
    if (!force && (await exists(jsonPath))) {
      skipped += 1;
      continue;
    }
    const record: SyllabusRecord = {
      fetchedAt: candidates.fetchedAt,
      academicYear: candidates.academicYear,
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

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
