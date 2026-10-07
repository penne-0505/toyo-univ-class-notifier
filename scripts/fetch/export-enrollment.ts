import {
  ensureEnrollmentOutputDirs,
  jsonOutputPath,
  markdownOutputPath,
  scrapeEnrollmentData,
  writeEnrollmentArtifacts,
} from './toyo-enrollment';

export async function main(): Promise<void> {
  await ensureEnrollmentOutputDirs();
  const data = await scrapeEnrollmentData();
  await writeEnrollmentArtifacts(data);

  console.log(`Enrollment data: ${jsonOutputPath}`);
  console.log(`Markdown summary: ${markdownOutputPath}`);
}
