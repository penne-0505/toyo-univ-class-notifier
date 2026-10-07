/**
 * ToyoNet-ACE の未提出課題一覧・お知らせ（コースニュース）の純粋なパース部分の検査。
 *   scripts/fetch/toyonet-ace.ts の toAssignment（DOM から取った行 → 課題）
 *   scripts/fetch/toyo-announcements.ts の parseDetailText / categorize / extractDateHint / toJstIso
 * DOM を読むブラウザ側のコードはここでは検査しない。fixtures は合成データ。
 * Usage: npx tsx --test scripts/dev/parsers/ace-feeds.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PendingAssignmentRow, toAssignment } from '../../fetch/toyonet-ace';
import { categorize, extractDateHint, parseDetailText, toJstIso } from '../../fetch/toyo-announcements';
import { readFixture, readJsonFixture } from './helpers';

describe('toAssignment（未提出課題一覧の行）', () => {
  const rows = readJsonFixture<PendingAssignmentRow[]>('ace-pending-assignments.json');
  const assignments = rows.map(toAssignment);

  it('タイトルが空白だけの行は課題にしない', () => {
    assert.equal(assignments[3], null);
  });

  it('リンクがある行: 課題 ID はリンクの末尾、締切は JST、状態は pending', () => {
    assert.deepEqual(assignments[0], {
      assignmentId: 'course_99000001_report_9000012',
      courseName: 'サンプル統計学B2',
      title: '第２回リフレクション',
      dueAt: '2026-10-11T23:00:00+09:00',
      status: 'pending',
      sourceUrl: 'https://www.ace.toyo.ac.jp/ct/course_99000001_report_9000012',
      notes: ['タイプ: レポート', '受付開始: 2026-10-05T09:00:00+09:00', '受付期間: 2026-10-05 09:00 ～ 2026-10-11 23:00'],
    });
  });

  it('リンクが無い行は「科目名:タイトル」から ID を作り、sourceUrl は null', () => {
    const item = assignments[2]!;
    assert.equal(item.assignmentId, 'デモ演習C1:授業アンケート');
    assert.equal(item.sourceUrl, null);
    assert.equal(item.dueAt, null);
    assert.deepEqual(item.notes, ['タイプ: アンケート']);
  });

  it('全角・半角の空白が混ざったタイトル・科目名は 1 個の半角空白にそろえる', () => {
    const item = toAssignment({
      type: '小テスト',
      title: '第３回　ミニッツ  ペーパー',
      courseName: '架空の経営学Ａ ',
      opensAtRaw: '',
      dueAtRaw: '2026-10-12 19:55',
      periodRaw: '',
      assignmentHref: null,
    })!;
    assert.equal(item.title, '第３回 ミニッツ ペーパー');
    assert.equal(item.courseName, '架空の経営学Ａ');
  });

  it('受付開始が日時として読めないときは原文を notes に残す', () => {
    const item = toAssignment({ type: 'レポート', title: 't', courseName: 'c', opensAtRaw: '随時', dueAtRaw: '', periodRaw: '', assignmentHref: null })!;
    assert.deepEqual(item.notes, ['タイプ: レポート', '受付開始: 随時']);
  });
});

describe('parseDetailText（コースニュースのリマインダ本文）', () => {
  // 呼び出し側（collectToyoNetAceAnnouncements）と同じく、空白を 1 個にそろえてから渡す
  const flattened = readFixture('ace-announcement-detail.txt').replace(/\s+/g, ' ').trim();

  it('[タイトル] と PC の URL を取る', () => {
    assert.deepEqual(parseDetailText(flattened), {
      title: '【休講】第3回講義資料について（公開しました）',
      newsUrl: 'https://www.ace.toyo.ac.jp/ct/course_99000001_news_9000051',
    });
  });

  it('改行のままでも [作成者] の手前までを取る', () => {
    const raw = readFixture('ace-announcement-detail.txt');
    assert.equal(parseDetailText(raw).title, '【休講】第3回講義資料について（公開しました）');
  });

  it('区切りが罫線だけで次の [] が無くても、罫線の手前で切る', () => {
    assert.equal(parseDetailText('[タイトル] : 教室変更のお知らせ -------------------- ToyoNet-ACE にログイン').title, '教室変更のお知らせ');
  });

  it('全角コロンでも読む', () => {
    assert.equal(parseDetailText('[タイトル]：補講のお知らせ [作成者] : x').title, '補講のお知らせ');
  });

  it('タイトルも URL も無ければ null', () => {
    assert.deepEqual(parseDetailText('ログインしてください'), { title: null, newsUrl: null });
  });

  it('PC の URL がコースの URL でなければ取らない', () => {
    assert.equal(parseDetailText('PC : https://example.invalid/ct/course_1_news_2').newsUrl, null);
  });
});

describe('categorize', () => {
  it('休講 / 補講 / 教室変更（教室移動も） / その他', () => {
    assert.equal(categorize('【休講】第3回'), '休講');
    assert.equal(categorize('第5回は補講日です'), '補講');
    assert.equal(categorize('教室変更のお知らせ'), '教室変更');
    assert.equal(categorize('教室移動について'), '教室変更');
    assert.equal(categorize('第3回授業資料につきまして'), 'その他');
  });

  it('休講と補講が両方あるときは休講を優先する', () => {
    assert.equal(categorize('休講に伴う補講について'), '休講');
  });
});

describe('extractDateHint', () => {
  it('YYYY/M/D・YYYY-MM-DD を YYYY-MM-DD にそろえる', () => {
    assert.equal(extractDateHint('2026/10/7 は休講です'), '2026-10-07');
    assert.equal(extractDateHint('補講: 2026-11-04'), '2026-11-04');
  });

  it('日付が無ければ null', () => {
    assert.equal(extractDateHint('10月7日は休講です'), null);
  });
});

describe('toJstIso（お知らせの送信日時）', () => {
  it('日時は JST の ISO にする（分までの表記は秒を補わない）。日付だけなら 0 時', () => {
    assert.equal(toJstIso('2026-10-07 11:25'), '2026-10-07T11:25+09:00');
    assert.equal(toJstIso('2026-10-07 11:25:30'), '2026-10-07T11:25:30+09:00');
    assert.equal(toJstIso('2026-10-07'), '2026-10-07T00:00:00+09:00');
  });

  it('日時でなければ null', () => {
    assert.equal(toJstIso(''), null);
    assert.equal(toJstIso('昨日'), null);
  });
});
