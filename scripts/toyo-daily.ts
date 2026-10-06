#!/usr/bin/env node

import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './lib/toyo-enrollment';
import { formatJst } from './lib/toyo-normalize';

/**
 * 24 時間に 1 回の全取得 → 全 publish。各段は別プロセスで実行し、失敗しても続行して最後にまとめて報告する。
 * publish は --force 付き: 内容が同じでも meta.json(publishedAt) を毎日コミットし、
 * クラウド側が「最後に生きていた時刻」を判断できるようにする。
 */

type Stage = {
  name: string;
  script: string;
  args: string[];
  /** この終了コードは失敗として扱わない（lottery の期間外など） */
  okCodes: number[];
};

const stages: Stage[] = [
  { name: 'toyo:sync', script: 'toyo-sync.ts', args: [], okCodes: [0] },
  { name: 'toyo:credits', script: 'toyo-fetch-credits.ts', args: [], okCodes: [0] },
  { name: 'toyo:lottery', script: 'toyo-fetch-lottery.ts', args: [], okCodes: [0, 1] },
  { name: 'toyo:context', script: 'toyo-context.ts', args: ['--no-sync'], okCodes: [0] },
  {
    name: 'toyo:publish',
    script: 'toyo-publish.ts',
    args: ['--include-candidates', '--force'],
    okCodes: [0],
  },
];

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

export async function main(): Promise<void> {
  const started = Date.now();
  const results: string[] = [];
  let failed = 0;

  for (const stage of stages) {
    const t0 = Date.now();
    console.log(`[daily] ${formatJst()} JST start ${stage.name}`);
    const code = await run(stage);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    const ok = stage.okCodes.includes(code);
    if (!ok) failed += 1;
    results.push(`${stage.name}=${ok ? (code === 0 ? 'ok' : `ok(exit ${code} ignored)`) : `FAILED(exit ${code})`} ${sec}s`);
  }

  console.log(`[daily] ${formatJst()} JST done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${results.join(', ')}`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
