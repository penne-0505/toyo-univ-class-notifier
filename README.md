# Toyo University Automation

東洋大学の学内システム（学務ポータル / ToyoNet-ACE）から履修・課題・お知らせを取得し、LLMやDiscord botから利用できるようにするツール群です。

## アーキテクチャ

```
Scripts (scripts/)         ← データ取得 core (Playwright + TypeScript)
   ↓ output/ にキャッシュ
Skill (.claude/commands/)  ← LLM の対話インターフェース
Discord Bot (bot/)         ← 機械的な定型閲覧の薄い wrapper (Python + uv)
```

- **Scripts**: 履修・シラバス・課題・お知らせ・祝日を取得して `output/` に保存する core 層
- **Skill** (`.claude/commands/toyo.md`): Claude Code から `/project:toyo` で呼び出すLLM用の判断フロー
- **Bot** (`bot/`): Slash コマンドと cron 通知を提供する Discord bot

## クイックスタート

```bash
# 1. 初回ログイン（GUIで一度だけ）
npm run toyo:login

# 2. データを同期
npm run toyo:sync

# 3. Bot を起動（別端末で）
cd bot && uv sync && uv run toyo-discord-bot
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
| `npm run toyo:announcements` | ACEのコースニュース（休講・補講・教室変更含む）のみ取得 |
| `npm run toyo:calendar` | 内閣府CSVから祝日データを取得 |
| `npm run toyo:run` | セッション疎通確認用の最小ランナー |
| `npm run toyo:context` | エージェントが最初に読む圧縮コンテキストを生成 |
| `npm run toyo:candidates [-- --syllabus]` | 履修登録画面の全コマから登録可能な科目一覧を取得（`--syllabus` で夜間・集中科目のシラバスも取得、`--syllabus=all` で全科目） |
| `npm run toyo:lottery` | 抽選実施科目一覧と当落（○/×）を取得（登録成功は確定ではない。落選科目は履修から削除される） |
| `npm run toyo:credits` | 単位数集計表（卒業要件の充足状況・学期別 GPA）と履修・修得科目一覧（不合格含む）を取得 |
| `npm run toyo:schedule [-- --date YYYY-MM-DD]` | `data/academic-schedule.json`（しおりから手で起こした学年暦）を読み、指定日（既定: 今日 JST）に進行中・直近の期間と、各曜日の第N回授業日を表示（ポータル不要） |
| `npm run toyo:grading-rules` | シラバスの「成績評価の方法・基準」から配分・足切りを抽出して `grading-rules.json` に下書きを書く（`reviewed: true` の科目は上書きしない。ポータル不要） |
| `npm run toyo:register -- --file plan.json [--exec]` | 履修登録画面に科目を入れて送信。既定は dry-run、`--exec` で実際に登録 |
| `npm run typecheck` | TypeScript型チェック |

## 出力ファイル

| パス | 内容 |
|------|------|
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
| `output/bot/summary.json` | 上記を集約したBot/Skill用JSON |
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
- Bot状態: `state/discord-bot-state.json`

## 環境変数

`.env.local`（リポジトリルート）または `bot/.env`（Bot用）に保存できます。

### スクリプト用 (.env.local)

| 変数 | 内容 |
|------|------|
| `TOYO_USERNAME` / `TOYO_PASSWORD` | SSO自動再ログイン用 |
| `TOYO_CHROME_PATH` | Chrome実行パス上書き（既定: `/opt/google/chrome/chrome`） |
| `TOYO_HEADLESS=0\|1` | headed/headless強制 |
| `TOYO_PORTAL_URL` | ポータルURL上書き |

### Bot用 (bot/.env)

| 変数 | 内容 |
|------|------|
| `DISCORD_TOKEN` | **必須** |
| `DISCORD_GUILD_ID` | 任意。開発時のSlash Command即時反映用 |

通知先チャンネル・通知時刻・リマインド分は環境変数ではなく **Slashコマンドで設定**します。通知時刻の既定値は `07:00` / `22:00`（JST）で、日次サマリー内に新規課題と期限順の未提出上位を含めます（`bot/README.md` 参照）。

## ドキュメント

- [`docs/basic-info.md`](docs/basic-info.md) — 授業時間、キャンパスアクセス、入構ルールなど固定情報
- [`docs/toyo-automation-runbook.md`](docs/toyo-automation-runbook.md) — 運用手順、セッション喪失時の回復、情報ソースのルーティング表
- [`.claude/commands/toyo.md`](.claude/commands/toyo.md) — LLM用Skill定義（決定フロー・回答テンプレート）
- [`bot/README.md`](bot/README.md) — Discord botの設定・コマンド一覧

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
5. Bot を起動しておけば cron で自動同期 + 通知（同期失敗は3回連続後、1日1回だけ警告）

`toyo:context` は既定で `summary.json` が 30 分より古い場合に `toyo:sync` を試みます。既存出力だけで確認したい場合は `npm run toyo:context -- --no-sync`、JSONを標準出力したい場合は `npm --silent run toyo:context -- --format json` を使います。

ポータルが `システムエラー` / `タイムアウトしました。` / SSOログイン画面 / 多要素認証設定画面 のいずれかを返した場合はログイン喪失として扱います。共通ヘルパー `detectToyoSessionLoss` / `recoverToyoSessionIfNeeded` (`scripts/lib/toyo.ts`) が自動回復を試み、失敗した場合は手動再ログインを案内します。詳細は `docs/toyo-automation-runbook.md` を参照。
