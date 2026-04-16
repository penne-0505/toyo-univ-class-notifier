import fs from 'node:fs/promises';
import path from 'node:path';
import { type Page } from 'playwright';
import { outputDir } from './toyo-enrollment';
import {
  collectPortalSnapshot,
  getOrCreatePage,
  launchStateContext,
  recoverToyoSessionIfNeeded,
  shouldRunHeadless,
} from './toyo';

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
};

export type AnnouncementCollectionResult = {
  fetchedAt: string;
  source: 'toyonet-ace';
  available: boolean;
  announcements: Announcement[];
  errors: string[];
};

const aceLoginUrl = 'https://www.ace.toyo.ac.jp/ct/login';
const reminderBaseUrl = 'https://www.ace.toyo.ac.jp/ct/home_library_reminder';
const reminderUrl = `${reminderBaseUrl}?count=50`;
export const announcementsOutputPath = path.join(outputDir, 'announcements.json');

function categorize(title: string): AnnouncementCategory {
  if (title.includes('休講')) return '休講';
  if (title.includes('補講')) return '補講';
  if (title.includes('教室変更') || title.includes('教室移動')) return '教室変更';
  return 'その他';
}

function toJstIso(raw: string): string | null {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(?::\d{2})?)?$/.test(normalized)) return null;
  const withTime = normalized.includes(' ') ? normalized : `${normalized} 00:00:00`;
  return `${withTime.replace(' ', 'T')}+09:00`;
}

function extractDateHint(text: string): string | null {
  const match = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  return `${y}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
}

function parseDetailText(text: string): { title: string | null; newsUrl: string | null } {
  // [タイトル] : 第３回授業資料につきまして
  const titleMatch = text.match(/\[タイトル\]\s*[：:]\s*(.+?)(?:\s*\[|\s*-{4,}|$)/);
  // PC : https://www.ace.toyo.ac.jp/ct/course_XXXXXXXX_news_XXXXXXXX
  const urlMatch = text.match(/PC\s*[：:]\s*(https:\/\/www\.ace\.toyo\.ac\.jp\/ct\/course_\S+)/);
  return {
    title: titleMatch?.[1]?.replace(/\s+/g, ' ').trim() ?? null,
    newsUrl: urlMatch?.[1]?.trim() ?? null,
  };
}

type ReminderRow = {
  detailHref: string;
  courseName: string;
  sendTime: string;
};

async function readCourseNewsRows(page: Page): Promise<ReminderRow[]> {
  return page.evaluate((): ReminderRow[] => {
    const rows = [...document.querySelectorAll<HTMLTableRowElement>('table.stdlist tr:not(.title)')];
    return rows
      .filter((r) => (r.textContent ?? '').includes('コースニュース'))
      .map((r) => {
        const titleLink = r.querySelector<HTMLAnchorElement>('td:first-child a');
        const courseLink = r.querySelector<HTMLAnchorElement>('td:nth-child(2) a');
        const sendTimeCell = r.querySelector<HTMLElement>('td.td-sendtime');
        return {
          detailHref: titleLink?.getAttribute('href') ?? '',
          courseName: (courseLink?.textContent ?? '').replace(/\s+/g, ' ').trim(),
          sendTime: (sendTimeCell?.textContent ?? '').trim(),
        };
      })
      .filter((r) => r.detailHref !== '');
  });
}

export async function collectToyoNetAceAnnouncements(
  _registeredCourseNames: string[] = []
): Promise<AnnouncementCollectionResult> {
  const fetchedAt = new Date().toISOString();
  const { browser, context } = await launchStateContext({ headless: shouldRunHeadless(true) });
  const page = await getOrCreatePage(context);

  try {
    await page.goto(aceLoginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await recoverToyoSessionIfNeeded(page, {
      returnUrl: aceLoginUrl,
      saveState: true,
      snapshotTag: 'toyonet-ace-announcements-login',
    });

    await page.goto(reminderUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await recoverToyoSessionIfNeeded(page, {
      returnUrl: reminderUrl,
      saveState: true,
      snapshotTag: 'toyonet-ace-announcements-reminder',
    });

    const rows = await readCourseNewsRows(page);
    const announcements: Announcement[] = [];
    const errors: string[] = [];

    for (const row of rows) {
      try {
        const detailUrl = new URL(row.detailHref, reminderBaseUrl).href;
        await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        await recoverToyoSessionIfNeeded(page, { returnUrl: detailUrl, saveState: false });

        const bodyText = await page.evaluate(
          () => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim()
        );

        const { title, newsUrl } = parseDetailText(bodyText);
        const effectiveTitle = title ?? row.courseName;

        announcements.push({
          announcementId: row.detailHref.replace('home_library_reminder_detail_', ''),
          category: categorize(effectiveTitle),
          courseNameHint: row.courseName || null,
          title: effectiveTitle,
          postedAt: toJstIso(row.sendTime),
          targetDate: extractDateHint(effectiveTitle),
          content: title ? `[${row.courseName}] ${title}` : '',
          sourceUrl: newsUrl ?? detailUrl,
        });
      } catch (error: unknown) {
        errors.push(
          `Failed to fetch reminder detail for ${row.courseName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const result: AnnouncementCollectionResult = {
      fetchedAt,
      source: 'toyonet-ace',
      available: true,
      announcements,
      errors,
    };

    await fs.mkdir(path.dirname(announcementsOutputPath), { recursive: true });
    await fs.writeFile(announcementsOutputPath, JSON.stringify(result, null, 2), 'utf8');
    return result;
  } catch (error: unknown) {
    try {
      await collectPortalSnapshot(page, 'toyonet-ace-announcements-error');
    } catch {
      // snapshot is best-effort
    }
    const message = error instanceof Error ? error.message : String(error);
    const failResult: AnnouncementCollectionResult = {
      fetchedAt,
      source: 'toyonet-ace',
      available: false,
      announcements: [],
      errors: [`Failed to collect announcements: ${message}`],
    };
    await fs.mkdir(path.dirname(announcementsOutputPath), { recursive: true }).catch(() => {});
    await fs.writeFile(announcementsOutputPath, JSON.stringify(failResult, null, 2), 'utf8').catch(() => {});
    return failResult;
  } finally {
    await context.close();
    await browser.close();
  }
}
