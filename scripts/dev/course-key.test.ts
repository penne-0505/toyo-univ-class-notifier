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
  ['哲学B2', '哲学Ｂ２'],
  ['生命と倫理　1', '生命と倫理 1'],
  ['生命と倫理　1', '生命と倫理1'],
  ['金融システム論１', '金融システム論1'],
  ['社会学Ａ2', '社会学A2'],
  ['AI基礎【オンデマンド】', 'ＡＩ基礎【オンデマンド】'],
  ['ai基礎', 'AI基礎'],
];

describe('courseKey', () => {
  for (const [a, b] of sameKey) {
    it(`${a} == ${b}`, () => {
      assert.equal(courseKey(a), courseKey(b));
      assert.equal(workerCourseKey(a), workerCourseKey(b));
    });
  }

  it('代表的な出力', () => {
    assert.equal(courseKey('哲学Ｂ２'), '哲学B2');
    assert.equal(courseKey('生命と倫理　1'), '生命と倫理1');
    assert.equal(courseKey('AI基礎【オンデマンド】'), 'AI基礎【オンデマンド】');
    assert.equal(courseKey('金融システム論１'), '金融システム論1');
  });

  it('別の科目は別のキーになる（末尾の数字や学期記号は落とさない）', () => {
    assert.notEqual(courseKey('哲学B2'), courseKey('哲学B1'));
    assert.notEqual(courseKey('哲学A2'), courseKey('哲学B2'));
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
