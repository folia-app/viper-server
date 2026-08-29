/**
 * Minimal JSON-RPC client with provider failover.
 *
 * Deliberately not ethers: this only needs three methods, and going direct
 * means a dead provider is a plain fetch failure we can fall through rather
 * than an ethers retry policy we have to fight.
 */

const { httpEndpoints } = require('./chain');

let requestId = 0;

/** Providers that just failed, with the time they may be retried. */
const cooldown = new Map();
const COOLDOWN_MS = 30_000;

function available(endpoints) {
  const now = Date.now();
  const ok = endpoints.filter((e) => (cooldown.get(e) || 0) <= now);
  // If everything is cooling down, ignore the cooldown rather than give up.
  return ok.length ? ok : endpoints;
}

async function callOne(endpoint, method, params, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++requestId,
        method,
        params,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) {
      const err = new Error(
        typeof body.error === 'string'
          ? body.error
          : body.error.message || JSON.stringify(body.error)
      );
      err.rpcError = body.error;
      throw err;
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Public endpoints hiccup constantly; most failures clear on a second ask. */
const ATTEMPTS_PER_ENDPOINT = 4;

/**
 * Call `method` against the first provider that answers, retrying each with
 * backoff before moving on. Throws only when every provider is exhausted.
 *
 * A bounded-range complaint is rethrown immediately: it is the caller's job to
 * split the range, not something another provider or another attempt fixes.
 */
async function call(method, params, { chainId, timeoutMs = 20_000 } = {}) {
  const endpoints = available(httpEndpoints(chainId));
  let lastError;

  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_ENDPOINT; attempt++) {
      try {
        const result = await callOne(endpoint, method, params, timeoutMs);
        cooldown.delete(endpoint);
        return result;
      } catch (e) {
        lastError = e;
        if (isRangeError(e)) throw e;
        if (isPermanentError(e)) break; // fail over now, don't retry a dead host
        if (attempt < ATTEMPTS_PER_ENDPOINT - 1) {
          // jittered backoff so parallel workers don't retry in lockstep
          await sleep(250 * (attempt + 1) + Math.random() * 250);
        }
      }
    }
    cooldown.set(endpoint, Date.now() + COOLDOWN_MS);
  }

  const err = new Error(
    `all ${endpoints.length} rpc provider(s) failed for ${method}: ${
      lastError && lastError.message
    }`
  );
  err.allProvidersFailed = true;
  throw err;
}

/**
 * Errors that will not get better by asking again — a dead hostname, a refused
 * connection, an auth or plan rejection. Worth failing over immediately rather
 * than burning four attempts on, which matters because the legacy `RPC` value
 * in .env points at a Grove host that no longer resolves.
 */
function isPermanentError(e) {
  const m = (e && e.message ? e.message : String(e)).toLowerCase();
  const code = (e && e.cause && e.cause.code) || e.code || '';
  return (
    ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ERR_INVALID_URL'].includes(code) ||
    m.includes('enotfound') ||
    m.includes('econnrefused') ||
    m.includes('getaddrinfo') ||
    m.includes('http 401') ||
    m.includes('http 403') ||
    m.includes('not available on free plan') ||
    m.includes('must authenticate') ||
    m.includes('api key')
  );
}

function isRangeError(e) {
  const m = (e && e.message ? e.message : String(e)).toLowerCase();
  return (
    m.includes('range') ||
    m.includes('too many results') ||
    m.includes('limited to') ||
    m.includes('query returned more than')
  );
}

const hex = (n) => '0x' + Number(n).toString(16);

async function getBlockNumber(tag = 'latest', opts = {}) {
  if (tag === 'latest') {
    const r = await call('eth_blockNumber', [], opts);
    return parseInt(r, 16);
  }
  const block = await call('eth_getBlockByNumber', [tag, false], opts);
  if (!block) throw new Error(`no block for tag ${tag}`);
  return parseInt(block.number, 16);
}

/**
 * Heads we care about. `finalized` is what makes reorg handling cheap: anything
 * at or below it can never change again. Providers that don't serve the tag
 * fall back to a fixed depth.
 */
async function getHeads(opts = {}) {
  const latest = await getBlockNumber('latest', opts);
  let finalized;
  try {
    finalized = await getBlockNumber('finalized', opts);
  } catch (_) {
    finalized = Math.max(0, latest - 64);
  }
  return { latest, finalized };
}

/**
 * eth_getLogs over an arbitrary range. Providers cap ranges at wildly different
 * limits and some simply crash on particular spans, so any failure halves the
 * range and retries until it succeeds or we're down to a single block.
 */
async function getLogs({ address, topics, fromBlock, toBlock }, opts = {}) {
  if (fromBlock > toBlock) return [];
  try {
    return await call(
      'eth_getLogs',
      [{ address, topics, fromBlock: hex(fromBlock), toBlock: hex(toBlock) }],
      opts
    );
  } catch (e) {
    if (fromBlock >= toBlock) {
      throw new Error(
        `eth_getLogs failed on single block ${fromBlock}: ${e.message}`
      );
    }
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const [a, b] = await Promise.all([
      getLogs({ address, topics, fromBlock, toBlock: mid }, opts),
      getLogs({ address, topics, fromBlock: mid + 1, toBlock }, opts),
    ]);
    return a.concat(b);
  }
}

module.exports = {
  call,
  getBlockNumber,
  getHeads,
  getLogs,
  isRangeError,
  isPermanentError,
};
