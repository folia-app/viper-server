# Build context is viper-server/ ; this file is fly/Dockerfile.
#
# The indexer has no native dependencies, so this is a plain slim image with no
# build toolchain — unlike the renderers, which need cairo, pango and friends
# pinned exactly.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY fly/package.json ./package.json
COPY fly/package-lock.json ./package-lock.json
# ci, not install: install re-resolves every range on each build, so two
# deploys of the same commit could ship different dependencies.
RUN npm ci --omit=dev --no-audit --no-fund \
 && apt-get purge -y git && apt-get autoremove -y

COPY indexer.js indexer-server.js ./
COPY lib ./lib
COPY routes/v1.js ./routes/v1.js

ARG GIT_SHA=unknown
ARG GIT_DIRTY=false
ARG BUILD_TIME=
ENV GIT_SHA=$GIT_SHA GIT_DIRTY=$GIT_DIRTY BUILD_TIME=$BUILD_TIME

ENV NODE_ENV=production \
    PORT=8080 \
    INDEXER=true \
    INDEXER_SOURCE=true \
    INDEXSUPPLY=false \
    INDEXER_DB=/data/viper-index.json

EXPOSE 8080
CMD ["node", "indexer-server.js"]
