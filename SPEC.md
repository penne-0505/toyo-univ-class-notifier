# SPEC.md — 東洋大学 学内システム自動化スクリプト群

本書は、`scripts/` ディレクトリ配下に実装されるデータ取得・集約スクリプト群を再実装するための仕様である。

## 1. 概要

### 1.1 目的

東洋大学の学内システム（学務ポータル `g-sys.toyo.ac.jp` / LMS「ToyoNet-ACE」`www.ace.toyo.ac.jp`）に対し、保存済みブラウザセッションを用いた自動ログイン・スクレイピングを行い、履修情報・シラバス・課題・コースニュース・祝日を構造化データとして `output/` 配下に保存する。出力は LLM エージェントなどの下流コンポーネントから参照されることを前提とする。

### 1.2 スコープ

本仕様の対象は `scripts/` 配下の TypeScript エントリポイント 9 本、共有ライブラリ 7 本、Python 補助スクリプト 1 本である。

- **対象**: `scripts/*.ts`, `scripts/lib/*.ts`, `scripts/toyo-build-timetable.py`, `package.json` の npm scripts 定義
- **対象外**: `.claude/commands/`（LLM Skill 定義）、`tests/`、`docs/` の内容。ただしこれらは `output/` のファイル形式を消費するため、出力スキーマは下流互換を維持すること

### 1.3 処理フロー概要

```
toyo:login ──→ storageState（playwright/.auth/toyo-state.json）を保存
                    │
【取得層】ブラウザ・HTTP で 1 ソースずつ取り、output/toyo/<source>.json に落とす
toyo:sync ────┬──→ 履修登録確認表 ──→ registration-data.json / .md
              ├──→ ACE 課題 ───────→ toyonet-ace-assignments.json
              ├──→ ACE コンテンツ ─→ toyonet-ace-contents.json
              ├──→ ACE お知らせ ───→ announcements.json
              └──→ 祝日 CSV ───────→ academic-calendar.json
toyo:syllabus / toyo:daily（index の欠けの補完）──→ syllabus/<授業コード>.json / .md

【組み立て層】ファイルだけを読む純粋処理（scripts/build/。Playwright もネットワークも使わない）
toyo:build ───┬──→ index ──→ course-index.json（科目の対応表。欠けは warnings）
              ├──→ summary ─→ output/toyo/summary.json
              └──→ context ─→ agent-context.json / .md
```

## 2. 前提環境・依存

### 2.1 ランタイム

- Node.js（`fetch`・`node:fs/promises`・`node:child_process` が利用可能なバージョン。global `fetch` を直接使用するため Node 18 以降）
- TypeScript は実行時トランスパイルせず `tsx` で直接実行する。`package.json` は `"type": "commonjs"` とし、各スクリプトは `import` 構文と `require.main === module` ガードを併用する（tsx の CJS 実行を前提）
- Python 3.x（仮想環境 `.venv/`、パスは `<repoRoot>/.venv/bin/python` 固定で参照）

### 2.2 npm 依存関係

| パッケージ | 用途 |
|---|---|
| `@playwright/test` (`^1.59.1`) | ブラウザ自動化。コード上は同梱の `playwright` パッケージから `chromium` / `Browser` / `BrowserContext` / `Page` を import する |
| `tsx` (`^4.21.0`) | TS スクリプト実行 |
| `typescript` (`^6.0.2`) | 型チェック（`tsc --noEmit`） |
| `@types/node` | Node 型定義 |

### 2.3 Python 依存関係

`.venv` に `openpyxl` をインストールすること（時間割 `.xlsx` 生成に使用）。

### 2.4 ブラウザ

- 実行バイナリはシステムインストールの Chrome を使う。既定パス `/opt/google/chrome/chrome`
- Playwright 同梱 Chromium ではなく `executablePath` 指定で起動する

## 3. ディレクトリ構成とファイルパス

`repoRoot` は `scripts/lib/` から 2 階層上（リポジトリルート）とする。以下のパスはすべて `repoRoot` からの相対で記す。

### 3.1 入力・ランタイム

| パス | 内容 | 環境変数による上書き |
|---|---|---|
| `playwright/.profiles/toyo` | 専用 Chrome 永続プロファイル | `TOYO_PROFILE_DIR` |
| `playwright/.auth/` | 認証情報ディレクトリ | `TOYO_AUTH_DIR` |
| `playwright/.auth/toyo-state.json` | `context.storageState()` 出力 | `TOYO_STORAGE_STATE` |
| `playwright/.auth/toyo-session.json` | セッションメタデータ `{savedAt, title, url}` | なし（`authDir` 連動） |
| `artifacts/toyo/` | スナップショット・診断出力 | `TOYO_ARTIFACT_DIR` |
| `artifacts/toyo/toyonet-ace-diagnostics.json` | ACE 診断ログ | なし |
| `.env.local`, `.env` | 環境変数ファイル（後述） | — |
| `docs/basic-info.md` | 固定情報（コンテキスト生成時にパスのみ参照） | — |

### 3.2 出力ファイル

| パス | 生成元 | 内容 |
|---|---|---|
| `output/toyo/registration-data.json` | 履修取得 | 履修登録確認表の構造化データ |
| `output/toyo/registration-summary.md` | 同上 | 人間向け Markdown |
| `output/spreadsheet/toyo-timetable.xlsx` | Python ビルダ | 時間割スプレッドシート |
| `output/toyo/syllabus/<stem>.json` / `.md` | シラバス取得 | 学期内キャッシュとしても機能 |
| `output/toyo/toyonet-ace-assignments.json` | ACE 課題取得 | 未提出課題一覧 |
| `output/toyo/toyonet-ace-contents.json` | ACE コンテンツ取得 | コース掲示資料 |
| `output/toyo/announcements.json` | ACE お知らせ取得 | コースニュース（カテゴリ分類済み） |
| `output/toyo/academic-calendar.json` | 祝日取得 | 内閣府祝日データ |
| `output/toyo/course-index.json` | 組み立て層（index） | 科目の対応表（授業コード・ACE courseId・scheduleCd・`has.*`・`warnings`） |
| `output/toyo/summary.json` | 組み立て層（summary） | 全ソース集約 JSON |
| `output/toyo/agent-context.json` / `.md` | コンテキスト生成 | エージェント向け圧縮コンテキスト |

## 4. 環境変数

### 4.1 env ファイル読み込み

共有ライブラリ `lib/toyo.ts` はモジュールロード時に `repoRoot/.env.local` → `repoRoot/.env` の順で読み込む簡易パーサを持つ。

- 各行を `KEY=VALUE` 形式で解釈。空行・`#` 始まりは無視
- 前後の `"` または `'` で囲まれた値はクォートを除去
- **既に `process.env` に存在するキーは上書きしない**
- 後に読むファイル（`.env`）は先（`.env.local`）の値を上書きしない

### 4.2 変数一覧

| 変数 | 用途 |
|---|---|
| `TOYO_USERNAME` / `TOYO_PASSWORD` | SSO ログインフォーム自動入力。未設定時は自動送信しない |
| `TOYO_CHROME_PATH` / `CHROME_PATH` | Chrome 実行パス（優先順: `TOYO_CHROME_PATH` > `CHROME_PATH` > 既定値） |
| `TOYO_HEADLESS` | `'1'` → 強制 headless、`'0'` → 強制 headed、未設定 → 各コマンドの既定 |
| `TOYO_PORTAL_URL` | ポータル URL 上書き（既定 `https://g-sys.toyo.ac.jp/portal`） |
| `TOYO_ARTIFACT_DIR` / `TOYO_AUTH_DIR` / `TOYO_PROFILE_DIR` / `TOYO_STORAGE_STATE` | 3.1 のパス上書き |
| `DISPLAY` / `WAYLAND_DISPLAY` | headed ログイン実行可否の判定に使用（OS 環境変数） |

