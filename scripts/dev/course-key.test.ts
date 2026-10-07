/**
 * courseKey の代表ケースと、scripts 側 / worker 側の実装が一致していることの検査。
 * Usage: npx tsx --test scripts/dev/course-key.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { courseKey } from '../lib/course-key';
import { courseKey as workerCourseKey } from '../../worker/src/course-key';

const sameKey: Array<[string, string]> = [
  ['サンプル統計学B2', 'サンプル統計学Ｂ２'],
  ['サンプル倫理学　1', 'サンプル倫理学 1'],
  ['サンプル倫理学　1', 'サンプル倫理学1'],
  ['サンプル金融論１', 'サンプル金融論1'],
  ['サンプル人間学Ａ2', 'サンプル人間学A2'],
  ['ZQ入門【オンデマンド】', 'ＺＱ入門【オンデマンド】'],
  ['zq入門', 'ZQ入門'],
];

describe('courseKey', () => {
  for (const [a, b] of sameKey) {
    it(`${a} == ${b}`, () => {
      assert.equal(courseKey(a), courseKey(b));
      assert.equal(workerCourseKey(a), workerCourseKey(b));
    });
  }

  it('代表的な出力', () => {
    assert.equal(courseKey('サンプル統計学Ｂ２'), 'サンプル統計学B2');
    assert.equal(courseKey('サンプル倫理学　1'), 'サンプル倫理学1');
    assert.equal(courseKey('ZQ入門【オンデマンド】'), 'ZQ入門【オンデマンド】');
    assert.equal(courseKey('サンプル金融論１'), 'サンプル金融論1');
  });

  it('別の科目は別のキーになる（末尾の数字や学期記号は落とさない）', () => {
    assert.notEqual(courseKey('サンプル統計学B2'), courseKey('サンプル統計学B1'));
    assert.notEqual(courseKey('サンプル統計学A2'), courseKey('サンプル統計学B2'));
  });

  it('scripts 側と worker 側で出力が一致する', () => {
    for (const [a, b] of sameKey) {
      assert.equal(courseKey(a), workerCourseKey(a));
      assert.equal(courseKey(b), workerCourseKey(b));
    }
    for (const sample of ['', '  ', ' 哲学　B\t2 ', 'Ａｂｃ１２３', 'ﾊﾝｶｸ', '①②']) {
      assert.equal(courseKey(sample), workerCourseKey(sample));
    }
  });

  it('実装本体（export function 以降）が worker 側のコピーと同一', () => {
    const body = (file: string): string => {
      const text = fs.readFileSync(file, 'utf8');
      return text.slice(text.indexOf('export function courseKey'));
    };
    const root = path.resolve(__dirname, '..', '..');
    assert.equal(body(path.join(root, 'scripts/lib/course-key.ts')), body(path.join(root, 'worker/src/course-key.ts')));
  });
});
