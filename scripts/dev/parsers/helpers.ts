/**
 * パーサのテスト用ヘルパ。fixtures/ には合成データだけを置く（本物の履修・成績・氏名・学籍番号は入れない）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const fixturesDir = path.resolve(__dirname, '..', 'fixtures');

export function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}

export function readJsonFixture<T>(name: string): T {
  return JSON.parse(readFixture(name)) as T;
}