## 5. コマンド一覧（npm scripts）

| コマンド | エントリポイント | 概要 |
|---|---|---|
| `typecheck` | `tsc --noEmit` | 型チェック |
| `toyo:login` | `scripts/toyo-login.ts` | 専用プロファイルで GUI ログインし storageState を保存 |
| `toyo:refresh-session` | 同上（別名） | セッション期限切れ時の再ログイン |
| `toyo:check` | `scripts/toyo-check.ts` | 保存セッションの有効性を確認 |
| `toyo:run` | `scripts/toyo-run.ts` | セッション疎通確認の最小ランナー |
| `toyo:export-enrollment` | `scripts/toyo-export-enrollment.ts` | 履修登録確認表のみ取得 + xlsx 生成 |
| `toyo:syllabus` | `scripts/toyo-fetch-syllabus.ts` | 指定科目のシラバス取得 |
| `toyo:calendar` | `scripts/toyo-fetch-calendar.ts` | 祝日データ取得 |
| `toyo:announcements` | `scripts/toyo-fetch-announcements.ts` | ACE コースニュース取得 |
| `toyo:sync` | `scripts/toyo-sync.ts` | 履修・課題・コンテンツ・お知らせ・祝日を取得 → `toyo:build`（`--no-build` で省略） |
| `toyo:build` | `scripts/toyo-build.ts` | 組み立て層をまとめて実行: index → summary → context（取得はしない） |
| `toyo:build:index` | `scripts/toyo-build-index.ts` | `course-index.json` だけを作る |
| `toyo:context` | `scripts/toyo-context.ts` | エージェント向け圧縮コンテキスト生成（読み込み・書き出しだけの薄い CLI。組み立ては `scripts/build/context.ts`） |
| `toyo:candidates` | `scripts/toyo-fetch-registration-candidates.ts` | 履修登録画面の全コマから登録可能科目（＋シラバス）を取得 |
| `toyo:credits` | `scripts/toyo-fetch-credits.ts` | 単位数集計表・履修修得科目一覧を取得 |
| `toyo:lottery` | `scripts/toyo-fetch-lottery.ts` | 抽選実施科目一覧と当落（○/×）を取得 |
| `toyo:register` | `scripts/toyo-register.ts` | 履修登録画面に科目を入れて送信（既定 dry-run） |

## 6. 外部システムと URL

| 対象 | URL |
|---|---|
| 学務ポータル | `https://g-sys.toyo.ac.jp/portal` |
| 履修登録確認表照会 | `https://g-sys.toyo.ac.jp/univision/action/in/f08/Usin080111` |
| 時間割（シラバス検索入口） | `https://g-sys.toyo.ac.jp/univision/action/in/f02/Usin026411` |
| 履修登録（正規登録期間） | `https://g-sys.toyo.ac.jp/univision/action/in/f07/Usin070311`（科目一覧サブウィンドウ `Usin071640`、送信先 `Usin070321`、エラー一覧 `Usin0716E1`） |
| 履修登録（追加登録期間） | `https://g-sys.toyo.ac.jp/univision/action/in/f07/Usin071611`（期間外は「使用可能対象外」） |
| 抽選実施科目一覧 | `https://g-sys.toyo.ac.jp/univision/action/in/f07/Usin07Z211`（`toyo:lottery`。期間外は「使用可能対象外」） |
| 単位数集計表 | `https://g-sys.toyo.ac.jp/univision/action/in/f08/Usin080411`（検索送信で `Usin080421`） |
| 履修・修得科目一覧 | `https://g-sys.toyo.ac.jp/univision/action/in/f08/Usin080311`（`year_from`/`year_to` 必須、`gradeInPastYear=1` で不合格含む） |
| シラバス詳細（登録画面経由） | `https://g-sys.toyo.ac.jp/univision/action/cm/f03/Uscm030170?option=<年度>/<年度>_<番号>[_en].html`（サブウィンドウ経由のみ） |
| SSO ホスト | `slink.secioss.com` |
| SSO 回復用ログイン URL | `https://slink.secioss.com/pub/login.cgi?back=%2fuser%2findex.php%3ftenant%3dtoyo.jp` |
| ACE ログイン | `https://www.ace.toyo.ac.jp/ct/login` |
| ACE コース一覧 | `https://www.ace.toyo.ac.jp/ct/home_course` |
| ACE 未提出課題 | `https://www.ace.toyo.ac.jp/ct/home_library_query` |
| ACE リマインダ一覧 | `https://www.ace.toyo.ac.jp/ct/home_library_reminder?count=50` |
| 内閣府 祝日 CSV | `https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv` |

## 7. 共通ライブラリ仕様

### 7.1 `lib/toyo.ts` — ブラウザ・セッション基盤

モジュールロード時に `.env.local` / `.env` を読み込む（4.1）。以下の公開 API を提供する。

#### パス定数

`paths` オブジェクトとして `repoRoot` / `artifactDir` / `authDir` / `profileDir` / `storageStatePath` を公開する（値は 3.1・4.2 に従う）。

#### ブラウザ起動

- `launchPersistentBrowser({headless})`: `chromium.launchPersistentContext(profileDir, ...)` で永続プロファイル起動。オプション:
  - `executablePath: getChromePath()`
  - `viewport: { width: 1440, height: 900 }`
  - `locale: 'ja-JP'`, `timezoneId: 'Asia/Tokyo'`
  - `args: ['--disable-blink-features=AutomationControlled']`
- `launchBrowser({headless})`: `chromium.launch({ executablePath, headless })`
- `launchStateContext({headless})`: `storageStatePath` が存在しなければ `"Saved auth state was not found ... Run \"npm run toyo:login\" first."` で例外。`browser.newContext({ storageState, viewport: 1440x900, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' })` を返す。戻り値は `{ browser, context }`
- いずれも起動前に `artifactDir` / `authDir` / `dirname(storageStatePath)` / `dirname(profileDir)` を `mkdir -p` する
- `getOrCreatePage(context)`: 閉じていない既存ページがあればそれを、なければ `newPage()` を返す

#### 判定ユーティリティ

- `isLoginUrl(url)`: ホスト名が `slink.secioss.com` なら true
- `isPortalUrl(url)`: ホスト名が `g-sys.toyo.ac.jp` かつパスが `/portal` で始まるなら true
- `shouldRunHeadless(defaultValue)`: `TOYO_HEADLESS` が `'1'`/`'0'` ならそれに従い、未設定なら `defaultValue`
- `gotoPortal(page)`: `portalUrl` へ `waitUntil: 'domcontentloaded'`, timeout 60s で遷移し、`networkidle` を 15s まで待つ（タイムアウトは握り潰す）

#### ログイン自動入力

`autoFillLogin(page)`:

- `TOYO_USERNAME` / `TOYO_PASSWORD` の両方が設定されていなければ `false`
- `#username_input` と `#password_input` が DOM に存在しなければ `false`
- 両フィールドを fill し `#login_button` を click、 `true` を返す

#### セッション喪失検知

`detectToyoSessionLoss(page)` は次を順に評価し、最初に合致した理由を返す。合致なしは `null`。

| 優先 | 条件 | 戻り値 |
|---|---|---|
| 1 | ページタイトルまたは body テキストに `システムエラー` | `'system-error'` |
| 2 | body テキストに `タイムアウトしました` | `'timeout'` |
| 3 | body テキストに `多要素認証設定画面` | `'mfa-settings'` |
| 4 | `#username_input, #password_input, #login_button` のいずれかが DOM に存在 | `'login-form'` |
| 5 | `isLoginUrl(page.url())` | `'sso-login'` |

