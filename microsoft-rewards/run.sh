#!/usr/bin/env bash
# QingLong entry: do not send account requests until both browser credentials exist.
set -euo pipefail
export REWARDS_DATA_DIR="${REWARDS_DATA_DIR:-/ql/data/rewards-data}"
export REWARDS_NOTIFY="${REWARDS_NOTIFY:-1}"
[ -f /ql/data/config/config.sh ] && . /ql/data/config/config.sh
script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! node -e 'const fs=require("node:fs"),path=require("node:path");try{const c=JSON.parse(fs.readFileSync(path.join(process.env.REWARDS_DATA_DIR,"credentials.json")));process.exit(Array.isArray(c.cookies)&&c.cookies.length&&c.app?.refresh_token?0:1)}catch{process.exit(1)}'; then
  printf '%s\n' '等待浏览器同步 Cookie 和完成 Rewards App 授权；本轮不发起微软任务。'
  exit 0
fi
exec node "$script_dir/rewards.js"
