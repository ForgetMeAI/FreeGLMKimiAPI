#!/bin/sh
# Speeds up container restarts/NAS reboots by skipping `npm ci` when the
# bind-mounted /app/node_modules already matches the current package.json /
# package-lock.json / Node version / arch / *this script*. Only reinstalls
# when one of those actually changed. Including this script's own contents
# in the hash means editing the install logic here (e.g. adding/removing
# --omit=dev) automatically invalidates old sentinels — no manual `rm`
# needed. Mirrors the sentinel-file pattern used for Hermes' package
# persistence.
set -e

SENTINEL="/app/node_modules/.install-sentinel"
SELF="$0"

CURRENT_HASH=$(cat package.json package-lock.json "$SELF" 2>/dev/null | \
    { command -v sha256sum >/dev/null 2>&1 && sha256sum || md5sum; } | \
    awk '{print $1}')
CURRENT_HASH="${CURRENT_HASH}-node$(node --version)-$(uname -m)"

if [ -f "$SENTINEL" ] && [ "$(cat "$SENTINEL")" = "$CURRENT_HASH" ]; then
    echo "[entrypoint] node_modules matches sentinel — skipping npm ci"
else
    echo "[entrypoint] Installing dependencies (first run, or package.json/lock/Node/arch/entrypoint changed)..."
    npm install
    echo "$CURRENT_HASH" > "$SENTINEL"
fi

exec "$@"
