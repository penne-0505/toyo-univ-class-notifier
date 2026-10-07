#!/usr/bin/env node

/**
 * シラバスの「成績評価の方法・基準」から配分と足切りを正規表現で抽出し、
 * data/grading-rules.json に下書きとして書く。
 *
 * 対象: 秋学期の登録科目 / add-registration-plan.json の科目 / 春学期の登録科目（参考）。
 * 既存ファイルで reviewed: true の科目は上書きしない（人手で直した内容を守る）。
 *
 * シラバス本文の入力は次の順（授業コードで引く。先に見つかったものを使う）:
 *   1. output/toyo/syllabus/<授業コード>.json（登録科目のキャッシュ）
 *   2. output/toyo/syllabus-pool/<授業コード>.json（登録可能科目の取得で貯めた本文）
 *   3. 候補ファイル（registration-candidates*.json。追加登録期間の取得には本文が無いので、本文のある方だけ）
 * 授業コードが確定しない科目（追加登録プランの scheduleCd しか分からないもの）は下書きを作らず「スキップ」と出す。
 *
 * Usage:
 *   npm run toyo:grading-rules
 *   npm run toyo:grading-rules -- --dry-run     # 書き込まず結果だけ表示
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { inferScheduleCd } from './lib/course-code';
import { readPool } from './lib/syllabus-pool';
import { findSyllabus, readSyllabusCache } from './lib/syllabus-cache';
import { type EnrollmentData } from './lib/toyo-enrollment';
import {
  draftGradingRule,
  gradingRulesPath,
  type GradingRule,
  type GradingRulesFile,
} from './lib/toyo-grading-rules';
import { outputDir, registrationDataPath } from './lib/toyo-paths';

/** 授業コード・scheduleCd・シラバス本文の出どころになる 1 件（pool の候補、候補ファイルの候補を同じ形にしたもの）。 */
type Source = {
  origin: string;
  scheduleCd: string | null;
  courseName: string | null;
  courseCode: string | null;
  grading: string | null;
};

type CandidateLike = {
  scheduleCd?: string;
  courseName?: string;
  syllabus?: { courseCode?: string; grading?: string } | null;
};

type PlanItem = { scheduleCd: string; name: string };

