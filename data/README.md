# data/

手書き・レビュー済みの静的データ置き場。`academic-schedule.json` は git 管理、`grading-rules.json` は git 管理外（下記）。`output/` はポータル取得や各 script が生成する成果物で、`.gitignore` 対象。

## ファイル

### academic-schedule.json

所属学部の履修登録のしおり（PDF。配布物なので git には入れない）から手で起こした学年暦。履修登録・抽選・追加登録・取消申請の期間、授業開始日などを持つ。

- 学年暦の詳細（授業終了日・試験期間・休講振替・成績発表など）はユーザーの Google カレンダーが正。ここには履修登録関連の期間のみ置き、`unknown` に挙げた項目はこれ以上埋めない。
- 更新手順: 年度が変わったら新しいしおりを見ながら `periods` / `terms` を手で書き直す。確認は `npx tsx scripts/toyo-academic-schedule.ts --date YYYY-MM-DD`。

### grading-rules.json（git 管理外）

科目ごとの成績配分（components）・足切り（cutoffs）。`agent-context` の各授業に `gradingRules` として載る。

- **実データは git 管理外**（本人の履修科目が分かるため、公開リポジトリには置かない）。非公開の `toyo-data` に `toyo:publish` で配信される。新しい環境では、`grading-rules.example.json`（架空の科目だけの見本。スキーマの全フィールドを含む）を `grading-rules.json` にコピーして使う。ファイルが無くても各スクリプトは動く（評価ルールが空になるだけ）。
- 更新手順: `npm run toyo:grading-rules` がシラバス（`output/toyo/syllabus/`）から下書きを生成し、このファイルを読み書きする。
- `reviewed: true` の科目は上書きされない。下書きを `sourceText`（シラバス原文）と見比べて直したら `reviewed: true` にする。
- `reviewed: false` や `warnings` が残る科目は、利用時に原文を引用して不確実性を伝える。
