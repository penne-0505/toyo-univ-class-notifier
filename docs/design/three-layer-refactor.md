# 3 層化リファクタ（取得・組み立て・配信）設計メモ

2026-10-08 起草。合意後に実装する。

## なぜやるか

- 2026-10-07 の障害（毎時の取得が 7 回連続で落ちた）は、組み立て処理（summary の生成）の途中でブラウザを開いてシラバスを取りに行っていたことが根本原因だった。応急処置で既定を cache-only にしたが、`buildDiscordSummary` は引数なしで呼ばれると今も ACE を 3 種類取得する。組み立てと取得が同じ関数に混ざっている限り、同種の事故は再発しうる。
- 科目の突き合わせ（授業コード / ACE の courseId / 登録画面の scheduleCd / 全角半角が揺れる科目名）が summary・coursework・grading-rules・Worker でばらばらに実装されている。新しく登録した科目の「シラバスが無い」「ACE にまだ無い」を誰も検出できなかった。
- Discord bot の廃止で `output/bot/summary.json` と `buildDiscordSummary` の名前が実態と合わなくなった。

## 層の境界

| 層 | 役割 | 入力 | 出力 | ネットワーク |
| --- | --- | --- | --- | --- |
| 取得（fetch） | 1 ソースを取りに行って JSON に落とす | ポータル / ACE / 内閣府 CSV | `output/toyo/<source>.json` | 使う |
| 組み立て（build） | ファイルだけを読んで派生物を作る純粋処理 | 取得層の出力と `data/` | `course-index.json`、`summary.json`、`agent-context.*` | **使わない** |
| 配信（publish） | 差分を toyo-data と Worker に送る | `output/toyo/`、`data/` | git commit、KV | 使う |

規則は 1 つだけ。**組み立て層は Playwright も fetch も import しない。** 欠けている入力は `null` と警告で表し、取りに行かない。これを型と import で担保する（`scripts/build/` から `playwright` と `lib/toyo.ts` のブラウザ系を import したら typecheck 用の lint で落とす）。

### 取得層の出力（ソースファイル）

ファイル名は今のまま（Worker・toyo-data・クラウドのエージェントが参照しているため）。すべて共通の外枠を持つ: `{ fetchedAt, available, errors, ... }`。

| ソース | ファイル | 取得コマンド |
| --- | --- | --- |
| 履修登録確認表 | `registration-data.json` | `toyo:export-enrollment` |
| ACE 未提出課題 | `toyonet-ace-assignments.json` | watch / daily |
| ACE お知らせ | `announcements.json` | watch / daily |
| ACE 教材 | `toyonet-ace-contents.json` | daily |
| ACE 提出状況 | `toyonet-ace-coursework.json` | coursework / daily |
| 祝日 | `academic-calendar.json` | daily |
| 単位数集計 | `credit-summary.json` | daily |
| 抽選 | `lottery-results.json` | daily |
| シラバス | `syllabus/<授業コード>.json` | daily（index の欠けだけ）/ `toyo:syllabus` |
| 登録可能科目 | `registration-candidates.json` | 登録期間中の daily / `toyo:candidates` |
| ジョブの健全性 | `health.json` | systemd の ExecStopPost |

### 組み立て層の出力

1. **`course-index.json`（新規）**: 科目の対応表。科目を参照するものは全部これを引く。
   ```json
   {
     "builtAt": "...",
     "courses": [{
       "courseCode": "2310126001",
       "semester": "秋学期",
       "names": { "portal": "組織行動論", "ace": "組織行動論", "key": "組織行動論" },
       "aceCourseId": "10931xxx",
       "scheduleCd": "3423101260-001",
       "slots": [{ "day": "木", "period": "6" }],
       "has": { "syllabus": true, "gradingRules": true, "aceCourse": false },
       "warnings": ["ACE のコース一覧にまだ無い（登録の反映待ちの可能性）"]
     }],
     "aceOnly": [{ "aceCourseId": "...", "name": "生命と倫理/生命倫理 1" }]
   }
   ```
   `names.key` は共通の正規化（NFKC・空白除去・大文字化）。正規化関数は `scripts/lib/course-key.ts` に 1 つだけ置き、Worker は同じ実装をコピーしてテストで一致を保証する。
