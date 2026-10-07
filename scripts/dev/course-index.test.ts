/**
 * buildCourseIndex の突き合わせと警告、および組み立て層（scripts/build/ 全体）と
 * scripts/lib/ の純粋モジュールが Playwright・ネットワーク・ブラウザ系のモジュールに依存しないことの検査。
 * Usage: npx tsx --test scripts/dev/course-index.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildCourseIndex, type CourseIndexInputs } from '../build/course-index';
// 組み立て層の全モジュールを読み込む（下の「依存」の検査で、これらを読み込んでも playwright が読み込まれないことを見る）
import '../build/academic-schedule';
import '../build/context';
import '../build/context-markdown';
import '../build/course-lookup';
import '../build/grading-rules';
import '../build/summary';
// scripts/lib/ の純粋モジュール（下の「lib の純粋モジュール」の検査対象。読み込んでも playwright が読み込まれないことを見る）
import '../lib/course-code';
import '../lib/course-key';
import '../lib/coursework-model';
import '../lib/syllabus-cache';
import '../lib/syllabus-pool';
import '../lib/toyo-academic-schedule';
import '../lib/toyo-env';
import '../lib/toyo-grading-rules';
import '../lib/toyo-normalize';
import '../lib/toyo-paths';
import { inferScheduleCd } from '../lib/course-code';

const schedule = {
  academicYear: '2026',
  source: 'test',
  periods: [],
  terms: [
    { semester: '春学期', classesStart: '2026-04-13', classesEnd: '2026-07-25', examPeriod: null, noClassDays: [], makeupDays: [] },
    { semester: '秋学期', classesStart: '2026-09-21', classesEnd: '2027-01-30', examPeriod: null, noClassDays: [], makeupDays: [] },
  ],
};

function inputs(overrides: Partial<CourseIndexInputs> = {}): CourseIndexInputs {
  return {
    registration: {
      academicYear: '2026',
      courses: [
        { courseCode: '2010101002', courseName: '哲学Ａ２', semesterLabel: '春学期', day: '水', period: '7' },
        { courseCode: '2010102002', courseName: '哲学Ｂ２', semesterLabel: '秋学期', day: '水', period: '7' },
        { courseCode: '2310126001', courseName: '組織行動論', semesterLabel: '秋学期', day: '木', period: '6' },
        { courseCode: 'XJ13900003', courseName: 'AI基礎【オンデマンド】', semesterLabel: '秋学期', day: '集中', period: '' },
        { courseCode: '2010133001', courseName: '天文学Ｂ', semesterLabel: '秋学期', day: '火', period: '6' },
      ],
    },
    coursework: {
      courses: [
        // 名前だけで一致（授業コードが ACE 側に無い）
        { courseId: '1', courseName: '哲学B2', aceListName: '哲学B2', courseCode: null, aceCourseCodes: [], portalCourseName: null },
        // 授業コードで一致（ACE 名は「天文学B7」）
        { courseId: '2', courseName: '天文学B7', aceListName: '天文学B', courseCode: null, aceCourseCodes: ['1010222007', '2010133001'] },
        { courseId: '3', courseName: '生命と倫理/生命倫理 1', aceListName: '生命と倫理/生命倫理 1', courseCode: null, aceCourseCodes: [] },
      ],
    },
    candidates: [{ candidates: [{ scheduleCd: '3423101260-001' }] }],
    syllabusFiles: ['2010102002.json', '2010102002.md', '2310126001.json', 'XJ13900003.json', '2010133001.json', '2010101002.json'],
    gradingRules: { courses: [{ courseCode: '2010102002', scheduleCd: '3420101020-002' }, { courseCode: '2010133001', scheduleCd: '3420101330-001' }] },
    academicSchedule: schedule,
    ...overrides,
  };
}

const now = new Date('2026-10-08T00:00:00+09:00');

describe('buildCourseIndex', () => {
  const index = buildCourseIndex(inputs(), now);
  const byCode = (code: string) => index.courses.find((c) => c.courseCode === code)!;

  it('名前の全角半角が違っても courseKey で突き合わせる', () => {
    assert.equal(byCode('2010102002').aceCourseId, '1');
    assert.equal(byCode('2010102002').names.key, '哲学B2');
    assert.equal(byCode('2010102002').names.ace, '哲学B2');
  });

  it('授業コードを ACE の複数コードから引く', () => {
    assert.equal(byCode('2010133001').aceCourseId, '2');
    assert.equal(byCode('2010133001').names.ace, '天文学B');
  });

  it('突き合わない ACE コースは aceOnly に出る', () => {
    assert.deepEqual(index.aceOnly, [{ aceCourseId: '3', name: '生命と倫理/生命倫理 1' }]);
  });

  it('今学期の欠けは警告、過去学期は警告しない', () => {
    assert.deepEqual(byCode('2010101002').warnings, []);
    assert.equal(byCode('2010101002').has.aceCourse, false);
    assert.deepEqual(byCode('2310126001').warnings, [
      'ACE のコース一覧にまだ無い（登録の反映待ちの可能性）',
      '評価ルールが無い（data/grading-rules.json）',
    ]);
    assert.deepEqual(byCode('2010102002').warnings, []);
  });

  it('scheduleCd: 候補ファイル / 評価ルール / 推定の順', () => {
    assert.equal(byCode('2310126001').scheduleCd, '3423101260-001');
    assert.equal(byCode('2310126001').scheduleCdInferred, undefined); // 候補一覧に推定値そのものがある
    assert.equal(byCode('2010102002').scheduleCd, '3420101020-002');
    assert.equal(byCode('XJ13900003').scheduleCd, inferScheduleCd('XJ13900003'));
    assert.equal(byCode('XJ13900003').scheduleCdInferred, true);
  });

  it('集中講義は slots が空', () => {
    assert.deepEqual(byCode('XJ13900003').slots, []);
    assert.equal(byCode('XJ13900003').intensive, true);
    assert.deepEqual(byCode('2310126001').slots, [{ day: '木', period: '6' }]);
  });

  it('入力が無くても落ちない（null と警告で表す）', () => {
    const empty = buildCourseIndex(inputs({ coursework: null, candidates: [], syllabusFiles: [], gradingRules: null, academicSchedule: null }), now);
    assert.equal(empty.courses.length, 5);
    assert.ok(empty.courses.every((c) => c.has.aceCourse === false && c.warnings.length === 3));
  });
});

/**
 * scripts/lib/ のうち、playwright・ネットワーク・ブラウザ系に触れない純粋なモジュール。
 * 組み立て層（scripts/build/）はこの中のものだけを値として import できる。
 * lib/toyo（ブラウザ）、toyo-health（→ publish/toyo-api のネットワーク）、toyo-notify（プロセス起動）は含めない。
 */
