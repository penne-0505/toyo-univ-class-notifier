#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WARNING_NO_SYLLABUS, type CourseIndex } from './build/course-index';
import { courseIndexOutputPath } from './toyo-build-index';
import { repoRoot } from './lib/toyo-paths';
import { formatJst } from './lib/toyo-normalize';

/**
 * 24 時間に 1 回の全取得 → 全 publish。各段は別プロセスで実行し、失敗しても続行して最後にまとめて報告する。
 * publish は --force 付き: 内容が同じでも meta.json(publishedAt) を毎日コミットし、
 * クラウド側が「最後に生きていた時刻」を判断できるようにする。
 *
 * 全取得のあと、course-index.json で「今学期なのにシラバスが無い科目」を見つけて自動で補完する
 * （登録科目を追加した翌朝に埋まる）: pool から seed → まだ欠けていれば時間割検索（ブラウザ）で取得。
 */

type Stage = {
  name: string;
  script: string;
  args: string[];
  /** この終了コードは失敗として扱わない（lottery の期間外など） */
  okCodes: number[];
};

/** 取得 → (index とシラバス補完) → context → publish の順に実行する。補完は stagesAfterFetch と stagesBeforePublish の間。 */
const stagesAfterFetch: Stage[] = [
  // sync が summary を組み立てる前に coursework を更新しておく（summary に取り込まれる）
  { name: 'toyo:coursework', script: 'toyo-fetch-coursework.ts', args: ['--no-summary'], okCodes: [0] },
  { name: 'toyo:sync', script: 'toyo-sync.ts', args: [], okCodes: [0] },
  { name: 'toyo:credits', script: 'toyo-fetch-credits.ts', args: [], okCodes: [0] },
  { name: 'toyo:lottery', script: 'toyo-fetch-lottery.ts', args: [], okCodes: [0, 1] },
];

const stagesBeforePublish: Stage[] = [
  { name: 'toyo:context', script: 'toyo-context.ts', args: ['--no-sync'], okCodes: [0] },
  {
    name: 'toyo:publish',
    script: 'toyo-publish.ts',
    args: ['--include-candidates', '--force'],
    okCodes: [0],
  },
];

const buildIndexStage = (suffix = ''): Stage => ({ name: `toyo:build:index${suffix}`, script: 'toyo-build-index.ts', args: [], okCodes: [0] });

function run(stage: Stage): Promise<number> {
  return new Promise((resolve) => {
    const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
    const child = spawn(tsx, [path.join(repoRoot, 'scripts', stage.script), ...stage.args], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    child.on('error', (error) => {
      console.error(`[daily] ${stage.name} spawn error: ${error.message}`);
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
}

/** index で「今学期の科目なのにシラバスが無い」授業コード。index が読めなければ null。 */
async function coursesMissingSyllabus(): Promise<string[] | null> {
  try {
    const index = JSON.parse(await fs.readFile(courseIndexOutputPath, 'utf8')) as CourseIndex;
    return index.courses.filter((c) => c.warnings.includes(WARNING_NO_SYLLABUS)).map((c) => c.courseCode);
  } catch {
    return null;
  }
}

export async function main(): Promise<void> {
  const started = Date.now();
  const results: string[] = [];
  let failed = 0;

  /** 1 段を実行して結果を記録する。失敗しても続行する。 */
  const execute = async (stage: Stage): Promise<boolean> => {
    const t0 = Date.now();
    console.log(`[daily] ${formatJst()} JST start ${stage.name}`);
    const code = await run(stage);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    const ok = stage.okCodes.includes(code);
    if (!ok) failed += 1;
    results.push(`${stage.name}=${ok ? (code === 0 ? 'ok' : `ok(exit ${code} ignored)`) : `FAILED(exit ${code})`} ${sec}s`);
    return ok;
  };

  for (const stage of stagesAfterFetch) await execute(stage);

  // index で欠けているシラバスの補完: seed（pool、ブラウザ不要）→ 時間割検索（ブラウザ）→ index を作り直す
  await execute(buildIndexStage());
  let missing = (await coursesMissingSyllabus()) ?? [];
  if (missing.length > 0) {
    console.log(`[daily] syllabus missing for ${missing.length} course(s): ${missing.join(', ')}`);
    await execute({
      name: 'toyo:syllabus:seed',
      script: 'toyo-seed-syllabus.ts',
      args: missing.flatMap((code) => ['--course-code', code]),
      okCodes: [0],
    });
    await execute(buildIndexStage(' (after seed)'));
    missing = (await coursesMissingSyllabus()) ?? missing;
    for (const code of missing) {
      await execute({ name: `toyo:syllabus ${code}`, script: 'toyo-fetch-syllabus.ts', args: ['--course-code', code], okCodes: [0] });
    }
    if (missing.length > 0) await execute(buildIndexStage(' (after syllabus)'));
  }

  for (const stage of stagesBeforePublish) await execute(stage);

  console.log(`[daily] ${formatJst()} JST done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${results.join(', ')}`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
