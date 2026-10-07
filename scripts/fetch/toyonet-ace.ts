import fs from 'node:fs/promises';
import path from 'node:path';
import { type Page } from 'playwright';
import { outputDir, repoRoot } from './toyo-enrollment';
import { courseKey } from '../lib/course-key';
import {
  collectPortalSnapshot,
  getOrCreatePage,
  launchStateContext,
  recoverToyoSessionIfNeeded,
  shouldRunHeadless,
} from '../lib/toyo';

export type AssignmentStatus = 'pending' | 'submitted' | 'unknown';

export type Assignment = {
  assignmentId: string;
  courseName: string;
  title: string;
  dueAt: string | null;
  status: AssignmentStatus;
  sourceUrl: string | null;
  notes: string[];
};

export type ContentResourceLink = {
  text: string;
  url: string;
};

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
};

export type AssignmentCollectionResult = {
  fetchedAt: string;
  source: 'toyonet-ace';
  available: boolean;
  assignments: Assignment[];
  errors: string[];
};

export type CourseContentCollectionResult = {
  fetchedAt: string;
  source: 'toyonet-ace';
  available: boolean;
  contents: CourseContent[];
  errors: string[];
};

export type PendingAssignmentRow = {
  type: string;
  title: string;
  courseName: string;
  opensAtRaw: string;
  dueAtRaw: string;
  periodRaw: string;
  assignmentHref: string | null;
};

type AceCourseLink = {
  courseName: string;
  courseUrl: string;
};

type AceContentListEntry = {
  title: string;
  contentUrl: string;
  listedAtRaw: string;
};

type AceContentDetailSnapshot = {
  title: string;
  bodyText: string;
  links: ContentResourceLink[];
};

const aceLoginUrl = 'https://www.ace.toyo.ac.jp/ct/login';
const homeCourseUrl = 'https://www.ace.toyo.ac.jp/ct/home_course';
const pendingAssignmentsUrl = 'https://www.ace.toyo.ac.jp/ct/home_library_query';
const assignmentPath = path.join(outputDir, 'toyonet-ace-assignments.json');
const contentPath = path.join(outputDir, 'toyonet-ace-contents.json');
const diagnosticsPath = path.join(repoRoot, 'artifacts', 'toyo', 'toyonet-ace-diagnostics.json');

type AcePageState = 'login' | 'pending-list' | 'unknown';

type AcePageDiagnostics = {
  state: AcePageState;
  url: string;
  title: string;
  bodyPreview: string;
  hasPendingAssignmentsTable: boolean;
  hasLoginForm: boolean;
};

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function toJstIso(raw: string): string | null {
  const normalized = normalizeText(raw);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(normalized)) {
    return null;
  }

  const normalizedWithSeconds =
    /:\d{2}$/.test(normalized) && normalized.split(':').length === 3
      ? normalized
      : `${normalized}:00`;
  return `${normalizedWithSeconds.replace(' ', 'T')}+09:00`;
}

function extractFirstDateTime(text: string): string | null {
  const match = text.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?/);
  return match ? toJstIso(match[0]) : null;
}

function extractPeriodBounds(text: string): { openFrom: string | null; openUntil: string | null } {
  const match = text.match(
    /公開期間[：:]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)\s*[～~]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)/
  );
  if (!match) {
    return { openFrom: null, openUntil: null };
  }

  return {
    openFrom: toJstIso(match[1]),
    openUntil: toJstIso(match[2]),
  };
}

function contentIdFromUrl(contentUrl: string): string {
  try {
    const pathname = new URL(contentUrl).pathname;
    return pathname.split('/').filter(Boolean).at(-1) ?? contentUrl;
  } catch {
    return contentUrl;
  }
}

function contentListUrlFromCourseUrl(courseUrl: string): string {
  return `${courseUrl}_page`;
}

function unwrapAceResourceUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith('/link_iframe_balloon')) {
      return url.searchParams.get('url') ?? rawUrl;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

function isAceNavigationLink(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    if (url.hostname === 'attend.manaba.jp' || url.hostname === 'doc.manaba.jp') {
      return true;
    }

    if (url.hostname !== 'www.ace.toyo.ac.jp') {
      return false;
    }

    const pathname = url.pathname;
    return (
      pathname === '/ct/hsearch' ||
      pathname === '/ct/home' ||
      pathname === '/ct/home_course' ||
      pathname.startsWith('/ct/home_') ||
      pathname.startsWith('/ct/course_') ||
      pathname.startsWith('/ct/page_') ||
      pathname.startsWith('/ct/usermemo_') ||
      pathname.startsWith('/ct/doc_') ||
      pathname === '/ct/logout'
    );
  } catch {
    return true;
  }
}

