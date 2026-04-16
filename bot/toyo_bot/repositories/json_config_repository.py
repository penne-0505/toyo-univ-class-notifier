from __future__ import annotations

import asyncio
import json
from pathlib import Path

from .notify_channel_repository import NotifyChannelRepository
from .notify_schedule_repository import NotifyScheduleRepository


class JsonConfigRepository(NotifyChannelRepository, NotifyScheduleRepository):
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = asyncio.Lock()

    async def getNotifyChannel(self) -> str | None:
        config = await self._read_config()
        channel_id = config.get("notifyChannelId")
        return str(channel_id) if channel_id else None

    async def setNotifyChannel(self, channel_id: str) -> None:
        async with self._lock:
            config = await self._read_config_unlocked()
            config["notifyChannelId"] = channel_id
            await self._write_config_unlocked(config)

    async def listNotifyTimes(self) -> list[str]:
        config = await self._read_config()
        return list(config.get("dailySummaryTimes", ["15:00"]))

    async def addNotifyTime(self, time_text: str) -> list[str]:
        async with self._lock:
            config = await self._read_config_unlocked()
            times = set(config.get("dailySummaryTimes", ["15:00"]))
            times.add(time_text)
            config["dailySummaryTimes"] = sorted(times)
            await self._write_config_unlocked(config)
            return list(config["dailySummaryTimes"])

    async def removeNotifyTime(self, time_text: str) -> list[str]:
        async with self._lock:
            config = await self._read_config_unlocked()
            times = set(config.get("dailySummaryTimes", ["15:00"]))
            times.discard(time_text)
            config["dailySummaryTimes"] = sorted(times)
            await self._write_config_unlocked(config)
            return list(config["dailySummaryTimes"])

    async def _read_config(self) -> dict[str, object]:
        async with self._lock:
            return await self._read_config_unlocked()

    async def _read_config_unlocked(self) -> dict[str, object]:
        def _read() -> dict[str, object]:
            if not self._path.exists():
                return self._default_config()
            with self._path.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
            config = self._default_config()
            config.update(payload)
            config["dailySummaryTimes"] = sorted(
                {
                    str(item)
                    for item in payload.get("dailySummaryTimes", config["dailySummaryTimes"])
                }
            )
            return config

        return await asyncio.to_thread(_read)

    async def _write_config_unlocked(self, config: dict[str, object]) -> None:
        def _write() -> None:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            temp_path = self._path.with_suffix(".tmp")
            with temp_path.open("w", encoding="utf-8") as handle:
                json.dump(config, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            temp_path.replace(self._path)

        await asyncio.to_thread(_write)

    @staticmethod
    def _default_config() -> dict[str, object]:
        return {
            "timezone": "Asia/Tokyo",
            "notifyChannelId": None,
            "dailySummaryTimes": ["15:00"],
        }
