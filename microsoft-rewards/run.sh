#!/usr/bin/env bash
# QingLong entry: do not send account requests until both browser credentials exist.
set -eu
export REWARDS_DATA_DIR="${REWARDS_DATA_DIR:-/ql/data/rewards-data}"
export REWARDS_NOTIFY="${REWARDS_NOTIFY:-1}"
[ -f /ql/data/config/config.sh ] && . /ql/data/config/config.sh
# 青龙以 `task <dir>/<file>` 方式调度时，$0 可能不含目录（甚至只有文件名），
# 直接 dirname 会得到 "."，拼出错误的 rewards.js 路径（如 /usr/local/bin/rewards.js）。
# 改为已知路径优先，再用脚本自身位置兜底。
script_dir=""
for _d in /ql/data/scripts/microsoft-rewards /ql/scripts/microsoft-rewards; do
  if [ -f "$_d/rewards.js" ]; then script_dir="$_d"; break; fi
done
if [ -z "$script_dir" ]; then
  script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)"
fi
if [ -z "$script_dir" ] || [ ! -f "$script_dir/rewards.js" ]; then
  printf '%s\n' '找不到 rewards.js：请确认 microsoft-rewards 目录完整（需包含 rewards.js / rewards-common.js / run.sh）。'
  exit 1
fi
if ! node -e 'const fs=require("node:fs"),path=require("node:path");try{const c=JSON.parse(fs.readFileSync(path.join(process.env.REWARDS_DATA_DIR,"credentials.json")));process.exit(Array.isArray(c.cookies)&&c.cookies.length&&c.app?.refresh_token?0:1)}catch{process.exit(1)}'; then
  printf '%s\n' '等待浏览器同步 Cookie 和完成 Rewards App 授权；本轮不发起微软任务。'
  exit 0
fi
exec node "$script_dir/rewards.js"
