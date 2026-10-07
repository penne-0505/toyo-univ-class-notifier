# Toyo University Automation

東洋大学の学内システム（学務ポータル / ToyoNet-ACE）から履修・課題・お知らせを取得し、LLM エージェントから利用できるようにするツール群です。

## アーキテクチャ

```
Scripts (scripts/)         ← 取得（fetch）→ 組み立て（build）→ 配信（publish）の 3 層 (Playwright + TypeScript)
   ↓ output/ にキャッシュ
Skill (.claude/commands/)  ← LLM の対話インターフェース
toyo:publish               ← ~/toyo-data (GitHub, 正本) と Worker へ配信
   ↓ PUT
Worker (worker/)           ← クラウドのエージェント向け REST (Cloudflare Workers + KV, Bearer キー必須)
```

- **Scripts**: 履修・シラバス・課題・お知らせ・祝日を取得して `output/` に保存し（取得層）、ファイルだけを読んで科目の対応表・summary・agent-context を作り（組み立て層）、toyo-data と Worker へ送る（配信層）。配置は下の「ディレクトリ構成」
- **Skill** (`.claude/commands/toyo.md`): Claude Code から `/project:toyo` で呼び出すLLM用の判断フロー
- **Worker** (`worker/`): 取得データを KV に持ち、クラウドのエージェントへ REST で返す（詳細は `worker/README.md`）

データの読み手は LLM エージェント（Claude Code の Skill、または Worker の REST / `toyo-data` repo 経由のクラウドのエージェント）です。

2026-10 に Discord bot は廃止しました。通知はこのマシンのデスクトップ通知（`toyo:health`。送り先は `.env.local` で Discord webhook / ntfy も選べます）が担い、外部からの鮮度確認はクラウドの秘書エージェントが `/v1/meta` の `publishedAt` と health で行います。

## ディレクトリ構成（scripts/）

```
scripts/
  toyo-*.ts   npm scripts の入口。対応モジュールの main() を呼ぶだけの薄いラッパー
  fetch/      取得層: ブラウザ・HTTP で 1 ソースずつ取り、output/toyo/<source>.json に落とす
  build/      組み立て層: ファイルだけを読んで派生物を作る（Playwright もネットワークも使わない）
  publish/    配信層: toyo-data（git）と Worker へ送る
  jobs/       ジョブ: 複数の段をつなぐ（watch / coursework / daily / sync、toyo:build の 3 段、health）
  lib/        共通: セッション・ブラウザ起動、env、パス、科目キー、正規化、health、notify
  dev/        開発用ツールとテスト（`npm test`）。parsers/ はパーサのテスト、fixtures/ は合成した入力データ
```

判断の基準は、ネットワーク・ブラウザを使うものは `fetch/`、ファイルだけ読んで派生物を作るものは `build/`、外部に送るものは `publish/`、複数の段をつなぐものは `jobs/`。コマンド名と本体ファイルの対応は `SPEC.md` の §5、各層の詳細は §3.3 と `docs/design/three-layer-refactor.md`。`build/` と `lib/` の純粋モジュールがブラウザ・ネットワークを読み込まないことは `scripts/dev/course-index.test.ts` が検査する。

## クイックスタート

```bash
# 1. 初回ログイン（GUIで一度だけ）
npm run toyo:login

# 2. データを同期
npm run toyo:sync
```

セッションが切れたら、もう一度 `npm run toyo:login` で再ログインします。

## スクリプト一覧

