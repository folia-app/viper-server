var express = require('express');
var router = express.Router();
const fs = require('fs');
const { ethers } = require("ethers");
const path = require('path')
const { getLength, boo, extractBiteId, formatName, getNetwork, reverseLookup } = require('../utils.js')

const { Viper } = require('viper')

/* GET home page. */
router.get('/', function (req, res, next) {
  res.render('index', { title: 'Viper' });
});

router.get('/v1/metadata/*', async function (req, res, next) {
  let tokenId = req.params[0]

  tokenId = ethers.BigNumber.from(tokenId)
  const isBitten = tokenId.gt(486)

  let { owner, length } = await getLength(tokenId, isBitten)
  if (length.lt(0)) {
    return boo(res, "Invalid tokenId")
  } else {
    length = length.add(1)
  }

  let baseURL = process.env.baseURL

  // check whether image exists, if so add ?c=datetime to the end of the filename
  const filepath = "../public/" + (getNetwork() == "homestead" ? "" : getNetwork() + "-") + "gifs/"
  const filename = formatName(tokenId, length, false) + "/complete.gif"
  const imagePath = path.join(__dirname, filepath, filename)

  var image = `${baseURL}/get/img/${tokenId}`

  if (fs.existsSync(imagePath)) {
    image = image + `?c=${fs.statSync(imagePath).mtimeMs}`
  }

  const v = new Viper({
    seed: getNetwork() == "homestead" ? null : getNetwork(),
    tokenId: tokenId.toString(),
    length: length.toNumber(),
  })

  var animation_url = `${baseURL}/get/iframe#${tokenId}-${length.toString()}`
  const external_url = `https://viper.folia.app` // TODO: change this when we know URL scheme in app

  const viperName = isBitten ? v.allVipers.filter(v => v.tokenId == extractBiteId(tokenId).originalTokenId)[0].name : v.me.name

  const name = isBitten ? "Bite by Viper " + viperName : viperName
  let senderAddress
  if (isBitten) {
    senderAddress = extractBiteId(tokenId).senderAddress.toHexString()
    const ensName = await reverseLookup(senderAddress)
    if (ensName) {
      senderAddress = ensName
    }
  }
  let description
  if (isBitten) {
    description = `You've been bitten by ${viperName} and there is no cure. Blame ${senderAddress}. \n\nTo find out more go to ${external_url}.`
  } else {
    description = `Viper ${viperName} has bitten ${length - 1} ${length - 1 == 1 ? "time" : "times"}. \n\nTo find out more go to https://viper.folia.app.`
  }

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
      { trait_type: 'Length', value: length.toNumber() },
      { trait_type: 'Head', value: v.headBase()[v.me.head % v.headBase().length] },
      { trait_type: 'Style', value: v.styles()[v.me.style] },
      { trait_type: 'Pattern', value: v.patterns()[v.me.pattern] },
      { trait_type: "Mood", value: v.mood()[v.me.head % 13] },

    ],
    // rarebits
    properties: [
      { key: 'Length', value: length.toNumber(), type: 'number' },
      { key: 'Head', value: v.headBase()[v.me.head % v.headBase().length], type: 'string' },
      { key: 'Style', value: v.styles()[v.me.style], type: 'string' },
      { key: 'Pattern', value: v.patterns()[v.me.pattern], type: 'string' },
      { key: "Mood", value: v.mood()[v.me.head % 13], type: 'string' },
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
