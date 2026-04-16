from __future__ import annotations

import asyncio
import logging

from .config import load_settings
from .discord_bot import ToyoDiscordBot


async def _run() -> None:
    settings = load_settings()
    bot = ToyoDiscordBot(settings)
    async with bot:
        await bot.start(settings.discord_token)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(_run())


if __name__ == "__main__":
    main()