body テキスト取得は `innerText({ timeout: 5000 })`、失敗時は空文字として扱う。

#### セッション回復

`recoverToyoSessionIfNeeded(page, options)`:

- options: `{ returnUrl?, saveState?, snapshotTag?, timeoutMs? }`。`timeoutMs` 既定 60,000ms
- 喪失が検知されなければ即座に `{ recovered: false, ... }` を返す
- 検知時の手順:
  1. `snapshotTag` 指定時はスナップショットを保存（失敗は無視）
  2. SSO 回復 URL へ遷移（`domcontentloaded` + `networkidle`）
  3. `autoFillLogin` を試行。自動送信できず、かつ再検知で `login-form`/`sso-login` のままなら例外（手動 `toyo:login` を案内するメッセージ）
  4. 自動送信後は「ホストが `slink.secioss.com` でなくなる」または「ログインフォーム要素が消える」まで `waitForFunction`（timeoutMs、タイムアウトは握り潰し）
  5. `returnUrl` がポータル URL でない場合はポータルへ一度遷移してウォームアップし、再検知で `mfa-settings` 以外の喪失が残れば例外
  6. `returnUrl` へ復帰遷移し、再度 `detectToyoSessionLoss`。残っていれば例外
  7. `saveState: true` なら `saveSessionState` を実行
- 戻り値: `{ finalUrl, loginUrl, reason, recovered, returnUrl }`

#### セッション待機・保存

- `waitForSession(page, timeoutMs)`: 「URL が `g-sys.toyo.ac.jp/portal`」または「URL に `slink.secioss.com` を含まず `portalUrl` で始まる」まで `waitForFunction` で待機。その後 `networkidle` 15s（握り潰し）
- `saveSessionState(context, page)`: `context.storageState()` を `storageStatePath` へ保存し、`authDir/toyo-session.json` に `{ savedAt: ISO8601, title, url }` を書き込む
- `readSessionMetadata()`: `toyo-session.json` を読み `{savedAt, title, url}` を返す。不在時 `null`

#### スナップショット

`collectPortalSnapshot(page, tag)`:

- `tag` を `[^a-z0-9_-]` → `-` 置換 + 小文字化した `safeTag` に正規化
- `artifactDir/<safeTag>.png` にフルページスクリーンショット
- `artifactDir/<safeTag>.json` に以下を保存: `{ title, url, headings(≤20件), links(≤30件, {text, href}), textPreview(≤3000文字) }`
  - headings は `h1, h2, h3` の textContent、links は `a` 要素から抽出。textPreview は body innerText の空白正規化済み先頭部分

### 7.2 `lib/toyo-enrollment.ts` — 履修登録確認表

#### 取得処理 `scrapeEnrollmentData()`

1. `launchStateContext`（headless 既定 true）で起動
2. 履修登録確認表 URL（§6）へ遷移 → `recoverToyoSessionIfNeeded({ returnUrl: 確認表URL, saveState: true, snapshotTag: 'registration-session-loss' })`
3. body `innerText` を取得し NBSP→空白に正規化、行単位で trim・空行除去
4. 学生情報の抽出:
   - `学籍番号`: `/学籍番号\s+([0-9]+)/`
   - `開講年度`: `/開講年度\s+([0-9]{4})/`
   - `学籍番号` を含む行の `氏名\s+(.+)$` をカナ氏名、その次行を氏名とする
5. 科目行のパース（タブ区切り、10 フィールド以上を要求）:
   - 完全一致するヘッダ行 `曜日 時限 学期 授業コード 科目ナンバリング 科目名 実施形態 担当者 教室 キャンパス 単位` はスキップ
   - `学期` で終わり `授業` を含まない行 → 学期ラベルとして保持
   - `注）` で始まる行で打ち切り
   - 先頭フィールドが `月〜日` の曜日なら曜日を更新して次フィールドへ、そうでなければ前行の曜日を継承
   - 以降 `時限, 学期(term), 授業コード, ナンバリング, 科目名, 実施形態, 担当者, 教室, キャンパス, 単位` を取得
   - 行はタブ区切りのまま位置で読む（空欄を落とさない）。英数字 10 桁の授業コードの位置を基準に、前側を `曜日 時限 学期`、後側を `ナンバリング 科目名 実施形態 担当者 教室 キャンパス 単位` とする
   - 先頭が `集中その他` の行は `day = '集中'`, `period = ''`。先頭が空の継続行は直前の曜日（集中ブロックを含む）を継承する
   - `曜日・授業コード・科目名` が空ならスキップ
   - 時限・単位は全角数字を半角化。単位は数値化できなければ `null`
6. `fetchStatus` 判定（§7.2 後段）を付けて `EnrollmentData` を返す

#### fetchStatus 判定

| 条件 | 値 |
|---|---|
| `pageTitle` に `システムエラー` または `タイムアウト` を含む | `'error'` |
| `courses` が 0 件（上記以外） | `'empty'` |
| それ以外 | `'success'` |

#### Markdown 生成 `buildEnrollmentMarkdown(data)`

- 科目一覧は曜日順（月→日）、時限昇順、科目名 `ja` ロケール順にソート
- 構成: 見出し・メタ情報（取得日時/参照元/学籍番号/氏名/開講年度/登録科目数/登録単位数合計）、`## 集計`（曜日別・実施形態別・キャンパス別の件数を `ja` ソート）、`## 履修科目一覧`（11 列の Markdown 表）、`## メモ`（出典注記の固定文）

#### 成果物書き出し・xlsx 起動

- `writeEnrollmentArtifacts(data)`: `registration-data.json`（2 スペース整形 JSON）と `registration-summary.md` を書き出す
- `runPythonWorkbookBuilder()`: `<repoRoot>/.venv/bin/python scripts/toyo-build-timetable.py <registration-data.json> <toyo-timetable.xlsx>` を `stdio: inherit` で spawn。終了コード非 0 で reject

### 7.3 `lib/toyonet-ace.ts` — ACE 課題・コースコンテンツ

#### ページ状態診断

- `inspectAcePage(page)`: ページ内評価で `{ state, url, title, bodyPreview(≤500), hasPendingAssignmentsTable, hasLoginForm }` を返す
  - `state`: URL が `slink.secioss.com` で始まるかログインフォーム 3 要素（`#username_input`/`#password_input`/`#login_button`）が**すべて**存在 → `'login'`。`table.stdlist` 存在または本文に `未提出の課題一覧`/`未提出課題` → `'pending-list'`。それ以外 `'unknown'`
- `resolveAceLoginIfNeeded(page, stage, steps, returnUrl?)`: 診断を `steps` 配列に追記し、`recoverToyoSessionIfNeeded({ returnUrl, saveState: true, snapshotTag: 'toyonet-ace-<stage>' })` を呼ぶ。回復した場合も `steps` に追記
- 失敗時は `artifacts/toyo/toyonet-ace-diagnostics.json` に `{ fetchedAt, stage, steps, page: <診断> }` を書き出す

#### 課題一覧 `collectToyoNetAceAssignments()`

1. ACE ログイン URL → 未提出課題 URL（`/ct/home_library_query`）の順に遷移し、各段階で `resolveAceLoginIfNeeded`
2. 最終状態が `'login'` なら例外、`'pending-list'` でなければ `table.stdlist` 等の出現を最大 30s 待機（失敗時は診断付きで例外）
3. `table.stdlist` の行（`th` を含む行は除く）を td 位置でパース: `[0]=タイプ, [1]=タイトル(+a の href), [2]=コース名, [3]=受付開始, [4]=締切, [5]=受付期間`
4. `Assignment` に変換:
   - `assignmentId`: href の URL パス末セグメント。なければ `コース名:タイトル` の空白を `_` にしたもの（200 文字まで）
   - `dueAt`: `YYYY-MM-DD HH:MM[:SS]` → `YYYY-MM-DDTHH:MM:SS+09:00`（秒省略時 `:00` 補完）。パース不可なら `null`
   - `status: 'pending'` 固定
   - `notes`: `タイプ: X`、パースできた `受付開始: <ISO>`（不可なら生テキスト）、`受付期間: <生テキスト>`
