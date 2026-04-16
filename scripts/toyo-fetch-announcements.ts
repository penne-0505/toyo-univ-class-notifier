#!/usr/bin/env node

import fs from 'node:fs/promises';
import { jsonOutputPath, type EnrollmentData } from './lib/toyo-enrollment';
import {
  collectToyoNetAceAnnouncements,
  announcementsOutputPath,
} from './lib/toyo-announcements';

async function readCourseNames(): Promise<string[]> {
  try {
    const raw = await fs.readFile(jsonOutputPath, 'utf8');
    const data = JSON.parse(raw) as EnrollmentData;
    return data.courses.map((c) => c.courseName);
  } catch {
    return [];
  }
}

export async function main(): Promise<void> {
  const courseNames = await readCourseNames();
  console.log(`Collecting ACE announcements (${courseNames.length} registered courses)...`);

  const result = await collectToyoNetAceAnnouncements(courseNames);

  if (result.errors.length > 0) {
    console.error('Errors:');
    for (const error of result.errors) {
      console.error(` - ${error}`);
    }
  }

  console.log(`Announcements collected: ${result.announcements.length}`);
  for (const a of result.announcements) {
    console.log(` [${a.category}] ${a.title}${a.targetDate ? ` (${a.targetDate})` : ''}`);
  }
  console.log(`Announcements output: ${announcementsOutputPath}`);

  if (!result.available) {
    process.exit(1);
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
