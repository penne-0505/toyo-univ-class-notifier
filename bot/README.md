# Toyo Discord Bot

`output/bot/summary.json` を読んで Discord に表示する薄い wrapper です。LLM 推論はせず、機械的にデータを表示するためのインターフェースです。

## セットアップ

```bash
cd bot
uv sync
uv run toyo-discord-bot
```

`uv run` 時に `bot/.env` が自動で読み込まれます。

## 環境変数

`bot/.env` に保存します。

| 変数 | 内容 |
|------|------|
| `DISCORD_TOKEN` | **必須** |
| `DISCORD_GUILD_ID` | 任意。開発時のSlash Command即時反映用 |

通知先チャンネル・通知時刻・リマインド分は **Slashコマンドで設定**し、`state/discord-bot-state.json` に永続化されます。

## Slash コマンド

### 表示系

| コマンド | 内容 |
|---------|------|
| `/today` | 今日の授業・関連課題・お知らせ |
| `/tomorrow` | 明日の授業・関連課題・お知らせ |
| `/assignments` | 未提出課題一覧（締切順） |
| `/announcements` | 休講・補講・教室変更のお知らせ |
| `/status` | データ取得状態と直近の同期結果 |

### 操作系

| コマンド | 内容 |
|---------|------|
| `/refresh` | その場で `npm run toyo:sync` を実行 |
| `/setchannel [#channel]` | 定期通知の送信先チャンネルを設定 |
| `/addtime HH:MM` | 日次サマリーの通知時刻を追加（JST） |
| `/removetime HH:MM` | 通知時刻を削除 |
| `/setreminder <minutes>` | 授業リマインドの送信タイミング（分前）を変更 |
| `/listtimes` | 現在の通知設定（チャンネル・時刻・リマインド分）を表示 |

## 定期実行

- **同期ループ**: 30分ごとに `npm run toyo:sync` を実行
- **日次サマリー**: `/addtime` で設定した時刻（JST）に当日の授業・課題・お知らせを送信
- **授業リマインド**: 次の授業の N 分前（既定: 180分前）に通知

## 永続化ファイル

`state/discord-bot-state.json`:

```json
{
  "notify_channel_id": 123456789,
  "notify_times": ["08:00", "15:00"],
  "remind_before_minutes": 180,
  "sent_keys": { ... }
}
```

`sent_keys` は通知重複防止用で、14日経過したものは自動でprune されます。
