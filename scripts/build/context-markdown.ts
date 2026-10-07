/**
 * 組み立て層: AgentContext を Markdown（agent-context.md）に整形する純粋関数。
 *
 * 規則: このファイルは Playwright も fetch も import しない。
 */
import type { AgentAnnouncement, AgentAssignment, AgentClass, AgentContext, AgentGradingRules, AgentPeriod } from './context';
import { truncate } from './context';
import type { CourseworkScheduleEntry } from '../lib/coursework-model';
import { describePeriodTime } from '../lib/toyo-academic-schedule';

function timeRange(startsAt: string, endsAt: string): string {
  const start = startsAt.match(/T(\d{2}:\d{2})/)?.[1] ?? startsAt;
  const end = endsAt.match(/T(\d{2}:\d{2})/)?.[1] ?? endsAt;
  return `${start}-${end}`;
}

function renderAssignment(assignment: AgentAssignment): string {
  const due = assignment.dueAt ?? '締切不明';
  return `${assignment.courseName}: ${assignment.title} (${due})`;
}

function renderAnnouncement(announcement: AgentAnnouncement): string {
  const course = announcement.courseNameHint ? `${announcement.courseNameHint}: ` : '';
  const target = announcement.targetDate ? ` target=${announcement.targetDate}` : '';
  return `[${announcement.category}] ${course}${announcement.title}${target}`;
}

function renderComponent(component: AgentGradingRules['components'][number]): string {
  const weight = component.weightPercent === null ? '配点不明' : `${component.weightPercent}%`;
  const scenario = component.scenario ? `[${component.scenario}] ` : '';
  const each = component.perSession ? '(毎回)' : '';
  return `${scenario}${component.name}${each} ${weight}`;
}

function renderPeriod(period: AgentPeriod): string {
  const when = describePeriodTime(period);
  const offset = period.status === 'upcoming' ? ` [${period.daysOffset}日後に開始]` : '';
  return `- [${period.semester}] ${period.label}: ${when}${offset}${period.note ? ` — ${period.note}` : ''}`;
}

const courseworkTypeLabel: Record<string, string> = { report: 'レポート', query: '小テスト', survey: 'アンケート' };
const courseworkStatusLabel: Record<string, string> = { open: '受付中', waiting: '受付開始待ち', closed: '受付終了', unknown: '状態不明' };

