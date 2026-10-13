#!/bin/sh
# Open-Box 多后端管理补丁 · 安装脚本
#
# 同时支持两类系统（自动识别，也可用 --platform 指定）：
#   · OpenWrt         —— procd，服务放在 /etc/init.d/（openbox-multi-backend、openbox-mb-proxy）
#   · Debian / Ubuntu —— systemd，单元放在 /etc/systemd/system/
#
# 用法：
#   直连 GitHub：
#     curl -fsSL https://raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/install.sh | sudo sh
#   GitHub 不畅时走镜像（默认 gh-proxy.com）：
#     curl -fsSL https://gh-proxy.com/raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/install.sh | sudo sh -s -- --mirror
#   本地目录安装：
#     sudo sh install.sh
#   可选参数：
#     --proxy-port 3037            代理服务监听端口
#     --proxy-bind 0.0.0.0         代理服务绑定地址（收紧为 127.0.0.1 则只允许本机访问）
#     --proxy-token <口令>          给代理加访问口令（与面板「后端管理 → 代理设置」填一致）
#     --platform openwrt|systemd   跳过自动识别
#     --mirror [前缀]              走 GitHub 镜像下载
#     --direct                     强制直连 GitHub
#
# 安装内容（补丁资产一律落在 data/，上游升级时会保留）：
#   1) 补丁文件 → $ROOT/data/multi-backend/{multi-backend.js,openbox-globe.js,globe.bundle.js,
#                 globe.worker.js,globe-assets/earth/*,apply.sh,proxy.mjs,watch.sh,
#                 watch-interval,proxy.conf}
#   2) 重放服务 → OpenWrt: /etc/init.d/openbox-multi-backend（procd，常驻轮询文件变化）
#                 Debian : /etc/systemd/system/openbox-patch.{service,path}
#   3) 代理服务 → OpenWrt: /etc/init.d/openbox-mb-proxy（procd）
#                 Debian : /etc/systemd/system/openbox-mb-proxy.service
#                 代理同时承担：多后端状态聚合 / 原地显示反代 / 城市库镜像 / 公网 IP 归属
#   4) 立即执行一次 apply.sh（把补丁注入 index.html）
set -eu

REPO="xhy200606/Open-Box-Patch"
BRANCH="main"
RAW_HOST="raw.githubusercontent.com"
DEFAULT_MIRROR="https://gh-proxy.com/"

ROOT=${OPENBOX_ROOT:-/opt/open-box}
DEST="$ROOT/data/multi-backend"
CONF="$DEST/proxy.conf"
# 服务目录可覆盖（与上游 update.sh 的 OPENBOX_INITD_DIR 同名），便于容器/离线部署与测试
SYSD=${OPENBOX_SYSD_DIR:-/etc/systemd/system}
INITD=${OPENBOX_INITD_DIR:-/etc/init.d}

PROXY_PORT=3037
PROXY_BIND=0.0.0.0
PROXY_TOKEN=""
PANEL_URL="http://127.0.0.1:3036"
PANEL_SET=0
PORT_SET=0
BIND_SET=0
TOKEN_SET=0
PLATFORM=auto
MIRROR=""

# ---- 解析参数 ----
while [ $# -gt 0 ]; do
  case "$1" in
    --panel-url)
      shift
      PANEL_URL="${1:-http://127.0.0.1:3036}"
      PANEL_SET=1
      if [ $# -gt 0 ]; then shift; fi
      ;;
    --mirror)
      shift
      case "${1:-}" in
        ""|-*) MIRROR="$DEFAULT_MIRROR" ;;
        *)     MIRROR="$1"; shift ;;
      esac
      ;;
    --direct)
      shift
      ;;
    --platform)
      shift
      PLATFORM="${1:-auto}"
      if [ $# -gt 0 ]; then shift; fi
      ;;
    --proxy-port)
      shift
      PROXY_PORT="${1:-3037}"
      PORT_SET=1
      if [ $# -gt 0 ]; then shift; fi
      ;;
    --proxy-bind)
      shift
      PROXY_BIND="${1:-0.0.0.0}"
      BIND_SET=1
      if [ $# -gt 0 ]; then shift; fi
      ;;
    --proxy-token)
      shift
      PROXY_TOKEN="${1:-}"
      TOKEN_SET=1
      if [ $# -gt 0 ]; then shift; fi
      ;;
    *)
      shift
      ;;
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

conf_value() { # conf_value <键> —— 取已有 proxy.conf 里的值
  [ -f "$CONF" ] || return 0
  sed -n "s/^$1=//p" "$CONF" 2>/dev/null | head -n 1
}

# ---- 前置检查 ----
if [ "$(id -u)" != "0" ]; then
  echo "请以 root 运行（curl | sudo sh，或 sudo sh install.sh）。" >&2
  exit 1
fi
if [ ! -d "$ROOT/panel/dist" ]; then
  echo "未找到 $ROOT/panel/dist，请确认 Open-Box 已安装。" >&2
  exit 1
