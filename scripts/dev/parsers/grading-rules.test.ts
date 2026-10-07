/**
 * シラバスの「成績評価の方法・基準」から配分・足切りを読む正規表現ベースの下書き抽出
 * （scripts/lib/toyo-grading-rules.ts）の検査。
 * 文章は大学が公開しているシラバスの成績評価欄の記述に基づく（科目名・担当者を含まない範囲の抜粋・一部改変）。
 * 抽出は下書きで、人が原文と見比べて直す前提。ここでは「正しく読めるべきもの」だけを固定する。
 * Usage: npx tsx --test scripts/dev/parsers/grading-rules.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type GradingComponentKind,
  type GradingRulesFile,
  classifyKind,
  draftGradingRule,
  extractComponents,
  extractCutoffs,
  extractRetake,
  totalWarnings,
  weightTotals,
} from '../../lib/toyo-grading-rules';
import { readJsonFixture } from './helpers';

const brief = (text: string) => extractComponents(text).components.map((c) => [c.name, c.weightPercent, c.kind] as const);

describe('extractComponents: 配点（%）', () => {
  it('全角の数字と％を読む', () => {
    assert.deepEqual(brief('期末試験７０％、小テスト３０％で評価する。'), [
      ['期末試験', 70, 'final-exam'],
      ['小テスト', 30, 'quiz'],
    ]);
  });

  it('「パーセント」表記', () => {
    assert.deepEqual(brief('期末試験 70パーセント、レポート 30パーセント'), [
      ['期末試験', 70, 'final-exam'],
      ['レポート', 30, 'report'],
    ]);
  });

  it('「約70%」は 70 として読む', () => {
    assert.deepEqual(brief('期末試験約70%、授業内小テスト約30%'), [
      ['期末試験', 70, 'final-exam'],
      ['授業内小テスト', 30, 'quiz'],
    ]);
  });

  it('括弧つきの名称と「の評価」「を」などの語尾を整える', () => {
    assert.deepEqual(brief('平常点（出席・参加）20%、期末レポート80%'), [
      ['平常点(出席・参加)', 20, 'attendance'],
      ['期末レポート', 80, 'report'],
    ]);
  });

  it('実際の文面（抜粋・一部改変）: 「小テスト100％（5%×8回、10％×6回）」は毎回の要素で、内訳を note に残す', () => {
    const { components, warnings } = extractComponents('＜成績評価の方法＞小テスト100％（5%×8回、10％×6回）で評価する。＜成績評価の基準＞東洋大学の成績評価基準に準拠する');
    assert.deepEqual(warnings, []);
    assert.equal(components.length, 1);
    assert.equal(components[0].weightPercent, 100);
    assert.equal(components[0].kind, 'quiz');
    assert.equal(components[0].perSession, true);
    assert.equal(components[0].note, '内訳: 5%×8回、10%×6回');
  });

  it('実際の文面（抜粋・一部改変）: 「毎回の課題・・・８４％（６％×１４回）レポート試験・・・１６％」', () => {
    const { components } = extractComponents('毎回の課題・・・８４％（６％×１４回）レポート試験・・・１６％東洋大学の成績評価基準に準拠する。');
    assert.deepEqual(
      components.map((c) => [c.name, c.weightPercent, c.kind, c.perSession, c.note]),
      [
        ['毎回の課題', 84, 'assignment', true, '内訳: 6%×14回'],
        ['レポート試験', 16, 'report', false, ''],
      ]
    );
  });

  it('「6%×14」のような回数つきの括弧は note になり、毎回の要素になる', () => {
    const [component] = extractComponents('毎回のコメントシート 6%×14回、期末試験 16%').components;
    assert.equal(component.perSession, true);
    assert.equal(component.weightPercent, 6);
  });

  it('実際の文面（抜粋・一部改変）: 「毎回の小課題」などの語を含む名称は perSession になる', () => {
    const { components } = extractComponents('「授業参加度（毎回の小課題）」(40%)と「学期末レポート課題」(60%)に基づいて成績評価を行います。');
    assert.deepEqual(components.map((c) => [c.weightPercent, c.kind, c.perSession]), [
      [40, 'participation', true],
      [60, 'report', false],
    ]);
  });

  it('配分が書かれていなければ空配列と警告', () => {
    const result = extractComponents('東洋大学の成績評価基準に準拠して評価する。');
    assert.deepEqual(result.components, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /抽出できなかった/);
  });
});

describe('extractComponents: ①〜⑳ と点数表記', () => {
  it('①②は「(1)」「(2)」に退避してから読む（応用レポート①１５点 → 115点 にならない）', () => {
    const { components } = extractComponents('応用レポート①１５点 応用レポート②２５点 期末試験６０点');
    assert.deepEqual(components.map((c) => [c.name, c.weightPercent]), [
      ['応用レポート(1)', 15],
      ['応用レポート(2)', 25],
      ['期末試験', 60],
    ]);
  });

  it('%表記でも ①② のレポートを別々の要素にする', () => {
    assert.deepEqual(brief('レポート①30％、レポート②30％、期末試験40％'), [
      ['レポート(1)', 30, 'report'],
      ['レポート(2)', 30, 'report'],
      ['期末試験', 40, 'final-exam'],
    ]);
  });

  it('実際の文面（抜粋・一部改変）: 点数表記（20点・40点・40点）は %換算して警告を付ける', () => {
    const { components, warnings } = extractComponents('【成績評価の方法】小テスト（20点）、中間試験（40点）、期末試験（40点）。中間試験、期末試験は講義の状況により、いずれかをレポートとすることもある。');
    assert.deepEqual(components.map((c) => [c.name, c.weightPercent, c.kind]), [
      ['小テスト', 20, 'quiz'],
      ['中間試験', 40, 'midterm'],
      ['期末試験', 40, 'final-exam'],
    ]);
    assert.deepEqual(warnings, ['配点は「点」表記から抽出（合計 100 点）。%換算は要確認。']);
  });

  it('「(10点満点)」「(90点満点)」の括弧つき点数', () => {
    const { components } = extractComponents('小テストの点(10点満点)と期末試験(90点満点)の合計に基づき成績をつけます。');
    assert.deepEqual(components.slice(0, 2).map((c) => [c.name, c.weightPercent, c.kind]), [
      ['小テストの点', 10, 'quiz'],
      ['期末試験', 90, 'final-exam'],
    ]);
  });

  it('「合計 50 点」の宣言があれば 100 点満点に換算する', () => {
    const { components } = extractComponents('期末試験30点、レポート20点 合計50点で評価する。');
    assert.deepEqual(components.map((c) => c.weightPercent), [60, 40]);
  });

  it('範囲表記（80~100点）は配点として読まない', () => {
    assert.deepEqual(extractComponents('期末試験（80~100点）で評価').components, []);
  });

  it('%と点が混在するときは % を優先する（成績基準の点数を配点にしない）', () => {
    const { components } = extractComponents('期末試験70%、小テスト30%。90点以上をS、80点以上をAとする。');
    assert.deepEqual(components.map((c) => c.weightPercent), [70, 30]);
  });
});

describe('classifyKind', () => {
  const cases: Array<[string, GradingComponentKind]> = [
    ['期末試験', 'final-exam'],
    ['学期末試験', 'final-exam'],
    ['定期試験', 'final-exam'],
    ['中間テスト', 'midterm'],
    ['小テスト', 'quiz'],
    ['確認テスト', 'quiz'],
    ['最終レポート', 'report'],
    ['出席点', 'attendance'],
    ['履修確認', 'attendance'],
    ['授業態度', 'participation'],
    ['平常点', 'participation'],
    ['毎回のコメント', 'assignment'],
    ['リフレクション', 'assignment'],
    ['その他', 'other'],
  ];
  for (const [label, kind] of cases) {
    it(`${label} → ${kind}`, () => {
      assert.equal(classifyKind(label), kind);
    });
  }

  it('「小テスト」は「テスト」を含んでも quiz（期末扱いにしない）', () => {
    assert.equal(classifyKind('授業内小テスト'), 'quiz');
  });
});

describe('extractCutoffs: 出席・提出回数', () => {
  it('「3分の2以上」（半角・全角・漢数字）は割合 0.667', () => {
    for (const text of ['授業回数の3分の2以上出席しない場合は評価しない。', '授業回数の３分の２以上の出席が必要。', '授業回数の三分の二以上の出席が必要。']) {
      const [cutoff] = extractCutoffs(text);
      assert.equal(cutoff.type, 'attendance', text);
      assert.equal(cutoff.threshold, 0.667, text);
      assert.equal(cutoff.unit, 'ratio', text);
    }
  });

  it('実際の文面（抜粋・一部改変）: 出席が 3分の2以上（全15回中10回以上）', () => {
    const cutoffs = extractCutoffs('授業への出席は、毎回の小課題の提出状況により判断します。出席回数（毎回の小課題の提出）を3分の2以上（全15回中10回以上）を満たしていない場合は、成績評価対象外となります。');
    assert.equal(cutoffs.length, 1);
    assert.equal(cutoffs[0].type, 'attendance');
    assert.equal(cutoffs[0].threshold, 0.667);
    assert.equal(cutoffs[0].unit, 'ratio');
  });

  it('「3分の1を超えて欠席」「1/3を超えて欠席」は出席必要割合 0.667 に直す', () => {
    assert.equal(extractCutoffs('3分の1を超えて欠席した場合は単位を認めない。')[0].threshold, 0.667);
    assert.equal(extractCutoffs('１／３を超えて欠席した者は不可とする。')[0].threshold, 0.667);
  });

  it('「欠席が5回以上」は回数 5', () => {
    const [cutoff] = extractCutoffs('欠席が５回以上になった場合、単位不可となります。');
    assert.deepEqual([cutoff.type, cutoff.threshold, cutoff.unit], ['attendance', 5, 'count']);
  });

  it('「出席が10回以上」は回数 10', () => {
    const [cutoff] = extractCutoffs('出席回数が10回以上であること。');
    assert.deepEqual([cutoff.type, cutoff.threshold, cutoff.unit], ['attendance', 10, 'count']);
  });

  it('実際の文面（抜粋・一部改変）: 「小テストの提出回数が10回未満の場合は、評価対象外」は提出回数の足切り（同じ文の汎用の足切りは重ねない）', () => {
    const cutoffs = extractCutoffs('講義後の小テストの点数（70%）と、期末試験（30%）の合計で、総合判断する。なお、小テストの提出回数が10回未満の場合は、評価対象外となるので注意すること。');
    assert.deepEqual(cutoffs, [
      {
        type: 'submission-count',
        text: 'なお、小テストの提出回数が10回未満の場合は、評価対象外となるので注意すること。',
        threshold: 10,
        unit: 'count',
      },
    ]);
  });

  it('提出が「10回以上」を前提とする文と、3分の2の出席が同じ文にあれば、両方の足切りを出す', () => {
    const cutoffs = extractCutoffs('レポート課題の提出が10回以上であることを前提とし(全授業数の三分の2以上)、期末試験の成績で判断する。');
    assert.deepEqual(cutoffs.map((c) => [c.type, c.threshold, c.unit]), [
      ['attendance', 0.667, 'ratio'],
      ['submission-count', 10, 'count'],
    ]);
  });

  it('実際の文面（抜粋・一部改変）: 「評価対象外：出席・試験・レポート提出等の評価要件の欠格」は other', () => {
    const [cutoff] = extractCutoffs('＊ 評価対象外 ：出席・試験・レポート提出等の評価要件の欠格。');
    assert.equal(cutoff.type, 'other');
    assert.equal(cutoff.threshold, null);
    assert.equal(cutoff.unit, null);
  });
});

describe('extractCutoffs: 試験必須・その他', () => {
  it('試験を受けなかった場合 / 平常点・レポートのみでは評価しない → exam-required', () => {
    assert.equal(extractCutoffs('期末試験を受けなかった場合は不合格とする。')[0].type, 'exam-required');
    assert.equal(extractCutoffs('レポートのみでは単位を認めない。')[0].type, 'exam-required');
  });

  it('「10回未満は評価対象外」（何の回数か書かれていない）は other。数値は取らない', () => {
    assert.deepEqual(extractCutoffs('10回未満は評価対象外'), [{ type: 'other', text: '10回未満は評価対象外', threshold: null, unit: null }]);
  });

  it('未提出は 0 点 → other', () => {
    assert.equal(extractCutoffs('未提出の課題は0点とする。')[0].type, 'other');
  });

  it('足切りの記載が無ければ空配列', () => {
    assert.deepEqual(extractCutoffs('東洋大学の成績評価基準に準拠する。'), []);
    assert.deepEqual(extractCutoffs(''), []);
  });

  it('長い文は 160 文字で切る', () => {
    const long = `${'あ'.repeat(200)}欠席が5回以上の場合は単位不可。`;
    const [cutoff] = extractCutoffs(long);
    assert.equal(cutoff.text.length, 160);
    assert.ok(cutoff.text.endsWith('…'));
    assert.equal(cutoff.threshold, 5);
  });
});

describe('extractRetake', () => {
  it('再試験・追試・再評価・再提出・再履修を含む文を返す', () => {
    assert.equal(extractRetake('やむを得ない事由の場合は追試験を行う。成績評価は東洋大学の基準に準拠する。'), 'やむを得ない事由の場合は追試験を行う。');
    assert.equal(extractRetake('期末試験70%。再試験は実施しない。'), '再試験は実施しない。');
    assert.equal(extractRetake('レポートの再提出を認める。'), 'レポートの再提出を認める。');
  });

  it('記載が無ければ null', () => {
    assert.equal(extractRetake('東洋大学の成績評価基準に準拠する。'), null);
    assert.equal(extractRetake(''), null);
  });
});

describe('weightTotals / totalWarnings / draftGradingRule', () => {
  const comp = (name: string, weightPercent: number | null, scenario: string | null = null) => ({
    name,
    weightPercent,
    kind: 'other' as const,
    perSession: false,
    scenario,
    note: '',
  });

  it('案が無ければ全要素の合計を空の名前で返す', () => {
    assert.deepEqual([...weightTotals([comp('a', 60), comp('b', 40)])], [['', { total: 100, unknown: 0 }]]);
  });

  it('案ごとに「共通 + その案」で合計する', () => {
    const totals = weightTotals([comp('共通', 30), comp('試験', 70, '試験あり'), comp('レポート', 70, '試験なし')]);
    assert.deepEqual(totals.get('試験あり'), { total: 100, unknown: 0 });
    assert.deepEqual(totals.get('試験なし'), { total: 100, unknown: 0 });
  });

  it('配点が null の要素は合計に入れず unknown に数える', () => {
    assert.deepEqual(weightTotals([comp('a', 50), comp('b', null)]).get(''), { total: 50, unknown: 1 });
  });

  it('合計が 100 でない / 配点不明があれば警告。ちょうど 100 なら警告なし', () => {
    assert.deepEqual(totalWarnings([comp('a', 60), comp('b', 40)]), []);
    assert.deepEqual(totalWarnings([comp('a', 60), comp('b', 30)]), ['配分の合計が 100 になっていない: 合計 90%。']);
    assert.deepEqual(totalWarnings([comp('a', 50), comp('b', null)]), ['配分の合計が 100 になっていない: 合計 50%、配点不明 1 件。']);
    assert.match(totalWarnings([comp('共通', 30), comp('試験', 60, '試験あり')])[0], /（試験あり）/);
  });

  it('draftGradingRule は未レビューの下書き（reviewed: false）で原文を sourceText に残す', () => {
    const grading = '期末試験70％、小テスト30％で評価する。授業回数の3分の2以上の出席が必要。再試験は実施しない。';
    const draft = draftGradingRule({
      courseCode: '9910102001',
      scheduleCd: null,
      courseName: 'サンプル統計学Ｂ２',
      semester: '秋学期',
      enrollment: 'registered',
      grading,
    });
    assert.equal(draft.reviewed, false);
    assert.equal(draft.sourceText, grading);
    assert.deepEqual(draft.components.map((c) => c.weightPercent), [70, 30]);
    assert.equal(draft.cutoffs[0].threshold, 0.667);
    assert.equal(draft.retake, '再試験は実施しない。');
    assert.deepEqual(draft.warnings, []);
  });

  it('配分が読めない下書きには警告が 2 つ付く（抽出失敗 + 合計が 100 でない）', () => {
    const draft = draftGradingRule({ courseCode: 'x', scheduleCd: null, courseName: 'x', semester: '春学期', enrollment: 'reference', grading: '準拠する。' });
    assert.equal(draft.warnings.length, 2);
  });
});

describe('data/grading-rules.example.json（架空の科目だけの見本）', () => {
  const example = readJsonFixture<GradingRulesFile>('../../../data/grading-rules.example.json');
  const kinds = new Set(['final-exam', 'midterm', 'quiz', 'report', 'assignment', 'participation', 'attendance', 'other']);
  const cutoffTypes = new Set(['attendance', 'submission-count', 'exam-required', 'other']);

  it('スキーマの全フィールドを持つ', () => {
    assert.equal(example.schemaVersion, 1);
    assert.ok(example.courses.length >= 3);
    for (const course of example.courses) {
      for (const key of ['courseCode', 'scheduleCd', 'courseName', 'semester', 'enrollment', 'components', 'cutoffs', 'retake', 'sourceText', 'reviewed', 'warnings']) {
        assert.ok(key in course, `${course.courseName}: ${key}`);
      }
      for (const component of course.components) {
        for (const key of ['name', 'weightPercent', 'kind', 'perSession', 'scenario', 'note']) assert.ok(key in component, `${course.courseName}: ${key}`);
        assert.ok(kinds.has(component.kind), component.kind);
      }
      for (const cutoff of course.cutoffs) {
        for (const key of ['type', 'text', 'threshold', 'unit']) assert.ok(key in cutoff, `${course.courseName}: ${key}`);
        assert.ok(cutoffTypes.has(cutoff.type), cutoff.type);
      }
    }
  });

  it('components の kind と cutoffs の type を全種類含み、scenario・reviewed・retake・warnings の見本もある', () => {
    const usedKinds = new Set(example.courses.flatMap((c) => c.components.map((x) => x.kind)));
    const usedTypes = new Set(example.courses.flatMap((c) => c.cutoffs.map((x) => x.type)));
    assert.deepEqual([...usedKinds].sort(), [...kinds].sort());
    assert.deepEqual([...usedTypes].sort(), [...cutoffTypes].sort());
    assert.ok(example.courses.some((c) => c.components.some((x) => x.scenario)));
    assert.ok(example.courses.some((c) => c.reviewed) && example.courses.some((c) => !c.reviewed));
    assert.ok(example.courses.some((c) => c.retake));
    assert.ok(example.courses.some((c) => c.warnings.length > 0));
    assert.ok(example.courses.some((c) => c.cutoffs.some((x) => x.unit === 'ratio')) && example.courses.some((c) => c.cutoffs.some((x) => x.unit === 'count')));
  });

  it('reviewed: true の科目と案つきの科目は、配点の合計が 100 になる', () => {
    for (const course of example.courses.filter((c) => c.reviewed || c.components.some((x) => x.scenario))) {
      for (const [scenario, { total, unknown }] of weightTotals(course.components)) {
        assert.equal(unknown, 0, `${course.courseName} ${scenario}`);
        assert.equal(total, 100, `${course.courseName} ${scenario}`);
      }
    }
  });

  it('見本の科目は架空であることが分かる（実在の授業コードを使わない）', () => {
    for (const course of example.courses) assert.match(course.courseCode, /^99999/);
  });
});
