import fs from 'node:fs';
import path from 'node:path';

/** リポジトリのルート（scripts/lib/ の 2 つ上）。 */
export const repoRoot = path.resolve(__dirname, '..', '..');

let loaded = false;

/**
 * `.env.local` → `.env` の順に読み込み、未設定の環境変数だけを埋める（既存の環境変数が優先）。
 * playwright などの重い依存を持たないので、health / notify のような軽い CLI からも使える。
 */
export function loadProjectEnv(): void {
  if (loaded) return;
  loaded = true;

  for (const fileName of ['.env.local', '.env']) {
    const filePath = path.join(repoRoot, fileName);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const separatorIndex = line.indexOf('=');
      if (separatorIndex <= 0) continue;

      const key = line.slice(0, separatorIndex).trim();
      if (!key || process.env[key] !== undefined) continue;

      let value = line.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  }
}
