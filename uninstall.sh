#!/bin/sh
# Open-Box 多后端管理补丁 · 卸载脚本
#
# 同时支持 OpenWrt（procd）与 Debian / Ubuntu（systemd），自动识别；也可用 --platform 指定。
#
# 用法（需 root）：
#   curl -fsSL https://raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/uninstall.sh | sudo sh
#   GitHub 不畅时：
#   curl -fsSL https://gh-proxy.com/raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/uninstall.sh | sudo sh
#   本地：sudo sh uninstall.sh
#   可选：--platform openwrt|systemd   （比如补丁装完后系统变过，或想强制清理另一套服务文件）
#
# 卸载内容：补丁重放服务、代理服务、注入脚本、index.html 还原、补丁数据目录。
set -eu

ROOT=${OPENBOX_ROOT:-/opt/open-box}
DIST="$ROOT/panel/dist"
HTML="$DIST/index.html"
SYSD=${OPENBOX_SYSD_DIR:-/etc/systemd/system}
INITD=${OPENBOX_INITD_DIR:-/etc/init.d}
PLATFORM=auto

while [ $# -gt 0 ]; do
  case "$1" in
    --platform)
      shift
      PLATFORM="${1:-auto}"
      if [ $# -gt 0 ]; then shift; fi
      ;;
    *) shift ;;
  esac
done

if [ "$(id -u)" != "0" ]; then
  echo "请以 root 运行。" >&2
  exit 1
fi

# ---- 平台识别（判据与 install.sh 一致）----
if [ "$PLATFORM" = "auto" ]; then
  if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    PLATFORM=systemd
  elif [ -r /etc/openwrt_release ] || [ -x /sbin/procd ] || [ -x /etc/init.d/procd ]; then
    PLATFORM=openwrt
  else
    PLATFORM=unknown
  fi
fi
echo "服务管理方式：$PLATFORM"

# ---- systemd：停用并移除单元（无法识别平台时也顺手清理，避免留下孤儿服务）----
if [ "$PLATFORM" = "systemd" ] || [ "$PLATFORM" = "unknown" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now openbox-patch.path 2>/dev/null || true
    systemctl disable --now openbox-patch.service 2>/dev/null || true
    systemctl disable --now openbox-mb-proxy.service 2>/dev/null || true
  fi
  rm -f "$SYSD/openbox-patch.path" \
        "$SYSD/openbox-patch.service" \
        "$SYSD/openbox-mb-proxy.service"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload 2>/dev/null || true
  fi
fi

# ---- OpenWrt：停用并移除 procd init 脚本 ----
if [ "$PLATFORM" = "openwrt" ] || [ "$PLATFORM" = "unknown" ]; then
  for _svc in openbox-multi-backend openbox-mb-proxy; do
    if [ -x "$INITD/$_svc" ]; then
      "$INITD/$_svc" stop 2>/dev/null || true
      "$INITD/$_svc" disable 2>/dev/null || true
    fi
    rm -f "$INITD/$_svc"
  done
fi

# ---- 移除注入的前端脚本与地球仪资产 ----
rm -f "$DIST/multi-backend.js" "$DIST/openbox-globe.js" "$DIST/globe.bundle.js" "$DIST/globe.worker.js"
rm -rf "$DIST/globe-assets"

# ---- 还原 index.html：优先用备份，否则按行删除注入标签 ----
if [ -f "$HTML" ]; then
  if [ -f "$HTML.ob-patch-bak" ]; then
    mv -f "$HTML.ob-patch-bak" "$HTML"
  else
    tmp="$HTML.ob-tmp.$$"
    grep -v -e 'multi-backend\.js' -e 'openbox-globe\.js' "$HTML" > "$tmp" && mv -f "$tmp" "$HTML"
  fi
fi

# ---- 删除补丁数据目录（含代理的数据库镜像缓存 globe-cache）----
rm -rf "$ROOT/data/multi-backend"

echo "Open-Box 补丁已卸载（刷新面板后左下角的「后端」区与概览页的「全球连接」卡片即消失）。"
