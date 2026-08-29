const { ethers } = require('ethers');
const contracts = require('viper-contracts');
const { EventSource } = require('eventsource');
const { extractBiteId: extractBiteIdRaw } = require('./lib/bite');
const indexerModule = require('./indexer');

// Cache to store the length of each token
const tokenLengths = new Map();

function getNetwork() {
  return process.env.network;
}
function getNetworkId() {
  const networks = {
    homestead: '1',
    sepolia: '11155111',
    rinkeby: '4',
  };
  const networkID = networks[getNetwork()];
  return networkID;
}

// Index Supply API setup
const API = process.env.VITE_INDEX_SUPPLY_API;
const chainId = getNetwork() == 'homestead' ? 1 : 11155111;

const makeEndpoint = (query, eventSig, live = true) => {
  const escapedQuery = encodeURIComponent(query);
  return `https://api.indexsupply.net/query${
    live ? '-live' : ''
  }?api-key=${API}&query=${escapedQuery}&event_signatures=${eventSig}&chain=${chainId}`;
};

const convertEvent = (event) => {
  if (!event.data) return [];
  const data = JSON.parse(event.data);
  if (!data.result || data.result[0].length == 0) return [];
  const columns = data.result[0][0];
  const records = data.result[0].slice(1);
  return records.map((record) => {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = record[i];
    });
    return obj;
  });
};

// Single source of truth for the bit math now lives in lib/bite.js (plain
// BigInt, no ethers). This wrapper keeps the BigNumber-shaped return value the
// existing callers in routes/ and render.js depend on.
function extractBiteId(tokenId) {
  const raw = extractBiteIdRaw(tokenId);
  return {
    length: ethers.BigNumber.from(raw.length.toString()),
    originalTokenId: ethers.BigNumber.from(raw.originalTokenId.toString()),
    senderAddress: raw.senderAddress,
  };
}

// Process a BiteByViper transfer event to update token lengths
function processBiteByViperTransfer(event) {
  try {
    const tokenId = event.tokenId || event.tokenid;
    if (!tokenId) return;

    const { length, originalTokenId } = extractBiteId(tokenId);

    // Update the length for the original Viper token
    const originalTokenIdStr = originalTokenId.toString();
    const currentLength = tokenLengths.get(originalTokenIdStr) || 0;
    const newLength = Math.max(currentLength, length.toNumber());
    tokenLengths.set(originalTokenIdStr, newLength);

    // Store the length for this BiteByViper token
    tokenLengths.set(tokenId.toString(), 0); // BiteByViper tokens always have length 0

    console.log(
      `Updated length for Viper #${originalTokenIdStr} to ${newLength}`
    );

    // Pre-warm gif generation (lazy require avoids circular dep with render.js)
    try {
      const { addToQueue } = require('./render.js');
      addToQueue(tokenId.toString(), length.toNumber());
      // ...and the Viper that did the biting, whose own image changes because
      // its length just went up. The pre-Index-Supply listener queued both;
      // only the bite survived that migration, so until now a freshly-bitten
      // Viper served a placeholder to whoever looked at it first.
      addToQueue(originalTokenIdStr, newLength + 1);
    } catch (e) {
      console.error('Failed to pre-warm gifs:', e);
    }
  } catch (e) {
    console.error('Error processing BiteByViper transfer:', e);
  }
}

// Process a Viper transfer event to initialize token lengths
function processViperTransfer(event) {
  try {
    const tokenId = event.tokenId || event.tokenid;
    if (!tokenId) return;

    const tokenIdStr = tokenId.toString();

    // Initialize the length for this Viper token if not already set
    if (!tokenLengths.has(tokenIdStr)) {
      tokenLengths.set(tokenIdStr, 0);
      console.log(`Initialized length for Viper #${tokenIdStr} to 0`);
    }
  } catch (e) {
    console.error('Error processing Viper transfer:', e);
  }
}

const transferSig = `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)`;

let isSubscribed = false;
let evt;

const onMsg = (msg) => {
  const events = convertEvent(msg);
  events.forEach((e) => {
    const viperAddress = contracts.Viper.networks[getNetworkId()].address;
    e.address?.toLowerCase() === viperAddress.toLowerCase()
      ? processViperTransfer(e)
      : processBiteByViperTransfer(e);
  });
};