5. `assignmentId` で重複除去し `toyonet-ace-assignments.json` へ `{ fetchedAt, source: 'toyonet-ace', available: true, assignments, errors: [] }` を保存
6. 例外時はスナップショット `toyonet-ace-home-library-query-error` + 診断ファイルを残し、`{ available: false, assignments: [], errors: [<メッセージ+パス>] }` を返す（throw しない）

#### コースコンテンツ `collectToyoNetAceContents(registeredCourseNames)`

1. `/ct/home_course` へ遷移 → `resolveAceLoginIfNeeded`
2. ページ内リンクのうちパスが `^/ct/course_\d+$` のものを `{courseName, courseUrl}` として収集
3. `registeredCourseNames` 非空ならコース名フィルタを適用（比較は NFKC 正規化 + 空白除去 + 大文字化）。**一致 0 件の場合は全件にフォールバック**
4. 各コースについて:
   - コンテンツ一覧 URL = `courseUrl + '_page'` へ遷移 → ログイン解決
   - 一覧エントリ: リンクのうちパスが `/ct/page_` で始まり `_` をちょうど 1 つ含むもの。タイトルはリンクテキスト、掲載日時は最も近い祖先コンテナ（`tr, li, article, section, div`）内の `YYYY-MM-DD HH:MM[:SS]` から抽出
   - 各エントリの詳細ページへ遷移 → ログイン解決 → `{ title: 最初の非空 h1/h2/h3, bodyText, links }` を取得
   - `CourseContent` へ変換:
     - `contentId`: contentUrl パス末セグメント
     - `updatedAt`: 本文の `更新日時[：:] <日時>`、なければ本文中最初の日時
     - `openFrom`/`openUntil`: 本文の `公開期間[：:] <from> ～ <to>`（`〜`/`~` 両対応）
     - `resourceLinks`: 詳細ページのリンクから ACE 内部ナビゲーションを除外したもの（下記）
5. コース単位で try/catch し、失敗は `errors` に追記して継続
6. `updatedAt ?? listedAt` 降順（両方欠落ならタイトル `ja` 順）にソート後 `contentId` で重複除去
7. `toyonet-ace-contents.json` に `{ fetchedAt, source: 'toyonet-ace', available: errors.length===0, contents, errors }` を保存
8. 致命的例外時はスナップショット `toyonet-ace-content-error` + 診断ファイルを残し `{ available: false, contents: [], errors }` を返す

##### resourceLinks フィルタ規則

- URL が `attend.manaba.jp` / `doc.manaba.jp` → 除外
- `www.ace.toyo.ac.jp` 以外のホスト → 残す
- ACE 内でもパスが `/ct/hsearch`, `/ct/home`, `/ct/home_course`, `/ct/home_*`, `/ct/course_*`, `/ct/page_*`, `/ct/usermemo_*`, `/ct/doc_*`, `/ct/logout` → 除外（コンテンツ詳細自身を含む）
- URL パース不能 → 除外扱い
- `/link_iframe_balloon` で終わる URL は `?url=` パラメータを実 URL として展開
- URL で重複除去

### 7.4 `lib/toyo-announcements.ts` — ACE コースニュース

#### 取得対象

`home_news` ではなくリマインダ一覧 `/ct/home_library_reminder?count=50` を用いる（`home_news` は AJAX 読み込みのため取得不可という既知の制約）。

#### `collectToyoNetAceAnnouncements(courseNames)`（引数は現在未使用）

1. ACE ログイン URL → リマインダ URL の順に遷移し、各段階で `recoverToyoSessionIfNeeded`（snapshotTag はそれぞれ `toyonet-ace-announcements-login` / `-reminder`、`saveState: true`）
2. `table.stdlist tr:not(.title)` のうちテキストに `コースニュース` を含む行を抽出:
   - `detailHref`: `td:first-child a` の href
   - `courseName`: `td:nth-child(2) a` のテキスト
   - `sendTime`: `td.td-sendtime` のテキスト
3. 各行の詳細ページ（`detailHref` を reminderBaseUrl で絶対化）へ順に遷移し、`recoverToyoSessionIfNeeded({ saveState: false })` 適用後、body テキストから構造化フィールドを抽出:
   - タイトル: `/\[タイトル\]\s*[：:]\s*(.+?)(?:\s*\[|\s*-{4,}|$)/`
   - ニュース URL: `/PC\s*[：:]\s*(https:\/\/www\.ace\.toyo\.ac\.jp\/ct\/course_\S+)/`
4. `Announcement` を生成:
   - `announcementId`: `detailHref` から `home_library_reminder_detail_` 接頭辞を除去
   - `title`: 抽出タイトル。なければ `courseName`
   - `category`: `休講`→休講、`補講`→補講、`教室変更`/`教室移動`→教室変更、以外→その他（タイトルに対しこの順で判定）
   - `postedAt`: `sendTime` を JST ISO 化。受理形式は `YYYY-MM-DD` または `YYYY-MM-DD HH:MM[:SS]`（**秒省略時は `:00` を補わず `T17:17+09:00` のように分まで**）
   - `targetDate`: タイトル中の最初の `YYYY/M/D` または `YYYY-M-D` → `YYYY-MM-DD`。なければ `null`
   - `content`: タイトル抽出成功時 `[courseName] title`、失敗時空文字
   - `sourceUrl`: ニュース URL ?? 詳細ページ URL
5. 行単位の失敗は `errors` に追記して継続。`announcements.json` に `{ fetchedAt, source: 'toyonet-ace', available: true, announcements, errors }` を保存
6. 致命的例外時はスナップショット `toyonet-ace-announcements-error` を保存し、`{ available: false, announcements: [], errors: [...] }` を（書き込みも best-effort で）返す

### 7.5 `lib/toyo-academic-calendar.ts` — 祝日

`fetchAcademicCalendar(academicYear)`:

1. 内閣府祝日 CSV を `fetch` 取得。`!response.ok` はエラー
2. レスポンスを `arrayBuffer` → **Shift_JIS でデコード**（失敗時 UTF-8 にフォールバック）
3. 1 行目（ヘッダ）を除き、各行を最初の `,` で `日付,名称` に分割。`Y/M/D` 形式を `YYYY-MM-DD`（ゼロパディング）へ変換。不正行はスキップ
4. パース結果 0 件はエラーとして記録
5. `academic-calendar.json` に `{ fetchedAt, available: errors.length===0, academicYear, nationalHolidays, errors }` を常時保存

補助 API: `isNationalHoliday(holidays, dateStr)`、`readAcademicCalendar()`（不在・パース失敗時 `null`）。

### 7.6 `lib/toyo-syllabus.ts` — シラバス

#### 検索・候補抽出

1. 時間割 URL（`Usin026411`）へ遷移 → `recoverToyoSessionIfNeeded({ saveState: true, snapshotTag: 'syllabus-timetable-session-loss' })`
2. 全 `tr` を走査し `td.subject_name a` を持つ行を候補とする:
   - リンクの `onclick` 属性から `openWindow('<URL>'+displayType` または `openWindow('<URL>'` を抽出し、`window.displayType`（不在時 `'mobile'`）を連結して詳細 URL を構成
   - URL の `syllabusNo` クエリが必須（なければ候補外）。`numbering` はあればデコードして保持
   - `td.employee_name a` → 担当者、`td.schedule` → スケジュール、`td.conduction_type` → 実施形態

