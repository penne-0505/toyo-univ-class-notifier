from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .models import Announcement, ClassSummary, DetailedClassSummary, Summary

_DISCORD_LIMIT = 1900


def _remind_label(minutes: int) -> str:
    if minutes >= 60 and minutes % 60 == 0:
        return f"{minutes // 60}時間前"
    if minutes >= 60:
        return f"{minutes // 60}時間{minutes % 60}分前"
    return f"{minutes}分前"


def _truncate(text: str) -> str:
    if len(text) <= _DISCORD_LIMIT:
        return text
    return text[:_DISCORD_LIMIT] + "\n…（省略）"


class SummaryService:
    def __init__(self, summary_path: Path, timezone: ZoneInfo) -> None:
        self._summary_path = summary_path
        self._tz = timezone

    async def load(self) -> Summary:
        def _read() -> dict:
            with self._summary_path.open("r", encoding="utf-8") as f:
                return json.load(f)

        payload = await asyncio.to_thread(_read)
        return Summary.from_dict(payload)

    # ── formatters ──────────────────────────────────────────────────────────

    def format_today(self, summary: Summary) -> str:
        return _truncate(self._format_day("今日", summary.today_classes, summary))

    def format_tomorrow(self, summary: Summary) -> str:
        return _truncate(self._format_day("明日", summary.tomorrow_classes, summary))

    def format_assignments(self, summary: Summary) -> str:
        if not summary.upcoming_assignments:
            suffix = "" if summary.ace_available else "\n⚠️ ToyoNet-ACE の取得に失敗したため未確認"
            return f"📋 未提出課題はありません。{suffix}"

        lines = ["📋 **未提出課題**"]
        for a in summary.upcoming_assignments[:10]:
            lines.append(self._fmt_assignment(a))
        if len(summary.upcoming_assignments) > 10:
            lines.append(f"…他 {len(summary.upcoming_assignments) - 10} 件")
        return _truncate("\n".join(lines))

    def format_announcements(self, summary: Summary) -> str:
        important = [a for a in summary.announcements if a.category in ("休講", "補講", "教室変更")]
        if not important:
            suffix = "" if summary.announcements_available else "\n⚠️ お知らせの取得に失敗したため未確認"
            return f"📢 休講・補講・教室変更のお知らせはありません。{suffix}"

        lines = ["📢 **お知らせ**"]
        for a in important:
            date_hint = f" ({a.target_date})" if a.target_date else ""
            course = f" [{a.course_name_hint}]" if a.course_name_hint else ""
            lines.append(f"**[{a.category}]**{course}{date_hint} {a.title}")
        return _truncate("\n".join(lines))

    def format_status(self, summary: Summary, last_sync: str | None = None) -> str:
        dt = summary.generated_at.astimezone(self._tz).strftime("%Y-%m-%d %H:%M JST")
        portal_icon = {"success": "✅", "error": "❌", "empty": "⚠️"}.get(
            summary.portal_fetch_status, "❓"
        )
        lines = [
            "**データ状態**",
            f"同期: {dt}",
            f"ポータル: {portal_icon} {summary.portal_fetch_status}"
            + (f" ({summary.portal_fetched_at})" if summary.portal_fetched_at else ""),
            f"ACE課題: {'✅' if summary.ace_available else '❌'}"
            + (f" ({summary.ace_fetched_at})" if summary.ace_fetched_at else ""),
            f"ACEお知らせ: {'✅' if summary.announcements_available else '❌'}",
        ]
        if summary.errors:
            lines.append("エラー:")
            lines.extend(f"  {e}" for e in summary.errors[:3])
        if last_sync:
            lines.append(f"直近同期: {last_sync}")
        return _truncate("\n".join(lines))

    def format_daily_summary(
        self, summary: Summary, *, new_assignment_ids: set[str] | None = None
    ) -> str:
        lines = ["**定期まとめ**"]
        lines.append(self._format_day("今日", summary.today_classes, summary))
        lines.append("")
        lines.append(self._format_assignment_digest(summary, new_assignment_ids or set()))

        important = [a for a in summary.announcements if a.category in ("休講", "補講", "教室変更")]
        if important:
            lines.append("\n📢 お知らせ:")
            for a in important[:3]:
                lines.append(f"  [{a.category}] {a.title}")

        return _truncate("\n".join(lines))

    def format_reminder(self, summary: Summary, remind_minutes: int = 180) -> str | None:
        if summary.next_class is None:
            return None
        c = summary.next_class
        start = c.starts_at.astimezone(self._tz).strftime("%H:%M")
        end = c.ends_at.astimezone(self._tz).strftime("%H:%M")
        lines = [
            f"⏰ **{_remind_label(remind_minutes)} リマインド**",
            f"{start}-{end} {c.day}{c.period}限 **{c.course_name}**",
            f"教室: {c.room or '未設定'} ({c.campus})",
        ]

        related = self._find_related_assignments(summary, c.course_code)
        if related:
            lines.append("関連課題:")
            lines.extend(f"  {self._fmt_assignment(a)}" for a in related[:3])

        related_ann = [
            a for a in summary.announcements
            if a.course_name_hint == c.course_name or c.course_name in a.title
        ]
        for a in related_ann[:2]:
            lines.append(f"⚠️ [{a.category}] {a.title}")

        return _truncate("\n".join(lines))

    def reminder_key(self, class_info: ClassSummary) -> str:
        return f"reminder:{class_info.course_code}:{class_info.starts_at.isoformat()}"

    def daily_key(self, now: datetime, time_text: str) -> str:
        return f"daily:{now.astimezone(self._tz).date().isoformat()}:{time_text}"

    def should_send_daily(self, now: datetime, time_text: str) -> bool:
        return now.astimezone(self._tz).strftime("%H:%M") == time_text

    def should_send_reminder(self, summary: Summary, now: datetime, remind_minutes: int = 180) -> bool:
        if summary.next_class is None:
            return False
        remind_at = summary.next_class.starts_at.timestamp() - 60 * remind_minutes
        now_ts = now.timestamp()
        return remind_at <= now_ts < remind_at + 60

    # ── internals ───────────────────────────────────────────────────────────

    def _format_day(
        self, label: str, classes: tuple[DetailedClassSummary, ...], summary: Summary
    ) -> str:
        if not classes:
            return f"**{label}の授業はありません。**"

        lines = [f"**{label}の授業**"]
        for item in classes:
            c = item.class_info
            start = c.starts_at.astimezone(self._tz).strftime("%H:%M")
            end = c.ends_at.astimezone(self._tz).strftime("%H:%M")
            lines.append(f"\n**{c.period}限** {start}-{end}")
            lines.append(f"{c.course_name} / {c.room or '教室未設定'} / {c.instructor}")

            for a in item.related_announcements:
                lines.append(f"⚠️ [{a.category}] {a.title}")
            for a in item.related_assignments[:2]:
                lines.append(f"📋 {self._fmt_assignment(a)}")

        if not summary.announcements_available:
            lines.append("\n⚠️ お知らせの取得に失敗しました。直接 ToyoNet-ACE を確認してください。")

        return "\n".join(lines)

    def _format_assignment_digest(self, summary: Summary, new_assignment_ids: set[str]) -> str:
        if not summary.ace_available:
            return "📋 **未提出課題チェック**\n⚠️ ToyoNet-ACE の課題取得に失敗したため未確認です。"

        assignments = list(summary.upcoming_assignments)
        if not assignments:
            return "📋 **未提出課題チェック**\n未提出課題はありません。"

        lines = ["📋 **未提出課題チェック**"]

        new_assignments = [
            assignment for assignment in assignments
            if assignment.assignment_id in new_assignment_ids
        ]
        if new_assignments:
            lines.append("")
            lines.append(f"🆕 新しい課題が {len(new_assignments)} 件あります")
            for assignment in new_assignments[:5]:
                lines.append(f"- {self._fmt_assignment(assignment)}")
            if len(new_assignments) > 5:
                lines.append(f"…他 {len(new_assignments) - 5} 件")

        due_known = [assignment for assignment in assignments if assignment.due_at is not None]
        if due_known:
            lines.append("")
            lines.append(f"🔥 期限順 上位{min(3, len(due_known))}件")
            for index, assignment in enumerate(due_known[:3], start=1):
                lines.append(f"{index}. {self._fmt_assignment(assignment)}")

        deadline_unknown = [assignment for assignment in assignments if assignment.due_at is None]
        if deadline_unknown:
            lines.append("")
            lines.append("🕵️ 締切未確認")
            for assignment in deadline_unknown[:3]:
                lines.append(f"- {self._fmt_assignment(assignment)}")
            if len(deadline_unknown) > 3:
                lines.append(f"…他 {len(deadline_unknown) - 3} 件")

        return "\n".join(lines)

    def _fmt_assignment(self, a: "Assignment") -> str:  # type: ignore[name-defined]
        if a.due_at:
            due = a.due_at.astimezone(self._tz).strftime("%m/%d %H:%M")
        else:
            due = "締切未確認"
        return f"{due} {a.course_name}: {a.title} [{a.status}]"

    def _find_related_assignments(
        self, summary: Summary, course_code: str
    ) -> list:
        for item in (*summary.today_classes, *summary.tomorrow_classes):
            if item.class_info.course_code == course_code:
                return list(item.related_assignments)
        return []
