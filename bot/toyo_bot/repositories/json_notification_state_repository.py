from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path

from .notification_state_repository import NotificationStateRepository


class JsonNotificationStateRepository(NotificationStateRepository):
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = asyncio.Lock()

    async def wasSent(self, notification_key: str) -> bool:
        state = await self._read_state()
        return notification_key in state["sent"]

    async def markSent(self, notification_key: str, sent_at: datetime) -> None:
        async with self._lock:
            state = await self._read_state_unlocked()
            state["sent"][notification_key] = sent_at.isoformat()
            await self._write_state_unlocked(state)

    async def pruneOlderThan(self, cutoff: datetime) -> None:
        async with self._lock:
            state = await self._read_state_unlocked()
            state["sent"] = {
                key: value
                for key, value in state["sent"].items()
                if datetime.fromisoformat(value) >= cutoff
            }
            await self._write_state_unlocked(state)

    async def _read_state(self) -> dict[str, dict[str, str]]:
        async with self._lock:
            return await self._read_state_unlocked()

    async def _read_state_unlocked(self) -> dict[str, dict[str, str]]:
        def _read() -> dict[str, dict[str, str]]:
            if not self._path.exists():
                return {"sent": {}}
            with self._path.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
            sent = payload.get("sent", {})
            return {"sent": {str(key): str(value) for key, value in sent.items()}}

        return await asyncio.to_thread(_read)

    async def _write_state_unlocked(self, state: dict[str, dict[str, str]]) -> None:
        def _write() -> None:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            temp_path = self._path.with_suffix(".tmp")
            with temp_path.open("w", encoding="utf-8") as handle:
                json.dump(state, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            temp_path.replace(self._path)

        await asyncio.to_thread(_write)
