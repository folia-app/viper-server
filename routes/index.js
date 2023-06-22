var express = require('express');
var router = express.Router();
const fs = require('fs');
const { utils } = require("ethers");
const path = require('path')
/* GET home page. */
router.get('/', function (req, res, next) {
  res.render('index', { title: 'Viper' });
});

router.get('/v1/metadata/*', function (req, res, next) {
  let tokenId = req.params[0]
  // const params = req.params[0].split("/")
  // var contractAddress = params[0]
  // var originalTokenId = params[1]
  // var tokenId = utils.solidityKeccak256([ "address", "uint256" ], [ contractAddress, originalTokenId ])
  if (tokenId.substring(0, 2) == "0x") {
    tokenId = utils.BigNumber.from(tokenId).toString()
  }
  var tokenIdInHex = utils.BigNumber.from(tokenId).toHexString()

  let rawdata
  try {
    rawdata = fs.readFileSync(`json/${tokenIdInHex}.json`);
  } catch (error) {
    return res.status(404).send(error)
  }

  let baseURL = process.env.baseURL

  let data = JSON.parse(rawdata);
  var contractAddress = data.asset_contract.address
  var originalTokenId = data.token_id
  var contractName = data.asset_contract.name
  var tokenName = data.name

  var originalImage = `${baseURL}/get/original/${contractAddress}/${originalTokenId}`
  var newImage = `${baseURL}/get/${contractAddress}/${originalTokenId}`

  var gifEndpoint = `${baseURL}/gif/${tokenIdInHex}`

  var properties = {
    collection: contractName
  }

  var image_url = newImage
  var description = `Viper is.... ~ presented by [Folia](https://folia.app)`

  var name = `Viper ${tokenName}`

  // the sauce
  const metadata = {
    // both opensea and rarebits
    name,

    // owner: owner,
    // name: `${doc.data.artist}, "${doc.data.title}", ${doc.data.year} (${printNo}/${doc.data.edition})`,

    description, // by token ID?
    // description: doc.data.description[0].text ?? '',

    // all assets related to the work (posterity)
    // directory: token.directory || work.directory,

    // opensea
    external_url: 'https://viper.folia.app/tokens/' + tokenId,
    // rarebits
    home_url: 'https://viper.folia.app/tokens/' + tokenId,

    // opensea
    image: image_url,
    // rarebits
    image_url,

    // opensea
    // attributes: token.attributes || [],
    properties: properties || [],
    // attributes: [
    //   {
    //     trait_type: 'artist',
    //     value: doc.data.artist
    //   },
    //   {
    //     trait_type: 'year',
    //     value: doc.data.year
    //   }
    // ],
    // rarebits
    // properties: [
    //   { key: 'zodiac', value: returnZodiac(tokenId), type: 'string' }
    // ],

    // rarebits
    // tags: ['cool', 'hot', 'mild']

    // open sea
    animation_url: gifEndpoint,

    // optimized for folia site
    // animation_url_optim: asset(work, tokenId, 'animation_url_optim'),
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

// router.get('/gif/*', function (req, res, next) {
//   let tokenId = req.params[0]
//   console.log({ tokenId })
//   if (tokenId.substring(0, 2) != '0x') {
//     tokenId = utils.BigNumber.from(tokenId).toHexString()
//     // tokenId = parseInt(tokenId).toString(16)
//     console.log({ tokenId })
//   }
//   // const params = req.params[0].split("/")
//   // var contractAddress = params[0]
//   // var originalTokenId = params[1]
//   // var tokenId = utils.solidityKeccak256([ "address", "uint256" ], [ contractAddress, originalTokenId ])
//   let rawdata
//   try {
//     rawdata = fs.readFileSync(`json/${tokenId}.json`);
//   } catch (error) {
//     return res.status(404).send(error)
//   }
//   let data = JSON.parse(rawdata);
//   var contractAddress = data.asset_contract.address
//   var originalTokenId = data.token_id
//   var contractName = data.asset_contract.name
//   var tokenName = data.name

//   res.render('gif', { contractAddress, originalTokenId, contractName, tokenName });
// });


module.exports = router;
