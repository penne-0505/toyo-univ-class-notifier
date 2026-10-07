# Toyo University Skill

東洋大学の授業・課題・スケジュール情報を取得・回答するスキルです。

## スクリプト実行ルール

### シラバス情報（キャッシュあり）
1. `output/toyo/syllabus/<授業コード>.json` を読む
2. ファイルが存在し `syllabus.academicYear` が現在の開講年度と一致する → そのデータを使う
3. 存在しないか年度が違う → `npm run toyo:syllabus -- --course-code <コード>` を実行してから読む

### それ以外の情報（毎回フェッチ）
質問に答える前に必ず `npm run toyo:context` を実行すること。
その後 `output/toyo/agent-context.md` または `output/toyo/agent-context.json` を読む。
詳細確認が必要な場合は集約 summary（`output/toyo/summary.json`）と各 source file に戻る。

## 情報ソースのルーティング

| 質問の種類 | 参照ファイル |
|-----------|-------------|
| 今日・明日は授業日か（祝日か） | `output/toyo/academic-calendar.json` の `nationalHolidays` |
| 今は何の期間か（履修登録・抽選・追加登録・取消申請の期間） | `agent-context` の `periods`、または `npm run toyo:schedule [-- --date YYYY-MM-DD]`（元データ `data/academic-schedule.json`。`unknown` の項目は推測しない） |
| 今日は第何回の授業か | `agent-context` の各授業の `sessionNumber`、または `npm run toyo:schedule`（祝日は授業なしとして数える。null は計算不能） |
| この課題・回を飛ばせるか／成績配分・足切り | `agent-context` の各授業の `gradingRules`（元データ `data/grading-rules.json`）。`reviewed:false` や `warnings` があれば `sourceText`（シラバス原文）を引用して不確実性を伝える |
| 授業・曜日・教室・担当者 | `output/toyo/registration-data.json` |
| 今日・明日の授業一覧 | `output/toyo/summary.json` の `todayClasses` / `tomorrowClasses` |
| 休講・補講・教室変更 | `output/toyo/summary.json` の `announcements`（category フィールドで分類） |
| 課題・締切 | `output/toyo/summary.json` の `upcomingAssignments` |
| シラバス詳細（講義スケジュール・評価等） | `output/toyo/syllabus/<授業コード>.json` |
| 授業時間・入構ルール | `docs/basic-info.md` |
| エージェント用初期コンテキスト | `output/toyo/agent-context.md` / `output/toyo/agent-context.json` |
| 登録できる科目・履修計画（登録期間中） | `npm run toyo:candidates -- --syllabus` → `output/toyo/registration-candidates.json` |
| 卒業要件の残り・GPA・不合格科目 | `npm run toyo:credits` → `output/toyo/credit-summary.md` |
| 履修登録の実行 | `npm run toyo:register -- --file plan.json`（dry-run）→ ユーザー確認後 `--exec` |

## 「明日の授業」への回答構造

以下の順で情報を収集し、ひとつの回答にまとめる。

1. **授業日判定**: `academic-calendar.json` で祝日チェック → 祝日なら「授業なし（祝日）」
2. **授業一覧**: `summary.json` の `tomorrowClasses` を取得
3. **お知らせ確認**: 各授業の `relatedAnnouncements` を確認（休講・教室変更があれば必ず明示）
4. **課題確認**: 各授業の `relatedAssignments` から翌日以降に締切が近いものを抽出
5. **データ鮮度**: `summary.json` の `generatedAt` と各 `sourceStatus.*.fetchedAt` を回答に含める

回答フォーマット（例）:

```
【明日の授業】2026-04-28（火）

⚠️ データ取得: 2026-04-27 23:10（JST）

6限 18:15-19:45
  科目: サンプル人間学Ａ2
  教室: 1234（サンプルキャンパス）
  担当: 〇〇 先生
  課題: なし
  お知らせ: なし

7限 19:55-21:25
  科目: サンプル流通論１
  教室: 5678（サンプルキャンパス）
  担当: 〇〇 先生
  課題: レポート提出（締切 4/30 23:59）
  お知らせ: なし
```

## データ信頼性ルール

- `portal.fetchStatus` が `"error"` → 授業データを信用しない。「ポータル取得エラーのため授業情報が古い可能性があります」と断ってから回答する
- `portal.fetchStatus` が `"empty"` → 「履修データが空です。`npm run toyo:login` 後に再同期してください」と伝える
- `announcementsAvailable: false` → 「休講・教室変更情報は取得できませんでした。直接 ToyoNet-ACE を確認してください」と付記する
- `academic-calendar.json` が存在しない → 祝日判定はスキップし、その旨を回答に含める

## 履修登録を頼まれたとき

1. `toyo:candidates -- --syllabus` と `toyo:credits` でデータを揃える（履修登録確認表も `toyo:export-enrollment` で最新化）
2. 候補の `scheduleCd` を `plan.json` にまとめ、`toyo:register -- --file plan.json` の dry-run でスクリーンショットと差分を見せる
3. ユーザーの明示的な OK を得てから `--exec`。サーバーのエラー（履修上限 24 単位/学期、同時限重複など）はそのまま提示する
4. 成功したら `toyo:export-enrollment` で確認表を再取得し、集中科目（`day: "集中"`）も含めて登録内容を照合する
5. 送信後は抽選実施科目一覧（`toyo:lottery`）で当落を確認し、結果発表日と追加登録期間をユーザーに伝える（登録成功は確定ではない。詳細は runbook の「抽選実施科目」「追加登録期間の手順」）

## クラウド側（toyo-data）での鮮度判断

- 取得データは private repo `toyo-data` へ定期 push される（watch 5 分 / daily 04:30 JST。仕組みは `docs/toyo-automation-runbook.md` の「データ配信」）
- クラウド側は `toyo-data` の `meta.json` の `publishedAt` と `sourceStatus` で鮮度を判断する（各ファイルの本体取得時刻は `meta.json` の `files.<path>.fetchedAt`）
- `publishedAt` が 24 時間より古い、または `sourceStatus` の `available` が false / `fetchStatus` が `error` のときは、データが古い可能性を断ってから回答する

## 判断の権限

- 「行くべきか？」「休んでも大丈夫か？」に対して積極的に判断してよい
- 例: 「最終レポートのみの評価なので、どうしても都合が悪ければ欠席の影響は限定的です」のような発言は可
- ただし確証のない情報に基づく断言は避け、根拠（シラバスの成績評価欄等）を示す

## エラー診断フロー

1. `summary.json` の `sourceStatus` と `errors` を確認
2. `agent-context.*` の `warnings` と `freshness.stale` を確認
3. `portal.fetchStatus === "error"` → `artifacts/toyo/` のスナップショットを確認
4. セッション切れの疑いがある → `npm run toyo:login` を案内
5. まだ失敗する → エラーメッセージをそのまま提示する
