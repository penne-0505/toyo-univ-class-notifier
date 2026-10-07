/**
 * 組み立て層: 課題・お知らせ・コンテンツ（ACE の表記）から、授業コードを引く純粋な関数。
 * 引き方は index が正本: ACE courseId → 科目名のキー（courseKey）の順。名前の `===` 比較や部分一致はしない。
 * 引けなかったものは courseCode: null（科目不明）で返す。落とさず、呼び出し側が残す。
 *
 * 規則: このファイルは Playwright も fetch も import しない。
 */
import { courseKey } from '../lib/course-key';
import type { CourseworkResult } from '../lib/coursework-model';
import type { CourseIndex, CourseIndexEntry } from './course-index';

export type CourseRef = {
  /** 登録科目の授業コード。ACE にあるが履修登録確認表に無い科目（aceOnly）や、引けなかったものは null */
  courseCode: string | null;
  aceCourseId: string | null;
};

export const UNKNOWN_COURSE: CourseRef = { courseCode: null, aceCourseId: null };

export type CourseResolver = {
  /** ACE courseId（課題 ID・URL から取れれば）→ ACE 上の科目名の順に引く。 */
  resolve(name: string | null | undefined, aceCourseId?: string | null): CourseRef;
  /** courseNameHint が無いお知らせ用: タイトルに科目名（キー）が丸ごと含まれていれば引く。部分一致はしない。 */
  resolveFromTitle(title: string): CourseRef;
};

/** ACE の URL / ID 文字列（course_<数字>…）から ACE courseId を取り出す。 */
export function aceCourseIdFrom(text: string | null | undefined): string | null {
  const match = /course_(\d+)/.exec(text ?? '');
  return match ? match[1] : null;
}

const MIN_TITLE_KEY_LENGTH = 3;

export function createCourseResolver(index: CourseIndex, coursework: CourseworkResult | null): CourseResolver {
  const byAceId = new Map<string, CourseIndexEntry>();
  const entriesByKey = new Map<string, CourseIndexEntry[]>();
  const aceIdByKey = new Map<string, string>();
  const knownAceIds = new Set<string>();

  const addKey = (key: string, entry: CourseIndexEntry): void => {
    if (!key) return;
    const list = entriesByKey.get(key) ?? [];
    if (!list.includes(entry)) list.push(entry);
    entriesByKey.set(key, list);
  };

  for (const entry of index.courses) {
    if (entry.aceCourseId) {
      byAceId.set(entry.aceCourseId, entry);
      knownAceIds.add(entry.aceCourseId);
    }
    addKey(entry.names.key, entry);
    if (entry.names.ace) addKey(courseKey(entry.names.ace), entry);
  }
  for (const ace of index.aceOnly) {
    knownAceIds.add(ace.aceCourseId);
    aceIdByKey.set(courseKey(ace.name), ace.aceCourseId);
  }
  // ACE の見出し名・一覧名・登録科目名はコースごとに揺れる（サンプル地理学B7 / サンプル地理学B など）。index の names.ace は一覧名なので、
  // 課題・お知らせが見出し名で来た場合に備え、coursework の 3 つの名前も ACE courseId への橋にする。
  for (const course of coursework?.courses ?? []) {
    knownAceIds.add(course.courseId);
    for (const name of [course.courseName, course.aceListName, course.portalCourseName]) {
      if (name) aceIdByKey.set(courseKey(name), course.courseId);
    }
  }

  const currentHead = index.currentSemester?.slice(0, 1) ?? null;
  const inCurrentSemester = (entry: CourseIndexEntry): boolean =>
    currentHead === null || entry.semester.startsWith('通年') || entry.semester.startsWith(currentHead);
  /** 同じ名前の科目が複数あるときは今学期のものを優先する。 */
  const pick = (entries: CourseIndexEntry[]): CourseIndexEntry => entries.find(inCurrentSemester) ?? entries[0];

  const fromEntry = (entry: CourseIndexEntry): CourseRef => ({ courseCode: entry.courseCode, aceCourseId: entry.aceCourseId });

  const resolveAceId = (aceCourseId: string): CourseRef | null => {
    const entry = byAceId.get(aceCourseId);
    if (entry) return fromEntry(entry);
    return knownAceIds.has(aceCourseId) ? { courseCode: null, aceCourseId } : null;
  };

  return {
    resolve(name, aceCourseId) {
      if (aceCourseId) {
        const hit = resolveAceId(aceCourseId);
        if (hit) return hit;
      }
      if (name) {
        const key = courseKey(name);
        const entries = entriesByKey.get(key);
        if (entries && entries.length > 0) return fromEntry(pick(entries));
        const viaAce = aceIdByKey.get(key);
        if (viaAce) return resolveAceId(viaAce) ?? { courseCode: null, aceCourseId: viaAce };
      }
      return UNKNOWN_COURSE;
    },
    resolveFromTitle(title) {
      const titleKey = courseKey(title);
      let best: { key: string; entries: CourseIndexEntry[] } | null = null;
      for (const [key, entries] of entriesByKey) {
        if (key.length < MIN_TITLE_KEY_LENGTH || !titleKey.includes(key)) continue;
        if (!best || key.length > best.key.length) best = { key, entries };
      }
      return best ? fromEntry(pick(best.entries)) : UNKNOWN_COURSE;
    },
  };
}
