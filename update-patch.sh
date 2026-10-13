#!/bin/sh
# Detached updater: fixed upstream installer, no client-supplied commands or URLs.
set -eu
ROOT=$1
JOB=$2
LOCK=$3
CHANNEL=$4
state() { printf '%s\n' "$1" > "$JOB/state.tmp"; mv "$JOB/state.tmp" "$JOB/state"; }
cleanup() {
  code=$?
  if [ "$code" -eq 0 ]; then state succeeded; else state failed; fi
  rm -f "$LOCK/pid"
  rmdir "$LOCK" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
state downloading
URL=https://raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/install.sh
if [ "$CHANNEL" = mirror ]; then URL="https://gh-proxy.com/$URL"; fi
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --connect-timeout 15 --max-time 180 "$URL" -o "$JOB/install.sh"
elif command -v wget >/dev/null 2>&1; then
  wget -T 180 -O "$JOB/install.sh" "$URL"
else
  echo '需要 curl 或 wget' >&2
  exit 1
fi
/bin/sh -n "$JOB/install.sh"
state installing
if [ "$CHANNEL" = mirror ]; then
  OPENBOX_ROOT="$ROOT" /bin/sh "$JOB/install.sh" --mirror
else
  OPENBOX_ROOT="$ROOT" /bin/sh "$JOB/install.sh" --direct
fi
