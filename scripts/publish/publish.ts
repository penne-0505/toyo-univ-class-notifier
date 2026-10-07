import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repoRoot } from '../lib/toyo-paths';
import { extractFetchedAt, formatJst, normalizedHash } from '../lib/toyo-normalize';
import { apiConfig, apiFileUrl, apiRequest, contentTypeOf } from './toyo-api';

const execFileAsync = promisify(execFile);

export const dataRepoDir = process.env.TOYO_DATA_DIR || path.join(os.homedir(), 'toyo-data');
const dataRepoUrl = 'git@github.com-toyo-data:penne-0505/toyo-data.git';
const CANDIDATES_REL = 'output/toyo/registration-candidates.json';
const HEALTH_REL = 'output/toyo/health.json';

/**
 * 公開してよいパスは allowlist だけ。除外リストには頼らない。
 *   output/toyo/**, data/**（summary.json も output/toyo/ にある）
 * allowlist の内側でも、配信しないと決めたものは NOT_PUBLISHED_PATTERNS で明示的に弾く。
 *   - syllabus-pool/: 約 140 科目分のシラバス本文。受け手には不要（登録中の科目は syllabus/ に出る）
 *   - registration-candidates.<regular|add>.json: 期間別の候補ファイル（最新版は registration-candidates.json）
 */
const ALLOWED_PATTERNS: RegExp[] = [/^output\/toyo\/.+/, /^data\/.+/];
/**
 * 旧パス。配信はしない。toyo-data / Worker に残っていれば削除として反映するためだけに管理対象へ含める。
 *   - output/bot/summary.json: summary.json は output/toyo/ へ移した（2026-10）。2026-10 以降、旧ファイルが消えたら削除してよい。
 */
const LEGACY_PATTERNS: RegExp[] = [/^output\/bot\/summary\.json$/];
const LEGACY_PATHS = ['output/bot/summary.json'];
const NOT_PUBLISHED_PATTERNS: RegExp[] = [
  /^output\/toyo\/syllabus-pool\//,
  /^output\/toyo\/registration-candidates\.(?:regular|add)\.json$/,
];
const FORBIDDEN_SEGMENTS = /^(?:artifacts|playwright|node_modules|\.git|\.env.*)$/;

function isNotPublished(rel: string): boolean {
  return NOT_PUBLISHED_PATTERNS.some((p) => p.test(rel));
}

/** toyo-data / Worker の管理対象のパスか（削除の反映でも使う）。 */
function assertManaged(rel: string): void {
  const ok =
    (ALLOWED_PATTERNS.some((p) => p.test(rel)) || LEGACY_PATTERNS.some((p) => p.test(rel))) &&
    !rel.split('/').some((segment) => FORBIDDEN_SEGMENTS.test(segment));
  if (!ok) {
    throw new Error(`Refusing to publish path outside allowlist: ${rel}`);
  }
}

/** 配信（コピー・PUT）してよいパスか。管理対象のうち NOT_PUBLISHED でないもの。 */
function assertAllowed(rel: string): void {
  assertManaged(rel);
  if (!ALLOWED_PATTERNS.some((p) => p.test(rel)) || isNotPublished(rel)) {
    throw new Error(`Refusing to publish path excluded from publishing: ${rel}`);
  }
}

