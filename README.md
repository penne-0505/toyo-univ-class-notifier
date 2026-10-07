# Toyo University Automation

東洋大学の学内システム（学務ポータル / ToyoNet-ACE）から履修・課題・お知らせを取得し、LLM エージェントから利用できるようにするツール群です。

## アーキテクチャ

```
Scripts (scripts/)         ← データ取得 core (Playwright + TypeScript)
   ↓ output/ にキャッシュ
Skill (.claude/commands/)  ← LLM の対話インターフェース
toyo:publish               ← ~/toyo-data (GitHub, 正本) と Worker へ配信
   ↓ PUT
Worker (worker/)           ← クラウドのエージェント向け REST (Cloudflare Workers + KV, Bearer キー必須)
```

- **Scripts**: 履修・シラバス・課題・お知らせ・祝日を取得して `output/` に保存する core 層
- **Skill** (`.claude/commands/toyo.md`): Claude Code から `/project:toyo` で呼び出すLLM用の判断フロー
- **Worker** (`worker/`): 取得データを KV に持ち、クラウドのエージェントへ REST で返す（詳細は `worker/README.md`）

データの読み手は LLM エージェント（Claude Code の Skill、または Worker の REST / `toyo-data` repo 経由のクラウドのエージェント）です。

2026-10 に Discord bot は廃止しました。通知はこのマシンのデスクトップ通知（`toyo:health`。送り先は `.env.local` で Discord webhook / ntfy も選べます）が担い、外部からの鮮度確認はクラウドの秘書エージェントが `/v1/meta` の `publishedAt` と health で行います。

## クイックスタート

```bash
# 1. 初回ログイン（GUIで一度だけ）
npm run toyo:login

# 2. データを同期
npm run toyo:sync
```

セッションが切れたら `npm run toyo:refresh-session`（`toyo:login` の別名）で再ログインします。

## スクリプト一覧

| コマンド | 内容 |
|---------|------|
| `npm run toyo:login` | 専用Chromeプロファイルでポータルにログインし、`storageState` を保存 |
| `npm run toyo:refresh-session` | `toyo:login` の別名（期限切れ時の再ログイン用） |
| `npm run toyo:check` | 保存済みセッションが有効か headless で確認 |
| `npm run toyo:sync` | 履修・課題・コンテンツ・お知らせ・祝日をまとめて取得して `summary.json` を更新 |
| `npm run toyo:export-enrollment` | 履修登録確認表のみ取得・整形 |
| `npm run toyo:syllabus -- --course-code <code>` | 指定授業のシラバスを取得（学期内キャッシュあり） |
| `npm run toyo:syllabus:seed [-- --force]` | `registration-candidates.json` の候補シラバス本文から、登録中科目の `output/toyo/syllabus/<授業コード>.json/.md` を書き出す（ブラウザ不要。既存は `--force` で上書き） |
| `npm run toyo:announcements` | ACEのコースニュース（休講・補講・教室変更含む）のみ取得 |
| `npm run toyo:coursework [-- --no-summary]` | ACE の全 2026 年度コースの提出状況を取得（`_report` / `_query` / `_survey` / `_grade` と提出記録 30 日）→ `output/toyo/toyonet-ace-coursework.json`。授業コードで `registration-data.json` と突き合わせる。取得後に summary.json を再生成（`--no-summary` で省略）。`toyo-coursework` タイマー（毎時 :20）用 |
| `npm run toyo:calendar` | 内閣府CSVから祝日データを取得 |
| `npm run toyo:run` | セッション疎通確認用の最小ランナー |
| `npm run toyo:context [-- --print]` | エージェントが最初に読む圧縮コンテキストを `output/toyo/agent-context.{md,json}` に生成。標準出力は 1 行サマリのみ（全文は `--print`、JSON は `--print --format json`） |
| `npm run toyo:candidates [-- --syllabus]` | 履修登録画面の全コマから登録可能な科目一覧を取得（`--syllabus` で夜間・集中科目のシラバスも取得、`--syllabus=all` で全科目） |
| `npm run toyo:lottery` | 抽選実施科目一覧と当落（○/×）を取得（登録成功は確定ではない。落選科目は履修から削除される） |
| `npm run toyo:credits` | 単位数集計表（卒業要件の充足状況・学期別 GPA）と履修・修得科目一覧（不合格含む）を取得 |
| `npm run toyo:schedule [-- --date YYYY-MM-DD]` | `data/academic-schedule.json`（しおりから手で起こした学年暦）を読み、指定日（既定: 今日 JST）に進行中・直近の期間と、各曜日の第N回授業日を表示（ポータル不要） |
| `npm run toyo:grading-rules` | シラバスの「成績評価の方法・基準」から配分・足切りを抽出して `grading-rules.json` に下書きを書く（`reviewed: true` の科目は上書きしない。ポータル不要） |
| `npm run toyo:register -- --file plan.json [--exec]` | 履修登録画面に科目を入れて送信。既定は dry-run、`--exec` で実際に登録 |
| `npm run toyo:publish [-- --dry-run --include-candidates --force --push-all-api]` | allowlist（`output/toyo/**`・`output/bot/summary.json`・`data/**`）を `~/toyo-data` へ同期し、時刻以外に差分があるときだけ commit & push。`meta.json` に鮮度・`sourceStatus` を書く。`TOYO_API_URL` / `TOYO_API_WRITE_KEY` があれば変化分を Worker にも PUT（`--push-all-api` で全件） |
| `npm run toyo:watch` | ACE の未提出課題とお知らせだけ取得し、変化があれば summary / agent-context を再生成して publish（5 分タイマー用。失敗が続くと 15→30 分に自動バックオフ） |
| `npm run toyo:daily` | 全取得（coursework → sync → credits → lottery → context）→ `toyo:publish --include-candidates --force`（24 時間タイマー用） |
| `npm run toyo:health -- <record\|status\|test-notify>` | 定期ジョブ（watch / coursework / daily）の失敗検知と通知。`status` で状態一覧（アラート中なら終了コード 1）、`test-notify` でテスト通知。systemd の `ExecStopPost` が成否を記録する。閾値・送り先は `docs/toyo-automation-runbook.md` の「失敗の検知と通知」 |
| `npm run typecheck` | TypeScript型チェック |

