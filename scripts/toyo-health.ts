#!/usr/bin/env node

import {
  ALERT_THRESHOLDS,
  JOB_NAMES,
  describeJobLine,
  isJobName,
  loadHealthState,
  recordResult,
} from './lib/toyo-health';
import { notify } from './lib/toyo-notify';

/**
 * 定期ジョブの失敗検知と通知。
 *   npm run toyo:health -- record <watch|coursework|daily> <success|failure> [--error <text>]
 *   npm run toyo:health -- status
 *   npm run toyo:health -- test-notify
 * systemd の ExecStopPost（deploy/toyo-health-hook.sh）から record が呼ばれる。
 */

function usage(): string {
  return [
    'Usage:',
    `  npm run toyo:health -- record <${JOB_NAMES.join('|')}> <success|failure> [--error <text>]`,
    '  npm run toyo:health -- status        全ジョブの状態を表示（アラート中のジョブがあれば終了コード 1）',
    '  npm run toyo:health -- test-notify   テスト通知を 1 回送る',
    '',
    `連続失敗でアラートする閾値: ${JOB_NAMES.map((name) => `${name}=${ALERT_THRESHOLDS[name]}`).join(', ')}`,
  ].join('\n');
}

function fail(message: string): never {
  console.error(`${message}\n\n${usage()}`);
  process.exit(2);
}

async function runRecord(args: string[]): Promise<void> {
  const [job, result, ...rest] = args;
  if (!job || !isJobName(job)) fail(`job は ${JOB_NAMES.join(' / ')} のいずれかを指定してください: ${job ?? '(なし)'}`);
  if (result !== 'success' && result !== 'failure') fail(`結果は success か failure です: ${result ?? '(なし)'}`);

  let error: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--error') {
      const value = rest[index + 1];
      if (value === undefined) fail('--error には文字列が必要です');
      error = value;
      index += 1;
    } else {
      fail(`不明なオプション: ${rest[index]}`);
    }
  }

  const outcome = await recordResult(job, result, { error });
  const parts = [`[health] ${job} ${result}`, `consecutiveFailures=${outcome.health.consecutiveFailures}`];
  if (outcome.transition) {
    parts.push(`transition=${outcome.transition}`);
    if (outcome.notified) parts.push(`notified=${outcome.notified.delivered.join(',')}`);
  }
  console.log(parts.join(' '));
}

async function runStatus(): Promise<void> {
  const state = await loadHealthState();
  const now = new Date();
  let alerting = 0;
  for (const job of JOB_NAMES) {
    console.log(describeJobLine(job, state.jobs[job], now));
    if (state.jobs[job].alerting) alerting += 1;
  }
  if (alerting > 0) process.exitCode = 1;
}

async function runTestNotify(): Promise<void> {
  const result = await notify({
    level: 'info',
    title: 'toyo:health のテスト通知',
    body: 'これはテスト通知です。この通知が届いていれば、失敗時のアラートも同じ送り先に届きます。',
  });
  console.log(`[health] test-notify delivered=${result.delivered.join(',') || '-'} failed=${result.failed.join(',') || '-'}`);
  if (result.failed.length > 0) process.exitCode = 1;
}

export async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'record':
      return runRecord(args);
    case 'status':
      return runStatus();
    case 'test-notify':
      return runTestNotify();
    case '--help':
    case '-h':
      console.log(usage());
      return;
    default:
      fail(`不明なコマンド: ${command ?? '(なし)'}`);
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