const SOURCE_COMMANDS: Array<[RegExp, string]> = [
  [/^output\/toyo\/summary\.json$/, 'toyo:build'],
  [/^output\/toyo\/registration-(?:data\.json|summary\.md)$/, 'toyo:sync'],
  [/^output\/toyo\/toyonet-ace-assignments\.json$/, 'toyo:sync | toyo:watch'],
  [/^output\/toyo\/announcements\.json$/, 'toyo:sync | toyo:watch'],
  [/^output\/toyo\/toyonet-ace-coursework\.json$/, 'toyo:coursework'],
  [/^output\/toyo\/toyonet-ace-contents\.json$/, 'toyo:sync'],
  [/^output\/toyo\/academic-calendar\.json$/, 'toyo:sync'],
  [/^output\/toyo\/credit-summary\./, 'toyo:credits'],
  [/^output\/toyo\/lottery-results\./, 'toyo:lottery'],
  [/^output\/toyo\/registration-candidates\.json$/, 'toyo:candidates'],
  [/^output\/toyo\/course-index\.json$/, 'toyo:build'],
  [/^output\/toyo\/agent-context\./, 'toyo:build'],
  [/^output\/toyo\/health\.json$/, 'toyo:health'],
  [/^output\/toyo\/syllabus\//, 'toyo:syllabus'],
  [/^data\//, 'manual (data/)'],
];

function sourceCommandFor(rel: string): string {
  return SOURCE_COMMANDS.find(([p]) => p.test(rel))?.[1] ?? 'unknown';
}

type Options = { dryRun: boolean; includeCandidates: boolean; force: boolean; pushAllApi?: boolean };

export type PublishResult = {
  changedFiles: string[];
  deletedFiles: string[];
  committed: boolean;
  pushed: boolean;
  /** Worker API への配信結果。TOYO_API_URL / TOYO_API_WRITE_KEY 未設定・dry-run のときは null。 */
  api: ApiPushResult | null;
};

export type ApiPushResult = { put: number; deleted: number; failed: number };

const API_PENDING_PATH = path.join(repoRoot, 'state', 'toyo-api-pending.json');

type ApiPending = { put: string[]; delete: string[] };

async function loadApiPending(): Promise<ApiPending> {
  try {
    const parsed = JSON.parse(await fs.readFile(API_PENDING_PATH, 'utf8')) as Partial<ApiPending>;
    return { put: parsed.put ?? [], delete: parsed.delete ?? [] };
  } catch {
    return { put: [], delete: [] };
  }
}

async function saveApiPending(pending: ApiPending): Promise<void> {
  await fs.mkdir(path.dirname(API_PENDING_PATH), { recursive: true });
  await fs.writeFile(API_PENDING_PATH, JSON.stringify(pending) + '\n', 'utf8');
}

/**
 * 変化したファイルと meta.json を Worker（toyo-data-api）へ PUT/DELETE する。
 * GitHub が正本なので、失敗してもログに出すだけで例外は投げない。
 * 失敗したパスは state/toyo-api-pending.json に残し、次回の実行で再送する。
 */
async function pushToApi(args: {
  sources: Map<string, string>;
  putPaths: string[];
  deletePaths: string[];
  meta: unknown | null;
}): Promise<ApiPushResult | null> {
  const config = apiConfig();
  if (!config) return null;
  const { baseUrl } = config;

  const pending = await loadApiPending();
  const putSet = new Set([...pending.put, ...args.putPaths]);
  const delSet = new Set([...pending.delete, ...args.deletePaths]);
  for (const rel of delSet) putSet.delete(rel);
  const result: ApiPushResult = { put: 0, deleted: 0, failed: 0 };
  const next: ApiPending = { put: [], delete: [] };

  const request = (method: string, url: string, body?: Buffer, contentType?: string): Promise<void> =>
    apiRequest(config, method, url, body, contentType);
  const urlFor = (rel: string) => apiFileUrl(baseUrl, rel);

  for (const rel of [...putSet].sort()) {
    const abs = args.sources.get(rel);
    try {
      if (!abs) continue; // 既にローカルから消えている（次回の削除で拾う）
      await request('PUT', urlFor(rel), await fs.readFile(abs), contentTypeOf(rel));
      result.put++;
    } catch (error) {
      result.failed++;
      next.put.push(rel);
      console.error(`[publish] api PUT ${rel} failed: ${(error as Error).message}`);
    }
  }
  for (const rel of [...delSet].sort()) {
    try {
      assertManaged(rel);
      await request('DELETE', urlFor(rel));
      result.deleted++;
    } catch (error) {
      result.failed++;
      next.delete.push(rel);
      console.error(`[publish] api DELETE ${rel} failed: ${(error as Error).message}`);
    }
  }
  // meta は最後（updatedAt = 最後の meta PUT）。ファイルが欠けたまま新しい publishedAt を見せないため、失敗があれば送らない。
  if (args.meta !== null && result.failed === 0) {
    try {
      await request('PUT', `${baseUrl}/v1/meta`, Buffer.from(JSON.stringify(args.meta), 'utf8'), 'application/json');
    } catch (error) {
      result.failed++;
      console.error(`[publish] api PUT meta failed: ${(error as Error).message}`);
    }
  } else if (args.meta !== null) {
    console.error('[publish] api: skipped meta PUT because some file transfers failed');
  }
  try {
    await saveApiPending(next);
  } catch (error) {
    console.error(`[publish] failed to save api pending state: ${(error as Error).message}`);
  }
  return result;
}

async function walk(absDir: string, relDir: string, out: Map<string, string>): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(absDir, entry.name);
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(abs, rel, out);
    } else if (entry.isFile()) {
      out.set(rel, abs);
    }
  }
}

