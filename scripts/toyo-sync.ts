#!/usr/bin/env node

import {
  ensureEnrollmentOutputDirs,
  scrapeEnrollmentData,
  writeEnrollmentArtifacts,
} from './lib/toyo-enrollment';
import { buildDiscordSummary, discordSummaryOutputPath, writeDiscordSummary } from './lib/toyo-summary';

export async function main(): Promise<void> {
  await ensureEnrollmentOutputDirs();

  const enrollment = await scrapeEnrollmentData();
  await writeEnrollmentArtifacts(enrollment);

  const summary = await buildDiscordSummary(enrollment);
  await writeDiscordSummary(summary);

  console.log(`Enrollment artifacts refreshed.`);
  console.log(`Discord summary: ${discordSummaryOutputPath}`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
