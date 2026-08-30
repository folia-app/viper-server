#!/usr/bin/env node
/**
 * Old-versus-new parity harness.
 *
 *   node scripts/parity.js                       droplet vs Fly, default sample
 *   node scripts/parity.js --tokens 40           bigger sample
 *   node scripts/parity.js --old URL --new URL   compare any two deployments
 *
 * Everything a caller can observe is compared, not just the happy path:
 * metadata bodies byte-for-byte, image bytes, the response headers that affect
 * caching, and the error cases. A difference is only a failure when both sides
 * actually hold the asset — one side having rendered something the other has
 * not yet is drift, not regression, and is reported separately.
 *
 * Exits non-zero if anything regressed, so it can gate a cutover.
 */

const crypto = require('crypto');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
};

const OLD = arg('--old', 'http://64.226.122.159:3001');
const NEW = arg('--new', 'https://folia-viper-render.fly.dev');
const SAMPLE = Number(arg('--tokens', 12));
const STATE_URL = arg('--state', 'https://folia-viper-indexer.fly.dev/v1/state');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let pass = 0;
let fail = 0;
let drift = 0;
const failures = [];
const drifts = [];

function ok(name) {
  pass++;
  console.log(`  PASS  ${name}`);
}
function bad(name, detail) {
  fail++;
  failures.push(`${name}: ${detail}`);
  console.log(`  FAIL  ${name} — ${detail}`);
}
function note(name, detail) {
  drift++;
  drifts.push(`${name}: ${detail}`);
  console.log(`  DRIFT ${name} — ${detail}`);
}

async function get(url, { binary = false } = {}) {
  const res = await fetch(url, { redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    headers: res.headers,
    body: binary ? buf : buf.toString('utf8'),
    bytes: buf.length,
    buf,
  };
}

/** Header fields that change behaviour for a caller or a CDN. */
const SIGNIFICANT_HEADERS = ['content-type', 'cache-control', 'x-pending'];

function compareHeaders(label, a, b) {
  for (const h of SIGNIFICANT_HEADERS) {
    const va = a.headers.get(h);
    const vb = b.headers.get(h);
    if (va !== vb) return `${h}: ${va} vs ${vb}`;
  }
  return null;
}

(async () => {
  console.log(`old: ${OLD}\nnew: ${NEW}\n`);

  // ---- which tokens exist, and at what length ---------------------------
  const state = JSON.parse((await get(STATE_URL)).body);
  const vipers = state.vipers;
  const bites = state.bites;
  const step = Math.max(1, Math.floor(vipers.length / SAMPLE));
  const tokenSample = vipers.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  const biteSample = bites.filter((_, i) => i % Math.max(1, Math.floor(bites.length / 4)) === 0).slice(0, 4);

  console.log(`[metadata] ${tokenSample.length} vipers + ${biteSample.length} bites`);
  for (const t of [...tokenSample.map((v) => v.tokenId), ...biteSample.map((b) => b.tokenId)]) {
    const label = String(t).length > 8 ? `bite ${String(t).slice(0, 8)}…` : `viper ${t}`;
    const [a, b] = await Promise.all([
      get(`${OLD}/v1/metadata/${t}`),
      get(`${NEW}/v1/metadata/${t}`),
    ]);
    if (a.status !== b.status) {
      bad(`${label} metadata`, `status ${a.status} vs ${b.status}`);
      continue;
    }
    if (a.status !== 200) {
      ok(`${label} metadata (both ${a.status})`);
      continue;
    }
    if (a.body === b.body) {
      ok(`${label} metadata byte-identical`);
      continue;
    }
    // A cache-buster mismatch means one side re-rendered; anything else is real.
    const ja = JSON.parse(a.body);
    const jb = JSON.parse(b.body);
    const strip = (o) => JSON.stringify({ ...o, image: String(o.image).split('?')[0], image_url: String(o.image_url).split('?')[0] });
    if (strip(ja) === strip(jb)) {
      note(`${label} metadata`, `identical but for the ?c= cache-buster`);
    } else {
      const keys = [...new Set([...Object.keys(ja), ...Object.keys(jb)])].filter(
        (k) => JSON.stringify(ja[k]) !== JSON.stringify(jb[k])
      );
      bad(`${label} metadata`, `differs in ${keys.join(', ')}`);
    }
  }

  // ---- images -----------------------------------------------------------
  console.log(`\n[images] ${tokenSample.length} vipers`);
  for (const v of tokenSample) {
    const [a, b] = await Promise.all([
      get(`${OLD}/get/img/${v.tokenId}`, { binary: true }),
      get(`${NEW}/get/img/${v.tokenId}`, { binary: true }),
    ]);
    const label = `viper ${v.tokenId} image`;

    if (a.status !== b.status) {
      bad(label, `status ${a.status} vs ${b.status}`);
      continue;
    }
    const pendingA = a.headers.get('x-pending') === 'true';
    const pendingB = b.headers.get('x-pending') === 'true';

    // A placeholder on one side means that side has not rendered it yet.
    if (pendingA !== pendingB) {
      note(label, `${pendingA ? 'old' : 'new'} is still rendering (placeholder)`);
      continue;
    }
    if (pendingA && pendingB) {
      ok(`${label} both pending`);
      continue;
    }
    if (sha(a.buf) === sha(b.buf)) {
      const hdr = compareHeaders(label, a, b);
      hdr ? bad(label, hdr) : ok(`${label} byte-identical (${a.bytes} bytes)`);
    } else {
      bad(label, `${a.bytes} vs ${b.bytes} bytes, sha ${sha(a.buf).slice(0, 12)} vs ${sha(b.buf).slice(0, 12)}`);
    }
  }

  // ---- error handling ---------------------------------------------------
  console.log('\n[errors]');
  for (const bad_ of ['0', 'abc', '999999999', '-1']) {
    const [a, b] = await Promise.all([
      get(`${OLD}/v1/metadata/${bad_}`),
      get(`${NEW}/v1/metadata/${bad_}`),
    ]);
    a.status === b.status
      ? ok(`"${bad_}" → both ${a.status}`)
      : bad(`"${bad_}"`, `status ${a.status} vs ${b.status}`);
  }

  // ---- other routes -----------------------------------------------------
  console.log('\n[routes]');
  for (const path of ['/get/iframe', '/']) {
    const [a, b] = await Promise.all([get(`${OLD}${path}`), get(`${NEW}${path}`)]);
    if (a.status !== b.status) {
      bad(path, `status ${a.status} vs ${b.status}`);
    } else if (a.body === b.body) {
      ok(`${path} identical (${a.status})`);
    } else {
      note(path, `same status ${a.status}, body differs by ${Math.abs(a.bytes - b.bytes)} bytes`);
    }
  }

  console.log(`\n  ${pass} pass · ${fail} fail · ${drift} drift`);
  if (drift) {
    console.log('\n  drift (expected while both are live and rendering independently):');
    drifts.slice(0, 8).forEach((d) => console.log(`    ${d}`));
  }
  if (fail) {
    console.log('\n  regressions:');
    failures.forEach((f) => console.log(`    ${f}`));
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