#### 候補スコアリング

`scoreCandidate(candidate, course)` — 合計点で降順ソートし 0 点は除外。

| 条件 | 加点 |
|---|---|
| 科目名一致（半角英数化・空白除去・大文字化） | +12 |
| ナンバリング一致（空白正規化） | +10 |
| スケジュール一致（後述の正規化同士） | +8 |
| 担当者一致（半角英数化・空白除去・大文字化） | +6 |
| 実施形態一致（空白正規化） | +4 |

スケジュール比較は「学期ラベル先頭が `春`→`春`、`秋`→`秋`、それ以外はそのまま」+ `曜日` + `時限` を連結し、NFKC 相当の半角化・空白除去・大文字化した文字列同士で行う。

#### 詳細ページ遷移（popup 連鎖）

詳細は直接 `goto` せず、UI クリックによる popup 連鎖で開く（直接遷移は `利用できません` になる既知の制約）。

1. 対象行の `td.subject_name a` を `page.evaluate` で click し `popup` イベントで中間ページ（chooser）を捕捉（10s）
2. 親 context の `page` イベント（`page`・`chooserPage` 以外の popup を predicate で指定）を待ちつつ、chooser 内の `input.button[value="日本語"]` を `force: true` で click → 詳細ページを捕捉（10s）
3. chooser は閉じ、詳細ページを `domcontentloaded` + `networkidle` 待機して返す

#### 詳細ページ解析

- `table.head-title` → 科目名
- `table.lcl-ttl2` の行を th/td セル配列として、先頭から 2 要素ずつ `(key, value)` に割り当て `metadata` を構築
- `table.sbs-show` の行をセル配列化し、単一セルで `【...】` 形式の行を見出し、直後の行を値として `sections` を構築

#### SyllabusRecord 生成

| フィールド | 出所 |
|---|---|
| `instructor` | metadata `担当者` |
| `courseCode` | metadata `授業コード` |
| `classFormat` | metadata `授業形態` |
| `conductionType` | metadata `実施形態` |
| `timetable` | metadata `時間割` を下記で整形 |
| `classroom` | metadata `教室` |
| `learningGoals` | section `学修到達目標` |
| `lectureSchedule` | section `講義スケジュール` |
| `instructionMethod` | section `指導方法` |
| `preAndPostStudy` | section `事前・事後学修`、なければ `事前・事後学習` |
| `grading` | section `成績評価の方法・基準` |
| `textbook` | section `テキスト` |

`時間割` 整形: `^(.)(.)(\d+|集中|未定|なし)$` にマッチした場合、季節（`春`→`春学期`、`秋`→`秋学期`、`通`→`通年`、`１〜４`→`1Q〜4Q`）、曜日（`月`→`月曜日` 等、`集`→`集中`、`未`→`未定`、`な`→`なし`）、時限（数字なら `N限`）を `, ` 連結した文字列に変換。非マッチ時は正規化済みの生文字列。

#### `fetchSyllabus(course)`

1. 候補抽出 → スコアリング → 上位 8 件まで詳細を順に開き、`courseCode` が `course.courseCode` と一致した時点でその `SyllabusRecord` を返す
2. 候補 0 件・マッチ 0 件・詳細読み取り失敗はそれぞれ明示的メッセージで例外

#### シラバスのキャッシュ（`lib/syllabus-cache.ts`）

`output/toyo/syllabus/<syllabusFileStem(授業コード)>.json` を読む純粋なモジュール（playwright に依存しない）。`readSyllabusCache()` が全件を `授業コード → SyllabusRecord` のマップで返し、`findSyllabus(map, 授業コード, academicYear)` が引く（`academicYear` が違うキャッシュは無いものとして扱う）。取得（`fetchSyllabus`）とは分離しており、キャッシュが無いときに取りに行く処理（旧 `fetchSyllabusWithCache`）は無い。補完は daily が index の欠け（`has.syllabus === false`）を見て、pool（`toyo:syllabus:seed`）→ 時間割検索（`toyo:syllabus`）の順に行う。

### 7.7 `build/summary.ts` — 集約サマリー（組み立て層）

`output/toyo/summary.json` の中身を作る純粋関数 `buildSummary(inputs, index, now)`。Playwright も fetch も import せず、取得層の出力ファイルの中身（`registration` / `assignments` / `contents` / `announcements` / `coursework` / `academicCalendar` / `syllabi` / `academicSchedule`）を引数で受け取る。欠けている入力は `null` で渡し、取りに行かず `sourceStatus` と `errors` で表す。読み込みと書き出しは `scripts/toyo-build.ts`。すべての日時処理は **JST（UTC+9）を UTC フィールド読み取りでエミュレート**する（`Date + 9h` → `getUTC*`）。

#### 時限テーブル（固定）

| 時限 | 開始 | 終了 |
|---|---|---|
| 1 | 09:00 | 10:30 |
| 2 | 10:40 | 12:10 |
| 3 | 13:00 | 14:30 |
| 4 | 14:45 | 16:15 |
| 5 | 16:30 | 18:00 |
| 6 | 18:15 | 19:45 |
| 7 | 19:55 | 21:25 |

#### 授業発生時刻の計算

- `nextOccurrence(course, now)`: `course.day`（曜日ラベル）と `periodTimes` から次回開始を算出。同日なら開始時刻を過ぎていれば +7 日。`startsAt`/`endsAt` は `YYYY-MM-DDTHH:MM:00+09:00` と epoch ms を併記
- `occurrenceOnOffsetDay(course, now, dayOffset)`: `now + dayOffset` 日（JST）の曜日が `course.day` と一致すれば同形式で返す。`dayOffset=0` が今日、`1` が明日

#### 関連付け規則（course-index 経由）

名前の `===` 比較や部分一致はしない（旧実装は全角半角の違いで取りこぼしていた）。ACE の課題・お知らせ・コンテンツは `build/course-lookup.ts` の resolver で授業コードに引く:

1. ACE courseId（課題の `assignmentId`、コンテンツ・お知らせの URL に含まれる `course_<数字>`）が index の `aceCourseId` と一致すればそれ
2. 科目名（課題・コンテンツの `courseName`、お知らせの `courseNameHint`）の `courseKey` が index の `names.key` / `names.ace` のキー、または coursework の ACE 名（見出し名・一覧名）のキーと一致すればそれ
3. `courseNameHint` が無いお知らせだけ、タイトルに index の科目名のキーが丸ごと（3 文字以上）含まれるものを、最長一致で引く（先頭 4 文字などの部分一致はしない）

同名の科目が複数あるときは今学期のものを優先する。引けなかったものは落とさず、全体の一覧（`upcomingAssignments` / `courseContents` / `announcements`）に `courseCode: null`（科目不明）で残す。引けたものには授業コードを `courseCode` として付ける。授業ごとの `coursework` は index の `aceCourseId`（無ければ授業コード一致）で引く。

#### ソート規則

- 課題: `dueAt` 昇順、`null` は末尾、両方 `null` ならタイトル `ja` 順
- コンテンツ: `updatedAt ?? listedAt` 降順、両方欠落ならタイトル `ja` 順

#### `buildSummary(inputs, index, now)`

1. 履修各科目の `nextOccurrence` を計算し最早のものを `nextClass` とする
2. `nextClassNotes`: `nextClass` の科目のシラバス（`syllabi` から `findSyllabus`）で `{ checkedAt: <JST日付>, firstTopic, syllabusPoints }` を構成
   - `firstTopic`: 講義スケジュールから `第N項/第N回` パターンの最初のトピックを正規表現で抽出
   - `syllabusPoints`: `評価: <grading>` / `予習復習: <preAndPostStudy>` / `教科書: <textbook>` のうち非空のもの
   - シラバスが無ければ `null`
