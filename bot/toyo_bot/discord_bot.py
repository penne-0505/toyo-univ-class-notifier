from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import discord
from discord import app_commands
from discord.ext import commands, tasks

from .config import Settings
from .models import Assignment, ClassSummary, Summary
from .summary_service import SummaryService
from .sync_service import SyncResult, SyncService

logger = logging.getLogger(__name__)

DEFAULT_NOTIFY_TIMES = ("07:00", "22:00")
ASSIGNMENT_RECORD_RETENTION_DAYS = 60


def _parse_time(value: str) -> str:
    parts = value.strip().split(":")
    if len(parts) != 2:
        raise ValueError("HH:MM 形式で入力してください。")
    hour, minute = int(parts[0]), int(parts[1])
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError("00:00 〜 23:59 の範囲で入力してください。")
    return f"{hour:02d}:{minute:02d}"


class BotState:
    """Persists notify channel, schedule, and notification dedup keys to a JSON file."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = asyncio.Lock()
        self._data: dict = {}
        self._load()

    def _load(self) -> None:
        try:
            self._data = json.loads(self._path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            self._data = {}

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps(self._data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    async def get_notify_channel_id(self) -> int | None:
        async with self._lock:
            raw = self._data.get("notify_channel_id")
            return int(raw) if raw else None

    async def set_notify_channel_id(self, channel_id: int) -> None:
        async with self._lock:
            self._data["notify_channel_id"] = channel_id
            self._save()

    async def get_notify_times(self) -> tuple[str, ...]:
        async with self._lock:
            stored = self._data.get("notify_times")
            return tuple(stored) if stored is not None else DEFAULT_NOTIFY_TIMES

    async def set_notify_times(self, times: tuple[str, ...]) -> None:
        async with self._lock:
            self._data["notify_times"] = list(times)
            self._save()

    async def get_remind_before_minutes(self) -> int:
        async with self._lock:
            stored = self._data.get("remind_before_minutes")
            return int(stored) if stored is not None else 180

    async def set_remind_before_minutes(self, minutes: int) -> None:
        async with self._lock:
            self._data["remind_before_minutes"] = minutes
            self._save()

    async def was_sent(self, key: str) -> bool:
        async with self._lock:
            return key in self._data.get("sent_keys", {})

    async def mark_sent(self, key: str) -> None:
        async with self._lock:
            sent = self._data.setdefault("sent_keys", {})
            sent[key] = datetime.now(timezone.utc).isoformat()
            cutoff = (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
            self._data["sent_keys"] = {k: v for k, v in sent.items() if v >= cutoff}
            self._save()

    async def get_known_assignment_ids(self) -> set[str]:
        async with self._lock:
            return set(self._assignment_records_unlocked().keys())

    async def save_assignment_snapshot(
        self, assignments: tuple[Assignment, ...], seen_at: datetime
    ) -> None:
        async with self._lock:
            records = self._assignment_records_unlocked()
            cutoff = seen_at - timedelta(days=ASSIGNMENT_RECORD_RETENTION_DAYS)
            pruned: dict[str, dict[str, Any]] = {}
            for assignment_id, record in records.items():
                last_seen_raw = str(record.get("last_seen_at", ""))
                try:
                    last_seen = datetime.fromisoformat(last_seen_raw)
                except ValueError:
                    continue
                if last_seen >= cutoff:
                    pruned[assignment_id] = record

            seen_at_text = seen_at.isoformat()
            for assignment in assignments:
                previous = pruned.get(assignment.assignment_id, {})
                pruned[assignment.assignment_id] = {
                    "first_seen_at": str(previous.get("first_seen_at") or seen_at_text),
                    "last_seen_at": seen_at_text,
                    "course_name": assignment.course_name,
                    "title": assignment.title,
                    "due_at": assignment.due_at.isoformat() if assignment.due_at else None,
                    "status": assignment.status,
                }

            assignment_state = self._data.setdefault("assignment_notifications", {})
            assignment_state["known_assignments"] = pruned
            self._save()

    async def record_sync_failure(self, result: SyncResult) -> int:
        async with self._lock:
            state = self._data.setdefault("sync_failure", {})
            count = int(state.get("consecutive_count") or 0) + 1
            state["consecutive_count"] = count
            state["last_failed_at"] = result.finished_at.isoformat()
            state["last_error_message"] = result.error_message or "Unknown error"
            self._save()
            return count

    async def reset_sync_failures(self) -> None:
        async with self._lock:
            state = self._data.setdefault("sync_failure", {})
            if state.get("consecutive_count") == 0:
                return
            state["consecutive_count"] = 0
            state["last_recovered_at"] = datetime.now(timezone.utc).isoformat()
            self._save()

    async def should_warn_sync_failure(self, warning_date: str) -> bool:
        async with self._lock:
            state = self._data.setdefault("sync_failure", {})
            count = int(state.get("consecutive_count") or 0)
            return count >= 3 and state.get("last_warning_date") != warning_date

    async def mark_sync_failure_warned(self, warning_date: str) -> None:
        async with self._lock:
            state = self._data.setdefault("sync_failure", {})
            state["last_warning_date"] = warning_date
            self._save()

    def _assignment_records_unlocked(self) -> dict[str, dict[str, Any]]:
        assignment_state = self._data.setdefault("assignment_notifications", {})
        records = assignment_state.get("known_assignments", {})
        if not isinstance(records, dict):
            assignment_state["known_assignments"] = {}
            return {}
        normalized: dict[str, dict[str, Any]] = {}
        for assignment_id, record in records.items():
            if isinstance(record, dict):
                normalized[str(assignment_id)] = record
        assignment_state["known_assignments"] = normalized
        return normalized


class ToyoBotCog(commands.Cog):
    def __init__(
        self,
        bot: commands.Bot,
        *,
        settings: Settings,
        state: BotState,
        summary_service: SummaryService,
        sync_service: SyncService,
    ) -> None:
        self.bot = bot
        self.settings = settings
        self.state = state
        self.summary_service = summary_service
        self.sync_service = sync_service

    async def cog_load(self) -> None:
        self.sync_loop.change_interval(seconds=self.settings.sync_interval_seconds)
        self.sync_loop.start()
        self.notification_loop.start()

    async def cog_unload(self) -> None:
        self.sync_loop.cancel()
        self.notification_loop.cancel()

    # ── background loops ────────────────────────────────────────────────────

    @tasks.loop(seconds=1800)
    async def sync_loop(self) -> None:
        result = await self.sync_service.runSync()
        if result.success:
            await self.state.reset_sync_failures()
            return
        failure_count = await self.state.record_sync_failure(result)
        if failure_count >= 3:
            await self._notify_sync_failure(result, failure_count)

    @sync_loop.before_loop
    async def before_sync_loop(self) -> None:
        await self.bot.wait_until_ready()

    @tasks.loop(seconds=60)
    async def notification_loop(self) -> None:
        summary = await self._safe_load_summary()
        if summary is None:
            return

        now = datetime.now(self.settings.timezone)
        channel = await self._get_notify_channel()
        if channel is None:
            return

        notify_times = await self.state.get_notify_times()
        remind_minutes = await self.state.get_remind_before_minutes()

        # daily summary at configured times
        for time_text in notify_times:
            if self.summary_service.should_send_daily(now, time_text):
                key = self.summary_service.daily_key(now, time_text)
                if not await self.state.was_sent(key):
                    known_assignment_ids = await self.state.get_known_assignment_ids()
                    new_assignment_ids = {
                        assignment.assignment_id
                        for assignment in summary.upcoming_assignments
                        if assignment.assignment_id not in known_assignment_ids
                    } if summary.ace_available else set()

                    await channel.send(
                        self.summary_service.format_daily_summary(
                            summary,
                            new_assignment_ids=new_assignment_ids,
                        )
                    )
                    if summary.ace_available:
                        await self.state.save_assignment_snapshot(summary.upcoming_assignments, now)
                    await self.state.mark_sent(key)

        # class reminder
        if self.summary_service.should_send_reminder(summary, now, remind_minutes):
            assert summary.next_class is not None
            key = self.summary_service.reminder_key(summary.next_class)
            if not await self.state.was_sent(key):
                msg = self.summary_service.format_reminder(summary, remind_minutes)
                if msg:
                    await channel.send(msg)
                    await self.state.mark_sent(key)

    @notification_loop.before_loop
    async def before_notification_loop(self) -> None:
        await self.bot.wait_until_ready()

    # ── slash commands ───────────────────────────────────────────────────────

    @app_commands.command(name="today", description="今日の授業・課題・お知らせを表示します。")
    async def today_command(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer()
        summary = await self._require_summary(interaction)
        if summary is None:
            return
        await interaction.followup.send(self.summary_service.format_today(summary))

    @app_commands.command(name="tomorrow", description="明日の授業・課題・お知らせを表示します。")
    async def tomorrow_command(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer()
        summary = await self._require_summary(interaction)
        if summary is None:
            return
        await interaction.followup.send(self.summary_service.format_tomorrow(summary))

    @app_commands.command(name="assignments", description="未提出課題一覧を表示します。")
    async def assignments_command(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer()
        summary = await self._require_summary(interaction)
        if summary is None:
            return
        await interaction.followup.send(self.summary_service.format_assignments(summary))

    @app_commands.command(name="announcements", description="休講・補講・教室変更のお知らせを表示します。")
    async def announcements_command(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer()
        summary = await self._require_summary(interaction)
        if summary is None:
            return
        await interaction.followup.send(self.summary_service.format_announcements(summary))

    @app_commands.command(name="status", description="データ取得状態と同期ログを表示します。")
    async def status_command(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True)
        summary = await self._require_summary(interaction)
        if summary is None:
            return
        last = self.sync_service.getLastResult()
        await interaction.followup.send(
            self.summary_service.format_status(summary, last.describe() if last else None),
            ephemeral=True,
        )

    @app_commands.command(name="refresh", description="その場で同期を実行します。")
    async def refresh_command(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)
        result = await self.sync_service.runSync()
        if not result.success:
            await interaction.followup.send(
                f"同期に失敗しました。\n{result.error_message or 'Unknown error'}",
                ephemeral=True,
            )
            return
        await self.state.reset_sync_failures()
        summary = await self._safe_load_summary()
        msg = "同期が完了しました。"
        if summary is not None:
            msg += f"\n\n{self.summary_service.format_today(summary)}"
        await interaction.followup.send(msg, ephemeral=True)

    @app_commands.command(
        name="setchannel",
        description="定期通知の送信先チャンネルを設定します。",
    )
    async def setchannel_command(
        self,
        interaction: discord.Interaction,
        channel: discord.TextChannel | None = None,
    ) -> None:
        target = channel or interaction.channel
        if not isinstance(target, discord.TextChannel):
            await interaction.response.send_message(
                "テキストチャンネルで実行するか、`channel` を指定してください。",
                ephemeral=True,
            )
            return
        await self.state.set_notify_channel_id(target.id)
        await interaction.response.send_message(
            f"通知先を {target.mention} に設定しました。",
            ephemeral=True,
        )

    @app_commands.command(name="addtime", description="日次サマリーの通知時刻を追加します（JST HH:MM）。")
    async def addtime_command(self, interaction: discord.Interaction, time: str) -> None:
        try:
            normalized = _parse_time(time)
        except ValueError as e:
            await interaction.response.send_message(str(e), ephemeral=True)
            return
        current = await self.state.get_notify_times()
        if normalized in current:
            await interaction.response.send_message(
                f"`{normalized}` はすでに設定されています。", ephemeral=True
            )
            return
        updated = (*current, normalized)
        await self.state.set_notify_times(updated)
        await interaction.response.send_message(
            f"通知時刻を追加しました。現在: {', '.join(sorted(updated)) or 'なし'}",
            ephemeral=True,
        )

    @app_commands.command(name="removetime", description="日次サマリーの通知時刻を削除します（JST HH:MM）。")
    async def removetime_command(self, interaction: discord.Interaction, time: str) -> None:
        try:
            normalized = _parse_time(time)
        except ValueError as e:
            await interaction.response.send_message(str(e), ephemeral=True)
            return
        current = await self.state.get_notify_times()
        updated = tuple(t for t in current if t != normalized)
        await self.state.set_notify_times(updated)
        await interaction.response.send_message(
            f"通知時刻を更新しました。現在: {', '.join(sorted(updated)) or 'なし'}",
            ephemeral=True,
        )

    @app_commands.command(name="listtimes", description="通知設定の一覧を表示します。")
    async def listtimes_command(self, interaction: discord.Interaction) -> None:
        times = await self.state.get_notify_times()
        remind = await self.state.get_remind_before_minutes()
        channel_id = await self.state.get_notify_channel_id()
        channel_text = f"<#{channel_id}>" if channel_id else "未設定"
        await interaction.response.send_message(
            f"**通知設定**\n"
            f"チャンネル: {channel_text}\n"
            f"日次サマリー時刻（JST）: {', '.join(sorted(times)) or 'なし'}\n"
            f"授業リマインド: {remind}分前",
            ephemeral=True,
        )

    @app_commands.command(name="setreminder", description="授業リマインドを何分前に送るか設定します。")
    async def setreminder_command(self, interaction: discord.Interaction, minutes: int) -> None:
        if minutes < 1 or minutes > 1440:
            await interaction.response.send_message(
                "1〜1440 の範囲で指定してください。", ephemeral=True
            )
            return
        await self.state.set_remind_before_minutes(minutes)
        await interaction.response.send_message(
            f"授業リマインドを {minutes}分前 に設定しました。", ephemeral=True
        )

    # ── helpers ──────────────────────────────────────────────────────────────

    async def _safe_load_summary(self) -> Summary | None:
        try:
            return await self.summary_service.load()
        except FileNotFoundError:
            return None
        except Exception:
            logger.exception("Failed to load summary")
            return None

    async def _require_summary(self, interaction: discord.Interaction) -> Summary | None:
        summary = await self._safe_load_summary()
        if summary is None:
            await interaction.followup.send(
                "summary.json がありません。先に `/refresh` を実行してください。"
            )
        return summary

    async def _get_notify_channel(self) -> discord.TextChannel | None:
        channel_id = await self.state.get_notify_channel_id()
        if channel_id is None:
            return None
        channel = self.bot.get_channel(channel_id)
        if isinstance(channel, discord.TextChannel):
            return channel
        try:
            fetched = await self.bot.fetch_channel(channel_id)
        except discord.DiscordException:
            logger.exception("Failed to fetch notify channel %s", channel_id)
            return None
        return fetched if isinstance(fetched, discord.TextChannel) else None

    async def _notify_sync_failure(self, result: SyncResult, failure_count: int) -> None:
        channel = await self._get_notify_channel()
        if channel is None:
            return
        warning_date = datetime.now(self.settings.timezone).date().isoformat()
        if not await self.state.should_warn_sync_failure(warning_date):
            return
        await channel.send(
            "⚠️ 同期が3回以上連続で失敗しています。\n"
            f"連続失敗: {failure_count}回\n"
            f"エラー: {result.error_message or 'Unknown error'}\n"
            "本日の同期失敗警告はこれ以降省略します。"
        )
        await self.state.mark_sync_failure_warned(warning_date)


class ToyoDiscordBot(commands.Bot):
    def __init__(self, settings: Settings) -> None:
        intents = discord.Intents.none()
        super().__init__(command_prefix="!", intents=intents)
        self.settings = settings
        self._state = BotState(settings.state_path)
        self._summary_service = SummaryService(settings.summary_path, settings.timezone)
        self._sync_service = SyncService(settings.sync_command, settings.repo_root)

    async def setup_hook(self) -> None:
        await self.add_cog(
            ToyoBotCog(
                self,
                settings=self.settings,
                state=self._state,
                summary_service=self._summary_service,
                sync_service=self._sync_service,
            )
        )

        if self.settings.guild_id is not None:
            guild = discord.Object(id=self.settings.guild_id)
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
            logger.info("Synced slash commands to guild %s", self.settings.guild_id)
            return

        await self.tree.sync()
        logger.info("Synced global slash commands")
