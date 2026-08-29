/**
 * Network / contract / RPC configuration. Pure config lookup, no side effects.
 *
 * The endpoints below are defaults, not commitments — every one of them can be
 * overridden from the environment. They exist so the server has a working
 * provider out of the box, because the previously configured Grove endpoints
 * (eth-trace.rpc.grove.city, sepolia.rpc.grove.city) no longer resolve.
 *
 *   RPC_HTTP  comma separated https endpoints, tried in order
 *   RPC_WSS   comma separated wss endpoints, all subscribed simultaneously
 *   START_BLOCK  override the backfill start
 */

const contracts = require('viper-contracts');

const NETWORK_IDS = {
  homestead: '1',
  mainnet: '1',
  sepolia: '11155111',
  rinkeby: '4',
};

const CHAINS = {
  1: {
    name: 'homestead',
    // Viper was deployed at 17669587; start a little before it.
    startBlock: 17669000,
    // Tenderly first: it serves the whole contract history in a single
    // eth_getLogs, which turns the backfill into seconds instead of minutes.
    // The others cap ranges (drpc 10k, publicnode 50k + no deep archive), which
    // the range-splitting in lib/rpc.js handles but more slowly.
    http: [
      'https://mainnet.gateway.tenderly.co',
      'https://eth.drpc.org',
      'https://ethereum-rpc.publicnode.com',
    ],
    wss: ['wss://ethereum-rpc.publicnode.com', 'wss://eth.drpc.org'],
  },
  11155111: {
    name: 'sepolia',
    // Sepolia Viper's first Transfer is at 3857214.
    startBlock: 3800000,
    // Note: sepolia.drpc.org is deliberately absent — it is paid-plan only and
    // answers every request with an upgrade notice.
    http: [
      'https://sepolia.gateway.tenderly.co',
      'https://ethereum-sepolia-rpc.publicnode.com',
    ],
    wss: [
      'wss://ethereum-sepolia-rpc.publicnode.com',
      'wss://sepolia.gateway.tenderly.co',
    ],
  },
};

function getNetwork() {
  return process.env.network || 'homestead';
}

function getNetworkId() {
  return NETWORK_IDS[getNetwork()];
}

function getChainId() {
  return parseInt(getNetworkId(), 10);
}

function getChainConfig(chainId = getChainId()) {
  const base = CHAINS[chainId];
  if (!base) throw new Error(`No chain config for chain ${chainId}`);
  return base;
}

function splitEnvList(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** https endpoints, most preferred first. */
function httpEndpoints(chainId = getChainId()) {
  const fromEnv = splitEnvList(process.env.RPC_HTTP);
  if (fromEnv.length) return fromEnv;

  // Honour the legacy single-endpoint vars if they are still set, but always
  // keep the public defaults behind them as a fallback.
  const legacy = [];
  const legacyValue =
    chainId === 1 ? process.env.RPC : process.env.RPC_TEST || process.env.RPC;
  if (legacyValue && /^https?:\/\//.test(legacyValue)) legacy.push(legacyValue);

  return [...legacy, ...getChainConfig(chainId).http];
}

/** wss endpoints — all of them are subscribed at once, deliveries are deduped. */
function wssEndpoints(chainId = getChainId()) {
  const fromEnv = splitEnvList(process.env.RPC_WSS);
  if (fromEnv.length) return fromEnv;
  return getChainConfig(chainId).wss;
}

function startBlock(chainId = getChainId()) {
  if (process.env.START_BLOCK) return parseInt(process.env.START_BLOCK, 10);
  return getChainConfig(chainId).startBlock;
}

/** Lowercased contract addresses for the active network. */
function addresses(networkId = getNetworkId()) {
  const viper = contracts.Viper.networks[networkId];
  const bite = contracts.BiteByViper.networks[networkId];
  if (!viper || !bite) {
    throw new Error(`No Viper/BiteByViper deployment for network ${networkId}`);
  }
  return {
    viper: viper.address.toLowerCase(),
    biteByViper: bite.address.toLowerCase(),
  };
}

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

module.exports = {
  NETWORK_IDS,
  TRANSFER_TOPIC,
  getNetwork,
  getNetworkId,
  getChainId,
  getChainConfig,
  httpEndpoints,
  wssEndpoints,
  startBlock,
  addresses,
};
