# Toyo Discord Bot

`output/bot/summary.json` を読んで Discord に表示する薄い wrapper です。LLM 推論はせず、機械的にデータを表示するためのインターフェースです。

## セットアップ

```bash
cd bot
uv sync
uv run toyo-discord-bot
```

`uv run` 時に `bot/.env` が自動で読み込まれます。

### Fedora で常駐させる場合

初回はデスクトップセッション上でリポジトリルートから `npm run toyo:login` を実行し、保存セッションを作ります。その後、Bot は user systemd service として常駐できます。

`~/.config/systemd/user/toyo-discord-bot.service`:

```ini
[Unit]
Description=Toyo Discord Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/dev/scratch/toyo-univ-analyze/bot
ExecStart=/usr/bin/env uv run toyo-discord-bot
Restart=on-failure
RestartSec=30
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now toyo-discord-bot.service
systemctl --user status toyo-discord-bot.service
```

ログは `journalctl --user -u toyo-discord-bot.service -f` で確認します。リポジトリの配置先が異なる場合は `WorkingDirectory` を変更してください。

## 環境変数

`bot/.env` に保存します。

| 変数 | 内容 |
|------|------|
| `DISCORD_TOKEN` | **必須** |
| `DISCORD_GUILD_ID` | 任意。開発時のSlash Command即時反映用 |

通知先チャンネル・通知時刻・リマインド分は **Slashコマンドで設定**し、`state/discord-bot-state.json` に永続化されます。通知時刻の既定値は `07:00` / `22:00`（JST）です。

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
- **日次サマリー**: `/addtime` で設定した時刻（JST）に当日の授業・課題・お知らせを送信。未設定時は `07:00` / `22:00`
- **課題チェック**: 日次サマリー内で新規課題と期限順の未提出上位3件を送信。初回導入時は現在の未提出課題を新規として扱う
- **授業リマインド**: 次の授業の N 分前（既定: 180分前）に通知
- **同期失敗警告**: `npm run toyo:sync` が3回連続で失敗したら通知。警告は1日1回まで

## 永続化ファイル

`state/discord-bot-state.json`:

```json
{
  "notify_channel_id": 123456789,
  "notify_times": ["07:00", "22:00"],
  "remind_before_minutes": 180,
  "assignment_notifications": {
    "known_assignments": {
      "assignment-id": {
        "first_seen_at": "2026-05-26T07:00:00+09:00",
        "last_seen_at": "2026-05-26T07:00:00+09:00",
        "course_name": "科目名",
        "title": "課題名",
        "due_at": "2026-05-30T23:59:00+09:00",
        "status": "pending"
      }
    }
  },
  "sync_failure": {
    "consecutive_count": 0,
    "last_warning_date": "2026-05-26"
  },
  "sent_keys": { ... }
}
```

`sent_keys` は通知重複防止用で、14日経過したものは自動でprune されます。
`assignment_notifications.known_assignments` は新規課題判定用で、最終確認から60日経過した課題は自動でprune されます。
