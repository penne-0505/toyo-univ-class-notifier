# Toyo Automation Runbook

このドキュメントは、LLM が東洋大学ポータル関連の実操作を行うための運用手順です。

最終的に skill 化する前提で、判断基準、実行順、失敗時の扱いを明示します。人間向けの GUI 手順ではなく、Playwright と保存済みセッションを使う自動操作のための手順書です。

## 基本方針

- 最新情報を聞かれたら、まず `npm run toyo:sync` で同期を試す。
- 同期後は `output/bot/summary.json` を確認する。
- 授業の根拠は `output/toyo/registration-data.json` と `output/toyo/registration-summary.md` を優先する。
- `fetchStatus` で取得結果を判定する：`success` → 通常 / `error` → ログイン喪失扱い / `empty` → 取得は成功したが履修ゼロ。
- `システムエラー` と `タイムアウト` は、原則としてログイン状態の喪失として扱う。

## アーキテクチャ

```
Scripts（データ取得・core）
  ↓
output/ ファイル群（キャッシュ）
  ↓
Skills（LLMとの対話） / Discord Bot（定型閲覧）
```

Skillsは `.claude/commands/toyo.md` として定義。LLMが質問を受けたとき、このSkillがScriptを呼び出してデータを取得・回答する。

## 情報ソースのルーティング

| データ種別 | ファイル | キャッシュ方針 |
|-----------|---------|--------------|
| 授業・教室 | `output/toyo/registration-data.json` | 毎回フェッチ |
| 課題・締切 | `output/toyo/toyonet-ace-assignments.json` | 毎回フェッチ |
| ACEお知らせ（休講等） | `output/toyo/announcements.json` | 毎回フェッチ |
| 学年暦・祝日 | `output/toyo/academic-calendar.json` | 毎回フェッチ |
| シラバス | `output/toyo/syllabus/<授業コード>.json` | 学期内キャッシュ |
| 集約サマリー | `output/bot/summary.json` | `toyo:sync` で生成 |

## 主要コマンド

```bash
npm run toyo:sync          # 全情報を同期（メイン）
npm run toyo:check
npm run toyo:login
npm run toyo:refresh-session
npm run toyo:export-enrollment
npm run toyo:syllabus -- --course-code <授業コード>
npm run toyo:calendar      # 祝日・学年暦のみ更新
npm run toyo:announcements # ACEお知らせのみ更新
```

使い分け:

- `toyo:sync`: 履修情報・ACEお知らせ・課題・コンテンツ・祝日・bot用summaryをまとめて更新する。
- `toyo:check`: 保存済み `storageState` がポータルで有効か確認する。
- `toyo:login`: GUI でログインし、保存済み `storageState` を更新する。
- `toyo:refresh-session`: `toyo:login` の別名。期限切れ時に使う。
- `toyo:export-enrollment`: 履修登録確認表だけを更新する。
- `toyo:syllabus`: 履修登録確認表の科目を指定して、シラバスを単体取得する（学期内キャッシュあり）。
- `toyo:calendar`: 内閣府CSVから祝日データを取得する。
- `toyo:announcements`: ToyoNet-ACEのお知らせ（休講・補講・教室変更等）を取得する。

## 同期後に確認するファイル

- `output/bot/summary.json`
  LLM や Discord bot が読む集約結果。`sourceStatus` でポータル・ACEの取得状況を確認。
- `output/toyo/registration-data.json`
  履修登録確認表の構造化データ。`fetchStatus` フィールドで取得成否を確認（`success` / `error` / `empty`）。
- `output/toyo/registration-summary.md`
  人間が読みやすい履修まとめ。
- `output/toyo/announcements.json`
  ToyoNet-ACEのお知らせ（休講・補講・教室変更）。`category` フィールドで分類済み。
- `output/toyo/academic-calendar.json`
  祝日データ。`nationalHolidays` 配列で `YYYY-MM-DD` 形式。
- `output/toyo/syllabus/*.json`
  単体取得したシラバスの構造化データ（学期内キャッシュとして機能）。
- `output/toyo/syllabus/*.md`
  単体取得したシラバスの Markdown。
- `artifacts/toyo/*.json`
  エラー時の画面スナップショット。
- `artifacts/toyo/*.png`
  エラー時のスクリーンショット。

## ログイン喪失の判定

次の状態は、実質的にログイン状態の喪失として扱う。

- ページタイトルまたは本文に `システムエラー` がある。
- 本文に `タイムアウトしました。` がある。
- `slink.secioss.com` 上にいる。
- SSO ログインフォームが表示されている。
- `多要素認証設定画面` が表示されている。

現在の共通判定は `scripts/lib/toyo.ts` の `detectToyoSessionLoss(page)` にある。

## セッション回復

ログイン喪失を検知したら、次の SSO 再ログイン URL を使う。

```text
https://slink.secioss.com/pub/login.cgi?back=%2fuser%2findex.php%3ftenant%3dtoyo.jp
```

現在の共通回復処理は `scripts/lib/toyo.ts` の `recoverToyoSessionIfNeeded(page, options)` にある。

回復処理の流れ:

