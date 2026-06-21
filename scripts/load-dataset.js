// Loads data/queries.csv into the SQLite primary store.
//
// Usage:  npm run load          (after `npm run generate`)
//         npm run setup         (generate + load in one step)
//
// To load YOUR OWN dataset instead, just place a CSV with a `query,count`
// header at data/queries.csv (or set DATASET path) and run this script.

import fs from 'node:fs';
import readline from 'node:readline';
import { config } from '../src/config.js';
import { initDb, bulkInsert, totalRows, closeDb } from '../src/db.js';

const CHUNK = 5000; // rows per transaction

async function main() {
  const file = process.env.DATASET || config.paths.dataset;
  if (!fs.existsSync(file)) {
    console.error(`Dataset not found: ${file}`);
    console.error('Run `npm run generate` first, or place a CSV there.');
    process.exit(1);
  }

  initDb();
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });

  let isHeader = true;
  let buffer = [];
  let loaded = 0;
  let skipped = 0;
  const t0 = Date.now();

  const flush = () => {
    if (buffer.length) {
      bulkInsert(buffer);
      loaded += buffer.length;
      buffer = [];
      process.stdout.write(`\r  loaded ${loaded.toLocaleString()} rows...`);
    }
  };

  for await (const line of rl) {
    if (isHeader) {
      isHeader = false;
      // tolerate a header row; if it doesn't look like one, treat as data
      if (/query\s*,\s*count/i.test(line)) continue;
    }
    const idx = line.lastIndexOf(',');
    if (idx === -1) {
      skipped++;
      continue;
    }
    const query = line.slice(0, idx).trim().toLowerCase();
    const count = parseInt(line.slice(idx + 1).trim(), 10);
    if (!query || !Number.isFinite(count)) {
      skipped++;
      continue;
    }
    buffer.push({ query, count });
    if (buffer.length >= CHUNK) flush();
  }
  flush();

  const total = totalRows();
  closeDb();

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write('\n');
  console.log(`Done in ${secs}s`);
  console.log(`  rows loaded:   ${loaded.toLocaleString()}`);
  console.log(`  rows skipped:  ${skipped.toLocaleString()}`);
  console.log(`  rows in table: ${total.toLocaleString()}`);
  if (total < 100_000) {
    console.warn(
      `  NOTE: table has < 100k rows. Increase DATASET_SIZE and re-run setup.`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