| コマンド | 内容 |
|---------|------|
| `npm run toyo:login` | 専用Chromeプロファイルでポータルにログインし、`storageState` を保存（セッション期限切れ時の再ログインにも使う） |
| `npm run toyo:check` | 保存済みセッションが有効か headless で確認 |
| `npm run toyo:sync [-- --no-build]` | 履修・課題・コンテンツ・お知らせ・祝日をまとめて取得し、`toyo:build` を実行（シラバスは取得しない。`--no-build` で build を省略） |
| `npm run toyo:export-enrollment` | 履修登録確認表のみ取得・整形（`registration-data.json` と `registration-summary.md`） |
| `npm run toyo:syllabus -- --course-code <code>` | 指定授業のシラバスを取得（学期内キャッシュあり） |
| `npm run toyo:syllabus:seed [-- --force] [--course-code <code>]` | シラバスの本文から、登録中科目の `output/toyo/syllabus/<授業コード>.json/.md` を書き出す（ブラウザ不要）。入力は `--from <ファイル>` が無ければ `output/toyo/syllabus-pool/` → 最新の `registration-candidates.json` の順。既存は `--force` で上書き。`--course-code` で対象を絞る |
| `npm run toyo:build` | 組み立て層をまとめて実行: `course-index.json` → `summary.json` → `agent-context.{json,md}`（各段 1 行サマリ）。取得層の出力ファイルを読むだけで、ネットワークもブラウザも使わない（純粋処理）。データの欠け（シラバス・ACE 未反映・評価ルール）は index と agent-context の Warnings に出し、失敗にはしない。どのジョブも取得のあとにこれを呼ぶ |
| `npm run toyo:build:index` | `output/toyo/course-index.json`（科目の対応表）だけを作る。授業コード・ACE のコース ID・scheduleCd・時限・シラバス/評価ルール/ACE の有無を科目ごとにまとめ、今学期の科目の欠けを `warnings` に出す |
| `npm run toyo:announcements` | ACEのコースニュース（休講・補講・教室変更含む）のみ取得 |
| `npm run toyo:coursework [-- --no-build]` | ACE の全 2026 年度コースの提出状況を取得（`_report` / `_query` / `_survey` / `_grade` と提出記録 30 日）→ `output/toyo/toyonet-ace-coursework.json`。授業コードで `registration-data.json` と突き合わせる。取得後に `toyo:build` を実行（`--no-build` で省略）。`toyo-coursework` タイマー（毎時 :20）用 |
| `npm run toyo:calendar` | 内閣府CSVから祝日データを取得 |
| `npm run toyo:context [-- --print]` | エージェントが最初に読む圧縮コンテキストを `output/toyo/agent-context.{md,json}` に生成（`toyo:build` の最後の段だけを単独で実行する薄い CLI。取得も sync もしない）。標準出力は 1 行サマリのみ（全文は `--print`、JSON は `--print --format json`） |
| `npm run toyo:candidates [-- --syllabus] [--add] [--refresh-pool]` | 履修登録画面の全コマから登録可能な科目一覧を取得（`--syllabus` で夜間・集中科目のシラバスも取得、`--syllabus=all` で全科目）。保存先は `registration-candidates.json`（最新）と `registration-candidates.<regular\|add>.json`（期間別）。取得したシラバス本文は `syllabus-pool/<授業コード>.json` にも貯める（既存は上書きしない。`--refresh-pool` で上書き） |
| `npm run toyo:lottery` | 抽選実施科目一覧と当落（○/×）を取得（登録成功は確定ではない。落選科目は履修から削除される） |
| `npm run toyo:credits` | 単位数集計表（卒業要件の充足状況・学期別 GPA）と履修・修得科目一覧（不合格含む）を取得 |
| `npm run toyo:schedule [-- --date YYYY-MM-DD]` | `data/academic-schedule.json`（しおりから手で起こした学年暦）を読み、指定日（既定: 今日 JST）に進行中・直近の期間と、各曜日の第N回授業日を表示（ポータル不要） |
| `npm run toyo:grading-rules` | シラバスの「成績評価の方法・基準」から配分・足切りを抽出して `grading-rules.json` に下書きを書く（`reviewed: true` の科目は上書きしない。ポータル不要） |
| `npm run toyo:register -- --file plan.json [--exec]` | 履修登録画面に科目を入れて送信。既定は dry-run、`--exec` で実際に登録 |
| `npm run toyo:publish [-- --dry-run --include-candidates --force --push-all-api]` | allowlist（`output/toyo/**`・`data/**`）を `~/toyo-data` へ同期し、時刻以外に差分があるときだけ commit & push。`meta.json` に鮮度・`sourceStatus` を書く。`TOYO_API_URL` / `TOYO_API_WRITE_KEY` があれば変化分を Worker にも PUT（`--push-all-api` で全件） |
| `npm run toyo:watch` | ACE の未提出課題とお知らせだけ取得し、変化があれば `toyo:build` → publish（5 分タイマー用。失敗が続くと 15→30 分に自動バックオフ） |
| `npm run toyo:daily` | 全取得（coursework → sync → credits → lottery）→ `toyo:build:index` → index で今学期のシラバスが欠けている科目を補完（pool から seed → 無ければ時間割検索。**補完の失敗は警告にとどめ daily は成功扱い**）→ `toyo:build` → `toyo:publish --include-candidates --force`（24 時間タイマー用） |
| `npm run toyo:health -- <record\|status\|test-notify>` | 定期ジョブ（watch / coursework / daily）の失敗検知と通知。`status` で状態一覧（アラート中なら終了コード 1）、`test-notify` でテスト通知。systemd の `ExecStopPost` が成否を記録する。閾値・送り先は `docs/toyo-automation-runbook.md` の「失敗の検知と通知」 |
| `npm run typecheck` | TypeScript型チェック |

