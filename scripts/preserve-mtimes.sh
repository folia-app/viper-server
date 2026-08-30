#!/usr/bin/env bash
#
# Preserve source mtimes across a media migration.
#
#   ./scripts/preserve-mtimes.sh capture <ssh-host> <remote-dir> <pattern> > mtimes.txt
#   ./scripts/preserve-mtimes.sh apply   <fly-app> <volume-dir> < mtimes.txt
#
# Why this exists: routes/index.js appends `?c=${statSync(path).mtimeMs}` to
# every image url as a cache-buster. tar only preserves whole seconds, so
# extracting a migrated archive rewrites those values and every published image
# url changes — a mass cache-bust across OpenSea and anything else pointing at
# them. Restoring the original mtimes keeps the urls byte-identical.
#
# `find -printf %T@` gives seconds with a nanosecond fraction, which maps exactly
# onto Node's mtimeMs:
#   find  1788025814.2078391780
#   node  1788025814207.839
set -euo pipefail

case "${1:-}" in
  capture)
    HOST="$2"; DIR="$3"; PAT="${4:-complete.gif}"
    ssh -o BatchMode=yes "$HOST" \
      "cd '$DIR' && find . -name '$PAT' -printf '%T@ %p\n' | sed 's|\./||'"
    ;;
  apply)
    APP="$2"; DEST="$3"
    TMP="$(mktemp)"
    {
      echo '#!/bin/sh'
      echo 'n=0'
      awk -v d="$DEST" '{ t=$1; $1=""; sub(/^ /,""); printf "touch -d @%s \"%s/%s\" 2>/dev/null && n=$((n+1))\n", t, d, $0 }'
      echo 'echo "restored $n mtimes"'
    } > "$TMP"
    flyctl ssh console -a "$APP" -C "sh -c 'rm -f /data/.mtimes.sh'" >/dev/null 2>&1 || true
    flyctl ssh sftp put "$TMP" /data/.mtimes.sh -a "$APP" >/dev/null
    flyctl ssh console -a "$APP" -C "sh /data/.mtimes.sh"
    flyctl ssh console -a "$APP" -C "sh -c 'rm -f /data/.mtimes.sh'" >/dev/null 2>&1 || true
    rm -f "$TMP"
    ;;
  *)
    sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
