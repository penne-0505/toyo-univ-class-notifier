# toyo-data-api

`toyo:publish` が集めた取得データ（`output/toyo/**`、`data/**`）を、GitHub を読めないクラウドのエージェントが REST で読むための Cloudflare Worker。KV に保存し、Bearer キーで保護する。データには学籍番号・氏名・成績が含まれる。

正本は GitHub の private repo `toyo-data`。Worker は配信用の複製で、GitHub トークンは持たない。

デプロイ先: `https://toyo-data-api.penne0505pp.workers.dev`

```
toyo:publish ─ PUT/DELETE (書き込みキー) ─▶ Worker ─▶ KV (DATA)
クラウドのエージェント ─ GET (読み取りキー) ─▶ Worker
```

## エンドポイント

すべて JSON（明記したものを除く）、`Cache-Control: no-store`。エラーは `{ "error": "..." }`。`GET /` と `GET /v1/health` 以外は `Authorization: Bearer <key>` 必須。

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/` | 認証不要。API の説明（text/markdown） |
| GET | `/v1/health` | 認証不要。`{ ok, updatedAt, degraded }`。`degraded` は取得側の定期ジョブにアラート中のものがあるか（ジョブ名・詳細は出さない） |
| GET | `/v1/meta` | `meta.json`（publishedAt, files, sourceStatus）＋ `apiVersion`、`updatedAt`、`health`（`output/toyo/health.json` の内容。定期ジョブごとの最終成功・連続失敗・`alerting`。直接 PUT された health.json があればそちらを優先） |
| GET | `/v1/context` | `agent-context.md`（text/markdown）。`?format=json` で JSON |
| GET | `/v1/files` | 保存中のパス・サイズ・fetchedAt |
| GET | `/v1/files/{path}` | ファイルをそのまま返す。許可は `output/toyo/`、`data/` のみ（他は 404）。旧 `output/bot/summary.json` も 2026-10 までは通す（削除用） |
| GET | `/v1/summary` | `output/toyo/summary.json`（全ソースを集約した summary）。無ければ旧パス `output/bot/summary.json` にフォールバック（1 リリース分の互換。2026-10 以降に削除） |
| GET | `/v1/assignments?within=7d\|14d\|today\|tomorrow\|all&status=pending&includeWaiting=1` | 課題。`within` は `Nd` 任意、既定 `7d`。JST 判定。期限切れの未提出は `overdue: true`、`dueAt` が null は `deadlineUnknown: true`（常に末尾に含む）。各要素に `course: { courseCode, courseName, gradingWeight: { name, weightPercent, kind, perSession, scenario } \| null, cutoffs, coursework: { submitted, notSubmitted } \| null }`（科目不明は `course: null`）。`includeWaiting=1` で ACE の受付開始待ちの report / query も混ぜる（`waiting: true`、`opensAt` 付き） |
| GET | `/v1/courses` | 登録科目一覧（`courseCode`・`courseName`・`timetable`・`aceCourseId`）。`aceOnlyCourses` は ACE にだけあるコース（自己登録など） |
| GET | `/v1/courses/{key}` | 科目の統合ビュー。`key` は授業コード / ACE courseId / 科目名（NFKC・空白除去・大文字化で曖昧一致。複数ヒットは **HTTP 300** と `candidates`、0 件は 404）。応答: `course`・`timetable`・`sessionNumberToday`（summary が今日のものでなければ null）・`nextSessionNumber`・`syllabus`（`lectureSchedule` を回ごとに分割、`today` / `next` の抜粋。シラバス未取得なら null）・`gradingRules`・`coursework`（items / counts / grades / recentSubmissions）・`assignments`・`announcements`（直近 5 件）・`contents`（直近 5 件） |
| GET | `/v1/today`, `/v1/tomorrow` | 授業 ＋ その日が `targetDate` のお知らせ ＋ 当日締切の課題。`summaryDateMismatch: true` は summary が古く授業一覧がずれている可能性 |
| PUT | `/v1/files/{path}` | 本文をそのまま保存（`Content-Type` も保存）。書き込みキーのみ。25 MiB 超は 413 |
| PUT | `/v1/meta` | `meta.json` を保存し `updatedAt` を更新。書き込みキーのみ |
| DELETE | `/v1/files/{path}` | 削除。書き込みキーのみ |

認証済みの GET 応答は、`health.alerting` が空でないとき（劣化中）だけ `X-Toyo-Degraded: 1` ヘッダが付く。

書き込みキーは読み取りも可能。読み取りキーで PUT/DELETE すると 403。

### 鮮度の読み方

- `meta.publishedAt` が 24 時間超なら取得側（このマシンのタイマー）の停止とみなす。毎日 04:30 JST の daily が必ず 1 回 meta を更新する。
- 提出状況（coursework）は毎時 :20 の取得。鮮度は `/v1/courses/{key}` / `/v1/assignments` の `courseworkFetchedAt`、`sourceStatus.toyonetAce.courseworkFetchedAt`。`submitted: null` は ACE の一覧から提出状態を読めなかった項目。
- 課題・お知らせの鮮度は `sourceStatus.toyonetAce.fetchedAt` / `announcementsFetchedAt`。
- `updatedAt` は最後に `PUT /v1/meta` した時刻（KV の同一キー書き込み制限を避けるため、ファイル単位では更新しない）。

## 鍵の扱い

| 鍵 | secret 名 | 置き場所 |
| --- | --- | --- |
| 読み取りキー | `READ_KEY` | クラウドのエージェントのホスト（環境変数など） |
| 書き込みキー | `WRITE_KEY` | このマシンだけ。`.env.local` の `TOYO_API_WRITE_KEY` |

- このマシンの控え: `~/.config/toyo-data-api/keys.json`（mode 600）。コードや repo には入れない。
- ローカル開発用の `.dev.vars` は gitignore 済み。

### ローテーション

```bash
node -e 'const c=require("crypto");console.log(JSON.stringify({READ_KEY:c.randomBytes(32).toString("base64"),WRITE_KEY:c.randomBytes(32).toString("base64")}))' > /tmp/keys.json
chmod 600 /tmp/keys.json
npx wrangler secret bulk /tmp/keys.json   # worker/ で実行。片方だけ替えるなら JSON に片方だけ入れる
# keys.json の内容を ~/.config/toyo-data-api/keys.json に反映し、
# 書き込みキーは .env.local の TOYO_API_WRITE_KEY、読み取りキーは各エージェントのホストへ
shred -u /tmp/keys.json
```

secret は即時に反映される。読み取りキーを替えたら、旧キーを使うエージェントは 401 になる。

## デプロイ

```bash
cd worker
npm install
npm run typecheck        # wrangler types + tsc --noEmit
npx wrangler deploy
```

- `wrangler.jsonc` の `secrets.required` により、secret 未設定だと deploy が失敗する。**新規 Worker の初回だけ** `npx wrangler deploy --secrets-file <keys.json>` で渡す（`{"READ_KEY": "...", "WRITE_KEY": "..."}`）。以後は `wrangler deploy` だけでよい。
- KV namespace は `npx wrangler kv namespace create DATA` で作成済み。id は `wrangler.jsonc` に記載。
- `compatibility_date` は UTC の「今日」を超えられない（未来日だと deploy が拒否される）。
- 全件を入れ直す: repo ルートで `npm run toyo:publish -- --push-all-api`。
- 型 `src/types.ts` は `scripts/build/summary.ts` と `scripts/lib/coursework-model.ts` のコピー。元が変わったら追従する。
- 科目の統合ロジックは `src/courses.ts`（KV からの読み出しは `src/index.ts`）。読むファイルは `output/toyo/summary.json`（無ければ旧 `output/bot/summary.json`）・`output/toyo/registration-data.json`・`output/toyo/toyonet-ace-coursework.json`・`output/toyo/syllabus/<授業コード>.json`・`data/grading-rules.json`。
