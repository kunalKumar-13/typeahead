// Generates search traffic against a running server, to populate trending and
// exercise the batch writer. Useful for demos and smoke tests.
//
//   npm run seed-traffic
//   SEED_TOTAL=5000 SEED_CONCURRENCY=80 npm run seed-traffic
//
// ~60% of traffic is concentrated on a few "hot" queries (some of them low
// all-time-count long-tail queries) so the recency-aware trending list visibly
// diverges from raw all-time popularity.

import fs from 'node:fs';
import { config } from '../src/config.js';

const HOST = process.env.HOST || `http://localhost:${config.port}`;
const TOTAL = Number(process.env.SEED_TOTAL || 3000);
const CONCURRENCY = Number(process.env.SEED_CONCURRENCY || 50);

// A few deliberately chosen hot queries (these exist in the generated dataset).
// The long-tail ones have modest all-time counts, so hammering them shows
// recency lifting them above more historically-popular siblings.
const HOT = (process.env.HOT && process.env.HOT.split(',')) || [
  'how to make pizza',
  'java interview questions',
  'iphone 15 pro max',
  'samsung galaxy review',
  'python roadmap 2026',
  'system design tutorial',
  'goa tourist places',
  'air fryer deals',
];

function loadSampleQueries(limit = 5000) {
  try {
    const raw = fs.readFileSync(config.paths.dataset, 'utf8');
    const lines = raw.split('\n');
    const out = [];
    for (let i = 1; i < lines.length && out.length < limit; i++) {
      const idx = lines[i].lastIndexOf(',');
      if (idx > 0) out.push(lines[i].slice(0, idx));
    }
    return out;
  } catch {
    return [...HOT];
  }
}

const sample = loadSampleQueries();

function nextQuery(i) {
  // 60% hot, 40% random tail.
  if (i % 10 < 6) return HOT[i % HOT.length];
  return sample[(i * 2654435761) % sample.length] || HOT[0];
}

async function postSearch(query) {
  try {
    const res = await fetch(`${HOST}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`Seeding ${TOTAL} searches to ${HOST} (concurrency ${CONCURRENCY})`);
  const t0 = Date.now();
  let sent = 0;
  let ok = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < TOTAL) {
      const i = cursor++;
      const success = await postSearch(nextQuery(i));
      sent++;
      if (success) ok++;
      if (sent % 500 === 0) process.stdout.write(`\r  sent ${sent}/${TOTAL}...`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const secs = (Date.now() - t0) / 1000;
  process.stdout.write('\n');
  console.log(`Done: ${ok}/${sent} ok in ${secs.toFixed(1)}s (${Math.round(sent / secs)} req/s)`);
  console.log(`\nNow check:`);
  console.log(`  curl '${HOST}/trending'`);
  console.log(`  curl '${HOST}/metrics'   # see writeReductionPct and db.writes vs searchesReceived`);
}

main().catch((e) => {
  console.error('Seeder failed — is the server running?');
  console.error(e.message);
  process.exit(1);
});