3. 今日・明日それぞれについて、該当科目へ `DetailedClassSummary` を構築:
   - `classInfo`（上記発生時刻）、`syllabus`（`DetailedClassNotes`）、関連課題・コンテンツ・お知らせ（上の関連付け規則）、`errors`
   - シラバスのキャッシュが無い科目は当該科目の `errors` に記録し `syllabus: null`（取得はしない。補完は daily）
4. 入力が `null` のソース（`registration-data.json` など）は `errors` に「<ファイル> がありません」を積み、`sourceStatus` の `available` を false にする
5. 結果は `scripts/toyo-build.ts` が `output/toyo/summary.json` に書く（スキーマは §9）

`build/` 配下（`course-index.ts` / `course-lookup.ts` / `summary.ts` / `context.ts` / `context-markdown.ts`）が Playwright・`lib/toyo.ts`・`lib/toyo-enrollment.ts`・`fetch(` を使っていないことは `scripts/dev/course-index.test.ts` が検査する。

### 7.8 `toyo-build-timetable.py` — 時間割 xlsx 生成

`Usage: toyo-build-timetable.py <input-json> <output-xlsx>`（引数過不足は終了コード 1）。

`registration-data.json` を読み、openpyxl で以下の構成のワークブックを生成する。

- シート名 `時間割`、`freeze_panes = "B4"`、グリッド線非表示
- `A1:G1` 結合: `<開講年度>年度 履修時間割`（太字・白・16pt・背景 `4C6EF5`・中央揃え、行高 28）
- `A2:G2` 結合: `<氏名> (<学籍番号>)  /  小学校の時間割ふう`（太字・`1F2937`・11pt・背景 `EEF2FF`、行高 22）
- 3 行目: `A3=時限`（背景 `F1F3F5`）、`B3:G3` に曜日 `月,火,水,木,金,土`（曜日色: 月 `FFF3BF`、火 `D3F9D8`、水 `D0EBFF`、木 `FFE8CC`、金 `E5DBFF`、土 `FFCCD5`）
- 列幅: `A=9`、`B〜G=24`。全セルに細罫線（`8A8F98`）
- 4〜10 行目: `A` 列に `N限`（1〜7、背景 `FFF0F6`、行高 68）。各曜日セルは中央揃え・折り返し
- 科目配置: `day`/`period`（全角数字は半角化）が表内に収まるもののみ。セル内容は 5 行テキスト:
  1. 科目名
  2. `<numbering> / <courseCode>`
  3. 担当者（空なら `担当者未設定`）
  4. `<room>・<campus>`（room 空なら `教室未設定`）
  5. `<実施形態> / <単位>単位`（実施形態空なら `未設定`）
  - セル背景: 実施形態による（`対面`=FFF9DB、`非オ`=E3FAFC、`非同`=E7F5FF、その他=FFFFFF）
  - フォント: Meiryo 10pt 太字
- 12 行目: `A:G` 結合で `履修サマリー`（背景 `F1F3F5`、行高 22）
- 13〜16 行目: 各 `A:G` 結合で `登録科目数: N件`、`登録単位数: N単位`、`実施形態: <形態> N件 / ...`（形態名ソート）、`注: 学務ポータルの「履修登録確認表照会」をもとに作成`
- 出力パスの親ディレクトリを作成して保存し、出力パスを標準出力に表示

## 8. エントリポイント仕様

全スクリプト共通: `main()` を export し、`require.main === module` ガード下で実行。catch でスタックまたはメッセージを stderr に出力し `process.exit(1)`。

### 8.1 `toyo-login.ts`（`toyo:login` / `toyo:refresh-session`）

- headless 既定は **false**（headed）。headed かつ `DISPLAY`/`WAYLAND_DISPLAY` 未設定なら即例外
- `launchPersistentBrowser` で専用プロファイル起動 → `gotoPortal`
- `isLoginUrl` なら `autoFillLogin` を試行（成否でログメッセージを分岐）。非ログイン URL なら「既存セッション有効」とみなす
- `waitForSession(page, 5分)` → `saveSessionState` → スナップショット `portal-after-login` → 保存先パスを表示

### 8.2 `toyo-check.ts`（`toyo:check`）

- `launchStateContext`（headless 既定 true）→ セッションメタデータを表示 → `gotoPortal`
- `isLoginUrl` なら未認証メッセージを表示し **終了コード 2**
- 認証中なら現在 URL とタイトルを表示

### 8.3 `toyo-run.ts`（`toyo:run`）

- `launchStateContext` → `gotoPortal` → `isLoginUrl` なら例外（再ログインを案内）
- スナップショット `portal-run` → `saveSessionState` で鮮度更新 → パス表示

### 8.4 `toyo-export-enrollment.ts`（`toyo:export-enrollment`）

出力ディレクトリ確保 → `scrapeEnrollmentData` → `writeEnrollmentArtifacts` → `runPythonWorkbookBuilder` → 3 つの出力パスを表示。

### 8.5 `toyo-sync.ts`（`toyo:sync`）

1. `scrapeEnrollmentData` → `writeEnrollmentArtifacts`
2. ACE 課題・コンテンツ・お知らせ・祝日を直列に取得（Playwright セッションは同時に 1 つ）。ACE の各取得が不調でも警告を出して続行し（結果は `summary.json` の `sourceStatus` / `errors` と agent-context の Warnings に出る）、カレンダー失敗も非致命。失敗とみなすのは履修登録確認表の取得が落ちたときだけ
3. `toyo:build`（index → summary → context）を実行。`--no-build` で省略（daily は最後にまとめて実行するため付ける）
4. シラバスは取得しない（daily の「index の欠けの補完」か `toyo:syllabus` / `toyo:syllabus:seed`）
5. `fetchStatus === 'error'` は警告表示。最後に 1 行サマリを表示

### 8.6 `toyo-fetch-calendar.ts`（`toyo:calendar`）

- `registration-data.json` の `academicYear` を読む（不在時は現在年）
- `fetchAcademicCalendar` 実行 → エラー・取得件数・出力パスを表示
- `available === false` なら終了コード 1

### 8.7 `toyo-fetch-announcements.ts`（`toyo:announcements`）

- `registration-data.json` から科目名一覧を読み `collectToyoNetAceAnnouncements` に渡す
- エラー・件数・各 `[category] title (targetDate)`・出力パスを表示
- `available === false` なら終了コード 1

### 8.8 `toyo-fetch-syllabus.ts`（`toyo:syllabus`）

CLI:

```
--help / -h            使用方法を表示して終了 0
--list                 registration-data.json の科目一覧をタブ区切りで表示
--course-code <code>   授業コード完全一致で指定
--course-name <name>   科目名部分一致で指定
<positional>           英数字のみ → 授業コード、それ以外 → 科目名（空白連結）
```

振る舞い:

- `--list` 時は `courseCode 科目名 曜日時限 担当者`（非空フィールドのタブ連結）を表示して終了
- `registration-data.json` の `pageTitle` が `システムエラー` を含む場合は取得せず例外（再ログイン + 再エクスポートを案内）
- 科目解決: 0 件一致 → エラー（`--list` を案内）。複数一致 → 候補一覧付きエラー
- `fetchSyllabus({...course, academicYear})` を実行し `output/toyo/syllabus/<stem>.json` / `.md` に保存
  - `stem`: `courseCode || courseName` を `[\\/:*?"<>|]+`→`-`、空白→`-`、前後 `-` 除去、80 文字で切詰
  - JSON: `{ fetchedAt, inputCourse, syllabus }`
  - Markdown: 科目名見出し + メタ情報箇条書き（取得日時/授業コード/担当者/時間割/教室/授業形態/実施形態/参照元）+ 固定セクション `学修到達目標` `講義スケジュール` `指導方法` `事前・事後学修` `成績評価` `テキスト`（空は `(空)`）

