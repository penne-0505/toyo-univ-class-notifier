import fs from 'node:fs/promises';
import path from 'node:path';
import { jsonOutputPath, type EnrollmentData } from './toyo-enrollment';
import { fetchAcademicCalendar, calendarOutputPath } from './toyo-academic-calendar';

async function readAcademicYear(): Promise<string> {
  try {
    const raw = await fs.readFile(jsonOutputPath, 'utf8');
    const data = JSON.parse(raw) as EnrollmentData;
    if (data.academicYear) return data.academicYear;
  } catch {
    // fall through
  }
  return String(new Date().getFullYear());
}

export async function main(): Promise<void> {
  const academicYear = await readAcademicYear();
  console.log(`Fetching academic calendar for ${academicYear}...`);

  const result = await fetchAcademicCalendar(academicYear);

  if (result.errors.length > 0) {
    console.error('Errors:');
    for (const error of result.errors) {
      console.error(` - ${error}`);
    }
  }

  console.log(`National holidays fetched: ${result.nationalHolidays.length}`);
  console.log(`Calendar output: ${calendarOutputPath}`);

  if (!result.available) {
    process.exit(1);
  }
}