async function init() {
  if (isSubscribed) return;

  // A missing or unknown `network` used to throw straight out of module load
  // and print a bare TypeError; fail with something readable instead.
  const deployment = contracts.Viper.networks[getNetworkId()];
  const biteDeployment = contracts.BiteByViper.networks[getNetworkId()];
  if (!deployment || !biteDeployment) {
    console.error(
      `[utils] no Viper/BiteByViper deployment for network "${getNetwork()}" — Index Supply subscription not started`
    );
    return;
  }

  isSubscribed = true;

  const viperAddress = deployment.address;
  const biteByViperAddress = biteDeployment.address;

  const queryBoth = `
    SELECT "from", "to", tokenId, address, block_num, tx_hash
    FROM transfer
    WHERE address = '${viperAddress}' OR address = '${biteByViperAddress}'
  `;

  // Then, set up live subscription
  const endpoint = makeEndpoint(queryBoth, transferSig);
  evt = new EventSource(endpoint);

  evt.onmessage = onMsg;
  evt.onerror = (error) => {
    console.warn('Error in EventSource connection:', error);
  };

  console.log('Subscribed to transfer events');
}

// Initialize on module load. Still on by default: the Index Supply stream stays
// authoritative until INDEXER_SOURCE=true says otherwise. Set INDEXSUPPLY=false
// to run on the local indexer alone.
if (process.env.INDEXSUPPLY !== 'false') {
  init().catch(console.error);
} else {
  console.log('[utils] Index Supply subscription disabled (INDEXSUPPLY=false)');
}

var refreshOpensea = function (network, address, tokenID) {
  if (network !== 'homestead')
    return new Promise((resolve, reject) =>
      reject("opensea doesn't support metadata refresh on testnet")
    );
  return new Promise((resolve, reject) => {
    // https://testnets-api.opensea.io/api/v1/asset/<your_contract_address>/<token_id>/?force_update=true
    // https://testnets-api.opensea.io/v2/chain/sepolia/contract/0xc8a395e3b82e515f88e0ef548124c114f16ce9e3/nfts/1?limit=50
    // const subdomain = network == 'homestead' ? 'api' : 'testnets-api'
    // var url = `https://${subdomain}.opensea.io/api/v1/asset/${address}/${tokenID}/?force_update=true`

    const options = {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'X-API-KEY': process.env.opensea_api,
      },
    };
    const url = `https://api.opensea.io/v2/chain/ethereum/contract/${address}/nfts/${tokenID}/refresh`;
    fetch(url, options)
      // .then(response => response.json())
      // .then(response => console.log(response))
      // .catch(err => console.error(err));
      // fetch(url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            'OS Network response was not ok, it was ' +
              response.status +
              ' with url ' +
              url
          );
        }
        const contentType = response.headers.get('Content-Type');
        if (!contentType || !contentType.includes('application/json')) {
          throw new TypeError('OS Response was not JSON');
        }
        return response.json();
      })
      .then((data) => {
        resolve({ status: 'success', data, url });
      })
      .catch((error) => {
        resolve({ status: 'error', data: error, url });
      });
  });
};

async function reverseLookup(address) {
  const ensAPI = process.env.BOT_API || 'https://bot.trifle.life';
  try {
    const response = await fetch(
      `${ensAPI}/ens/name?address=${address}&exact=true`
    );
    const data = await response.json();
    return data.name || address;
  } catch (e) {
    console.error('Error looking up ENS name:', e);
    return address;
  }
}

async function getLength(tokenId, isBitten, returnOwner = false) {
  // make sure tokenId is a BigNumber
  tokenId = tokenId.toString();

  const address = isBitten
    ? contracts.BiteByViper.networks[getNetworkId()].address
    : contracts.Viper.networks[getNetworkId()].address;

  let owner;
  if (returnOwner) {
    try {
      owner = await getOwner(address, tokenId);
    } catch (e) {
      console.log(`Error getting owner of ${tokenId} on ${address}`, { e });
      return {
        owner: null,
        length: ethers.BigNumber.from(-1),
      };
    }
  }

  return {
    owner,
    length: resolveLength(tokenId, isBitten),
  };
}

/**
 * Zero-indexed length; every caller adds 1 before displaying it.
 *
 * Order of preference:
 *   1. the local indexer, when it is authoritative
 *   2. the in-memory map fed by the Index Supply stream
 *   3. a deterministic default
 *
 * Step 3 is a fix. Previously a bite with a cold cache derived its length from
 * its own token id while a warm cache returned 0, so a bite's reported Length
 * flipped between its bite number and 1 depending on how long the server had
 * been up. Production has served 1 since launch, so 1 is what it returns now,
 * consistently.
 */
