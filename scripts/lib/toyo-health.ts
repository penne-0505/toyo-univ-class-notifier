import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repoRoot } from './toyo-env';
import { putFileToApi } from './toyo-api';
import { notify, redactSensitive, type NotifyResult } from './toyo-notify';

const execFileAsync = promisify(execFile);

/**
 * 定期ジョブ（systemd タイマー）の成否を記録し、失敗が続いたら通知する。
 * 状態は state/health.json（正本）、公開用の写しは output/toyo/health.json。
 * 目的の違いにより toyo-watch.ts 独自の state/watch-state.json（バックオフ用）とは別に持つ。
 */

export const JOB_NAMES = ['watch', 'coursework', 'daily'] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** 連続失敗がこの回数に達したらアラートを 1 回送る。 */
export const ALERT_THRESHOLDS: Record<JobName, number> = { watch: 3, coursework: 2, daily: 1 };
/** アラート中のまま失敗が続くとき、この間隔で再通知する。 */
export const REALERT_AFTER_MS = 6 * 3600_000;
/** lastSuccessAt がこれより古ければ「古い」とみなす（toyo:context の警告用）。 */
export const STALE_AFTER_MS: Record<JobName, number> = {
  watch: 30 * 60_000,
  coursework: 3 * 3600_000,
  daily: 30 * 3600_000,
};

const LAST_ERROR_MAX = 500;
const JOURNAL_TAIL_LINES = 80;
const ERROR_LINE_PATTERN = /error|timeout|failed|econn|exception|exceeded/i;
// 成功時にも出る「0 件」系の行（failed:0 / errors: 0 など）は拾わない
const BENIGN_LINE_PATTERN = /(?:failed|errors?)\s*[:=]\s*0\b|\b0\s+(?:failed|errors?)\b|triggerUncaughtException/i;
// systemd 自身の行（Main process exited ... など）は原因の手掛かりにならない
const SYSTEMD_LINE_PATTERN = /^\S+\.service: |^Failed to start /;

export type JobHealth = {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  alerting: boolean;
  alertedAt: string | null;
  /** 現在の失敗の連なりが始まった時刻（回復通知の「約 N 時間」の計算用）。 */
  failingSince: string | null;
};

export type HealthState = { jobs: Record<JobName, JobHealth> };
export type HealthSnapshot = { generatedAt: string; jobs: Record<JobName, JobHealth>; alerting: JobName[] };

export const healthStatePath = path.join(repoRoot, 'state', 'health.json');
export const healthSnapshotPath = path.join(repoRoot, 'output', 'toyo', 'health.json');
export const healthSnapshotRel = 'output/toyo/health.json';
const lockPath = path.join(repoRoot, 'state', 'health.lock');

export function isJobName(value: string): value is JobName {
  return (JOB_NAMES as readonly string[]).includes(value);
}

function emptyJob(): JobHealth {
  return {
    lastRunAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    lastError: null,
    alerting: false,
    alertedAt: null,
    failingSince: null,
  };
}

function normalizeJobs(raw: unknown): Record<JobName, JobHealth> {
  const source = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) as Record<string, Partial<JobHealth>>;
  const jobs = {} as Record<JobName, JobHealth>;
  for (const name of JOB_NAMES) jobs[name] = { ...emptyJob(), ...(source[name] ?? {}) };
  return jobs;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function loadHealthState(): Promise<HealthState> {
  const raw = (await readJson(healthStatePath)) as { jobs?: unknown } | null;
  return { jobs: normalizeJobs(raw?.jobs) };
}

/** output/toyo/health.json を読む。無い・壊れているときは null。 */
export async function loadHealthSnapshot(file = healthSnapshotPath): Promise<HealthSnapshot | null> {
  const raw = (await readJson(file)) as Partial<HealthSnapshot> | null;
  if (!raw || typeof raw !== 'object' || !raw.jobs) return null;
  const jobs = normalizeJobs(raw.jobs);
  return {
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    jobs,
    alerting: JOB_NAMES.filter((name) => jobs[name].alerting),
  };
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
}

function buildSnapshot(state: HealthState, now: Date): HealthSnapshot {
  const jobs = normalizeJobs(state.jobs);
  for (const name of JOB_NAMES) jobs[name].lastError = jobs[name].lastError ? redactSensitive(jobs[name].lastError) : null;
  return { generatedAt: now.toISOString(), jobs, alerting: JOB_NAMES.filter((name) => jobs[name].alerting) };
}

/** 別ジョブの ExecStopPost が同時に走っても state を壊さないための簡易ロック。 */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) await fs.rm(lockPath, { force: true });
      } catch {
        /* 直前に解放された */
      }
      if (Date.now() > deadline) throw new Error('health state lock timed out');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}

// ---------- エラー文の取得・整形 ----------

