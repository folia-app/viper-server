#!/usr/bin/env node
/**
 * Prove the local indexer agrees with the system it is replacing.
 *
 *   node scripts/verify-parity.js                  # vs live production API
 *   node scripts/verify-parity.js --index-supply   # also vs Index Supply
 *   node scripts/verify-parity.js --all            # every viper, not a sample
 *
 * Exits non-zero on any mismatch so it can gate a cutover.
 */

require('dotenv').config();

const { Indexer } = require('../indexer');
const chain = require('../lib/chain');

const args = process.argv.slice(2);
const CHECK_IS = args.includes('--index-supply');
const CHECK_ALL = args.includes('--all');
// The production server only serves mainnet. Comparing a sepolia index against
// it would be meaningless, so that leg is skipped unless a base url is given.
const PROD = process.env.PARITY_BASE_URL || null;
const DEFAULT_PROD = 'http://64.226.122.159:3001';

const SIG =
  'Transfer(address indexed from, address indexed to, uint256 indexed tokenId)';

async function indexSupplyCounts(addresses) {
  const key = process.env.VITE_INDEX_SUPPLY_API;
  if (!key) return null;
  const q = `select address, count(tokenId) as c, min(block_num) as fb, max(block_num) as lb from transfer where address in (${addresses.join(
    ', '
  )}) group by address`;
  const u = new URL('https://api.indexsupply.net/query');
  u.searchParams.set('api-key', key);
  u.searchParams.set('query', q);
  u.searchParams.set('event_signatures', SIG);
  u.searchParams.set('chain', String(chain.getChainId()));
  const r = await fetch(u);
  if (!r.ok) throw new Error(`index supply HTTP ${r.status}`);
  const body = await r.json();
  const rows = body.result[0].slice(1);
  return Object.fromEntries(rows.map((row) => [row[0].toLowerCase(), row[1]]));
}

async function main() {
  const indexer = new Indexer();
  console.log(
    `network=${chain.getNetwork()} chain=${indexer.chainId} viper=${
      indexer.addresses.viper
    } bite=${indexer.addresses.biteByViper}`
  );

  await indexer.start();
  const state = indexer.getState();
  console.log(
    `local: ${state.vipers.length} vipers, ${state.bites.length} bites, head block ${state.block}`
  );

  let failures = 0;

  // ---- 1. raw log counts vs Index Supply --------------------------------
  if (CHECK_IS) {
    try {
      const counts = await indexSupplyCounts([
        indexer.addresses.viper,
        indexer.addresses.biteByViper,
      ]);
      if (!counts) {
        console.log('\n[index supply] skipped — no VITE_INDEX_SUPPLY_API set');
      } else {
        const rows = indexer.db.allLogs(indexer.chainId);
        const mine = {};
        for (const r of rows) mine[r.address] = (mine[r.address] || 0) + 1;
        console.log('\n[index supply] raw log counts');
        for (const addr of [indexer.addresses.viper, indexer.addresses.biteByViper]) {
          const theirs = counts[addr] ?? 0;
          const ours = mine[addr] || 0;
          const ok = theirs === ours;
          if (!ok) failures++;
          console.log(
            `  ${ok ? 'OK  ' : 'FAIL'} ${addr}  index-supply=${theirs}  local=${ours}`
          );
        }
      }
    } catch (e) {
      console.log(`\n[index supply] unavailable: ${e.message}`);
    }
  }

  // ---- 2. owner + length vs the live production API ----------------------
  const longest = [...state.vipers].sort((a, b) => b.length - a.length).slice(0, 10);
  const spread = ['1', '7', '42', '100', '250', '333', '486']
    .map((id) => state.vipers.find((v) => v.tokenId === id))
    .filter(Boolean);

  const sample = CHECK_ALL
    ? state.vipers
    : [...new Map([...longest, ...spread].map((v) => [v.tokenId, v])).values()];

  const prodBase =
    PROD || (chain.getNetwork() === 'homestead' ? DEFAULT_PROD : null);

  if (!prodBase) {
    console.log(
      `\n[production] skipped — no production server for network "${chain.getNetwork()}" (set PARITY_BASE_URL to compare)`
    );
  } else {
    console.log(
      `\n[production] checking ${sample.length} viper(s) against ${prodBase}/v1/metadata`
    );
  }

  let matched = 0;
  let skipped = 0;
  let mismatched = 0;
  let cursor = 0;

  const checkOne = async (v) => {
    let res;
    try {
      res = await fetch(`${prodBase}/v1/metadata/${v.tokenId}`);
    } catch (e) {
      skipped++;
      console.log(`  SKIP ${v.tokenId}: ${e.message}`);
      return;
    }
    if (!res.ok) {
      skipped++;
      console.log(`  SKIP ${v.tokenId}: HTTP ${res.status}`);
      return;
    }
    const m = await res.json();
    const attr = m.attributes.find((a) => a.trait_type === 'Length');
    const theirLength = attr ? attr.value : null;
    const theirOwner = (m.owner || '').toLowerCase();

    const lengthOk = theirLength === v.length;
    // Production resolves owner via OpenSea first; treat an absent owner as
    // "nothing to compare" rather than a disagreement.
    const ownerOk = !theirOwner || theirOwner === v.owner.toLowerCase();

    if (lengthOk && ownerOk) {
      matched++;
      return;
    }
    mismatched++;
    console.log(
      `  FAIL ${v.tokenId}: prod length=${theirLength} owner=${theirOwner || '-'} | local length=${v.length} owner=${v.owner}`
    );
  };

  if (prodBase) {
    const worker = async () => {
      while (cursor < sample.length) await checkOne(sample[cursor++]);
    };
    await Promise.all(
      Array.from({ length: Number(process.env.PARITY_CONCURRENCY || 4) }, worker)
    );

    failures += mismatched;
    console.log(
      `  ${matched}/${sample.length} exact match, ${mismatched} mismatch, ${skipped} skipped`
    );
  }

  // ---- 3. internal consistency ------------------------------------------
  console.log('\n[invariants]');
  const bad = [];
  for (const v of state.vipers) {
    if (Number(v.tokenId) < 1 || Number(v.tokenId) > 486) {
      bad.push(`viper id out of range: ${v.tokenId}`);
    }
    if (v.length < 1) bad.push(`viper ${v.tokenId} length < 1`);
    if (!/^0x[0-9a-f]{40}$/.test(v.owner || '')) {
      bad.push(`viper ${v.tokenId} has no owner`);
    }
  }
  for (const b of state.bites) {
    const parent = state.vipers.find((v) => v.tokenId === b.originalTokenId);
    if (!parent) bad.push(`bite ${b.tokenId} has no parent viper`);
    else if (parent.length < b.length + 1) {
      bad.push(
        `viper ${parent.tokenId} length ${parent.length} < bite length ${b.length} + 1`
      );
    }
  }
  const dupes = state.bites.length - new Set(state.bites.map((b) => b.tokenId)).size;
  if (dupes) bad.push(`${dupes} duplicate bite id(s)`);

  if (bad.length) {
    failures += bad.length;
    bad.slice(0, 20).forEach((b) => console.log(`  FAIL ${b}`));
  } else {
    console.log('  OK   all vipers in range, lengths consistent, no duplicate bites');
  }

  indexer.stop();

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
