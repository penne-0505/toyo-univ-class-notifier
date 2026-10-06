#!/usr/bin/env node

/**
 * シラバスの「成績評価の方法・基準」から配分と足切りを正規表現で抽出し、
 * data/grading-rules.json に下書きとして書く。
 *
 * 対象: 秋学期の登録科目 / add-registration-plan.json の科目 / 春学期の登録科目（参考）。
 * 既存ファイルで reviewed: true の科目は上書きしない（人手で直した内容を守る）。
 *
 * Usage:
 *   npm run toyo:grading-rules
 *   npm run toyo:grading-rules -- --dry-run     # 書き込まず結果だけ表示
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { jsonOutputPath, outputDir, type EnrollmentData } from './lib/toyo-enrollment';
import {
  draftGradingRule,
  gradingRulesPath,
  type GradingRule,
  type GradingRulesFile,
} from './lib/toyo-grading-rules';

type Candidate = {
  scheduleCd: string;
  courseName: string;
  syllabus?: { courseCode?: string; grading?: string };
};

type PlanItem = { scheduleCd: string; name: string };

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** scheduleCd = '34' + 授業コード先頭7桁 + '0-' + 授業コード末尾3桁 */
function scheduleCdFromCourseCode(courseCode: string): string {
  return `34${courseCode.slice(0, 7)}0-${courseCode.slice(7)}`;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const enrollment = await readJson<EnrollmentData>(jsonOutputPath);
  const candidatesFile = await readJson<{ candidates: Candidate[] }>(
    path.join(outputDir, 'registration-candidates.json')
  );
  const plan = (await readJson<PlanItem[]>(path.join(outputDir, 'add-registration-plan.json'))) ?? [];
  const existing = await readJson<GradingRulesFile>(gradingRulesPath);
  if (!enrollment) throw new Error('registration-data.json が見つかりません。');

  const candidates = candidatesFile?.candidates ?? [];
  const candidateByScheduleCd = new Map(candidates.map((c) => [c.scheduleCd, c]));
  const candidateByCourseCode = new Map(
    candidates.filter((c) => c.syllabus?.courseCode).map((c) => [c.syllabus!.courseCode!, c])
  );

  const drafts: GradingRule[] = [];
  const seen = new Set<string>();
  const push = (rule: GradingRule): void => {
    if (seen.has(rule.courseCode)) return;
    seen.add(rule.courseCode);
    drafts.push(rule);
  };
  const missing = (courseCode: string, scheduleCd: string | null, courseName: string, semester: GradingRule['semester'], enrollmentKind: GradingRule['enrollment'], reason: string): GradingRule => ({
    courseCode,
    scheduleCd,
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

  // 1. 秋学期の登録科目（候補一覧のシラバスから。授業コード一致 → scheduleCd 式の順で探す）
  for (const course of enrollment.courses.filter((c) => c.semesterLabel === '秋学期')) {
    const candidate =
      candidateByCourseCode.get(course.courseCode) ??
      candidateByScheduleCd.get(scheduleCdFromCourseCode(course.courseCode));
    const grading = candidate?.syllabus?.grading;
    if (!candidate || !grading) {
      push(missing(course.courseCode, candidate?.scheduleCd ?? null, course.courseName, '秋学期', 'registered', 'registration-candidates.json にシラバス本文が無い。toyo:candidates -- --syllabus を実行すること。'));
      continue;
    }
    push(draftGradingRule({ courseCode: course.courseCode, scheduleCd: candidate.scheduleCd, courseName: course.courseName, semester: '秋学期', enrollment: 'registered', grading }));
  }

  // 2. 追加登録プランの科目
  for (const item of plan) {
    const candidate = candidateByScheduleCd.get(item.scheduleCd);
    const courseCode = candidate?.syllabus?.courseCode ?? item.scheduleCd;
    const grading = candidate?.syllabus?.grading;
    if (!candidate || !grading) {
      push(missing(courseCode, item.scheduleCd, item.name, '秋学期', 'add-plan', 'registration-candidates.json にシラバス本文が無い。'));
      continue;
    }
    push(draftGradingRule({ courseCode, scheduleCd: item.scheduleCd, courseName: candidate.courseName, semester: '秋学期', enrollment: 'add-plan', grading }));
  }

  // 3. 春学期の登録科目（参考）
  for (const course of enrollment.courses.filter((c) => c.semesterLabel === '春学期')) {
    const record = await readJson<{ syllabus?: { grading?: string } }>(
      path.join(outputDir, 'syllabus', `${course.courseCode}.json`)
    );
    const grading = record?.syllabus?.grading;
    const scheduleCd = scheduleCdFromCourseCode(course.courseCode);
    if (!grading) {
      push(missing(course.courseCode, scheduleCd, course.courseName, '春学期', 'reference', `output/toyo/syllabus/${course.courseCode}.json が無い。`));
      continue;
    }
    push(draftGradingRule({ courseCode: course.courseCode, scheduleCd, courseName: course.courseName, semester: '春学期', enrollment: 'reference', grading }));
  }

  // reviewed: true の既存科目は上書きしない。対象外の既存科目はそのまま残す。
  const existingByCode = new Map((existing?.courses ?? []).map((c) => [c.courseCode, c]));
  const merged: GradingRule[] = drafts.map((draft) => {
    const previous = existingByCode.get(draft.courseCode);
    return previous?.reviewed ? previous : draft;
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
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
