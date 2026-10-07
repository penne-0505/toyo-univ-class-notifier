/**
 * 単位数集計表・履修修得科目一覧（scripts/fetch/credits.ts の parseCreditSummary / parseCompletedCourses）の検査。
 * Usage: npx tsx --test scripts/dev/parsers/credits.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCompletedCourses, parseCreditSummary } from '../../fetch/credits';
import { readFixture } from './helpers';

const T = '\t';
const row = (...cells: string[]): string => cells.join(T);

describe('parseCreditSummary: 単位数集計表', () => {
  const { requirements, bySemester } = parseCreditSummary(readFixture('credit-summary.txt'));

  it('要件行を全部読む（実施形態別・単位修得状況の表は要件に混ざらない）', () => {
    assert.equal(requirements.length, 13);
    assert.equal(requirements[0].name, '総単位');
    assert.equal(requirements.at(-1)!.name, '自由科目');
  });

  it('名前は前後の全角空白を落とす', () => {
    assert.deepEqual(
      requirements.map((r) => r.name).slice(0, 4),
      ['総単位', '卒業要件単位（100単位）', '全学基盤教育科目（4単位以上）', '哲学・自校教育（2単位以上）']
    );
  });

  it('数値の列を読む。条件単位が空の行は required が null', () => {
    assert.deepEqual(requirements[0], { name: '総単位', depth: 0, required: null, earned: 10, inProgress: 8, judged: 18, shortage: 0 });
    const graduation = requirements.find((r) => r.name.startsWith('卒業要件'))!;
    assert.equal(graduation.required, 100);
    assert.equal(graduation.earned, 10);
    assert.equal(graduation.inProgress, 8);
    assert.equal(graduation.judged, 18);
    assert.equal(graduation.shortage, 82);
    assert.equal(requirements.find((r) => r.name === '国際')!.required, null);
  });

  it('階層（先頭の全角空白 1 個につき 1 段）を depth にする', () => {
    const depthOf = (name: string) => requirements.find((r) => r.name.startsWith(name))!.depth;
    assert.equal(depthOf('総単位'), 0);
    assert.equal(depthOf('卒業要件'), 1);
    assert.equal(depthOf('全学基盤教育科目'), 2);
    assert.equal(depthOf('哲学・自校教育'), 3);
    assert.equal(depthOf('専門教育選択'), 4);
    assert.equal(depthOf('資格・卒業単位外'), 1);
    assert.equal(depthOf('自由科目'), 2);
  });

  it('学期別の成績: 単位修得状況の表だけを読み、年度・学期の重複（実施形態別・学年別）は捨てる', () => {
    assert.deepEqual(
      bySemester.map((s) => `${s.academicYear} ${s.semester}`),
      ['2025 春学期', '2025 秋学期', '2026 秋学期']
    );
  });

  it('学期別の成績: 履修・修得・GPA と S A B C D E * T 保 の人数', () => {
    assert.deepEqual(bySemester[0], {
      academicYear: '2025',
      semester: '春学期',
      registered: 8,
      earned: 8,
      gpa: 2.5,
      grades: { S: 1, A: 2, B: 1, C: 0, D: 0, E: 0, '*': 0, T: 0, 保: 0 },
    });
    assert.equal(bySemester[1].grades.D, 1);
    assert.equal(bySemester[2].grades['*'], 8);
    assert.equal(bySemester[2].gpa, 0);
  });

  it('全角数字の数値も読む', () => {
    const text = [row('要件', '条件単位', '修得単位', '履修中単位', '判定単位', '不足単位'), row('総単位', '', '１０', '８', '１８', '０')].join('\n');
    assert.equal(parseCreditSummary(text).requirements[0].earned, 10);
    assert.equal(parseCreditSummary(text).requirements[0].judged, 18);
  });

  it('空の本文・無関係な本文は空配列', () => {
    assert.deepEqual(parseCreditSummary(''), { requirements: [], bySemester: [] });
    assert.deepEqual(parseCreditSummary('システムエラー\nもう一度お試しください'), { requirements: [], bySemester: [] });
  });

  it('列が足りない要件行は読み飛ばす', () => {
    const text = [row('要件', '条件単位', '修得単位', '履修中単位', '判定単位', '不足単位'), row('途中で切れた行', '1', '2')].join('\n');
    assert.deepEqual(parseCreditSummary(text).requirements, []);
  });
});

describe('parseCompletedCourses: 履修・修得科目一覧', () => {
  const courses = parseCompletedCourses(readFixture('completed-courses.txt'));

  it('科目行を全部読む（見出し行・科目群の行は科目にしない）', () => {
    assert.equal(courses.length, 8);
  });

  it('科目群（全学基盤教育科目 / 全学共通教育科目 / 専門教育科目）が次の見出しまで付く', () => {
    assert.deepEqual(
      courses.map((c) => c.courseGroup),
      [
        '全学基盤教育科目',
        '全学基盤教育科目',
        '全学共通教育科目',
        '全学共通教育科目',
        '全学共通教育科目',
        '専門教育科目',
        '専門教育科目',
        '専門教育科目',
      ]
    );
  });

  it('各列（区分・科目名・担当者・単位・成績・成績備考・年度・期間・履修学年・セメスタ）を読む', () => {
    assert.deepEqual(courses[0], {
      courseGroup: '全学基盤教育科目',
      category: '哲学・自校教育',
      courseName: 'サンプル論理学Ａ',
      instructor: '架空　一郎',
      credits: 2,
      grade: 'S',
      gradeNote: '',
      academicYear: '2025',
      term: '春学期',
      yearOfStudy: '1',
      semesterIndex: '1',
    });
    const retake = courses.find((c) => c.courseName.startsWith('ＺＱ入門'))!;
    assert.equal(retake.gradeNote, '再試験合格');
    assert.equal(retake.yearOfStudy, '2');
    assert.equal(retake.semesterIndex, '4');
  });

  it('成績の記号（S・◎・D・*・E・空欄＝履修中）をそのまま持つ', () => {
    assert.deepEqual(courses.map((c) => c.grade), ['S', '◎', 'D', '*', 'A', 'B', 'E', '']);
  });

  it('年度が 4 桁でない行は科目としない', () => {
    const text = ['専門教育科目', row('', '基礎', 'サンプル簿記論', '架空', '2', 'A', '', '年度不明', '春学期', '1', '1')].join('\n');
    assert.deepEqual(parseCompletedCourses(text), []);
  });

  it('単位が数値でなければ null', () => {
    const text = ['専門教育科目', row('', '基礎', 'サンプル簿記論', '架空', '※', 'A', '', '2025', '春学期', '1', '1')].join('\n');
    assert.equal(parseCompletedCourses(text)[0].credits, null);
  });

  it('空の本文は空配列', () => {
    assert.deepEqual(parseCompletedCourses(''), []);
  });
});
