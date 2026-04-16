#!/usr/bin/env node

import {
  ensureEnrollmentOutputDirs,
  jsonOutputPath,
  markdownOutputPath,
  runPythonWorkbookBuilder,
  scrapeEnrollmentData,
  workbookOutputPath,
  writeEnrollmentArtifacts,
} from './lib/toyo-enrollment';

export async function main(): Promise<void> {
  await ensureEnrollmentOutputDirs();
  const data = await scrapeEnrollmentData();
  await writeEnrollmentArtifacts(data);
  await runPythonWorkbookBuilder();

  console.log(`Enrollment data: ${jsonOutputPath}`);
  console.log(`Markdown summary: ${markdownOutputPath}`);
  console.log(`Spreadsheet timetable: ${workbookOutputPath}`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
