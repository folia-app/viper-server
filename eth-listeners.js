const { ethers, utils } = require("ethers");
const contracts = require('viper-contracts')
const { extractBiteId, refreshOpensea } = require('./utils.js')

const network = process.env.network;
const networks = {
  'homestead': '1',
  'sepolia': '11155111',
  'rinkeby': '4'
}
const networkID = networks[network]

const provider = new ethers.providers.InfuraProvider(
  network,
  process.env.INFURA_API_KEY,
);
if (contracts.Viper.networks[networkID] == undefined) {
  console.log(`no viper contract on network ${networkID}`)
  return
}
const viperContract = new ethers.Contract(
  contracts.Viper.networks[networkID].address,
  contracts.Viper.abi, provider
)

if (contracts.BiteByViper.networks[networkID] == undefined) {
  console.log(`no bite by viper contract on network ${networkID}`)
  return
}
const biteByViperContract = new ethers.Contract(
  contracts.BiteByViper.networks[networkID].address,
  contracts.BiteByViper.abi, provider
)


// get all previous Transfer events from biteByViperContract
biteByViperContract.queryFilter(biteByViperContract.filters.Transfer(), 0)
  .then((events) => {
    events.forEach((event) => {
      var from = event.args[0]
      var to = event.args[1].toString()
      var tokenId = ethers.BigNumber.from(event.args[2])
      const { length, originalTokenId, senderAddress } = extractBiteId(tokenId)
      console.log({
        from,
        to,
        tokenId: tokenId.toString(),
        length,
        originalTokenId,
        senderAddress

      })
    })
  })

biteByViperContract.on('Transfer', async (...args) => {
  var from = args[0]
  var to = args[1].toString()
  var tokenId = ethers.BigNumber.from(args[2])
  const { length, originalTokenId, senderAddress } = extractBiteId(tokenId)
  refreshOpensea(network, viperContract.address, originalTokenId.toString())

  console.log(`biteByViperContract Transfer:`,
    { from },
    { to },
    { tokenId: tokenId.toString() },
    { length, originalTokenId, senderAddress },
  )
})

viperContract.on('Transfer', async (...args) => {
  var from = args[0]
  var to = args[1].toString()
  var tokenId = ethers.BigNumber.from(args[2])

  console.log(`viperContract Transfer:`,
    { from },
    { to },
    { tokenId: tokenId.toString() }
  )

  refreshOpensea(network, viperContract.address, tokenId.toString())
})

