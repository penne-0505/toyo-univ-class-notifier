import { createHash } from 'node:crypto';

/**
 * 差分判定用の正規化。取得時刻だけが変わったファイルを「変化なし」と見なすために、
 * 時刻メタデータを取り除いたうえでハッシュを取る。
 * 注意: `updatedAt` / `postedAt` / `dueAt` などは本物のデータなので除外しない。
 */

// health.json の lastRunAt / lastSuccessAt も毎回変わるだけの時刻（変化検知から外す）
const TIME_KEY_PATTERN = /^(?:\w*(?:fetched|generated|built|saved|checked|published)At\w*|last(?:run|success)At|ageMinutes)$/i;

/** 時刻キー（fetchedAt / builtAt など）を再帰的に取り除き、キー順を揃えた JSON 値を返す。 */
export function stripTimeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripTimeKeys);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (TIME_KEY_PATTERN.test(key)) continue;
      out[key] = stripTimeKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const TEXT_TIME_VALUE =
  /(\w*(?:fetched|generated|built|saved|checked|published)At\w*|ageMinutes)(["']?\s*[:=]\s*)("[^"]*"|[^\s,;}<]+)/gi;
const TEXT_TIME_LINE = /^\s*(?:[-*]\s*)?(?:取得日時|取得時刻|生成日時)\s*[:：]/;

export function normalizeText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !TEXT_TIME_LINE.test(line))
    .map((line) => line.replace(TEXT_TIME_VALUE, '$1$2<t>'))
    .join('\n');
}

export function normalizeContent(fileName: string, content: Buffer): string {
  const text = content.toString('utf8');
  if (fileName.endsWith('.json')) {
    try {
      return JSON.stringify(stripTimeKeys(JSON.parse(text)));
    } catch {
      return normalizeText(text);
    }
  }
  return normalizeText(text);
}

export function normalizedHash(fileName: string, content: Buffer): string {
  return createHash('sha256').update(normalizeContent(fileName, content)).digest('hex');
}

/** 本体に埋まっている取得時刻を返す（無ければ null）。 */
export function extractFetchedAt(fileName: string, content: Buffer): string | null {
  const text = content.toString('utf8');
  if (fileName.endsWith('.json')) {
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      for (const key of ['fetchedAt', 'generatedAt', 'builtAt', 'savedAt']) {
        const v = data?.[key];
        if (typeof v === 'string') return v;
      }
      const meta = data?.meta as Record<string, unknown> | undefined;
      if (typeof meta?.fetchedAt === 'string') return meta.fetchedAt;
    } catch {
      /* fall through */
    }
    return null;
  }
  const match =
    text.match(/(?:取得日時|取得時刻|生成日時)\s*[:：]\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/) ??
    text.match(/(?:builtAt|generatedAt|fetchedAt)\s*[:=]\s*"?(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
  if (match) return match[1];
  const html = text.match(/"fetchedAt"\s*:\s*"(\d{4}-\d{2}-\d{2}T[\d:.]+Z)"/);
  return html ? html[1] : null;
}

export function formatJst(date: Date = new Date()): string {
  const shifted = new Date(date.getTime() + 9 * 3600_000);
  return shifted.toISOString().slice(0, 19).replace('T', ' ');
}
