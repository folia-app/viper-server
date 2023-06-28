var express = require('express');
var router = express.Router();
const fs = require('fs');
const { utils } = require("ethers");
const path = require('path')
const { ethers } = require("ethers");

// const { Viper } = require('viper-contracts')

/* GET home page. */
router.get('/', function (req, res, next) {
  res.render('index', { title: 'Viper' });
});

router.get('/v1/metadata/*', function (req, res, next) {
  let tokenId = req.params[0]

  if (tokenId.substring(0, 2) == "0x") {
    tokenId = utils.BigNumber.from(tokenId).toString()
  }
  const owner = ethers.constants.AddressZero // TODO: fix
  const length = 2 // TODO: fix

  let baseURL = process.env.baseURL

  var image = `${baseURL}/get/img/${tokenId}/${length}`
  var animation_url = `${baseURL}/get/iframe#${tokenId}-${length}`

  // the sauce
  const metadata = {
    // both opensea and rarebits
    name: `Viper No ${tokenId}`,
    owner,

    description: `Viper is.... ~ presented by [Folia](https://folia.app)`,

    // opensea
    external_url: baseURL,// 'https://viper.folia.app/tokens/' + tokenId, // TODO: add back once ready
    // rarebits
    home_url: baseURL,//'https://viper.folia.app/tokens/' + tokenId, //TODO: add back once ready

    // opensea
    image,

    // rarebits
    image_url: image,

    // animation
    animation_url,

    // opensea
    attributes: [
      // {
      //   trait_type: 'eyes',
      //   value: eyes[eye]
      // },
      // {
      //   trait_type: 'mouth',
      //   value: mouths[mouth]
      // }
    ],
    // rarebits
    properties: [
      // { key: 'eyes', value: eyes[eye], type: 'string' },
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
