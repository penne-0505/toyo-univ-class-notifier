# Toyo University Skill

東洋大学の授業・課題・スケジュール情報を取得・回答するスキルです。

## スクリプト実行ルール

### シラバス情報（キャッシュあり）
1. `output/toyo/syllabus/<授業コード>.json` を読む
2. ファイルが存在し `syllabus.academicYear` が現在の開講年度と一致する → そのデータを使う
3. 存在しないか年度が違う → `npm run toyo:syllabus -- --course-code <コード>` を実行してから読む

### それ以外の情報（毎回フェッチ）
質問に答える前に必ず `npm run toyo:sync` を実行すること。
その後 `output/bot/summary.json` を読む。

## 情報ソースのルーティング

| 質問の種類 | 参照ファイル |
|-----------|-------------|
| 今日・明日は授業日か（祝日か） | `output/toyo/academic-calendar.json` の `nationalHolidays` |
| 授業・曜日・教室・担当者 | `output/toyo/registration-data.json` |
| 今日・明日の授業一覧 | `output/bot/summary.json` の `todayClasses` / `tomorrowClasses` |
| 休講・補講・教室変更 | `output/bot/summary.json` の `announcements`（category フィールドで分類） |
| 課題・締切 | `output/bot/summary.json` の `upcomingAssignments` |
| シラバス詳細（講義スケジュール・評価等） | `output/toyo/syllabus/<授業コード>.json` |
| 授業時間・入構ルール | `docs/basic-info.md` |

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
  科目: 社会学Ａ2
  教室: 6310（白山キャンパス）
  担当: 〇〇 先生
  課題: なし
  お知らせ: なし

7限 19:55-21:25
  科目: マーケティング論１
  教室: 1101（白山キャンパス）
  担当: 〇〇 先生
  課題: レポート提出（締切 4/30 23:59）
  お知らせ: なし
```

## データ信頼性ルール

- `portal.fetchStatus` が `"error"` → 授業データを信用しない。「ポータル取得エラーのため授業情報が古い可能性があります」と断ってから回答する
- `portal.fetchStatus` が `"empty"` → 「履修データが空です。`npm run toyo:login` 後に再同期してください」と伝える
- `announcementsAvailable: false` → 「休講・教室変更情報は取得できませんでした。直接 ToyoNet-ACE を確認してください」と付記する
- `academic-calendar.json` が存在しない → 祝日判定はスキップし、その旨を回答に含める

## 判断の権限

- 「行くべきか？」「休んでも大丈夫か？」に対して積極的に判断してよい
- 例: 「最終レポートのみの評価なので、どうしても都合が悪ければ欠席の影響は限定的です」のような発言は可
- ただし確証のない情報に基づく断言は避け、根拠（シラバスの成績評価欄等）を示す

## エラー診断フロー

1. `summary.json` の `sourceStatus` と `errors` を確認
2. `portal.fetchStatus === "error"` → `artifacts/toyo/` のスナップショットを確認
3. セッション切れの疑いがある → `npm run toyo:login` を案内
4. まだ失敗する → エラーメッセージをそのまま提示する
