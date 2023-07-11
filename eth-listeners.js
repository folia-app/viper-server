const { ethers, utils } = require("ethers");
const contracts = require('viper-contracts')
const { extractBiteId, getNetwork, getProvider } = require('./utils.js')
const { addToQueue } = require('./render.js');
console.log('network:', getNetwork())
if (contracts.Viper.networks[getNetwork()] == undefined) {
  console.error(`no viper contract on network ${getNetwork()}`)
  return
}
const viperContract = new ethers.Contract(
  contracts.Viper.networks[getNetwork()].address,
  contracts.Viper.abi, getProvider()
)

if (contracts.BiteByViper.networks[getNetwork()] == undefined) {
  console.error(`no bite by viper contract on network ${getNetwork()}`)
  return
}
const biteByViperContract = new ethers.Contract(
  contracts.BiteByViper.networks[getNetwork()].address,
  contracts.BiteByViper.abi, getProvider()
)


// get all previous Transfer events from biteByViperContract
biteByViperContract.queryFilter(biteByViperContract.filters.Transfer(), 0)
  .then((events) => {
    events.forEach(async (event) => {
      var from = event.args[0]
      var to = event.args[1].toString()
      var tokenId = ethers.BigNumber.from(event.args[2])
      if (process.env.GENERATE_GIFS == "true") {
        const { length, originalTokenId, senderAddress } = extractBiteId(tokenId)
        console.log(`BiteByViper Mint:`,
          { from, to, tokenId: tokenId.toString() },
          { length, originalTokenId, senderAddress },
        )
        addToQueue(tokenId.toString(), 0)
      }
    })
  })

biteByViperContract.on('Transfer', async (...args) => {
  var from = args[0]
  var to = args[1].toString()
  var tokenId = ethers.BigNumber.from(args[2])
  const { length, originalTokenId, senderAddress } = extractBiteId(tokenId)
  console.log(`BiteByViper Mint:`,
    { from, to, tokenId: tokenId.toString() },
    { length, originalTokenId, senderAddress },
  )
  addToQueue(tokenId.toString(), 0)
  addToQueue(originalTokenId.toString(), length.add(1).toNumber())
})


// get all previous Transfer events from biteByViperContract
viperContract.queryFilter(viperContract.filters.Transfer(), 0)
  .then((events) => {
    events.forEach(async (event) => {
      var from = event.args[0]
      var to = event.args[1].toString()
      var tokenId = ethers.BigNumber.from(event.args[2])
      if (process.env.GENERATE_GIFS == "true" && from.toLowerCase() == ethers.constants.AddressZero.toLowerCase()) {
        console.log(`ViperContract Mint:`,
          { from, to, tokenId: tokenId.toString() },
        )
        addToQueue(tokenId.toString(), 1)
      }
    })
  })

viperContract.on('Transfer', async (...args) => {
  var from = args[0]
  var to = args[1].toString()
  var tokenId = ethers.BigNumber.from(args[2])
  if (from.toLowerCase() == ethers.constants.AddressZero.toLowerCase()) {
    console.log(`ViperContract Mint:`,
      { from, to, tokenId: tokenId.toString() },
    )
    addToQueue(tokenId.toString(), 1)
  }
})

