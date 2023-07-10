var express = require('express');
const { ethers, utils } = require("ethers");
const fs = require('fs');
const { extractBiteId, getLength, boo, getNetwork, refreshOpensea } = require('../utils.js')
const { Viper } = require('viper')
const stream = require('stream')
const { Gone } = require('http-errors');
const { generateGif, generatePlaceholder, generatePlaceholderAndGif, addToQueue } = require('../render.js');
const path = require('path')
const contracts = require('viper-contracts')

var router = express.Router();

// router.get('/iframe', async function (req, res, next) {
//   const viperIndexPath = require.resolve('viper/dist/index.html');
//   return returnFile(viperIndexPath, req, res, next)
// })
const placeHolderFilename = path.join(__dirname, `public/viper-loading-loop.gif`)


router.get('/iframe', async function (req, res, next) {
  // const indexPath = path.join(__dirname, 'viper', 'dist', 'index.html');
  const viperIndexPath = require.resolve('viper/dist/index.html');
  fs.readFile(viperIndexPath, 'utf8', (err, data) => {
    if (err) {
      return next(err);
    }
    if (getNetwork() !== "homestead") {
      data = data.replace('const seed = null;', `const seed = '${getNetwork()}';`);
    }
    res.send(data);
  });
});


router.get('/refresh-os/*', async function (req, res, next) {

  const params = req.params[0].split("/")
  var tokenId = params[0]
  var viperLength = parseInt(params[1], 10)

  if (!tokenId || parseInt(tokenId) <= 0) {
    return boo(res, "Invalid tokenId")
  }

  let contractAddress
  if (parseInt(tokenId) <= 486) {
    contractAddress = contracts.Viper.networks[getNetwork()].address
    let { length } = await getLength(tokenId)
    if (length.lt(0)) {
      return boo(res, "Invalid tokenId")
    } else {
      // need to add 1 because they're 0 indexed
      length = length.add(1)
    }
    viperLength = length.toNumber()
  } else {
    contractAddress = contracts.BiteByViper.networks[getNetwork()].address
  }
  if (!viperLength || !Number.isInteger(viperLength)) {
    viperLength = 1
  }

  const filename = await generatePlaceholderAndGif(tokenId, viperLength)

  if (filename != placeHolderFilename) {
    // const payload = { "api_key": "d2882307b723c69ff5e75f8333c6cb10", "events": [{ "user_id": "0xaf2ce0962d1a4b1aab10f7faa62bbbca40a8ea53", "device_id": "cf625674-679d-4e4e-be71-27501183e2f9", "session_id": 1688907267167, "time": 1688907938809, "platform": "Web", "language": "en-US", "ip": "$remote", "insert_id": "881549b9-844c-4381-af17-eda6c34c7b53", "event_type": "refresh metadata", "event_properties": { "web3Present": true, "web3Unlocked": true, "web3Network": "11155111", "web3Wallet": "MetaMask", "accountPresent": true, "chain": "SEPOLIA", "chainId": 11155111, "providerName": "MetaMask", "providerPresent": true, "isBanned": false, "isDisabled": false, "theme": "light", "path": `/assets/sepolia/${contractAddress}/${tokenId}`, "queryString": "", "title": `${tokenId} - VIPER-486 | OpenSea`, "url": `https://testnets.opensea.io/assets/sepolia/${contractAddress}/${tokenId}`, "itemId": "QXNzZXRUeXBlOjIwNTcyOTI1MQ==", "address": "0x8fe230e57960b73ec674ce19f1353be9046f3b0e", "chainIdentifier": "SEPOLIA", "tokenId": tokenId, "loggedAt": 1688907938808, "internalEventId": "38275f22-6754-476c-8037-3d2c50d94a27", "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36", "os": "Mac OS", "connectionSpeed": "4g", "cookiesEnabled": true, "screenSize": { "width": 3440, "height": 1440 }, "windowSize": { "width": 1315, "height": 1336 } }, "event_id": 67, "library": "amplitude-ts/2.1.0", "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36" }], "options": {} }
    const response = await refreshOpensea(getNetwork(), contractAddress, tokenId)
    // const response = await fetch(`https://api2.amplitude.com/2/httpapi`, {
    //   method: 'POST',
    //   headers: {
    //     'Content-Type': 'application/json',
    //   },
    //   body: JSON.stringify(payload),
    // })
    // const data = await response.json()
    // console.log({ data })
    if (response.status == "success") {
      return res.status(200).send(response.data)
      // return res.status(200).send(data)
    } else {
      return boo(res, response.data + " (" + response.url + ")")
      // return boo(res, data)
    }
  } else {
    addToQueue(tokenId, viperLength)
    return boo(res, "not done generating image")
  }
  // return res.status(400).send(err)
})


