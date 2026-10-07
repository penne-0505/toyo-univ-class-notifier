# TODO

## Scripts（データ取得層）

### 新規スクリプト
- [x] 学年暦スクレイパー (`scripts/lib/toyo-academic-calendar.ts` + `scripts/toyo-fetch-calendar.ts`)
  - 内閣府CSVから祝日を取得、`output/toyo/academic-calendar.json` に出力
  - `package.json` に `toyo:calendar` スクリプト追加
- [x] ACEお知らせスクレイパー (`scripts/lib/toyo-announcements.ts` + `scripts/toyo-fetch-announcements.ts`)
  - `home_news` ページから休講・補講・教室変更を取得、`category` フィールドで分類
  - `output/toyo/announcements.json` に出力
  - `package.json` に `toyo:announcements` スクリプト追加

### 既存スクリプトの改修
- [x] ステータス分類の整備（`scripts/lib/toyo-enrollment.ts`）
  - `FetchStatus: "success" | "error" | "empty"` 型を追加
  - `courses: []` かつエラーなし → `"empty"` として区別
  - `EnrollmentData` に `fetchStatus` フィールドを追加
- [x] シラバスのキャッシュ判定（`scripts/lib/toyo-syllabus.ts`）
  - `fetchSyllabusWithCache` 関数を追加（学期内キャッシュあれば再利用）
  - `SyllabusRecord` に `academicYear` フィールドを追加
  - `toyo-summary.ts` が `fetchSyllabusWithCache` を使用するよう更新（3 層化リファクタで `build/summary.ts` に移し、シラバスは取りに行かずキャッシュ・pool を読むだけに変更）
- [x] `toyo:sync` に学年暦・お知らせ取得を組み込む（`scripts/toyo-sync.ts`）
  - カレンダーを enrollment と並行フェッチ
  - お知らせは `buildDiscordSummary` 内でACEデータと並行フェッチ（3 層化リファクタで取得は sync に集約し、summary は `build/summary.ts` の `buildSummary` に）

---

## Skills（LLMインターフェース層）

- [x] Skillファイルの作成（`.claude/commands/toyo.md`）
  - スクリプト呼び出しルール（シラバスはキャッシュ、それ以外は毎回同期）
  - 情報ソースのルーティングテーブル
  - 「明日の授業」回答テンプレート
  - データ信頼性ルール（fetchStatus に応じた挙動）
  - エラー診断フロー

---

## ドキュメント

- [x] `docs/toyo-automation-runbook.md` をSkillの決定事項に合わせて更新
  - アーキテクチャ図（Scripts → Skills / Worker）
  - 情報ソースのルーティング表
  - `fetchStatus` ルール（error / empty / success）
  - キャッシュルールの明記
