#!/usr/bin/env node

import {
  ensureEnrollmentOutputDirs,
  jsonOutputPath,
  markdownOutputPath,
  scrapeEnrollmentData,
  writeEnrollmentArtifacts,
} from './lib/toyo-enrollment';

export async function main(): Promise<void> {
  await ensureEnrollmentOutputDirs();
  const data = await scrapeEnrollmentData();
  await writeEnrollmentArtifacts(data);

  console.log(`Enrollment data: ${jsonOutputPath}`);
  console.log(`Markdown summary: ${markdownOutputPath}`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