## 出力ファイル

| パス | 内容 |
|------|------|
| `worker/`（デプロイ先 `https://toyo-data-api.penne0505pp.workers.dev`） | 上記データを REST で読む Worker。`/v1/context` など。Bearer キー必須 |
| `output/toyo/toyonet-ace-coursework.json` | ACE のコース別提出状況。`courses[].items`（type: report/query/survey、status: open/waiting/closed/unknown、submitted: true/false/null、opensAt/dueAt）、`counts`（report+query のみ。アンケートは除く）、`grades`、トップレベルの `submissions`（提出記録 30 日）。drill（Web最終テスト）は query 扱い |
| `output/toyo/registration-data.json` | 履修登録確認表（`fetchStatus: success/error/empty`） |
| `output/toyo/registration-summary.md` | 履修まとめ（人間向け） |
| `output/toyo/syllabus/<授業コード>.json` | シラバス（学期内キャッシュ） |
| `output/toyo/toyonet-ace-assignments.json` | 未提出課題一覧 |
| `output/toyo/toyonet-ace-contents.json` | コース掲示資料 |
| `output/toyo/announcements.json` | コースニュース（カテゴリ: 休講/補講/教室変更/その他） |
| `output/toyo/academic-calendar.json` | 祝日データ |
| `data/academic-schedule.json` | 学年暦（履修登録・抽選・追加登録・取消申請の期間、授業開始日など）。しおりから手書きの静的データ（git 管理）。履修登録関連の期間のみ置き、授業終了日・試験期間・休講振替・成績発表など学年暦の詳細はユーザーの Google カレンダーが正（`unknown` に列挙、ここでは埋めない） |
| `data/grading-rules.json` | 科目ごとの成績配分（components）・足切り（cutoffs）。`toyo:grading-rules` の下書きを人が直したもの（`reviewed` で区別）。`agent-context` の各授業に `gradingRules` として載る |
| `output/toyo/summary.json` | 全ソースを集約した summary（`toyo:build` が作る。Skill・Worker・toyo-data が読む。旧 `output/bot/summary.json` は廃止） |
| `output/toyo/course-index.json` | 科目の対応表（`toyo:build` が作る）。課題・お知らせ・コンテンツの科目の突き合わせはこれを引く |
| `output/toyo/agent-context.json` | エージェント用の圧縮コンテキスト（構造化JSON） |
| `output/toyo/agent-context.md` | エージェント用の圧縮コンテキスト（Markdown） |
| `output/toyo/registration-candidates.json` | 履修登録画面から取得した登録可能科目（選択ID `scheduleCd`、コマ、シラバス）。最新の取得結果で、期間（正規 / 追加）を問わず上書きされる |
| `output/toyo/registration-candidates.<regular\|add>.json` | 同上の期間別。その期間の最新の取得結果が残る（配信対象外） |
| `output/toyo/syllabus-pool/<授業コード>.json` | 登録可能科目のシラバス本文の貯め場所（約 146 科目）。候補ファイルが上書きされても残る。配信対象外 |
| `output/toyo/course-index.json` | 科目の対応表（組み立て層の出力）。`courses[]`: `courseCode` / `semester` / `names`（portal・ace・key）/ `aceCourseId` / `scheduleCd`（推定のとき `scheduleCdInferred: true`）/ `slots` / `has`（syllabus・gradingRules・aceCourse）/ `warnings`、トップレベル `aceOnly`。`warnings` は今学期の科目だけ |
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

