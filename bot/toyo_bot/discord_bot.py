from __future__ import annotations

import logging
from datetime import datetime, timedelta

import discord
from discord import app_commands
from discord.ext import commands, tasks

from .config import Settings
from .repositories import (
    JsonConfigRepository,
    JsonNotificationStateRepository,
    NotifyChannelRepository,
    NotifyScheduleRepository,
    NotificationStateRepository,
)
from .summary_service import SummaryService
from .sync_service import SyncResult, SyncService

logger = logging.getLogger(__name__)


def normalize_time_text(time_text: str) -> str:
    pieces = time_text.strip().split(":")
    if len(pieces) != 2:
        raise ValueError("時刻は HH:MM 形式で指定してください。")
    hour = int(pieces[0])
    minute = int(pieces[1])
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        raise ValueError("時刻は 00:00 から 23:59 の範囲で指定してください。")
    return f"{hour:02d}:{minute:02d}"


class ToyoBotCog(commands.Cog):
    def __init__(
        self,
        bot: commands.Bot,
        *,
        settings: Settings,
        channel_repository: NotifyChannelRepository,
        schedule_repository: NotifyScheduleRepository,
        notification_state_repository: NotificationStateRepository,
        summary_service: SummaryService,
        sync_service: SyncService,
    ) -> None:
        self.bot = bot
        self.settings = settings
        self.channel_repository = channel_repository
        self.schedule_repository = schedule_repository
        self.notification_state_repository = notification_state_repository
        self.summary_service = summary_service
        self.sync_service = sync_service

    async def cog_load(self) -> None:
        self.sync_loop.change_interval(seconds=self.settings.summary_sync_interval_seconds)
        self.notification_loop.change_interval(
            seconds=self.settings.notification_check_interval_seconds
        )
        self.sync_loop.start()
        self.notification_loop.start()

    async def cog_unload(self) -> None:
        self.sync_loop.cancel()
        self.notification_loop.cancel()

    @tasks.loop(seconds=1800)
    async def sync_loop(self) -> None:
        result = await self.sync_service.runSync()
        if not result.success:
            await self._send_sync_failure_once(result)

    @sync_loop.before_loop
    async def before_sync_loop(self) -> None:
        await self.bot.wait_until_ready()

    @tasks.loop(seconds=60)
    async def notification_loop(self) -> None:
        await self.notification_state_repository.pruneOlderThan(
            datetime.now(self.settings.timezone) - timedelta(days=14)
        )

        summary = await self._safe_load_summary()
        if summary is None:
            return

        now = datetime.now(self.settings.timezone)
        channel = await self._get_notify_channel()
        if channel is None:
            return

        for time_text in await self.schedule_repository.listNotifyTimes():
            if not self.summary_service.shouldSendDailySummary(now, time_text):
                continue
            key = self.summary_service.dailySummaryKey(now, time_text)
            if await self.notification_state_repository.wasSent(key):
                continue
            await channel.send(self.summary_service.buildDailySummaryMessage(summary))
            await self.notification_state_repository.markSent(key, now)

        if (
            summary.next_class is not None
            and self.summary_service.shouldSendClassReminder(summary, now)
        ):
            key = self.summary_service.reminderKey(summary.next_class)
            if not await self.notification_state_repository.wasSent(key):
                message = self.summary_service.buildClassReminderMessage(summary)
                if message:
                    await channel.send(message)
                    await self.notification_state_repository.markSent(key, now)

    @notification_loop.before_loop
    async def before_notification_loop(self) -> None:
        await self.bot.wait_until_ready()

    @app_commands.command(name="next", description="次コマと関連する提出物を表示します。")
    async def next_command(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer()
        summary = await self._safe_load_summary()
        if summary is None:
            await interaction.followup.send("summary.json がありません。先に `/refresh` を実行してください。")
            return
        await interaction.followup.send(self.summary_service.formatNextClass(summary))

    @app_commands.command(name="today", description="今日の授業一覧と近い提出物を表示します。")
    async def today_command(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer()
        summary = await self._safe_load_summary()
        if summary is None:
            await interaction.followup.send("summary.json がありません。先に `/refresh` を実行してください。")
            return
        await interaction.followup.send(self.summary_service.formatToday(summary))

    @app_commands.command(name="status", description="収集状態と直近同期状態を表示します。")
    async def status_command(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True)
        summary = await self._safe_load_summary()
        if summary is None:
            await interaction.followup.send("summary.json がありません。先に `/refresh` を実行してください。")
            return
        last_result = self.sync_service.getLastResult()
        last_status = last_result.describe() if last_result else None
        await interaction.followup.send(
            self.summary_service.formatStatus(summary, last_status),
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

        summary = await self._safe_load_summary()
        message = "同期が完了しました。"
        if summary is not None:
            message = f"{message}\n\n{self.summary_service.formatNextClass(summary)}"
        await interaction.followup.send(message, ephemeral=True)

    @app_commands.command(
        name="setchannel",
        description="定期通知の送信先チャンネルを設定します。",
    )
    async def setchannel_command(
        self,
        interaction: discord.Interaction,
        channel: discord.TextChannel | None = None,
    ) -> None:
        target_channel = channel or interaction.channel
        if not isinstance(target_channel, discord.TextChannel):
            await interaction.response.send_message(
                "テキストチャンネルで実行するか、`channel` を指定してください。",
                ephemeral=True,
            )
            return

        await self.channel_repository.setNotifyChannel(str(target_channel.id))
        await interaction.response.send_message(
            f"通知先を {target_channel.mention} に設定しました。",
            ephemeral=True,
        )

    @app_commands.command(name="addtime", description="JST の定期通知時刻を追加します。")
    async def addtime_command(self, interaction: discord.Interaction, time: str) -> None:
        try:
            normalized = normalize_time_text(time)
        except ValueError as error:
            await interaction.response.send_message(str(error), ephemeral=True)
            return

        times = await self.schedule_repository.addNotifyTime(normalized)
        await interaction.response.send_message(
            f"定期通知時刻を追加しました。JST: {', '.join(times)}",
            ephemeral=True,
        )

    @app_commands.command(name="removetime", description="JST の定期通知時刻を削除します。")
    async def removetime_command(self, interaction: discord.Interaction, time: str) -> None:
        try:
            normalized = normalize_time_text(time)
        except ValueError as error:
            await interaction.response.send_message(str(error), ephemeral=True)
            return

        times = await self.schedule_repository.removeNotifyTime(normalized)
        await interaction.response.send_message(
            f"定期通知時刻を更新しました。JST: {', '.join(times) if times else 'なし'}",
            ephemeral=True,
        )

    @app_commands.command(name="listtimes", description="JST の定期通知時刻一覧を表示します。")
    async def listtimes_command(self, interaction: discord.Interaction) -> None:
        times = await self.schedule_repository.listNotifyTimes()
        await interaction.response.send_message(
            f"定期通知時刻は JST で {', '.join(times) if times else '未設定'} です。",
            ephemeral=True,
        )

    async def _safe_load_summary(self):
        try:
            return await self.summary_service.loadSummary()
        except FileNotFoundError:
            return None
        except Exception:
            logger.exception("Failed to load summary")
            return None

    async def _get_notify_channel(self) -> discord.TextChannel | None:
        channel_id = await self.channel_repository.getNotifyChannel()
        if channel_id is None:
            return None
        channel = self.bot.get_channel(int(channel_id))
        if isinstance(channel, discord.TextChannel):
            return channel
        try:
            fetched = await self.bot.fetch_channel(int(channel_id))
        except discord.DiscordException:
            logger.exception("Failed to fetch notify channel %s", channel_id)
            return None
        return fetched if isinstance(fetched, discord.TextChannel) else None

    async def _send_sync_failure_once(self, result: SyncResult) -> None:
        channel = await self._get_notify_channel()
        if channel is None:
            return

        key = f"sync-error:{result.finished_at.date().isoformat()}:{result.error_message}"
        if await self.notification_state_repository.wasSent(key):
            return

        await channel.send(
            "同期に失敗しました。再ログインや収集先の確認が必要かもしれません。\n"
            f"{result.error_message or 'Unknown error'}"
        )
        await self.notification_state_repository.markSent(
            key,
            datetime.now(self.settings.timezone),
        )


class ToyoDiscordBot(commands.Bot):
    def __init__(self, settings: Settings) -> None:
        intents = discord.Intents.none()
        super().__init__(command_prefix="!", intents=intents)
        self.settings = settings
        self._config_repository = JsonConfigRepository(settings.config_path)
        self._notification_state_repository = JsonNotificationStateRepository(
            settings.notification_state_path
        )
        self._summary_service = SummaryService(settings.summary_path, settings.timezone)
        self._sync_service = SyncService(settings.sync_command, settings.repo_root)

    async def setup_hook(self) -> None:
        await self.add_cog(
            ToyoBotCog(
                self,
                settings=self.settings,
                channel_repository=self._config_repository,
                schedule_repository=self._config_repository,
                notification_state_repository=self._notification_state_repository,
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
