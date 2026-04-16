from __future__ import annotations

from typing import Protocol


class NotifyScheduleRepository(Protocol):
    async def listNotifyTimes(self) -> list[str]: ...

    async def addNotifyTime(self, time_text: str) -> list[str]: ...

    async def removeNotifyTime(self, time_text: str) -> list[str]: ...
