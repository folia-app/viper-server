/**
 * Viper event indexer.
 *
 * Replaces the hosted Index Supply subscription with a local one:
 *
 *   backfill     chunked eth_getLogs into SQLite, once, resumable
 *   fast lane    wss eth_subscribe on both contracts, every provider at once
 *   reconciler   slow poll that rewrites everything above `finalized`
 *
 * The fast lane is what makes it quick (~2s from block to here). The
 * reconciler is what makes it correct: it settles reorgs and backfills
 * anything the sockets missed while disconnected, so a dropped socket is
 * invisible rather than fatal.
 *
 * Nothing here runs unless INDEXER=true. It is additive by design — the
 * existing Index Supply path in utils.js is untouched and still authoritative
 * until INDEXER_SOURCE=true flips reads over.
 */

const EventEmitter = require('events');

const { extractBiteId } = require('./lib/bite');
const chain = require('./lib/chain');
const rpc = require('./lib/rpc');
const dbLib = require('./lib/db');
const { LogSubscriber } = require('./lib/subscribe');

const BACKFILL_CHUNK = Number(process.env.BACKFILL_CHUNK || 100_000);
const BACKFILL_CONCURRENCY = 4;
const RECONCILE_INTERVAL_MS = Number(process.env.INDEXER_RECONCILE_MS || 30_000);
// How far below `finalized` to re-scan. Finalised blocks cannot change, so
// this margin only guards against a provider reporting finality optimistically.
const FINALITY_MARGIN = 8;

