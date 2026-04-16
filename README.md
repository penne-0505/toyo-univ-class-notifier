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
| `output/bot/summary.json` | 上記を集約したBot/Skill用JSON |

エラー時のスナップショットは `artifacts/toyo/` に保存されます。

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

通知先チャンネル・通知時刻・リマインド分は環境変数ではなく **Slashコマンドで設定**します（`bot/README.md` 参照）。

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
4. Bot を起動しておけば cron で自動同期 + 通知

ポータルが `システムエラー` / `タイムアウトしました。` / SSOログイン画面 / 多要素認証設定画面 のいずれかを返した場合はログイン喪失として扱います。共通ヘルパー `detectToyoSessionLoss` / `recoverToyoSessionIfNeeded` (`scripts/lib/toyo.ts`) が自動回復を試み、失敗した場合は手動再ログインを案内します。詳細は `docs/toyo-automation-runbook.md` を参照。