function jstMinuteLabel(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

function renderCourseworkEntry(item: CourseworkScheduleEntry): string {
  const submitted = item.submitted === true ? '提出済' : item.submitted === false ? '未提出' : '提出状況不明';
  const opens = item.status === 'waiting' && item.opensAt ? ` 受付開始 ${jstMinuteLabel(item.opensAt)}` : '';
  return `- ${jstMinuteLabel(item.dueAt)} 締切 ${item.portalCourseName ?? item.courseName}: ${item.title} [${courseworkTypeLabel[item.type] ?? item.type}/${courseworkStatusLabel[item.status] ?? item.status}/${submitted}]${opens}`;
}

function appendClassSection(lines: string[], title: string, classes: AgentClass[]): void {
  lines.push(`## ${title}`);
  if (classes.length === 0) {
    lines.push('- なし');
    lines.push('');
    return;
  }

  for (const entry of classes) {
    const session = entry.sessionNumber === null ? '' : ` 第${entry.sessionNumber}回`;
    lines.push(
      `- ${entry.period}限 ${timeRange(entry.startsAt, entry.endsAt)} ${entry.courseName} (${entry.courseCode})${session}`
    );
    lines.push(
      `  - ${entry.campus} ${entry.room || '教室不明'} / ${entry.deliveryMode || '形態不明'} / ${entry.instructor || '担当不明'}`
    );
    if (entry.syllabus?.grading) {
      lines.push(`  - 評価: ${entry.syllabus.grading}`);
    }
    if (entry.gradingRules) {
      const rules = entry.gradingRules;
      const tag = rules.reviewed ? '' : '（未レビュー）';
      if (rules.components.length > 0) {
        lines.push(`  - 配分${tag}: ${rules.components.map(renderComponent).join(' / ')}`);
      }
      if (rules.cutoffs.length > 0) {
        lines.push(`  - 足切り${tag}: ${rules.cutoffs.map((cutoff) => `[${cutoff.type}] ${truncate(cutoff.text, 100)}`).join(' / ')}`);
      }
      if (rules.warnings.length > 0) {
        lines.push(`  - 成績ルールの注意: ${rules.warnings.map((warning) => truncate(warning, 100)).join(' / ')}`);
      }
    }
    if (entry.coursework) {
      const cw = entry.coursework;
      const cutoff = entry.submissionCutoff
        ? ` / 足切りまで残り ${entry.submissionCutoff.remaining}（基準 ${entry.submissionCutoff.threshold} 回・提出 ${entry.submissionCutoff.submitted} 回、対象: ${entry.submissionCutoff.countedTypes}。条件の向きは足切り本文を優先）`
        : '';
      const next = cw.nextOpensAt ? ` / 次の受付開始 ${jstMinuteLabel(cw.nextOpensAt)}` : '';
      lines.push(`  - 提出状況: 済 ${cw.submitted} / 未 ${cw.notSubmitted}（受付中 ${cw.notSubmittedOpen}・終了 ${cw.closedNotSubmitted}）/ 受付開始待ち ${cw.waiting}${cutoff}${next}`);
    }
    if (entry.syllabus?.firstTopic) {
      lines.push(`  - シラバス先頭トピック: ${entry.syllabus.firstTopic}`);
    }
    if (entry.relatedAssignments.length > 0) {
      lines.push(`  - 関連課題: ${entry.relatedAssignments.map(renderAssignment).join(' / ')}`);
    }
    if (entry.relatedContents.length > 0) {
      lines.push(
        `  - 関連コンテンツ: ${entry.relatedContents.map((item) => item.title).join(' / ')}`
      );
    }
    if (entry.relatedAnnouncements.length > 0) {
      lines.push(
        `  - 関連お知らせ: ${entry.relatedAnnouncements.map(renderAnnouncement).join(' / ')}`
      );
    }
    if (entry.errors.length > 0) {
      lines.push(`  - 取得エラー: ${entry.errors.join(' / ')}`);
    }
  }
  lines.push('');
}

export function buildMarkdown(context: AgentContext): string {
  const lines: string[] = [
    '# Toyo Agent Context',
    '',
    `- builtAt: ${context.builtAt}`,
    `- timezone: ${context.timezone}`,
    `- summaryGeneratedAt: ${context.freshness.summaryGeneratedAt ?? 'unknown'}`,
    `- ageMinutes: ${context.freshness.ageMinutes ?? 'unknown'} / maxAgeMinutes: ${context.freshness.maxAgeMinutes}`,
    `- stale: ${context.freshness.stale}`,
    '',
    '## Status',
    `- portal: ${context.sourceStatus.portal.fetchStatus}, available=${context.sourceStatus.portal.available}, fetchedAt=${context.sourceStatus.portal.fetchedAt ?? 'unknown'}`,
    `- ToyoNet-ACE assignments: available=${context.sourceStatus.toyonetAce.available}, fetchedAt=${context.sourceStatus.toyonetAce.fetchedAt ?? 'unknown'}`,
    `- ToyoNet-ACE contents: available=${context.sourceStatus.toyonetAce.contentsAvailable}, fetchedAt=${context.sourceStatus.toyonetAce.contentsFetchedAt ?? 'unknown'}`,
    `- ToyoNet-ACE announcements: available=${context.sourceStatus.toyonetAce.announcementsAvailable}, fetchedAt=${context.sourceStatus.toyonetAce.announcementsFetchedAt ?? 'unknown'}`,
    `- ToyoNet-ACE coursework: available=${context.sourceStatus.toyonetAce.courseworkAvailable ?? false}, fetchedAt=${context.sourceStatus.toyonetAce.courseworkFetchedAt ?? 'unknown'}`,
    '',
    '## Warnings',
  ];

  if (context.warnings.length === 0) {
    lines.push('- なし');
  } else {
    lines.push(...context.warnings.map((warning) => `- ${warning}`));
  }
  lines.push('');

  lines.push(`## Periods (${context.periods.date})`);
  if (!context.periods.available) {
    lines.push('- academic-schedule.json がありません（期間情報なし）');
  } else if (context.periods.active.length === 0 && context.periods.upcoming.length === 0) {
    lines.push('- 進行中・7日以内に始まる期間はなし');
  } else {
    if (context.periods.active.length > 0) {
      lines.push('進行中:');
      lines.push(...context.periods.active.map(renderPeriod));
    }
    if (context.periods.upcoming.length > 0) {
      lines.push('7日以内に開始:');
      lines.push(...context.periods.upcoming.map(renderPeriod));
    }
  }
  lines.push('');

  lines.push(`## Today (${context.today.date})`);
  lines.push(`- nationalHoliday: ${context.today.nationalHoliday ?? 'なし'}`);
  lines.push('');
  appendClassSection(lines, 'Today Classes', context.today.classes);

  lines.push(`## Tomorrow (${context.tomorrow.date})`);
  lines.push(`- nationalHoliday: ${context.tomorrow.nationalHoliday ?? 'なし'}`);
  lines.push('');
  appendClassSection(lines, 'Tomorrow Classes', context.tomorrow.classes);

  lines.push('## Next Class');
  if (context.nextClass) {
    lines.push(
      `- ${context.nextClass.startsAt} ${context.nextClass.courseName} (${context.nextClass.courseCode})`
    );
    if (context.nextClassNotes?.syllabusPoints.length) {
      lines.push(...context.nextClassNotes.syllabusPoints.map((point) => `  - ${point}`));
    }
  } else {
    lines.push('- なし');
  }
  lines.push('');

  lines.push(`## Assignments Due Within ${context.assignments.horizonDays} Days`);
  if (context.assignments.dueWithinHorizon.length === 0) {
    lines.push('- なし');
  } else {
    lines.push(
      ...context.assignments.dueWithinHorizon.map((assignment) => `- ${renderAssignment(assignment)}`)
    );
  }
  lines.push('');

  lines.push('## Deadline Unknown Assignments');
  if (context.assignments.deadlineUnknown.length === 0) {
    lines.push('- なし');
  } else {
    lines.push(
      ...context.assignments.deadlineUnknown.map((assignment) => `- ${renderAssignment(assignment)}`)
    );
  }
  lines.push('');

  lines.push(`## Upcoming Coursework (${context.courseworkSchedule.horizonDays} days)`);
  if (context.courseworkSchedule.items.length === 0) {
    lines.push('- なし（toyo:coursework 未取得の場合も空）');
  } else {
    lines.push(...context.courseworkSchedule.items.map(renderCourseworkEntry));
  }
  lines.push('');

  lines.push('## Important Announcements');
  if (context.announcements.important.length === 0) {
    lines.push('- なし');
  } else {
    lines.push(
      ...context.announcements.important.map((announcement) => `- ${renderAnnouncement(announcement)}`)
    );
  }
  lines.push('');

  lines.push('## Recent Other Announcements');
  if (context.announcements.recentOther.length === 0) {
    lines.push('- なし');
  } else {
    lines.push(
      ...context.announcements.recentOther.map((announcement) => `- ${renderAnnouncement(announcement)}`)
    );
  }
  lines.push('');

  lines.push('## Agent Notes');
  lines.push(...context.agentNotes.map((note) => `- ${note}`));
  lines.push('');

  lines.push('## Source Files');
  for (const [key, value] of Object.entries(context.sourceFiles)) {
    lines.push(`- ${key}: ${value}`);
  }

  return `${lines.join('\n')}\n`;
}