function notesForRow(row: PendingAssignmentRow): string[] {
  const notes = [`タイプ: ${row.type}`];
  const opensAt = toJstIso(row.opensAtRaw);
  if (opensAt) {
    notes.push(`受付開始: ${opensAt}`);
  } else if (normalizeText(row.opensAtRaw)) {
    notes.push(`受付開始: ${normalizeText(row.opensAtRaw)}`);
  }

  const period = normalizeText(row.periodRaw);
  if (period) {
    notes.push(`受付期間: ${period}`);
  }

  return notes;
}

function assignmentIdFromHref(href: string | null): string | null {
  if (!href) {
    return null;
  }

  try {
    const url = new URL(href, pendingAssignmentsUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    return segments.at(-1) ?? null;
  } catch {
    return null;
  }
}

export function toAssignment(row: PendingAssignmentRow): Assignment | null {
  const title = normalizeText(row.title);
  const courseName = normalizeText(row.courseName);
  if (!title || !courseName) {
    return null;
  }

  const sourceUrl = row.assignmentHref ? new URL(row.assignmentHref, pendingAssignmentsUrl).href : null;
  const assignmentId =
    assignmentIdFromHref(row.assignmentHref) ??
    `${courseName}:${title}`.replace(/\s+/g, '_').slice(0, 200);

  return {
    assignmentId,
    courseName,
    title,
    dueAt: toJstIso(row.dueAtRaw),
    status: 'pending',
    sourceUrl,
    notes: notesForRow(row),
  };
}

async function inspectAcePage(page: Page): Promise<AcePageDiagnostics> {
  return page.evaluate((loginUrl): AcePageDiagnostics => {
    const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
    const title = document.title.trim();
    const url = window.location.href;
    const hasPendingAssignmentsTable = document.querySelector('table.stdlist') !== null;
    const hasLoginForm =
      document.querySelector('#username_input') !== null &&
      document.querySelector('#password_input') !== null &&
      document.querySelector('#login_button') !== null;

    let state: AcePageState = 'unknown';
    if (url.startsWith(loginUrl) || hasLoginForm) {
      state = 'login';
    } else if (
      hasPendingAssignmentsTable ||
      bodyText.includes('未提出の課題一覧') ||
      bodyText.includes('未提出課題')
    ) {
      state = 'pending-list';
    }

    return {
      state,
      url,
      title,
      bodyPreview: bodyText.slice(0, 500),
      hasPendingAssignmentsTable,
      hasLoginForm,
    };
  }, 'https://slink.secioss.com');
}

async function writeDiagnosticsArtifact(payload: {
  fetchedAt: string;
  stage: string;
  steps: string[];
  page: AcePageDiagnostics;
}): Promise<void> {
  await fs.mkdir(path.dirname(diagnosticsPath), { recursive: true });
  await fs.writeFile(diagnosticsPath, JSON.stringify(payload, null, 2), 'utf8');
}

async function resolveAceLoginIfNeeded(
  page: Page,
  stage: string,
  steps: string[],
  returnUrl?: string
): Promise<void> {
  const diagnostics = await inspectAcePage(page);
  steps.push(
    `${stage}: state=${diagnostics.state} title=${diagnostics.title || '(no title)'} url=${diagnostics.url}`
  );

  const recovery = await recoverToyoSessionIfNeeded(page, {
    returnUrl: returnUrl ?? diagnostics.url,
    saveState: true,
    snapshotTag: `toyonet-ace-${stage}`,
  });
  if (recovery.recovered) {
    steps.push(
      `${stage}: recovered SSO session from ${recovery.reason} and returned to ${recovery.finalUrl}`
    );
  }
}

async function bootstrapAceSession(page: Page): Promise<void> {
  await page.goto(aceLoginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await recoverToyoSessionIfNeeded(page, {
    returnUrl: aceLoginUrl,
    saveState: true,
    snapshotTag: 'toyonet-ace-login-session-loss',
  });
  await page.goto(pendingAssignmentsUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await recoverToyoSessionIfNeeded(page, {
    returnUrl: pendingAssignmentsUrl,
    saveState: true,
    snapshotTag: 'toyonet-ace-pending-session-loss',
  });
}

async function bootstrapAceSessionWithDiagnostics(
  page: Page,
  steps: string[]
): Promise<void> {
  steps.push(`goto ace login: ${aceLoginUrl}`);
  await page.goto(aceLoginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await resolveAceLoginIfNeeded(page, 'after ace login entry', steps, aceLoginUrl);

  steps.push(`goto pending assignments: ${pendingAssignmentsUrl}`);
  await page.goto(pendingAssignmentsUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await resolveAceLoginIfNeeded(
    page,
    'after pending assignments entry',
    steps,
    pendingAssignmentsUrl
  );

  const diagnostics = await inspectAcePage(page);
  if (diagnostics.state === 'login') {
    throw new Error('Still on SSO login page after attempting ACE bootstrap.');
  }

  if (diagnostics.state !== 'pending-list') {
    steps.push(
      `after pending assignments entry: unexpected state=${diagnostics.state} preview=${diagnostics.bodyPreview}`
    );
  }
}

async function readPendingAssignments(page: Page, steps: string[]): Promise<PendingAssignmentRow[]> {
  const initialDiagnostics = await inspectAcePage(page);
  if (initialDiagnostics.state === 'login') {
    throw new Error('ACE pending assignments page redirected to SSO login before parsing started.');
  }

  if (initialDiagnostics.state !== 'pending-list') {
    try {
      await page.waitForFunction(
        () => {
          const bodyText = document.body?.innerText ?? '';
          return (
            document.querySelector('table.stdlist') !== null ||
            bodyText.includes('未提出の課題一覧') ||
            bodyText.includes('未提出課題')
          );
        },
        undefined,
        { timeout: 30_000 }
      );
    } catch (error: unknown) {
      const diagnostics = await inspectAcePage(page);
      steps.push(
        `read pending assignments timeout: state=${diagnostics.state} title=${diagnostics.title || '(no title)'} url=${diagnostics.url}`
      );
      throw new Error(
        `Timed out waiting for the ACE pending assignments view. state=${diagnostics.state} title=${
          diagnostics.title || '(no title)'
        } url=${diagnostics.url} preview=${diagnostics.bodyPreview}`
      );
    }
  }

  const finalDiagnostics = await inspectAcePage(page);
  steps.push(
    `parse pending assignments: state=${finalDiagnostics.state} title=${finalDiagnostics.title || '(no title)'}`
  );

  return page.evaluate((): PendingAssignmentRow[] => {
    const table = document.querySelector('table.stdlist');
    if (!table) {
      return [];
    }

    const rows: PendingAssignmentRow[] = [];

    for (const row of table.querySelectorAll('tr')) {
      if (row.querySelectorAll('th').length > 0) {
        continue;
      }

      const cells = [...row.querySelectorAll('td')];
      const titleLink = cells[1]?.querySelector('a') ?? null;
      const entry: PendingAssignmentRow = {
        type: (cells[0]?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        title: (cells[1]?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        courseName: (cells[2]?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        opensAtRaw: (cells[3]?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        dueAtRaw: (cells[4]?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        periodRaw: (cells[5]?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        assignmentHref: titleLink?.getAttribute('href') ?? null,
      };

      if (entry.title && entry.courseName) {
        rows.push(entry);
      }
    }

    return rows;
  });
}

async function readAceCourseLinks(page: Page): Promise<AceCourseLink[]> {
  return page.evaluate((): AceCourseLink[] => {
    const entries = new Map<string, AceCourseLink>();
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = anchor.href || '';
      const pathname = new URL(href, window.location.href).pathname;
      if (!/^\/ct\/course_\d+$/.test(pathname)) {
        continue;
      }

      const courseName = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!courseName) {
        continue;
      }

      entries.set(href, {
        courseName,
        courseUrl: href,
      });
    }

    return [...entries.values()];
  });
}

function filterCourseLinks(
  courseLinks: AceCourseLink[],
  registeredCourseNames: string[]
): AceCourseLink[] {
  if (registeredCourseNames.length === 0) {
    return courseLinks;
  }

  const keys = new Set(registeredCourseNames.map(courseKey));
  const matched = courseLinks.filter((item) => keys.has(courseKey(item.courseName)));
  return matched.length > 0 ? matched : courseLinks;
}

async function openAceContentList(
  page: Page,
  courseLink: AceCourseLink,
  steps: string[]
): Promise<string> {
  const contentListUrl = contentListUrlFromCourseUrl(courseLink.courseUrl);
  steps.push(`goto course content list: ${courseLink.courseName} -> ${contentListUrl}`);
  await page.goto(contentListUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await resolveAceLoginIfNeeded(
    page,
    `after content list entry ${courseLink.courseName}`,
    steps,
    contentListUrl
  );
  return contentListUrl;
}

async function readAceContentListEntries(page: Page): Promise<AceContentListEntry[]> {
  return page.evaluate((): AceContentListEntry[] => {
    const entries = new Map<string, AceContentListEntry>();

    const anchors = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')];
    for (const anchor of anchors) {
      const href = anchor.href || '';
      const url = new URL(href, window.location.href);
      const underscoreCount = (url.pathname.match(/_/g) ?? []).length;
      if (!url.pathname.startsWith('/ct/page_') || underscoreCount !== 1) {
        continue;
      }

      const title = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!title) {
        continue;
      }

      const container =
        anchor.closest('tr, li, article, section, div') ?? anchor.parentElement ?? anchor;
      const contextText = (container.textContent ?? '').replace(/\s+/g, ' ').trim();
      const dateMatch = contextText.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?/);

      entries.set(href, {
        title,
        contentUrl: href,
        listedAtRaw: dateMatch?.[0] ?? '',
      });
    }

    return [...entries.values()];
  });
}

async function readAceContentDetail(page: Page): Promise<AceContentDetailSnapshot> {
  return page.evaluate((): AceContentDetailSnapshot => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
      .map((anchor) => ({
        text: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim(),
        url: anchor.href || '',
      }))
      .filter((item) => item.url);

    return {
      title:
        [...document.querySelectorAll('h1, h2, h3')]
          .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
          .find(Boolean) ?? '',
      bodyText: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      links,
    };
  });
}

function toCourseContent(
  courseLink: AceCourseLink,
  contentListUrl: string,
  entry: AceContentListEntry,
  detail: AceContentDetailSnapshot
): CourseContent {
  const bodyText = normalizeText(detail.bodyText);
  const updatedAtMatch = bodyText.match(
    /更新日時\s*[:：]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)/
  );
  const { openFrom, openUntil } = extractPeriodBounds(bodyText);

  const resourceLinks = [
    ...new Map(
      detail.links
        .map((item) => ({
          text: normalizeText(item.text) || unwrapAceResourceUrl(item.url),
          url: unwrapAceResourceUrl(item.url),
        }))
        .filter((item) => item.url)
        .filter((item) => !isAceNavigationLink(item.url))
        .map((item) => [item.url, item] as const)
    ).values(),
  ];

  return {
    contentId: contentIdFromUrl(entry.contentUrl),
    courseName: courseLink.courseName,
    courseUrl: courseLink.courseUrl,
    contentListUrl,
    title: entry.title || detail.title,
    contentUrl: entry.contentUrl,
    listedAt: toJstIso(entry.listedAtRaw),
    updatedAt: updatedAtMatch ? toJstIso(updatedAtMatch[1]) : extractFirstDateTime(bodyText),
    openFrom,
    openUntil,
    resourceLinks,
  };
}

async function writeAssignmentArtifact(result: AssignmentCollectionResult): Promise<void> {
  await fs.mkdir(path.dirname(assignmentPath), { recursive: true });
  await fs.writeFile(assignmentPath, JSON.stringify(result, null, 2), 'utf8');
}

async function writeContentArtifact(result: CourseContentCollectionResult): Promise<void> {
  await fs.mkdir(path.dirname(contentPath), { recursive: true });
  await fs.writeFile(contentPath, JSON.stringify(result, null, 2), 'utf8');
}

export async function collectToyoNetAceAssignments(): Promise<AssignmentCollectionResult> {
  const fetchedAt = new Date().toISOString();
  const steps: string[] = [];
  const { browser, context } = await launchStateContext({
    headless: shouldRunHeadless(true),
  });
  const page = await getOrCreatePage(context);

  try {
    await bootstrapAceSessionWithDiagnostics(page, steps);

    const rawAssignments = await readPendingAssignments(page, steps);
    const assignments = rawAssignments
      .map(toAssignment)
      .filter((assignment): assignment is Assignment => assignment !== null);

    const dedupedAssignments = [...new Map(assignments.map((item) => [item.assignmentId, item])).values()];

    const result: AssignmentCollectionResult = {
      fetchedAt,
      source: 'toyonet-ace',
      available: true,
      assignments: dedupedAssignments,
      errors: [],
    };

    await writeAssignmentArtifact(result);
    return result;
  } catch (error: unknown) {
    let snapshotMessage = '';
    let diagnosticsMessage = '';
    try {
      const artifact = await collectPortalSnapshot(page, 'toyonet-ace-home-library-query-error');
      snapshotMessage = ` Snapshot: ${artifact.summaryPath}`;
    } catch {
      snapshotMessage = '';
    }

    try {
      const diagnostics = await inspectAcePage(page);
      await writeDiagnosticsArtifact({
        fetchedAt,
        stage: 'collectToyoNetAceAssignments',
        steps,
        page: diagnostics,
      });
      diagnosticsMessage = ` Diagnostics: ${diagnosticsPath}`;
    } catch {
      diagnosticsMessage = '';
    }

    const message =
      error instanceof Error ? error.message : String(error);

    return {
      fetchedAt,
      source: 'toyonet-ace',
      available: false,
      assignments: [],
      errors: [`Failed to collect ToyoNet-ACE assignments: ${message}.${snapshotMessage}${diagnosticsMessage}`],
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

function sortCourseContents(contents: CourseContent[]): CourseContent[] {
  return [...contents].sort((a, b) => {
    const left = a.updatedAt ?? a.listedAt ?? '';
    const right = b.updatedAt ?? b.listedAt ?? '';
    if (left && right) {
      return right.localeCompare(left);
    }
    if (left) return -1;
    if (right) return 1;
    return a.title.localeCompare(b.title, 'ja');
  });
}

export async function collectToyoNetAceContents(
  registeredCourseNames: string[] = []
): Promise<CourseContentCollectionResult> {
  const fetchedAt = new Date().toISOString();
  const steps: string[] = [];
  const { browser, context } = await launchStateContext({
    headless: shouldRunHeadless(true),
  });
  const page = await getOrCreatePage(context);

  try {
    steps.push(`goto home course: ${homeCourseUrl}`);
    await page.goto(homeCourseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await resolveAceLoginIfNeeded(page, 'after home course entry', steps, homeCourseUrl);

    const allCourseLinks = await readAceCourseLinks(page);
    const courseLinks = filterCourseLinks(allCourseLinks, registeredCourseNames);
    const contents: CourseContent[] = [];
    const errors: string[] = [];

    for (const courseLink of courseLinks) {
      try {
        const contentListUrl = await openAceContentList(page, courseLink, steps);
        const entries = await readAceContentListEntries(page);

        for (const entry of entries) {
          await page.goto(entry.contentUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
          await resolveAceLoginIfNeeded(
            page,
            `after content detail entry ${courseLink.courseName} / ${entry.title}`,
            steps,
            entry.contentUrl
          );

          const detail = await readAceContentDetail(page);
          contents.push(toCourseContent(courseLink, contentListUrl, entry, detail));
        }
      } catch (error: unknown) {
        errors.push(
          `Failed to collect course contents for ${courseLink.courseName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const dedupedContents = [
      ...new Map(sortCourseContents(contents).map((item) => [item.contentId, item])).values(),
    ];

    const result: CourseContentCollectionResult = {
      fetchedAt,
      source: 'toyonet-ace',
      available: errors.length === 0,
      contents: dedupedContents,
      errors,
    };

    await writeContentArtifact(result);
    return result;
  } catch (error: unknown) {
    let snapshotMessage = '';
    let diagnosticsMessage = '';
    try {
      const artifact = await collectPortalSnapshot(page, 'toyonet-ace-content-error');
      snapshotMessage = ` Snapshot: ${artifact.summaryPath}`;
    } catch {
      snapshotMessage = '';
    }

    try {
      const diagnostics = await inspectAcePage(page);
      await writeDiagnosticsArtifact({
        fetchedAt,
        stage: 'collectToyoNetAceContents',
        steps,
        page: diagnostics,
      });
      diagnosticsMessage = ` Diagnostics: ${diagnosticsPath}`;
    } catch {
      diagnosticsMessage = '';
    }

    const message = error instanceof Error ? error.message : String(error);

    return {
      fetchedAt,
      source: 'toyonet-ace',
      available: false,
      contents: [],
      errors: [
        `Failed to collect ToyoNet-ACE course contents: ${message}.${snapshotMessage}${diagnosticsMessage}`,
      ],
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

export {
  assignmentPath as toyoNetAceAssignmentsOutputPath,
  contentPath as toyoNetAceContentsOutputPath,
  repoRoot,
};
