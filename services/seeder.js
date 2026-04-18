'use strict';

const path        = require('path');
const Board       = require('../models/Board');
const boardConfig = require('../boardConfig.json');

// Load PoliMap provinces.json — adjust path if PoliMap repo moves
const POLIMAP_PATH = path.join(__dirname, '../../PoliMap/canada/provinces.json');

const COUNTRY_BOARDS = [
  { uri: 'ca',  name: 'Canada General', description: 'Canadian politics — general discussion' },
  { uri: 'pol', name: 'Politics',       description: 'Cross-national political discussion', parentUri: null },
  { uri: 'meta', name: 'Meta',          description: 'Site feedback and announcements', parentUri: null }
];

async function upsertBoard(data) {
  const exists = await Board.findOne({ uri: data.uri });
  if (exists) return false;
  await Board.create(data);
  return true;
}

async function run() {
  let created = 0;

  // Global boards
  for (const b of COUNTRY_BOARDS) {
    if (await upsertBoard(b)) created++;
  }

  // Load provinces from PoliMap
  let provinces = [];
  try {
    provinces = require(POLIMAP_PATH);
  } catch (e) {
    console.warn('Seeder: could not load provinces.json from PoliMap — skipping province boards');
  }

  for (const prov of provinces) {
    if (!prov.available) continue;

    const uri = `ca-${prov.code.toLowerCase()}`;

    if (await upsertBoard({
      uri,
      name:        prov.name,
      description: `${prov.name} provincial politics`,
      country:     'ca',
      region:      prov.code.toLowerCase(),
      parentUri:   'ca',
      polimapKey:  prov.code
    })) created++;

    // Hub cities for this province
    const hubs = boardConfig.hubCities[uri] || [];
    for (const hub of hubs) {
      if (await upsertBoard({
        uri:         hub.uri,
        name:        hub.name,
        description: `${hub.name} local politics`,
        country:     'ca',
        region:      prov.code.toLowerCase(),
        parentUri:   uri,
        polimapKey:  prov.code
      })) created++;
    }
  }

  console.log(`Seeder: ${created} board(s) created`);
  return { created };
}

module.exports = { run };
