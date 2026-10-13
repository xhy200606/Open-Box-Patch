#!/bin/sh
# Compatibility entry point for the existing uninstall URL.
set -eu
if [ -f "$0" ]; then
  ENTRY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  if [ -f "$ENTRY_DIR/scripts/uninstall.sh" ]; then
    exec /bin/sh "$ENTRY_DIR/scripts/uninstall.sh" "$@"
  fi
fi
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
URL=https://raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/scripts/uninstall.sh
download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 15 --max-time 120 "$1" -o "$STAGE/uninstall.sh"
  elif command -v wget >/dev/null 2>&1; then
    wget -T 120 -O "$STAGE/uninstall.sh" "$1"
  else
    echo '需要 curl 或 wget' >&2
    return 1
  fi
}
download "$URL" || download "https://gh-proxy.com/$URL"
/bin/sh -n "$STAGE/uninstall.sh"
/bin/sh "$STAGE/uninstall.sh" "$@"
