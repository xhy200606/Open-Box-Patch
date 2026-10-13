#!/bin/sh
# Open-Box 多后端管理补丁 · 安装脚本
# 支持从 GitHub 下载安装（curl | sh），也支持本地目录安装。
#
# 用法（目标机为 Debian / Ubuntu systemd 环境，需 root）：
#   直连 GitHub：
#     curl -fsSL https://raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/install.sh | sudo sh
#   GitHub 不畅时走镜像（默认 gh-proxy.com）：
#     curl -fsSL https://gh-proxy.com/raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/install.sh | sudo sh -s -- --mirror
#   本地目录安装：
#     sudo sh install.sh
#   指定镜像前缀：
#     sudo sh install.sh --mirror https://gh-proxy.com/
#
# 安装内容：
#   1) 补丁文件 → /opt/open-box/data/multi-backend/（升级时被保留的目录）
#   2) systemd 单元 → /etc/systemd/system/openbox-patch.{service,path}
#   3) 立即执行一次 apply.sh
set -eu

REPO="xhy200606/Open-Box-Patch"
BRANCH="main"
RAW_HOST="raw.githubusercontent.com"
DEFAULT_MIRROR="https://gh-proxy.com/"
ROOT=${OPENBOX_ROOT:-/opt/open-box}
DEST="$ROOT/data/multi-backend"
SYSD=/etc/systemd/system

# ---- 解析参数 ----
MIRROR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mirror)
      shift
      case "${1:-}" in
        ""|-*) MIRROR="$DEFAULT_MIRROR" ;;
        *)     MIRROR="$1"; shift ;;
      esac
      ;;
    --direct) shift ;;
    *) shift ;;
  esac
done

if [ -n "$MIRROR" ]; then
  BASE="${MIRROR}${RAW_HOST}/${REPO}/${BRANCH}"
else
  BASE="https://${RAW_HOST}/${REPO}/${BRANCH}"
fi

fetch() { # fetch <仓库内相对路径> <目标文件>
  _url="$BASE/$1"
  echo "  下载 $1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$_url" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$_url"
  else
    echo "错误：需要 curl 或 wget。" >&2
    exit 1
  fi
}

# ---- 前置检查 ----
[ "$(id -u)" = "0" ] || { echo "请以 root 运行（curl | sudo sh，或 sudo sh install.sh）。" >&2; exit 1; }
[ -d "$ROOT/panel/dist" ] || { echo "未找到 $ROOT/panel/dist，请确认 Open-Box 已安装。" >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || {
  echo "未检测到 systemd（本补丁面向 Debian / Ubuntu）。" >&2
  echo "其它系统可手动把补丁文件放到 $DEST 并执行 apply.sh。" >&2
  exit 1
}

# ---- 判断本地目录安装还是远程下载安装 ----
LOCAL=0
if [ -f "$0" ]; then
  HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  if [ -f "$HERE/multi-backend.js" ] && [ -f "$HERE/apply.sh" ]; then LOCAL=1; fi
fi

mkdir -p "$DEST"

if [ "$LOCAL" = "1" ]; then
  echo "本地目录安装：$HERE"
  cp -f "$HERE/multi-backend.js" "$DEST/multi-backend.js"
  cp -f "$HERE/apply.sh" "$DEST/apply.sh"
  cp -f "$HERE/systemd/openbox-patch.service" "$SYSD/openbox-patch.service"
  cp -f "$HERE/systemd/openbox-patch.path" "$SYSD/openbox-patch.path"
else
  echo "从 $BASE 下载补丁文件…"
  fetch multi-backend.js "$DEST/multi-backend.js"
  fetch apply.sh "$DEST/apply.sh"
  fetch systemd/openbox-patch.service "$SYSD/openbox-patch.service"
  fetch systemd/openbox-patch.path "$SYSD/openbox-patch.path"
fi

chmod +x "$DEST/apply.sh"
chmod 644 "$DEST/multi-backend.js" "$SYSD/openbox-patch.service" "$SYSD/openbox-patch.path"

systemctl daemon-reload
systemctl enable --now openbox-patch.path
systemctl enable openbox-patch.service

"$DEST/apply.sh"

echo ""
echo "安装完成。刷新面板页面，即可在左下角「运行时长」下方看到「后端」管理区。"
