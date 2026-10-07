#!/usr/bin/env node

import fs from 'node:fs/promises';
import { jsonOutputPath, type EnrollmentData } from './lib/toyo-enrollment';
import { collectToyoNetAceCoursework, courseworkOutputPath, computeCounts } from './lib/toyonet-ace-coursework';
import {
  toyoNetAceAssignmentsOutputPath,
  toyoNetAceContentsOutputPath,
  type AssignmentCollectionResult,
  type CourseContentCollectionResult,
} from './lib/toyonet-ace';
import { announcementsOutputPath, type AnnouncementCollectionResult } from './lib/toyo-announcements';
import { buildDiscordSummary, writeDiscordSummary } from './lib/toyo-summary';

/**
 * ACE のコース別提出状況（レポート / 小テスト / アンケート / 成績 / 提出記録）を取得して
 * output/toyo/toyonet-ace-coursework.json に保存する。
 * 取得後、ディスク上の ACE データから summary.json を再生成する（--no-summary で省略）。
 * 再生成しないと toyo:context が coursework を反映できない。
 */

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function rebuildSummary(): Promise<void> {
  const [enrollment, assignments, contents, announcements] = await Promise.all([
    readJson<EnrollmentData>(jsonOutputPath),
    readJson<AssignmentCollectionResult>(toyoNetAceAssignmentsOutputPath),
    readJson<CourseContentCollectionResult>(toyoNetAceContentsOutputPath),
    readJson<AnnouncementCollectionResult>(announcementsOutputPath),
  ]);
  if (!enrollment || !assignments || !contents || !announcements) {
    console.warn('summary を再生成できません（registration-data / assignments / contents / announcements のいずれかが無い）。');
    return;
  }
  const summary = await buildDiscordSummary(enrollment, { assignments, contents, announcements });
  await writeDiscordSummary(summary);
  console.log('[coursework] summary.json を再生成しました。');
}

export async function main(): Promise<void> {
  const noSummary = process.argv.includes('--no-summary');
  // 科目ごとの内訳は --verbose のときだけ（毎時の journal を汚さない）
  const verbose = process.argv.includes('--verbose');
  if (verbose) console.log('Collecting ToyoNet-ACE coursework...');
  const result = await collectToyoNetAceCoursework();

  if (result.errors.length > 0) {
    console.error('Errors:');
    for (const error of result.errors) console.error(` - ${error}`);
  }

  const totals = { items: 0, submitted: 0, notSubmittedOpen: 0, closedNotSubmitted: 0, waiting: 0 };
  for (const course of result.courses) {
    const counts = computeCounts(course.items);
    totals.items += course.items.length;
    totals.submitted += counts.submitted;
    totals.notSubmittedOpen += counts.notSubmittedOpen;
    totals.closedNotSubmitted += counts.closedNotSubmitted;
    totals.waiting += counts.waiting;
    if (verbose) {
      const byType = (t: string) => course.items.filter((i) => i.type === t).length;
      console.log(
        ` ${course.courseName} [${course.courseCode ?? '-'}${course.portalCourseName ? '' : ' / 未登録'}] items=${course.items.length} (report ${byType('report')}, query ${byType('query')}, survey ${byType('survey')}) 済=${counts.submitted} 受付中未=${counts.notSubmittedOpen} 終了未=${counts.closedNotSubmitted} 待ち=${counts.waiting} grades=${course.grades.length}`
      );
    }
  }
  console.log(
    `[coursework] courses=${result.courses.length} items=${totals.items} 済=${totals.submitted} 受付中未=${totals.notSubmittedOpen} 終了未=${totals.closedNotSubmitted} 待ち=${totals.waiting} submissions(30d)=${result.submissions.length}`
  );
  if (result.available && verbose) console.log(`Output: ${courseworkOutputPath}`);

  if (!result.available) {
    process.exit(1);
  }
  if (!noSummary) {
    await rebuildSummary();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