2. **`summary.json`**: 置き場所を `output/bot/summary.json` から `output/toyo/summary.json` へ移す。`buildSummary(sources, index, now)` はファイルの中身を引数で受け取る純粋関数にする。
3. **`agent-context.{json,md}`**: `toyo-context.ts`（1,000 行）を「文脈データの組み立て（純粋）」と「Markdown への整形」に分ける。今の「summary が古ければ sync を走らせる」挙動は削除し、古さは警告として出すだけにする。取得は各ジョブの責任。

`toyo:build` 1 本で index → summary → context を順に作る。どのジョブも最後に `toyo:build` → `toyo:publish` を呼ぶ。

### ジョブ（取得 → 組み立て → 配信をつなぐだけ）

| ジョブ | 取得 | 組み立て | 配信 |
| --- | --- | --- | --- |
| watch（5 分） | 課題・お知らせ | 差分があれば `toyo:build` | 差分があれば publish |
| coursework（毎時） | 提出状況 | `toyo:build` | publish |
| daily（04:30） | 全ソース ＋ index で欠けているシラバス ＋ 登録期間中は候補 | `toyo:build` | publish（force） |

daily のシラバス補完は index の `has.syllabus === false` を見て行う。登録科目を追加した翌朝に自動で埋まる（昨日の手作業が不要になる）。

## 候補データの上書き対策

登録可能科目は、期間ごとに取得結果を分ける: `registration-candidates.json`（最新）に加えて、`registration-candidates.regular.json` / `registration-candidates.add.json`。シラバス本文は取得のたびに `output/toyo/syllabus-pool/<授業コード>.json` に貯め、上書きされない。シラバス補完は「プール → 時間割検索」の順で探す。プールは配信の対象外（約 140 科目分あり、要らないため）。

## 改名

| 旧 | 新 |
| --- | --- |
| `output/bot/summary.json` | `output/toyo/summary.json` |
| `buildDiscordSummary` / `DiscordSummary` / `discordSummaryOutputPath` | `buildSummary` / `Summary` / `summaryOutputPath` |

Worker は 1 リリースだけ旧パスへのフォールバックを持つ。`/v1/summary` のエンドポイントは変わらないので、REST で読むエージェントには影響がない。`/v1/files/output/bot/summary.json` を直接読んでいる場合だけ影響する（toyo-data の README で告知する）。toyo-data 側の旧ファイルは publish の削除反映で消える。

## ディレクトリ構成

```
scripts/
  fetch/      取得層（ブラウザ・HTTP）。今の lib/toyonet-ace*.ts、lib/toyo-enrollment.ts の取得部分など
  build/      組み立て層（純粋）。course-index、summary、context
  publish/    配信層。publish、Worker への送信
  jobs/       watch、coursework、daily
  lib/        共通（セッション、env、course-key、health、notify、正規化）
  toyo-*.ts   npm scripts の入口（薄いラッパー。名前は変えない）
```

npm scripts と systemd ユニットの名前は変えない。

## 安全網: 置き換え前後の突き合わせ

実装の各段階で、旧実装と新実装に同じ入力を与え、`summary.json` と `agent-context.json` が時刻とパス以外一致することを確認する。
- 入力は今の `output/toyo/` 一式をスナップショットとして保存したもの（`tmp/golden/`、git 管理外）。
- 比較スクリプトは時刻キーを除外する（`scripts/lib/toyo-normalize.ts` を流用）。
- 差分があれば、意図した変更（例: index 由来の警告が増えた）か不具合かを判断して記録する。

## 進め方（3 コミット）

