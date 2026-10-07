import fs from 'node:fs/promises';
import path from 'node:path';
import { outputDir } from './toyo-enrollment';

export type NationalHoliday = {
  date: string; // YYYY-MM-DD
  name: string;
};

export type AcademicCalendarResult = {
  fetchedAt: string;
  available: boolean;
  academicYear: string;
  nationalHolidays: NationalHoliday[];
  errors: string[];
};

const nationalHolidaysUrl = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
export const calendarOutputPath = path.join(outputDir, 'academic-calendar.json');

function parseHolidaysCsv(text: string): NationalHoliday[] {
  const lines = text.split(/\r?\n/).slice(1);
  const holidays: NationalHoliday[] = [];
  for (const line of lines) {
    const commaIndex = line.indexOf(',');
    if (commaIndex < 0) continue;
    const dateRaw = line.slice(0, commaIndex).trim();
    const name = line.slice(commaIndex + 1).trim();
    if (!dateRaw || !name) continue;
    // format: YYYY/M/D
    const parts = dateRaw.split('/');
    if (parts.length !== 3) continue;
    const [y, m, d] = parts.map(Number);
    if (!y || !m || !d) continue;
    holidays.push({
      date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      name,
    });
  }
  return holidays;
}

export function isNationalHoliday(holidays: NationalHoliday[], dateStr: string): NationalHoliday | null {
  return holidays.find((h) => h.date === dateStr) ?? null;
}

export async function fetchAcademicCalendar(academicYear: string): Promise<AcademicCalendarResult> {
  const fetchedAt = new Date().toISOString();
  const errors: string[] = [];
  let nationalHolidays: NationalHoliday[] = [];

  try {
    const response = await fetch(nationalHolidaysUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    let text: string;
    try {
      text = new TextDecoder('shift-jis').decode(buffer);
    } catch {
      text = new TextDecoder('utf-8').decode(buffer);
    }
    nationalHolidays = parseHolidaysCsv(text);
    if (nationalHolidays.length === 0) {
      errors.push('National holidays CSV was empty or could not be parsed.');
    }
  } catch (error: unknown) {
    errors.push(
      `Failed to fetch national holidays: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const result: AcademicCalendarResult = {
    fetchedAt,
    available: errors.length === 0,
    academicYear,
    nationalHolidays,
    errors,
  };

  await fs.mkdir(path.dirname(calendarOutputPath), { recursive: true });
  await fs.writeFile(calendarOutputPath, JSON.stringify(result, null, 2), 'utf8');
  return result;
}

export async function readAcademicCalendar(): Promise<AcademicCalendarResult | null> {
  try {
    const raw = await fs.readFile(calendarOutputPath, 'utf8');
    return JSON.parse(raw) as AcademicCalendarResult;
  } catch {
    return null;
  }
}