1. 現在の URL を復帰先として保持する。
2. 必要なら画面スナップショットを保存する。
3. SSO 再ログイン URL を開く。
4. `.env.local` または `.env` の `TOYO_USERNAME` / `TOYO_PASSWORD` で `autoFillLogin(page)` を試す。
5. `slink.secioss.com` から抜けるまで待つ。
6. 元の URL に戻る。
7. まだログイン喪失状態なら失敗として扱う。
8. `saveState: true` の場合は `playwright/.auth/toyo-state.json` を更新する。

自動入力できない場合は、GUI で次を実行する。

```bash
npm run toyo:login
```

## エラーを正常データとして扱わない

次のような `registration-data.json` は失敗扱いにする。

```json
{
  "pageTitle": "システムエラー",
  "courses": []
}
```

これは「履修科目が 0 件」ではなく、「履修登録確認表の取得に失敗した」状態。

画面スナップショットは次に保存される。

- `artifacts/toyo/registration-system-error.json`
- `artifacts/toyo/registration-system-error.png`

## LLM 操作手順

授業や課題の最新情報を聞かれたとき:

1. `npm run toyo:sync` を実行する。
2. `output/bot/summary.json` を読む。
3. `sourceStatus` と `errors` を確認する。
4. `registration-data.json` の `fetchStatus` を確認する。
   - `"error"` → ログイン喪失扱い。授業データを信用しないと断った上で回答する。
   - `"empty"` → 「履修データが空です。`npm run toyo:login` 後に再同期してください」と伝える。
   - `"success"` → 通常通り回答する。
5. 履修、シラバス、ToyoNet-ACE の入口では自動回復後に再試行される。
6. まだ失敗する場合は `npm run toyo:login` が必要だと明示する。
7. 取得失敗 (`"error"`) と授業なし (`"empty"`) を混同せずに回答する。
8. `announcements.json` の `category: "休講"` / `"補講"` / `"教室変更"` を必ずチェックして回答に反映する。
9. `academic-calendar.json` の `nationalHolidays` で祝日チェックをする。祝日なら「授業なし（祝日）」と答える。

## シラバス単体取得

シラバスは `npm run toyo:syllabus` で単体取得できる。

まず履修登録確認表を最新化する。

```bash
npm run toyo:export-enrollment
```

候補を確認する。

```bash
npm run toyo:syllabus -- --list
```

授業コードで取得する。

```bash
npm run toyo:syllabus -- --course-code 2D10343001
```

科目名でも検索できる。

```bash
npm run toyo:syllabus -- 自然災害と防災
```

出力先:

- `output/toyo/syllabus/<授業コード>.json`
- `output/toyo/syllabus/<授業コード>.md`

`registration-data.json` が `システムエラー` 由来の場合、シラバス取得は実行せず、先にセッション更新と履修登録確認表の再取得を行う。

## お知らせ（コースニュース）の取得元

`home_news` ページは AJAX 読み込み + 教員からの直接通知では使われていないため、**`home_library_reminder` から取得する**。

```text
https://www.ace.toyo.ac.jp/ct/home_library_reminder?count=50
```

このリマインダ一覧には、各コースで投稿されたお知らせ（コースニュース、レポート公開、成績公開等）が集約される。`コースニュース掲示のお知らせ` 行のみを抽出し、各行の `home_library_reminder_detail_<id>` を直接開くと、本文に以下の形式で構造化データが含まれる。

```text
[コース名] : ロジカルシンキング入門
[タイトル] : 第３回授業資料につきまして
[作成者] : 藤坂 大佑
PC : https://www.ace.toyo.ac.jp/ct/course_<id>_news_<id>
```

この `[タイトル]` に `休講` / `補講` / `教室変更` が含まれるかで `category` を分類する。掲示板（`掲示` アイコン）経由でお知らせを行う教員は捕捉できない既知の制約あり。

## 実装メモ

共通化済み:

- `ssoRecoveryLoginUrl`
- `detectToyoSessionLoss(page)`
- `recoverToyoSessionIfNeeded(page, options)`

接続済み:

- `scrapeEnrollmentData()` の `confirmationUrl` 直後
- ToyoNet-ACE の `resolveAceLoginIfNeeded()`（課題・コンテンツ）
- ToyoNet-ACE の `collectToyoNetAceAnnouncements()`（リマインダ・detail両方）
- syllabus/timetable 系の入口

今後つなぎ込む候補:

- `toyo:check` の判定
- 各コース掲示板（`course_{id}_topics`）からの休講通知拾い上げ

推奨する実装パターン:

```ts
await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

await recoverToyoSessionIfNeeded(page, {
  returnUrl: targetUrl,
  saveState: true,
  snapshotTag: 'target-session-loss',
});
```

## Skill 化するときの境界

skill には、次の粒度で手順を持たせる。

- 「最新化する」なら `npm run toyo:sync`
- 「取得結果を読む」なら `output/bot/summary.json`
- 「失敗を診断する」なら `sourceStatus`、`errors`、`artifacts/toyo/`
- 「ログイン喪失」なら `recoverToyoSessionIfNeeded` または `npm run toyo:login`

skill はポータル仕様を暗記するのではなく、上記のファイルと関数を見て判断する。
