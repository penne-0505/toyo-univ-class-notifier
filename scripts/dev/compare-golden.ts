#!/usr/bin/env node

/**
 * 2 つの JSON ファイルを時刻キー（fetchedAt / generatedAt / builtAt など）を除いて比較し、差分をパス単位で表示する。
 * 3 層化リファクタの前後で summary.json / agent-context.json が変わっていないことの確認に使う。
 * 差分があれば終了コード 1。
 *
 * Usage:
 *   npx tsx scripts/dev/compare-golden.ts <before.json> <after.json>
 *   例: npx tsx scripts/dev/compare-golden.ts tmp/golden/2026-10-08/toyo/agent-context.json output/toyo/agent-context.json
 */

import fs from 'node:fs';
import { stripTimeKeys } from '../lib/toyo-normalize';

type Diff = { path: string; kind: 'changed' | 'added' | 'removed'; before?: unknown; after?: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPrimitive(value: unknown): boolean {
  return value === null || typeof value !== 'object';
}

export function diffValues(before: unknown, after: unknown, path = '$', out: Diff[] = []): Diff[] {
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.every(isPrimitive) && after.every(isPrimitive)) {
      // プリミティブ配列は挿入で添字がずれるため、値の集合差で報告する
      const beforeCount = new Map<string, number>();
      for (const v of before) beforeCount.set(JSON.stringify(v), (beforeCount.get(JSON.stringify(v)) ?? 0) + 1);
      const afterCount = new Map<string, number>();
      for (const v of after) afterCount.set(JSON.stringify(v), (afterCount.get(JSON.stringify(v)) ?? 0) + 1);
      for (const [key, n] of afterCount) {
        if (n > (beforeCount.get(key) ?? 0)) out.push({ path: `${path}[]`, kind: 'added', after: JSON.parse(key) });
      }
      for (const [key, n] of beforeCount) {
        if (n > (afterCount.get(key) ?? 0)) out.push({ path: `${path}[]`, kind: 'removed', before: JSON.parse(key) });
      }
      return out;
    }
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i += 1) {
      if (i >= before.length) out.push({ path: `${path}[${i}]`, kind: 'added', after: after[i] });
      else if (i >= after.length) out.push({ path: `${path}[${i}]`, kind: 'removed', before: before[i] });
      else diffValues(before[i], after[i], `${path}[${i}]`, out);
    }
    return out;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const childPath = `${path}.${key}`;
      if (!(key in before)) out.push({ path: childPath, kind: 'added', after: after[key] });
      else if (!(key in after)) out.push({ path: childPath, kind: 'removed', before: before[key] });
      else diffValues(before[key], after[key], childPath, out);
    }
    return out;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ path, kind: 'changed', before, after });
  return out;
}

function show(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export function main(): void {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error('Usage: npx tsx scripts/dev/compare-golden.ts <before.json> <after.json>');
    process.exit(2);
  }
  const read = (file: string): unknown => stripTimeKeys(JSON.parse(fs.readFileSync(file, 'utf8')));
  const diffs = diffValues(read(beforePath), read(afterPath));
  if (diffs.length === 0) {
    console.log('no differences (time keys ignored)');
    return;
  }
  for (const d of diffs) {
    if (d.kind === 'changed') console.log(`~ ${d.path}\n    - ${show(d.before)}\n    + ${show(d.after)}`);
    else if (d.kind === 'added') console.log(`+ ${d.path}: ${show(d.after)}`);
    else console.log(`- ${d.path}: ${show(d.before)}`);
  }
  console.log(`${diffs.length} difference(s)`);
  process.exitCode = 1;
}

if (require.main === module) main();
