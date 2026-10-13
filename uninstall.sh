#!/bin/sh
# Open-Box 多后端管理补丁 · 卸载脚本
#
# 用法（需 root）：
#   curl -fsSL https://raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/uninstall.sh | sudo sh
#   GitHub 不畅时：
#   curl -fsSL https://gh-proxy.com/raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/uninstall.sh | sudo sh
#   本地：sudo sh uninstall.sh
#
# 卸载内容：systemd 单元、注入脚本、index.html 还原、补丁数据目录。
set -eu

ROOT=${OPENBOX_ROOT:-/opt/open-box}
DIST="$ROOT/panel/dist"
HTML="$DIST/index.html"

[ "$(id -u)" = "0" ] || { echo "请以 root 运行。" >&2; exit 1; }

systemctl disable --now openbox-patch.path 2>/dev/null || true
systemctl disable --now openbox-patch.service 2>/dev/null || true
rm -f /etc/systemd/system/openbox-patch.path /etc/systemd/system/openbox-patch.service
systemctl daemon-reload 2>/dev/null || true

# 移除注入的前端脚本
rm -f "$DIST/multi-backend.js"

# 还原 index.html：优先用备份，否则按行删除注入标签
if [ -f "$HTML" ]; then
  if [ -f "$HTML.ob-patch-bak" ]; then
    mv -f "$HTML.ob-patch-bak" "$HTML"
  else
    tmp="$HTML.ob-tmp.$$"
    grep -v 'multi-backend.js' "$HTML" > "$tmp" && mv -f "$tmp" "$HTML"
  fi
fi

rm -rf "$ROOT/data/multi-backend"

echo "Open-Box 多后端管理补丁已卸载。"
