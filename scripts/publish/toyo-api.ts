import { loadProjectEnv } from '../lib/toyo-env';

/**
 * Worker（toyo-data-api）への書き込み用の共通ヘルパー。
 * publish/publish.ts と lib/toyo-health.ts が使う。TOYO_API_URL / TOYO_API_WRITE_KEY が無ければ何もしない。
 */

export type ApiConfig = { baseUrl: string; key: string };

export function apiConfig(): ApiConfig | null {
  loadProjectEnv();
  const baseUrl = process.env.TOYO_API_URL?.trim().replace(/\/+$/, '');
  const key = process.env.TOYO_API_WRITE_KEY?.trim();
  if (!baseUrl || !key) return null;
  return { baseUrl, key };
}

export function contentTypeOf(rel: string): string {
  if (rel.endsWith('.json')) return 'application/json; charset=utf-8';
  if (rel.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (rel.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

export function apiFileUrl(baseUrl: string, rel: string): string {
  return `${baseUrl}/v1/files/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/** 失敗（HTTP エラー・タイムアウト）は例外を投げる。 */
export async function apiRequest(
  config: ApiConfig,
  method: string,
  url: string,
  body?: Buffer,
  contentType?: string,
  timeoutMs = 60_000
): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${config.key}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
    body: body as unknown as BodyInit | undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
}

/** 1 ファイルを PUT する。未設定・失敗のときは false（例外は投げない）。 */
export async function putFileToApi(rel: string, body: Buffer, timeoutMs = 15_000): Promise<boolean> {
  const config = apiConfig();
  if (!config) return false;
  try {
    await apiRequest(config, 'PUT', apiFileUrl(config.baseUrl, rel), body, contentTypeOf(rel), timeoutMs);
    return true;
  } catch {
    return false;
  }
}
