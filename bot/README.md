# Toyo Discord Bot

Discord から `output/bot/summary.json` を読む通知 Bot です。

- 通知時刻は `Asia/Tokyo`、つまり JST として扱います
- `/addtime 15:00` のような時刻も JST 解釈です
- 通知先チャンネルと時刻設定は `state/discord-config.json` に保存されます
- 送信済み通知の重複防止状態は `state/discord-notification-state.json` に保存されます

## 使い方

```bash
cd bot
uv sync
uv run toyo-discord-bot
```

`uv run` の前に `bot/.env` が自動で読み込まれます。

必要な環境変数:

- `DISCORD_TOKEN`
- `DISCORD_GUILD_ID` 任意。開発時にギルド単位で Slash Commands を即時反映したい場合に使います
- `TOYO_SYNC_COMMAND` 任意。既定は `npm run toyo:sync`

Bot は定期的に `TOYO_SYNC_COMMAND` を呼び、既定では 30 分ごとに `summary.json` を更新します。