function resolveLength(tokenId, isBitten) {
  tokenId = tokenId.toString();

  // Token 486 is fixed at length 0 by design.
  if (tokenId === '486') return ethers.BigNumber.from(0);

  if (indexerModule.isAuthoritative()) {
    try {
      const fromIndex = indexerModule.get().lengthFor(tokenId, isBitten);
      if (fromIndex !== null && fromIndex !== undefined) {
        return ethers.BigNumber.from(fromIndex);
      }
    } catch (e) {
      console.warn('indexer length lookup failed, falling back:', e.message);
    }
  }

  const cachedLength = tokenLengths.get(tokenId);
  if (cachedLength !== undefined) return ethers.BigNumber.from(cachedLength);

  // Bites are always reported as length 0 here (Length 1 once the caller adds
  // one), matching what the warm path has always returned.
  if (isBitten) return ethers.BigNumber.from(0);

  console.error(`No length available for ${tokenId}`);
  return undefined;
}

async function getOwner(address, tokenId) {
  // The local log table knows the owner without a network call. Asking OpenSea
  // on every metadata request meant their rate limiter could 404 our own
  // tokens; this removes them from the request path entirely.
  if (indexerModule.isAuthoritative()) {
    try {
      const fromIndex = indexerModule.get().ownerOf(address, tokenId);
      if (fromIndex) return fromIndex;
    } catch (e) {
      console.warn('indexer owner lookup failed, falling back:', e.message);
    }
  }

  let owner;
  try {
    owner = await getOwnerOS(address, tokenId);
    return owner;
  } catch (e) {
    console.log(
      `error trying to get owner from OS, going to try getting from index-supply`,
      { e }
    );
  }

  // Use index-supply API to query owner
  const query = `
    SELECT "to" as owner
    FROM transfer
    WHERE address = ${address}
    AND tokenId = ${tokenId}
    ORDER BY block_num DESC
    LIMIT 1
  `;

  try {
    const response = await fetch(makeEndpoint(query, transferSig, false));
    const data = await response.json();
    // {"block_height":22061627,"result":[[["owner"],["0x5115e6d883b88c2393519df59c09c84f26e39439"]]]}
    const owner = data.result[0][1][0];
    if (owner) {
      return owner;
    } else {
      throw new Error(
        `Could not find owner for token ${tokenId} on contract ${address} using query ${query}`
      );
    }
  } catch (e) {
    console.error('Error fetching owner from index-supply:', e);
    throw e;
  }
}

async function getOwnerOS(nftContractAddress, tokenId) {
  const isMainnet = getNetwork() == 'homestead';
  const host = isMainnet ? 'api.opensea.io' : 'testnets-api.opensea.io';
  const chain = isMainnet ? 'ethereum' : 'sepolia';
  const target = `https://${host}/v2/chain/${chain}/contract/${nftContractAddress}/nfts/${tokenId}?limit=50`;
  // const target = `https://${prefix}api.opensea.io/v2/chain/${
  //   getNetwork() == 'homestead' ? 'ethereum' : getNetwork()
  // }/contract/${nftContractAddress}/nfts/${tokenId.toString()}?limit=1`;
  console.log({ api: process.env.opensea_api });
  const options = {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'x-api-key': process.env.opensea_api,
    },
  };
  const request = await fetch(target, options);
  const response = await request.json();
  const nft = response.nft;
  const owners = nft.owners;
  return owners[0].address;
}

function boo(res, int) {
  return res.status(404).send(int.toString() || '404');
}

const formatName = function (tokenId, length, preserve = true) {
  let originalTokenId,
    bitten = false;
  if (String(tokenId).length > 4) {
    bitten = true;
    if (String(tokenId).indexOf('b') > -1) {
      tokenId = String(tokenId).replace('b', '');
    } else {
      ({ length, originalTokenId } = extractBiteId(tokenId));
      tokenId = preserve ? tokenId : originalTokenId;
    }
  }
  const paddedTokenId =
    (bitten && !preserve ? 'b' : '') + String(tokenId).padStart(4, '0');
  const paddedLength = String(length).padStart(3, '0');
  return `${paddedTokenId}/${paddedLength}`;
};

async function sleep(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

// export extractBiteId
module.exports = {
  sleep,
  resolveLength,
  extractBiteId,
  refreshOpensea,
  reverseLookup,
  getLength,
  getOwner,
  getOwnerOS,
  boo,
  getNetwork,
  getNetworkId,
  formatName,
  makeEndpoint,
  convertEvent,
  processViperTransfer,
  processBiteByViperTransfer,
  tokenLengths,
  init,
};
