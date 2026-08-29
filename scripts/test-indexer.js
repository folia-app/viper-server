#!/usr/bin/env node
/**
 * Deterministic tests for the indexer's internals — no network, no RPC.
 *
 * These cover the paths that are hard to observe in production because they
 * depend on events that happen a few times a month, or on a reorg: delta
 * emission, duplicate delivery from two sockets, reorg replacement, and the
 * resume watermark.
 *
 *   node scripts/test-indexer.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.network = process.env.network || 'homestead';

const { Indexer } = require('../indexer');
const dbLib = require('../lib/db');

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

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `got ${a}, want ${e}`);
}

// ---------------------------------------------------------------- fixtures

const VIPER = '0x32f8f03197c55741ccf8dea9d8f014281bd30183';
const BITE = '0x044ec6ce7e87859eb9d3ca966cadfb7926d0c482';
const ZERO = '0x0000000000000000000000000000000000000000';
const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const CAROL = '0x3333333333333333333333333333333333333333';

const pad32 = (addr) => '0x' + addr.replace('0x', '').padStart(64, '0');
const TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Encode a BiteByViper token id the way the contract does. */
function biteTokenId(length, originalTokenId, sender) {
  return (
    (BigInt(length) << 169n) |
    (BigInt(originalTokenId) << 160n) |
    BigInt(sender)
  ).toString();
}

function log({ block, idx, address, from, to, tokenId, hash }) {
  return {
    blockNumber: '0x' + block.toString(16),
    blockHash: hash || '0x' + `b${block}`.padEnd(64, '0'),
    logIndex: '0x' + idx.toString(16),
    transactionHash: '0x' + `t${block}${idx}`.padEnd(64, '0'),
    address,
    topics: [
      TRANSFER,
      pad32(from),
      pad32(to),
      '0x' + BigInt(tokenId).toString(16).padStart(64, '0'),
    ],
  };
}

function makeIndexer() {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'viper-idx-')),
    'test.sqlite'
  );
  const ix = new Indexer({
    chainId: 1,
    networkId: '1',
    addresses: { viper: VIPER, biteByViper: BITE },
    dbFile: file,
  });
  ix.db = dbLib.open(file);
  return ix;
}

const rows = (ix, logs) => logs.map((l) => dbLib.toRow(ix.chainId, l));

// ------------------------------------------------------------------- tests

console.log('[derivation]');
{
  const ix = makeIndexer();
  const bite1 = biteTokenId(1, 7, ALICE);
  const bite2 = biteTokenId(2, 7, BOB);

  ix.db.insertMany(
    rows(ix, [
      log({ block: 100, idx: 0, address: VIPER, from: ZERO, to: ALICE, tokenId: 7 }),
      log({ block: 101, idx: 0, address: BITE, from: ZERO, to: BOB, tokenId: bite1 }),
      log({ block: 102, idx: 0, address: BITE, from: ZERO, to: CAROL, tokenId: bite2 }),
    ])
  );
  ix._invalidate();
  const s = ix.derive();

  eq('one viper derived', s.vipers.length, 1);
  eq('viper 7 owner', s.vipers[0].owner, ALICE);
  eq('viper length is max bite length + 1', s.vipers[0].length, 3);
  eq('two bites derived', s.bites.length, 2);
  eq('bite records its sender', s.bites[0].from, ALICE);
  eq('bite records its parent', s.bites[0].originalTokenId, '7');
  eq('lengthFor(viper) is zero-indexed', ix.lengthFor('7', false), 2);
  eq('lengthFor(bite) is always 0', ix.lengthFor(bite1, true), 0);
  eq('ownerOf reads the latest transfer', ix.ownerOf(VIPER, '7'), ALICE);
  ix.db.close();
}

console.log('\n[transfers move ownership]');
{
  const ix = makeIndexer();
  ix.db.insertMany(
    rows(ix, [
      log({ block: 100, idx: 0, address: VIPER, from: ZERO, to: ALICE, tokenId: 9 }),
      log({ block: 105, idx: 0, address: VIPER, from: ALICE, to: BOB, tokenId: 9 }),
      log({ block: 110, idx: 2, address: VIPER, from: BOB, to: CAROL, tokenId: 9 }),
    ])
  );
  ix._invalidate();
  eq('latest transfer wins', ix.derive().vipers[0].owner, CAROL);
  eq('no phantom bites', ix.derive().bites.length, 0);
  eq('unbitten viper has length 1', ix.derive().vipers[0].length, 1);
  ix.db.close();
}

