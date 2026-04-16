from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


@dataclass(frozen=True, slots=True)
class SyncResult:
    success: bool
    started_at: datetime
    finished_at: datetime
    stdout: str
    stderr: str
    error_message: str | None = None

    def describe(self) -> str:
        if self.success:
            return f"成功 ({self.finished_at.isoformat()})"
        if self.error_message:
            return f"失敗 ({self.finished_at.isoformat()}): {self.error_message}"
        return f"失敗 ({self.finished_at.isoformat()})"


class SyncService:
    def __init__(self, command: tuple[str, ...], workdir: Path) -> None:
        self._command = command
        self._workdir = workdir
        self._lock = asyncio.Lock()
        self._last_result: SyncResult | None = None

    async def runSync(self) -> SyncResult:
        async with self._lock:
            started_at = datetime.now(timezone.utc)
            process = await asyncio.create_subprocess_exec(
                *self._command,
                cwd=str(self._workdir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_bytes, stderr_bytes = await process.communicate()
            finished_at = datetime.now(timezone.utc)
            stdout = stdout_bytes.decode("utf-8", errors="replace")
            stderr = stderr_bytes.decode("utf-8", errors="replace")
            success = process.returncode == 0
            result = SyncResult(
                success=success,
                started_at=started_at,
                finished_at=finished_at,
                stdout=stdout,
                stderr=stderr,
                error_message=None if success else (stderr.strip() or stdout.strip() or "Unknown error"),
            )
            self._last_result = result
            return result

    def getLastResult(self) -> SyncResult | None:
        return self._last_result
