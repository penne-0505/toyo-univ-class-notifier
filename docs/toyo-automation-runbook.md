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
Skills（LLMとの対話） / Worker・toyo-data（クラウドのエージェント向け）
```

Skillsは `.claude/commands/toyo.md` として定義。LLMが質問を受けたとき、このSkillがScriptを呼び出してデータを取得・回答する。

## 情報ソースのルーティング

| データ種別 | ファイル | キャッシュ方針 |
|-----------|---------|--------------|
| 授業・教室 | `output/toyo/registration-data.json` | 毎回フェッチ |
| 課題・締切 | `output/toyo/toyonet-ace-assignments.json` | 毎回フェッチ |
| ACEお知らせ（休講等） | `output/toyo/announcements.json` | 毎回フェッチ |
| 祝日 | `output/toyo/academic-calendar.json` | 毎回フェッチ |
| 学年暦（履修登録・抽選・追加登録・取消申請の期間、授業開始日） | `data/academic-schedule.json` | 手書きの静的データ（しおり由来。年度が変わったら書き直す。履修登録関連の期間のみ。学年暦の詳細はユーザーの Google カレンダーが正） |
| 成績配分・足切り | `data/grading-rules.json` | `toyo:grading-rules` で下書き → 人が確認（`reviewed`）。`data/` は手書き・レビュー済みの静的データ（git 管理）、`output/` は生成物 |
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
npm run toyo:context       # エージェント用の圧縮コンテキストを生成（標準出力は 1 行サマリ、全文は --print）
npm run toyo:health -- status   # 定期ジョブの失敗状況（アラート中なら終了コード 1）
npm run toyo:candidates    # 履修登録画面から登録可能科目を取得（--syllabus でシラバスも）
npm run toyo:credits       # 単位数集計表・履修修得科目を取得
npm run toyo:register      # 履修登録の dry-run / --exec で送信（--period add --max-credits N --skip-missing）
npm run toyo:lottery       # 抽選実施科目一覧と当落を取得
npm run toyo:schedule      # 学年暦から今日の進行中の期間・第N回授業日を表示（--date YYYY-MM-DD）
npm run toyo:grading-rules # シラバスから成績配分・足切りの下書きを生成（reviewed:true は上書きしない）
```

使い分け:

- `toyo:sync`: 履修情報・ACEお知らせ・課題・コンテンツ・祝日・集約 summary をまとめて更新する。
- `toyo:check`: 保存済み `storageState` がポータルで有効か確認する。
- `toyo:login`: GUI でログインし、保存済み `storageState` を更新する。
- `toyo:refresh-session`: `toyo:login` の別名。期限切れ時に使う。
- `toyo:export-enrollment`: 履修登録確認表だけを更新する。
- `toyo:syllabus`: 履修登録確認表の科目を指定して、シラバスを単体取得する（学期内キャッシュあり）。
- `toyo:syllabus:seed`: `registration-candidates.json` の `candidates[].syllabus` から登録中科目のシラバスキャッシュを一括生成する（時間割検索を経由しない。既存ファイルは `--force` で上書き）。学期切替直後に `toyo:candidates` を実行した後で使う。
- `toyo:calendar`: 内閣府CSVから祝日データを取得する。
- `toyo:announcements`: ToyoNet-ACEのお知らせ（休講・補講・教室変更等）を取得する。
- `toyo:context`: `summary.json` が古い場合は `toyo:sync` を試み、今日/明日の授業、近い課題、重要なお知らせ、鮮度・警告を `output/toyo/agent-context.json` と `output/toyo/agent-context.md` にまとめる。既存出力だけで作る場合は `--no-sync` を付ける。標準出力は 1 行サマリ（`[context] <JST> today=n tomorrow=m warnings=k`）で、全文は `--print`（`--format json` と併用可）。定期ジョブが失敗中・停止中なら Warnings に載る（「失敗の検知と通知」参照）。今日/明日の授業には `sessionNumber`（第N回）と `gradingRules`（配分・足切り）が付き、「Periods」節に今日進行中・7日以内に始まる期間（`academic-schedule.json`）が載る。どちらのファイルも無ければ null / 空配列になるだけで壊れない。
- `toyo:schedule`: `academic-schedule.json` を読むだけ。`--date 2026-10-07` で任意の日の進行中の期間と各曜日の第N回を確認できる。祝日（`academic-calendar.json`）と `noClassDays` は授業日から除き、`makeupDays` は振替曜日として数える。
- `toyo:grading-rules`: シラバス本文から正規表現で配分・足切りを抽出する下書き生成。抽出結果は必ず `sourceText` と見比べて直し `reviewed: true` にする。配分合計が 100 にならない科目は `warnings` に入る。

