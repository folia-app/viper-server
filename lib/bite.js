/**
 * Pure bit-math for BiteByViper token ids. No side effects, no ethers, no I/O —
 * safe to require from anywhere (utils.js re-exports a BigNumber-flavoured
 * wrapper so existing callers keep working unchanged).
 *
 * A bite token id packs three values:
 *   bits 169+    length of the viper at the time of the bite
 *   bits 160-168 the original Viper token id (1..486)
 *   bits 0-159   the address that did the biting
 */

const MAX_VIPER_ID = 486;
const ADDRESS_MASK = (1n << 160n) - 1n;

/**
 * @param {string|number|bigint} tokenId
 * @returns {{ length: bigint, originalTokenId: bigint, senderAddress: string }}
 */
function extractBiteId(tokenId) {
  const id = BigInt(tokenId);

  const length = id >> 169n;
  if (length < 1n) {
    throw new Error(`Invalid length ${length} for tokenId ${id}`);
  }

  const originalTokenId = (id >> 160n) & 0x1ffn;
  if (originalTokenId < 1n || originalTokenId > BigInt(MAX_VIPER_ID)) {
    throw new Error(
      `Invalid originalTokenId ${originalTokenId} for tokenId ${id}`
    );
  }

  const senderAddress =
    '0x' + (id & ADDRESS_MASK).toString(16).padStart(40, '0');

  return { length, originalTokenId, senderAddress };
}

/** True when a token id is in BiteByViper's id space rather than Viper's 1..486. */
function isBiteTokenId(tokenId) {
  try {
    return BigInt(tokenId) > BigInt(MAX_VIPER_ID);
  } catch (_) {
    return false;
  }
}

module.exports = { extractBiteId, isBiteTokenId, MAX_VIPER_ID };