1. **index と正規化の導入（追加のみ、既存の挙動は不変）**: `lib/course-key.ts`、`build/course-index.ts`、`syllabus-pool`、候補ファイルの期間別保存。daily に「index の欠けたシラバスを補完」を追加。
   - **完了（ae71d2b、2026-10-08）**。`courseKey` に置き換えたのは `lib/toyonet-ace.ts` の `normalizeCourseKey`（削除）と `worker/src/courses.ts` の `normalizeKey`（削除）の 2 つ。どちらも「空白を畳む → NFKC → 空白除去 → 大文字化」と「NFKC → 空白除去 → 大文字化」で出力が同じ。
   - **置き換えなかった正規化・突き合わせ（ステップ 2 で判断）**:
     - `lib/toyo-syllabus.ts` の `normalizeCourseName`（シラバス検索で候補と登録科目の照合に使う）: NFKC ではなく全角の数字と英大文字だけを半角にする。全角英小文字・半角カナ・全角記号（（）、～ など）は変換されないので `courseKey` と結果が異なりうる。同ファイルの `normalizeInstructor`（教員名）と `normalizeSchedule`（時間割文字列）も同じ関数で、科目名のキーではない。
     - `lib/toyo-grading-rules.ts` の `normalize`: 成績評価の本文を正規表現で読むための正規化（①〜⑳ を退避してから NFKC、空白は 1 個に畳むだけで除去しない、大文字化しない）。キーではない。
     - `toyo-fetch-registration-candidates.ts` の `normalize`、`lib/toyonet-ace.ts` / `lib/toyo-syllabus.ts` の `normalizeText`: 空白を畳むだけの表示用整形。キーではない。
     - `lib/toyo-summary.ts`（337・354 行付近）: 科目名を `===`、課題タイトルを `includes(courseName)` と先頭 4 文字で突き合わせており、正規化していない。summary を純粋化するとき index の `aceCourseId` / `names.key` で引き直す候補。
     - `lib/toyonet-ace-coursework.ts:291` と Worker の `findCourseworkForCode`: 授業コードの大文字化比較。名前ではなくコードの照合なので変更なし（index も同じ比較）。
     - `scheduleCd` の推定式（`'34' + 先頭 7 桁 + '0-' + 末尾 3 桁`）は `scripts/toyo-grading-rules.ts` の `scheduleCdFromCourseCode` と `build/course-index.ts` の `inferScheduleCd` に重複している。AI基礎（XJ13900003 → 実際は 34XJ128700-002）のように式が合わない例があるため、index は「候補ファイル → grading-rules → 推定（`scheduleCdInferred: true`）」の順で引く。
     - シラバスのファイル名の整形（`safeStem` / `safeFileStem` / `syllabusFileStem` / `poolFileName`）が 4 か所に複製されている。授業コードが英数字だけなら結果は同じ。
   - 実装中に決めたこと: `course-index.json` に `intensive`（集中講義は `slots` が空）、`currentSemester`、`academicYear` を足した。`scripts/lib/toyo-paths.ts`（repoRoot / outputDir / dataDir）を切り出した（`toyo-academic-schedule.ts` が `toyo-enrollment.ts` 経由で playwright を読み込んでいたため）。`scripts/dev/course-index.test.ts` が、`scripts/build/` に playwright / `lib/toyo` / `toyo-enrollment` の import が無いことと、`course-index` を読み込んでも playwright が読み込まれないことを検査する（メモにある typecheck 用 lint の先取り）。