### 8.9 `toyo-context.ts`（`toyo:context`）と `toyo-build.ts`（`toyo:build`）

`toyo:build` は index → summary → context を順に作る（各段 1 行サマリ）。取得はしない。`toyo:context` は最後の段だけを単独で実行する薄い CLI で、ファイルを読んで `build/context.ts`（文脈データの組み立て、純粋）と `build/context-markdown.ts`（Markdown 整形、純粋）に渡し、書き出すだけ。

CLI（`toyo:context`）:

```
--max-age-minutes <n>   summary.json が n 分より古ければ stale と警告する（既定 30）
--horizon-days <n>      課題の締切ホライズン日数（既定 7）
--print                 全文を標準出力に出す（既定は 1 行サマリ `[context] <JST> today=n tomorrow=m warnings=k` のみ）
--format markdown|json  --print のときの標準出力形式（既定 markdown。ファイルは常時両方書き出し）
--no-sync               互換のため受け付けるが無視する（`--sync` は廃止でエラー）
```

処理（`buildContext(inputs, options, now)`）:

1. `summary.json` を読む。不在なら例外（`npm run toyo:build` を案内）。`generatedAt` からの経過が `maxAgeMinutes` 超過なら `freshness.stale`。**古くても取得（`toyo:sync`）は走らせない**。古さは freshness と warnings で表すだけ
2. `registration-data.json`・`academic-calendar.json`・`data/academic-schedule.json`・`data/grading-rules.json`・`course-index.json`・`health.json` を読み（無ければ `null`）、コンテキストを構築:
   - `today`/`tomorrow`: 日付は `summary.generatedAt` 基準の JST（フォールバックは現在時刻）、祝日名を `nationalHolidays` から引く
   - `classes`: `summary.todayClasses`/`tomorrowClasses` を圧縮形式へ変換（§9 `AgentClass`）
   - `assignments`: `dueAt` が `[now-1h, now+horizonDays]` 内のもの（最大 20 件）と `dueAt === null`（最大 12 件）に分割
   - `announcements`: カテゴリ `休講`/`補講`/`教室変更`（最大 12 件）とその他（最大 6 件）に分割
   - `warnings`: stale・portal `fetchStatus` が `error`/`empty`・ACE 各ソース不可・summary 内 errors・registration 不在・fetchStatus 不一致・カレンダー不在/エラー、定期ジョブの失敗・停止（`output/toyo/health.json`、詳細は runbook「失敗の検知と通知」）、index の欠け（今学期の科目のシラバス・ACE 反映・評価ルール）の各条件でメッセージを積む
   - `agentNotes`: 利用上の注意（固定文。鮮度・エラー時の扱い・`dueAt=null` の扱い・`basic-info.md` 参照等）
   - `sourceFiles`: 参照ファイルの絶対パス一覧
3. `agent-context.json`（2 スペース整形）と `agent-context.md`（§9 の形式）を書き出し、`--print` のときだけ `--format` に応じてどちらかを標準出力

## 9. データスキーマ

### 9.1 `registration-data.json`（EnrollmentData）

```jsonc
{
  "fetchStatus": "success | error | empty",
  "fetchedAt": "<ISO8601>",
  "sourceUrl": "<最終URL>",
  "pageTitle": "<ページタイトル>",
  "studentNumber": "string",
  "studentNameKana": "string",
  "studentName": "string",
  "academicYear": "string(4桁)",
  "courses": [{
    "semesterLabel": "string",   // 例: "春学期"
    "day": "月|火|水|木|金|土|日",
    "period": "string",          // 半角化済み
    "term": "string",
    "courseCode": "string",
    "numbering": "string",
    "courseName": "string",
    "deliveryMode": "string",    // 例: "対面", "非オ", "非同"
    "instructor": "string",
    "room": "string",
    "campus": "string",
    "credits": "number | null"
  }]
}
```

### 9.2 `toyonet-ace-assignments.json`

```jsonc
{
  "fetchedAt": "<ISO8601>",
  "source": "toyonet-ace",
  "available": "boolean",
  "assignments": [{
    "assignmentId": "string",
    "courseName": "string",
    "title": "string",
    "dueAt": "<YYYY-MM-DDTHH:MM:SS+09:00> | null",
    "status": "pending | submitted | unknown",
    "sourceUrl": "string | null",
    "notes": ["string"]
  }],
  "errors": ["string"]
}
```

### 9.3 `toyonet-ace-contents.json`

```jsonc
{
  "fetchedAt": "<ISO8601>",
  "source": "toyonet-ace",
  "available": "boolean",   // errors が空なら true
  "contents": [{
    "contentId": "string",
    "courseName": "string",
    "courseUrl": "string",
    "contentListUrl": "string",
    "title": "string",
    "contentUrl": "string",
    "listedAt": "<JST ISO> | null",
    "updatedAt": "<JST ISO> | null",
    "openFrom": "<JST ISO> | null",
    "openUntil": "<JST ISO> | null",
    "resourceLinks": [{ "text": "string", "url": "string" }]
  }],
  "errors": ["string"]
}
```

### 9.4 `announcements.json`

```jsonc
{
  "fetchedAt": "<ISO8601>",
  "source": "toyonet-ace",
  "available": "boolean",
  "announcements": [{
    "announcementId": "string",
    "category": "休講 | 補講 | 教室変更 | その他",
    "courseNameHint": "string | null",
    "title": "string",
    "postedAt": "<JST ISO> | null",   // 分までの場合あり
    "targetDate": "<YYYY-MM-DD> | null",
    "content": "string",
    "sourceUrl": "string"
  }],
  "errors": ["string"]
}
```

### 9.5 `academic-calendar.json`

```jsonc
{
  "fetchedAt": "<ISO8601>",
  "available": "boolean",
  "academicYear": "string",
  "nationalHolidays": [{ "date": "YYYY-MM-DD", "name": "string" }],
  "errors": ["string"]
}
```

### 9.6 `output/toyo/summary.json`（Summary）

```jsonc
{
  "generatedAt": "<ISO8601>",
  "timezone": "Asia/Tokyo",
  "nextClass": "CourseSummary | null",
  "nextClassNotes": {
    "checkedAt": "YYYY-MM-DD",
    "firstTopic": "string | null",
    "syllabusPoints": ["string"]
  } | null,
  "todayClasses": ["DetailedClassSummary"],
  "tomorrowClasses": ["DetailedClassSummary"],
  "upcomingAssignments": ["Assignment + courseCode(string|null) + coursework"],   // ソート済み全件。courseCode は index で引いた授業コード（null = 科目不明）
  "courseContents": ["CourseContent + courseCode"],     // ソート済み全件
  "announcements": ["Announcement + courseCode"],
  "sourceStatus": {
    "portal": { "available": "boolean", "fetchStatus": "string", "fetchedAt": "<ISO|null>", "path": "string" },
    "toyonetAce": {
      "available": "boolean", "fetchedAt": "<ISO>",
      "contentsAvailable": "boolean", "contentsFetchedAt": "<ISO>",
      "announcementsAvailable": "boolean", "announcementsFetchedAt": "<ISO>"
    }
  },
  "errors": ["string"]
}
```

`CourseSummary`:

```jsonc
{
  "courseName": "string", "courseCode": "string", "instructor": "string",
  "room": "string", "campus": "string", "day": "string", "period": "string",
  "deliveryMode": "string",
  "startsAt": "<JST ISO>", "endsAt": "<JST ISO>",
  "startsAtEpochMs": "number", "endsAtEpochMs": "number"
}
```

