# デプロイ（systemd ユーザータイマー）

取得データを private repo `penne-0505/toyo-data`（ローカル clone は `~/toyo-data`）へ定期 push する仕組みです。Discord bot とは独立しており、bot は `output/` を読むだけです。

| ユニット | 間隔 | 内容 |
| --- | --- | --- |
| `toyo-watch` | 5 分ごと（`*:0/5`） | ACE の未提出課題とお知らせだけ取得し、変化があれば summary / agent-context を再生成して publish |
| `toyo-daily` | 毎日 04:30 JST（`Persistent=true`） | 全取得（sync → credits → lottery → context）→ `toyo:publish --include-candidates --force` |

- watch と daily は `flock /tmp/toyo-fetch.lock` で排他します。watch はロック中なら何もせず正常終了（終了コード 75 を成功扱い）、daily は最大 15 分ロックを待ちます。
- watch は連続失敗 2 回で 15 分、4 回で 30 分スキップします（`state/watch-state.json`）。成功すると解除されます。systemd 側は 5 分固定のままです。
- `PATH` は `/home/penne/.volta/bin:/usr/bin:/bin` に固定しています。node の場所が変わったらユニットの `Environment=PATH=` を直してください（`which node` で確認）。

## インストール

```bash
bash deploy/install-timers.sh
```

`~/.config/systemd/user/` にユニットをコピーし、`daemon-reload` → `enable --now` までを行います。ユニットを編集したら再度実行してください。

ログアウト中も動かすには linger が必要です（この環境では有効化済み。確認: `loginctl show-user $USER -p Linger`）。

## 確認

```bash
systemctl --user list-timers 'toyo-*'
journalctl --user -u toyo-watch -n 20 --no-pager
journalctl --user -u toyo-daily -n 50 --no-pager
cat state/watch-state.json          # 連続失敗回数・次回許可時刻
git -C ~/toyo-data log --oneline -5
```

手動実行は `npm run toyo:watch` / `npm run toyo:daily` / `npm run toyo:publish -- --dry-run`。サービス経由なら `systemctl --user start toyo-watch.service`。

## 停止・削除

```bash
systemctl --user disable --now toyo-watch.timer toyo-daily.timer   # 停止のみ
bash deploy/install-timers.sh --uninstall                           # ユニットも削除
```

ログイン切れ（`toyo:login` が必要な状態）が続くと watch は失敗扱いになり、バックオフします。復旧後は `rm state/watch-state.json` で即座に再開できます。
