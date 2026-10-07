import { collectToyoNetAceCoursework, courseworkOutputPath, computeCounts } from '../fetch/toyonet-ace-coursework';
import { runBuild } from './build';

/**
 * ACE のコース別提出状況（レポート / 小テスト / アンケート / 成績 / 提出記録）を取得して
 * output/toyo/toyonet-ace-coursework.json に保存する。
 * 取得後、toyo:build（index → summary → agent-context）を実行する（--no-build で省略。daily は最後にまとめて実行するため付ける）。
 * 失敗とみなすのは取得が落ちたときだけ。ACE への登録反映待ちなどの欠けは index の警告で表し、ここでは失敗にしない。
 */

export async function main(): Promise<void> {
  const noBuild = process.argv.includes('--no-build');
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
  if (!noBuild) {
    await runBuild();
  }
}
