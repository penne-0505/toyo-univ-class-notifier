#!/usr/bin/env bash
# toyo-watch / toyo-daily / toyo-coursework の systemd ユーザータイマーを登録して有効化する。
# 使い方: bash deploy/install-timers.sh [--uninstall]
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/systemd" && pwd)"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNITS=(toyo-watch.service toyo-watch.timer toyo-daily.service toyo-daily.timer toyo-coursework.service toyo-coursework.timer)

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now toyo-watch.timer toyo-daily.timer toyo-coursework.timer || true
  for u in "${UNITS[@]}"; do rm -f "$DEST/$u"; done
  systemctl --user daemon-reload
  echo "uninstalled."
  exit 0
fi

mkdir -p "$DEST"
for u in "${UNITS[@]}"; do
  install -m 0644 "$SRC/$u" "$DEST/$u"
done
systemctl --user daemon-reload
systemctl --user enable --now toyo-watch.timer toyo-daily.timer toyo-coursework.timer
systemctl --user list-timers 'toyo-*'
