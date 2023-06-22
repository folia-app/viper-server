const { ethers, utils } = require("ethers");
contracts = require('./viper-contracts.js')
console.log({ contracts })

var checkCount = function () {
  console.log('checking count')
  // for(let i = 1; i < 257; i++) {
  //   h=("00" + i).slice (-3);
  //     const tokenID = ('12000' + h)
  //     checkTrans(tokenID)
  //   }

  // async function checkTrans(token) {
  //   fs.readdir( 'output', (error, files) => {
  //   const startsWithtokenID = files.filter((files) => files.slice(0, 8)===token.toString());
  //   let data = startsWithtokenID.length-1;
  //   if (data < 0) {
  //     data = 0
  //   }

  //   fs.writeFile("public/txt/"+token.toString()+".txt", data.toString(), (err) => {
  //   if (err) console.log(err);
  //       });
  //   });
  // };
}
// checkCount()
// setInterval(checkCount, 24 * 60 * 60 * 1000)

// const { FoliaControllerV2 } = require('folia-contracts');
// const { FoliaControllerV2 } = require('folia-contracts');

// const seriesID = '12'

const network = process.env.network;
console.log({ network })
console.log({ filename: __filename })
console.log({ dirname: __dirname })
const networks = {
  'homestead': '1',
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
viperContract = new ethers.Contract(
  contracts.Viper.networks[networkID].address,
  contracts.Viper.abi, provider
)

// var refreshOpensea = function(tokenID) {
//   var url = `https://api.opensea.io/api/v1/asset/${viper.address}/${tokenID}/?force_update=true`
//   console.log({url})
//   fetch(url)
//   .then(response => response.json())
//   .then(data => console.log({opensea: data}))
//   .catch(error => { console.log(error) })
// }

// var checkAll = async (first = false) => {
//   console.log(`check all`)
//   var makeVid = async (tokenID, owner) => {
//     const vid = `output/${tokenID.toString() + owner.toLowerCase()}.mp4`
//     console.log(`MAKE VID: (${vid})`)
//     try {
//       if (!first) {
//         fs.accessSync(vid)
//         console.log(`EXISTS ALREADY: ${vid}`)
//         return
//       } else {
//         throw new Error('make it anyway')
//       }
//     } catch (_) { 
//       try {
//         await go(tokenID, owner)
//         refreshOpensea(tokenID)
//       } catch(error) {
//         console.log(`FAILED TO MAKE: ${vid}`)
//         console.log(`RETRY IN 1sec`)
//         console.log({error})
//         setTimeout(async() => {
//           makeVid(tokenID, owner)
//         }, 1000)
//       }
//     }
//   }
//   var totalSupply = Number((await viperContract.totalSupply()).toString())
//   for (var i = 1; i < totalSupply + 1; i++) {
//     var tokenID = (seriesID * 1_000_000) + i
//     var owner = (await viperContract.ownerOf(tokenID)).toLowerCase()
//     makeVid(tokenID, owner)
//     await (() => {
//       return new Promise((resolve, _) => {
//         setTimeout(resolve, 10 * 1000) // 10 sec
//       })
//     })()
//   }
// }
// var checkAllInterval = setInterval(checkAll, 60 * 60 * 1000) // 60 min
// checkAll(true)


viperContract.on('editionBought', async (...args) => {
  var contractAddress = args[0]
  var originalTokenId = args[1].toString()
  var tokenId = ethers.BigNumber.from(args[2]).toHexString()

  console.log(`editionBought:`,
    { contractAddress },
    { originalTokenId },
    { tokenId }
  )

  var makeImg = async (contractAddress, originalTokenId, tokenId) => {
    const filename = `output/${contractAddress.toString().toLowerCase()}-${originalTokenId.toString().toLowerCase()}-${tokenId.toString().toLowerCase()}.png`
    console.log(`MAKE IMG: (${filename})`)
    try {
      fs.accessSync(filename)
      console.log(`EXISTS ALREADY: ${filename}`)
      return
    } catch (_) {
      try {
        await go(contractAddress, originalTokenId, tokenId, networkID)
      } catch (error) {
        console.log('error is ', { error }, 'message is ', error.message)
        if (error.message == 'no such token') {
          return res.status(404).send(error.message)
        }
        console.log(`FAILED TO MAKE: ${filename}`)
        console.log(`RETRY IN 1sec`)
        console.log({ error })
        setTimeout(async () => {
          makeImg(contractAddress, originalTokenId, tokenId)
        }, 1000)
      }
    }
  }
  makeImg(contractAddress, originalTokenId, tokenId)
})
