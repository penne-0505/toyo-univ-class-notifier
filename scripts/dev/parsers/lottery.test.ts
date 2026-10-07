/**
 * 抽選実施科目一覧（scripts/fetch/lottery.ts の parseLotteryText）の検査。
 * Usage: npx tsx --test scripts/dev/parsers/lottery.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLotteryMarkdown, parseLotteryText } from '../../fetch/lottery';
import { readFixture } from './helpers';

const T = '\t';
const row = (...cells: string[]): string => cells.join(T);

describe('parseLotteryText', () => {
  const parsed = parseLotteryText(readFixture('lottery-results.txt'));

  it('開講年度・学期を読む', () => {
    assert.equal(parsed.academicYear, '2026');
    assert.equal(parsed.semester, '秋学期');
  });

  it('科目行だけを読む（見出し・ページ送り・件数の行は科目にしない）', () => {
    assert.equal(parsed.entries.length, 4);
    assert.deepEqual(
      parsed.entries.map((e) => e.courseCode),
      ['9G00102001', '9G01014001', '9G01017001', '9G01218001']
    );
  });

  it('× → lost、○ → won、空欄 → pending、それ以外 → unknown', () => {
    assert.deepEqual(parsed.entries.map((e) => [e.result, e.resultMark]), [
      ['lost', '×'],
      ['won', '○'],
      ['pending', ''],
      ['unknown', '◎'],
    ]);
  });

  it('各列（区分・科目名・時間割・担当者・教室・キャンパス・単位）を読む', () => {
    assert.deepEqual(parsed.entries[0], {
      result: 'lost',
      resultMark: '×',
      courseCode: '9G00102001',
      category: '哲学・自校教育',
      courseName: 'サンプル倫理学Ａ',
      scheduleLabel: '秋無無',
      instructor: '架空　一郎',
      classroom: '非対面授業（別キャンパスのオンデマンド授業）',
      campus: '別キャンパス（ＸＹ・ＺＷ）',
      credits: 2,
    });
  });

  it('○ の別表記（〇・◯）と × の別表記（✕）も判定する', () => {
    const lines = ['〇', '◯', '✕'].map((mark, i) =>
      row(mark, `9G0000000${i}`, '区分', `サンプル科目${i}`, '秋無無', '架空', '教室', 'キャンパス', '2')
    );
    assert.deepEqual(parseLotteryText(lines.join('\n')).entries.map((e) => e.result), ['won', 'won', 'lost']);
  });

  it('単位が数字でなければ null', () => {
    const text = row('○', '9G00000009', '区分', 'サンプル科目', '秋無無', '架空', '教室', 'キャンパス', '-');
    assert.equal(parseLotteryText(text).entries[0].credits, null);
  });

  it('列が足りない行・授業コードの位置が違う行は読まない', () => {
    const short = row('○', '9G00000001', '区分', 'サンプル科目', '秋無無', '架空', '教室', 'キャンパス'); // 単位が無い
    const shifted = row('○', '区分', '9G00000002', 'サンプル科目', '秋無無', '架空', '教室', 'キャンパス', '2');
    assert.deepEqual(parseLotteryText(`${short}\n${shifted}`).entries, []);
  });

  it('抽選実施科目が無い（登録科目がすべて確定）ときは空配列。年度・学期は読める', () => {
    const text = ['抽選実施科目一覧照会', row('開講年度', '2026', '学期', '春学期', '学籍番号', '9999999999'), '抽選実施科目はありません'].join('\n');
    const result = parseLotteryText(text);
    assert.equal(result.academicYear, '2026');
    assert.equal(result.semester, '春学期');
    assert.deepEqual(result.entries, []);
  });

  it('年度・学期の記載が無ければ null', () => {
    const result = parseLotteryText('システムエラー');
    assert.equal(result.academicYear, null);
    assert.equal(result.semester, null);
  });
});

describe('buildLotteryMarkdown', () => {
  it('当選・落選・未発表を表に出し、画面が開けなかったときはその旨を書く', () => {
    const { academicYear, semester, entries } = parseLotteryText(readFixture('lottery-results.txt'));
    const md = buildLotteryMarkdown({ fetchedAt: '2026-10-06T08:00:00.000Z', available: true, academicYear, semester, entries, errors: [] });
    assert.match(md, /\| 落選（×） \| サンプル倫理学Ａ \|/);
    assert.match(md, /\| 当選（○） \|/);
    assert.match(md, /\| 未発表 \|/);
    assert.match(md, /取得できた/);
    const unavailable = buildLotteryMarkdown({ fetchedAt: '2026-10-06T08:00:00.000Z', available: false, academicYear: null, semester: null, entries: [], errors: ['使用可能対象外'] });
    assert.match(unavailable, /画面が開けなかった/);
    assert.match(unavailable, /## エラー\n- 使用可能対象外/);
  });
});
