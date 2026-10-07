/**
 * 公開リポジトリに個人情報が混ざっていないかの検査。
 * git 管理下（`git ls-files`。`--include-untracked` で未追跡・非 ignore のファイルも含める）の全テキストファイルを走査し、ヒットを「ファイル:行 [種別]」で出す。
 * 値そのものは出力しない。ヒットがあれば exit code 1。
 *
 * 検査する内容:
 *   a. 履修科目名: output/toyo/registration-data.json と data/grading-rules.json（どちらも git 管理外）の courseName（NFKC・空白除去で比較）
 *      あわせて同ファイルの授業コード・担当者名も調べる
 *   b. 学籍番号・氏名: 同ファイルの studentNumber / studentName / studentNameKana
 *   c. 所属が推測できる語（学部・部制）
 *   d. API キー: ~/.config/toyo-data-api/keys.json の値
 * registration-data.json / keys.json が無い環境では該当する検査（a,b / d）をスキップする（その旨を表示）。
 * 大学全体の一般情報（シラバス検索 URL、「東洋大学」など）は検査対象外。
 *
 * Usage: npx tsx scripts/dev/check-public-privacy.ts [--include-untracked]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..');

type Needle = { kind: string; value: string };

/** NFKC にして空白を全部落とす（「生命と倫理　1」と「生命と倫理1」を同じにする）。 */
function squash(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, '');
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function collectNeedles(): { needles: Needle[]; skipped: string[] } {
  const needles: Needle[] = [];
  const skipped: string[] = [];

  const registration = readJson(path.join(repoRoot, 'output/toyo/registration-data.json')) as {
    studentNumber?: string;
    studentName?: string;
    studentNameKana?: string;
    courses?: Array<{ courseName?: string; courseCode?: string; instructor?: string }>;
  } | null;
  if (registration) {
    for (const course of registration.courses ?? []) {
      if (course.courseName) needles.push({ kind: 'course-name', value: squash(course.courseName) });
      if (course.courseCode) needles.push({ kind: 'course-code', value: squash(course.courseCode) });
      // 担当者は「、」「,」区切りで複数入ることがある
      for (const name of (course.instructor ?? '').split(/[、,\n]/)) {
        if (squash(name).length >= 3) needles.push({ kind: 'instructor', value: squash(name) });
      }
    }
    for (const key of ['studentNumber', 'studentName', 'studentNameKana'] as const) {
      const value = registration[key];
      if (value) needles.push({ kind: 'student-identity', value: squash(value) });
    }
  } else {
    skipped.push('registration-data.json が無いので 科目名・学籍番号・氏名 の検査をスキップ');
  }

  // 履修候補・参考の科目名（data/grading-rules.json。git 管理外）。登録済み以外の本人の履修計画も含まれる
  const gradingRules = readJson(path.join(repoRoot, 'data/grading-rules.json')) as { courses?: Array<{ courseName?: string }> } | null;
  for (const course of gradingRules?.courses ?? []) {
    if (course.courseName) needles.push({ kind: 'course-name', value: squash(course.courseName) });
  }

  // 検査スクリプト自身にヒットしないよう、語は断片から組み立てる
  const faculty = '経営' + '学部';
  const division = '第' + '2' + '部';
  needles.push({ kind: 'affiliation', value: faculty + division });
  needles.push({ kind: 'affiliation', value: division });

  const keys = readJson(path.join(os.homedir(), '.config/toyo-data-api/keys.json')) as Record<string, unknown> | null;
  if (keys) {
    for (const [name, value] of Object.entries(keys)) {
      if (/key/i.test(name) && typeof value === 'string' && value.length >= 8) needles.push({ kind: 'api-key', value });
    }
  } else {
    skipped.push('keys.json が無いので API キーの検査をスキップ');
  }

  // 重複と空を除く
  const seen = new Set<string>();
  const unique = needles.filter((needle) => {
    if (!needle.value) return false;
    const id = `${needle.kind}:${needle.value}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { needles: unique, skipped };
}

function listFiles(): string[] {
  const args = ['ls-files', '-z'];
  if (process.argv.includes('--include-untracked')) args.push('--cached', '--others', '--exclude-standard');
  const out = execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(out.split('\0').filter(Boolean))].filter((file) => {
    try {
      return fs.statSync(path.join(repoRoot, file)).isFile();
    } catch {
      return false;
    }
  });
}

function main(): void {
  const { needles, skipped } = collectNeedles();
  const files = listFiles();
  const hits: string[] = [];
  let scanned = 0;

  for (const file of files) {
    const buffer = fs.readFileSync(path.join(repoRoot, file));
    if (buffer.includes(0)) continue; // バイナリ
    scanned += 1;
    const lines = buffer.toString('utf8').split('\n');
    lines.forEach((line, index) => {
      const squashed = squash(line);
      const raw = line;
      const kinds = new Set<string>();
      for (const needle of needles) {
        if (needle.kind === 'api-key' ? raw.includes(needle.value) : squashed.includes(needle.value)) kinds.add(needle.kind);
      }
      for (const kind of kinds) hits.push(`${file}:${index + 1} [${kind}]`);
    });
  }

  for (const note of skipped) console.log(`[skip] ${note}`);
  console.log(`[scan] ${scanned} files, ${needles.length} patterns`);
  if (hits.length === 0) {
    console.log('[ok] hits: 0');
    return;
  }
  for (const hit of hits) console.log(hit);
  console.log(`[ng] hits: ${hits.length}`);
  process.exitCode = 1;
}

main();
