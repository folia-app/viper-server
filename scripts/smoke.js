#!/usr/bin/env node
/**
 * End-to-end check of the indexer-backed server.
 *
 * Boots the real Express app on a spare port with the indexer authoritative and
 * the Index Supply stream switched off, then exercises every endpoint the dapp
 * and OpenSea depend on — including a live SSE connection — and diffs the
 * metadata against the running production server.
 *
 *   node scripts/smoke.js
 *
 * Exits non-zero on the first hard failure.
 */

process.env.INDEXER = 'true';
process.env.INDEXER_SOURCE = 'true';
process.env.INDEXSUPPLY = 'false';
process.env.GENERATE_GIFS = process.env.GENERATE_GIFS || 'false';
// Use a dedicated database so injecting a synthetic event below can never
// touch the real index.
process.env.INDEXER_DB =
  process.env.INDEXER_DB ||
  require('path').join(
    __dirname,
    '..',
    'data',
    `smoke-${process.env.network || 'homestead'}.json`
  );

require('dotenv').config();

const http = require('http');
const app = require('../app');
const indexerModule = require('../indexer');

const IS_MAINNET = (process.env.network || 'homestead') === 'homestead';
const PROD =
  process.env.PARITY_BASE_URL ||
  (IS_MAINNET ? 'http://64.226.122.159:3001' : null);

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function main() {
  const server = http.createServer(app);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  console.log(`server up on ${base}\nwaiting for indexer…`);

  const summary = await indexerModule.get().ready();
  console.log(
    `indexer ready: ${summary.vipers} vipers, ${summary.bites} bites, ${summary.logs} logs, ${summary.socketsLive} socket(s) live\n`
  );

  // ---------------------------------------------------------------- /v1/state
  console.log('[/v1/state]');
  const stateRes = await fetch(`${base}/v1/state`);
  const state = await stateRes.json();
  check('200 OK', stateRes.status === 200, `got ${stateRes.status}`);
  check('has vipers', state.vipers.length > 0, `got ${state.vipers.length}`);
  check('has bites', state.bites.length > 0, `got ${state.bites.length}`);
  if (IS_MAINNET) {
    check('486 vipers (minted out)', state.vipers.length === 486, `got ${state.vipers.length}`);
    check('539 bites', state.bites.length === 539, `got ${state.bites.length}`);
  }
  check('has block height', state.block > 0, `got ${state.block}`);
  check(
    'every viper has an owner and length >= 1',
    state.vipers.every((v) => /^0x[0-9a-f]{40}$/.test(v.owner) && v.length >= 1)
  );
  check(
    'every bite maps to a real viper',
    state.bites.every(
      (b) => Number(b.originalTokenId) >= 1 && Number(b.originalTokenId) <= 486
    )
  );

  const etag = stateRes.headers.get('etag');
  check('sends an ETag', !!etag, 'no ETag header');
  const cached = await fetch(`${base}/v1/state`, {
    headers: { 'If-None-Match': etag },
  });
  check('304s on matching ETag', cached.status === 304, `got ${cached.status}`);

  const bytes = Buffer.byteLength(JSON.stringify(state));
  console.log(`  info  payload ${(bytes / 1024).toFixed(0)} KB uncompressed`);

  // --------------------------------------------------------------- /v1/status
  console.log('\n[/v1/status]');
  // Sockets connect asynchronously just after backfill; give them a moment
  // rather than racing them.
  await waitFor(
    async () => (await (await fetch(`${base}/v1/status`)).json()).socketsLive >= 1,
    15000
  );
  const status = await (await fetch(`${base}/v1/status`)).json();
  check('reports enabled', status.enabled === true);
  check('reports authoritative', status.authoritative === true);
  check('at least one socket live', status.socketsLive >= 1, `got ${status.socketsLive}`);
  check('backfill watermark set', status.backfilledTo > 0, `got ${status.backfilledTo}`);

  // --------------------------------------------------------------- /v1/stream
  console.log('\n[/v1/stream]');
  const streamed = await readStream(`${base}/v1/stream`, 3000);
  check('opens and sends a snapshot', streamed.events.length > 0, 'no events received');
  const snapshot = streamed.events.find((e) => e.event === 'state');
  check('snapshot event present', !!snapshot);
  check(
    'snapshot matches /v1/state',
    !!snapshot &&
      snapshot.data.vipers.length === state.vipers.length &&
      snapshot.data.bites.length === state.bites.length
  );
  check('snapshot carries an id', !!snapshot && snapshot.id === String(state.block));
  check(
    'correct content type',
    (streamed.contentType || '').includes('text/event-stream'),
    streamed.contentType
  );

  // ------------------------------------------------------- metadata + images
  console.log('\n[/v1/metadata + /get/img]');
  const sampleIds = (IS_MAINNET ? ['1', '24', '100', '486'] : ['1', '2', '3'])
    .filter((id) => state.vipers.some((v) => v.tokenId === id));
  for (const id of sampleIds) {
    const mine = await (await fetch(`${base}/v1/metadata/${id}`)).json();
    let theirs = null;
    if (PROD) {
      try {
        const r = await fetch(`${PROD}/v1/metadata/${id}`);
        if (r.ok) theirs = await r.json();
      } catch (_) {
        /* production unreachable, compare what we can */
      }
    }
    const lengthOf = (m) =>
      m.attributes.find((a) => a.trait_type === 'Length').value;

    check(`viper ${id}: has a name`, !!mine.name, JSON.stringify(mine).slice(0, 120));
    check(`viper ${id}: owner resolved`, /^0x[0-9a-f]{40}$/i.test(mine.owner || ''), `owner=${mine.owner}`);
    if (theirs) {
      check(
        `viper ${id}: length matches production (${lengthOf(theirs)})`,
        lengthOf(mine) === lengthOf(theirs),
        `local=${lengthOf(mine)} prod=${lengthOf(theirs)}`
      );
      check(
        `viper ${id}: name matches production`,
        mine.name === theirs.name,
        `local="${mine.name}" prod="${theirs.name}"`
      );
      check(
        `viper ${id}: attributes match production`,
        JSON.stringify(mine.attributes) === JSON.stringify(theirs.attributes),
        `local=${JSON.stringify(mine.attributes)} prod=${JSON.stringify(theirs.attributes)}`
      );
    }
  }

  // a bite, which exercises the other length path entirely
  const bite =
    state.bites.find((b) => b.originalTokenId === '24') || state.bites[0];
  if (bite) {
    const mine = await (await fetch(`${base}/v1/metadata/${bite.tokenId}`)).json();
    let theirs = null;
    if (PROD) {
      try {
        const r = await fetch(`${PROD}/v1/metadata/${bite.tokenId}`);
        if (r.ok) theirs = await r.json();
      } catch (_) {
        /* ignore */
      }
    }
    check('bite: has a name', !!mine.name);
    check(
      'bite: reports Length 1 (production parity)',
      mine.attributes.find((a) => a.trait_type === 'Length').value === 1,
      JSON.stringify(mine.attributes)
    );
    if (theirs) {
      check(
        'bite: name matches production',
        mine.name === theirs.name,
        `local="${mine.name}" prod="${theirs.name}"`
      );
      check(
        'bite: attributes match production',
        JSON.stringify(mine.attributes) === JSON.stringify(theirs.attributes)
      );
    }
  }

  // ------------------------------------------- live delta over the stream
  // The last untested link: a new log reaching a connected browser. Real Viper
  // events happen a few times a month, so inject one and roll it back.
  console.log('\n[live delta]');
  {
    const indexer = indexerModule.get();
    const parent = state.vipers.find((v) => v.length >= 1);
    const nextLength = parent.length; // bite lengths are the viper's length before the bite
    const sender = '0x' + 'ab'.repeat(20);
    const fakeTokenId = (
      (BigInt(nextLength) << 169n) |
      (BigInt(parent.tokenId) << 160n) |
      BigInt(sender)
    ).toString();
    const fakeBlock = state.block + 1;

    const received = [];
    const stream = await openStream(`${base}/v1/stream`, (evt) => received.push(evt));

    indexer._onLiveLog({
      blockNumber: '0x' + fakeBlock.toString(16),
      blockHash: '0x' + 'fe'.repeat(32),
      logIndex: '0x0',
      transactionHash: '0x' + 'ee'.repeat(32),
      address: indexer.addresses.biteByViper,
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        '0x'.padEnd(66, '0'),
        '0x' + sender.replace('0x', '').padStart(64, '0'),
        '0x' + BigInt(fakeTokenId).toString(16).padStart(64, '0'),
      ],
    });

    await new Promise((r) => setTimeout(r, 1200));
    stream.close();

    const delta = received.find((e) => e.event === 'delta');
    check('a delta reached the connected client', !!delta, `saw ${received.map((r) => r.event).join(',')}`);
    check(
      'delta carries the new bite',
      !!delta && delta.data.bites.some((b) => b.tokenId === fakeTokenId)
    );
    check(
      'delta carries the updated viper',
      !!delta && delta.data.vipers.some((v) => v.tokenId === parent.tokenId)
    );
    check(
      "viper's length advanced",
      !!delta &&
        delta.data.vipers.find((v) => v.tokenId === parent.tokenId).length ===
          nextLength + 1
    );
    check('delta block is the new block', !!delta && delta.data.block === fakeBlock);

    // roll the synthetic event back out
    indexer.db.deleteByBlockHash(indexer.chainId, '0x' + 'fe'.repeat(32));
    indexer._invalidate();
    const after = indexer.getState();
    check('rollback restored the original state', after.bites.length === state.bites.length,
      `${after.bites.length} vs ${state.bites.length}`);
  }

  // ------------------------------------------------------------- gif routes
  console.log('\n[/get/img]');
  for (const id of sampleIds.slice(0, 2)) {
    const r = await fetch(`${base}/get/img/${id}`);
    const pending = r.headers.get('x-pending') === 'true';
    check(
      `img ${id}: 200`,
      r.status === 200,
      `got ${r.status}`
    );
    check(
      `img ${id}: is a gif`,
      (r.headers.get('content-type') || '').includes('gif'),
      r.headers.get('content-type')
    );
    if (pending) console.log(`  info  img ${id} served the placeholder (render queued)`);
  }
  const iframe = await fetch(`${base}/get/iframe`);
  check('iframe route serves html', iframe.status === 200, `got ${iframe.status}`);

  // -------------------------------------------------------------- bad input
  console.log('\n[bad input]');
  for (const bad of ['0', '999999', 'abc', '-1']) {
    const r = await fetch(`${base}/v1/metadata/${bad}`);
    check(`rejects "${bad}"`, r.status >= 400, `got ${r.status}`);
  }

  server.close();
  indexerModule.get().stop();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

