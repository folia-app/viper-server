const { ethers } = require('ethers');
const contracts = require('viper-contracts');
const { EventSource } = require('eventsource');

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
const API = process.env.INDEX_SUPPLY_API_KEY;
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

function extractBiteId(tokenId) {
  tokenId = ethers.BigNumber.from(tokenId);
  // length is tokenId bit shifted right 169 bits
  const length = tokenId.shr(169);
  if (length.lt(1)) {
    throw new Error(`Invalid length ${length} for tokenId ${tokenId}`);
  }
  // originalTokenId is tokenId bit shifted right 160 bits and then masked with 0x1ff
  const originalTokenId = tokenId.shr(160).and(0x1ff);
  if (originalTokenId.lt(1) || originalTokenId.gt(486)) {
    throw new Error(
      `Invalid originalTokenId ${originalTokenId} for tokenId ${tokenId}`
    );
  }
  // senderAddress is tokenId masked with 0xffffffffffffffffffffffffffffffffffffffff
  const senderAddress =
    '0x' +
    tokenId
      .and('0xffffffffffffffffffffffffffffffffffffffff')
      .toHexString()
      .replace('0x', '')
      .padStart(40, '0');
  return { length, originalTokenId, senderAddress };
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
  isSubscribed = true;

  const viperAddress = contracts.Viper.networks[getNetworkId()].address;
  const biteByViperAddress =
    contracts.BiteByViper.networks[getNetworkId()].address;

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

// Initialize on module load
init().catch(console.error);

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
    const response = await fetch(`${ensAPI}/ens/name?address=${address}`);
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

  let length;
  if (tokenId !== '486') {
    // Get the cached length for this token
    const cachedLength = tokenLengths.get(tokenId);

    if (cachedLength !== undefined) {
      length = ethers.BigNumber.from(cachedLength);
    } else {
      console.error(`No cached length for ${tokenId}`);
    }
  } else {
    // Token ID 486 always has length 0
    length = ethers.BigNumber.from(0);
  }

  return {
    owner,
    length,
  };
}

async function getOwner(address, tokenId) {
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
    const response = await fetch(makeEndpoint(query, '', false));
    const data = await response.json();
    const results = convertEvent({ data: JSON.stringify(data) });
    if (results.length > 0) {
      owner = results[0].owner;
      return owner;
    } else {
      console.error({ results });
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
  const prefix = getNetwork() == 'homestead' ? '' : 'testnets-';
  // https://testnets-api.opensea.io/v2/chain/sepolia/contract/0xc8a395e3b82e515f88e0ef548124c114f16ce9e3/nfts/1?limit=50
  const target = `https://${prefix}api.opensea.io/v2/chain/${
    getNetwork() == 'homestead' ? 'ethereum' : getNetwork()
  }/contract/${nftContractAddress}/nfts/${tokenId.toString()}?limit=1`;
  const options = {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'X-API-KEY': process.env.opensea_api,
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