function cleanErrorText(text: string): string {
  const home = os.homedir();
  const cleaned = redactSensitive(text)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(repoRoot)
    .join('.')
    .split(home)
    .join('~')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length <= LAST_ERROR_MAX ? cleaned : `${cleaned.slice(0, LAST_ERROR_MAX - 1)}…`;
}

/** journal の出力からエラーらしき行の最後の 3 行を取り出す（純粋関数。テストしやすいよう分離）。 */
export function pickErrorLines(journalText: string): string | null {
  const matched = journalText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && ERROR_LINE_PATTERN.test(line) && !BENIGN_LINE_PATTERN.test(line) && !SYSTEMD_LINE_PATTERN.test(line));
  if (matched.length === 0) return null;
  return matched.slice(-3).join(' / ');
}

async function journalTail(job: JobName): Promise<string> {
  const base = ['--user', '-u', `toyo-${job}.service`, '-n', String(JOURNAL_TAIL_LINES), '-o', 'cat', '--no-pager'];
  // ExecStopPost の中なら、今回の実行（invocation）の出力だけに絞る。前回までのエラーを拾わないため。
  const invocation = process.env.INVOCATION_ID;
  const attempts = invocation ? [[...base, `_SYSTEMD_INVOCATION_ID=${invocation}`], base] : [base];
  for (const args of attempts) {
    try {
      const { stdout } = await execFileAsync('journalctl', args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
      if (stdout.trim() !== '') return stdout;
    } catch {
      /* 次の候補へ */
    }
  }
  return '';
}

async function resolveError(job: JobName, explicit: string | undefined): Promise<string> {
  if (explicit !== undefined && explicit.trim() !== '') return cleanErrorText(explicit);
  const picked = pickErrorLines(await journalTail(job));
  return picked ? cleanErrorText(picked) : '(エラー行を取得できませんでした)';
}

// ---------- 通知本文 ----------

const IMPACT: Record<JobName, string> = {
  watch: '課題・お知らせの更新が止まっている可能性があります。',
  coursework: 'データの今日・明日・提出状況が古い可能性があります。',
  daily: '日次の全取得（履修・単位・抽選結果）が止まっている可能性があります。',
};

function jstParts(date: Date): { ymd: string; md: string; hm: string } {
  const iso = new Date(date.getTime() + 9 * 3600_000).toISOString();
  return { ymd: iso.slice(0, 10), md: iso.slice(5, 10).replace('-', '/'), hm: iso.slice(11, 16) };
}

/** 同じ日なら HH:mm、違う日なら MM/DD HH:mm（JST）。 */
export function formatShortJst(iso: string | null, now: Date): string {
  if (!iso) return '記録なし';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '記録なし';
  const t = jstParts(date);
  return t.ymd === jstParts(now).ymd ? t.hm : `${t.md} ${t.hm}`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 90) return `約 ${Math.max(1, minutes)} 分`;
  return `約 ${Math.round(minutes / 60)} 時間`;
}

function alertMessage(job: JobName, health: JobHealth, now: Date, repeated: boolean) {
  const since = formatShortJst(health.failingSince, now);
  const head = repeated
    ? `toyo-${job} が引き続き失敗中（${health.consecutiveFailures} 回連続、${since} から。最終成功 ${formatShortJst(health.lastSuccessAt, now)}）`
    : `toyo-${job} が ${health.consecutiveFailures} 回連続で失敗（最終成功 ${formatShortJst(health.lastSuccessAt, now)}）`;
  return {
    level: 'alert' as const,
    title: repeated ? `toyo-${job} が失敗中（継続）` : `toyo-${job} が失敗中`,
    body: `${head}。直近のエラー: ${health.lastError ?? '不明'}。${IMPACT[job]}`,
  };
}

function recoveryMessage(job: JobName, failures: number, durationMs: number | null) {
  const duration = durationMs === null ? '' : `、${formatDuration(durationMs)}`;
  return {
    level: 'recovered' as const,
    title: `toyo-${job} が回復`,
    body: `toyo-${job} が回復（失敗 ${failures} 回${duration}）`,
  };
}

// ---------- 記録 ----------

export type Transition = 'alert' | 'realert' | 'recovered' | null;
export type RecordOutcome = {
  job: JobName;
  result: 'success' | 'failure';
  transition: Transition;
  health: JobHealth;
  notified: NotifyResult | null;
};

