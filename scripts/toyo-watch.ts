#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { jsonOutputPath, repoRoot, type EnrollmentData } from './lib/toyo-enrollment';
import {
  collectToyoNetAceAssignments,
  toyoNetAceAssignmentsOutputPath,
  toyoNetAceContentsOutputPath,
  type CourseContentCollectionResult,
} from './lib/toyonet-ace';
import { announcementsOutputPath, collectToyoNetAceAnnouncements } from './lib/toyo-announcements';
import { buildDiscordSummary, writeDiscordSummary } from './lib/toyo-summary';
import { formatJst, normalizedHash } from './lib/toyo-normalize';
import { publish } from './toyo-publish';

/**
 * ACE の未提出課題とリマインダだけを取得し、変化があるときだけ
 * summary / agent-context を再生成して publish する（5 分間隔の systemd timer 用）。
 */

const statePath = path.join(repoRoot, 'state', 'watch-state.json');
const FIFTEEN_MIN = 15 * 60_000;
const THIRTY_MIN = 30 * 60_000;

type WatchState = {
  consecutiveFailures: number;
  nextAllowedAt: string | null;
  /** 変化検知後に summary 再生成〜publish が完了していない場合 true（失敗リトライ用） */
  pendingPublish: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastChangeAt: string | null;
  lastError: string | null;
};

const emptyState: WatchState = {
  consecutiveFailures: 0,
  nextAllowedAt: null,
  pendingPublish: false,
  lastRunAt: null,
  lastSuccessAt: null,
  lastChangeAt: null,
  lastError: null,
};

async function readState(): Promise<WatchState> {
  try {
    return { ...emptyState, ...(JSON.parse(await fs.readFile(statePath, 'utf8')) as Partial<WatchState>) };
  } catch {
    return { ...emptyState };
  }
}

async function writeState(state: WatchState): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function backoffMs(failures: number): number {
  if (failures >= 4) return THIRTY_MIN;
  if (failures >= 2) return FIFTEEN_MIN;
  return 0;
}

async function readBuf(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

function sameContent(file: string, a: Buffer | null, b: Buffer | null): boolean {
  if (!a || !b) return a === b;
  return normalizedHash(path.basename(file), a) === normalizedHash(path.basename(file), b);
}

function runContext(): Promise<void> {
  return new Promise((resolve, reject) => {
    const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
    const child = spawn(tsx, [path.join(repoRoot, 'scripts', 'toyo-context.ts'), '--no-sync'], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`toyo:context --no-sync exited with ${code}`))
    );
  });
}

type Outcome = { changed: boolean; committed: boolean };

async function runOnce(state: WatchState): Promise<Outcome> {
  const prevAssignments = await readBuf(toyoNetAceAssignmentsOutputPath);
  const prevAnnouncements = await readBuf(announcementsOutputPath);

  // Playwright セッションは同時に 1 つなので直列に取得する
  const assignments = await collectToyoNetAceAssignments();
  if (!assignments.available) {
    throw new Error(assignments.errors.join(' | ') || 'assignments unavailable');
  }
  const announcements = await collectToyoNetAceAnnouncements();
  if (!announcements.available || announcements.errors.length > 0) {
    // collect 側は失敗時に空結果で上書きするので、前回の内容へ戻す
    if (prevAnnouncements) await fs.writeFile(announcementsOutputPath, prevAnnouncements);
    throw new Error(announcements.errors.join(' | ') || 'announcements unavailable');
  }

  const changed =
    !sameContent(toyoNetAceAssignmentsOutputPath, prevAssignments, await readBuf(toyoNetAceAssignmentsOutputPath)) ||
    !sameContent(announcementsOutputPath, prevAnnouncements, await readBuf(announcementsOutputPath));

  if (changed) state.pendingPublish = true;
  if (!state.pendingPublish) return { changed: false, committed: false };

  const enrollmentBuf = await readBuf(jsonOutputPath);
  if (!enrollmentBuf) throw new Error('registration-data.json がありません。先に toyo:sync を実行してください。');
  const enrollment = JSON.parse(enrollmentBuf.toString('utf8')) as EnrollmentData;

  const contentsBuf = await readBuf(toyoNetAceContentsOutputPath);
  const contents: CourseContentCollectionResult = contentsBuf
    ? (JSON.parse(contentsBuf.toString('utf8')) as CourseContentCollectionResult)
    : {
        fetchedAt: new Date().toISOString(),
        source: 'toyonet-ace',
        available: false,
        contents: [],
        errors: ['toyonet-ace-contents.json が存在しません（toyo:daily で取得されます）'],
      };

  const summary = await buildDiscordSummary(enrollment, { assignments, contents, announcements });
  await writeDiscordSummary(summary);
  await runContext();
  const result = await publish({ dryRun: false, includeCandidates: false, force: false });

  state.pendingPublish = false;
  state.lastChangeAt = new Date().toISOString();
  return { changed: true, committed: result.committed };
}

export async function main(): Promise<void> {
  const started = Date.now();
  const stamp = () => `${formatJst(new Date())} JST`;
  const state = await readState();

  if (state.nextAllowedAt && Date.parse(state.nextAllowedAt) > started) {
    console.log(
      `[watch] ${stamp()} skipped (backoff until ${formatJst(new Date(state.nextAllowedAt))} JST, failures=${state.consecutiveFailures})`
    );
    return;
  }

  try {
    const outcome = await runOnce(state);
    state.consecutiveFailures = 0;
    state.nextAllowedAt = null;
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    state.lastRunAt = new Date().toISOString();
    await writeState(state);
    console.log(
      `[watch] ${stamp()} changed=${outcome.changed ? 'yes' : 'no'} committed=${outcome.committed ? 'yes' : 'no'} ${((Date.now() - started) / 1000).toFixed(1)}s`
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    state.consecutiveFailures += 1;
    const wait = backoffMs(state.consecutiveFailures);
    state.nextAllowedAt = wait > 0 ? new Date(Date.now() + wait).toISOString() : null;
    state.lastError = message.slice(0, 500);
    state.lastRunAt = new Date().toISOString();
    await writeState(state);
    console.error(
      `[watch] ${stamp()} FAILED failures=${state.consecutiveFailures}${wait ? ` backoff=${wait / 60_000}min` : ''} ${((Date.now() - started) / 1000).toFixed(1)}s: ${message}`
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