`plan.json` は `["scheduleCd", ...]` の配列（`registration-candidates.json` の `scheduleCd`）。履修上限（所属学部ごとに決まる。例: 学期 24 単位）や重複はサーバー側で判定され、エラーがあれば何も登録されない。

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

## 開発

このリポジトリは**公開**です。本人の履修科目・学部・学年・成績・学籍番号・氏名・鍵はコミットしません（実データは `output/`（git 管理外）と非公開の `toyo-data` にあります）。

### テスト

```bash
npm test             # scripts/dev/*.test.ts と scripts/dev/parsers/*.test.ts（node:test + tsx。ネットワーク・ポータル不要）
npm run typecheck
```

- `scripts/dev/parsers/` はポータル・ACE のページから文字列を読む部分（履修登録確認表、単位数集計、履修修得科目、抽選結果、ACE の提出状況・課題・お知らせ、シラバスの成績評価の抽出、ジョブの失敗検知）のテスト。取得（Playwright）と解釈（純粋関数）を分けてあり、テストは解釈だけを対象にする。
- パーサを直したときは、`scripts/dev/fixtures/` の入力に事例を足して回帰ケースにする。

### fixtures の方針

- `scripts/dev/fixtures/` には**合成データだけ**を置く。本物の履修・成績・氏名・学籍番号・担当者・授業コードは入れない。
- 実ページの構造（タブ区切り、行の並び、見出し、注記）は保ち、科目名・授業コード・担当者・成績・学籍番号・氏名だけを架空のものに差し替える。構造の確認に実ページを取得したときは `tmp/`（git 管理外）に保存し、コミットしない。
- 例外はシラバスの成績評価欄の文章（大学が公開している情報）。科目名・担当者が文中に無い範囲で使う。

### 公開前の検査

```bash
npx tsx scripts/dev/check-public-privacy.ts [--include-untracked]
```

git 管理下の全テキストファイルに、ローカルの個人データ（`output/toyo/registration-data.json` と `data/grading-rules.json` の科目名・授業コード・担当者、学籍番号・氏名、所属が分かる語、`~/.config/toyo-data-api/keys.json` のキー）が含まれていないかを調べます。ヒットは `ファイル:行 [種別]` で出し（値は出さない）、1 件でもあれば終了コード 1 です。コミットや push の前に実行してください。これらのファイルが無い環境では該当する検査をスキップします。

## ドキュメント

- [`docs/basic-info.md`](docs/basic-info.md) — 授業時間、キャンパスアクセス、入構ルールなど固定情報
- [`docs/toyo-automation-runbook.md`](docs/toyo-automation-runbook.md) — 運用手順、セッション喪失時の回復、情報ソースのルーティング表
- [`.claude/commands/toyo.md`](.claude/commands/toyo.md) — LLM用Skill定義（決定フロー・回答テンプレート）

## 想定ワークフロー

1. `npm run toyo:login` を一度実行してログインを完了する
2. `npm run toyo:check` で保存セッションが有効か確認
3. 必要なときに `npm run toyo:sync` を走らせて最新化
4. エージェントに授業相談を投げる前に `npm run toyo:context` で圧縮コンテキストを生成
5. 定期ジョブ（systemd タイマー、`deploy/README.md`）が自動で同期・配信し、失敗が続くと `toyo:health` が通知する

`toyo:context` は取得も sync もしません。`summary.json` が 30 分より古いときは Warnings と `freshness.stale` に出るだけなので、最新にしたいときは `npm run toyo:sync` → `npm run toyo:build` の順に実行します。標準出力は `[context] <JST> today=n tomorrow=m warnings=k` の 1 行だけで（journal を汚さないため）、全文は `output/toyo/agent-context.md` を読むか `--print` を付けます。JSON を標準出力したい場合は `npm --silent run toyo:context -- --print --format json` です。定期ジョブが失敗中・停止中のときは Warnings に載ります。

ポータルが `システムエラー` / `タイムアウトしました。` / SSOログイン画面 / 多要素認証設定画面 のいずれかを返した場合はログイン喪失として扱います。共通ヘルパー `detectToyoSessionLoss` / `recoverToyoSessionIfNeeded` (`scripts/lib/toyo.ts`) が自動回復を試み、失敗した場合は手動再ログインを案内します。詳細は `docs/toyo-automation-runbook.md` を参照。