## 履修登録画面の制約（2026-09 に判明）

- 履修登録（正規登録期間）は `/univision/action/in/f07/Usin070311`。各コマの科目一覧（`Usin071640`）とシラバス（`Uscm030170`）は、画面のボタンから開くサブウィンドウでしか表示されない。URL を直接開くと「不正な操作」になる。`scripts/toyo-fetch-registration-candidates.ts` はボタンをクリックしてサブウィンドウを捕捉する。
- 科目一覧のシラバスボタンは前のサブウィンドウを閉じてから開くので、毎回 `context.waitForEvent('page')` で新しいページを待つ。シラバスを 200 件前後連続で開くと「認証エラー」になり以降のコマが 0 件になるため、認証エラーを検知したら登録画面を開き直す。
- 英語開講科目は「日本語」ボタンがなく「English」だけ。シラバス取得は English にフォールバックする。
- 登録の送信は `onExecButtomClick()` → `confirm()` → Ajax POST（`Usin070321`）。応答ヘッダ `x-json` が `{"status":"success"}` なら成功、`error` なら画面にエラー（E）・警告（W）が出て何も登録されない。履修上限（秋学期 24 単位）超過はここで判定される。事前チェックの API はない。
- 追加登録（`Usin071611`）・抽選科目一覧（`Usin07Z211`）は期間外だと「この機能は使用可能対象外です」。
- 履修登録確認表の「集中その他」科目は曜日・時限がなく、`registration-data.json` では `day: "集中"`, `period: ""` になる。今日/明日の授業一覧には出ない。
- `tsx` は esbuild の keepNames により `page.evaluate` に渡した関数内の関数定義へ `__name()` を注入し、ブラウザ側で `ReferenceError: __name is not defined` になる。ブラウザ側コードは文字列（`String.raw`）で渡す。

## 抽選実施科目

- 履修登録の送信が成功しても、定員超過の科目（他キャンパス開講の全学科目など。2026 秋は赤羽台のオンデマンド 4 科目）は抽選になり、登録は確定ではない。
- 落選した科目は履修登録と ToyoNet-ACE のコースから削除される。抽選実施科目は追加登録期間に追加できない。
- 当落は `npm run toyo:lottery`（抽選実施科目一覧 `Usin07Z211`）で確認する。結果は `output/toyo/lottery-results.json` / `.md`（○ 当選、× 落選）。画面が開けないときは既存ファイルを上書きせず、非 0 で終了する。
- 2026 年度（秋学期）の日程: 抽選発表 10/5、抽選結果 10/6 17:00、追加登録 10/7(水) 12:20〜10/9(金) 23:59、履修取消 10/23〜10/29。
- 出典: ACE コース course_4999517 の「2026年度経営学部履修登録のしおり.pdf」。
- 2026-09-29 に 12 科目を登録し、4 科目（生命と倫理・情報化社会と人間・ジェンダー論・総合Ｅ）が落選して 8 科目 16 単位になった。

## 追加登録期間の手順

追加登録は先着順で、開講されている科目も限られる。履修上限（秋学期 24 単位）に対して現在の登録単位数との差分だけ入る。優先順の plan は `output/toyo/add-registration-plan.json`（`[{"scheduleCd", "name", "note"}]`、並び順 = 優先順）。

1. 12:20 になったら `npm run toyo:candidates -- --add` で、追加登録画面で今開いている科目を取得する。期間前は「使用可能対象外」と表示されて非 0 終了し、既存の `registration-candidates.json` は更新されない。
2. `npm run toyo:register -- --file output/toyo/add-registration-plan.json --period add --max-credits 24 --skip-missing` を dry-run で実行し、追加される科目・飛ばされる科目・送信後の単位数を確認する。`--skip-missing` は候補に無い科目、`--max-credits` は上限を超える科目を飛ばす。
3. 差分をユーザーが確認して OK を出したら、同じコマンドに `--exec` を付けて送信する。エラー（E）があれば何も登録されないので、そのまま提示して plan を見直す。
4. `npm run toyo:export-enrollment` で履修登録確認表を更新し、`npm run toyo:lottery` で抽選科目が混ざっていないか確認する。

注意: 追加登録画面の候補は `registration-candidates.json` の `period` が `add` のものを使う。`regular` のまま実行すると警告が出る。

## データ配信（toyo-data）

