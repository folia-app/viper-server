/**
 * Multi-provider WebSocket log subscriptions.
 *
 * Every configured endpoint is subscribed simultaneously and all of them feed
 * the same callback. Duplicate deliveries are expected and harmless — the log
 * store dedupes on (block_hash, log_idx) — so the useful property is that any
 * single provider can die without the stream stopping.
 *
 * Each socket reconnects on its own schedule with exponential backoff plus
 * jitter, so two providers failing at once don't resynchronise into a
 * thundering herd.
 */

const WebSocket = require('ws');

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const PING_INTERVAL_MS = 30_000;
const PONG_GRACE_MS = 10_000;

class LogSubscriber {
  /**
   * @param {object} opts
   * @param {string[]} opts.endpoints  wss urls
   * @param {string[]} opts.address    contract addresses to filter on
   * @param {string[]} opts.topics     topic filter
   * @param {(log: object, endpoint: string) => void} opts.onLog
   * @param {(status: object) => void} [opts.onStatus]
   */
  constructor({ endpoints, address, topics, onLog, onStatus }) {
    this.endpoints = endpoints;
    this.address = address;
    this.topics = topics;
    this.onLog = onLog;
    this.onStatus = onStatus || (() => {});
    this.sockets = new Map();
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    for (const endpoint of this.endpoints) this._connect(endpoint, 0);
  }

  stop() {
    this.stopped = true;
    for (const [, s] of this.sockets) {
      clearTimeout(s.retryTimer);
      clearInterval(s.pingTimer);
      clearTimeout(s.pongTimer);
      try {
        s.ws && s.ws.terminate();
      } catch (_) {
        /* already gone */
      }
    }
    this.sockets.clear();
  }

  /** How many endpoints currently have a live subscription. */
  liveCount() {
    let n = 0;
    for (const [, s] of this.sockets) if (s.subscribed) n++;
    return n;
  }

  status() {
    return this.endpoints.map((e) => {
      const s = this.sockets.get(e) || {};
      return {
        endpoint: e,
        connected: !!s.subscribed,
        attempts: s.attempts || 0,
        lastError: s.lastError || null,
        logsSeen: s.logsSeen || 0,
      };
    });
  }

  _state(endpoint) {
    if (!this.sockets.has(endpoint)) {
      this.sockets.set(endpoint, {
        ws: null,
        subscribed: false,
        attempts: 0,
        logsSeen: 0,
        lastError: null,
        subId: null,
        retryTimer: null,
        pingTimer: null,
        pongTimer: null,
      });
    }
    return this.sockets.get(endpoint);
  }

  _retry(endpoint) {
    if (this.stopped) return;
    const s = this._state(endpoint);
    s.subscribed = false;
    s.attempts += 1;
    const base = Math.min(
      MAX_BACKOFF_MS,
      MIN_BACKOFF_MS * Math.pow(2, Math.min(s.attempts, 6))
    );
    const delay = Math.floor(base / 2 + Math.random() * base);
    clearTimeout(s.retryTimer);
    s.retryTimer = setTimeout(() => this._connect(endpoint), delay);
  }

  _connect(endpoint) {
    if (this.stopped) return;
    const s = this._state(endpoint);

    clearInterval(s.pingTimer);
    clearTimeout(s.pongTimer);

    let ws;
    try {
      ws = new WebSocket(endpoint, { handshakeTimeout: 15_000 });
    } catch (e) {
      s.lastError = e.message;
      return this._retry(endpoint);
    }
    s.ws = ws;

    const fail = (why) => {
      s.lastError = why;
      if (s.subscribed) this.onStatus({ endpoint, connected: false, why });
      s.subscribed = false;
      try {
        ws.terminate();
      } catch (_) {
        /* already gone */
      }
      this._retry(endpoint);
    };

    ws.on('open', () => {
      s.attempts = 0;
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_subscribe',
          params: ['logs', { address: this.address, topics: this.topics }],
        })
      );

      // Some providers drop idle sockets silently; a ping/pong keeps the
      // connection honest and surfaces a half-open socket quickly.
      s.pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        clearTimeout(s.pongTimer);
        s.pongTimer = setTimeout(
          () => fail('pong timeout'),
          PONG_GRACE_MS
        );
        try {
          ws.ping();
        } catch (_) {
          fail('ping threw');
        }
      }, PING_INTERVAL_MS);
    });

    ws.on('pong', () => clearTimeout(s.pongTimer));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }

      if (msg.id === 1) {
        if (msg.error) return fail(`subscribe rejected: ${msg.error.message}`);
        s.subId = msg.result;
        s.subscribed = true;
        s.lastError = null;
        this.onStatus({ endpoint, connected: true });
        return;
      }

      if (msg.method !== 'eth_subscription') return;
      if (s.subId && msg.params.subscription !== s.subId) return;

      const log = msg.params.result;
      if (!log || !log.topics || log.removed) return; // reorg drops are settled by the reconciler
      s.logsSeen += 1;
      try {
        this.onLog(log, endpoint);
      } catch (e) {
        console.error('[indexer] onLog threw', e);
      }
    });

    ws.on('error', (e) => fail(e.message));
    ws.on('close', () => {
      clearInterval(s.pingTimer);
      clearTimeout(s.pongTimer);
      if (!this.stopped) fail('closed');
    });
  }
}

module.exports = { LogSubscriber };