fi

# ---- 平台识别 ----
# 判据与上游 update.sh / uninstall.sh 保持一致（/etc/openwrt_release、procd），
# 不看单独的 /etc/rc.common —— 有些非 OpenWrt 系统也会有同名文件，容易误判。
if [ "$PLATFORM" = "auto" ]; then
  if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    PLATFORM=systemd
  elif [ -r /etc/openwrt_release ] || [ -x /sbin/procd ] || [ -x /etc/init.d/procd ]; then
    PLATFORM=openwrt
  else
    PLATFORM=unknown
  fi
fi

case "$PLATFORM" in
  openwrt|systemd) : ;;
  *)
    echo "未能识别服务管理方式（既不是 systemd，也不是 OpenWrt 的 procd）。" >&2
    echo "可用 --platform openwrt|systemd 手动指定，或手动把补丁文件放到 $DEST 后执行 apply.sh。" >&2
    exit 1
    ;;
esac
if [ "$PLATFORM" = "openwrt" ] && [ ! -f /etc/rc.common ]; then
  echo "警告：识别为 OpenWrt，但没有 /etc/rc.common，init 脚本可能不会生效。" >&2
fi

echo "服务管理方式：$PLATFORM"

# ---- 保留已有代理配置（重复安装 / 升级时不要把用户改过的设置冲掉）----
if [ -f "$CONF" ]; then
  if [ "$PORT_SET" = "0" ]; then
    _v=$(conf_value OPENBOX_MB_PORT)
    if [ -n "$_v" ]; then PROXY_PORT="$_v"; fi
  fi
  if [ "$BIND_SET" = "0" ]; then
    _v=$(conf_value OPENBOX_MB_BIND)
    if [ -n "$_v" ]; then PROXY_BIND="$_v"; fi
  fi
  if [ "$TOKEN_SET" = "0" ]; then
    _v=$(conf_value OPENBOX_MB_TOKEN)
    if [ -n "$_v" ]; then PROXY_TOKEN="$_v"; fi
  fi
  if [ "$PANEL_SET" = "0" ]; then
    _v=$(conf_value OPENBOX_MB_PANEL)
    if [ -n "$_v" ]; then PANEL_URL="$_v"; fi
  fi
fi

# ---- 判断本地目录安装还是远程下载安装 ----
LOCAL=0
HERE=""
if [ -f "$0" ]; then
  HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  if [ -f "$HERE/frontend/multi-backend.js" ] && [ -f "$HERE/scripts/apply.sh" ]; then LOCAL=1; fi
fi

get() { # get <仓库内相对路径> <目标文件> —— 本地有就用本地副本，否则下载
  if [ "$LOCAL" = "1" ] && [ -f "$HERE/$1" ]; then
    cp -f "$HERE/$1" "$2"
  else
    fetch "$1" "$2"
  fi
}

mkdir -p "$DEST"

if [ "$LOCAL" = "1" ]; then
  echo "本地目录安装：$HERE"
else
  echo "从 $BASE 下载补丁文件…"
fi

get frontend/multi-backend.js "$DEST/multi-backend.js"
get scripts/apply.sh         "$DEST/apply.sh"
get backend/proxy.mjs        "$DEST/proxy.mjs"
get backend/patch-manager.mjs "$DEST/patch-manager.mjs"
get scripts/update-patch.sh   "$DEST/update-patch.sh"
get version.json      "$DEST/version.json"
get scripts/watch.sh         "$DEST/watch.sh"

# 「全球连接」地球仪（可选）：缺任何一个文件都不影响其余功能，只让那张卡片显示提示。
get_soft() { # 取不到就告警并继续
  if get "$1" "$2" 2>/dev/null; then return 0; fi
  echo "  警告：$1 未取到（对应功能将不可用）"
  return 0
}

mkdir -p "$DEST/globe-assets/earth"
get_soft frontend/openbox-globe.js "$DEST/openbox-globe.js"
get_soft frontend/globe.bundle.js  "$DEST/globe.bundle.js"
get_soft frontend/globe.worker.js  "$DEST/globe.worker.js"
# 仓库按类别组织，安装后仍沿用原来的资产位置。
for _tex in background.jpg earth-day.webp earth-night.webp earth-surface.webp; do
  get_soft "frontend/globe/assets/earth/$_tex" "$DEST/globe-assets/earth/$_tex"
done

chmod +x "$DEST/apply.sh" "$DEST/watch.sh"
chmod 644 "$DEST/multi-backend.js" "$DEST/proxy.mjs"
chmod 644 "$DEST/openbox-globe.js" "$DEST/globe.bundle.js" "$DEST/globe.worker.js" 2>/dev/null || true
chmod 644 "$DEST/globe-assets/earth/"* 2>/dev/null || true

if [ ! -f "$DEST/watch-interval" ]; then
  echo 15 > "$DEST/watch-interval"
fi

