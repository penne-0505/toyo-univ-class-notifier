#!/usr/bin/env node

import {
  ensureEnrollmentOutputDirs,
  scrapeEnrollmentData,
  writeEnrollmentArtifacts,
} from './lib/toyo-enrollment';
import { buildDiscordSummary, discordSummaryOutputPath, writeDiscordSummary } from './lib/toyo-summary';
import { fetchAcademicCalendar } from './lib/toyo-academic-calendar';

export async function main(): Promise<void> {
  await ensureEnrollmentOutputDirs();

  const enrollment = await scrapeEnrollmentData();
  await writeEnrollmentArtifacts(enrollment);

  // Calendar is fetched in parallel with the summary build to save time
  const [summary] = await Promise.all([
    buildDiscordSummary(enrollment),
    fetchAcademicCalendar(enrollment.academicYear).catch((error: unknown) => {
      console.warn(
        `Calendar fetch failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`
      );
    }),
  ]);

  await writeDiscordSummary(summary);

  if (enrollment.fetchStatus === 'error') {
    console.warn(`Portal fetch status: ${enrollment.fetchStatus} (pageTitle: ${enrollment.pageTitle})`);
  }
  console.log(`Enrollment status: ${enrollment.fetchStatus}`);
  console.log(`Enrollment artifacts refreshed.`);
  console.log(`Discord summary: ${discordSummaryOutputPath}`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
