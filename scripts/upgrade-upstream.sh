#!/bin/sh
# 上游升级辅助脚本
#
# 直接跑 /opt/open-box/update.sh 会卡在「等待内核和 TUN 退出超时」，原因有两个：
#   1) guard 守护每 10 秒检查一次内核，发现被 update.sh 停掉就立刻拉起来，
#      于是 update.sh 永远等不到内核退出；
#   2) update.sh 会重铺 /etc/init.d/openbox 与 etc/config.json，出口分流的挂钩
#      与运行配置随之丢失（配置本身在 data/ 里，不受影响）。
#
# 本脚本按顺序处理：空间预检 → 暂停 guard → 执行升级 → 恢复 guard → 重放补丁。
#
# 用法：sh upgrade-upstream.sh [--direct|--mirror]
set -eu

ROOT=${OPENBOX_ROOT:-/opt/open-box}
OFF="$ROOT/data/guard-off"
SRC="$ROOT/data/multi-backend"

log() { echo "[upgrade] $*"; }

# ---------- 1) 空间预检（update.sh 要求 300MB，提前给出可操作提示） ----------
need_mb=300
avail=$(df -m "$ROOT" 2>/dev/null | awk 'NR==2{print $4}')
if [ -n "$avail" ] && [ "$avail" -lt "$need_mb" ]; then
  log "可用空间 ${avail}MB，低于升级要求 ${need_mb}MB。可清理："
  du -s "$ROOT"/data/* 2>/dev/null | sort -n | tail -5 | while read -r kb path; do
    log "  $((kb / 1024))MB  $path"
  done
  exit 1
fi

# ---------- 2) 暂停 guard ----------
# 用 guard 自带的开关，而不是 kill 掉它：升级结束后删掉开关即可恢复看护。
touch "$OFF"
trap 'rm -f "$OFF"' EXIT HUP INT TERM
log "已暂停 guard（$OFF）"

# ---------- 3) 执行升级 ----------
sh "$ROOT/update.sh" "$@"

# ---------- 4) 恢复 guard ----------
rm -f "$OFF"
trap - EXIT HUP INT TERM
log "已恢复 guard"

# ---------- 5) 重放补丁 ----------
# apply.sh 会重新注入前端标签、并调用 egress-prepare --reapply 重挂启动脚本。
if [ -f "$SRC/apply.sh" ]; then
  OPENBOX_ROOT="$ROOT" sh "$SRC/apply.sh" >/dev/null 2>&1 || log "apply.sh 有告警，请手动执行查看"
fi
# 挂钩写好后再重启一次，内核才会以 egress-runtime.json 启动。
/etc/init.d/openbox restart >/dev/null 2>&1 || log "重启内核失败，请手动 /etc/init.d/openbox restart"

# ---------- 6) 自检 ----------
sleep 5
ver=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/meta.json" 2>/dev/null | head -1)
tag=$(grep -c "multi-backend\.js" "$ROOT/panel/dist/index.html" 2>/dev/null || echo 0)
hook=$(grep -c "openbox-patch-egress" /etc/init.d/openbox 2>/dev/null || echo 0)
plugin=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SRC/version.json" 2>/dev/null | head -1)
log "上游版本 $ver / 补丁版本 $plugin"
log "前端注入 $tag 处，启动挂钩 $hook 处（都应为 1）"
if [ "$tag" = "1" ] && [ "$hook" = "1" ]; then
  log "完成"
else
  log "有项目未恢复，请查看 /opt/open-box/data/multi-backend/egress-last-error.json"
  exit 1
fi
