#!/bin/sh
set -eu
# Resolve custom installation roots from the installed wrapper location.
ROOT=${OPENBOX_ROOT:-$(CDPATH= cd "$(dirname "$0")/../.." && pwd)}
NODE="$ROOT/node/bin/node"
[ -x "$NODE" ] || NODE=$(command -v node)
if [ -s "$ROOT/data/node-preload" ] && [ -x "$ROOT/openwrt/bin/compat/node" ]; then
  NODE="$ROOT/openwrt/bin/compat/node"
fi
export OPENBOX_ROOT="$ROOT" OPENSSL_CONF=/dev/null
export LD_LIBRARY_PATH="$ROOT/node/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
CONF=$("$NODE" "$ROOT/data/multi-backend/egress-prepare.mjs")
# A missing WAN or invalid configuration stops the split instead of silently
# sending traffic through the wrong uplink. Management panel stays separate.
exec "$ROOT/bin/sing-box" run -c "$CONF" -D "$ROOT/data"