## 出力ファイル

| パス | 内容 |
|------|------|
| `worker/`（デプロイ先 `https://toyo-data-api.penne0505pp.workers.dev`） | 上記データを REST で読む Worker。`/v1/context` など。Bearer キー必須 |
| `output/toyo/toyonet-ace-coursework.json` | ACE のコース別提出状況。`courses[].items`（type: report/query/survey、status: open/waiting/closed/unknown、submitted: true/false/null、opensAt/dueAt）、`counts`（report+query のみ。アンケートは除く）、`grades`、トップレベルの `submissions`（提出記録 30 日）。drill（Web最終テスト）は query 扱い |
| `output/toyo/registration-data.json` | 履修登録確認表（`fetchStatus: success/error/empty`） |
| `output/toyo/registration-summary.md` | 履修まとめ（人間向け） |
| `output/spreadsheet/toyo-timetable.xlsx` | 時間割スプレッドシート |
| `output/toyo/syllabus/<授業コード>.json` | シラバス（学期内キャッシュ） |
| `output/toyo/toyonet-ace-assignments.json` | 未提出課題一覧 |
| `output/toyo/toyonet-ace-contents.json` | コース掲示資料 |
| `output/toyo/announcements.json` | コースニュース（カテゴリ: 休講/補講/教室変更/その他） |
| `output/toyo/academic-calendar.json` | 祝日データ |
| `data/academic-schedule.json` | 学年暦（履修登録・抽選・追加登録・取消申請の期間、授業開始日など）。しおりから手書きの静的データ（git 管理）。履修登録関連の期間のみ置き、授業終了日・試験期間・休講振替・成績発表など学年暦の詳細はユーザーの Google カレンダーが正（`unknown` に列挙、ここでは埋めない） |
| `data/grading-rules.json` | 科目ごとの成績配分（components）・足切り（cutoffs）。`toyo:grading-rules` の下書きを人が直したもの（`reviewed` で区別）。`agent-context` の各授業に `gradingRules` として載る |
| `output/bot/summary.json` | 全ソースを集約した summary（歴史的経緯で `bot/` 配下にある。Skill・Worker・toyo-data が読む） |
| `output/toyo/agent-context.json` | エージェント用の圧縮コンテキスト（構造化JSON） |
| `output/toyo/agent-context.md` | エージェント用の圧縮コンテキスト（Markdown） |
| `output/toyo/registration-candidates.json` | 履修登録画面から取得した登録可能科目（選択ID `scheduleCd`、コマ、シラバス） |
| `output/toyo/lottery-results.json` / `.md` | 抽選実施科目一覧と当落 |
| `output/toyo/credit-summary.json` / `.md` | 卒業要件の充足状況・学期別成績・履修修得科目一覧 |
| `artifacts/toyo/register-*.png` / `register-result.json` | `toyo:register` の送信前スクリーンショットと結果 |

