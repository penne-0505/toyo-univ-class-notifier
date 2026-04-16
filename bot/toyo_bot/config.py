from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv


@dataclass(frozen=True, slots=True)
class Settings:
    discord_token: str
    repo_root: Path
    summary_path: Path
    state_path: Path
    sync_command: tuple[str, ...]
    guild_id: int | None
    timezone: ZoneInfo
    sync_interval_seconds: int


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def load_settings() -> Settings:
    repo_root = _repo_root()
    load_dotenv(repo_root / "bot" / ".env")

    discord_token = os.environ.get("DISCORD_TOKEN", "").strip()
    if not discord_token:
        raise RuntimeError("DISCORD_TOKEN is required.")

    guild_id_raw = os.environ.get("DISCORD_GUILD_ID")
    guild_id = int(guild_id_raw) if guild_id_raw else None

    return Settings(
        discord_token=discord_token,
        repo_root=repo_root,
        summary_path=repo_root / "output" / "bot" / "summary.json",
        state_path=repo_root / "state" / "discord-bot-state.json",
        sync_command=("npm", "run", "toyo:sync"),
        guild_id=guild_id,
        timezone=ZoneInfo("Asia/Tokyo"),
        sync_interval_seconds=1800,
    )