async function collectSources(includeCandidates: boolean): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  await walk(path.join(repoRoot, 'output', 'toyo'), 'output/toyo', sources);
  await walk(path.join(repoRoot, 'data'), 'data', sources);
  if (!includeCandidates) sources.delete(CANDIDATES_REL);
  // 配信しないと決めたもの（syllabus-pool、期間別の候補ファイル）はここで明示的に外す
  for (const rel of [...sources.keys()]) if (isNotPublished(rel)) sources.delete(rel);
  for (const rel of sources.keys()) assertAllowed(rel);
  return sources;
}

async function git(args: string[], opts: { allowFail?: boolean } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dataRepoDir, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error: unknown) {
    if (opts.allowFail) return '';
    const e = error as { stderr?: string; message: string };
    throw new Error(`git ${args.join(' ')} failed: ${(e.stderr || e.message).trim()}`);
  }
}

async function ensureClone(): Promise<void> {
  try {
    await fs.access(path.join(dataRepoDir, '.git'));
  } catch {
    await execFileAsync('git', ['clone', dataRepoUrl, dataRepoDir]);
  }
}

async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

async function remoteMainExists(): Promise<boolean> {
  return (await git(['ls-remote', '--heads', 'origin', 'main'], { allowFail: true })) !== '';
}

