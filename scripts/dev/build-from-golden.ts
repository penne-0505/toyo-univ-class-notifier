#!/usr/bin/env node

/**
 * 突き合わせ用: 保存済みのスナップショット（tmp/golden/<日付>/toyo/ の取得層の出力一式）を入力に、
 * 新実装の組み立て層（index → buildSummary → buildContext）を実行して <outDir> に書く。
 * 時刻は旧 summary の generatedAt / 旧 context の builtAt に合わせる（同じ入力・同じ時刻で比べるため）。
 * 出力: <outDir>/course-index.json, summary.json, agent-context.json, agent-context.md。output/toyo/ には触らない。
 * 比較は scripts/dev/compare-golden.ts で行う。
 *
 * Usage:
 *   npx tsx scripts/dev/build-from-golden.ts <goldenDir> <oldSummary.json> <outDir> [--now <ISO8601>] [--data-dir <dir>]
 *   例: npx tsx scripts/dev/build-from-golden.ts tmp/golden/2026-10-08/toyo tmp/golden/2026-10-08/bot/summary.json tmp/golden-new
 *   --now を渡すと summary / context の時刻をそれに差し替える（別の曜日・時刻での挙動確認用）。
 *   --data-dir を渡すと data/（grading-rules.json）をそのディレクトリから読む。スナップショットには data/ が無いので、
 *   旧 context を作った時点の data/ を `git show <commit>:data/grading-rules.json` で取り出して指すと、評価ルールの入力差も揃えられる。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildCourseIndex } from '../build/course-index';
import { buildContext, defaultHorizonDays, defaultMaxAgeMinutes, type AcademicCalendar } from '../build/context';
import { buildMarkdown } from '../build/context-markdown';
import { buildSummary } from '../build/summary';
import { readCourseIndexInputs } from '../jobs/build-index';
import { readSummaryInputs } from '../jobs/build';
import { type GradingRulesFile } from '../lib/toyo-grading-rules';
import { healthWarnings, type HealthSnapshot } from '../lib/toyo-health';
import { dataDir } from '../lib/toyo-paths';

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const nowIndex = argv.indexOf('--now');
  const nowOverride = nowIndex >= 0 ? new Date(argv[nowIndex + 1]) : null;
  const dataIndex = argv.indexOf('--data-dir');
  const inputDataDir = dataIndex >= 0 ? path.resolve(argv[dataIndex + 1]) : dataDir;
  const positional = argv.filter((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--now' && argv[i - 1] !== '--data-dir');
  const [goldenDir, oldSummaryPath, outDir] = positional;
  if (!goldenDir || !oldSummaryPath || !outDir) {
    console.error('Usage: npx tsx scripts/dev/build-from-golden.ts <goldenDir> <oldSummary.json> <outDir> [--now <ISO8601>] [--data-dir <dir>]');
    process.exit(2);
  }
  const oldSummary = await readJson<{ generatedAt: string }>(oldSummaryPath);
  const oldContext = await readJson<{ builtAt: string }>(path.join(goldenDir, 'agent-context.json'));
  if (!oldSummary || !oldContext) throw new Error('旧 summary / 旧 agent-context を読めません。');
  const summaryNow = nowOverride ?? new Date(oldSummary.generatedAt);
  const contextNow = nowOverride ?? new Date(oldContext.builtAt);

  const index = buildCourseIndex(await readCourseIndexInputs({ outputDir: goldenDir, dataDir: inputDataDir }), summaryNow);
  const summary = buildSummary(await readSummaryInputs(goldenDir), index, summaryNow);

  const health = await readJson<HealthSnapshot>(path.join(goldenDir, 'health.json'));
  const context = buildContext(
    {
      summary,
      registration: (await readSummaryInputs(goldenDir)).registration,
      academicCalendar: await readJson<AcademicCalendar>(path.join(goldenDir, 'academic-calendar.json')),
      academicSchedule: (await readSummaryInputs(goldenDir)).academicSchedule,
      gradingRules: await readJson<GradingRulesFile>(path.join(inputDataDir, 'grading-rules.json')),
      courseIndex: index,
      healthWarnings: healthWarnings(health, contextNow),
    },
    { maxAgeMinutes: defaultMaxAgeMinutes, horizonDays: defaultHorizonDays },
    contextNow
  );

  await fs.mkdir(outDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(outDir, 'course-index.json'), JSON.stringify(index, null, 2), 'utf8'),
    fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8'),
    fs.writeFile(path.join(outDir, 'agent-context.json'), JSON.stringify(context, null, 2), 'utf8'),
    fs.writeFile(path.join(outDir, 'agent-context.md'), buildMarkdown(context), 'utf8'),
  ]);
  console.log(`wrote ${outDir}: summary(now=${summaryNow.toISOString()}) context(now=${contextNow.toISOString()})`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