export async function recordResult(
  job: JobName,
  result: 'success' | 'failure',
  options: { error?: string; now?: Date } = {}
): Promise<RecordOutcome> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  // journalctl の実行はロックの外で済ませる（ロック保持時間を短くする）
  const error = result === 'failure' ? await resolveError(job, options.error) : null;

  let message: ReturnType<typeof alertMessage> | ReturnType<typeof recoveryMessage> | null = null;
  let transition: Transition = null;
  let snapshot!: HealthSnapshot;
  let health!: JobHealth;

  await withLock(async () => {
    const state = await loadHealthState();
    const job_ = state.jobs[job];
    job_.lastRunAt = nowIso;

    if (result === 'success') {
      const wasAlerting = job_.alerting;
      const failures = job_.consecutiveFailures;
      const failingSince = job_.failingSince ? Date.parse(job_.failingSince) : NaN;
      job_.lastSuccessAt = nowIso;
      job_.consecutiveFailures = 0;
      job_.alerting = false;
      job_.alertedAt = null;
      job_.failingSince = null;
      if (wasAlerting) {
        transition = 'recovered';
        message = recoveryMessage(job, failures, Number.isNaN(failingSince) ? null : now.getTime() - failingSince);
      }
    } else {
      job_.consecutiveFailures += 1;
      job_.lastFailureAt = nowIso;
      job_.lastError = error;
      if (!job_.failingSince) job_.failingSince = nowIso;
      if (!job_.alerting && job_.consecutiveFailures >= ALERT_THRESHOLDS[job]) {
        job_.alerting = true;
        job_.alertedAt = nowIso;
        transition = 'alert';
        message = alertMessage(job, job_, now, false);
      } else if (job_.alerting) {
        const alertedAt = job_.alertedAt ? Date.parse(job_.alertedAt) : NaN;
        if (Number.isNaN(alertedAt) || now.getTime() - alertedAt >= REALERT_AFTER_MS) {
          job_.alertedAt = nowIso;
          transition = 'realert';
          message = alertMessage(job, job_, now, true);
        }
      }
    }

    snapshot = buildSnapshot(state, now);
    health = job_;
    await writeJsonAtomic(healthStatePath, state);
    await writeJsonAtomic(healthSnapshotPath, snapshot);
  });

  let notified: NotifyResult | null = null;
  if (message) {
    notified = await notify(message);
    // 遷移があったときだけ Worker へ直接送る（GitHub は次の publish に任せる）。失敗は無視。
    await putFileToApi(healthSnapshotRel, Buffer.from(JSON.stringify(snapshot, null, 2) + '\n', 'utf8'));
  }
  return { job, result, transition, health, notified };
}

// ---------- 表示・警告 ----------

export function describeJobLine(job: JobName, health: JobHealth, now: Date): string {
  const stale = isStale(job, health, now);
  const mark = health.alerting ? 'ALERT' : stale ? 'STALE' : 'ok';
  const parts = [
    `[${mark.padEnd(5)}] ${job.padEnd(10)}`,
    `最終成功 ${formatShortJst(health.lastSuccessAt, now)}`,
    `最終実行 ${formatShortJst(health.lastRunAt, now)}`,
    `連続失敗 ${health.consecutiveFailures}/${ALERT_THRESHOLDS[job]}`,
  ];
  if (health.alerting) parts.push(`通知済み ${formatShortJst(health.alertedAt, now)}`);
  if (health.consecutiveFailures > 0 && health.lastError) parts.push(`エラー: ${health.lastError}`);
  return parts.join(' | ');
}

function isStale(job: JobName, health: JobHealth, now: Date): boolean {
  if (!health.lastSuccessAt) return false; // 記録が無いものは「不明」であって「古い」とは言わない
  const last = Date.parse(health.lastSuccessAt);
  return !Number.isNaN(last) && now.getTime() - last > STALE_AFTER_MS[job];
}

/** toyo:context の Warnings 用。alerting 中、または lastSuccessAt が閾値より古いジョブを列挙する。 */
export function healthWarnings(snapshot: HealthSnapshot | null, now: Date): string[] {
  if (!snapshot) return [];
  const warnings: string[] = [];
  for (const job of JOB_NAMES) {
    const health = snapshot.jobs[job];
    if (health.alerting) {
      const since = formatShortJstDate(health.failingSince ?? health.lastFailureAt);
      warnings.push(`toyo-${job} が${since ? ` ${since} から` : ''}失敗中（連続 ${health.consecutiveFailures} 回）。${IMPACT_SHORT[job]}`);
    } else if (isStale(job, health, now)) {
      const minutes = Math.round((now.getTime() - Date.parse(health.lastSuccessAt as string)) / 60_000);
      warnings.push(
        `toyo-${job} の最終成功が ${formatShortJstDate(health.lastSuccessAt)}（${minutes} 分前）で、目安の ${Math.round(STALE_AFTER_MS[job] / 60_000)} 分を超えています。${IMPACT_SHORT[job]}`
      );
    }
  }
  return warnings;
}

const IMPACT_SHORT: Record<JobName, string> = {
  watch: '課題・お知らせが古い可能性',
  coursework: '今日・明日・提出状況が古い可能性',
  daily: '日次の全取得（履修・単位・抽選結果）が古い可能性',
};

/** `YYYY-MM-DD HH:mm`（JST）。 */
function formatShortJstDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}
