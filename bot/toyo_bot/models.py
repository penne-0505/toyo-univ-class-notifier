from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass(frozen=True, slots=True)
class ClassSummary:
    course_name: str
    course_code: str
    instructor: str
    room: str
    campus: str
    day: str
    period: str
    delivery_mode: str
    starts_at: datetime
    ends_at: datetime

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ClassSummary":
        return cls(
            course_name=str(payload["courseName"]),
            course_code=str(payload["courseCode"]),
            instructor=str(payload["instructor"]),
            room=str(payload["room"]),
            campus=str(payload["campus"]),
            day=str(payload["day"]),
            period=str(payload["period"]),
            delivery_mode=str(payload["deliveryMode"]),
            starts_at=datetime.fromisoformat(str(payload["startsAt"])),
            ends_at=datetime.fromisoformat(str(payload["endsAt"])),
        )


@dataclass(frozen=True, slots=True)
class Assignment:
    assignment_id: str
    course_name: str
    title: str
    due_at: datetime | None
    status: str

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "Assignment":
        due_at_raw = payload.get("dueAt")
        return cls(
            assignment_id=str(payload["assignmentId"]),
            course_name=str(payload["courseName"]),
            title=str(payload["title"]),
            due_at=datetime.fromisoformat(str(due_at_raw)) if due_at_raw else None,
            status=str(payload.get("status", "unknown")),
        )


@dataclass(frozen=True, slots=True)
class Announcement:
    announcement_id: str
    category: str  # '休講' | '補講' | '教室変更' | 'その他'
    course_name_hint: str | None
    title: str
    target_date: str | None  # YYYY-MM-DD

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "Announcement":
        return cls(
            announcement_id=str(payload["announcementId"]),
            category=str(payload.get("category", "その他")),
            course_name_hint=str(payload["courseNameHint"]) if payload.get("courseNameHint") else None,
            title=str(payload["title"]),
            target_date=str(payload["targetDate"]) if payload.get("targetDate") else None,
        )


@dataclass(frozen=True, slots=True)
class DetailedClassSummary:
    class_info: ClassSummary
    related_assignments: tuple[Assignment, ...]
    related_announcements: tuple[Announcement, ...]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "DetailedClassSummary":
        return cls(
            class_info=ClassSummary.from_dict(payload["classInfo"]),
            related_assignments=tuple(
                Assignment.from_dict(item) for item in payload.get("relatedAssignments", [])
            ),
            related_announcements=tuple(
                Announcement.from_dict(item) for item in payload.get("relatedAnnouncements", [])
            ),
        )


@dataclass(frozen=True, slots=True)
class Summary:
    generated_at: datetime
    next_class: ClassSummary | None
    today_classes: tuple[DetailedClassSummary, ...]
    tomorrow_classes: tuple[DetailedClassSummary, ...]
    upcoming_assignments: tuple[Assignment, ...]
    announcements: tuple[Announcement, ...]
    portal_fetch_status: str  # 'success' | 'error' | 'empty'
    portal_fetched_at: str | None
    ace_available: bool
    ace_fetched_at: str | None
    announcements_available: bool
    errors: tuple[str, ...]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "Summary":
        source_status = payload.get("sourceStatus", {})
        portal = source_status.get("portal", {})
        ace = source_status.get("toyonetAce", {})
        next_class_payload = payload.get("nextClass")
        return cls(
            generated_at=datetime.fromisoformat(str(payload["generatedAt"])),
            next_class=ClassSummary.from_dict(next_class_payload) if next_class_payload else None,
            today_classes=tuple(
                DetailedClassSummary.from_dict(item) for item in payload.get("todayClasses", [])
            ),
            tomorrow_classes=tuple(
                DetailedClassSummary.from_dict(item) for item in payload.get("tomorrowClasses", [])
            ),
            upcoming_assignments=tuple(
                Assignment.from_dict(item) for item in payload.get("upcomingAssignments", [])
            ),
            announcements=tuple(
                Announcement.from_dict(item) for item in payload.get("announcements", [])
            ),
            portal_fetch_status=str(portal.get("fetchStatus", "unknown")),
            portal_fetched_at=str(portal["fetchedAt"]) if portal.get("fetchedAt") else None,
            ace_available=bool(ace.get("available")),
            ace_fetched_at=str(ace["fetchedAt"]) if ace.get("fetchedAt") else None,
            announcements_available=bool(ace.get("announcementsAvailable", False)),
            errors=tuple(str(item) for item in payload.get("errors", [])),
        )
