/**
 * 科目名の突き合わせキー。全角半角（NFKC）・空白（全角含む）・大小文字の揺れを吸収する。
 * 例: 「哲学Ｂ２」「哲学B2」「生命と倫理　1」「生命と倫理 1」は、それぞれ同じキーになる。
 *
 * この関数は 1 か所に置く。worker/src/course-key.ts は同じ実装のコピー（Worker は別パッケージのため）で、
 * scripts/dev/course-key.test.ts が両者の一致を検査する。変更するときは両方を同時に直すこと。
 */
export function courseKey(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
}
