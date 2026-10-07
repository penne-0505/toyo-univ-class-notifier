/**
 * 組み立て層をまとめて実行する: course-index → summary → agent-context。
 * 取得層の出力ファイル（output/toyo/*.json、data/）を読むだけで、ブラウザもネットワークも使わない。
 * 欠けている入力は null と警告で表し、失敗にはしない（失敗は取得そのものが落ちたときだけ）。
 * どのジョブも取得のあとにこれを呼び、そのあと publish する。
 *
 * Usage:
 *   npm run toyo:build
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { type CourseIndex } from '../build/course-index';
import { buildSummary, summaryOutputPath, type AcademicCalendarInput, type Summary, type SummaryInputs } from '../build/summary';
import { buildAndWriteCourseIndex, summarizeCourseIndex } from './build-index';
import { buildAndWriteContext, summarizeContext } from './build-context';
import { readSyllabusCache } from '../lib/syllabus-cache';
import { loadAcademicSchedule } from '../lib/toyo-academic-schedule';
import { type AnnouncementCollectionResult } from '../fetch/toyo-announcements';
import { type EnrollmentData } from '../fetch/toyo-enrollment';
import { outputDir } from '../lib/toyo-paths';
import { type CourseworkResult } from '../lib/coursework-model';
import { type AssignmentCollectionResult, type CourseContentCollectionResult } from '../fetch/toyonet-ace';

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** 入力を読む。dir を渡すと output/toyo/ の代わりにそのディレクトリを読む（scripts/dev/build-from-golden.ts 用）。 */
export async function readSummaryInputs(dir: string = outputDir): Promise<SummaryInputs> {
  const read = <T>(name: string): Promise<T | null> => readJson<T>(path.join(dir, name));
  const [registration, assignments, contents, announcements, coursework, academicCalendar, syllabi] = await Promise.all([
    read<EnrollmentData>('registration-data.json'),
    read<AssignmentCollectionResult>('toyonet-ace-assignments.json'),
    read<CourseContentCollectionResult>('toyonet-ace-contents.json'),
    read<AnnouncementCollectionResult>('announcements.json'),
    read<CourseworkResult>('toyonet-ace-coursework.json'),
    read<AcademicCalendarInput>('academic-calendar.json'),
    readSyllabusCache(path.join(dir, 'syllabus')),
  ]);
  return {
    registration,
    assignments,
    contents,
    announcements,
    coursework: coursework && Array.isArray(coursework.courses) ? coursework : null,
    academicCalendar,
    syllabi,
    academicSchedule: loadAcademicSchedule(),
  };
}

export async function writeSummary(summary: Summary): Promise<void> {
  await fs.mkdir(path.dirname(summaryOutputPath), { recursive: true });
  const tmp = `${summaryOutputPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(summary, null, 2), 'utf8');
  await fs.rename(tmp, summaryOutputPath);
}

export function summarizeSummary(summary: Summary): string {
  return `[summary] today=${summary.todayClasses.length} tomorrow=${summary.tomorrowClasses.length} assignments=${summary.upcomingAssignments.length} contents=${summary.courseContents.length} announcements=${summary.announcements.length} errors=${summary.errors.length}`;
}

/** 入力を読んで summary を組み立て、書き出す。 */
export async function buildAndWriteSummary(index: CourseIndex, now: Date = new Date()): Promise<Summary> {
  const summary = buildSummary(await readSummaryInputs(), index, now);
  await writeSummary(summary);
  return summary;
}

/** index → summary → context を順に作る。各段の 1 行サマリを標準出力に出す。 */
export async function runBuild(now: Date = new Date()): Promise<void> {
  const index = await buildAndWriteCourseIndex(now);
  console.log(summarizeCourseIndex(index));
  const summary = await buildAndWriteSummary(index, now);
  console.log(summarizeSummary(summary));
  const { context } = await buildAndWriteContext(undefined, now);
  console.log(summarizeContext(context));
}

export async function main(): Promise<void> {
  await runBuild();
}
