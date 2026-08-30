/**
 * The endpoints that replace the browser's direct Index Supply subscription.
 *
 *   GET /v1/state    full world state, ETag'd  (~150 KB, ~37 KB gzipped)
 *   GET /v1/stream   server-sent events: a snapshot, then deltas
 *   GET /v1/status   indexer health, for ops and for the shadow comparison
 *
 * These are additive. They only answer when INDEXER=true; otherwise they
 * return 503 so that deploying this code changes nothing about the running
 * server until the flag is set.
 */

const express = require('express');
const crypto = require('crypto');
const indexerModule = require('../indexer');

const router = express.Router();

// Proxies and load balancers close quiet connections; a comment frame every
// 20s keeps the stream alive without being an event the client has to handle.
const HEARTBEAT_MS = 20_000;

function requireIndexer(req, res, next) {
  if (!indexerModule.isEnabled()) {
    return res.status(503).json({
      error: 'indexer disabled',
      hint: 'set INDEXER=true to enable /v1/state and /v1/stream',
    });
  }
  next();
}

function etagFor(payload) {
  return (
    '"' +
    crypto.createHash('sha1').update(payload).digest('base64').slice(0, 27) +
    '"'
  );
}

router.get('/state', requireIndexer, async function (req, res, next) {
  try {
    const indexer = indexerModule.get();
    await indexer.ready();
    const state = indexer.getState();

    const body = JSON.stringify({
      block: state.block,
      chainId: indexer.chainId,
      network: require('../lib/chain').getNetwork(),
      vipers: state.vipers.map(({ tokenId, owner, length }) => ({
        tokenId,
        owner,
        length,
      })),
      bites: state.bites,
    });

    const etag = etagFor(body);
    res.set('ETag', etag);
    // Short cache: the stream is what delivers freshness, this is the cold load.
    res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=300');
    res.type('application/json');

    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    return res.send(body);
  } catch (e) {
    return next(e);
  }
});

router.get('/stream', requireIndexer, async function (req, res, next) {
  let indexer;
  try {
    indexer = indexerModule.get();
    await indexer.ready();
  } catch (e) {
    return next(e);
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tell nginx-style proxies not to buffer this response.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders && res.flushHeaders();

  const send = (event, data, id) => {
    if (res.writableEnded) return;
    if (id !== undefined) res.write(`id: ${id}\n`);
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Always open with a full snapshot. It is cheap, and it means a reconnecting
  // client converges on the truth without the server having to retain a
  // per-client backlog.
  const state = indexer.getState();
  send('state', {
    block: state.block,
    chainId: indexer.chainId,
    vipers: state.vipers.map(({ tokenId, owner, length }) => ({
      tokenId,
      owner,
      length,
    })),
    bites: state.bites,
  }, state.block);

  const onDelta = (delta) => send('delta', delta, delta.block);
  indexer.on('delta', onDelta);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    indexer.removeListener('delta', onDelta);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
});

/**
 * What is actually running. Deploys used to be untraceable — an image could be
 * built from a dirty working tree and nothing recorded which commit it came
 * from. GIT_SHA is baked in at build time by scripts/deploy.sh and CI.
 */
router.get('/version', function (req, res) {
  res.json({
    commit: process.env.GIT_SHA || 'unknown',
    dirty: process.env.GIT_DIRTY === 'true',
    builtAt: process.env.BUILD_TIME || null,
    node: process.version,
    network: require('../lib/chain').getNetwork(),
  });
});

router.get('/status', function (req, res) {
  if (!indexerModule.isEnabled()) {
    return res.json({ enabled: false, authoritative: false });
  }
  const indexer = indexerModule.get();
  return res.json({
    enabled: true,
    authoritative: indexerModule.isAuthoritative(),
    ...indexer.summary(),
  });
});

module.exports = router;
