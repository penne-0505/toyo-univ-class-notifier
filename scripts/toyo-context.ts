#!/usr/bin/env node

/**
 * output/toyo/agent-context.{json,md} を作る薄い CLI。ファイルを読んで scripts/build/context.ts に渡し、書き出すだけ。
 * 取得（toyo:sync など）はしない。summary が古いときは警告（freshness / warnings）で表す。
 * 通常は `npm run toyo:build`（index → summary → context）の最後の段として呼ばれる。
 */

import fs from 'node:fs/promises';
import { buildMarkdown } from './build/context-markdown';
import {
  buildContext,
  contextJsonPath,
  contextMarkdownPath,
  defaultHorizonDays,
  defaultMaxAgeMinutes,
  type AcademicCalendar,
  type AgentContext,
  type ContextInputs,
  type ContextOptions,
} from './build/context';
import { summaryOutputPath, type Summary } from './build/summary';
import { courseIndexOutputPath } from './toyo-build-index';
import { type CourseIndex } from './build/course-index';
import { type EnrollmentData } from './lib/toyo-enrollment';
import { loadAcademicSchedule } from './lib/toyo-academic-schedule';
import { gradingRulesPath, type GradingRulesFile } from './lib/toyo-grading-rules';
import { healthWarnings, loadHealthSnapshot } from './lib/toyo-health';
import { formatJst } from './lib/toyo-normalize';
import { outputDir, registrationDataPath } from './lib/toyo-paths';
import path from 'node:path';

type OutputFormat = 'markdown' | 'json';

type CliOptions = ContextOptions & {
  format: OutputFormat;
  /** 全文を標準出力に出す（既定は 1 行サマリのみ）。 */
  print: boolean;
};

function usage(): string {
  return [
    'Usage:',
    '  npm run toyo:context',
    '  npm run toyo:context -- --print                  全文（Markdown）を標準出力に出す',
    '  npm run toyo:context -- --print --format json',
    '',
    'Options:',
    `  --max-age-minutes <n>     summary がこれより古ければ stale と警告する。Default: ${defaultMaxAgeMinutes}.`,
    `  --horizon-days <n>        Include assignments due within n days. Default: ${defaultHorizonDays}.`,
    '  --print                   Print the full context to stdout. Default: one-line summary only.',
    '  --format markdown|json    Format used with --print. Both output files are always written.',
    '  --no-sync                 互換のため受け付けるが無視する（このコマンドは取得も sync もしない）。',
    '',
    'summary が古いときは npm run toyo:sync などで取得してから npm run toyo:build を実行する。',
  ].join('\n');
}

function parsePositiveNumber(raw: string | undefined, label: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return value;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    maxAgeMinutes: defaultMaxAgeMinutes,
    horizonDays: defaultHorizonDays,
    format: 'markdown',
    print: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--no-sync') continue; // 互換のため受け付けて無視する
    if (arg === '--sync') {
      throw new Error('--sync は廃止しました。取得は npm run toyo:sync / toyo:daily で行い、その後 npm run toyo:build を実行してください。');
    }
    if (arg === '--print') {
      options.print = true;
      continue;
    }
    if (arg === '--max-age-minutes') {
      options.maxAgeMinutes = parsePositiveNumber(argv[index + 1], '--max-age-minutes');
      index += 1;
      continue;
    }
    if (arg === '--horizon-days') {
      options.horizonDays = parsePositiveNumber(argv[index + 1], '--horizon-days');
      index += 1;
      continue;
    }
    if (arg === '--format') {
      const format = argv[index + 1];
      if (format !== 'markdown' && format !== 'json') {
        throw new Error(`--format must be markdown or json.\n\n${usage()}`);
      }
      options.format = format;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
  }

  return options;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    // 無い・壊れているファイルは null（欠けとして警告に出る）
    return null;
  }
}

/** context の入力を読む。summary が無いときは null（呼び出し側が toyo:build を促す）。 */
export async function readContextInputs(now: Date): Promise<ContextInputs | null> {
  const summary = await readJsonFile<Summary>(summaryOutputPath);
  if (!summary) return null;
  const [registration, academicCalendar, gradingRules, courseIndex, health] = await Promise.all([
    readJsonFile<EnrollmentData>(registrationDataPath),
    readJsonFile<AcademicCalendar>(path.join(outputDir, 'academic-calendar.json')),
    readJsonFile<GradingRulesFile>(gradingRulesPath),
    readJsonFile<CourseIndex>(courseIndexOutputPath),
    loadHealthSnapshot(),
  ]);
  return {
    summary,
    registration,
    academicCalendar,
    academicSchedule: loadAcademicSchedule(),
    gradingRules: gradingRules && Array.isArray(gradingRules.courses) ? gradingRules : null,
    courseIndex,
    healthWarnings: healthWarnings(health, now),
  };
}

export async function writeContext(context: AgentContext, markdown: string): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  await Promise.all([
    fs.writeFile(contextJsonPath, JSON.stringify(context, null, 2), 'utf8'),
    fs.writeFile(contextMarkdownPath, markdown, 'utf8'),
  ]);
}

/** 入力を読んで context を組み立て、書き出す。toyo:build からも呼ぶ。summary が無ければ例外。 */
export async function buildAndWriteContext(
  options: ContextOptions = { maxAgeMinutes: defaultMaxAgeMinutes, horizonDays: defaultHorizonDays },
  now: Date = new Date()
): Promise<{ context: AgentContext; markdown: string }> {
  const inputs = await readContextInputs(now);
  if (!inputs) {
    throw new Error(`summary.json was not found at ${summaryOutputPath}. Run npm run toyo:build first.`);
  }
  const context = buildContext(inputs, options, now);
  const markdown = buildMarkdown(context);
  await writeContext(context, markdown);
  return { context, markdown };
}

export function summarizeContext(context: AgentContext): string {
  return `[context] ${formatJst()} JST today=${context.today.classes.length} tomorrow=${context.tomorrow.classes.length} warnings=${context.warnings.length}`;
}

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { context, markdown } = await buildAndWriteContext(options);

  if (options.print) {
    console.log(options.format === 'json' ? JSON.stringify(context, null, 2) : markdown);
    return;
  }
  // 既定は journal を汚さない 1 行サマリ（全文は --print、または output/toyo/agent-context.md を読む）
  console.log(summarizeContext(context));
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
