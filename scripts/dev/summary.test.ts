/**
 * buildSummary（純粋関数）の科目の突き合わせと、入力が欠けたときの振る舞いの検査。
 * Usage: npx tsx --test scripts/dev/summary.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCourseIndex } from '../build/course-index';
import { buildSummary, type SummaryInputs } from '../build/summary';

const schedule = {
  academicYear: '2026',
  source: 'test',
  periods: [],
  terms: [{ semester: '秋学期', classesStart: '2026-09-21', classesEnd: '2027-01-30', examPeriod: null, noClassDays: [], makeupDays: [] }],
};

const course = (courseCode: string, courseName: string, day: string, period: string) => ({
  semesterLabel: '秋学期',
  day,
  period,
  term: '',
  courseCode,
  numbering: '',
  courseName,
  deliveryMode: '対面',
  instructor: '先生',
  room: '101',
  campus: '白山',
  credits: 2,
});

const syllabus = (courseCode: string) => ({
  fetchedAt: '2026-10-01T00:00:00Z',
  academicYear: '2026',
  sourceUrl: 'https://example.test',
  courseName: courseCode,
  instructor: '',
  courseCode,
  classFormat: '',
  conductionType: '',
  timetable: '',
  classroom: '',
  learningGoals: '',
  lectureSchedule: '第1回 ガイダンス 第2回 本論',
  instructionMethod: '',
  preAndPostStudy: '',
  grading: '期末試験 100%',
  textbook: '',
});

const ace = (courseId: string, name: string, courseCode: string | null = null) => ({
  courseId,
  courseName: name,
  aceListName: name,
  courseCode,
  aceCourseCodes: [],
  portalCourseName: null,
  fetchedAt: '2026-10-08T00:00:00Z',
  items: [],
  grades: [],
  counts: { submitted: 0, notSubmittedOpen: 0, closedNotSubmitted: 0, waiting: 0 },
});

const assignment = (assignmentId: string, courseName: string, title: string) => ({
  assignmentId,
  courseName,
  title,
  dueAt: '2026-10-20T23:59:00+09:00',
  status: 'pending',
  sourceUrl: null,
  notes: [],
});

const announcement = (announcementId: string, courseNameHint: string | null, title: string) => ({
  announcementId,
  category: 'その他',
  courseNameHint,
  title,
  postedAt: null,
  targetDate: null,
  content: '',
  sourceUrl: `https://www.ace.toyo.ac.jp/ct/home_library_reminder_detail_${announcementId}`,
});

function inputs(overrides: Partial<SummaryInputs> = {}): SummaryInputs {
  return {
    registration: {
      fetchStatus: 'success',
      fetchedAt: '2026-10-08T00:00:00Z',
      sourceUrl: '',
      pageTitle: '',
      studentNumber: '',
      studentNameKana: '',
      studentName: '',
      academicYear: '2026',
      courses: [
        course('2010102002', '哲学Ｂ２', '水', '7'),
        course('2310017001', '会計学', '水', '6'),
        course('2310126001', '組織行動論', '木', '6'),
      ],
    },
    assignments: {
      fetchedAt: '2026-10-08T00:00:00Z',
      source: 'toyonet-ace',
      available: true,
      assignments: [
        assignment('course_1_query_1', '哲学B2', '第2回 小テスト'), // 名前の全角半角違い + courseId
        assignment('course_9_report_5', '【2026】経営学部第2部', '手続きの案内'), // 履修外（科目不明）
        assignment('x', '会計学', '第1回'), // courseId なし。名前で一致
      ],
      errors: [],
    },
    contents: {
      fetchedAt: '2026-10-08T00:00:00Z',
      source: 'toyonet-ace',
      available: true,
      contents: [],
      errors: [],
    },
    announcements: {
      fetchedAt: '2026-10-08T00:00:00Z',
      source: 'toyonet-ace',
      available: true,
      announcements: [
        announcement('a1', '哲学B2', '第２回授業資料追加'),
        announcement('a2', null, '会計学 2回目の補足'), // hint なし: タイトルに科目名が丸ごと含まれる
        announcement('a3', null, '会計の基礎について'), // 先頭 4 文字が似ているだけ。一致させない
      ],
      errors: [],
    },
    coursework: {
      fetchedAt: '2026-10-08T00:00:00Z',
      source: 'toyonet-ace',
      available: true,
      courses: [ace('1', '哲学B2'), ace('2', '会計学')],
      submissions: [],
      errors: [],
    },
    academicCalendar: null,
    syllabi: { '2010102002': syllabus('2010102002'), '2310017001': syllabus('2310017001') },
    academicSchedule: schedule,
    ...overrides,
  } as unknown as SummaryInputs;
}

const wednesdayNoon = new Date('2026-10-07T12:00:00+09:00');
const thursdayNoon = new Date('2026-10-08T12:00:00+09:00');

function build(overrides: Partial<SummaryInputs> = {}, now = wednesdayNoon) {
  const base = inputs(overrides);
  const index = buildCourseIndex(
    {
      registration: base.registration as never,
      coursework: base.coursework as never,
      candidates: [],
      syllabusFiles: Object.keys(base.syllabi).map((code) => `${code}.json`),
      gradingRules: null,
      academicSchedule: base.academicSchedule,
    },
    now
  );
  return buildSummary(base, index, now);
}

describe('buildSummary: 科目の突き合わせ（index 経由）', () => {
  const summary = build();
  const todayByCode = (code: string) => summary.todayClasses.find((c) => c.classInfo.courseCode === code)!;

  it('ACE の表記（全角半角が違う）でも courseId / 科目名のキーで授業コードに引ける', () => {
    assert.deepEqual(todayByCode('2010102002').relatedAssignments.map((a) => a.assignmentId), ['course_1_query_1']);
    assert.deepEqual(todayByCode('2010102002').relatedAnnouncements.map((a) => a.announcementId), ['a1']);
    assert.deepEqual(todayByCode('2310017001').relatedAssignments.map((a) => a.assignmentId), ['x']);
  });

  it('hint が無いお知らせは、タイトルに科目名のキーが丸ごと含まれるときだけ引く（部分一致の推測はしない）', () => {
    assert.deepEqual(todayByCode('2310017001').relatedAnnouncements.map((a) => a.announcementId), ['a2']);
    const byId = new Map(summary.announcements.map((a) => [a.announcementId, a.courseCode]));
    assert.equal(byId.get('a3'), null);
  });

  it('引けないものは落とさず courseCode: null（科目不明）で一覧に残す', () => {
    assert.equal(summary.upcomingAssignments.length, 3);
    const unknown = summary.upcomingAssignments.find((a) => a.assignmentId === 'course_9_report_5')!;
    assert.equal(unknown.courseCode, null);
    assert.equal(summary.upcomingAssignments.find((a) => a.assignmentId === 'course_1_query_1')!.courseCode, '2010102002');
  });

  it('coursework は index の aceCourseId で結びつく', () => {
    assert.equal(todayByCode('2010102002').coursework?.courseId, '1');
    assert.equal(summary.upcomingAssignments.find((a) => a.assignmentId === 'course_1_query_1')!.coursework?.courseId, '1');
  });
});

describe('buildSummary: 欠けた入力', () => {
  it('入力がすべて null でも落ちず、sourceStatus と errors で表す', () => {
    const summary = build(
      { registration: null, assignments: null, contents: null, announcements: null, coursework: null, academicCalendar: null, syllabi: {}, academicSchedule: null },
      thursdayNoon
    );
    assert.deepEqual(summary.todayClasses, []);
    assert.equal(summary.sourceStatus.portal.available, false);
    assert.equal(summary.sourceStatus.toyonetAce.available, false);
    assert.equal(summary.errors.length, 4);
  });

  it('シラバスのキャッシュが無い科目は syllabus: null とその授業のエラーで表す（取りに行かない）', () => {
    const summary = build({ syllabi: {} });
    const today = summary.todayClasses.find((c) => c.classInfo.courseCode === '2010102002')!;
    assert.equal(today.syllabus, null);
    assert.equal(today.errors.length, 1);
  });

  it('ACE の取得結果が available: false ならそのまま sourceStatus に出る', () => {
    const base = inputs();
    const summary = build({ assignments: { ...base.assignments!, available: false, assignments: [], errors: ['boom'] } });
    assert.equal(summary.sourceStatus.toyonetAce.available, false);
    assert.ok(summary.errors.includes('boom'));
  });
});
