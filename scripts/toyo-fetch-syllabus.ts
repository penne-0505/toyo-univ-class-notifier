#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type Course,
  type EnrollmentData,
  jsonOutputPath,
  outputDir,
} from './lib/toyo-enrollment';
import { fetchSyllabus, type SyllabusRecord } from './lib/toyo-syllabus';

const syllabusOutputDir = path.join(outputDir, 'syllabus');

type CliOptions = {
  courseCode: string | null;
  courseName: string | null;
  list: boolean;
};

function usage(): string {
  return [
    'Usage:',
    '  npm run toyo:syllabus -- --course-code <授業コード>',
    '  npm run toyo:syllabus -- --course-name <科目名>',
    '  npm run toyo:syllabus -- <授業コードまたは科目名>',
    '  npm run toyo:syllabus -- --list',
    '',
    'Examples:',
    '  npm run toyo:syllabus -- --course-code 2D10343001',
    '  npm run toyo:syllabus -- 自然災害と防災',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    courseCode: null,
    courseName: null,
    list: false,
  };
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--list') {
      options.list = true;
      continue;
    }
    if (arg === '--course-code') {
      options.courseCode = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg === '--course-name') {
      options.courseName = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
    positional.push(arg);
  }

  if (!options.courseCode && !options.courseName && positional.length > 0) {
    const query = positional.join(' ').trim();
    if (/^[0-9A-Za-z]+$/.test(query)) {
      options.courseCode = query;
    } else {
      options.courseName = query;
    }
  }

  return options;
}

async function readEnrollmentData(): Promise<EnrollmentData> {
  const raw = await fs.readFile(jsonOutputPath, 'utf8');
  return JSON.parse(raw) as EnrollmentData;
}

function printCourseList(courses: Course[]): void {
  if (courses.length === 0) {
    console.log('No courses were found in registration-data.json.');
    return;
  }

  for (const course of courses) {
    console.log(
      [
        course.courseCode,
        course.courseName,
        `${course.day}${course.period}`,
        course.instructor,
      ]
        .filter(Boolean)
        .join('\t')
    );
  }
}

function findCourse(courses: Course[], options: CliOptions): Course {
  const matches = courses.filter((course) => {
    if (options.courseCode && course.courseCode === options.courseCode) {
      return true;
    }
    if (options.courseName && course.courseName.includes(options.courseName)) {
      return true;
    }
    return false;
  });

  if (matches.length === 0) {
    throw new Error(
      [
        'No matching course was found in registration-data.json.',
        options.courseCode ? `courseCode: ${options.courseCode}` : null,
        options.courseName ? `courseName: ${options.courseName}` : null,
        '',
        'Run this to inspect available courses:',
        '  npm run toyo:syllabus -- --list',
      ]
        .filter((line): line is string => line !== null)
        .join('\n')
    );
  }

  if (matches.length > 1) {
    const candidates = matches
      .map(
        (course) =>
          `- ${course.courseCode} ${course.courseName} ${course.day}${course.period} ${course.instructor}`
      )
      .join('\n');
    throw new Error(
      [
        'Multiple courses matched. Specify --course-code.',
        '',
        candidates,
      ].join('\n')
    );
  }

  return matches[0]!;
}

function safeFileStem(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function buildSyllabusMarkdown(course: Course, record: SyllabusRecord): string {
  const lines = [
    `# ${record.courseName || course.courseName}`,
    '',
    `- 取得日時: ${record.fetchedAt}`,
    `- 授業コード: ${record.courseCode || course.courseCode}`,
    `- 担当者: ${record.instructor || course.instructor}`,
    `- 時間割: ${record.timetable}`,
    `- 教室: ${record.classroom || course.room}`,
    `- 授業形態: ${record.classFormat}`,
    `- 実施形態: ${record.conductionType || course.deliveryMode}`,
    `- 参照元: ${record.sourceUrl}`,
    '',
    '## 学修到達目標',
    record.learningGoals || '(空)',
    '',
    '## 講義スケジュール',
    record.lectureSchedule || '(空)',
    '',
    '## 指導方法',
    record.instructionMethod || '(空)',
    '',
    '## 事前・事後学修',
    record.preAndPostStudy || '(空)',
    '',
    '## 成績評価',
    record.grading || '(空)',
    '',
    '## テキスト',
    record.textbook || '(空)',
  ];

  return `${lines.join('\n')}\n`;
}

export async function writeSyllabusArtifacts(
  course: Course,
  record: SyllabusRecord
): Promise<{ jsonPath: string; markdownPath: string }> {
  await fs.mkdir(syllabusOutputDir, { recursive: true });
  const stem = safeFileStem(record.courseCode || course.courseCode || course.courseName);
  const jsonPath = path.join(syllabusOutputDir, `${stem}.json`);
  const markdownPath = path.join(syllabusOutputDir, `${stem}.md`);

  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        fetchedAt: record.fetchedAt,
        inputCourse: course,
        syllabus: record,
      },
      null,
      2
    ),
    'utf8'
  );
  await fs.writeFile(markdownPath, buildSyllabusMarkdown(course, record), 'utf8');

  return { jsonPath, markdownPath };
}

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const enrollment = await readEnrollmentData();

  if (options.list) {
    printCourseList(enrollment.courses);
    return;
  }

  if (!options.courseCode && !options.courseName) {
    throw new Error(`A course code or course name is required.\n\n${usage()}`);
  }

  if (enrollment.pageTitle.includes('システムエラー')) {
    throw new Error(
      [
        'registration-data.json was generated from a system error page.',
        'Refresh the session and enrollment data before fetching a syllabus:',
        '  npm run toyo:login',
        '  npm run toyo:export-enrollment',
      ].join('\n')
    );
  }

  const course = findCourse(enrollment.courses, options);
  const record = await fetchSyllabus({
    ...course,
    academicYear: enrollment.academicYear,
  });
  const { jsonPath, markdownPath } = await writeSyllabusArtifacts(course, record);

  console.log(`Syllabus JSON: ${jsonPath}`);
  console.log(`Syllabus Markdown: ${markdownPath}`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
