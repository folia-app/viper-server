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
      echo 'miss=0'
      # -c matters: plain touch CREATES a missing file. Applied against a volume
      # whose upload silently failed, that turns an empty directory into a
      # directory of plausible-looking zero-byte files and reports success.
      # Count the misses too, so a failed transfer is loud rather than pretty.
      awk -v d="$DEST" '{ t=$1; $1=""; sub(/^ /,""); printf "if [ -f \"%s/%s\" ]; then touch -c -d @%s \"%s/%s\" && n=$((n+1)); else miss=$((miss+1)); fi\n", d, $0, t, d, $0 }'
      echo 'echo "restored $n mtimes, $miss missing"'
      echo '[ "$miss" -eq 0 ] || exit 3'
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
