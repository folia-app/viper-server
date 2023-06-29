const { ethers } = require("ethers");

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

// export extractBiteId
module.exports = { extractBiteId, refreshOpensea, reverseLookup }