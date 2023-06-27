var express = require('express');
const { ethers, utils } = require("ethers");
require('dotenv').config()
const fs = require('fs');

// const { Viper } = require('viper')
const stream = require('stream')
const { Gone } = require('http-errors');
const { generateGif, generatePlaceholder, generatePlaceholderAndGif } = require('../render.js');
const path = require('path')
var boo = function (res, int) {
  return res.status(404).send(int.toString() || '404')
}
var router = express.Router();

router.get('/iframe', async function (req, res, next) {
  // const params = req.params[0].split("/")
  // var tokenId = parseInt(params[0], 10)
  // var viperLength = parseInt(params[1], 10)

  // Assuming the current file is in a different location than the "viper" package
  const viperIndexPath = require.resolve('viper/dist/index.html');
  // const viperDirectory = path.dirname(viperIndexPath);
  // const indexPath = path.join(viperDirectory, 'index.html');

  // Read the contents of the index.html file
  // const html = fs.readFileSync(indexPath, 'utf8');

  // Use the html variable as needed
  // console.log(html);
  return returnFile(viperIndexPath, req, res, next)


})

router.get('/img/*', async function (req, res, next) {

  const params = req.params[0].split("/")
  var tokenId = parseInt(params[0], 10)
  var viperLength = parseInt(params[1], 10)

  if (!tokenId || !Number.isInteger(tokenId)) {
    return res.status(404).send("no token id")
  }
  if (!viperLength || !Number.isInteger(viperLength)) {
    viperLength = 1
  }
  // get viper length from chain

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