# ---- 代理服务配置（systemd 的 EnvironmentFile 与 procd init 读同一个文件）----
{
  echo "OPENBOX_MB_PORT=$PROXY_PORT"
  echo "OPENBOX_MB_BIND=$PROXY_BIND"
  echo "OPENBOX_MB_TOKEN=$PROXY_TOKEN"
  echo "OPENBOX_MB_PANEL=$PANEL_URL"
} > "$CONF"
chmod 600 "$CONF"

# 随包 Node。OpenWrt 的 musl 需要随包 libstdc++（LD_LIBRARY_PATH）；缺 madvise 的设备
# 靠 data/node-preload 指定的兼容库。Debian 上 node/lib 已被删掉，所以先判断存在性。
NODE_BIN="$ROOT/node/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node || echo node)
fi
NODE_LIB=""
if [ -d "$ROOT/node/lib" ]; then
  NODE_LIB="$ROOT/node/lib"
fi

if [ "$PLATFORM" = "systemd" ]; then
  # ---- systemd：按实际安装根目录生成单元（兼容自定义 OPENBOX_ROOT）----
  cat > "$SYSD/openbox-patch.service" <<EOF
[Unit]
Description=Re-apply Open-Box multi-backend patch
ConditionPathExists=$ROOT/panel/dist/index.html

[Service]
Type=oneshot
ExecStart=$DEST/apply.sh

[Install]
WantedBy=multi-user.target
EOF

  cat > "$SYSD/openbox-patch.path" <<EOF
[Unit]
Description=Watch Open-Box panel dist for upstream updates

[Path]
PathChanged=$ROOT/panel/dist/index.html
PathModified=$ROOT/panel/dist

[Install]
WantedBy=multi-user.target
EOF

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
    echo "EnvironmentFile=-$CONF"
    if [ -n "$NODE_LIB" ]; then
      echo "Environment=LD_LIBRARY_PATH=$NODE_LIB"
    fi
    if [ -n "$PRELOAD" ]; then
      echo "Environment=LD_PRELOAD=$PRELOAD"
    fi
    echo 'Environment=OPENSSL_CONF=/dev/null'
    echo "Environment=OPENBOX_ROOT=$ROOT"
    echo "ExecStart=$NODE_BIN --max-old-space-size=64 $DEST/proxy.mjs"
    echo 'Restart=always'
    echo 'RestartSec=3'
    # Detached Patch jobs must finish when their installer restarts the proxy.
    echo 'KillMode=process'
    echo ''
    echo '[Install]'
    echo 'WantedBy=multi-user.target'
  } > "$SYSD/openbox-mb-proxy.service"

  chmod 644 "$SYSD/openbox-patch.service" "$SYSD/openbox-patch.path" "$SYSD/openbox-mb-proxy.service"

  systemctl daemon-reload
  systemctl enable --now openbox-patch.path
  systemctl enable openbox-patch.service
  systemctl enable --now openbox-mb-proxy.service
  systemctl restart openbox-mb-proxy.service
else
  # ---- OpenWrt：procd init 脚本 ----
  for _svc in openbox-multi-backend openbox-mb-proxy; do
    get "services/openwrt/initd/$_svc" "$INITD/$_svc"
    chmod +x "$INITD/$_svc"
  done

  "$INITD/openbox-mb-proxy" enable || true
  "$INITD/openbox-multi-backend" enable || true
  # 先起代理，再起重放服务（后者启动时会立刻注入一次补丁）
  "$INITD/openbox-mb-proxy" restart || true
  "$INITD/openbox-multi-backend" restart || true
fi

# 无论哪种平台都立刻注入一次，保证"装完刷新页面就见效"
OPENBOX_ROOT="$ROOT" /bin/sh "$DEST/apply.sh"

echo ""
echo "安装完成："
echo "  · 前端：刷新面板页面，左下角「运行时长」下方出现「后端」管理区；"
echo "          概览页「域名过滤」下方出现「全球连接」地球仪。"
echo "  · 代理：已在 ${PROXY_PORT} 端口监听（${PROXY_BIND}）。"
if [ "$PROXY_BIND" = "127.0.0.1" ]; then
  echo "    注意：绑定 127.0.0.1 时只有路由器本机能访问代理；浏览器在别的设备上请改成"
  echo "    --proxy-bind 0.0.0.0（或该网段的地址）。"
fi
if [ -z "$PROXY_TOKEN" ]; then
  echo "  · 安全：代理未设访问口令，同网段可访问。需要收紧时重跑安装并加 --proxy-token <口令>，"
  echo "    再到面板「后端管理 → 代理设置」填入同一口令。"
fi
if [ "$PLATFORM" = "openwrt" ]; then
  echo "  · 服务：/etc/init.d/openbox-multi-backend（补丁重放）、/etc/init.d/openbox-mb-proxy（代理）"
  echo "    上游升级替换 panel/ 后，重放服务会在约 15 秒内自动把补丁补回去。"
else
  echo "  · 服务：openbox-patch.path（监听面板变化）、openbox-mb-proxy.service（代理）"
fi