2. **組み立て層の純化と改名**: `buildSummary` を純粋関数にし、summary の中の取得呼び出しを削除。`toyo-context.ts` を分割し、自動 sync を削除。summary の置き場所を移し、Worker にフォールバックを入れてデプロイ。突き合わせで差分を確認。
   - **完了（本体 3752cb2、Worker bace5c5、評価ルール生成の入力切替など周辺の修正はこのメモを更新したコミット、2026-10-08）**。
   - 実装中に決めたこと: `scripts/build/` は summary・context・context-markdown・course-lookup（課題・お知らせ・コンテンツを index で授業コードに引く resolver）。ファイルの読み書きは CLI 側（`toyo-build.ts` / `toyo-context.ts` / `toyo-build-index.ts`）。純粋性は `scripts/dev/course-index.test.ts` が `scripts/build/` 全体で検査する（値の import は Node 標準・同ディレクトリ・純粋な `lib/` に限る、`fetch(` 禁止、読み込んでも playwright が読み込まれない）。`import type` は実行時に消えるので許す。
   - 純粋化のため `lib/` から切り出したもの: `lib/coursework-model.ts`（coursework の型と brief / schedule の計算）、`lib/syllabus-cache.ts`（シラバスのキャッシュの型と読み出し）、`lib/course-code.ts`（`inferScheduleCd` と `syllabusFileStem`。scheduleCd の推定式とシラバスのファイル名整形は 1 か所になった）。`healthWarnings` は呼び出し側（`toyo-context.ts`）が計算して `ContextInputs.healthWarnings` で渡す。
   - summary の全体一覧（`upcomingAssignments` / `courseContents` / `announcements`）の各項目に、index で引いた授業コード `courseCode` を付けた。引けないもの（履修外の ACE コース、全学のお知らせなど）は `null`（科目不明）で残す。お知らせは `courseNameHint` を引き、hint が無いときだけタイトルに科目名のキーが丸ごと（3 文字以上）含まれるものを引く。先頭 4 文字の部分一致はやめた。
   - agent-context から `sync` フィールド（と Markdown の `- sync:` 行）を削除した。`--sync` は廃止（エラー）、`--no-sync` は受け付けて無視する。
   - 取得と build の線引き: `toyo:sync` は ACE 各取得の不調では失敗にしない（履修登録確認表の取得が落ちたときだけ失敗）。`toyo:daily` のシラバス補完の段は警告にとどめ成功扱い。`toyo:coursework` / `toyo:sync` の `--no-summary` は `--no-build` になった（daily は最後にまとめて build するため付ける）。
   - 残した課題: `toyo-coursework.service` の ExecStart に残っている `toyo:context -- --no-sync` は、`toyo:coursework` が `toyo:build` を呼ぶようになったため冗長（無害）。ユニットを触るときに外してよい。Worker の旧パスのフォールバックと publish の `LEGACY_PATTERNS` は 2026-10 以降に削除する。
3. **ディレクトリの移動**: 機械的な移動と import の修正のみ。挙動は変えない。

各コミットの後にタイマーを 1 周させて health が success であることを確認する。

## このメモで決めないこと

- パーサのテスト（構造が固まった後に別作業）
- ACE をブラウザなしの HTTP で取る軽量化（別作業）

## ステップ 1 の後に追加した課題（ステップ 2 で扱う）

- **評価ルール生成の入力**: `toyo:grading-rules` がシラバス本文を「最新の候補ファイル」から読んでいる。追加登録期間の取得（本文なし）の後では空になり、scheduleCd を授業コード欄に入れた空の下書きを重複追加した（1603c11 で手修正）。入力をシラバスのキャッシュと pool に切り替え、授業コードが確定しない科目は下書きを作らないようにする。
- **欠けの扱いと通知の線引き**: データの欠け（シラバスが取れない、ACE 未反映、評価ルールが無い）は index と agent-context の警告で知らせ、ジョブの失敗にはしない。ジョブの失敗（＝通知）は、取得そのものが落ちたときだけにする。daily のシラバス補完が失敗しても daily は成功扱いにする。
- **summary の科目突き合わせ**: `lib/toyo-summary.ts` の名前の `===` 比較と課題タイトルの部分一致を、course-index 経由の授業コード照合に置き換える。
- **重複の解消**: scheduleCd の推定式（2 か所）、シラバスのファイル名整形（4 か所）を 1 か所にまとめる。`lib/toyo-syllabus.ts` の `normalizeCourseName` は時間割検索の照合専用として残し、名前をそれと分かるものにする。
