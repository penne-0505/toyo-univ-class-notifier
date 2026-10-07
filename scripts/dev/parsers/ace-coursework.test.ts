/**
 * ToyoNet-ACE のコース別提出状況（scripts/fetch/toyonet-ace-coursework.ts の純粋関数）の検査。
 * 入力はブラウザ側スクリプトが DOM から作る行の形（PageRow など）。fixtures/ace-coursework-pages.json は合成データ。
 * Usage: npx tsx --test scripts/dev/parsers/ace-coursework.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type PageRow,
  matchRegisteredCourse,
  parseCourseCodes,
  parseGrades,
  parseItemRow,
  parseStatus,
  parseSubmitLog,
  type SubmitLogSnapshot,
} from '../../fetch/toyonet-ace-coursework';
import { toJstIso } from '../../fetch/toyonet-ace';
import { courseKey } from '../../lib/course-key';
import { readJsonFixture } from './helpers';

type Pages = {
  report: { codeText: string; courseName: string; rows: PageRow[] };
  query: { codeText: string; courseName: string; rows: PageRow[] };
  survey: { codeText: string; courseName: string; rows: PageRow[] };
  grades: { grades: Array<{ title: string; score: string; note: string }> };
  submitlog: SubmitLogSnapshot;
};
const pages = readJsonFixture<Pages>('ace-coursework-pages.json');
const COURSE_ID = '99000001';
const itemsOf = (rows: PageRow[]) => rows.map((r) => parseItemRow(r, COURSE_ID)).filter((item) => item !== null);

describe('parseCourseCodes', () => {
  it('単独の授業コード', () => {
    assert.deepEqual(parseCourseCodes('9910102001'), ['9910102001']);
  });

  it('ACE は 1 コースに複数の授業コードを持つことがある（カンマ・読点・空白区切り）', () => {
    assert.deepEqual(parseCourseCodes('9810222007, 9910133001'), ['9810222007', '9910133001']);
    assert.deepEqual(parseCourseCodes('9810222007、9910133001'), ['9810222007', '9910133001']);
    assert.deepEqual(parseCourseCodes('9810222007 9910133001'), ['9810222007', '9910133001']);
  });

  it('英字を含む授業コードと NBSP 区切り', () => {
    assert.deepEqual(parseCourseCodes('XJ99900003 9910133001'), ['XJ99900003', '9910133001']);
  });

  it('コードでないもの（短すぎる語・記号）と空文字は捨てる', () => {
    assert.deepEqual(parseCourseCodes(''), []);
    assert.deepEqual(parseCourseCodes('授業コードなし'), []);
    assert.deepEqual(parseCourseCodes('12345, 9910102001'), ['9910102001']);
  });
});

describe('parseStatus', () => {
  it('受付中 / 受付開始待ち / 受付終了', () => {
    assert.equal(parseStatus('受付中 未提出'), 'open');
    assert.equal(parseStatus('受付開始待ち'), 'waiting');
    assert.equal(parseStatus('受付終了 提出済み'), 'closed');
  });

  it('どれでもなければ unknown', () => {
    assert.equal(parseStatus('提出済み'), 'unknown');
    assert.equal(parseStatus(''), 'unknown');
  });

  it('「受付開始待ち」「受付終了」は「受付中」より優先する（文言の一部に重なっても）', () => {
    assert.equal(parseStatus('受付開始待ち（受付中になるまでお待ちください）'), 'waiting');
    assert.equal(parseStatus('受付終了（受付中ではありません）'), 'closed');
  });
});

describe('parseItemRow', () => {
  const reports = itemsOf(pages.report.rows);

  it('見出し行・リンクの無い行は項目にしない', () => {
    assert.equal(parseItemRow(pages.report.rows[0], COURSE_ID), null);
    assert.equal(reports.length, 4);
  });

  it('受付中・未提出', () => {
    const item = reports.find((i) => i.itemId === '9000012')!;
    assert.equal(item.type, 'report');
    assert.equal(item.title, '第2回レポート');
    assert.equal(item.status, 'open');
    assert.equal(item.submitted, false);
    assert.equal(item.opensAt, '2026-10-05T18:15:00+09:00');
    assert.equal(item.dueAt, '2026-10-12T19:55:00+09:00');
    assert.equal(item.url, 'https://www.ace.toyo.ac.jp/ct/course_99000001_report_9000012');
  });

  it('受付終了・提出済み', () => {
    const item = reports.find((i) => i.itemId === '9000011')!;
    assert.equal(item.status, 'closed');
    assert.equal(item.submitted, true);
  });

  it('受付開始待ちは未提出とみなす', () => {
    const item = reports.find((i) => i.itemId === '9000013')!;
    assert.equal(item.status, 'waiting');
    assert.equal(item.submitted, false);
  });

  it('受付終了・未提出（期限切れ）', () => {
    const item = reports.find((i) => i.itemId === '9000014')!;
    assert.equal(item.status, 'closed');
    assert.equal(item.submitted, false);
  });

  it('秒つきの日時も JST の ISO にする', () => {
    const item = reports.find((i) => i.itemId === '9000014')!;
    assert.equal(item.opensAt, '2026-09-21T00:00:00+09:00');
    assert.equal(item.dueAt, '2026-09-27T23:59:59+09:00');
  });

  it('drill（Web 確認テストなど）は小テスト一覧に並ぶので query 扱い。「未受験」は未提出', () => {
    const queries = itemsOf(pages.query.rows);
    assert.equal(queries.length, 3);
    const drill = queries.find((i) => i.itemId === '9000022')!;
    assert.equal(drill.type, 'query');
    assert.equal(drill.submitted, false);
    assert.equal(drill.status, 'open');
    assert.ok(drill.url.endsWith('course_99000001_drill_9000022'));
  });

  it('アンケート（survey）', () => {
    const [survey] = itemsOf(pages.survey.rows);
    assert.equal(survey.type, 'survey');
    assert.equal(survey.status, 'closed');
    assert.equal(survey.submitted, false);
  });

  it('別コースの項目（コース ID が違うリンク）は採用しない', () => {
    const row = pages.survey.rows.find((r) => r.text.startsWith('他コース'))!;
    assert.equal(parseItemRow(row, COURSE_ID), null);
    assert.equal(parseItemRow(row, '99000002')?.itemId, '9000032');
  });

  it('提出済みを表す各種の文言を提出済みとして読む', () => {
    for (const word of ['提出済み', '提出完了', '採点済み', '回答済み', '受験済み', '評価済み']) {
      const row: PageRow = {
        head: [],
        cells: ['第9回課題', `受付終了 ${word}`, '2026-10-01 00:00', '2026-10-02 00:00'],
        anchors: [{ href: 'course_99000001_report_9000099', text: '第9回課題' }],
        text: '',
      };
      assert.equal(parseItemRow(row, COURSE_ID)!.submitted, true, word);
    }
  });

  it('状態が読めず提出の記載もないときは submitted が null', () => {
    const row: PageRow = {
      head: [],
      cells: ['第9回課題', '受付中', '2026-10-01 00:00', '2026-10-02 00:00'],
      anchors: [{ href: 'course_99000001_report_9000099', text: '第9回課題' }],
      text: '',
    };
    const item = parseItemRow(row, COURSE_ID)!;
    assert.equal(item.status, 'open');
    assert.equal(item.submitted, null);
  });

  it('日時が無い・形式が違うときは null', () => {
    const row: PageRow = {
      head: [],
      cells: ['第9回課題', '受付開始待ち', '未定', ''],
      anchors: [{ href: 'course_99000001_report_9000099', text: '第9回課題' }],
      text: '',
    };
    const item = parseItemRow(row, COURSE_ID)!;
    assert.equal(item.opensAt, null);
    assert.equal(item.dueAt, null);
  });
});

describe('parseGrades', () => {
  const grades = parseGrades(pages.grades);

  it('タイトルが空の行は捨てる', () => {
    assert.deepEqual(grades.map((g) => g.title), ['第1回小テスト', '第2回レポート', '最終レポート']);
  });

  it('得点は文字列のまま。「-」と空は null（未採点）', () => {
    assert.deepEqual(grades.map((g) => g.score), ['8', null, null]);
  });

  it('補足（平均点・採点中など）は note。空は null', () => {
    assert.deepEqual(grades.map((g) => g.note), ['平均 7.2', null, '採点中']);
  });

  it('成績が 1 件も無ければ空配列', () => {
    assert.deepEqual(parseGrades({ grades: [] }), []);
  });
});

describe('parseSubmitLog', () => {
  const log = parseSubmitLog(pages.submitlog);

  it('項目リンクのある行だけを読む（コースのお知らせなどは捨てる）', () => {
    assert.equal(log.length, 3);
  });

  it('日付と時刻を JST の ISO にし、コース名の [] を外す', () => {
    assert.deepEqual(log[0], {
      courseId: '99000001',
      type: 'report',
      itemId: '9000011',
      title: '第１回レポート',
      courseName: 'サンプル統計学B2',
      submittedAt: '2026-10-07T21:45:00+09:00',
    });
    assert.equal(log[1].type, 'query');
  });

  it('コースへのリンクが無い行は courseName が null', () => {
    assert.equal(log[2].courseName, null);
    assert.equal(log[2].courseId, '99000003');
  });
});

describe('matchRegisteredCourse / ACE の科目名の全角半角揺れ', () => {
  const registered = [
    { courseCode: '9910102001', courseName: 'サンプル統計学Ｂ２' },
    { courseCode: 'XJ99900003', courseName: 'ＺＱ入門【オンデマンド】' },
    { courseCode: '9930102001', courseName: 'サンプル　行動論' },
  ] as unknown as Parameters<typeof matchRegisteredCourse>[2];

  it('授業コードが一致すれば名前は見ない', () => {
    assert.equal(matchRegisteredCourse(['9910102001'], 'まったく違う名前', registered)?.courseName, 'サンプル統計学Ｂ２');
  });

  it('授業コードの大文字小文字は区別しない', () => {
    assert.equal(matchRegisteredCourse(['xj99900003'], '', registered)?.courseCode, 'XJ99900003');
  });

  it('回帰: コードが無くても、ACE の「サンプル統計学B2」（半角）と登録の「サンプル統計学Ｂ２」（全角）が突き合う', () => {
    assert.equal(matchRegisteredCourse([], 'サンプル統計学B2', registered)?.courseCode, '9910102001');
  });

  it('回帰: 全角英字・全角空白・【】の揺れ（ＺＱ入門 / ZQ入門、サンプル　行動論 / サンプル 行動論）', () => {
    assert.equal(matchRegisteredCourse([], 'ZQ入門【オンデマンド】', registered)?.courseCode, 'XJ99900003');
    assert.equal(matchRegisteredCourse([], 'サンプル 行動論', registered)?.courseCode, '9930102001');
  });

  it('どちらにも当たらなければ null（学部のお知らせ用コースなど）', () => {
    assert.equal(matchRegisteredCourse(['0000000000'], '【2026】サンプル学部', registered), null);
  });

  it('courseKey は全角半角・空白の揺れを吸収するが、別の科目は区別する', () => {
    assert.equal(courseKey('サンプル統計学B2'), courseKey('サンプル統計学Ｂ２'));
    assert.notEqual(courseKey('サンプル統計学B2'), courseKey('サンプル統計学B1'));
  });
});

describe('toJstIso（ACE の日時表記）', () => {
  it('分までの表記は秒 0 で補う', () => {
    assert.equal(toJstIso('2026-10-05 21:25'), '2026-10-05T21:25:00+09:00');
  });

  it('秒つきはそのまま', () => {
    assert.equal(toJstIso('2026-10-05 21:25:30'), '2026-10-05T21:25:30+09:00');
  });

  it('前後・途中の余分な空白を許す。日時でなければ null', () => {
    assert.equal(toJstIso('  2026-10-05   21:25 '), '2026-10-05T21:25:00+09:00');
    assert.equal(toJstIso('2026-10-05'), null);
    assert.equal(toJstIso(''), null);
    assert.equal(toJstIso('受付開始待ち'), null);
  });
});
