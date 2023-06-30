const { ethers, utils } = require("ethers");
// var fetch = require("node-fetch")
const fs = require('fs');
const client = require('https');
const { Viper } = require('viper')
const { createCanvas, loadImage } = require('canvas')
const { spawn } = require('child_process');
const { extractBiteId, refreshOpensea, getNetwork, getProvider } = require('./utils.js')
const contracts = require('viper-contracts')

const path = require('path')
const preloads = {}
let lastCheckedQueueLength = 0
const queue = []
const currentSpawns = []
var os = require('os');

var cores = os.cpus().length
const maxSpawns = cores > 2 ? cores - 2 : 1
console.log(`max spawns: ${maxSpawns}`)
const v = new Viper()
const GENERATE_GIFS = process.env.GENERATE_GIFS == "true" ? true : false
const preload = GENERATE_GIFS ? v.allVipers.length : 0
const minLength = 1
const maxLength = getNetwork() == "homestead" ? 60 : 1

let totalTime = 0
let numberOfVipers = 0

const formatName = function (tokenId, length, preserve = true) {
  let originalTokenId, bitten = false
  if (String(tokenId).length > 4) {
    bitten = true;
    if (tokenId.indexOf("b") > -1) {
      tokenId = tokenId.replace("b", "")
    } else {
      ({ length, originalTokenId } = extractBiteId(tokenId))
      tokenId = preserve ? tokenId : originalTokenId
    }
  }
  const paddedTokenId = (bitten && !preserve ? "b" : "") + String(tokenId).padStart(4, '0')
  const paddedLength = String(length).padStart(3, '0')
  return `${paddedTokenId}/${paddedLength}`
}
for (let j = minLength; j <= maxLength; j++) {
  for (let i = 1; i <= preload; i++) {
    queue.push(formatName(i, j))
  }
}

const queueChecker = setInterval(() => {
  if (lastCheckedQueueLength !== queue.length) {
    lastCheckedQueueLength = queue.length
    console.log(`queue length: ${queue.length}`)
  }
  while (queue.length > 0 && currentSpawns.length < maxSpawns) {
    console.log('spawning')
    const next = queue.shift()
    console.log(`next: ${next}`, `There are ${currentSpawns.length} current spawns, and ${queue.length} in the queue. The max spawn is ${maxSpawns}`)
    const [tokenId, viperLength] = next.split("/")
    generateGif(tokenId, viperLength)
  }
}, 5000)


var addToQueue = async function (tokenId, viperLength) {
  const queueIndex = queue.indexOf(formatName(tokenId, viperLength))
  const currentSpawnsIndex = currentSpawns.indexOf(formatName(tokenId, viperLength))

  // make sure that gif is in queue
  if (queueIndex < 0 && currentSpawnsIndex < 0) {
    console.log(`adding ${formatName(tokenId, viperLength, false)} to queue`)
    queue.unshift(`${formatName(tokenId, viperLength)}`)
  } else if (queueIndex > -1) {
    console.log(`${formatName(tokenId, viperLength, false)} already in queue at position ${queueIndex}`)
    if (queueIndex != 0) {
      console.log(`moving ${formatName(tokenId, viperLength, false)} to front of queue`)
      // move to front of queue
      queue.splice(queueIndex, 1)
      queue.unshift(formatName(tokenId, viperLength))
    }
  } else {
    console.log(`${formatName(tokenId, viperLength, false)} already in currentSpawns at position ${currentSpawnsIndex}`)
  }
}

var generatePlaceholderAndGif = async function (tokenId, viperLength) {

  const dirPrefix = "public/" + (process.env.network == "homestead" ? "" : process.env.network + "-") + "gifs/"

  // check if gif is already generated
  // if so, return gif
  const filename = path.join(__dirname, dirPrefix + `${formatName(tokenId, viperLength, false)}/complete.gif`)

  try {
    fs.accessSync(filename)
    return filename
  } catch (_) {
    console.log(`no gif found at ${filename}`)
  }

  addToQueue(tokenId, viperLength)

  // check if placeholder img is already generated
  // if so, return placeholder img
  // const placeHolderFilename = path.join(__dirname, `output/placeholder/${formatName(tokenId, viperLength)}.png`)
  const placeHolderFilename = path.join(__dirname, `public/viper-loading-loop.gif`)
  try {
    fs.accessSync(placeHolderFilename)
    return placeHolderFilename
  } catch (_) {
    console.log(`no placeholder found at ${placeHolderFilename}, begin generation`)
  }

  // create placeholder img
  // return placeholder img filename
  return await generatePlaceholder(tokenId, viperLength)
}

