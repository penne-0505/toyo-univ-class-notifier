import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WARNING_NO_SYLLABUS, type CourseIndex } from '../build/course-index';
import { courseIndexOutputPath } from './build-index';
import { repoRoot } from '../lib/toyo-paths';
import { formatJst } from '../lib/toyo-normalize';

/**
 * 24 時間に 1 回の全取得 → 組み立て → 全 publish。各段は別プロセスで実行し、失敗しても続行して最後にまとめて報告する。
 * publish は --force 付き: 内容が同じでも meta.json(publishedAt) を毎日コミットし、
 * クラウド側が「最後に生きていた時刻」を判断できるようにする。
 *
 * 流れ: 取得（提出状況・履修/課題/コンテンツ/お知らせ/祝日・単位・抽選）→ index → シラバス補完 → toyo:build → publish。
 *
 * 失敗の線引き: 取得段と build / publish の失敗は daily の失敗（終了コード 1、toyo:health の通知対象）。
 * シラバス補完の段は「データの欠けを埋める試み」なので、失敗しても警告として記録するだけで daily は成功扱い（終了コード 0）。
 * 埋まらなかった欠けは index と agent-context の Warnings に残る。
 * 補完は index の欠け（今学期なのにシラバスが無い科目）だけが対象: pool から seed → まだ欠けていれば時間割検索（ブラウザ）。
 */

type Stage = {
  name: string;
  script: string;
  args: string[];
  /** この終了コードは失敗として扱わない（lottery の期間外など） */
  okCodes: number[];
};

/** 取得段。coursework と sync は build を省く（最後にまとめて build する）。 */
const fetchStages: Stage[] = [
  { name: 'toyo:coursework', script: 'toyo-fetch-coursework.ts', args: ['--no-build'], okCodes: [0] },
  { name: 'toyo:sync', script: 'toyo-sync.ts', args: ['--no-build'], okCodes: [0] },
  { name: 'toyo:credits', script: 'toyo-fetch-credits.ts', args: [], okCodes: [0] },
  { name: 'toyo:lottery', script: 'toyo-fetch-lottery.ts', args: [], okCodes: [0, 1] },
];

const finalStages: Stage[] = [
  { name: 'toyo:build', script: 'toyo-build.ts', args: [], okCodes: [0] },
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
  const warnings: string[] = [];
  let failed = 0;

  /** 1 段を実行して結果を記録する。失敗しても続行する。soft な段の失敗は警告にとどめる。 */
  const execute = async (stage: Stage, options: { soft?: boolean } = {}): Promise<boolean> => {
    const t0 = Date.now();
    console.log(`[daily] ${formatJst()} JST start ${stage.name}`);
    const code = await run(stage);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    const ok = stage.okCodes.includes(code);
    if (!ok && options.soft) {
      warnings.push(`${stage.name} (exit ${code})`);
      results.push(`${stage.name}=WARN(exit ${code}) ${sec}s`);
      return false;
    }
    if (!ok) failed += 1;
    results.push(`${stage.name}=${ok ? (code === 0 ? 'ok' : `ok(exit ${code} ignored)`) : `FAILED(exit ${code})`} ${sec}s`);
    return ok;
  };

  for (const stage of fetchStages) await execute(stage);

  // シラバス補完（soft）: index で欠けを見つけ、seed（pool、ブラウザ不要）→ 時間割検索（ブラウザ）→ index を作り直す
  await execute(buildIndexStage(), { soft: true });
  let missing = (await coursesMissingSyllabus()) ?? [];
  if (missing.length > 0) {
    console.log(`[daily] syllabus missing for ${missing.length} course(s): ${missing.join(', ')}`);
    await execute(
      {
        name: 'toyo:syllabus:seed',
        script: 'toyo-seed-syllabus.ts',
        args: missing.flatMap((code) => ['--course-code', code]),
        okCodes: [0],
      },
      { soft: true }
    );
    await execute(buildIndexStage(' (after seed)'), { soft: true });
    missing = (await coursesMissingSyllabus()) ?? missing;
    for (const code of missing) {
      await execute({ name: `toyo:syllabus ${code}`, script: 'toyo-fetch-syllabus.ts', args: ['--course-code', code], okCodes: [0] }, { soft: true });
    }
    if (missing.length > 0) await execute(buildIndexStage(' (after syllabus)'), { soft: true });
  }
  if (warnings.length > 0) {
    // 失敗にはしない。埋まらなかった欠けは index / agent-context の Warnings に残る
    console.warn(`[daily] WARN syllabus completion had failures (daily continues): ${warnings.join(', ')}`);
  }

  for (const stage of finalStages) await execute(stage);

  console.log(`[daily] ${formatJst()} JST done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${results.join(', ')}`);
  if (failed > 0) process.exitCode = 1;
}
