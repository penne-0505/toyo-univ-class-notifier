from __future__ import annotations

from typing import Protocol


class NotifyChannelRepository(Protocol):
    async def getNotifyChannel(self) -> str | None: ...

    async def setNotifyChannel(self, channel_id: str) -> None: ...
