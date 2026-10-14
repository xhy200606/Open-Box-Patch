#!/bin/sh
# Open-Box 多后端管理补丁 · 变更监听（OpenWrt / procd 用，Debian 走 systemd path 单元不需要它）
#
# 作用：上游 update.sh 升级时会整体替换 panel/，注入标签随之消失。systemd 那边有
#       openbox-patch.path 监听文件变化，OpenWrt 的 procd 没有等价物，所以这里用一个
#       极轻量的轮询循环顶上：只看 index.html 与补丁脚本的「大小 + mtime」指纹，
#       指纹变了才调用 apply.sh（apply.sh 本身幂等，重复调用无副作用）。
#
# 由 /etc/init.d/openbox-multi-backend 以 procd 常驻实例方式拉起，procd 负责崩溃重拉。
# 轮询间隔可用 data/multi-backend/watch-interval 调整（秒，最小 5，默认 15）。
set -u

ROOT=${OPENBOX_ROOT:-/opt/open-box}
DIST="$ROOT/panel/dist"
SRC_DIR="$ROOT/data/multi-backend"
APPLY="$SRC_DIR/apply.sh"

INTERVAL=15
if [ -f "$SRC_DIR/watch-interval" ]; then
	_v=$(tr -dc '0-9' < "$SRC_DIR/watch-interval" 2>/dev/null | head -c 4)
	if [ -n "$_v" ] && [ "$_v" -ge 5 ] 2>/dev/null; then
		INTERVAL="$_v"
	fi
fi

# 文件指纹：大小-月-日-时间。ls -ln 是 busybox 也支持的写法（$5 大小，$6..$8 时间）。
# 既要看面板的 index.html，也要看补丁自身的文件 —— 补丁升级（换了 bundle）时同样要重放一次。
stamp() {
	for f in \
		"$DIST/index.html" \
		"$SRC_DIR/multi-backend.js" \
		"$SRC_DIR/openbox-globe.js" \
		"$SRC_DIR/globe.bundle.js" \
		"$SRC_DIR/globe.worker.js" \
		"$SRC_DIR/patch-anytls.mjs" \
		"$SRC_DIR/anytls-share.mjs" \
		"$ROOT/panel/server/index.mjs" \
		"$ROOT/panel/server/cli/deploy.mjs"
	do
		if [ -e "$f" ]; then
			ls -ln "$f" 2>/dev/null | awk '{print $5"-"$6"-"$7"-"$8}'
		else
			echo "missing"
		fi
	done
}

# 面板已经卸载（目录没了）就安静退出，别让 procd 无意义地反复重拉
[ -d "$ROOT/panel" ] || exit 0

LAST="__init__"
while :; do
	CUR=$(stamp)
	if [ "$CUR" != "$LAST" ]; then
		LAST="$CUR"
		if [ -f "$APPLY" ]; then
			OPENBOX_ROOT="$ROOT" /bin/sh "$APPLY" >/dev/null 2>&1
		fi
	fi
	sleep "$INTERVAL"
done
