#!/usr/bin/env bash
# systemd の ExecStopPost から呼ばれ、ジョブの成否を toyo:health に記録する。
# 使い方（ユニット内）: ExecStopPost=-/usr/bin/bash deploy/toyo-health-hook.sh <watch|coursework|daily>
# systemd が ExecStopPost に渡す環境変数 $SERVICE_RESULT / $EXIT_STATUS を見て判定する。
set -u

job="${1:?job name required}"

# watch の `flock -n -E 75`（他ジョブが実行中でスキップ）は実行されていないので、成功にも失敗にも数えない。
# SuccessExitStatus=75 のため SERVICE_RESULT は success になるので、先に判定する。
if [[ "${EXIT_STATUS:-}" == "75" ]]; then
  exit 0
fi

if [[ "${SERVICE_RESULT:-}" == "success" ]]; then
  result=success
else
  result=failure
fi

exec npm run --silent toyo:health -- record "$job" "$result"
