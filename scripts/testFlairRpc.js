'use strict';
// One-off connectivity check: exercises the same RPC path getFlairForWallet
// uses, without needing a real wallet with matching holdings.
const mongoose = require('mongoose');
const config   = require('../config');
const flair    = require('../services/flair');

(async () => {
  await mongoose.connect(config.mongo.uri);
  const testAddr = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'; // vitalik.eth, arbitrary known address
  try {
    const result = await flair.getFlairForWallet(testAddr);
    console.log('OK, no RPC error. Result:', result);
  } catch (e) {
    console.log('RPC ERROR:', e.message);
  }
  await mongoose.disconnect();
})();
