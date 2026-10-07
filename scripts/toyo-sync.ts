#!/usr/bin/env node

import {
  ensureEnrollmentOutputDirs,
  scrapeEnrollmentData,
  writeEnrollmentArtifacts,
} from './lib/toyo-enrollment';
import { collectToyoNetAceAssignments, collectToyoNetAceContents } from './lib/toyonet-ace';
import { collectToyoNetAceAnnouncements } from './lib/toyo-announcements';
import { fetchAcademicCalendar } from './lib/toyo-academic-calendar';
import { summaryOutputPath } from './build/summary';
import { runBuild } from './toyo-build';

/**
 * ポータルとACE の取得系をまとめて取り直し（履修・課題・コンテンツ・お知らせ・祝日）、toyo:build を実行する。
 * シラバスは取得しない（index の欠けを daily が補完する。手動は toyo:syllabus / toyo:syllabus:seed）。
 *
 * 失敗とみなすのは履修登録確認表の取得が落ちたときだけ。ACE の各取得が不調でも、その結果は
 * summary の sourceStatus と warnings に出るので、ここでは警告を出して続行する。
 * --no-build: 取得だけして build を省く（daily は最後にまとめて build するため付ける）。
 */

function warn(label: string, result: { available: boolean; errors: string[] }): void {
  if (!result.available || result.errors.length > 0) {
    console.warn(`[sync] ${label} unavailable or partial: ${result.errors.join(' | ') || '(no error message)'}`);
  }
}

export async function main(): Promise<void> {
  const noBuild = process.argv.includes('--no-build');
  await ensureEnrollmentOutputDirs();

  const enrollment = await scrapeEnrollmentData();
  await writeEnrollmentArtifacts(enrollment);

  // Playwright セッションは同時に 1 つなので直列に取得する
  const courseNames = enrollment.courses.map((course) => course.courseName);
  warn('assignments', await collectToyoNetAceAssignments());
  warn('contents', await collectToyoNetAceContents(courseNames));
  warn('announcements', await collectToyoNetAceAnnouncements(courseNames));
  await fetchAcademicCalendar(enrollment.academicYear).catch((error: unknown) => {
    console.warn(`Calendar fetch failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
  });

  if (enrollment.fetchStatus === 'error') {
    console.warn(`Portal fetch status: ${enrollment.fetchStatus} (pageTitle: ${enrollment.pageTitle})`);
  }
  // journal を汚さないよう 1 行にまとめる
  console.log(`[sync] enrollment=${enrollment.fetchStatus}${noBuild ? '' : ` summary=${summaryOutputPath}`}`);
  if (!noBuild) await runBuild();
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
