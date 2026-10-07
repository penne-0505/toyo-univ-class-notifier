import type { Announcement, Assignment, CourseworkFile, DetailedClassSummary, Summary, FileMetadata, GradingRulesFile, HealthSnapshot, PublishMeta, RegistrationData, SyllabusFile } from './types';
import { assignmentCourseInfo, buildCourseDetail, buildCourseIndex, courseSummaryLine, resolveCourse, waitingAssignments } from './courses';

const API_VERSION = '1';
const MAX_BODY_BYTES = 25 * 1024 * 1024; // KV の値上限 25 MiB
const FILE_PREFIX = 'f:';
const META_KEY = 'meta';
const HEALTH_FILE = 'output/toyo/health.json';
const UPDATED_AT_KEY = 'updatedAt';
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// summary.json は 2026-10 に output/bot/ から output/toyo/ へ移した。旧パスは 1 リリース分の互換（読み出しのフォールバックと、
// toyo:publish が旧ファイルを削除するための DELETE）として許可している。2026-10 以降に削除する（旧パスの正規表現と LEGACY_SUMMARY_FILE）。
const SUMMARY_FILE = 'output/toyo/summary.json';
const LEGACY_SUMMARY_FILE = 'output/bot/summary.json';
const ALLOWED_PATH = [/^output\/toyo\/.+/, /^output\/bot\/summary\.json$/, /^data\/.+/];

type Role = 'read' | 'write';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(message);
  }
}

// ---------- 共通 ----------

const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2) + '\n', {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function errorResponse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }) + '\n', {
    status,
    headers: { ...BASE_HEADERS, ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** 長さが違っても時間が変わらないよう、SHA-256 にしてから定数時間で比較する。 */
async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
  return diff === 0;
}

async function authenticate(request: Request, env: Env): Promise<Role> {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new HttpError(401, 'Authorization: Bearer <key> が必要です', { 'WWW-Authenticate': 'Bearer' });
  const token = match[1]!;
  // 両方を必ず比較する（短絡しない）
  const [isWrite, isRead] = await Promise.all([constantTimeEquals(token, env.WRITE_KEY), constantTimeEquals(token, env.READ_KEY)]);
  if (isWrite) return 'write';
  if (isRead) return 'read';
  throw new HttpError(401, 'キーが正しくありません', { 'WWW-Authenticate': 'Bearer' });
}

/** URL の path 部分を検証して正規化する。allowlist 外・不正な形は null。 */
function parseFilePath(raw: string): string | null {
  if (raw === '') return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.startsWith('/')) return null;
  const segments = decoded.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return null;
  if (!ALLOWED_PATH.some((p) => p.test(decoded))) return null;
  return decoded;
}

