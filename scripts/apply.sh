#!/bin/sh
# Open-Box 补丁 · 重放脚本（幂等，可反复执行）
#
# 作用：把补丁重新注入到前端 SPA。因为 update.sh 升级时会整体替换
#       $ROOT/panel/，本脚本由 systemd 的 path 单元（Debian/Ubuntu）或
#       procd 常驻轮询（OpenWrt）在 index.html 变化后自动调用；
#       也可手动执行： sh $ROOT/data/multi-backend/apply.sh
#
# 说明：面板用 express.static 托管 dist/，对非 index.html/sw.js 的文件会返回
#       `immutable` 一年强缓存。因此注入标签带内容哈希（?v=<hash>），补丁更新后
#       hash 变化 → URL 变化 → 浏览器自动拉取新版本，避免旧缓存。
#
# 补丁目前注入两个脚本：
#   · multi-backend.js  —— 左下角「后端」切换器 + 原地显示
#   · openbox-globe.js  —— 概览页「域名过滤」下方「全球连接」地球仪（按需加载 bundle）
set -eu

ROOT=${OPENBOX_ROOT:-/opt/open-box}
DIST="$ROOT/panel/dist"
SRC_DIR="$ROOT/data/multi-backend"

log() { echo "[multi-backend] $*"; }

[ -d "$DIST" ] || { log "$DIST 不存在，跳过"; exit 0; }
[ -d "$SRC_DIR" ] || { log "补丁目录 $SRC_DIR 不存在，跳过"; exit 0; }

hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print substr($1,1,12)}'
  elif command -v md5sum >/dev/null 2>&1; then
    md5sum "$1" | awk '{print substr($1,1,12)}'
  else
    cksum "$1" | awk '{print $1}'
  fi
}

# 拷贝一份资产到 dist（内容一致就不写，避免触发 path 单元自循环）
copy_asset() {
  _src="$SRC_DIR/$1"
  _dst="$DIST/$2"
  [ -f "$_src" ] || return 1
  mkdir -p "$(dirname "$_dst")"
  if ! cmp -s "$_src" "$_dst" 2>/dev/null; then
    cp -f "$_src" "$_dst"
    chmod 644 "$_dst"
    log "已拷贝 $2"
  fi
  return 0
}

# AnyTLS shared-network extension. Validate all upstream anchors before writing.
if [ -f "$SRC_DIR/patch-anytls.mjs" ]; then
  _node="$ROOT/node/bin/node"
  [ -x "$_node" ] || _node=$(command -v node || true)
  if [ -s "$ROOT/data/node-preload" ] && [ -x "$ROOT/openwrt/bin/compat/node" ]; then
    _node="$ROOT/openwrt/bin/compat/node"
  fi
  if [ -n "$_node" ]; then
    _status=0
    OPENBOX_ROOT="$ROOT" OPENSSL_CONF=/dev/null LD_LIBRARY_PATH="$ROOT/node/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$_node" "$SRC_DIR/patch-anytls.mjs" || _status=$?
    if [ "$_status" = 10 ]; then
      log "已添加 AnyTLS 共享网络支持，重启面板以载入后端扩展"
      if [ -x /etc/init.d/openbox-panel ]; then
        /etc/init.d/openbox-panel restart || log "请手动重启 OpenBox 面板"
      elif command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet openbox-panel.service; then
        systemctl restart openbox-panel.service || log "请手动重启 OpenBox 面板"
      fi
    elif [ "$_status" != 0 ]; then
      log "当前上游版本无法应用 AnyTLS 扩展，其余补丁继续安装"
    fi
  fi
fi

# ---------- 1) 落盘资产 ----------
copy_asset multi-backend.js multi-backend.js || log "警告：缺少 multi-backend.js"
copy_asset openbox-globe.js openbox-globe.js || true
copy_asset globe.bundle.js globe.bundle.js || true
copy_asset globe.worker.js globe.worker.js || true

# 地球贴图（CC BY 4.0，随补丁分发，不从公网拉）
# 安装后位于 $SRC_DIR/globe-assets/earth/，与面板里的相对路径一致，直接同路径拷贝。
for _tex in background.jpg earth-day.webp earth-night.webp earth-surface.webp; do
  copy_asset "globe-assets/earth/$_tex" "globe-assets/earth/$_tex" || true
done

# ---------- 2) 生成注入标签 ----------
# 标签里的哈希要覆盖该脚本**及其按需加载的资源**：注入脚本会按自身的 ?v= 去请求
# globe.bundle.js / globe.worker.js，而面板对这些文件返回 immutable 一年强缓存，
# 因此只哈希注入脚本本身，会导致补丁升级后浏览器仍用旧 bundle。
TAGFILE=$(mktemp 2>/dev/null || echo "/tmp/openbox-patch-tags.$$")
HASHSTAGE=$(mktemp 2>/dev/null || echo "/tmp/openbox-patch-hash.$$")
trap 'rm -f "$TAGFILE" "$HASHSTAGE"' EXIT HUP INT TERM

# want_tag <dist 内注入文件名> <参与哈希的源文件...>
want_tag() {
  _name="$1"
  shift
  : >"$HASHSTAGE"
  for _f in "$@"; do
    [ -f "$SRC_DIR/$_f" ] || return 0
    cat "$SRC_DIR/$_f" >>"$HASHSTAGE" 2>/dev/null || return 0
  done
  printf '<script src="./%s?v=%s"></script>\n' "$_name" "$(hash_of "$HASHSTAGE")" >>"$TAGFILE"
}

want_tag multi-backend.js multi-backend.js
want_tag openbox-globe.js openbox-globe.js globe.bundle.js globe.worker.js

# ---------- 3) 注入 index.html（幂等） ----------
HTML="$DIST/index.html"
if [ -f "$HTML" ] && [ -s "$TAGFILE" ]; then
  _need=0
  while IFS= read -r _tag; do
    [ -z "$_tag" ] && continue
    grep -qF "$_tag" "$HTML" || _need=1
  done <"$TAGFILE"

  if [ "$_need" = "1" ]; then
    # 仅首次保留原始副本，便于卸载还原（不要覆盖成已打过补丁的版本）
    [ -f "$HTML.ob-patch-bak" ] || cp -f "$HTML" "$HTML.ob-patch-bak"
    _tmp="$HTML.ob-tmp.$$"
    awk -v tagfile="$TAGFILE" '
      BEGIN { while ((getline line < tagfile) > 0) tags = tags line "\n" }
      /multi-backend\.js|openbox-globe\.js/ { next }
      /<\/body>/ { printf "%s", tags }
      { print }
    ' "$HTML" >"$_tmp"
    mv -f "$_tmp" "$HTML"
    chmod 644 "$HTML"
    log "已注入 index.html"
  fi
fi

log "完成"
