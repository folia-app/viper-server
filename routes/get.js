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
  const placeHolderFilename = path.join(__dirname, `public/viper-loading-loop.gif`)

  if (filename != placeHolderFilename) {
    const response = await refreshOpensea(getNetwork(), contractAddress, tokenId)
    if (response.status == "success") {
      return res.status(200).send(response.data)
    } else {
      return boo(res, response.data + " (" + response.url + ")")
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
  console.log(`return file ${filename}`)
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
