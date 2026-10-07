/**
 * 履修登録確認表（scripts/fetch/toyo-enrollment.ts の parseEnrollmentText）と、
 * 登録画面が開けないときの案内文（scripts/fetch/registration-candidates.ts の describeUnavailableScreen）の検査。
 * Usage: npx tsx --test scripts/dev/parsers/enrollment.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEnrollmentText } from '../../fetch/toyo-enrollment';
import { describeUnavailableScreen } from '../../fetch/registration-candidates';
import { readFixture } from './helpers';

const T = '\t';
const row = (...cells: string[]): string => cells.join(T);
const pageTitle = '履修登録確認表照会／Course Registration Confirmation';
const header = row('曜日', '時限', '学期', '', '授業コード', '科目ナンバリング', '科目名', '実施形態', '担当者', '教室', 'キャンパス', '単位');

describe('parseEnrollmentText: 合成した確認表', () => {
  const parsed = parseEnrollmentText(readFixture('enrollment-confirmation.txt'), pageTitle);
  const byCode = (code: string) => parsed.courses.find((c) => c.courseCode === code)!;

  it('見出し（学籍番号・氏名・開講年度）を読む', () => {
    assert.equal(parsed.fetchStatus, 'success');
    assert.equal(parsed.pageTitle, pageTitle);
    assert.equal(parsed.studentNumber, '9999999999');
    assert.equal(parsed.studentNameKana, 'テスト　タロウ');
    assert.equal(parsed.studentName, '架空　太郎');
    assert.equal(parsed.academicYear, '2026');
  });

  it('全科目を取りこぼさない（通常行 + 継続行 + 集中行 + 集中の継続行）', () => {
    assert.equal(parsed.courses.length, 11);
    assert.equal(new Set(parsed.courses.map((c) => c.courseCode)).size, 11);
  });

  it('通常行: 曜日・時限・学期・授業コード・科目名などを位置で読む', () => {
    assert.deepEqual(byCode('9910101001'), {
      semesterLabel: '春学期',
      day: '月',
      period: '6', // 全角「６」は半角にする
      term: '春',
      courseCode: '9910101001',
      numbering: 'ZZZ101',
      courseName: 'サンプル統計学Ａ２',
      deliveryMode: '対面',
      instructor: '架空　一郎',
      room: '9101',
      campus: '白山',
      credits: 2,
    });
  });

  it('同じ曜日の継続行（先頭の曜日が空）は直前の曜日を引き継ぐ', () => {
    const second = byCode('9930101001');
    assert.equal(second.day, '月');
    assert.equal(second.period, '7');
    assert.equal(second.term, '春');
    assert.equal(second.semesterLabel, '春学期');
    assert.equal(byCode('9930101002').day, '水');
    assert.equal(byCode('9930101003').day, '土');
  });

  it('学期の見出し（春学期 / 秋学期）で semesterLabel が切り替わる', () => {
    const labels = parsed.courses.map((c) => c.semesterLabel);
    assert.deepEqual(labels, ['春学期', '春学期', '春学期', '春学期', '春学期', '春学期', '秋学期', '秋学期', '秋学期', '秋学期', '秋学期']);
    assert.equal(byCode('9910102001').term, '秋');
  });

  it('回帰（2026-09）: 「集中その他」行とその継続行を取りこぼさない。day は「集中」、period は空', () => {
    const intensive = parsed.courses.filter((c) => c.day === '集中');
    assert.deepEqual(
      intensive.map((c) => c.courseCode),
      ['9G00102001', '9910102009', 'XJ99900003']
    );
    for (const course of intensive) {
      assert.equal(course.period, '');
      assert.equal(course.semesterLabel, '秋学期');
      assert.equal(course.credits, 2);
    }
    // 継続行も科目名・担当者・教室・キャンパスを位置どおりに読めている
    assert.equal(byCode('XJ99900003').courseName, 'ＺＱ入門【オンデマンド】');
    assert.equal(byCode('XJ99900003').numbering, 'ZZZ303');
    assert.equal(byCode('XJ99900003').deliveryMode, '非オ');
    assert.equal(byCode('XJ99900003').campus, '別キャンパス');
  });

  it('「注）」以降は読まない', () => {
    const withTrailing = `${readFixture('enrollment-confirmation.txt')}${row('月', '6', '秋', '', '9910109999', 'ZZZ999', '注の後の行', '対面', '架空', '1', '白山', '2')}\n`;
    assert.equal(parseEnrollmentText(withTrailing, pageTitle).courses.length, 11);
  });
});

describe('parseEnrollmentText: 個別のケース', () => {
  const wrap = (...lines: string[]): string => ['履修登録確認表照会', '開講年度\t2026', header, ...lines].join('\n');

  it('全角数字の時限・単位を半角にする', () => {
    const text = wrap('春学期', row('火', '６', '春', '', '9910100001', 'ZZZ001', 'サンプル論理学Ａ', '対面', '架空', '9101', '白山', '２'));
    const [course] = parseEnrollmentText(text, pageTitle).courses;
    assert.equal(course.period, '6');
    assert.equal(course.credits, 2);
  });

  it('時限が全角の継続行（曜日なし）も時限を読む', () => {
    const text = wrap(
      '秋学期',
      row('金', '６', '秋', '', '9910100002', 'ZZZ002', 'サンプル論理学Ｂ', '対面', '架空', '9101', '白山', '2'),
      row('７', '秋', '', '9910100003', 'ZZZ003', 'サンプル地理学Ａ', '対面', '架空', '9102', '白山', '2')
    );
    const courses = parseEnrollmentText(text, pageTitle).courses;
    assert.deepEqual(courses.map((c) => [c.day, c.period]), [['金', '6'], ['金', '7']]);
  });

  it('同一科目の 2 コマ目の単位「※」は 0 単位として読む（合計で二重に数えない）', () => {
    const text = wrap(
      '春学期',
      row('月', '6', '春', '', '9910100004', 'ZZZ004', 'デモ演習C1', '対面', '架空', '9101', '白山', '2'),
      row('7', '春', '', '9910100004', 'ZZZ004', 'デモ演習C1', '対面', '架空', '9101', '白山', '※')
    );
    assert.deepEqual(parseEnrollmentText(text, pageTitle).courses.map((c) => c.credits), [2, 0]);
  });

  it('列が足りない行・授業コードが無い行・科目名が空の行は捨てる', () => {
    const text = wrap(
      '春学期',
      row('月', '6', '春', '', '9910100006', 'ZZZ006', 'サンプル統計学Ａ２', '対面'), // 列が足りない
      row('月', '6', '春', '', 'abc', 'ZZZ006', 'サンプル統計学Ａ２', '対面', '架空', '9101', '白山', '2'), // コードが 10 桁の英大文字・数字でない
      row('月', '6', '春', '', '9910100007', 'ZZZ007', '', '対面', '架空', '9101', '白山', '2') // 科目名が空
    );
    assert.equal(parseEnrollmentText(text, pageTitle).courses.length, 0);
  });

  it('NBSP が混ざっても読める', () => {
    const text = wrap('春学期', row('月', '6', '春', '', '9910100008', 'ZZZ008', 'サンプル統計学Ａ２', '対面', '架空 一郎', '9101', '白山', '2')).replace('開講年度\t2026', '開講年度 2026');
    const parsed = parseEnrollmentText(text, pageTitle);
    assert.equal(parsed.academicYear, '2026');
    assert.equal(parsed.courses[0].instructor, '架空 一郎');
  });
});

describe('parseEnrollmentText: fetchStatus', () => {
  const okBody = readFixture('enrollment-confirmation.txt');

  it('タイトルが「システムエラー」→ error（本文に科目があっても）', () => {
    assert.equal(parseEnrollmentText(okBody, 'システムエラー').fetchStatus, 'error');
  });

  it('タイトルが「タイムアウト」→ error', () => {
    assert.equal(parseEnrollmentText('', 'セッションタイムアウト').fetchStatus, 'error');
  });

  it('科目が 0 件 → empty', () => {
    assert.equal(parseEnrollmentText(`履修登録確認表照会\n開講年度\t2026\n${header}\n春学期\n`, pageTitle).fetchStatus, 'empty');
    assert.equal(parseEnrollmentText('', pageTitle).fetchStatus, 'empty');
  });

  it('見出しが無くても落ちない（学籍番号・氏名・開講年度は空）', () => {
    const parsed = parseEnrollmentText('何もない画面', pageTitle);
    assert.equal(parsed.studentNumber, '');
    assert.equal(parsed.studentName, '');
    assert.equal(parsed.studentNameKana, '');
    assert.equal(parsed.academicYear, '');
  });
});

describe('describeUnavailableScreen', () => {
  const notOpenText = 'エラー\n\nこの機能は使用可能対象外です。\n  戻る';

  it('回帰: 追加登録期間の画面が「使用可能対象外」のとき、期間外の案内を返す（セッション切れの案内ではない）', () => {
    const message = describeUnavailableScreen('add', notOpenText);
    assert.match(message, /追加登録期間の画面は現在「使用可能対象外」です/);
    assert.match(message, /期間になってから再実行してください/);
    assert.doesNotMatch(message, /toyo:login/);
  });

  it('正規登録期間でも同じ判定で、ラベルだけが変わる', () => {
    const message = describeUnavailableScreen('regular', notOpenText);
    assert.match(message, /正規登録期間の画面は現在「使用可能対象外」です/);
    assert.doesNotMatch(message, /追加登録期間/);
  });

  it('「Request Error」も期間外として扱う', () => {
    assert.match(describeUnavailableScreen('add', 'Request Error'), /使用可能対象外/);
  });

  it('システムエラー・不正な操作は、ログインし直す案内にする', () => {
    for (const text of ['システムエラーが発生しました', '不正な操作が行われました', '認証エラー']) {
      const message = describeUnavailableScreen('regular', text);
      assert.match(message, /開けませんでした/);
      assert.match(message, /npm run toyo:login/);
      assert.doesNotMatch(message, /使用可能対象外/);
    }
  });

  it('画面の表示は空白をつぶして先頭 120 文字だけ付ける', () => {
    const long = `この機能は使用可能対象外です。\n${'あ'.repeat(300)}`;
    const message = describeUnavailableScreen('add', long);
    const shown = message.split('\n画面の表示: ')[1];
    assert.equal(shown.length, 120);
    assert.ok(shown.startsWith('この機能は使用可能対象外です。 ああ'));
  });
});