エラー時のスナップショットは `artifacts/toyo/` に保存されます。

初回は `npm install` が必要です（`tsx` が無いと `npm run toyo:*` は `tsx: command not found` で失敗します）。

## 履修登録の流れ

```bash
npm run toyo:candidates -- --syllabus   # 登録可能科目とシラバスを取得（数分）
npm run toyo:credits                     # 卒業要件の残りを確認
npm run toyo:register -- --file plan.json          # dry-run（画面に入れた状態を artifacts/toyo/ に保存）
npm run toyo:register -- --file plan.json --exec   # 送信。エラー（履修上限超過など）はそのまま表示される
npm run toyo:export-enrollment           # 履修登録確認表で結果を確認
npm run toyo:lottery                     # 抽選実施科目の当落を確認
```

`plan.json` は `["scheduleCd", ...]` の配列（`registration-candidates.json` の `scheduleCd`）。履修上限（経営学部第2部は学期 24 単位）や重複はサーバー側で判定され、エラーがあれば何も登録されない。

追加登録期間は `toyo:candidates -- --add` で候補を取り直し、`toyo:register -- --file plan.json --period add --max-credits 24 --skip-missing` を使う。手順は `docs/toyo-automation-runbook.md` の「追加登録期間の手順」を参照。

## ランタイムファイル

- 専用ブラウザプロファイル: `playwright/.profiles/toyo`
- 保存セッション: `playwright/.auth/toyo-state.json`
- セッションメタデータ: `playwright/.auth/toyo-session.json`

## 環境変数

`.env.local`（リポジトリルート）に保存できます。

### スクリプト用 (.env.local)

| 変数 | 内容 |
|------|------|
| `TOYO_USERNAME` / `TOYO_PASSWORD` | SSO自動再ログイン用 |
| `TOYO_CHROME_PATH` | Chrome実行パス上書き（既定: `/opt/google/chrome/chrome`） |
| `TOYO_HEADLESS=0\|1` | headed/headless強制 |
| `TOYO_PORTAL_URL` | ポータルURL上書き |
| `TOYO_API_URL` / `TOYO_API_WRITE_KEY` | Worker（`worker/`）への配信先と書き込みキー。両方あるときだけ publish が PUT する |

## ドキュメント

- [`docs/basic-info.md`](docs/basic-info.md) — 授業時間、キャンパスアクセス、入構ルールなど固定情報
- [`docs/toyo-automation-runbook.md`](docs/toyo-automation-runbook.md) — 運用手順、セッション喪失時の回復、情報ソースのルーティング表
- [`.claude/commands/toyo.md`](.claude/commands/toyo.md) — LLM用Skill定義（決定フロー・回答テンプレート）

## スプレッドシート出力（Python依存）

履修エクスポートは Python virtual env 経由で `.xlsx` を生成します。

```bash
uv venv .venv
uv pip install --python .venv/bin/python openpyxl pandas
```

## 想定ワークフロー

1. `npm run toyo:login` を一度実行してログインを完了する
2. `npm run toyo:check` で保存セッションが有効か確認
3. 必要なときに `npm run toyo:sync` を走らせて最新化
4. エージェントに授業相談を投げる前に `npm run toyo:context` で圧縮コンテキストを生成
5. 定期ジョブ（systemd タイマー、`deploy/README.md`）が自動で同期・配信し、失敗が続くと `toyo:health` が通知する

`toyo:context` は既定で `summary.json` が 30 分より古い場合に `toyo:sync` を試みます。既存出力だけで確認したい場合は `npm run toyo:context -- --no-sync` を使います。標準出力は `[context] <JST> today=n tomorrow=m warnings=k` の 1 行だけで（journal を汚さないため）、全文は `output/toyo/agent-context.md` を読むか `--print` を付けます。JSON を標準出力したい場合は `npm --silent run toyo:context -- --print --format json` です。定期ジョブが失敗中・停止中のときは Warnings に載ります。

ポータルが `システムエラー` / `タイムアウトしました。` / SSOログイン画面 / 多要素認証設定画面 のいずれかを返した場合はログイン喪失として扱います。共通ヘルパー `detectToyoSessionLoss` / `recoverToyoSessionIfNeeded` (`scripts/lib/toyo.ts`) が自動回復を試み、失敗した場合は手動再ログインを案内します。詳細は `docs/toyo-automation-runbook.md` を参照。