class Indexer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.chainId = options.chainId || chain.getChainId();
    this.networkId = options.networkId || chain.getNetworkId();
    this.addresses = options.addresses || chain.addresses(this.networkId);
    this.dbFile = options.dbFile;

    this.db = null;
    this.subscriber = null;
    this.reconcileTimer = null;

    this.started = false;
    this.backfilled = false;
    this._state = null; // derived cache, invalidated on write
    this._stateBlock = 0;
    this._readyPromise = null;
    this.lastReconcileAt = 0;
    this.lastReconcileError = null;
  }

  get contractList() {
    return [this.addresses.viper, this.addresses.biteByViper];
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    if (this.started) return this._readyPromise;
    this.started = true;

    this.db = dbLib.open(this.dbFile);

    this._readyPromise = (async () => {
      await this.backfill();
      this.backfilled = true;
      // Warm the derived cache before going live so the first socket delivery
      // emits a real diff rather than a full resync.
      this.derive();
      this.startLive();
      this.emit('ready', this.summary());
      return this.summary();
    })();

    return this._readyPromise;
  }

  ready() {
    return this._readyPromise || Promise.reject(new Error('indexer not started'));
  }

  stop() {
    if (this.subscriber) this.subscriber.stop();
    clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    if (this.db) this.db.close();
    this.db = null;
    this.started = false;
    this._readyPromise = null;
  }

  // ---------------------------------------------------------------- backfill

  /**
   * Walk from the deployment block to finality in chunks. Resumable: a restart
   * picks up from `backfilled_to` rather than rescanning history, which is the
   * whole reason this is cheaper than the pre-Index-Supply listener.
   */
  async backfill() {
    const state = this.db.getSyncState(this.chainId);
    const configuredStart = chain.startBlock(this.chainId);
    const from = state && state.backfilled_to
      ? state.backfilled_to + 1
      : configuredStart;

    const { latest, finalized } = await rpc.getHeads({ chainId: this.chainId });
    const target = Math.max(finalized - FINALITY_MARGIN, from - 1);

    if (target < from) {
      this.db.setSyncState(this.chainId, { head: latest, finalized });
      console.log(
        `[indexer] backfill up to date (${this.db.countLogs(this.chainId)} logs)`
      );
      return;
    }

    const ranges = [];
    for (let b = from; b <= target; b += BACKFILL_CHUNK) {
      ranges.push([b, Math.min(b + BACKFILL_CHUNK - 1, target)]);
    }

    console.log(
      `[indexer] backfilling ${from}..${target} in ${ranges.length} chunks`
    );
    const t0 = Date.now();

    let cursor = 0;
    let done = 0;
    let inserted = 0;
    const failed = [];

    const fetchRange = async ([lo, hi]) => {
      const logs = await rpc.getLogs(
        {
          address: this.contractList,
          topics: [chain.TRANSFER_TOPIC],
          fromBlock: lo,
          toBlock: hi,
        },
        { chainId: this.chainId }
      );
      if (logs.length) {
        inserted += this.db.insertMany(
          logs.map((l) => dbLib.toRow(this.chainId, l))
        );
      }
    };

    const worker = async () => {
      while (cursor < ranges.length) {
        const range = ranges[cursor++];
        try {
          await fetchRange(range);
        } catch (e) {
          // Record and keep going; a single flaky span must not abort a
          // backfill that is otherwise 800 chunks of the way through.
          failed.push({ range, error: e.message });
        }
        done += 1;
        if (done % 200 === 0) {
          console.log(`[indexer]   ${done}/${ranges.length} chunks`);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(BACKFILL_CONCURRENCY, ranges.length) }, worker)
    );

    // Second pass, serially — most failures are transient provider hiccups and
    // clear once the concurrent load is off.
    const stillFailed = [];
    for (const { range } of failed) {
      try {
        await fetchRange(range);
      } catch (e) {
        stillFailed.push({ range, error: e.message });
      }
    }

    // `backfilled_to` must never skip a gap: if a span is still missing, stop
    // the watermark below it so the next run retries from there.
    let safeTarget = target;
    if (stillFailed.length) {
      const firstGap = Math.min(...stillFailed.map((f) => f.range[0]));
      safeTarget = firstGap - 1;
      console.warn(
        `[indexer] ${stillFailed.length} range(s) unresolved, watermark held at ${safeTarget}`
      );
      for (const f of stillFailed.slice(0, 5)) {
        console.warn(`[indexer]   ${f.range[0]}..${f.range[1]}: ${f.error}`);
      }
    }

    this.db.setSyncState(this.chainId, {
      backfilled_to: Math.max(safeTarget, from - 1),
      head: latest,
      finalized,
    });
    this._invalidate();

    console.log(
      `[indexer] backfill done: +${inserted} logs, ${this.db.countLogs(
        this.chainId
      )} total, ${((Date.now() - t0) / 1000).toFixed(1)}s${
        failed.length ? ` (${failed.length} chunk retries)` : ''
      }`
    );
  }

  // -------------------------------------------------------------------- live

  startLive() {
    const endpoints = chain.wssEndpoints(this.chainId);

    this.subscriber = new LogSubscriber({
      endpoints,
      address: this.contractList,
      topics: [chain.TRANSFER_TOPIC],
      onLog: (log) => this._onLiveLog(log),
      onStatus: (s) => {
        console.log(
          `[indexer] socket ${s.connected ? 'up' : 'down'} ${s.endpoint}${
            s.why ? ` (${s.why})` : ''
          }`
        );
        this.emit('socket', s);
      },
    });
    this.subscriber.start();

    this.reconcileTimer = setInterval(
      () => this.reconcile().catch((e) => {
        this.lastReconcileError = e.message;
        console.warn('[indexer] reconcile failed:', e.message);
      }),
      RECONCILE_INTERVAL_MS
    );
    if (this.reconcileTimer.unref) this.reconcileTimer.unref();

    console.log(
      `[indexer] live on ${endpoints.length} socket(s), reconciling every ${
        RECONCILE_INTERVAL_MS / 1000
      }s`
    );
  }

  _onLiveLog(log) {
    let row;
    try {
      row = dbLib.toRow(this.chainId, log);
    } catch (e) {
      return console.warn('[indexer] undecodable log', e.message);
    }

    const before = this._snapshotForDiff();
    const inserted = this.db.insertMany([row]);
    if (!inserted) return; // already had it from the other socket

    this.db.setSyncState(this.chainId, {
      head: Math.max(row.block_num, this.db.getSyncState(this.chainId)?.head || 0),
    });
    this._invalidate();
    this._emitDelta(before, `socket block ${row.block_num}`);
  }

  /**
   * Rewrite everything above finality from canonical chain state, and pull
   * forward `backfilled_to`. This is the reorg handler and the gap filler in
   * one: whatever the chain says now replaces whatever we thought.
   */
  async reconcile() {
    if (!this.db) return;
    const { latest, finalized } = await rpc.getHeads({ chainId: this.chainId });
    const from = Math.max(0, finalized - FINALITY_MARGIN);

    const logs = await rpc.getLogs(
      {
        address: this.contractList,
        topics: [chain.TRANSFER_TOPIC],
        fromBlock: from,
        toBlock: latest,
      },
      { chainId: this.chainId }
    );

    const before = this._snapshotForDiff();
    const { removed, inserted } = this.db.replaceFrom(
      this.chainId,
      from,
      logs.map((l) => dbLib.toRow(this.chainId, l))
    );

    this.db.setSyncState(this.chainId, {
      backfilled_to: Math.max(
        this.db.getSyncState(this.chainId)?.backfilled_to || 0,
        finalized - FINALITY_MARGIN
      ),
      head: latest,
      finalized,
    });

    this.lastReconcileAt = Date.now();
    this.lastReconcileError = null;

    if (removed || inserted) {
      this._invalidate();
      this._emitDelta(before, `reconcile ${from}..${latest}`);
    }
  }

  // ------------------------------------------------------------- derivation

  _invalidate() {
    this._state = null;
  }

  /**
   * Replay the log table into the two collections the dapp renders.
   *
   *   viper.length = (highest bite length against it) + 1, minimum 1
   *   bite.length  = the length encoded in its own token id
   *
   * Both match what the Index Supply handlers produce today; the parity test
   * in scripts/verify-parity.js checks that against live production.
   */
  derive() {
    if (this._state) return this._state;

    const rows = this.db.allLogs(this.chainId);
    const vipers = new Map();
    const bites = [];
    const biteIds = new Set();
    let block = 0;

    for (const r of rows) {
      block = Math.max(block, r.block_num);

      if (r.address === this.addresses.viper) {
        const existing = vipers.get(r.token_id);
        if (existing) {
          existing.owner = r.to_addr;
        } else {
          vipers.set(r.token_id, {
            tokenId: r.token_id,
            owner: r.to_addr,
            length: 1,
            maxBiteLength: 0,
          });
        }
        continue;
      }

      if (r.address !== this.addresses.biteByViper) continue;

      let decoded;
      try {
        decoded = extractBiteId(r.token_id);
      } catch (_) {
        continue; // not a token id this contract version can express
      }

      const originalTokenId = decoded.originalTokenId.toString();
      const biteLength = Number(decoded.length);

      if (biteIds.has(r.token_id)) {
        // a later transfer of an existing bite: ownership moves, nothing else
        const bite = bites.find((b) => b.tokenId === r.token_id);
        if (bite) bite.owner = r.to_addr;
      } else {
        biteIds.add(r.token_id);
        bites.push({
          tokenId: r.token_id,
          owner: r.to_addr,
          from: decoded.senderAddress,
          originalTokenId,
          length: biteLength,
        });
      }

      let viper = vipers.get(originalTokenId);
      if (!viper) {
        viper = {
          tokenId: originalTokenId,
          owner: null,
          length: 1,
          maxBiteLength: 0,
        };
        vipers.set(originalTokenId, viper);
      }
      viper.maxBiteLength = Math.max(viper.maxBiteLength, biteLength);
      viper.length = viper.maxBiteLength + 1;
    }

    this._state = {
      block,
      vipers: [...vipers.values()].sort(
        (a, b) => Number(a.tokenId) - Number(b.tokenId)
      ),
      bites,
    };
    this._stateBlock = block;
    return this._state;
  }

  _snapshotForDiff() {
    if (!this._state) return null;
    return {
      vipers: new Map(this._state.vipers.map((v) => [v.tokenId, { ...v }])),
      bites: new Map(this._state.bites.map((b) => [b.tokenId, { ...b }])),
    };
  }

  _emitDelta(before, reason) {
    const after = this.derive();
    if (!before) {
      // No prior snapshot to diff against — tell listeners to resync.
      this.emit('delta', {
        block: after.block,
        reason,
        resync: true,
        vipers: after.vipers,
        bites: after.bites,
      });
      return;
    }

    const changedVipers = after.vipers.filter((v) => {
      const p = before.vipers.get(v.tokenId);
      return !p || p.owner !== v.owner || p.length !== v.length;
    });
    const newBites = after.bites.filter((b) => {
      const p = before.bites.get(b.tokenId);
      return !p || p.owner !== b.owner;
    });

    if (!changedVipers.length && !newBites.length) return;

    const delta = {
      block: after.block,
      reason,
      resync: false,
      vipers: changedVipers,
      bites: newBites,
    };
    console.log(
      `[indexer] delta (${reason}): ${changedVipers.length} viper(s), ${newBites.length} bite(s)`
    );
    this.emit('delta', delta);
  }

  // ------------------------------------------------------------------ reads

  getState() {
    return this.derive();
  }

  getViper(tokenId) {
    return this.derive().vipers.find((v) => v.tokenId === String(tokenId)) || null;
  }

  getBite(tokenId) {
    return this.derive().bites.find((b) => b.tokenId === String(tokenId)) || null;
  }

  /**
   * The zero-indexed length the metadata/image routes expect (they add 1).
   *
   * Bites deliberately return 0 so that callers report Length 1, matching what
   * production has served since launch. The bite's own encoded length is used
   * for its image path via formatName(), which re-derives it from the token id.
   */
  lengthFor(tokenId, isBitten) {
    const id = String(tokenId);
    if (isBitten) return 0;
    const viper = this.getViper(id);
    if (!viper) return null;
    return viper.maxBiteLength;
  }

  /** Current owner straight from the log table — no third party involved. */
  ownerOf(address, tokenId) {
    return this.db.latestOwner(this.chainId, address.toLowerCase(), String(tokenId));
  }

  summary() {
    const sync = this.db ? this.db.getSyncState(this.chainId) : null;
    const state = this.db ? this.derive() : { vipers: [], bites: [], block: 0 };
    return {
      chainId: this.chainId,
      network: chain.getNetwork(),
      ready: this.backfilled,
      logs: this.db ? this.db.countLogs(this.chainId) : 0,
      vipers: state.vipers.length,
      bites: state.bites.length,
      block: state.block,
      head: sync ? sync.head : 0,
      finalized: sync ? sync.finalized : 0,
      backfilledTo: sync ? sync.backfilled_to : 0,
      sockets: this.subscriber ? this.subscriber.status() : [],
      socketsLive: this.subscriber ? this.subscriber.liveCount() : 0,
      lastReconcileAt: this.lastReconcileAt,
      lastReconcileError: this.lastReconcileError,
    };
  }
}

// ------------------------------------------------------------------ singleton

let singleton = null;

/** Enabled only by explicit opt-in, so deploying this changes nothing. */
function isEnabled() {
  return process.env.INDEXER === 'true';
}

/** True when the indexer, not Index Supply, should answer length/owner reads. */
function isAuthoritative() {
  return isEnabled() && process.env.INDEXER_SOURCE === 'true';
}

function get() {
  if (!singleton) singleton = new Indexer();
  return singleton;
}

module.exports = { Indexer, get, isEnabled, isAuthoritative };
