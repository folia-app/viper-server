/**
 * Log store — a plain JSON file held in memory.
 *
 * This started as SQLite and did not need to be. The whole dataset is under
 * 2,000 rows and ~150 KB, every read is a full replay in JavaScript anyway, and
 * the file is a cache rather than a system of record: the chain is the record,
 * and a full rebuild takes seven seconds. What SQLite added was a native
 * dependency, and the production droplet runs Node 18 with no package manager
 * and a `canvas` binary compiled against that exact ABI — so a native module
 * that needs Node 22 is not a dependency this can afford.
 *
 * The interface is unchanged from the SQLite version, so nothing above it moved.
 *
 * Rows are keyed by (chain_id, block_hash, log_idx):
 *   - two providers delivering the same log dedupe for free
 *   - a reorged block produces rows under a different hash, so stale rows are
 *     identifiable rather than silently overwriting good ones
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'data');
const FORMAT_VERSION = 1;

// Writes are debounced: losing the last couple of seconds is harmless because
// the reconciler re-scans from finality on boot and the backfill resumes from
// its watermark. Both paths converge on the chain regardless.
const FLUSH_DEBOUNCE_MS = 2000;

const keyOf = (row) => `${row.chain_id}:${row.block_hash}:${row.log_idx}`;
const byOrder = (a, b) => a.block_num - b.block_num || a.log_idx - b.log_idx;

function open(file) {
  const target =
    file ||
    process.env.INDEXER_DB ||
    path.join(DEFAULT_DIR, `viper-${process.env.network || 'homestead'}.json`);

  const inMemory = target === ':memory:';
  if (!inMemory) fs.mkdirSync(path.dirname(target), { recursive: true });

  let model = { version: FORMAT_VERSION, logs: [], sync: {} };

  if (!inMemory && fs.existsSync(target)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (parsed && Array.isArray(parsed.logs)) {
        model = { version: FORMAT_VERSION, logs: parsed.logs, sync: parsed.sync || {} };
      }
    } catch (e) {
      // The file is disposable — a corrupt one is a reason to rebuild, not to
      // refuse to start.
      console.warn(
        `[db] could not read ${target} (${e.message}); starting from empty and rebuilding`
      );
    }
  }

  const index = new Set(model.logs.map(keyOf));
  let dirty = false;
  let flushTimer = null;
  let closed = false;

  function flush() {
    if (inMemory || !dirty || closed) return;
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(model));
    fs.renameSync(tmp, target); // atomic: readers never see a partial file
    dirty = false;
  }

  function markDirty() {
    dirty = true;
    if (inMemory || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try {
        flush();
      } catch (e) {
        console.error('[db] flush failed:', e.message);
      }
    }, FLUSH_DEBOUNCE_MS);
    if (flushTimer.unref) flushTimer.unref();
  }

  const onExit = () => {
    try {
      flush();
    } catch (_) {
      /* going down anyway */
    }
  };
  process.on('exit', onExit);

  function insertMany(rows) {
    let inserted = 0;
    for (const row of rows) {
      const k = keyOf(row);
      if (index.has(k)) continue;
      index.add(k);
      model.logs.push(row);
      inserted += 1;
    }
    if (inserted) {
      model.logs.sort(byOrder);
      markDirty();
    }
    return inserted;
  }

  /**
   * Replace every log at or above `fromBlock` for this chain with `rows`.
   * This is the reorg story in one call: whatever the chain says now wins.
   */
  function replaceFrom(chainId, fromBlock, rows) {
    const kept = [];
    let removed = 0;
    for (const row of model.logs) {
      if (row.chain_id === chainId && row.block_num >= fromBlock) {
        index.delete(keyOf(row));
        removed += 1;
      } else {
        kept.push(row);
      }
    }
    model.logs = kept;

    let inserted = 0;
    for (const row of rows) {
      const k = keyOf(row);
      if (index.has(k)) continue;
      index.add(k);
      model.logs.push(row);
      inserted += 1;
    }
    if (removed || inserted) {
      model.logs.sort(byOrder);
      markDirty();
    }
    return { removed, inserted };
  }

  function deleteByBlockHash(chainId, blockHash) {
    const hash = blockHash.toLowerCase();
    const kept = [];
    let removed = 0;
    for (const row of model.logs) {
      if (row.chain_id === chainId && row.block_hash === hash) {
        index.delete(keyOf(row));
        removed += 1;
      } else {
        kept.push(row);
      }
    }
    if (removed) {
      model.logs = kept;
      markDirty();
    }
    return removed;
  }

  const forChain = (chainId) => model.logs.filter((r) => r.chain_id === chainId);

  return {
    file: target,

    insertMany,
    replaceFrom,
    deleteByBlockHash,

    allLogs: forChain, // already in (block_num, log_idx) order
    countLogs: (chainId) => forChain(chainId).length,
    maxBlock: (chainId) =>
      forChain(chainId).reduce((max, r) => Math.max(max, r.block_num), 0),

    latestOwner: (chainId, address, tokenId) => {
      const addr = address.toLowerCase();
      const id = String(tokenId);
      // logs are ordered, so the last match is the current owner
      for (let i = model.logs.length - 1; i >= 0; i--) {
        const r = model.logs[i];
        if (r.chain_id === chainId && r.address === addr && r.token_id === id) {
          return r.to_addr;
        }
      }
      return null;
    },

    getSyncState: (chainId) => model.sync[chainId] || null,
    setSyncState: (chainId, patch) => {
      const cur = model.sync[chainId] || {
        chain_id: chainId,
        backfilled_to: 0,
        head: 0,
        finalized: 0,
      };
      model.sync[chainId] = {
        chain_id: chainId,
        backfilled_to: patch.backfilled_to ?? cur.backfilled_to,
        head: patch.head ?? cur.head,
        finalized: patch.finalized ?? cur.finalized,
        updated_at: Date.now(),
      };
      markDirty();
    },

    flush,
    close: () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush();
      closed = true;
      process.removeListener('exit', onExit);
    },
  };
}

/** Normalise an eth_getLogs / eth_subscribe log into a storable row. */
function toRow(chainId, log) {
  return {
    chain_id: chainId,
    block_num: parseInt(log.blockNumber, 16),
    block_hash: log.blockHash.toLowerCase(),
    log_idx: parseInt(log.logIndex, 16),
    tx_hash: log.transactionHash.toLowerCase(),
    address: log.address.toLowerCase(),
    from_addr: '0x' + log.topics[1].slice(26).toLowerCase(),
    to_addr: '0x' + log.topics[2].slice(26).toLowerCase(),
    token_id: BigInt(log.topics[3]).toString(),
  };
}

module.exports = { open, toRow };
