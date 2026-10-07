import path from 'node:path';

/**
 * リポジトリ内の主要ディレクトリ。playwright などの重い依存を持たないので、
 * 組み立て層（scripts/build/）からも安全に import できる。
 */
export const repoRoot = path.resolve(__dirname, '..', '..');
export const outputDir = path.join(repoRoot, 'output', 'toyo');
export const dataDir = path.join(repoRoot, 'data');
export const registrationDataPath = path.join(outputDir, 'registration-data.json');