取得データは private repo `penne-0505/toyo-data`（ローカル clone: `~/toyo-data`）へ定期 push する。systemd ユーザータイマーで動き。

```
toyo-watch.timer (5分)  → toyo:watch ─ 変化あり → summary 再生成 → toyo:context --no-sync ─┐
toyo-coursework.timer (毎時:20) → toyo:coursework → context --no-sync ───────────────────┤
toyo-daily.timer (04:30) → toyo:daily (coursework/sync/credits/lottery/context) ──────────┤
                                                                                          ▼
                                       toyo:publish → ~/toyo-data → GitHub (private)
```

- 公開対象は allowlist（`output/toyo/**`、`output/bot/summary.json`、`data/**`）のみ。`artifacts/`・`playwright/`・`.env*` はコード上含まれない。`registration-candidates.json`（約 1.6MB）は `--include-candidates`（daily）のときだけ。
- 差分判定は `fetchedAt` / `generatedAt` / `builtAt` などの時刻を除いたハッシュ。時刻だけ変わったファイルは書き換えず、commit にも含めない。`meta.json` だけが変わる場合も commit しない（daily は `--force` で毎日 1 commit 作り、生存確認を兼ねる）。
- watch は `state/watch-state.json` に連続失敗数と次回許可時刻を持つ。失敗 2 回で 15 分、4 回で 30 分スキップし、成功で解除。ログイン切れ時は `toyo:login` 後に `rm state/watch-state.json`。
- watch・daily・coursework は `flock /tmp/toyo-fetch.lock` で排他（Playwright セッションは同時に 1 つ）。coursework は取得後に summary.json も再生成し（`--no-summary` で省略）、各授業・課題に `coursework`（提出済/未提出数・次の受付開始）、トップレベルに `courseworkSchedule`（今後 14 日、受付開始待ちを含む）を載せる。導入・確認・停止は `deploy/README.md`。
- 注意: watch が「変化なし」の間は summary.json の `generatedAt` が古いままになる。`toyo:context` の既定 30 分 stale 判定を使う場合は `--no-sync` を付けても警告が出うる。鮮度は `fetchedAt` の新しさではなく、watch の最終確認時刻（`state/watch-state.json` の `lastSuccessAt`）で見ること。
- 注意: `registration-data.json` には学籍番号・氏名が含まれ、そのまま push される（private repo 前提）。
- journal を汚さないため、定期実行されるコマンドの標準出力は 1 行サマリにしている（`toyo:context` は `[context] ...`、`toyo:coursework` は `[coursework] ...`、`toyo:sync` は `[sync] ...`）。科目ごとの内訳は `toyo:coursework -- --verbose`、context の全文は `--print`。
- 失敗検知と通知は次節「失敗の検知と通知」。

### Worker 経由の読み方（クラウドのエージェント向け）

GitHub を読めないエージェントのため、`toyo:publish` は変化したファイルと `meta.json` を Cloudflare Worker（`worker/`、KV 保存）へも PUT する。GitHub が正本で、Worker への配信が失敗しても publish の終了コードは変わらない（失敗したパスは `state/toyo-api-pending.json` に残り、次回再送）。

- 配信条件: `.env.local` に `TOYO_API_URL` と `TOYO_API_WRITE_KEY` がある。`--dry-run` では送らない。初回・作り直し時は `npm run toyo:publish -- --push-all-api`。
- 読み方: `curl -H "Authorization: Bearer $READ_KEY" $URL/v1/context`（まずこれ）。`/v1/meta`、`/v1/assignments?within=7d`、`/v1/today`、`/v1/files/{path}` など。科目単位なら `/v1/courses`（一覧）と `/v1/courses/{授業コード|ACE courseId|科目名}`（時間割・第N回・シラバス・成績ルール・提出状況・課題・お知らせを 1 回で）。`/v1/assignments?within=14d&includeWaiting=1` は受付開始待ちの小テストも混ぜ、各要素に配点・足切り・提出数（`course`）を付ける。一覧と鍵の扱い・ローテーションは `worker/README.md`。
- 鮮度は GitHub と同じ読み方: `/v1/meta` の `publishedAt` が 24 時間超なら取得側停止。`updatedAt` は最後に meta を PUT した時刻。
- 読み取りキーはエージェント側、書き込みキーはこのマシンの `.env.local` だけに置く。

### 失敗の検知と通知

