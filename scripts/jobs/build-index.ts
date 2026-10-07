/**
 * output/toyo/course-index.json（科目の対応表）を作る。ファイルを読むだけでネットワークもブラウザも使わない。
 * 入力: registration-data / toyonet-ace-coursework / registration-candidates*.json / syllabus/ / data/grading-rules.json
 *
 * Usage:
 *   npm run toyo:build:index
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildCourseIndex,
  type CandidatesInput,
  type CourseIndex,
  type CourseIndexInputs,
  type CourseworkInput,
  type GradingRulesInput,
  type RegistrationInput,
} from '../build/course-index';
import { loadAcademicSchedule } from '../lib/toyo-academic-schedule';
import { dataDir, outputDir } from '../lib/toyo-paths';

export const courseIndexOutputPath = path.join(outputDir, 'course-index.json');

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/** 入力を読む。dirs を渡すと、output/toyo/ と data/ の代わりにそのディレクトリを読む（scripts/dev/build-from-golden.ts 用）。 */
export async function readCourseIndexInputs(dirs: { outputDir: string; dataDir: string } = { outputDir, dataDir }): Promise<CourseIndexInputs> {
  const candidateFiles = ['registration-candidates.json', 'registration-candidates.regular.json', 'registration-candidates.add.json'];
  const candidates = (
    await Promise.all(candidateFiles.map((name) => readJson<CandidatesInput>(path.join(dirs.outputDir, name))))
  ).filter((file): file is CandidatesInput => file !== null && Array.isArray(file.candidates));
  return {
    registration: await readJson<RegistrationInput>(path.join(dirs.outputDir, 'registration-data.json')),
    coursework: await readJson<CourseworkInput>(path.join(dirs.outputDir, 'toyonet-ace-coursework.json')),
    candidates,
    syllabusFiles: await listFiles(path.join(dirs.outputDir, 'syllabus')),
    gradingRules: await readJson<GradingRulesInput>(path.join(dirs.dataDir, 'grading-rules.json')),
    academicSchedule: loadAcademicSchedule(),
  };
}

export async function writeCourseIndex(index: CourseIndex): Promise<void> {
  await fs.mkdir(path.dirname(courseIndexOutputPath), { recursive: true });
  const tmp = `${courseIndexOutputPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, courseIndexOutputPath);
}

/** 入力を読んで index を組み立て、書き出す。daily / coursework からも呼ぶ。 */
export async function buildAndWriteCourseIndex(now: Date = new Date()): Promise<CourseIndex> {
  const index = buildCourseIndex(await readCourseIndexInputs(), now);
  await writeCourseIndex(index);
  return index;
}

export function summarizeCourseIndex(index: CourseIndex): string {
  const current = index.currentSemester;
  const inScope = index.courses.filter((c) => !current || c.semester.startsWith(current.slice(0, 1)) || c.semester.startsWith('通年'));
  const withWarnings = index.courses.filter((c) => c.warnings.length > 0);
  const warningCount = index.courses.reduce((sum, c) => sum + c.warnings.length, 0);
  return `[index] courses=${index.courses.length} current(${current ?? '?'})=${inScope.length} warnings=${warningCount} (${withWarnings.length} courses) aceOnly=${index.aceOnly.length}`;
}

export async function main(): Promise<void> {
  const index = await buildAndWriteCourseIndex();
  console.log(summarizeCourseIndex(index));
}