router.get('/img/*', async function (req, res, next) {

  const params = req.params[0].split("/")
  var tokenId = params[0]
  var viperLength = parseInt(params[1], 10)

  if (!tokenId || parseInt(tokenId) <= 0) {
    return boo(res, "Invalid tokenId")
  }
  try {
    if (parseInt(tokenId) <= 486) {
      let { length } = await getLength(tokenId)
      if (length.lt(0)) {
        return boo(res, "Invalid tokenId")
      } else {
        // need to add 1 because they're 0 indexed
        length = length.add(1)
      }
      viperLength = length.toNumber()
    }
    if (!viperLength || !Number.isInteger(viperLength)) {
      viperLength = 1
    }
  } catch (err) {
    console.log({ err })
    return boo(res, "Invalid tokenId")
  }

  try {
    const filename = await generatePlaceholderAndGif(tokenId, viperLength)
    return returnFile(filename, req, res, next)
  } catch (err) {
    console.log({ err })
    return res.status(400).send(err)
  }
})

function returnFile(filename, req, res, next) {
  const cache = (filename.indexOf("viper-loading-loop.gif") > -1 ? (1 / 60) : 15) * 60 // 1 sec or 15 minutes
  res.set('Cache-control', `public, max-age=${cache}`)

  var options = {
    // root: path.join(__dirname, 'public'),
    dotfiles: 'deny',
    headers: {
      'x-timestamp': Date.now(),
      'x-sent': true
    }
  }
  res.sendFile(filename, options, function (err) {
    if (err) {
      next(err)
    } else {
      console.log('Sent:', filename)
    }
  })
}



// /* GET users listing. */
// router.get('/*', async function (req, res, next) {
//   const params = req.params[0].split("/")
//   var contractAddress, originalTokenId, prefix, suffix
//   if (params[0] == 'original') {
//     contractAddress = params[1]
//     originalTokenId = params[2]
//     prefix = 'raw'
//     suffix = ''
//   } else {
//     contractAddress = params[0]
//     originalTokenId = params[1]
//     prefix = 'output'
//     suffix = '.png'
//   }

//   console.log({ contractAddress, originalTokenId })

//   var tokenId = utils.solidityKeccak256(["address", "uint256"], [contractAddress, originalTokenId])

//   console.log(`get:\n`,
//     { contractAddress },
//     { originalTokenId },
//     { tokenId })

//   const filename = `${prefix}/${contractAddress.toString().toLowerCase()}-${originalTokenId.toString().toLowerCase()}-${tokenId.toString().toLowerCase()}${suffix}`

//   try {
//     fs.accessSync(filename)
//   } catch (_) {
//     console.log(`didn't have the file ${filename}`)
//     try {
//       await go(contractAddress, originalTokenId, tokenId, networkID)
//     } catch (err) {
//       if (err.message == 'no such token') {
//         return res.status(404).send(err.message)
//       }
//       console.log({ err })
//       return boo(res, "404")
//     }
//   }

//   try {
//     fs.accessSync(filename)
//   } catch (_) {
//     console.log(`still didn't have the file ${filename}`)
//     boo(res, 6)
//   }

//   const data = fs.readFileSync(filename)
//   res.writeHead(200, {
//     'Content-Type': 'image/png',
//   })
//   return res.end(data);
// });

module.exports = router;
