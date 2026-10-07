# デプロイ（systemd ユーザータイマー）

取得データを private repo `penne-0505/toyo-data`（ローカル clone は `~/toyo-data`）へ定期 push する仕組みです。読み手はクラウドのエージェント（Worker の REST / `toyo-data` repo）です。

| ユニット | 間隔 | 内容 |
| --- | --- | --- |
| `toyo-watch` | 5 分ごと（`*:0/5`） | ACE の未提出課題とお知らせだけ取得し、変化があれば summary / agent-context を再生成して publish |
| `toyo-daily` | 毎日 04:30 JST（`Persistent=true`） | 全取得（coursework → sync → credits → lottery → context）→ `toyo:publish --include-candidates --force` |
| `toyo-coursework` | 毎時 :20 | ACE のコース別提出状況（レポート / 小テスト / アンケート / 成績 / 提出記録）を取得 → `toyo:build`（index → summary → context）→ `toyo:context -- --no-sync`（互換のため残しており、context を作り直すだけ）→ `toyo:publish`。`flock -w 600` でロック待ち、`TimeoutStartSec=900` |

- watch・daily・coursework は `flock /tmp/toyo-fetch.lock` で排他します（Playwright セッションは同時に 1 つ）。watch はロック中なら何もせず正常終了（終了コード 75 を成功扱い）、daily は最大 15 分、coursework は最大 10 分ロックを待ちます。
- watch は連続失敗 2 回で 15 分、4 回で 30 分スキップします（`state/watch-state.json`）。成功すると解除されます。systemd 側は 5 分固定のままです。
- 3 つの service は `ExecStopPost=-/usr/bin/bash deploy/toyo-health-hook.sh <job>` で成否を `toyo:health` に記録します。連続失敗が閾値（watch 3 / coursework 2 / daily 1）に達すると通知し、回復でも通知します（`flock -n -E 75` のスキップは記録しません）。送り先（Discord webhook / ntfy / notify-send）の設定と `status` の見方は `docs/toyo-automation-runbook.md` の「失敗の検知と通知」。
- `PATH` は `/home/penne/.volta/bin:/usr/bin:/bin` に固定しています。node の場所が変わったらユニットの `Environment=PATH=` を直してください（`which node` で確認）。

## インストール

```bash
bash deploy/install-timers.sh
```

`~/.config/systemd/user/` にユニットをコピーし、`daemon-reload` → `enable --now` までを行います。ユニットを編集したら再度実行してください（`ExecStopPost` が呼ぶ `deploy/toyo-health-hook.sh` はリポジトリ内を直接参照するので、コピーは不要です）。

ログアウト中も動かすには linger が必要です（この環境では有効化済み。確認: `loginctl show-user $USER -p Linger`）。

## 確認

```bash
systemctl --user list-timers 'toyo-*'
journalctl --user -u toyo-watch -n 20 --no-pager
journalctl --user -u toyo-daily -n 50 --no-pager
journalctl --user -u toyo-coursework -n 30 --no-pager
cat state/watch-state.json          # 連続失敗回数・次回許可時刻（バックオフ用）
npm run toyo:health -- status       # ジョブごとの最終成功・連続失敗・アラート状態（アラート中なら終了コード 1）
npm run toyo:health -- test-notify  # 通知の送り先のテスト
git -C ~/toyo-data log --oneline -5
```

手動実行は `npm run toyo:watch` / `npm run toyo:daily` / `npm run toyo:publish -- --dry-run`。サービス経由なら `systemctl --user start toyo-watch.service`。

## 停止・削除

```bash
systemctl --user disable --now toyo-watch.timer toyo-daily.timer toyo-coursework.timer   # 停止のみ
bash deploy/install-timers.sh --uninstall                           # ユニットも削除
```

ログイン切れ（`toyo:login` が必要な状態）が続くと watch は失敗扱いになり、バックオフします。復旧後は `rm state/watch-state.json` で即座に再開できます。