console.log('\n[duplicate delivery from two sockets]');
{
  const ix = makeIndexer();
  const l = log({ block: 200, idx: 3, address: VIPER, from: ZERO, to: ALICE, tokenId: 11 });
  const first = ix.db.insertMany(rows(ix, [l]));
  const second = ix.db.insertMany(rows(ix, [l]));
  eq('first delivery inserts', first, 1);
  eq('second delivery is ignored', second, 0);
  eq('one row stored', ix.db.countLogs(1), 1);
  ix.db.close();
}

console.log('\n[reorg replacement]');
{
  const ix = makeIndexer();
  // A bite lands at block 300 on one fork...
  const orphan = biteTokenId(1, 12, ALICE);
  ix.db.insertMany(
    rows(ix, [
      log({ block: 299, idx: 0, address: VIPER, from: ZERO, to: ALICE, tokenId: 12 }),
      log({
        block: 300, idx: 0, address: BITE, from: ZERO, to: BOB, tokenId: orphan,
        hash: '0x' + 'aa'.repeat(32),
      }),
    ])
  );
  ix._invalidate();
  eq('bite visible before reorg', ix.derive().bites.length, 1);
  eq('parent length raised before reorg', ix.derive().vipers[0].length, 2);

  // ...then that fork is replaced by one where it never happened.
  const res = ix.db.replaceFrom(1, 300, []);
  ix._invalidate();
  eq('orphaned row removed', res.removed, 1);
  eq('bite gone after reorg', ix.derive().bites.length, 0);
  eq('parent length rolled back', ix.derive().vipers[0].length, 1);
  eq('pre-reorg history untouched', ix.db.countLogs(1), 1);
  ix.db.close();
}

console.log('\n[delta emission]');
{
  const ix = makeIndexer();
  ix.db.insertMany(
    rows(ix, [
      log({ block: 400, idx: 0, address: VIPER, from: ZERO, to: ALICE, tokenId: 20 }),
    ])
  );
  ix._invalidate();
  ix.derive(); // warm the cache, as start() does before going live

  const seen = [];
  ix.on('delta', (d) => seen.push(d));

  // a new bite arrives over the socket
  const newBite = biteTokenId(1, 20, ALICE);
  ix._onLiveLog(
    log({ block: 401, idx: 0, address: BITE, from: ZERO, to: BOB, tokenId: newBite })
  );

  eq('one delta emitted', seen.length, 1);
  eq('delta is not a resync', seen[0].resync, false);
  eq('delta carries the new bite', seen[0].bites.length, 1);
  eq('delta carries the changed viper', seen[0].vipers.length, 1);
  eq('changed viper has its new length', seen[0].vipers[0].length, 2);
  eq('delta block', seen[0].block, 401);

  // the same log arriving again from the other socket must be silent
  ix._onLiveLog(
    log({ block: 401, idx: 0, address: BITE, from: ZERO, to: BOB, tokenId: newBite })
  );
  eq('duplicate emits no second delta', seen.length, 1);

  // an unrelated viper transfer emits only that viper
  ix._onLiveLog(
    log({ block: 402, idx: 0, address: VIPER, from: ALICE, to: CAROL, tokenId: 20 })
  );
  eq('transfer emits a delta', seen.length, 2);
  eq('transfer delta has no bites', seen[1].bites.length, 0);
  eq('transfer delta shows new owner', seen[1].vipers[0].owner, CAROL);
  ix.db.close();
}

console.log('\n[malformed input is survivable]');
{
  const ix = makeIndexer();
  ix.db.insertMany(
    rows(ix, [
      log({ block: 500, idx: 0, address: VIPER, from: ZERO, to: ALICE, tokenId: 30 }),
      // a bite id whose parent is out of range — must be skipped, not thrown
      log({
        block: 501, idx: 0, address: BITE, from: ZERO, to: BOB,
        tokenId: biteTokenId(1, 500, ALICE),
      }),
    ])
  );
  ix._invalidate();
  let threw = null;
  try {
    ix.derive();
  } catch (e) {
    threw = e.message;
  }
  check('derive does not throw on an undecodable bite', threw === null, threw);
  eq('undecodable bite is skipped', ix.derive().bites.length, 0);
  eq('valid viper still present', ix.derive().vipers.length, 1);
  ix.db.close();
}

console.log('\n[resume watermark]');
{
  const ix = makeIndexer();
  ix.db.setSyncState(1, { backfilled_to: 12345, head: 12400, finalized: 12380 });
  const s = ix.db.getSyncState(1);
  eq('watermark persisted', s.backfilled_to, 12345);
  eq('head persisted', s.head, 12400);
  eq('finalized persisted', s.finalized, 12380);

  // a watermark must never move backwards on a partial run
  ix.db.setSyncState(1, { head: 12500 });
  eq('unrelated update preserves watermark', ix.db.getSyncState(1).backfilled_to, 12345);
  ix.db.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
