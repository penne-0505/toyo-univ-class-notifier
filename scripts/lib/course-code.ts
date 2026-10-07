/**
 * 授業コードから導く規則（scheduleCd の推定式、シラバスのファイル名）。1 か所だけに置く。
 * 科目名の突き合わせキーは course-key.ts の courseKey。
 */

/**
 * 授業コード → ポータルの時間割コード（scheduleCd）の推定式: '34' + 先頭 7 桁 + '0-' + 末尾 3 桁。
 * ZQ入門（XJ99900003 → 実際は 34XJ999700-002）のように合わない科目があるため、あくまで推定。
 * 候補ファイル・評価ルールにある実値を先に引き、無いときだけこの式を使う（build/course-index.ts の resolveScheduleCd）。
 */
export function inferScheduleCd(courseCode: string): string {
  return `34${courseCode.slice(0, 7)}0-${courseCode.slice(7)}`;
}

/**
 * 授業コードをファイル名の語幹にする規則。output/toyo/syllabus/<語幹>.json と .md、
 * output/toyo/syllabus-pool/<語幹>.json の両方がこの規則を使う。授業コードが英数字だけなら授業コードそのもの。
 */
export function syllabusFileStem(courseCode: string): string {
  return courseCode.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
