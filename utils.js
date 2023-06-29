const { ethers } = require("ethers");
const contracts = require('viper-contracts')
const axios = require('axios');


function getNetwork() {
  return process.env.network
}
function getNetworkId() {
  const networks = {
    'homestead': '1',
    'sepolia': '11155111',
    'rinkeby': '4'
  }
  const networkID = networks[getNetwork()]
  return networkID
}

function extractBiteId(tokenId) {
  tokenId = ethers.BigNumber.from(tokenId)
  // length is tokenId bit shifted right 169 bits
  const length = tokenId.shr(169)
  if (length.lt(1)) {
    throw new Error(`Invalid length ${length} for tokenId ${tokenId}`)
  }
  // originalTokenId is tokenId bit shifted right 160 bits and then masked with 0x1ff
  const originalTokenId = tokenId.shr(160).and(0x1ff)
  if (originalTokenId.lt(1) || originalTokenId.gt(486)) {
    throw new Error(`Invalid originalTokenId ${originalTokenId} for tokenId ${tokenId}`)
  }
  // senderAddress is tokenId masked with 0xffffffffffffffffffffffffffffffffffffffff
  const senderAddress = tokenId.and("0xffffffffffffffffffffffffffffffffffffffff")
  return { length, originalTokenId, senderAddress }
}

var refreshOpensea = function (network, address, tokenID) {
  // https://testnets-api.opensea.io/v2/chain/sepolia/contract/0xc8a395e3b82e515f88e0ef548124c114f16ce9e3/nfts/1?limit=50
  const subdomain = network == 'homestead' ? 'api' : 'testnets-api'
  var url = `https://${subdomain}.opensea.io/api/v1/asset/${address}/${tokenID}/?force_update=true`
  fetch(url)
    .then(response => response.json())
    .then(data => console.log({ opensea: data }))
    .catch(error => { console.log(error) })
}

async function reverseLookup(address) {
  const provider = new ethers.providers.InfuraProvider(
    "homestead",
    process.env.INFURA_API_KEY,
  );
  const name = await provider.lookupAddress(address)
  return name || address
}

function getProvider() {
  const provider = new ethers.providers.InfuraProvider(
    getNetwork(),
    process.env.INFURA_API_KEY,
  );
  return provider
}
async function getLength(tokenId, isBitten) {
  const provider = getProvider()

  const address = isBitten ? contracts.BiteByViper.networks[getNetworkId()].address : contracts.Viper.networks[getNetworkId()].address
  const abi = isBitten ? contracts.BiteByViper.abi : contracts.Viper.abi
  const contract = new ethers.Contract(
    address, abi, provider
  )
  let owner
  try {
    owner = await getOwnerOS(address, tokenId)
  } catch (e) {
    return {
      owner: null,
      length: ethers.BigNumber.from(-1)
    }
  }
  const length = isBitten ? ethers.BigNumber.from(0) : (await contract.lengths(tokenId))
  return {
    owner,
    length
  }
}

async function getOwner(tokenId) {
  const provider = getProvider()
  const viperContract = new ethers.Contract(
    contracts.Viper.networks[getNetworkId()].address,
    contracts.Viper.abi, provider
  )

  const owner = await viperContract.ownerOf(tokenId)
  return owner
}

async function getOwnerOS(nftContractAddress, tokenId) {
  const prefix = getNetwork() == 'homestead' ? '' : 'testnets-'
  // https://testnets-api.opensea.io/v2/chain/sepolia/contract/0xc8a395e3b82e515f88e0ef548124c114f16ce9e3/nfts/1?limit=50
  const target = `https://${prefix}api.opensea.io/v2/chain/${getNetwork()}/contract/${nftContractAddress}/nfts/${tokenId.toString()}?limit=1`
  const response = await axios.get(target);
  const nft = response.data.nft
  const owners = nft.owners
  return owners[0].address
}

function boo(res, int) {
  return res.status(404).send(int.toString() || '404')
}


// export extractBiteId
module.exports = { extractBiteId, refreshOpensea, reverseLookup, getLength, getOwner, getOwnerOS, boo }