const pureLibs = new Set([
  'course-code',
  'course-key',
  'coursework-model',
  'syllabus-cache',
  'syllabus-pool',
  'toyo-academic-schedule',
  'toyo-env',
  'toyo-grading-rules',
  'toyo-normalize',
  'toyo-paths',
]);

const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 値として読み込まれる import / re-export の指定子。`import type` と `{ type A }` だけの import は実行時に消えるので除く。 */
function valueImports(source: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(source).matchAll(/^\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s+['"]([^'"]+)['"]/gms)) {
    if (m[2]) continue;
    const braces = /^\{([^}]*)\}$/.exec(m[3].trim());
    if (braces) {
      const names = braces[1].split(',').map((n) => n.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue;
    }
    out.push(m[4]);
  }
  return out;
}

describe('組み立て層の依存（scripts/build/ 全体）', () => {
  const buildDir = path.resolve(__dirname, '..', 'build');
  const files = fs.readdirSync(buildDir).filter((f) => f.endsWith('.ts'));

  it('scripts/build/ に 5 つ以上のモジュールがある（検査対象の取りこぼし防止）', () => {
    assert.ok(files.length >= 5, files.join(', '));
  });

  it('組み立て層と純粋な lib を読み込んでも playwright は読み込まれない', () => {
    const resolved = Object.keys(require.cache).filter((file) => /node_modules\/(?:playwright|playwright-core)\//.test(file));
    assert.deepEqual(resolved, []);
  });

  it('値の import は Node 標準・同じディレクトリ・純粋な lib/ に限る（playwright / lib/toyo / fetch/ / publish/ / jobs/ は不可）', () => {
    for (const name of files) {
      const source = fs.readFileSync(path.join(buildDir, name), 'utf8');
      for (const spec of valueImports(source)) {
        if (spec.startsWith('node:') || spec.startsWith('./')) continue;
        const lib = /^\.\.\/lib\/([^/]+)$/.exec(spec);
        assert.ok(lib && pureLibs.has(lib[1]), `${name}: 組み立て層から値として import できない: ${spec}`);
      }
    }
  });

  it('fetch( を呼ばない', () => {
    for (const name of files) {
      const source = stripComments(fs.readFileSync(path.join(buildDir, name), 'utf8'));
      assert.ok(!/\bfetch\s*\(/.test(source), `${name}: fetch( を使っている`);
    }
  });

  it('値の import が許可リスト外なら検出できる（検査自体の確認）', () => {
    const bad = "import { launchStateContext } from '../lib/toyo';\nimport { type Course } from '../fetch/toyo-enrollment';\nimport type { X } from 'playwright';";
    assert.deepEqual(valueImports(bad), ['../lib/toyo']);
  });
});

describe('lib の純粋モジュール（scripts/lib/）', () => {
  const libDir = path.resolve(__dirname, '..', 'lib');

  it('pureLibs の各モジュールが実在する（名前の取りこぼし・改名の検出）', () => {
    for (const name of pureLibs) assert.ok(fs.existsSync(path.join(libDir, `${name}.ts`)), `${name}.ts が scripts/lib/ に無い`);
  });

  it('値の import は Node 標準と、pureLibs 同士に限る（playwright / lib/toyo / toyo-health / toyo-notify / fetch / publish は不可）', () => {
    for (const name of pureLibs) {
      const source = fs.readFileSync(path.join(libDir, `${name}.ts`), 'utf8');
      for (const spec of valueImports(source)) {
        if (spec.startsWith('node:')) continue;
        const sibling = /^\.\/([^/]+)$/.exec(spec);
        assert.ok(sibling && pureLibs.has(sibling[1]), `lib/${name}.ts: 純粋な lib から値として import できない: ${spec}`);
      }
    }
  });

  it('fetch( を呼ばない', () => {
    for (const name of pureLibs) {
      const source = stripComments(fs.readFileSync(path.join(libDir, `${name}.ts`), 'utf8'));
      assert.ok(!/\bfetch\s*\(/.test(source), `lib/${name}.ts: fetch( を使っている`);
    }
  });
});
