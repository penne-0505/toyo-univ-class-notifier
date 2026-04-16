from __future__ import annotations

import os
import shlex
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo


@dataclass(frozen=True, slots=True)
class Settings:
    discord_token: str
    repo_root: Path
    summary_path: Path
    config_path: Path
    notification_state_path: Path
    sync_command: tuple[str, ...]
    guild_id: int | None
    timezone: ZoneInfo
    summary_sync_interval_seconds: int
    notification_check_interval_seconds: int


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _load_dotenv(dotenv_path: Path) -> None:
    if not dotenv_path.exists():
        return

    for raw_line in dotenv_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        separator_index = line.find("=")
        if separator_index <= 0:
            continue

        key = line[:separator_index].strip()
        value = line[separator_index + 1 :].strip()
        if not key or key in os.environ:
            continue

        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]

        os.environ[key] = value


def load_settings() -> Settings:
    repo_root = _repo_root()
    _load_dotenv(repo_root / "bot" / ".env")
    discord_token = os.environ.get("DISCORD_TOKEN", "").strip()
    if not discord_token:
        raise RuntimeError("DISCORD_TOKEN is required.")

    summary_path = Path(
        os.environ.get("TOYO_SUMMARY_PATH", repo_root / "output" / "bot" / "summary.json")
    )
    config_path = Path(
        os.environ.get("TOYO_DISCORD_CONFIG_PATH", repo_root / "state" / "discord-config.json")
    )
    notification_state_path = Path(
        os.environ.get(
            "TOYO_NOTIFICATION_STATE_PATH",
            repo_root / "state" / "discord-notification-state.json",
        )
    )

    sync_command_raw = os.environ.get("TOYO_SYNC_COMMAND", "npm run toyo:sync")
    sync_command = tuple(shlex.split(sync_command_raw))
    if not sync_command:
        raise RuntimeError("TOYO_SYNC_COMMAND resolved to an empty command.")

    guild_id_raw = os.environ.get("DISCORD_GUILD_ID")
    guild_id = int(guild_id_raw) if guild_id_raw else None

    return Settings(
        discord_token=discord_token,
        repo_root=repo_root,
        summary_path=summary_path,
        config_path=config_path,
        notification_state_path=notification_state_path,
        sync_command=sync_command,
        guild_id=guild_id,
        timezone=ZoneInfo("Asia/Tokyo"),
        summary_sync_interval_seconds=30 * 60,
        notification_check_interval_seconds=60,
    )
