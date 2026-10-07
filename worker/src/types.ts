// scripts/build/summary.ts などの型を Worker 側にコピーしたもの。scripts 側は import しない。
// 元の型を変えたらここも追従すること（Worker は JSON をそのまま返すだけなので、ズレても壊れはしない）。

export type AssignmentStatus = 'pending' | 'submitted' | 'unknown';

export type Assignment = {
  assignmentId: string;
  courseName: string;
  title: string;
  dueAt: string | null;
  status: AssignmentStatus;
  sourceUrl: string | null;
  notes: string[];
  /** summary の全体一覧にだけ付く（scripts/build/summary.ts が course-index で引いた授業コード。引けなければ null = 科目不明）。 */
  courseCode?: string | null;
};

export type ContentResourceLink = { text: string; url: string };

export type CourseContent = {
  contentId: string;
  courseName: string;
  courseUrl: string;
  contentListUrl: string;
  title: string;
  contentUrl: string;
  listedAt: string | null;
  updatedAt: string | null;
  openFrom: string | null;
  openUntil: string | null;
  resourceLinks: ContentResourceLink[];
  /** summary の全体一覧にだけ付く（scripts/build/summary.ts が course-index で引いた授業コード。引けなければ null = 科目不明）。 */
  courseCode?: string | null;
};

export type AnnouncementCategory = '休講' | '補講' | '教室変更' | 'その他';

export type Announcement = {
  announcementId: string;
  category: AnnouncementCategory;
  courseNameHint: string | null;
  title: string;
  postedAt: string | null;
  targetDate: string | null;
  content: string;
  sourceUrl: string;
  /** summary の全体一覧にだけ付く（scripts/build/summary.ts が course-index で引いた授業コード。引けなければ null = 科目不明）。 */
  courseCode?: string | null;
};

export type CourseSummary = {
  courseName: string;
  courseCode: string;
  instructor: string;
  room: string;
  campus: string;
  day: string;
  period: string;
  deliveryMode: string;
  startsAt: string;
  endsAt: string;
  startsAtEpochMs: number;
  endsAtEpochMs: number;
};

export type NextClassNotes = {
  checkedAt: string | null;
  firstTopic: string | null;
  syllabusPoints: string[];
};

export type DetailedClassNotes = {
  sourceUrl: string;
  classFormat: string;
  conductionType: string;
  timetable: string;
  classroom: string;
  learningGoals: string;
  lectureSchedule: string;
  instructionMethod: string;
  preAndPostStudy: string;
  grading: string;
  textbook: string;
  firstTopic: string | null;
};

export type CourseworkBrief = {
  courseId: string;
  submitted: number;
  notSubmitted: number;
  notSubmittedOpen: number;
  closedNotSubmitted: number;
  waiting: number;
  submittedByType?: { report: number; query: number };
  nextOpensAt: string | null;
  fetchedAt: string;
};

export type DetailedClassSummary = {
  classInfo: CourseSummary;
  sessionNumber: number | null;
  coursework?: CourseworkBrief | null;
  syllabus: DetailedClassNotes | null;
  relatedAssignments: Assignment[];
  relatedContents: CourseContent[];
  relatedAnnouncements: Announcement[];
  errors: string[];
};

export type CourseworkItemType = 'report' | 'query' | 'survey';
export type CourseworkStatus = 'open' | 'waiting' | 'closed' | 'unknown';

export type CourseworkItem = {
  itemId: string;
  type: CourseworkItemType;
  title: string;
  url: string;
  status: CourseworkStatus;
  submitted: boolean | null;
  opensAt: string | null;
  dueAt: string | null;
  raw: string;
};

export type CourseworkCourse = {
  courseId: string;
  courseName: string;
  aceListName: string | null;
  courseCode: string | null;
  aceCourseCodes: string[];
  portalCourseName: string | null;
  fetchedAt: string;
  items: CourseworkItem[];
  grades: Array<{ title: string; score: string | null; note: string | null }>;
  counts: { submitted: number; notSubmittedOpen: number; closedNotSubmitted: number; waiting: number };
};

