#!/usr/bin/env node

/**
 * 一度だけ実行する移行スクリプト。
 * 2026-09-28 に取得した正規登録期間の候補ファイル（シラバス本文入り・約 146 科目）は、追加登録期間の取得で
 * output/toyo/registration-candidates.json が上書きされて失われた。toyo-data の git 履歴に残っているので、
 * そこから syllabus-pool/<授業コード>.json と registration-candidates.regular.json を作る。
 * 既にあるファイルは上書きしない（--refresh-pool で pool を上書き）。ブラウザもネットワークも使わない。
 *
 * Usage:
 *   npx tsx scripts/dev/seed-syllabus-pool.ts [--commit 05db6bd] [--refresh-pool]
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { saveCandidatesToPool, syllabusPoolDir, type PoolCandidate } from '../lib/syllabus-pool';
import { outputDir } from '../lib/toyo-paths';

const execFileAsync = promisify(execFile);
const DEFAULT_COMMIT = '05db6bd';
const CANDIDATES_REL = 'output/toyo/registration-candidates.json';

type CandidatesFile = {
  fetchedAt: string;
  academicYear: string | null;
  period?: 'regular' | 'add';
  candidates: PoolCandidate[];
  [key: string]: unknown;
};

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const commitIndex = argv.indexOf('--commit');
  const commit = commitIndex >= 0 && argv[commitIndex + 1] ? argv[commitIndex + 1] : DEFAULT_COMMIT;
  const refresh = argv.includes('--refresh-pool');
  const dataRepoDir = process.env.TOYO_DATA_DIR || path.join(os.homedir(), 'toyo-data');

  const { stdout } = await execFileAsync('git', ['-C', dataRepoDir, 'show', `${commit}:${CANDIDATES_REL}`], {
    maxBuffer: 256 * 1024 * 1024,
  });
  const file = JSON.parse(stdout) as CandidatesFile;
  const withSyllabus = file.candidates.filter((c) => c.syllabus?.courseCode).length;
  console.log(`source: ${dataRepoDir} ${commit}:${CANDIDATES_REL} fetchedAt=${file.fetchedAt} candidates=${file.candidates.length} withSyllabus=${withSyllabus}`);

  // この時点の取得は期間指定なしの旧形式（正規登録期間の画面）。period が無ければ regular とみなす
  const period = file.period ?? 'regular';
  const pool = await saveCandidatesToPool({ ...file, period }, { refresh });
  console.log(`syllabus-pool: written=${pool.written} kept(existing)=${pool.kept} dir=${syllabusPoolDir}`);

  const regularPath = path.join(outputDir, 'registration-candidates.regular.json');
  try {
    await fs.access(regularPath);
    console.log(`kept existing ${regularPath}`);
  } catch {
    await fs.writeFile(regularPath, `${JSON.stringify({ ...file, period }, null, 2)}\n`, 'utf8');
    console.log(`wrote ${regularPath}`);
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