function contentTypeFor(rel: string, header: string | null): string {
  if (header && header.trim() !== '') return header;
  if (rel.endsWith('.json')) return 'application/json; charset=utf-8';
  if (rel.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (rel.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

// ---------- JST 日付 ----------

function jstDateString(epochMs: number): string {
  return new Date(epochMs + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** ISO 文字列（+09:00 付き）を epoch ms に。解釈できなければ null。 */
function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// ---------- KV ----------

/** summary.json を読む。output/toyo/summary.json が無ければ旧パス（output/bot/summary.json）にフォールバック（2026-10 以降に削除）。 */
async function readSummaryOrNull(env: Env): Promise<Summary | null> {
  return (
    (await env.DATA.get<Summary>(FILE_PREFIX + SUMMARY_FILE, 'json')) ??
    (await env.DATA.get<Summary>(FILE_PREFIX + LEGACY_SUMMARY_FILE, 'json'))
  );
}

async function readSummary(env: Env): Promise<Summary> {
  const summary = await readSummaryOrNull(env);
  if (!summary) throw new HttpError(404, 'summary.json はまだ投入されていません');
  return summary;
}

async function readJsonFile<T>(env: Env, rel: string): Promise<T | null> {
  return env.DATA.get<T>(FILE_PREFIX + rel, 'json');
}

async function readCourseSources(env: Env) {
  const [registration, coursework, rules] = await Promise.all([
    readJsonFile<RegistrationData>(env, 'output/toyo/registration-data.json'),
    readJsonFile<CourseworkFile>(env, 'output/toyo/toyonet-ace-coursework.json'),
    readJsonFile<GradingRulesFile>(env, 'data/grading-rules.json'),
  ]);
  return { registration, coursework, rules, index: buildCourseIndex(registration, coursework) };
}

async function getUpdatedAt(env: Env): Promise<string | null> {
  return env.DATA.get(UPDATED_AT_KEY);
}

/**
 * 定期ジョブの状態。遷移（アラート・回復）のときに toyo:health が直接 PUT する health.json が最新なので、
 * それを優先し、無ければ publish が meta に載せた写しを使う。
 */
async function readHealth(env: Env, meta: PublishMeta | null): Promise<HealthSnapshot | null> {
  const direct = await readJsonFile<HealthSnapshot>(env, HEALTH_FILE);
  return direct ?? meta?.health ?? null;
}

function isDegraded(health: HealthSnapshot | null): boolean {
  return Array.isArray(health?.alerting) && health.alerting.length > 0;
}

async function touch(env: Env): Promise<void> {
  await env.DATA.put(UPDATED_AT_KEY, new Date().toISOString());
}

async function readLimitedBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new HttpError(413, `本文が上限 ${MAX_BODY_BYTES} バイトを超えています`);
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, `本文が上限 ${MAX_BODY_BYTES} バイトを超えています`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// ---------- ハンドラ ----------

async function handleMeta(env: Env): Promise<Response> {
  const [meta, updatedAt] = await Promise.all([env.DATA.get<PublishMeta>(META_KEY, 'json'), getUpdatedAt(env)]);
  if (!meta) throw new HttpError(404, 'meta.json はまだ投入されていません');
  return json({ apiVersion: API_VERSION, updatedAt, ...meta, health: await readHealth(env, meta) });
}

async function handleContext(env: Env, url: URL): Promise<Response> {
  const asJson = url.searchParams.get('format') === 'json';
  const key = FILE_PREFIX + (asJson ? 'output/toyo/agent-context.json' : 'output/toyo/agent-context.md');
  const { value, metadata } = await env.DATA.getWithMetadata<FileMetadata>(key, 'stream');
  if (!value) throw new HttpError(404, 'agent-context はまだ投入されていません');
  const type = asJson ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8';
  return new Response(value, { headers: { ...BASE_HEADERS, 'Content-Type': metadata?.contentType ?? type } });
}

async function handleFileList(env: Env): Promise<Response> {
  const [meta, updatedAt] = await Promise.all([env.DATA.get<PublishMeta>(META_KEY, 'json'), getUpdatedAt(env)]);
  const files: Array<{ path: string; size: number | null; contentType: string | null; fetchedAt: string | null; storedAt: string | null }> = [];
  let cursor: string | undefined;
  for (;;) {
    const page: KVNamespaceListResult<FileMetadata, string> = await env.DATA.list<FileMetadata>({ prefix: FILE_PREFIX, cursor });
    for (const key of page.keys) {
      const path = key.name.slice(FILE_PREFIX.length);
      files.push({
        path,
        size: key.metadata?.size ?? null,
        contentType: key.metadata?.contentType ?? null,
        fetchedAt: meta?.files[path]?.fetchedAt ?? null,
        storedAt: key.metadata?.storedAt ?? null,
      });
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return json({ apiVersion: API_VERSION, updatedAt, count: files.length, files });
}

async function handleFileGet(env: Env, rel: string): Promise<Response> {
  const { value, metadata } = await env.DATA.getWithMetadata<FileMetadata>(FILE_PREFIX + rel, 'stream');
  if (!value) throw new HttpError(404, `見つかりません: ${rel}`);
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    'Content-Type': contentTypeFor(rel, metadata?.contentType ?? null),
  };
  if (metadata?.size !== undefined) headers['Content-Length'] = String(metadata.size);
  return new Response(value, { headers });
}

async function handleFilePut(env: Env, request: Request, rel: string): Promise<Response> {
  const body = await readLimitedBody(request);
  const metadata: FileMetadata = {
    contentType: contentTypeFor(rel, request.headers.get('Content-Type')),
    size: body.byteLength,
    storedAt: new Date().toISOString(),
  };
  await env.DATA.put(FILE_PREFIX + rel, body, { metadata });
  return json({ ok: true, path: rel, size: metadata.size });
}

async function handleMetaPut(env: Env, request: Request): Promise<Response> {
  const body = await readLimitedBody(request);
  const text = new TextDecoder().decode(body);
  try {
    JSON.parse(text);
  } catch {
    throw new HttpError(400, 'meta は JSON で送ってください');
  }
  await env.DATA.put(META_KEY, text);
  await touch(env);
  return json({ ok: true, size: body.byteLength });
}

async function handleFileDelete(env: Env, rel: string): Promise<Response> {
  await env.DATA.delete(FILE_PREFIX + rel);
  return json({ ok: true, path: rel, deleted: true });
}

async function handleSummary(env: Env): Promise<Response> {
  let { value, metadata } = await env.DATA.getWithMetadata<FileMetadata>(FILE_PREFIX + SUMMARY_FILE, 'stream');
  if (!value) {
    // 旧パスへのフォールバック（2026-10 以降に削除）
    ({ value, metadata } = await env.DATA.getWithMetadata<FileMetadata>(FILE_PREFIX + LEGACY_SUMMARY_FILE, 'stream'));
  }
  if (!value) throw new HttpError(404, 'summary.json はまだ投入されていません');
  return new Response(value, {
    headers: { ...BASE_HEADERS, 'Content-Type': metadata?.contentType ?? 'application/json; charset=utf-8' },
  });
}

type AssignmentOut = Assignment & { deadlineUnknown?: true; overdue?: true; waiting?: true; opensAt?: string | null; course?: unknown };

async function handleAssignmentsFrom(env: Env, summary: Summary, url: URL, nowMs: number): Promise<Response> {
  const within = url.searchParams.get('within') ?? '7d';
  const status = url.searchParams.get('status');
  if (status !== null && status !== 'pending' && status !== 'submitted' && status !== 'unknown') {
    throw new HttpError(400, 'status は pending | submitted | unknown');
  }

  const today = jstDateString(nowMs);
  const tomorrow = jstDateString(nowMs + 24 * 60 * 60 * 1000);
  let predicate: (dueMs: number) => boolean;
  const days = /^(\d{1,3})d$/.exec(within);
  if (within === 'all') predicate = () => true;
  else if (within === 'today') predicate = (ms) => jstDateString(ms) === today;
  else if (within === 'tomorrow') predicate = (ms) => jstDateString(ms) === tomorrow;
  else if (days) {
    const limit = nowMs + Number(days[1]) * 24 * 60 * 60 * 1000;
    predicate = (ms) => ms <= limit; // 期限切れ（過去）も含め、overdue を付ける
  } else {
    throw new HttpError(400, 'within は 7d（任意の Nd）| today | tomorrow | all');
  }

  const includeWaiting = url.searchParams.get('includeWaiting') === '1';
  const { coursework, rules, index } = await readCourseSources(env);
  const all: AssignmentOut[] = [
    ...summary.upcomingAssignments,
    ...(summary.deadlineUnknownAssignments ?? []),
    ...(includeWaiting ? waitingAssignments(coursework) : []),
  ];
  const seen = new Set<string>();
  const dated: AssignmentOut[] = [];
  const unknown: AssignmentOut[] = [];
  for (const a of all) {
    if (seen.has(a.assignmentId)) continue;
    seen.add(a.assignmentId);
    if (status && a.status !== status) continue;
    const dueMs = parseMs(a.dueAt);
    const withCourse = { ...a, course: assignmentCourseInfo(a, index, rules) };
    if (dueMs === null) {
      unknown.push({ ...withCourse, deadlineUnknown: true });
    } else if (predicate(dueMs)) {
      dated.push(dueMs < nowMs ? { ...withCourse, overdue: true } : withCourse);
    }
  }
  dated.sort((a, b) => (parseMs(a.dueAt) ?? 0) - (parseMs(b.dueAt) ?? 0));

  return json({
    summaryGeneratedAt: summary.generatedAt,
    now: new Date(nowMs).toISOString(),
    within,
    status,
    includeWaiting,
    courseworkFetchedAt: coursework?.fetchedAt ?? null,
    count: dated.length + unknown.length,
    note: 'deadlineUnknown: true は dueAt が取得できなかった課題。締切が近いとは扱わず、不確実だと伝えること。waiting: true は受付開始待ちで、未提出一覧にはまだ載らない項目（includeWaiting=1 のときだけ混ざる）。course.coursework は ACE の提出済み数 / 未提出数。',
    assignments: [...dated, ...unknown],
  });
}

async function handleCourseList(env: Env): Promise<Response> {
  const { registration, coursework, index } = await readCourseSources(env);
  if (!registration) throw new HttpError(404, 'registration-data.json はまだ投入されていません');
  return json({
    registrationFetchedAt: registration.fetchedAt,
    courseworkFetchedAt: coursework?.fetchedAt ?? null,
    note: 'key には courseCode / aceCourseId / 科目名（全角半角・空白・大小文字は無視）を使える。aceCourseId が null の科目は ACE にコースが見つからなかったもの。registered:false は ACE にだけあるコース（自己登録など）。',
    count: index.filter((e) => e.registered).length,
    courses: index.filter((e) => e.registered).map(courseSummaryLine),
    aceOnlyCourses: index.filter((e) => !e.registered).map(courseSummaryLine),
  });
}

async function handleCourseDetail(env: Env, rawKey: string, nowMs: number): Promise<Response> {
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    throw new HttpError(400, 'key のエンコードが不正です');
  }
  const { coursework, rules, index } = await readCourseSources(env);
  const resolved = resolveCourse(index, key);
  if (resolved.kind === 'none') throw new HttpError(404, `科目が見つかりません: ${key}（/v1/courses で一覧を確認）`);
  if (resolved.kind === 'many') {
    return json({ error: `複数の科目に一致しました。courseCode か aceCourseId で指定してください: ${key}`, candidates: resolved.candidates.map(courseSummaryLine) }, 300);
  }
  const entry = resolved.entry;
  const [summary, syllabusFile] = await Promise.all([
    readSummaryOrNull(env),
    entry.courseCode ? readJsonFile<SyllabusFile>(env, `output/toyo/syllabus/${entry.courseCode}.json`) : Promise.resolve(null),
  ]);
  return json(buildCourseDetail({ entry, summary, coursework, rules, syllabusFile, nowMs, todayString: jstDateString(nowMs) }));
}

function dayView(summary: Summary, which: 'today' | 'tomorrow', nowMs: number): Response {
  const offset = which === 'today' ? 0 : 24 * 60 * 60 * 1000;
  const date = jstDateString(nowMs + offset);
  const classes: DetailedClassSummary[] = which === 'today' ? summary.todayClasses : summary.tomorrowClasses;
  const generatedDate = parseMs(summary.generatedAt) === null ? null : jstDateString(Date.parse(summary.generatedAt));
  const expectedGenerated = jstDateString(nowMs);
  const announcements: Announcement[] = summary.announcements.filter((a) => a.targetDate !== null && a.targetDate.slice(0, 10) === date);
  const dueAssignments = [...summary.upcomingAssignments, ...(summary.deadlineUnknownAssignments ?? [])].filter((a) => {
    const ms = parseMs(a.dueAt);
    return ms !== null && jstDateString(ms) === date && a.status !== 'submitted';
  });
  return json({
    date,
    summaryGeneratedAt: summary.generatedAt,
    // summary は取得時点の「今日/明日」で固定される。日付をまたいで古いなら授業一覧がずれている。
    summaryDateMismatch: generatedDate !== expectedGenerated,
    classes,
    announcements,
    assignmentsDue: dueAssignments,
  });
}

const INDEX_MD = `# toyo-data-api

東洋大学の学内システムから自動取得したデータを、クラウドのエージェントが読むための REST API です。
データは本人のマシンが投入します（正本は private GitHub repo \`toyo-data\`）。学籍番号・氏名・成績を含むため、**Bearer キー必須**です。

## 認証

\`\`\`
curl -H "Authorization: Bearer $TOYO_READ_KEY" https://<このホスト>/v1/context
\`\`\`

キーは本人から受け取ります。読み取りキーはエージェントのホストの環境変数などに置き、ログや会話に出さないでください。

## エンドポイント（すべて JSON、\`Cache-Control: no-store\`）

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | /v1/health | 認証不要。\`{ ok, updatedAt, degraded }\`。\`degraded: true\` は取得側の定期ジョブが失敗中（詳細は /v1/meta の \`health\`） |
| GET | /v1/meta | publishedAt、各ファイルの fetchedAt、sourceStatus、updatedAt、health（定期ジョブの最終成功・連続失敗・alerting） |
| GET | /v1/context | agent-context.md（text/markdown）。\`?format=json\` で JSON。まずこれを読む |
| GET | /v1/files | 保存中のパスとサイズ・fetchedAt |
| GET | /v1/files/{path} | ファイルをそのまま返す（output/toyo/, data/ のみ。旧 output/bot/summary.json も 2026-10 までは通す） |
| GET | /v1/summary | output/toyo/summary.json（無ければ旧 output/bot/summary.json） |
| GET | /v1/assignments | \`?within=7d\\|14d\\|today\\|tomorrow\\|all&status=pending&includeWaiting=1\`。締切不明は \`deadlineUnknown: true\`。各要素に \`course\`（配点・足切り・提出済/未提出数）。\`includeWaiting=1\` で受付開始待ちも混ぜる（\`waiting: true\`） |
| GET | /v1/courses | 登録科目一覧（授業コード・科目名・曜日時限・ACE courseId） |
| GET | /v1/courses/{key} | 科目 1 件の統合ビュー。key は授業コード / ACE courseId / 科目名（曖昧一致、複数ヒットは 300 で候補）。時間割・今日の第N回・シラバス（回ごと）・成績ルール・提出状況・課題・お知らせ・コンテンツ |
| GET | /v1/today, /v1/tomorrow | 授業 + その日のお知らせ + 当日締切の課題 |
| PUT/DELETE | /v1/files/{path}, PUT /v1/meta | 書き込み専用キーのみ（取得側が使う） |

エラーは \`{ "error": "..." }\` で返ります（401 キー不正、404 なし、413 大きすぎ）。

## 鮮度の読み方

- 変化があったときだけ更新されます。\`meta.publishedAt\` が古い ＝ その間に変化が無かった、とは限りません。
- 毎日 04:30 JST に必ず 1 回は全取得します。**\`meta.publishedAt\` が 24 時間より古ければ、取得側が止まっている**と判断してください。
- 課題・お知らせは 5 分ごとに確認します。個別の鮮度は \`sourceStatus.toyonetAce.fetchedAt\` / \`announcementsFetchedAt\`。
- \`sourceStatus.portal.fetchStatus\` が \`error\` のときは履修データを信用しないでください。
- /v1/today, /v1/tomorrow の \`summaryDateMismatch: true\` は、summary の生成日と今日がずれている（授業一覧が古い）サイン。
- 提出状況（\`/v1/courses/{key}\` の coursework、\`/v1/assignments\` の course.coursework）は \`toyo:coursework\`（毎時 :20）の取得時点。鮮度は \`courseworkFetchedAt\`。\`submitted: null\` は ACE の一覧から提出状態を読めなかった項目。
- 取得側の定期ジョブ（watch / coursework / daily）が失敗中のとき、GET の応答に \`X-Toyo-Degraded: 1\` ヘッダが付きます。詳細は /v1/meta の \`health\`（\`alerting\` にジョブ名、各ジョブに lastSuccessAt / consecutiveFailures）。context の Warnings にも同じ内容が載ります。
- \`dueAt\` が null の課題は締切不明です。差し迫った課題として扱わないでください。
`;

// ---------- ルーティング ----------

/** 認証済みの GET 応答に、劣化中だけ X-Toyo-Degraded: 1 を付ける。 */
async function withDegradedHeader(env: Env, response: Response): Promise<Response> {
  if (!response.ok) return response;
  let degraded = false;
  try {
    const meta = await env.DATA.get<PublishMeta>(META_KEY, 'json');
    degraded = isDegraded(await readHealth(env, meta));
  } catch {
    return response; // 健康状態を読めなくても本来の応答は返す
  }
  if (!degraded) return response;
  const out = new Response(response.body, response);
  out.headers.set('X-Toyo-Degraded', '1');
  return out;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === '/' && method === 'GET') {
    return new Response(INDEX_MD, { headers: { ...BASE_HEADERS, 'Content-Type': 'text/markdown; charset=utf-8' } });
  }
  if (path === '/v1/health' && method === 'GET') {
    // 認証不要の応答なので、劣化しているかどうかだけを返す（ジョブ名や詳細は出さない）
    const [updatedAt, meta] = await Promise.all([getUpdatedAt(env), env.DATA.get<PublishMeta>(META_KEY, 'json')]);
    return json({ ok: true, updatedAt, degraded: isDegraded(await readHealth(env, meta)) });
  }
  if (!path.startsWith('/v1/')) throw new HttpError(404, '見つかりません');

  const role = await authenticate(request, env);
  const nowMs = Date.now();

  const filePrefix = '/v1/files/';
  if (path.startsWith(filePrefix)) {
    const rel = parseFilePath(path.slice(filePrefix.length));
    if (rel === null) throw new HttpError(404, '見つかりません');
    if (method === 'GET') return withDegradedHeader(env, await handleFileGet(env, rel));
    if (method === 'PUT' || method === 'DELETE') {
      if (role !== 'write') throw new HttpError(403, '書き込みキーが必要です');
      return method === 'PUT' ? handleFilePut(env, request, rel) : handleFileDelete(env, rel);
    }
    throw new HttpError(405, 'Method Not Allowed', { Allow: 'GET, PUT, DELETE' });
  }

  if (path === '/v1/meta') {
    if (method === 'GET') return withDegradedHeader(env, await handleMeta(env));
    if (method === 'PUT') {
      if (role !== 'write') throw new HttpError(403, '書き込みキーが必要です');
      return handleMetaPut(env, request);
    }
    throw new HttpError(405, 'Method Not Allowed', { Allow: 'GET, PUT' });
  }

  if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed', { Allow: 'GET' });
  return withDegradedHeader(env, await readRoute(path, url, env, nowMs));
}

async function readRoute(path: string, url: URL, env: Env, nowMs: number): Promise<Response> {
  switch (path) {
    case '/v1/context':
      return handleContext(env, url);
    case '/v1/files':
      return handleFileList(env);
    case '/v1/summary':
      return handleSummary(env);
    case '/v1/assignments':
      return handleAssignmentsFrom(env, await readSummary(env), url, nowMs);
    case '/v1/courses':
      return handleCourseList(env);
    case '/v1/today':
      return dayView(await readSummary(env), 'today', nowMs);
    case '/v1/tomorrow':
      return dayView(await readSummary(env), 'tomorrow', nowMs);
    default:
      if (path.startsWith('/v1/courses/') && path.length > '/v1/courses/'.length) {
        return handleCourseDetail(env, path.slice('/v1/courses/'.length), nowMs);
      }
      throw new HttpError(404, '見つかりません');
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.status, error.message, error.headers);
      console.error(JSON.stringify({ message: 'unhandled', error: error instanceof Error ? error.message : String(error) }));
      return errorResponse(500, 'Internal Server Error');
    }
  },
} satisfies ExportedHandler<Env>;
