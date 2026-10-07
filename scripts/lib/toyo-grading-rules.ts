import fsSync from 'node:fs';
import path from 'node:path';
import { dataDir } from './toyo-paths';

export type GradingComponentKind =
  | 'final-exam'
  | 'midterm'
  | 'quiz'
  | 'report'
  | 'assignment'
  | 'participation'
  | 'attendance'
  | 'other';

export type GradingComponent = {
  name: string;
  /** 配点（%換算）。配分が書かれていない / 読み取れない場合は null。 */
  weightPercent: number | null;
  kind: GradingComponentKind;
  /** 毎回（各回）課される要素かどうか。 */
  perSession: boolean;
  /** 配点が複数案ある科目での案の名前（例: 「試験あり」）。単一案なら省略 / null。 */
  scenario?: string | null;
  note: string;
};

export type GradingCutoff = {
  type: 'attendance' | 'submission-count' | 'exam-required' | 'other';
  text: string;
  /** unit が ratio のとき 0〜1 の比率（出席に必要な割合など）、count のとき回数。読み取れなければ null。 */
  threshold: number | null;
  unit?: 'ratio' | 'count' | null;
};

export type GradingRule = {
  courseCode: string;
  scheduleCd: string | null;
  courseName: string;
  semester: '春学期' | '秋学期';
  /** registered: 登録済み / add-plan: 追加登録候補 / reference: 春学期（参考） */
  enrollment?: 'registered' | 'add-plan' | 'reference';
  components: GradingComponent[];
  cutoffs: GradingCutoff[];
  retake: string | null;
  sourceText: string;
  reviewed: boolean;
  warnings: string[];
};

export type GradingRulesFile = {
  schemaVersion: 1;
  generatedAt: string;
  notes: string[];
  courses: GradingRule[];
};

export const gradingRulesPath = path.join(dataDir, 'grading-rules.json');

let cache: { value: GradingRulesFile | null } | undefined;

/** 存在しない / 壊れている場合は null。 */
export function loadGradingRules(): GradingRulesFile | null {
  if (cache) return cache.value;
  let value: GradingRulesFile | null = null;
  try {
    const parsed = JSON.parse(fsSync.readFileSync(gradingRulesPath, 'utf8')) as Partial<GradingRulesFile>;
    if (Array.isArray(parsed.courses)) value = parsed as GradingRulesFile;
  } catch {
    value = null;
  }
  cache = { value };
  return value;
}

export function findGradingRule(courseCode: string): GradingRule | null {
  return loadGradingRules()?.courses.find((course) => course.courseCode === courseCode) ?? null;
}

// ---------------------------------------------------------------------------
// 下書き抽出（正規表現ベース。必ず人間 / エージェントが sourceText と見比べて直すこと）
// ---------------------------------------------------------------------------

const circledDigits = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