`DetailedClassSummary`: `{ classInfo: CourseSummary, syllabus: DetailedClassNotes | null, relatedAssignments: Assignment[], relatedContents: CourseContent[], relatedAnnouncements: Announcement[], errors: string[] }`。`DetailedClassNotes` は `SyllabusRecord` の主要フィールド + `firstTopic`。

### 9.7 `syllabus/<stem>.json`

```jsonc
{
  "fetchedAt": "<ISO8601>",
  "inputCourse": { /* Course 全体 */ },
  "syllabus": {
    "fetchedAt": "<ISO8601>", "academicYear": "string", "sourceUrl": "string",
    "courseName": "string", "instructor": "string", "courseCode": "string",
    "classFormat": "string", "conductionType": "string", "timetable": "string",
    "classroom": "string", "learningGoals": "string", "lectureSchedule": "string",
    "instructionMethod": "string", "preAndPostStudy": "string",
    "grading": "string", "textbook": "string"
  }
}
```

### 9.8 `agent-context.json`（AgentContext）

```jsonc
{
  "builtAt": "<ISO8601>",
  "timezone": "Asia/Tokyo",
  "freshness": { "summaryGeneratedAt": "<ISO|null>", "ageMinutes": "number|null", "maxAgeMinutes": "number", "stale": "boolean" },
  "today":    { "date": "YYYY-MM-DD", "nationalHoliday": "string|null", "classes": ["AgentClass"] },
  "tomorrow": { "date": "YYYY-MM-DD", "nationalHoliday": "string|null", "classes": ["AgentClass"] },
  "nextClass": "CourseSummary | null",
  "nextClassNotes": "NextClassNotes | null",
  "assignments": {
    "horizonDays": "number",
    "dueWithinHorizon": ["AgentAssignment"],   // ≤20
    "deadlineUnknown": ["AgentAssignment"]     // ≤12
  },
  "announcements": {
    "important": ["AgentAnnouncement"],        // ≤12、休講/補講/教室変更
    "recentOther": ["AgentAnnouncement"]       // ≤6
  },
  "sourceStatus": "Summary.sourceStatus",
  "warnings": ["string"],
  "sourceFiles": { "summary": "path", "enrollment": "path", "academicCalendar": "path", "basicInfo": "path", "contextJson": "path", "contextMarkdown": "path" },
  "agentNotes": ["string"]
}
```

圧縮ルール（`AgentClass`・`AgentAssignment`・`AgentContent`・`AgentAnnouncement`）:

- `title`・`notes` は 160 文字、`grading`/`preAndPostStudy`/`contentPreview` は 240 文字、`firstTopic`/`textbook` は 180 文字で空白正規化のうえ省略記号 `…` 付き切詰
- `relatedContents`・`relatedAnnouncements` は各最大 8 件
- `AgentClass.syllabus` は `sourceUrl`/`classFormat`/`grading`/`firstTopic`/`preAndPostStudy`/`textbook` のみ残し、空は `null`

### 9.9 `agent-context.md` 構成

固定セクション順: `# Toyo Agent Context` → メタ箇条書き（builtAt/timezone/sync/鮮度）→ `## Status`（各ソースの available/fetchedAt）→ `## Warnings` → `## Today (<date>)` + `Today Classes` → `## Tomorrow` 同様 → `## Next Class` → `## Assignments Due Within N Days` → `## Deadline Unknown Assignments` → `## Important Announcements` → `## Recent Other Announcements` → `## Agent Notes` → `## Source Files`。空集合は `- なし`。授業行は `- <period>限 HH:MM-HH:MM <科目名> (<code>)` + サブ箇条書き（教室/形態/担当・評価・先頭トピック・関連課題・関連コンテンツ・関連お知らせ・取得エラー）。

### 9.10 セッションメタデータ `toyo-session.json`

```jsonc
{ "savedAt": "<ISO8601>", "title": "<保存時ページタイトル>", "url": "<保存時URL>" }
```

## 10. エラーハンドリングと終了コード

| 状況 | 挙動 |
|---|---|
| ストレージ状態不在で `launchStateContext` | 例外（`toyo:login` 実行を案内）・終了コード 1 |
| `toyo:check` で未認証 | メッセージ表示・終了コード 2 |
| `toyo:calendar` / `toyo:announcements` で `available: false` | 終了コード 1 |
| ACE 課題・コンテンツ・お知らせの致命的失敗 | throw せず `available: false` + `errors` を返し出力ファイルも書く |
| セッション喪失検知 | `recoverToyoSessionIfNeeded` が自動回復を試行。回復不能なら例外（手動 `toyo:login` を案内） |
| 個別リソース（ACE コンテンツの 1 コース、お知らせの 1 行、シラバス 1 科目）の失敗 | `errors` に追記して処理継続 |
| 例外発生時 | `artifacts/toyo/` にスナップショット PNG/JSON（可能な場合）+ ACE は診断 JSON を残す |

## 11. 非機能要件・設計上の注意

- **文字コード**: 祝日 CSV は Shift_JIS。ページ内テキストは全角数字を半角化してから比較・数値化する箇所が複数ある
- **日時**: 内部の日時計算はすべて JST 固定（UTC+9 のオフセット演算）。出力は `+09:00` 付き ISO
- **並列性**: `toyo:sync` 内で ACE 課題/コンテンツ/お知らせは `Promise.all` 並行だが、各コレクタはそれぞれ独立ブラウザを起動する
- **冪等性**: 出力 JSON は全件上書き。シラバスのみ年度一致を条件とするファイルキャッシュを持つ
- **セレクタ依存**: 学務ポータル（univision）・manaba ベースの ACE の DOM 構造（`table.stdlist`、`td.subject_name` 等）に強く依存する。仕様変更時はセレクタ層を局所化して修正できる構造を保つこと
- **セキュリティ**: 資格情報は env ファイル経由のみ。ログに `TOYO_PASSWORD` を出力しない。`output/`・`playwright/.auth/`・`artifacts/` は gitignore 対象

## 12. 既知の制約

- ACE お知らせはリマインダ一覧由来のため、掲示板経由のみで通知する教員のお知らせは捕捉できない
- シラバス詳細は直接 URL 遷移不可（popup 連鎖が必須）
- `timetable` の `時間割` 整形は先頭 1 文字ずつのパターンにのみ対応（複数コマ等は非対応）
- `filterCourseLinks` は履修科目名との一致 0 件時に全コースへフォールバックする（誤爆防止ではなく取りこぼし防止）
- `registration-data.json` の氏名・カナは行位置依存の簡易パースであり、ポータルのレイアウト変更に弱い

## 13. 受け入れ基準

1. `npm run typecheck` がエラーなく通る
2. `npm run toyo:login`（GUI 環境）で `toyo-state.json`・`toyo-session.json` が生成される
3. `npm run toyo:check` が認証中に終了コード 0、未認証で 2 を返す
4. `npm run toyo:export-enrollment` で `registration-data.json`・`registration-summary.md`・`toyo-timetable.xlsx` が生成される
5. `npm run toyo:sync` で §9 の全出力が生成され、`summary.json` が `sourceStatus` を含む
6. `npm run toyo:syllabus -- --list` が科目一覧を表示し、`--course-code` で `syllabus/<code>.json`・`.md` が生成される
7. `npm run toyo:build` で `course-index.json`・`summary.json`・`agent-context.json`・`.md` が生成される（取得はせず、古さは freshness と warnings に出る）
8. セッション喪失時に各収集処理が `recoverToyoSessionIfNeeded` 経由で自動回復を試み、失敗時は例外・スナップショット・`available: false` のいずれかの形で検知可能に残る