const generateGif = async function (tokenId, viperLength) {
  // generate gif
  console.log(`generateGif ${formatName(tokenId, viperLength, false)}`)
  if (currentSpawns.length >= maxSpawns) {
    console.log('max spawns reached, returning without running')
    return
  }

  currentSpawns.push(`${formatName(tokenId, viperLength)}`)
  const dirPrefix = "public/" + (process.env.network == "homestead" ? "" : process.env.network + "-") + "gifs/"

  // check if gif is already generated
  // if so, return gif
  const filename = path.join(__dirname, dirPrefix + `${formatName(tokenId, viperLength, false)}/complete.gif`)
  try {
    fs.accessSync(filename)
    console.log(`gif already exists at ${filename}, removing from currentSpans queue`)
    currentSpawns.splice(currentSpawns.indexOf(`${formatName(tokenId, viperLength, false)}`), 1)
    return
  } catch (_) { }


  const start = new Date().getTime();
  const child = spawn(`./node_modules/viper/bin/viper-cli.js`, ['generate-gif', tokenId, viperLength, dirPrefix])

  child.stdout.on('data', data => {
    console.log(`stdout-${formatName(tokenId, viperLength, false)}:\n${data}`);
  });

  child.stderr.on('data', data => {
    console.error(`stderr-${formatName(tokenId, viperLength, false)}: ${data}`);
  });

  child.on('error', (error) => {
    console.error(`error-${formatName(tokenId, viperLength, false)}: ${error.message}`);
  });
  child.on('close', async (code) => {
    const end = new Date().getTime();


    console.log(`child process exited with code ${code} while running on ${formatName(tokenId, viperLength, false)}`);

    const filename = path.join(__dirname, dirPrefix + `${formatName(tokenId, viperLength, false)}/complete.gif`)
    console.log(`checking if ${filename} exists`)
    try {
      fs.accessSync(filename)
      const duration = end - start
      totalTime += duration
      numberOfVipers++
      console.log(`gif completed at : ${filename} in a time of ${duration / 1000} s, average time: ${(totalTime / numberOfVipers) / 1000} s`)
      let contract
      if (formatName(tokenId, viperLength).indexOf("b") > -1) {
        contract = contracts.BiteByViper
      } else {
        contract = contracts.Viper
      }

      // if token exists on chain, refresh it on opensea
      const instantiaedContract = new ethers.Contract(
        contract.networks[getNetwork()].address,
        contract.abi,
        getProvider()
      )
      try {
        const owner = await instantiaedContract.ownerOf(tokenId.toString())
        console.log({ owner })
        refreshOpensea(getNetwork(), contract.networks[getNetwork()].address, tokenId.toString())
      } catch (e) {
        console.log('error from ownerOf, token does not exist on chain yet')
      }

    } catch (e) {
      console.log({ e })
      console.log(`exited without completing the gif, adding back to queue: ${formatName(tokenId, viperLength, false)}`)
      currentSpawns.splice(currentSpawns.indexOf(`${formatName(tokenId, viperLength)}`), 1)
      queue.unshift(`${formatName(tokenId, viperLength)}`)
      return
    }

    try {
      console.log('now that gif is complete, try optimizing it')
      await optimizeGif(filename)
    } catch (e) {
      console.log(`failed to optimize gif, exited with error:`, { e })
    }

    console.log('done trying to optimize gif, OK to remove from queue whether optimization worked or not')
    currentSpawns.splice(currentSpawns.indexOf(`${formatName(tokenId, viperLength)}`), 1)

  });
}

var optimizeGif = async function (filename) {
  return new Promise((resolve, reject) => {
    const child = spawn(`gifsicle`, ['-b', '-O2', filename])

    child.stdout.on('data', data => {
      console.log(`stdout-gifsicle:\n${data}`);
    });
    child.stderr.on('data', data => {
      console.error(`stderr-gifsicle: ${data}`);
    });
    child.on('error', (error) => {
      console.error(`error-gifsicle: ${error.message}`);
    });
    child.on('close', async (code) => {
      console.log(`child process exited with code ${code} while running gifsicle`);
      if (code == 0) {
        resolve()
      } else {
        reject(code)
      }

    })

  })



}

var generatePlaceholder = async function (tokenId, viperLength) {
  // generate placeholder img
  console.log('generate placeholder')
  const canvas = createCanvas(686, 686)
  const ctx = canvas.getContext('2d')
  ctx.font = "bold 32px serif";
  ctx.fillText(`please wait while viper #${tokenId}`, 100, 243)
  ctx.fillText(` is being generated`, 100, 343)
  // save placeholder img
  const filename = `${__dirname}/output/placeholder/${formatName(tokenId, viperLength, false)}.png`
  const out = fs.createWriteStream(filename)
  const stream = canvas.createPNGStream()
  stream.pipe(out)
  return new Promise((resolve, reject) => {
    out.on('finish', () => resolve(filename))
    out.on('error', reject)
  })
}

module.exports = { generateGif, generatePlaceholder, generatePlaceholderAndGif, addToQueue }


