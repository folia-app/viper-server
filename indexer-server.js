/**
 * Standalone indexer service.
 *
 * The /v1 API — state, stream, status — with none of the rendering. That split
 * matters: the indexer has no native dependencies at all (express, cors, ws and
 * a JSON contracts package), so it containerises to a few megabytes and runs on
 * any modern Node, while canvas and node-p5 stay behind on the box that needs
 * them until their renderers get the golden-image treatment.
 *
 * There is deliberately no persistent volume. The log store is a rebuildable
 * cache — a full backfill from chain takes about eight seconds — so a restart
 * re-derives rather than restoring, and the machine stays stateless.
 */

require('dotenv').config();

// This process exists only to index; the flags are not optional here.
process.env.INDEXER = 'true';
process.env.INDEXER_SOURCE = 'true';
process.env.INDEXSUPPLY = process.env.INDEXSUPPLY || 'false';
process.env.INDEXER_DB = process.env.INDEXER_DB || '/tmp/viper-index.json';

const express = require('express');
const cors = require('cors');

const indexer = require('./indexer');
const chain = require('./lib/chain');
const v1Router = require('./routes/v1');

const app = express();
const port = Number(process.env.PORT || 8080);

app.use(cors({ exposedHeaders: ['X-Pending'] }));
app.disable('x-powered-by');

// Liveness: the process is up. Kept separate from readiness on purpose — Fly
// should not cycle the machine merely because a backfill is still running.
app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

// Readiness: the backfill has completed and at least one socket is connected.
app.get('/readyz', (req, res) => {
  try {
    const s = indexer.get().summary();
    const ready = s.ready && s.socketsLive >= 1;
    res.status(ready ? 200 : 503).json({
      ready,
      logs: s.logs,
      block: s.block,
      socketsLive: s.socketsLive,
    });
  } catch (e) {
    res.status(503).json({ ready: false, error: e.message });
  }
});

app.use('/v1', v1Router);

app.get('/', (req, res) =>
  res.json({
    service: 'viper-indexer',
    network: chain.getNetwork(),
    chainId: chain.getChainId(),
    endpoints: ['/v1/state', '/v1/stream', '/v1/status', '/healthz', '/readyz'],
  })
);

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[indexer-server]', err);
  res.status(500).json({ error: 'internal error' });
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(
    `[indexer-server] listening on ${port} · network=${chain.getNetwork()} chain=${chain.getChainId()}`
  );
});

indexer
  .get()
  .start()
  .then((s) =>
    console.log(
      `[indexer-server] ready: ${s.vipers} vipers, ${s.bites} bites, ${s.logs} logs at block ${s.block}`
    )
  )
  .catch((e) => {
    console.error('[indexer-server] failed to start indexer:', e);
    process.exitCode = 1;
  });

// Fly sends SIGTERM on deploy and on machine stop; close cleanly so the JSON
// store is flushed and the sockets are torn down rather than dropped.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[indexer-server] ${sig} — shutting down`);
    server.close(() => {
      try {
        indexer.get().stop();
      } catch (_) {
        /* already stopped */
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
