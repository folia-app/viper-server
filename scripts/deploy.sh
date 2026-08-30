#!/usr/bin/env bash
#
# Deploy to Fly with the commit recorded in the image.
#
#   ./scripts/deploy.sh indexer
#   ./scripts/deploy.sh render
#   ./scripts/deploy.sh render --allow-dirty
#
# flyctl builds from the working directory, not from git, so without this it is
# possible — and was, during the migration — to ship uncommitted changes with no
# record of what is running. This refuses a dirty tree unless told otherwise,
# and bakes the sha in either way so /v1/version can answer the question.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-}"
ALLOW_DIRTY="${2:-}"

case "$TARGET" in
  indexer) APP=folia-viper-indexer; CFG=fly/fly.toml;        DOCKER=fly/Dockerfile ;;
  render)  APP=folia-viper-render;  CFG=fly/fly.render.toml; DOCKER=fly/Dockerfile.render ;;
  *) echo "usage: $0 {indexer|render} [--allow-dirty]" >&2; exit 1 ;;
esac

SHA="$(git rev-parse --short HEAD)"
DIRTY=false
if [ -n "$(git status --porcelain)" ]; then
  DIRTY=true
  if [ "$ALLOW_DIRTY" != "--allow-dirty" ]; then
    echo "working tree is dirty — commit first, or pass --allow-dirty:" >&2
    git status --porcelain | sed 's/^/  /' >&2
    exit 1
  fi
  echo "WARNING: deploying a dirty tree; /v1/version will report dirty=true"
fi

echo "deploying $APP from $SHA (dirty=$DIRTY)"
flyctl deploy \
  --config "$CFG" --dockerfile "$DOCKER" --app "$APP" \
  --build-arg "GIT_SHA=$SHA" \
  --build-arg "GIT_DIRTY=$DIRTY" \
  --build-arg "BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --ha=false --yes
