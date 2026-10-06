#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repoRoot } from './lib/toyo-enrollment';
import { extractFetchedAt, formatJst, normalizedHash } from './lib/toyo-normalize';

const execFileAsync = promisify(execFile);

export const dataRepoDir = process.env.TOYO_DATA_DIR || path.join(os.homedir(), 'toyo-data');
const dataRepoUrl = 'git@github.com-toyo-data:penne-0505/toyo-data.git';
const CANDIDATES_REL = 'output/toyo/registration-candidates.json';

/**
 * 公開してよいパスは allowlist だけ。除外リストには頼らない。
 *   output/toyo/**, output/bot/summary.json, data/**
 */
const ALLOWED_PATTERNS: RegExp[] = [/^output\/toyo\/.+/, /^output\/bot\/summary\.json$/, /^data\/.+/];
const FORBIDDEN_SEGMENTS = /^(?:artifacts|playwright|node_modules|\.git|\.env.*)$/;

function assertAllowed(rel: string): void {
  const ok =
    ALLOWED_PATTERNS.some((p) => p.test(rel)) &&
    !rel.split('/').some((segment) => FORBIDDEN_SEGMENTS.test(segment));
  if (!ok) {
    throw new Error(`Refusing to publish path outside allowlist: ${rel}`);
  }
}

const SOURCE_COMMANDS: Array<[RegExp, string]> = [
  [/^output\/bot\/summary\.json$/, 'toyo:sync | toyo:watch'],
  [/^output\/toyo\/registration-(?:data\.json|summary\.md)$/, 'toyo:sync'],
  [/^output\/toyo\/toyonet-ace-assignments\.json$/, 'toyo:sync | toyo:watch'],
  [/^output\/toyo\/announcements\.json$/, 'toyo:sync | toyo:watch'],
  [/^output\/toyo\/toyonet-ace-contents\.json$/, 'toyo:sync'],
  [/^output\/toyo\/academic-calendar\.json$/, 'toyo:sync'],
  [/^output\/toyo\/credit-summary\./, 'toyo:credits'],
  [/^output\/toyo\/lottery-results\./, 'toyo:lottery'],
  [/^output\/toyo\/registration-candidates\.json$/, 'toyo:candidates'],
  [/^output\/toyo\/agent-context\./, 'toyo:context'],
  [/^output\/toyo\/syllabus\//, 'toyo:syllabus'],
  [/^data\//, 'manual (data/)'],
];

function sourceCommandFor(rel: string): string {
  return SOURCE_COMMANDS.find(([p]) => p.test(rel))?.[1] ?? 'unknown';
}

type Options = { dryRun: boolean; includeCandidates: boolean; force: boolean };

export type PublishResult = {
  changedFiles: string[];
  deletedFiles: string[];
  committed: boolean;
  pushed: boolean;
};

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
  const summary = path.join(repoRoot, 'output', 'bot', 'summary.json');
  try {
    await fs.access(summary);
    sources.set('output/bot/summary.json', summary);
  } catch {
    /* summary 未生成 */
  }
  if (!includeCandidates) sources.delete(CANDIDATES_REL);
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
  const botSummary = path.join(dataRepoDir, 'output', 'bot', 'summary.json');
  if (await readIfExists(botSummary)) managed.set('output/bot/summary.json', botSummary);
  for (const [rel, abs] of managed) {
    if (sources.has(rel)) continue;
    if (rel === CANDIDATES_REL && !options.includeCandidates) continue;
    assertAllowed(rel);
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
  const summaryBuf = await readIfExists(path.join(repoRoot, 'output', 'bot', 'summary.json'));
  if (summaryBuf) {
    try {
      sourceStatus = (JSON.parse(summaryBuf.toString('utf8')) as { sourceStatus?: unknown }).sourceStatus ?? null;
    } catch {
      sourceStatus = null;
    }
  }
  const meta = { publishedAt: now.toISOString(), files, sourceStatus };

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
    return { changedFiles, deletedFiles, committed: false, pushed: false };
  }

  await fs.writeFile(path.join(dataRepoDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');

  // 前回の commit 失敗などで meta.json 以外の未コミット変更が残っていれば、それも拾う
  const leftover = (await git(['status', '--porcelain', '--untracked-files=all']))
    .split('\n')
    .filter((line) => line !== '' && !line.endsWith(' meta.json'));

  let committed = false;
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

  let pushed = false;
  if (committed || (await hasUnpushedCommits())) {
    await pushWithRetry();
    pushed = true;
  }
  return { changedFiles, deletedFiles, committed, pushed };
}

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, includeCandidates: false, force: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--include-candidates') options.includeCandidates = true;
    else if (arg === '--force') options.force = true;
    else throw new Error(`Unknown option: ${arg}\nUsage: npm run toyo:publish -- [--dry-run] [--include-candidates] [--force]`);
  }
  return options;
}

export async function main(): Promise<void> {
  const result = await publish(parseArgs(process.argv.slice(2)));
  console.log(
    `[publish] changed=${result.changedFiles.length} deleted=${result.deletedFiles.length} committed=${result.committed ? 'yes' : 'no'} pushed=${result.pushed ? 'yes' : 'no'}`
  );
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