function normalize(text: string): string {
  // ①②… は NFKC で "1" "2" になり直後の数値と癒着する（応用レポート①１５点 → 115点）ため先に退避する
  const protectedText = text.replace(/[①-⑳]/g, (c) => `(${circledDigits.indexOf(c) + 1})`);
  return protectedText.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function classifyKind(label: string): GradingComponentKind {
  if (/中間/.test(label)) return 'midterm';
  if (/レポート/.test(label)) return 'report';
  if (/小テスト|確認テスト|チェックテスト|クイズ|ミニテスト/.test(label)) return 'quiz';
  if (/期末|定期|学期末|最終|試験|テスト/.test(label)) return 'final-exam';
  if (/出席|履修確認/.test(label)) return 'attendance';
  if (/参加|平常|態度/.test(label)) return 'participation';
  if (/課題|リフレクション|ミニッツ|コメント|ペーパー|小課題/.test(label)) return 'assignment';
  return 'other';
}

function cleanLabel(raw: string): string {
  let label = raw
    .replace(/[「」『』]/g, '')
    .replace(/<[^>]*>|【[^】]*】/g, '')
    .replace(/^[^(]*\)/, (head) => (head.includes('(') ? head : '')) // 対応する "(" が無い ")" までを捨てる
    .replace(/^[がはをのとやでに、・\s]+/, '')
    .replace(/^\d+\s+/, '')
    .replace(/[\s:・…]+$/, '')
    .replace(/[がはをで]$/, '')
    .trim();
  label = label.replace(/(の評価|の成績|の点数|の結果|の得点|配点|評価)$/, '').trim();
  return label.length > 40 ? label.slice(-40) : label;
}

function lastChunk(preceding: string): string {
  const stripped = preceding.replace(/[\s:・…(\[「]+$/, '');
  const chunks = stripped.split(/[、。,;+]|\s・|・{2,}|:|及び|および|かつ|あるいは|または/);
  return chunks[chunks.length - 1] ?? '';
}

/** text[start] が "(" のとき、対応する ")" の直後の位置を返す。なければ -1。 */
function skipBalancedParen(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

type RawToken = { label: string; value: number; unit: '%' | '点'; perSession: boolean; note: string };

function extractTokens(text: string): { tokens: RawToken[]; declaredTotal: number | null } {
  const tokens: RawToken[] = [];
  let declaredTotal: number | null = null;
  const tokenRe = /(約)?(\d+(?:\.\d+)?)\s*(%|パーセント|点)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    const unit = match[3] === '点' ? '点' : '%';
    const before = text.slice(cursor, match.index);
    // 範囲表記（80~100点）や、直前が「~」「-」の数値は採点基準の記述なので飛ばす
    if (/[~\-]\s*$/.test(before) || /^\s*[~\-]\s*\d/.test(text.slice(tokenRe.lastIndex))) {
      continue;
    }
    // 「合計100点」「計100%」は構成要素ではなく総計の宣言
    if (/(合計|総計|計)\s*$/.test(before)) {
      declaredTotal = Number(match[2]);
      break; // 以降は補足説明とみなして読まない
    }

    let end = tokenRe.lastIndex;
    let note = '';
    let perSession = false;
    const rest = text.slice(end);
    const parenStart = rest.search(/^\s*\(/);
    if (parenStart === 0) {
      const open = end + rest.indexOf('(');
      const close = skipBalancedParen(text, open);
      if (close > 0) {
        const inner = text.slice(open + 1, close - 1);
        if (/[×*x]\s*\d+/.test(inner) || /%|点/.test(inner)) {
          note = inner.trim();
          if (/[×*]\s*\d+/.test(inner)) perSession = true;
          end = close;
          tokenRe.lastIndex = close;
        }
      }
    }
    const label = cleanLabel(lastChunk(before));
    if (/毎回|各回|各講義|毎授業/.test(label)) perSession = true;
    tokens.push({ label, value: Number(match[2]), unit, perSession, note });
    cursor = end;
  }
  return { tokens, declaredTotal };
}

export function extractComponents(gradingText: string): { components: GradingComponent[]; warnings: string[] } {
  const text = normalize(gradingText);
  const warnings: string[] = [];
  const { tokens, declaredTotal } = extractTokens(text);

  const percentTokens = tokens.filter((token) => token.unit === '%');
  const used = percentTokens.length > 0 ? percentTokens : tokens.filter((token) => token.unit === '点');
  const usingPoints = percentTokens.length === 0 && used.length > 0;
  if (usingPoints) {
    warnings.push(`配点は「点」表記から抽出（合計 ${declaredTotal ?? used.reduce((s, t) => s + t.value, 0)} 点）。%換算は要確認。`);
  }

  const components: GradingComponent[] = used.map((token) => {
    const scale = usingPoints && declaredTotal && declaredTotal !== 100 ? 100 / declaredTotal : 1;
    return {
      name: token.label || '(名称不明)',
      weightPercent: Math.round(token.value * scale * 100) / 100,
      kind: classifyKind(token.label),
      perSession: token.perSession,
      scenario: null,
      note: token.note ? `内訳: ${token.note}` : '',
    };
  });

  if (components.length === 0) warnings.push('配分（%・点）を抽出できなかった。原文を確認すること。');
  return { components, warnings };
}

type CutoffRule = {
  type: GradingCutoff['type'];
  re: RegExp;
  threshold?: (match: RegExpMatchArray) => { value: number; unit: 'ratio' | 'count' } | null;
};

const kanjiDigits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 };
function toNumber(raw: string): number {
  return kanjiDigits[raw] ?? Number(raw);
}

const cutoffRules: CutoffRule[] = [
  {
    type: 'attendance',
    re: /([0-9一二三四五])分の([0-9一二三四五])以上/,
    threshold: (m) => ({ value: toNumber(m[2]) / toNumber(m[1]), unit: 'ratio' }),
  },
  {
    type: 'attendance',
    re: /([0-9一二三四五])分の([0-9一二三四五])を超え(?:て|る)?(?:欠席|休)/,
    threshold: (m) => ({ value: 1 - toNumber(m[2]) / toNumber(m[1]), unit: 'ratio' }),
  },
  {
    type: 'attendance',
    re: /(\d)\/(\d)を超え(?:て|る)?(?:欠席|休)/,
    threshold: (m) => ({ value: 1 - Number(m[1]) / Number(m[2]), unit: 'ratio' }),
  },
  {
    type: 'attendance',
    re: /欠席[^。]{0,40}?(\d+)回以上/,
    threshold: (m) => ({ value: Number(m[1]), unit: 'count' }),
  },
  {
    type: 'attendance',
    re: /出席(?:回数)?[^。]{0,40}?(\d+)回以上/,
    threshold: (m) => ({ value: Number(m[1]), unit: 'count' }),
  },
  {
    type: 'submission-count',
    re: /提出(?:回数)?(?:が|を)?\s*(\d+)回(?:未満|以上|を超え)/,
    threshold: (m) => ({ value: Number(m[1]), unit: 'count' }),
  },
  { type: 'exam-required', re: /必ず(?:受|受験)|試験を受け(?:ない|なかった)|(?:平常点|レポート)のみでは(?:評価|単位)/ },
  { type: 'other', re: /未提出[^。]{0,20}0点|0点とする|評価対象外|評価の対象としない|成績評価の対象としない|単位不可|欠格/ },
];

export function extractCutoffs(gradingText: string): GradingCutoff[] {
  const text = normalize(gradingText);
  const sentences = text.split(/(?<=[。】])/).map((s) => s.trim()).filter(Boolean);
  const cutoffs: GradingCutoff[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences) {
    for (const rule of cutoffRules) {
      const match = sentence.match(rule.re);
      if (!match) continue;
      const key = `${rule.type}:${sentence}`;
      if (seen.has(key)) continue;
      // 同じ文で具体的な足切り（出席・提出回数など）が取れていれば、汎用の "other" は重複なので足さない
      if (rule.type === 'other' && cutoffs.some((c) => c.text.startsWith(sentence.slice(0, 40)))) continue;
      seen.add(key);
      const threshold = rule.threshold?.(match) ?? null;
      cutoffs.push({
        type: rule.type,
        text: sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence,
        threshold: threshold ? Math.round(threshold.value * 1000) / 1000 : null,
        unit: threshold?.unit ?? null,
      });
    }
  }
  return cutoffs;
}

export function extractRetake(gradingText: string): string | null {
  const sentence = normalize(gradingText)
    .split(/(?<=[。】])/)
    .find((s) => /再試験|追試|再評価|再提出|再履修/.test(s));
  return sentence ? sentence.trim() : null;
}

/**
 * 配点合計を出す。scenario が null の要素は全案に共通、scenario 付きの要素は「共通 + その案」で合計する。
 * 配点が null の要素は合計に入れず unknown に数える。
 */
export function weightTotals(components: GradingComponent[]): Map<string, { total: number; unknown: number }> {
  const sumOf = (items: GradingComponent[]): { total: number; unknown: number } => ({
    total: items.reduce((acc, item) => acc + (item.weightPercent ?? 0), 0),
    unknown: items.filter((item) => item.weightPercent === null).length,
  });
  const shared = components.filter((component) => !component.scenario);
  const scenarios = [...new Set(components.map((c) => c.scenario).filter((name): name is string => Boolean(name)))];
  const totals = new Map<string, { total: number; unknown: number }>();
  if (scenarios.length === 0) {
    totals.set('', sumOf(shared));
    return totals;
  }
  for (const scenario of scenarios) {
    totals.set(scenario, sumOf([...shared, ...components.filter((c) => c.scenario === scenario)]));
  }
  return totals;
}

export function totalWarnings(components: GradingComponent[]): string[] {
  const warnings: string[] = [];
  for (const [scenario, { total, unknown }] of weightTotals(components)) {
    const label = scenario ? `（${scenario}）` : '';
    if (Math.abs(total - 100) > 0.01 || unknown > 0) {
      warnings.push(
        `配分の合計が 100 になっていない${label}: 合計 ${Math.round(total * 100) / 100}%${unknown > 0 ? `、配点不明 ${unknown} 件` : ''}。`
      );
    }
  }
  return warnings;
}

export function draftGradingRule(input: {
  courseCode: string;
  scheduleCd: string | null;
  courseName: string;
  semester: '春学期' | '秋学期';
  enrollment: GradingRule['enrollment'];
  grading: string;
}): GradingRule {
  const { components, warnings } = extractComponents(input.grading);
  const allWarnings = [...warnings, ...totalWarnings(components)];
  return {
    courseCode: input.courseCode,
    scheduleCd: input.scheduleCd,
    courseName: input.courseName,
    semester: input.semester,
    enrollment: input.enrollment,
    components,
    cutoffs: extractCutoffs(input.grading),
    retake: extractRetake(input.grading),
    sourceText: input.grading,
    reviewed: false,
    warnings: allWarnings,
  };
}
