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
    source_url: str | None
    notes: tuple[str, ...]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "Assignment":
        due_at_raw = payload.get("dueAt")
        return cls(
            assignment_id=str(payload["assignmentId"]),
            course_name=str(payload["courseName"]),
            title=str(payload["title"]),
            due_at=datetime.fromisoformat(str(due_at_raw)) if due_at_raw else None,
            status=str(payload["status"]),
            source_url=str(payload["sourceUrl"]) if payload.get("sourceUrl") else None,
            notes=tuple(str(note) for note in payload.get("notes", [])),
        )


@dataclass(frozen=True, slots=True)
class NextClassNotes:
    checked_at: str | None
    first_topic: str | None
    syllabus_points: tuple[str, ...]
    raw_markdown_path: str | None

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "NextClassNotes":
        return cls(
            checked_at=str(payload["checkedAt"]) if payload.get("checkedAt") else None,
            first_topic=str(payload["firstTopic"]) if payload.get("firstTopic") else None,
            syllabus_points=tuple(str(item) for item in payload.get("syllabusPoints", [])),
            raw_markdown_path=(
                str(payload["rawMarkdownPath"]) if payload.get("rawMarkdownPath") else None
            ),
        )


@dataclass(frozen=True, slots=True)
class Summary:
    generated_at: datetime
    timezone: str
    next_class: ClassSummary | None
    next_class_notes: NextClassNotes | None
    today_classes: tuple[ClassSummary, ...]
    upcoming_assignments: tuple[Assignment, ...]
    errors: tuple[str, ...]
    portal_available: bool
    portal_fetched_at: str | None
    toyonet_ace_available: bool
    toyonet_ace_fetched_at: str | None

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "Summary":
        source_status = payload.get("sourceStatus", {})
        portal = source_status.get("portal", {})
        toyonet_ace = source_status.get("toyonetAce", {})
        next_class_payload = payload.get("nextClass")
        next_class_notes_payload = payload.get("nextClassNotes")
        return cls(
            generated_at=datetime.fromisoformat(str(payload["generatedAt"])),
            timezone=str(payload["timezone"]),
            next_class=ClassSummary.from_dict(next_class_payload) if next_class_payload else None,
            next_class_notes=(
                NextClassNotes.from_dict(next_class_notes_payload)
                if next_class_notes_payload
                else None
            ),
            today_classes=tuple(
                ClassSummary.from_dict(item) for item in payload.get("todayClasses", [])
            ),
            upcoming_assignments=tuple(
                Assignment.from_dict(item) for item in payload.get("upcomingAssignments", [])
            ),
            errors=tuple(str(item) for item in payload.get("errors", [])),
            portal_available=bool(portal.get("available")),
            portal_fetched_at=(
                str(portal["fetchedAt"]) if portal.get("fetchedAt") else None
            ),
            toyonet_ace_available=bool(toyonet_ace.get("available")),
            toyonet_ace_fetched_at=(
                str(toyonet_ace["fetchedAt"]) if toyonet_ace.get("fetchedAt") else None
            ),
        )