/** Open an SSE stream and hand each parsed frame to `onEvent`. */
function openStream(url, onEvent) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.startsWith(':')) continue;
          const out = {};
          for (const line of frame.split('\n')) {
            const at = line.indexOf(': ');
            if (at === -1) continue;
            const key = line.slice(0, at);
            const value = line.slice(at + 2);
            if (key === 'data') {
              try {
                out.data = JSON.parse(value);
              } catch (_) {
                out.data = value;
              }
            } else out[key] = value;
          }
          onEvent(out);
        }
      });
      resolve({ close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

/** Poll `fn` until it returns true or `ms` elapses. */
async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch (_) {
      /* keep waiting */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Read an SSE stream for `ms` and return the parsed frames. */
function readStream(url, ms) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const events = [];
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.startsWith(':')) continue; // heartbeat
          const out = {};
          for (const line of frame.split('\n')) {
            const at = line.indexOf(': ');
            if (at === -1) continue;
            const key = line.slice(0, at);
            const value = line.slice(at + 2);
            if (key === 'data') {
              try {
                out.data = JSON.parse(value);
              } catch (_) {
                out.data = value;
              }
            } else {
              out[key] = value;
            }
          }
          events.push(out);
        }
      });
      setTimeout(() => {
        req.destroy();
        resolve({ events, contentType: res.headers['content-type'] });
      }, ms);
    });
    req.on('error', reject);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