const CANDIDATE_FILES = ['registration-candidates.json', 'registration-candidates.regular.json', 'registration-candidates.add.json'];

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function fromCandidate(origin: string, c: CandidateLike): Source {
  return {
    origin,
    scheduleCd: c.scheduleCd ?? null,
    courseName: c.courseName ?? null,
    courseCode: c.syllabus?.courseCode ?? null,
    grading: c.syllabus?.grading || null,
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const enrollment = await readJson<EnrollmentData>(registrationDataPath);
  const plan = (await readJson<PlanItem[]>(path.join(outputDir, 'add-registration-plan.json'))) ?? [];
  const existing = await readJson<GradingRulesFile>(gradingRulesPath);
  if (!enrollment) throw new Error('registration-data.json が見つかりません。');

  const syllabusCache = await readSyllabusCache();
  const pool = await readPool();
  const candidateSources: Source[] = [];
  for (const name of CANDIDATE_FILES) {
    const file = await readJson<{ candidates?: CandidateLike[] }>(path.join(outputDir, name));
    for (const c of file?.candidates ?? []) candidateSources.push(fromCandidate(name, c));
  }
  const poolSources = pool.map((entry) => fromCandidate('syllabus-pool', { ...entry.candidate, syllabus: { ...entry.candidate.syllabus, courseCode: entry.courseCode } }));
  // 授業コード・scheduleCd を引く対象。本文（grading）を持つものを先にする
  const lookupSources = [...poolSources, ...candidateSources].sort((a, b) => Number(Boolean(b.grading)) - Number(Boolean(a.grading)));

  /** 授業コードで本文を探す: キャッシュ → pool → 候補ファイル */
  const gradingFor = (courseCode: string, academicYear?: string): { text: string | null; scheduleCd: string | null } => {
    const record = findSyllabus(syllabusCache, courseCode, academicYear) ?? findSyllabus(syllabusCache, courseCode);
    const hit = lookupSources.find((s) => s.courseCode === courseCode);
    const scheduleCd = hit?.scheduleCd ?? null;
    if (record?.grading) return { text: record.grading, scheduleCd };
    const withText = lookupSources.find((s) => s.courseCode === courseCode && s.grading);
    return { text: withText?.grading ?? null, scheduleCd: withText?.scheduleCd ?? scheduleCd };
  };

  const drafts: GradingRule[] = [];
  const seen = new Set<string>();
  const skipped: string[] = [];
  const push = (rule: GradingRule): void => {
    if (seen.has(rule.courseCode)) return;
    seen.add(rule.courseCode);
    drafts.push(rule);
  };
  const existingByCode = new Map((existing?.courses ?? []).map((c) => [c.courseCode, c]));
  const missing = (courseCode: string, scheduleCd: string | null, courseName: string, semester: GradingRule['semester'], enrollmentKind: GradingRule['enrollment'], reason: string): GradingRule => ({
    courseCode,
    scheduleCd: scheduleCd ?? existingByCode.get(courseCode)?.scheduleCd ?? null,
    courseName,
    semester,
    enrollment: enrollmentKind,
    components: [],
    cutoffs: [],
    retake: null,
    sourceText: '',
    reviewed: false,
    warnings: [reason],
  });

  // 1. 秋学期の登録科目
  for (const course of enrollment.courses.filter((c) => c.semesterLabel === '秋学期')) {
    const found = gradingFor(course.courseCode, enrollment.academicYear);
    if (!found.text) {
      push(missing(course.courseCode, found.scheduleCd, course.courseName, '秋学期', 'registered', 'シラバス本文が無い（output/toyo/syllabus・syllabus-pool・候補ファイルのどれにも）。toyo:daily が補完するか、toyo:syllabus を実行すること。'));
      continue;
    }
    const scheduleCd = found.scheduleCd ?? existingByCode.get(course.courseCode)?.scheduleCd ?? inferScheduleCd(course.courseCode);
    push(draftGradingRule({ courseCode: course.courseCode, scheduleCd, courseName: course.courseName, semester: '秋学期', enrollment: 'registered', grading: found.text }));
  }

  // 2. 追加登録プランの科目: scheduleCd しか分からない。授業コードは候補（pool / 候補ファイル）の本文から確定できたものだけ。
  for (const item of plan) {
    const hit = lookupSources.find((s) => s.scheduleCd === item.scheduleCd && s.courseCode);
    if (!hit?.courseCode) {
      skipped.push(`${item.name} (${item.scheduleCd})`);
      continue;
    }
    const found = gradingFor(hit.courseCode);
    if (!found.text) {
      push(missing(hit.courseCode, item.scheduleCd, item.name, '秋学期', 'add-plan', 'シラバス本文が無い。'));
      continue;
    }
    push(draftGradingRule({ courseCode: hit.courseCode, scheduleCd: item.scheduleCd, courseName: hit.courseName ?? item.name, semester: '秋学期', enrollment: 'add-plan', grading: found.text }));
  }

  // 3. 春学期の登録科目（参考）
  for (const course of enrollment.courses.filter((c) => c.semesterLabel === '春学期')) {
    const found = gradingFor(course.courseCode, enrollment.academicYear);
    const scheduleCd = found.scheduleCd ?? existingByCode.get(course.courseCode)?.scheduleCd ?? inferScheduleCd(course.courseCode);
    if (!found.text) {
      push(missing(course.courseCode, scheduleCd, course.courseName, '春学期', 'reference', `シラバス本文が無い（output/toyo/syllabus/${course.courseCode}.json）。`));
      continue;
    }
    push(draftGradingRule({ courseCode: course.courseCode, scheduleCd, courseName: course.courseName, semester: '春学期', enrollment: 'reference', grading: found.text }));
  }

  // reviewed: true の既存科目は上書きしない。入力が欠けて空の下書きしか作れない場合も、既存の内容を空で上書きしない。
  // 対象外の既存科目はそのまま残す。
  const merged: GradingRule[] = drafts.map((draft) => {
    const previous = existingByCode.get(draft.courseCode);
    if (previous?.reviewed) return previous;
    if (previous && draft.sourceText === '' && (previous.components.length > 0 || previous.cutoffs.length > 0)) return previous;
    return draft;
  });
  for (const previous of existing?.courses ?? []) {
    if (!seen.has(previous.courseCode)) merged.push(previous);
  }

  const result: GradingRulesFile = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    notes: existing?.notes ?? [],
    courses: merged,
  };
  if (!dryRun) {
    await fs.writeFile(gradingRulesPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }

  const reviewedCount = merged.filter((c) => c.reviewed).length;
  console.log(`${dryRun ? '[dry-run] ' : ''}grading-rules: ${merged.length} 科目（reviewed ${reviewedCount} / 下書き ${merged.length - reviewedCount}）`);
  console.log(`出力: ${gradingRulesPath}`);
  for (const rule of merged) {
    const mark = rule.reviewed ? 'reviewed' : 'draft   ';
    console.log(`  [${mark}] ${rule.semester} ${rule.courseName} (${rule.courseCode}) 配分${rule.components.length}件 足切り${rule.cutoffs.length}件 warnings=${rule.warnings.length}`);
    for (const warning of rule.warnings) console.log(`      ! ${warning}`);
  }
  for (const line of skipped) {
    console.log(`  [スキップ] ${line}: 授業コードが確定しない（候補に本文が無く scheduleCd しか分からない）ため下書きを作らない`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