定期ジョブの失敗が「ログに残るだけ」で気づかれないのを防ぐ仕組み（2026-10-07 に coursework が 7 時間連続で失敗した事故が発端）。各 service の `ExecStopPost`（`deploy/toyo-health-hook.sh`）が systemd の `$SERVICE_RESULT` / `$EXIT_STATUS` を見て `npm run --silent toyo:health -- record <job> success|failure` を呼ぶ。`watch` が他ジョブ実行中でスキップした場合（`EXIT_STATUS=75`）は記録しない。`ExecStopPost` は `-` 付きなので、記録の失敗で本体の結果は変わらない。

| ジョブ | 連続失敗でアラートする閾値 | context で「古い」とみなす最終成功からの経過 |
| --- | --- | --- |
| `watch`（5 分） | 3 回（約 15 分） | 30 分 |
| `coursework`（毎時） | 2 回（約 2 時間） | 3 時間 |
| `daily`（04:30） | 1 回 | 30 時間 |

- 閾値は `scripts/lib/toyo-health.ts` の定数（`ALERT_THRESHOLDS` / `STALE_AFTER_MS` / `REALERT_AFTER_MS`）。
- 通知は閾値に達した時点で 1 回だけ。以後は失敗が続いても送らず、通知から 6 時間たっても失敗中なら再通知する。失敗中に成功すると「回復」を 1 回送り、アラートを解除する。
- エラー文は `--error` が無ければ `journalctl --user -u toyo-<job>.service` の今回の実行分から `error|timeout|failed|econn|exception|exceeded` を含む行の最後 3 行（500 字まで）。学籍番号らしき 10 桁の数字は `**********` に伏せる（授業コードも 10 桁なので伏せられる）。
- 状態: `state/health.json`（正本。ジョブごとに `lastRunAt` / `lastSuccessAt` / `lastFailureAt` / `consecutiveFailures` / `lastError` / `alerting` / `alertedAt` / `failingSince`）。公開用の写しは `output/toyo/health.json`（`{ generatedAt, jobs, alerting }`）。
- 遷移（アラート・再通知・回復）のたびに `output/toyo/health.json` を Worker へ直接 PUT する（失敗は無視。GitHub へは次の publish で載る。`meta.json` の `health` にも毎回入る）。

#### 送り先の設定（`.env.local`）

複数設定すれば全部に送る。何も設定しなければ `notify-send`（systemd 下では `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID/bus` を補う）、それも失敗したら標準エラー（= journal）に出すだけ。

| 変数 | 送り先 |
| --- | --- |
| `TOYO_ALERT_DISCORD_WEBHOOK` | Discord webhook URL。`{ content }` を POST（2000 字まで） |
| `TOYO_ALERT_NTFY_TOPIC`（＋任意で `TOYO_ALERT_NTFY_SERVER`、既定 `https://ntfy.sh`） | ntfy。`Title` ヘッダ、アラートは `Priority: high`。公開サーバーに送るので、本文から URL・長いトークン・10 桁数字を落とす。トピック名は事実上のパスワードなので推測されにくい名前にする |

```bash
npm run toyo:health -- test-notify   # 設定した全送り先へテスト通知を 1 回送る
```

#### status の見方

```bash
npm run toyo:health -- status        # アラート中のジョブがあれば終了コード 1
[ok   ] watch      | 最終成功 03:30 | 最終実行 03:30 | 連続失敗 0/3
[ALERT] coursework | 最終成功 20:21 | 最終実行 03:20 | 連続失敗 7/2 | 通知済み 22:20 | エラー: ...
```

- 行頭: `ok`（正常）/ `ALERT`（アラート中）/ `STALE`（アラートではないが最終成功が閾値より古い）。
- `連続失敗 n/m` は現在の連続失敗数 / アラート閾値。日付が今日でなければ `MM/DD HH:mm`（JST）。
- 原因を直したら、次の定期実行（または `systemctl --user start toyo-<job>.service`）の成功で自動的に回復する。`state/health.json` を直接消してもよい。

#### 劣化の可視化

- `toyo:context`: アラート中のジョブ、または最終成功が上表の目安より古いジョブを Warnings / JSON の `warnings` に載せる（例: 「toyo-coursework が 2026-10-07 20:22 から失敗中。今日・明日・提出状況が古い可能性」）。
- Worker: `GET /v1/health`（認証不要）は `{ ok, updatedAt, degraded }` だけを返す（ジョブ名・詳細は出さない）。`/v1/meta` には `health` が入り、認証済み GET の応答には劣化中だけ `X-Toyo-Degraded: 1` ヘッダが付く。

## 同期後に確認するファイル

- `output/bot/summary.json`
  全ソースを集約した summary（歴史的経緯で `bot/` 配下にある）。LLM エージェントが読む。`sourceStatus` でポータル・ACEの取得状況を確認。
