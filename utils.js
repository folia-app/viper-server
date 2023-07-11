const { ethers } = require("ethers");
const contracts = require('viper-contracts')



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
  if (network !== 'homestead') return new Promise((resolve, reject) => reject('opensea doesn\'t support metadata refresh on testnet'))
  return new Promise((resolve, reject) => {
    // https://testnets-api.opensea.io/api/v1/asset/<your_contract_address>/<token_id>/?force_update=true
    // https://testnets-api.opensea.io/v2/chain/sepolia/contract/0xc8a395e3b82e515f88e0ef548124c114f16ce9e3/nfts/1?limit=50
    // const subdomain = network == 'homestead' ? 'api' : 'testnets-api'
    // var url = `https://${subdomain}.opensea.io/api/v1/asset/${address}/${tokenID}/?force_update=true`

    const options = {
      method: 'POST',
      headers: { accept: 'application/json', 'X-API-KEY': process.env.opensea_api }
    };
    const url = `https://api.opensea.io/v2/chain/ethereum/contract/${address}/nfts/${tokenID}/refresh`
    fetch(url, options)
      // .then(response => response.json())
      // .then(response => console.log(response))
      // .catch(err => console.error(err));
      // fetch(url)
      .then(response => {
        if (!response.ok) {
          throw new Error('OS Network response was not ok, it was ' + response.status + ' with url ' + url)
        }
        const contentType = response.headers.get('Content-Type')
        if (!contentType || !contentType.includes('application/json')) {
          throw new TypeError('OS Response was not JSON')
        }
        return response.json()
      })
      .then(data => {
        resolve({ status: 'success', data, url })
      })
      .catch(error => {
        resolve({ status: 'error', data: error, url })
      })
  })
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
    owner = await getOwner(address, tokenId)
    // owner = await getOwnerOS(address, tokenId)
  } catch (e) {
    console.log(`Error getting owner of ${tokenId} on ${address}`)
    return {
      owner: null,
      length: ethers.BigNumber.from(-1)
    }
  }
  let length
  if (tokenId !== '486' && !tokenId.eq(486)) {
    length = isBitten ? ethers.BigNumber.from(0) : (await contract.lengths(tokenId))
  } else {
    length = ethers.BigNumber.from(0)
  }
  return {
    owner,
    length
  }
}

async function getOwner(address, tokenId) {
  const provider = getProvider()
  const NFTContract = new ethers.Contract(
    address,
    contracts.Viper.abi, provider
  )

  const owner = await NFTContract.ownerOf(tokenId)
  return owner
}

async function getOwnerOS(nftContractAddress, tokenId) {
  const prefix = getNetwork() == 'homestead' ? '' : 'testnets-'
  // https://testnets-api.opensea.io/v2/chain/sepolia/contract/0xc8a395e3b82e515f88e0ef548124c114f16ce9e3/nfts/1?limit=50
  const target = `https://${prefix}api.opensea.io/v2/chain/${getNetwork()}/contract/${nftContractAddress}/nfts/${tokenId.toString()}?limit=1`

  const request = await fetch(target)
  const response = await request.json()
  const nft = response.data.nft
  const owners = nft.owners
  return owners[0].address
}

function boo(res, int) {
  return res.status(404).send(int.toString() || '404')
}


const formatName = function (tokenId, length, preserve = true) {
  let originalTokenId, bitten = false
  if (String(tokenId).length > 4) {
    bitten = true;
    if (String(tokenId).indexOf("b") > -1) {
      tokenId = String(tokenId).replace("b", "")
    } else {
      ({ length, originalTokenId } = extractBiteId(tokenId))
      tokenId = preserve ? tokenId : originalTokenId
    }
  }
  const paddedTokenId = (bitten && !preserve ? "b" : "") + String(tokenId).padStart(4, '0')
  const paddedLength = String(length).padStart(3, '0')
  return `${paddedTokenId}/${paddedLength}`
}


// export extractBiteId
module.exports = { extractBiteId, refreshOpensea, reverseLookup, getLength, getOwner, getOwnerOS, boo, getNetwork, getNetworkId, getProvider, formatName }