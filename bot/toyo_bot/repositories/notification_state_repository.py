from __future__ import annotations

from datetime import datetime
from typing import Protocol


class NotificationStateRepository(Protocol):
    async def wasSent(self, notification_key: str) -> bool: ...

    async def markSent(self, notification_key: str, sent_at: datetime) -> None: ...

    async def pruneOlderThan(self, cutoff: datetime) -> None: ...
