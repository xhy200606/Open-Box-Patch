#!/bin/sh
# Open-Box 多后端管理补丁 · 重放脚本（幂等，可反复执行）
# 作用：把补丁重新注入到前端 SPA。因为 update.sh 升级时会整体替换
#       /opt/open-box/panel/，本脚本由 systemd path 单元在 index.html
#       变化后自动调用；也可手动执行： sh /opt/open-box/data/multi-backend/apply.sh
#
# 说明：面板用 express.static 托管 dist/，对非 index.html/sw.js 的文件会返回
#       `immutable` 一年强缓存。因此注入标签带内容哈希（?v=<hash>），补丁更新后
#       hash 变化 → URL 变化 → 浏览器自动拉取新版本，避免旧缓存。
set -eu

ROOT=${OPENBOX_ROOT:-/opt/open-box}
DIST="$ROOT/panel/dist"
SRC_DIR="$ROOT/data/multi-backend"
SRC_JS="$SRC_DIR/multi-backend.js"

[ -d "$DIST" ] || { echo "[multi-backend] $DIST 不存在，跳过"; exit 0; }
[ -f "$SRC_JS" ] || { echo "[multi-backend] 补丁脚本缺失，跳过"; exit 0; }

# 1) 拷贝注入脚本（内容一致则不写，避免触发 systemd path 自循环）
if ! cmp -s "$SRC_JS" "$DIST/multi-backend.js" 2>/dev/null; then
  cp -f "$SRC_JS" "$DIST/multi-backend.js"
  chmod 644 "$DIST/multi-backend.js"
  echo "[multi-backend] 已拷贝 multi-backend.js"
fi

# 2) 计算内容哈希，生成带缓存穿透参数的注入标签
if command -v sha256sum >/dev/null 2>&1; then
  HASH=$(sha256sum "$SRC_JS" | awk '{print substr($1,1,12)}')
elif command -v md5sum >/dev/null 2>&1; then
  HASH=$(md5sum "$SRC_JS" | awk '{print substr($1,1,12)}')
else
  HASH=$(cksum "$SRC_JS" | awk '{print $1}')
fi
TAG="<script src=\"./multi-backend.js?v=$HASH\"></script>"

# 3) 向 index.html 注入（幂等：当前 TAG 已存在则跳过；否则移除旧标签后写入新标签）
HTML="$DIST/index.html"
if [ -f "$HTML" ]; then
  if ! grep -qF "$TAG" "$HTML"; then
    # 仅首次保留原始副本，便于卸载还原（不要覆盖成已打过补丁的版本）
    [ -f "$HTML.ob-patch-bak" ] || cp -f "$HTML" "$HTML.ob-patch-bak"
    tmp="$HTML.ob-tmp.$$"
    awk -v tag="$TAG" '
      /multi-backend\.js/ { next }
      /<\/body>/ { print tag }
      { print }
    ' "$HTML" > "$tmp"
    mv -f "$tmp" "$HTML"
    chmod 644 "$HTML"
    echo "[multi-backend] 已注入 index.html (v=${HASH})"
  fi
fi

echo "[multi-backend] 完成"
