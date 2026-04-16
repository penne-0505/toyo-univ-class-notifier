from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .models import Assignment, ClassSummary, Summary


class SummaryService:
    def __init__(self, summary_path: Path, timezone: ZoneInfo) -> None:
        self._summary_path = summary_path
        self._timezone = timezone

    async def loadSummary(self) -> Summary:
        def _read() -> dict[str, object]:
            with self._summary_path.open("r", encoding="utf-8") as handle:
                return json.load(handle)

        payload = await asyncio.to_thread(_read)
        return Summary.from_dict(payload)

    def formatNextClass(self, summary: Summary) -> str:
        if summary.next_class is None:
            return "次コマ情報はまだありません。まず `/refresh` で同期してください。"

        class_info = summary.next_class
        lines = [
            "次コマ",
            self._format_class_line(class_info),
        ]

        if summary.next_class_notes and summary.next_class_notes.first_topic:
            lines.append(f"初回内容: {summary.next_class_notes.first_topic}")

        if summary.next_class_notes and summary.next_class_notes.syllabus_points:
            lines.append("シラバス要点:")
            lines.extend(
                f"- {point}" for point in summary.next_class_notes.syllabus_points[:3]
            )

        upcoming = self._upcoming_assignment_lines(summary.upcoming_assignments, class_info.course_name)
        if upcoming:
            lines.append("関連する提出物:")
            lines.extend(upcoming)

        return "\n".join(lines)

    def formatToday(self, summary: Summary) -> str:
        if not summary.today_classes:
            return "今日の授業はありません。"

        lines = ["今日の授業"]
        lines.extend(self._format_class_line(class_info) for class_info in summary.today_classes)

        if summary.upcoming_assignments:
            lines.append("近い提出物:")
            lines.extend(self._format_assignment_line(item) for item in summary.upcoming_assignments[:5])

        return "\n".join(lines)

    def formatStatus(self, summary: Summary, sync_status: str | None) -> str:
        lines = [
            "状態",
            f"- Summary 更新: {self._format_dt(summary.generated_at)}",
            f"- 学務ポータル: {'OK' if summary.portal_available else '要確認'}",
            f"- ToyoNet-ACE: {'OK' if summary.toyonet_ace_available else '未実装または未取得'}",
            f"- JST 通知時刻: {summary.timezone}",
        ]
        if summary.portal_fetched_at:
            lines.append(f"- 履修データ取得: {summary.portal_fetched_at}")
        if summary.toyonet_ace_fetched_at:
            lines.append(f"- ACE 取得: {summary.toyonet_ace_fetched_at}")
        if summary.errors:
            lines.append("- 収集エラー:")
            lines.extend(f"  - {item}" for item in summary.errors[:5])
        if sync_status:
            lines.append(f"- 直近同期: {sync_status}")
        return "\n".join(lines)

    def buildDailySummaryMessage(self, summary: Summary) -> str:
        lines = ["15:00 まとめ" if self._is_fifteen(summary.generated_at) else "定期まとめ"]
        if summary.today_classes:
            lines.append("今日の残り授業:")
            lines.extend(self._format_class_line(item) for item in summary.today_classes)
        else:
            lines.append("今日の授業はありません。")

        if summary.upcoming_assignments:
            lines.append("提出物:")
            lines.extend(self._format_assignment_line(item) for item in summary.upcoming_assignments[:5])
        else:
            lines.append("提出物は見つかっていません。")

        if summary.errors:
            lines.append("注意:")
            lines.extend(f"- {item}" for item in summary.errors[:3])

        return "\n".join(lines)

    def buildClassReminderMessage(self, summary: Summary) -> str | None:
        if summary.next_class is None:
            return None

        class_info = summary.next_class
        lines = [
            "3時間前リマインド",
            self._format_class_line(class_info),
        ]

        related_assignments = self._upcoming_assignment_lines(
            summary.upcoming_assignments,
            class_info.course_name,
        )
        if related_assignments:
            lines.append("関連する提出物:")
            lines.extend(related_assignments)

        return "\n".join(lines)

    def reminderKey(self, class_info: ClassSummary) -> str:
        return f"class-reminder:{class_info.course_code}:{class_info.starts_at.isoformat()}"

    def dailySummaryKey(self, now: datetime, time_text: str) -> str:
        now_jst = now.astimezone(self._timezone)
        return f"daily-summary:{now_jst.date().isoformat()}:{time_text}"

    def shouldSendClassReminder(self, summary: Summary, now: datetime) -> bool:
        if summary.next_class is None:
            return False
        reminder_at = summary.next_class.starts_at.astimezone(self._timezone).timestamp() - 3 * 3600
        now_ts = now.astimezone(self._timezone).timestamp()
        return reminder_at <= now_ts < reminder_at + 300

    def shouldSendDailySummary(self, now: datetime, time_text: str) -> bool:
        current = now.astimezone(self._timezone).strftime("%H:%M")
        return current == time_text

    @staticmethod
    def _is_fifteen(generated_at: datetime) -> bool:
        return generated_at.astimezone(ZoneInfo("Asia/Tokyo")).strftime("%H:%M") == "15:00"

    def _upcoming_assignment_lines(
        self, assignments: tuple[Assignment, ...], course_name: str
    ) -> list[str]:
        lines: list[str] = []
        for item in assignments:
            if item.course_name != course_name:
                continue
            lines.append(self._format_assignment_line(item))
            if len(lines) >= 3:
                break
        return lines

    def _format_class_line(self, class_info: ClassSummary) -> str:
        start = class_info.starts_at.astimezone(self._timezone).strftime("%m/%d %H:%M")
        end = class_info.ends_at.astimezone(self._timezone).strftime("%H:%M")
        room = class_info.room or "教室未設定"
        return (
            f"- {start}-{end} {class_info.day}{class_info.period}限 "
            f"{class_info.course_name} / {room} / {class_info.instructor}"
        )

    def _format_assignment_line(self, assignment: Assignment) -> str:
        if assignment.due_at:
            due = assignment.due_at.astimezone(self._timezone).strftime("%m/%d %H:%M")
        else:
            due = "締切未確認"
        return f"- {due} {assignment.course_name}: {assignment.title} [{assignment.status}]"

    def _format_dt(self, value: datetime) -> str:
        return value.astimezone(self._timezone).strftime("%Y-%m-%d %H:%M JST")