async function pushWithRetry(): Promise<void> {
  try {
    await git(['push', '-u', 'origin', 'main']);
  } catch (first) {
    console.error(`[publish] push failed, retrying once: ${(first as Error).message}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await git(['push', '-u', 'origin', 'main']);
  }
}

async function hasUnpushedCommits(): Promise<boolean> {
  const hasHead = (await git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true })) !== '';
  if (!hasHead) return false;
  if (!(await git(['rev-parse', '--verify', '-q', 'origin/main'], { allowFail: true }))) return true;
  return Number(await git(['rev-list', '--count', 'origin/main..HEAD'])) > 0;
}

export async function publish(options: Options): Promise<PublishResult> {
  await ensureClone();
  if (!options.dryRun) {
    await git(['checkout', '-B', 'main'], { allowFail: true });
    if (await remoteMainExists()) {
      await git(['fetch', 'origin', 'main']);
      await git(['merge', '--ff-only', 'origin/main']);
    }
  }

  const sources = await collectSources(options.includeCandidates);
  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];

  // コピー（正規化ハッシュが同じなら書き換えない）
  for (const [rel, abs] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    const dest = path.join(dataRepoDir, rel);
    const [srcBuf, destBuf] = await Promise.all([fs.readFile(abs), readIfExists(dest)]);
    const name = path.basename(rel);
    if (destBuf && normalizedHash(name, srcBuf) === normalizedHash(name, destBuf)) continue;
    changedFiles.push(rel);
    if (!options.dryRun) {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, srcBuf);
    }
  }

  // 削除の反映（管理対象ルート配下のみ。candidates は --include-candidates 無しなら温存）
  const managed = new Map<string, string>();
  await walk(path.join(dataRepoDir, 'output', 'toyo'), 'output/toyo', managed);
  await walk(path.join(dataRepoDir, 'data'), 'data', managed);
  // 旧パス（配信対象ではない）が toyo-data に残っていれば、削除として反映する
  for (const legacy of LEGACY_PATHS) {
    const abs = path.join(dataRepoDir, legacy);
    if (await readIfExists(abs)) managed.set(legacy, abs);
  }
  for (const [rel, abs] of managed) {
    if (sources.has(rel)) continue;
    if (rel === CANDIDATES_REL && !options.includeCandidates) continue;
    assertManaged(rel); // 配信対象外のパスが toyo-data に残っていれば、ここで削除として反映される
    deletedFiles.push(rel);
    if (!options.dryRun) await fs.rm(abs);
  }

  // meta.json
  const now = new Date();
  const files: Record<string, { fetchedAt: string | null; source: string }> = {};
  const published = new Set([...sources.keys()]);
  if (!options.includeCandidates && (await readIfExists(path.join(dataRepoDir, CANDIDATES_REL)))) {
    published.add(CANDIDATES_REL);
  }
  for (const rel of [...published].sort()) {
    const buf = await readIfExists(sources.get(rel) ?? path.join(dataRepoDir, rel));
    files[rel] = {
      fetchedAt: buf ? extractFetchedAt(path.basename(rel), buf) : null,
      source: sourceCommandFor(rel),
    };
  }
  let sourceStatus: unknown = null;
  const summaryBuf = await readIfExists(path.join(repoRoot, 'output', 'toyo', 'summary.json'));
  if (summaryBuf) {
    try {
      sourceStatus = (JSON.parse(summaryBuf.toString('utf8')) as { sourceStatus?: unknown }).sourceStatus ?? null;
    } catch {
      sourceStatus = null;
    }
  }
  // 定期ジョブの健康状態（toyo:health が書く）。クラウド側が「止まっているか」を meta だけで判断できるようにする
  let health: unknown = null;
  const healthBuf = await readIfExists(path.join(repoRoot, HEALTH_REL));
  if (healthBuf) {
    try {
      health = JSON.parse(healthBuf.toString('utf8'));
    } catch {
      health = null;
    }
  }
  const meta = { publishedAt: now.toISOString(), files, sourceStatus, health };

  const shouldCommit = changedFiles.length + deletedFiles.length > 0 || options.force;

  if (options.dryRun) {
    console.log(`[publish] dry-run: ${sources.size} files in allowlist (candidates ${options.includeCandidates ? 'included' : 'excluded'})`);
    for (const f of changedFiles) console.log(`  M/A ${f}`);
    for (const f of deletedFiles) console.log(`  D   ${f}`);
    console.log(
      shouldCommit
        ? `[publish] dry-run: would commit ${changedFiles.length + deletedFiles.length} file(s) + meta.json and push`
        : '[publish] dry-run: no content changes; nothing would be committed'
    );
    return { changedFiles, deletedFiles, committed: false, pushed: false, api: null };
  }

  // GitHub（正本）への commit/push。失敗しても Worker への配信は試みる（エラーは最後に投げ直す）。
  let committed = false;
  let pushed = false;
  let gitError: unknown = null;
  try {
    await fs.writeFile(path.join(dataRepoDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');

    // 前回の commit 失敗などで meta.json 以外の未コミット変更が残っていれば、それも拾う
    const leftover = (await git(['status', '--porcelain', '--untracked-files=all']))
      .split('\n')
      .filter((line) => line !== '' && !line.endsWith(' meta.json'));

    if (shouldCommit || leftover.length > 0) {
      await git(['add', '-A']);
      const dirty = (await git(['status', '--porcelain'])) !== '';
      if (dirty) {
        const n = Math.max(changedFiles.length + deletedFiles.length, leftover.length);
        const identity: string[] = [];
        if (!(await git(['config', 'user.name'], { allowFail: true }))) identity.push('-c', 'user.name=toyo-publisher');
        if (!(await git(['config', 'user.email'], { allowFail: true }))) {
          identity.push('-c', 'user.email=toyo-publisher@users.noreply.github.com');
        }
        await git([...identity, 'commit', '-m', `sync ${formatJst(now)} (${n})`]);
        committed = true;
      }
    }

    if (committed || (await hasUnpushedCommits())) {
      await pushWithRetry();
      pushed = true;
    }
  } catch (error) {
    gitError = error;
  }

  // Worker API への配信（任意）。GitHub の成否とは独立で、失敗しても終了コードは変えない。
  let api: ApiPushResult | null = null;
  try {
    const pushAll = options.pushAllApi === true;
    const hasChange = changedFiles.length + deletedFiles.length > 0;
    api = await pushToApi({
      sources,
      putPaths: pushAll ? [...sources.keys()] : changedFiles,
      deletePaths: deletedFiles,
      // meta は変化があったとき・--force（daily）・全送信のときだけ送る（5 分ごとの無駄な KV 書き込みを避ける）
      meta: hasChange || options.force || pushAll ? meta : null,
    });
  } catch (error) {
    console.error(`[publish] api push failed: ${(error as Error).message}`);
  }

  if (gitError) throw gitError;
  return { changedFiles, deletedFiles, committed, pushed, api };
}

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, includeCandidates: false, force: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--include-candidates') options.includeCandidates = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--push-all-api') options.pushAllApi = true;
    else throw new Error(`Unknown option: ${arg}\nUsage: npm run toyo:publish -- [--dry-run] [--include-candidates] [--force] [--push-all-api]`);
  }
  return options;
}

export async function main(): Promise<void> {
  const result = await publish(parseArgs(process.argv.slice(2)));
  console.log(
    `[publish] changed=${result.changedFiles.length} deleted=${result.deletedFiles.length} committed=${result.committed ? 'yes' : 'no'} pushed=${result.pushed ? 'yes' : 'no'} api=${result.api ? `put:${result.api.put}/del:${result.api.deleted}/failed:${result.api.failed}` : 'off'}`
  );
}