- `output/toyo/agent-context.json` / `output/toyo/agent-context.md`
  コーディングエージェントが最初に読む圧縮コンテキスト。`freshness`、`warnings`、今日/明日の授業、近い課題、重要なお知らせ、参照すべき source file を含む。
- `output/toyo/registration-data.json`
  履修登録確認表の構造化データ。`fetchStatus` フィールドで取得成否を確認（`success` / `error` / `empty`）。
- `output/toyo/registration-summary.md`
  人間が読みやすい履修まとめ。
- `output/toyo/announcements.json`
  ToyoNet-ACEのお知らせ（休講・補講・教室変更）。`category` フィールドで分類済み。
- `output/toyo/academic-calendar.json`
  祝日データ。`nationalHolidays` 配列で `YYYY-MM-DD` 形式。
- `data/academic-schedule.json`
  しおり由来の学年暦（手書き）。`periods`（登録・抽選・追加登録・取消申請など）と `terms`（通常授業開始日・休講日・振替日）。しおりに無い項目は null で、`unknown` に理由つきで列挙してある。推測で埋めない。学年暦の詳細はユーザーの Google カレンダーが正で、ここには履修登録関連の期間のみ置く。
- `data/grading-rules.json`
  科目別の成績配分と足切り。`reviewed: false` や `warnings` が残るものは原文（`sourceText`）を引用して不確実性を伝える。
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

1. `npm run toyo:context` を実行する。
2. `output/toyo/agent-context.md` または `output/toyo/agent-context.json` を読む。
3. `freshness.stale`、`warnings`、`sourceStatus` を確認する。
4. 詳細が必要なら `output/bot/summary.json` と source file に戻る。
5. `registration-data.json` の `fetchStatus` を確認する。
   - `"error"` → ログイン喪失扱い。授業データを信用しないと断った上で回答する。
   - `"empty"` → 「履修データが空です。`npm run toyo:login` 後に再同期してください」と伝える。
   - `"success"` → 通常通り回答する。
6. 履修、シラバス、ToyoNet-ACE の入口では自動回復後に再試行される。
7. まだ失敗する場合は `npm run toyo:login` が必要だと明示する。
8. 取得失敗 (`"error"`) と授業なし (`"empty"`) を混同せずに回答する。
9. `announcements.json` の `category: "休講"` / `"補講"` / `"教室変更"` を必ずチェックして回答に反映する。
10. `academic-calendar.json` の `nationalHolidays` で祝日チェックをする。祝日なら「授業なし（祝日）」と答える。

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

## 運用上の落とし穴

過去の実作業で踏んだもの。原因と回避を対で持つ。

- 症状: `npm run toyo:sync` や ad-hoc の `tsx -e` が `listen EPERM` / crashpad で落ちる。
  - 原因: この環境の ad-hoc runner 制約。
  - 回避: ad-hoc Playwright を書かず repo の既存 script に寄せる。runner 制約であることを明示して切り分ける。

- 症状: 同期後に `summary.json` が前より内容が薄くなった。
  - 原因: partial refresh が同じ出力先を上書きした。
  - 回避: 再同期前に `registration-summary.md` / assignments / contents を読んでおく。fresh run が壊れたら stale と partial を明示して使い分ける。

- 症状: シラバス detail が `利用できません` になる。
  - 原因: detail URL に direct `goto` した。
  - 回避: `npm run toyo:syllabus` を使う。UI をたどる必要がある場合は popup 連鎖 `Usin026411` → `Usin026420` → `日本語` → `Uscm030170` を前提にする。

- 症状: 科目名で見つけた評価基準が別授業のものだった。
  - 原因: `toyonet-ace-contents.json` や `output/toyo/syllabus/*.md` の別科目キャッシュを科目名一致で拾った。
  - 回避: `docs/basic-info.md` と `registration-data.json` で授業コードを確定してから `npm run toyo:syllabus -- --course-code <code>` で取り直す。科目名 grep から始めない。

- JSON 集計に `jq` を前提にしない。この環境では `node -e` で済ませる。

## Skill 化するときの境界

skill には、次の粒度で手順を持たせる。

- 「最新化する」なら `npm run toyo:sync`
- 「取得結果を読む」なら `output/bot/summary.json`
- 「失敗を診断する」なら `sourceStatus`、`errors`、`artifacts/toyo/`
- 「ログイン喪失」なら `recoverToyoSessionIfNeeded` または `npm run toyo:login`

skill はポータル仕様を暗記するのではなく、上記のファイルと関数を見て判断する。
