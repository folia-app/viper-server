var express = require('express');
var router = express.Router();
const fs = require('fs');
const { ethers } = require("ethers");
const path = require('path')
const { getLength, boo, extractBiteId } = require('../utils.js')

// const { Viper } = require('viper-contracts')

/* GET home page. */
router.get('/', function (req, res, next) {
  res.render('index', { title: 'Viper' });
});

router.get('/v1/metadata/*', async function (req, res, next) {
  let tokenId = req.params[0]

  tokenId = ethers.BigNumber.from(tokenId)
  const isBitten = tokenId.gt(486)
  console.log({ isBitten })
  let { owner, length } = await getLength(tokenId, isBitten)
  if (length.lt(0)) {
    return boo(res, "Invalid tokenId")
  } else {
    length = length.add(1)
  }

  let baseURL = process.env.baseURL

  var image = `${baseURL}/get/img/${tokenId}`
  var animation_url = `${baseURL}/get/iframe#${tokenId}-${length.toString()}`
  const external_url = baseURL // TODO: fix this

  const name = isBitten ? "Viper Bite by Viper #" + extractBiteId(tokenId).originalTokenId : "Viper #" + tokenId

  let description
  if (isBitten) {
    description = `Bite by Viper is the result of an act of aggression. You've been poisoned and there is no cure. To find out more go to ${external_url}.`
  } else {
    description = `Viper is.... ~ presented by [Folia](https://folia.app)`
  }

  //TODO: add viper attributes

  // the sauce
  const metadata = {
    // both opensea and rarebits
    name,
    owner,

    description,

    // opensea
    external_url,
    // rarebits
    home_url: external_url,

    // opensea
    image,

    // rarebits
    image_url: image,

    // animation
    animation_url,

    // opensea
    attributes: [
      {
        trait_type: 'length',
        value: length.toNumber()
      },
      // {
      //   trait_type: 'mouth',
      //   value: mouths[mouth]
      // }
    ],
    // rarebits
    properties: [
      { key: 'length', value: length.toNumber(), type: 'number' },
      // { key: 'mouth', value: mouths[mouth], type: 'string' }
    ],
    // optimized for folia site
    // animation_url_optim: animation_url,
    // animation_loop: token.animation_loop ?? work.animation_loop ?? false,
    // background: token.background ?? work.background ?? '',

    // youtube_url: '',

    // 3d models
    // obj: asset(work, tokenId, 'obj'),
    // drc: asset(work, tokenId, 'drc'),
    // iframe: asset(work, tokenId, 'iframe')

    // sha hashes for posterity (annoying for works with many files... IPFS is source file...)
    // sha256: work.sha256 || {}
  }



  res.json(metadata);

  // // const data = fs.readFileSync(filename)
  // res.writeHead(200, {
  //   'Content-Type': 'application/json',
  // })
  // return res.end(metadata);

})

router.get('/all/', async function (req, res, next) {
  // count how many gifs exist in the public/gifs folder
  const directoryPath = path.join(__dirname, '../public/gifs');
  const files = fs.readdirSync(directoryPath).filter(name => name.indexOf("-") === 4)//.map(name => name.split("-")[0]);
  const groups = []
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const tokenId = parseInt(file.split("-")[0])
    const index = tokenId - 1
    if (!groups[index]) {
      groups[index] = []
    }
    groups[index].push(file)
  }
  console.log({ groups })

  // use the template inside viers/all.jade
  res.render('all', { files: groups });

})


module.exports = router;
