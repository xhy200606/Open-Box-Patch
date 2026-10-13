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
#   指定镜像前缀 / 代理端口：
#     sudo sh install.sh --mirror https://gh-proxy.com/ --proxy-port 3037
#
# 安装内容：
#   1) 补丁文件     → /opt/open-box/data/multi-backend/（升级时被保留的目录）
#   2) 前端补丁单元 → /etc/systemd/system/openbox-patch.{service,path}
#   3) 代理服务单元 → /etc/systemd/system/openbox-mb-proxy.service
#   4) 立即执行一次 apply.sh 并启动代理
set -eu

REPO="xhy200606/Open-Box-Patch"
BRANCH="main"
RAW_HOST="raw.githubusercontent.com"
DEFAULT_MIRROR="https://gh-proxy.com/"
ROOT=${OPENBOX_ROOT:-/opt/open-box}
DEST="$ROOT/data/multi-backend"
SYSD=/etc/systemd/system
PROXY_PORT=3037

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
    --proxy-port)
      shift
      PROXY_PORT="${1:-3037}"; [ $# -gt 0 ] && shift
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
  cp -f "$HERE/proxy.mjs" "$DEST/proxy.mjs"
  cp -f "$HERE/systemd/openbox-patch.service" "$SYSD/openbox-patch.service"
  cp -f "$HERE/systemd/openbox-patch.path" "$SYSD/openbox-patch.path"
else
  echo "从 $BASE 下载补丁文件…"
  fetch multi-backend.js "$DEST/multi-backend.js"
  fetch apply.sh "$DEST/apply.sh"
  fetch proxy.mjs "$DEST/proxy.mjs"
  fetch systemd/openbox-patch.service "$SYSD/openbox-patch.service"
  fetch systemd/openbox-patch.path "$SYSD/openbox-patch.path"
fi

chmod +x "$DEST/apply.sh"
chmod 644 "$DEST/multi-backend.js" "$DEST/proxy.mjs" "$SYSD/openbox-patch.service" "$SYSD/openbox-patch.path"

# ---- 生成代理服务单元（复用随包 Node；设备需要 node-preload 时一并带上）----
NODE_BIN="$ROOT/node/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN=$(command -v node || echo node)
PRELOAD=""
if [ -f "$ROOT/data/node-preload" ]; then
  PRELOAD=$(tr -d '\n' < "$ROOT/data/node-preload" 2>/dev/null || true)
fi

{
  echo '[Unit]'
  echo 'Description=Open-Box multi-backend proxy (password auth + status)'
  echo 'After=network.target'
  echo ''
  echo '[Service]'
  echo 'Type=simple'
  echo "Environment=OPENBOX_MB_PORT=$PROXY_PORT"
  echo 'Environment=OPENBOX_MB_BIND=0.0.0.0'
  if [ -n "$PRELOAD" ]; then echo "Environment=LD_PRELOAD=$PRELOAD"; fi
  echo "ExecStart=$NODE_BIN $DEST/proxy.mjs"
  echo 'Restart=always'
  echo 'RestartSec=3'
  echo ''
  echo '[Install]'
  echo 'WantedBy=multi-user.target'
} > "$SYSD/openbox-mb-proxy.service"
chmod 644 "$SYSD/openbox-mb-proxy.service"

# ---- 启用 ----
systemctl daemon-reload
systemctl enable --now openbox-patch.path
systemctl enable openbox-patch.service
systemctl enable --now openbox-mb-proxy.service

# 传递安装根目录，保证 apply.sh 与实际安装路径一致
OPENBOX_ROOT="$ROOT" "$DEST/apply.sh"

echo ""
echo "安装完成："
echo "  · 前端：刷新面板页面，左下角「运行时长」下方出现「后端」管理区。"
echo "  · 代理：openbox-mb-proxy 已在 ${PROXY_PORT} 端口监听（面板注入脚本默认用它）。"
echo "  若代理端口非默认，请在「后端管理 → 代理设置」里改成 http://<本机>:$PROXY_PORT 。"
