/**
 * 履修登録（正規登録期間）画面に科目を入れて「登録実行」する。
 *
 * 既定は dry-run（画面に選択を入れた状態のスクリーンショットと add/cancel の差分を出すだけ）。
 * 実際に送信するには --exec を付ける。送信結果（成功 / エラー・警告一覧）は標準出力と
 * artifacts/toyo/register-result.* に残す。
 *
 * Usage:
 *   npm run toyo:register -- --add 3499301150-001,3499101290-001        # dry-run
 *   npm run toyo:register -- --file plan.json                            # [{"scheduleCd": "..."}] or ["..."]
 *   npm run toyo:register -- --file plan.json --cancel 3499200020-001 --exec
 *   npm run toyo:register -- --add                                        # 変更なし（現在の登録状態を見る）
 *
 * 科目の選択ID（scheduleCd）は output/toyo/registration-candidates.json（npm run toyo:candidates）で分かる。
 * 登録画面は科目一覧ポップアップからしか科目を選べないが、ページ内の _onUpdate() を直接呼んでも
 * 送信内容（add / cancel の scheduleCd 一覧）は同じになる。サーバー側で履修上限・重複などが判定され、
 * エラー（E）があれば何も登録されない。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { type Page } from 'playwright';
import {
  candidatesOutputPath,
  describeUnavailableScreen,
  RegistrationScreenUnavailableError,
  type RegistrationCandidatesData,
} from './registration-candidates';
import {
  getOrCreatePage,
  launchStateContext,
  paths,
  recoverToyoSessionIfNeeded,
  shouldRunHeadless,
} from '../lib/toyo';

const registrationUrls = {
  regular: 'https://g-sys.toyo.ac.jp/univision/action/in/f07/Usin070311', // 正規登録期間
  add: 'https://g-sys.toyo.ac.jp/univision/action/in/f07/Usin071611', // 追加登録期間（先着順・限られた科目のみ）
} as const;
type Period = keyof typeof registrationUrls;

type CliOptions = {
  add: string[];
  cancel: string[];
  file: string | null;
  exec: boolean;
  period: Period;
  maxCredits: number | null;
  skipMissing: boolean;
};

type RowValue = { koma: string; scheduleCd: string; subjectName: string; credit: string; uneditable: boolean };

export type RegisterResult = {
  executed: boolean;
  status: 'dry-run' | 'success' | 'error' | 'unknown';
  add: string[];
  cancel: string[];
  rowsBefore: RowValue[];
  rowsAfter: RowValue[];
  messages: string[];
  rowErrors: { scheduleCd: string; subjectName: string; message: string; type: 'E' | 'W' | '' }[];
  screenshotPath: string | null;
};

function usage(): string {
  return [
    'Usage:',
    '  npm run toyo:register -- --add <scheduleCd,...> [--cancel <scheduleCd,...>] [--exec]',
    '  npm run toyo:register -- --file <plan.json> [--exec]',
    '  npm run toyo:register -- --file <plan.json> --period add --max-credits 24 --skip-missing --exec',
    '',
    'plan.json は ["scheduleCd", ...] または [{"scheduleCd": "...", ...}] の配列（並び順 = 優先順）。',
    '--period add     追加登録期間の画面（Usin071611）を使う（既定は正規登録 regular）',
    '--max-credits N  登録後の合計が N 単位を超えない範囲で、plan の順に追加する（超える科目は飛ばす）',
    '--skip-missing   registration-candidates.json に無い scheduleCd はエラーにせず飛ばす',
    '--exec を付けない限り送信しない。',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { add: [], cancel: [], file: null, exec: false, period: 'regular', maxCredits: null, skipMissing: false };
  const list = (value: string | undefined): string[] =>
    (value ?? '')
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--exec') {
      options.exec = true;
      continue;
    }
    if (arg === '--add') {
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        options.add.push(...list(next));
        index += 1;
      }
      continue;
    }
    if (arg === '--cancel') {
      options.cancel.push(...list(argv[index + 1]));
      index += 1;
      continue;
    }
    if (arg === '--file') {
      options.file = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--period') {
      const value = argv[index + 1];
      if (value !== 'regular' && value !== 'add') throw new Error(`--period は regular か add: ${value}`);
      options.period = value;
      index += 1;
      continue;
    }
    if (arg === '--max-credits') {
      options.maxCredits = Number(argv[index + 1]);
      if (!Number.isFinite(options.maxCredits)) throw new Error('--max-credits には数値を指定してください');
      index += 1;
      continue;
    }
    if (arg === '--skip-missing') {
      options.skipMissing = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
  }
  return options;
}

async function readPlanFile(file: string): Promise<string[]> {
  const raw = JSON.parse(await fs.readFile(path.resolve(file), 'utf8')) as unknown;
  const items = Array.isArray(raw) ? raw : [];
  return items
    .map((item) => (typeof item === 'string' ? item : (item as { scheduleCd?: string; id?: string }).scheduleCd ?? (item as { id?: string }).id ?? ''))
    .filter(Boolean);
}

async function readCandidateMap(): Promise<{
  map: Map<string, RegistrationCandidatesData['candidates'][number]>;
  period: 'regular' | 'add' | null;
  fetchedAt: string | null;
}> {
  try {
    const data = JSON.parse(await fs.readFile(candidatesOutputPath, 'utf8')) as RegistrationCandidatesData;
    return {
      map: new Map(data.candidates.map((candidate) => [candidate.scheduleCd, candidate])),
      period: data.period ?? null, // period フィールド追加前のファイルは正規登録期間のもの
      fetchedAt: data.fetchedAt,
    };
  } catch {
    return { map: new Map(), period: null, fetchedAt: null };
  }
}

// NOTE: tsx（esbuild keepNames）は page.evaluate に渡した関数内の関数定義に __name() を注入して
// ブラウザ側で ReferenceError になるため、ブラウザ側コードは文字列で渡す。
const readRowsScript = String.raw`(() => _getRows().map((tr) => {
  const v = _getValue(tr);
  const clean = (t) => (t || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  return v ? { koma: _getName(tr), scheduleCd: v.scheduleCd, subjectName: clean(v.subjectName), credit: clean(v.credit), uneditable: !!v.uneditable } : null;
}).filter(Boolean))()`;

const readErrorsScript = String.raw`(() => {
  const clean = (v) => (v || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const common = Array.from(document.querySelectorAll('#common_error li')).map((li) => clean(li.textContent)).filter(Boolean);
  const headers = Array.from(document.querySelectorAll('#error_message_header, #error_warning_message_header'))
    .filter((el) => el.offsetParent !== null).map((el) => clean(el.textContent)).filter(Boolean);
  const rows = _getRows().map((tr) => {
    const v = _getValue(tr);
    if (!v || !v.errorMessage) return null;
    return { scheduleCd: v.scheduleCd, subjectName: v.subjectName, message: clean(v.errorMessage), type: v.error ? 'E' : v.warning ? 'W' : '' };
  }).filter(Boolean);
  return { messages: headers.concat(common), rowErrors: rows };
})()`;

async function readRows(page: Page): Promise<RowValue[]> {
  return (await page.evaluate(readRowsScript)) as RowValue[];
}

function komaOf(slot: { dayId: string; periodId: string }): string {
  return `koma_${slot.dayId}_${slot.periodId}`;
}

export async function registerCourses(options: CliOptions): Promise<RegisterResult> {
  const { map: candidateMap, period: candidatesPeriod, fetchedAt: candidatesFetchedAt } = await readCandidateMap();
  if (candidateMap.size > 0 && (candidatesPeriod ?? 'regular') !== options.period) {
    console.warn(
      `警告: registration-candidates.json は ${candidatesPeriod ?? 'regular'} 期間の画面から取得したものです（${candidatesFetchedAt}）。--period ${options.period} の候補とは限りません。` +
        `npm run toyo:candidates${options.period === 'add' ? ' -- --add' : ''} で取り直してください。`
    );
  }
  let wanted = [...new Set(options.add)];
  const unknown = wanted.filter((cd) => !candidateMap.has(cd));
  if (unknown.length > 0) {
    if (!options.skipMissing) {
      throw new Error(
        `次の選択IDが registration-candidates.json にありません（npm run toyo:candidates${options.period === 'add' ? ' -- --add' : ''} で更新してください）: ${unknown.join(', ')}`
      );
    }
    console.warn(`候補一覧に無いため飛ばします（この期間は登録できない科目の可能性）: ${unknown.join(', ')}`);
    wanted = wanted.filter((cd) => candidateMap.has(cd));
  }
  const registrationUrl = registrationUrls[options.period];

  const { browser, context } = await launchStateContext({ headless: shouldRunHeadless(true) });
  const page = await getOrCreatePage(context);
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message()}`);
    if (dialog.type() === 'confirm') {
      void (options.exec ? dialog.accept() : dialog.dismiss());
    } else {
      void dialog.accept();
    }
  });

  try {
    await page.goto(registrationUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await recoverToyoSessionIfNeeded(page, {
      returnUrl: registrationUrl,
      saveState: true,
      snapshotTag: 'register-session-loss',
    });
    const bodyText = ((await page.evaluate('document.body.innerText')) as string).replace(/ /g, ' ');
    if (/この機能は使用可能対象外です|Request Error|システムエラー|不正な操作/.test(bodyText)) {
      throw new RegistrationScreenUnavailableError(describeUnavailableScreen(options.period, bodyText));
    }

    const rowsBefore = await readRows(page);
    const registered = new Set(rowsBefore.map((row) => row.scheduleCd));
    let runningCredits = rowsBefore
      .filter((row) => !options.cancel.includes(row.scheduleCd))
      .reduce((sum, row) => sum + (Number(row.credit) || 0), 0);
    const skippedByCap: string[] = [];

    // 追加: コマごとに _onUpdate。既存の登録は uneditable として残る。
    const byKoma = new Map<string, RegistrationCandidatesData['candidates'][number][]>();
    for (const cd of wanted) {
      if (registered.has(cd) || options.cancel.includes(cd)) continue;
      const candidate = candidateMap.get(cd)!;
      const credit = Number(candidate.credit ?? 0);
      if (options.maxCredits !== null && runningCredits + credit > options.maxCredits) {
        skippedByCap.push(`${cd} ${candidate.courseName} (${credit})`);
        continue;
      }
      runningCredits += credit;
      for (const slot of candidate.slots) {
        const koma = komaOf(slot);
        if (!byKoma.has(koma)) byKoma.set(koma, []);
        byKoma.get(koma)!.push(candidate);
      }
    }
    for (const [koma, candidates] of byKoma) {
      const existing = rowsBefore.filter((row) => row.koma === koma && !options.cancel.includes(row.scheduleCd));
      const values = [
        ...existing.map((row) => ({ scheduleCd: row.scheduleCd, subjectName: row.subjectName, conductionType: '', employeeName: '', credit: row.credit, uneditable: row.uneditable })),
        ...candidates.map((candidate) => ({
          scheduleCd: candidate.scheduleCd,
          subjectName: `【${candidate.semester || '秋'}】 ${candidate.courseName}`,
          conductionType: candidate.conductionType,
          employeeName: candidate.instructor,
          credit: String(candidate.credit ?? ''),
          uneditable: false,
        })),
      ];
      const ok = await page.evaluate(
        `(function(){ if (!$$('tr.${koma}').length) return 'no-row'; return _onUpdate(${JSON.stringify({ name: koma, values })}); })()`
      );
      if (ok !== true) throw new Error(`コマ ${koma} に行がありません (${ok})`);
    }
    // 取消: 対象コマから該当 scheduleCd を除いた values で _onUpdate
    for (const cd of options.cancel) {
      const rows = rowsBefore.filter((row) => row.scheduleCd === cd);
      if (rows.length === 0) {
        console.warn(`cancel 対象 ${cd} は現在登録されていません`);
        continue;
      }
      for (const row of rows) {
        const remain = (await readRows(page)).filter((r) => r.koma === row.koma && r.scheduleCd !== cd);
        const values = remain.map((r) => ({ scheduleCd: r.scheduleCd, subjectName: r.subjectName, conductionType: '', employeeName: '', credit: r.credit, uneditable: r.uneditable }));
        await page.evaluate(`_onUpdate(${JSON.stringify({ name: row.koma, values })})`);
      }
    }

    if (skippedByCap.length > 0) {
      console.warn(`上限 ${options.maxCredits} 単位を超えるため飛ばしました: ${skippedByCap.join(' / ')}`);
    }
    const rowsAfter = await readRows(page);
    const after = new Set(rowsAfter.map((row) => row.scheduleCd));
    const add = [...after].filter((cd) => !registered.has(cd));
    const cancel = [...registered].filter((cd) => !after.has(cd));

    await fs.mkdir(paths.artifactDir, { recursive: true });
    const screenshotPath = path.join(paths.artifactDir, options.exec ? 'register-before-submit.png' : 'register-dry-run.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const result: RegisterResult = {
      executed: false,
      status: 'dry-run',
      add,
      cancel,
      rowsBefore,
      rowsAfter,
      messages: [],
      rowErrors: [],
      screenshotPath,
    };
    if (!options.exec) return result;
    if (add.length === 0 && cancel.length === 0) {
      result.messages.push('変更がないため送信しませんでした。');
      return result;
    }

    // 送信先は画面の form.action から取る（正規登録は Usin070321、追加登録は別アクションの可能性がある）
    const formAction = ((await page.evaluate("(document.forms[0] && document.forms[0].action) || ''")) as string).split(';')[0];
    const actionPath = formAction ? formAction.replace(/^https?:\/\/[^/]+/, '') : '/in/f07/Usin070321';
    console.log(`送信先: ${actionPath}`);
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes(actionPath) && response.request().method() === 'POST',
      { timeout: 60_000 }
    );
    await page.click('input[value="登録実行"]');
    const response = await responsePromise;
    const xjson = response.headers()['x-json'] ?? '';
    await page.waitForTimeout(2_000);
    const status: RegisterResult['status'] = /"status"\s*:\s*"success"/.test(xjson)
      ? 'success'
      : /"status"\s*:\s*"error"/.test(xjson)
        ? 'error'
        : 'unknown';
    result.executed = true;
    result.status = status;
    if (status === 'error') {
      const errors = (await page.evaluate(readErrorsScript)) as Pick<RegisterResult, 'messages' | 'rowErrors'>;
      result.messages = errors.messages;
      result.rowErrors = errors.rowErrors;
    } else {
      const text = ((await page.evaluate('document.body.innerText')) as string).replace(/\s+/g, ' ').trim();
      result.messages = [text.slice(0, 200)];
    }
    result.screenshotPath = path.join(paths.artifactDir, `register-result-${status}.png`);
    await page.screenshot({ path: result.screenshotPath, fullPage: true });
    await fs.writeFile(path.join(paths.artifactDir, 'register-result.json'), `${JSON.stringify({ ...result, dialogs, xjson }, null, 2)}\n`, 'utf8');
    return result;
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.file) options.add.push(...(await readPlanFile(options.file)));
  const result = await registerCourses(options);

  const label = (cd: string) => {
    const row = result.rowsAfter.find((r) => r.scheduleCd === cd) ?? result.rowsBefore.find((r) => r.scheduleCd === cd);
    return row ? `${cd} ${row.subjectName} (${row.credit})` : cd;
  };
  console.log(`現在の登録: ${result.rowsBefore.length} 件`);
  for (const row of result.rowsBefore) console.log(`  = ${row.koma} ${row.scheduleCd} ${row.subjectName} ${row.credit}`);
  console.log(`追加 ${result.add.length} 件 / 取消 ${result.cancel.length} 件`);
  for (const cd of result.add) console.log(`  + ${label(cd)}`);
  for (const cd of result.cancel) console.log(`  - ${label(cd)}`);
  const total = result.rowsAfter.reduce((sum, row) => sum + (Number(row.credit) || 0), 0);
  console.log(`送信後の想定単位数: ${total}`);
  if (result.screenshotPath) console.log(`スクリーンショット: ${result.screenshotPath}`);
  if (!result.executed) {
    console.log(result.status === 'dry-run' ? 'dry-run: 送信していません（--exec で送信）' : result.messages.join('\n'));
    return;
  }
  console.log(`結果: ${result.status}`);
  for (const message of result.messages) console.log(`  ${message}`);
  for (const error of result.rowErrors) console.log(`  [${error.type || '-'}] ${error.subjectName} (${error.scheduleCd}): ${error.message}`);
  if (result.status === 'success') {
    console.log('履修登録確認表を更新するには: npm run toyo:export-enrollment');
    console.log('注意: 定員超過の科目は抽選になり、この時点では確定ではありません。抽選結果発表後に npm run toyo:lottery で当落を確認してください。');
  } else {
    process.exitCode = 2;
  }
}