export type CourseworkSubmission = {
  courseId: string;
  type: string;
  itemId: string | null;
  title: string;
  courseName: string | null;
  submittedAt: string | null;
};

export type CourseworkFile = {
  fetchedAt: string;
  available: boolean;
  courses: CourseworkCourse[];
  submissions: CourseworkSubmission[];
  errors: string[];
};

export type CourseworkScheduleEntry = {
  courseId: string;
  courseName: string;
  courseCode: string | null;
  portalCourseName: string | null;
  type: CourseworkItemType;
  itemId: string;
  title: string;
  url: string;
  status: CourseworkStatus;
  submitted: boolean | null;
  opensAt: string | null;
  dueAt: string;
};

export type RegisteredCourse = {
  semesterLabel: string;
  day: string;
  period: string;
  term: string;
  courseCode: string;
  numbering: string;
  courseName: string;
  deliveryMode: string;
  instructor: string;
  room: string;
  campus: string;
  credits: number | null;
};

export type RegistrationData = { fetchedAt: string; academicYear: string; courses: RegisteredCourse[] };

export type GradingComponent = {
  name: string;
  weightPercent: number | null;
  kind: string;
  perSession: boolean;
  scenario?: string | null;
  note: string;
};

export type GradingCutoff = { type: string; text: string; threshold: number | null; unit?: string | null };

export type GradingRule = {
  courseCode: string;
  courseName: string;
  semester: string;
  components: GradingComponent[];
  cutoffs: GradingCutoff[];
  retake: string | null;
  sourceText: string;
  reviewed: boolean;
  warnings: string[];
};

export type GradingRulesFile = { courses: GradingRule[] };

/** output/toyo/syllabus/<授業コード>.json */
export type SyllabusFile = {
  fetchedAt?: string;
  syllabus?: {
    fetchedAt?: string;
    sourceUrl?: string;
    classFormat?: string;
    conductionType?: string;
    timetable?: string;
    classroom?: string;
    learningGoals?: string;
    lectureSchedule?: string;
    instructionMethod?: string;
    preAndPostStudy?: string;
    grading?: string;
    textbook?: string;
    [key: string]: unknown;
  };
};

export type SourceStatus = {
  portal: { available: boolean; fetchStatus: string; fetchedAt: string | null; path: string };
  toyonetAce: {
    available: boolean;
    fetchedAt: string | null;
    contentsAvailable: boolean;
    contentsFetchedAt: string | null;
    announcementsAvailable: boolean;
    announcementsFetchedAt: string | null;
    courseworkAvailable?: boolean;
    courseworkFetchedAt?: string | null;
  };
};

export type Summary = {
  generatedAt: string;
  timezone: 'Asia/Tokyo';
  nextClass: CourseSummary | null;
  nextClassNotes: NextClassNotes | null;
  todayClasses: DetailedClassSummary[];
  tomorrowClasses: DetailedClassSummary[];
  upcomingAssignments: Array<Assignment & { coursework?: CourseworkBrief | null }>;
  courseworkSchedule?: CourseworkScheduleEntry[];
  /** 現行の summary.json には無いが、将来の追加に備えて任意で受ける。 */
  deadlineUnknownAssignments?: Assignment[];
  courseContents: CourseContent[];
  announcements: Announcement[];
  sourceStatus: SourceStatus;
  errors: string[];
};

/** ~/toyo-data/meta.json（scripts/publish/publish.ts が生成） */
export type PublishMeta = {
  publishedAt: string;
  files: Record<string, { fetchedAt: string | null; source: string }>;
  sourceStatus: SourceStatus | null;
  /** toyo:health が書く定期ジョブの状態（output/toyo/health.json の内容）。古い meta には無い。 */
  health?: HealthSnapshot | null;
};

/** output/toyo/health.json。alerting が空でなければ「劣化」。 */
export type HealthSnapshot = {
  generatedAt: string;
  jobs: Record<string, unknown>;
  alerting: string[];
};

export type FileMetadata = { contentType: string; size: number; storedAt: string };
