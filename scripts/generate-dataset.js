// Generates a reproducible, realistically-skewed search dataset.
//
// Output: data/queries.csv  with header `query,count`.
//
// Design notes (for the viva):
//  - We emit single terms first, then 2-grams, then long-tail combinations.
//    Counts are assigned by generation order, so short/common queries ("iphone")
//    land at the head of the distribution and long-tail queries at the bottom.
//  - Counts follow a Zipf law: count(rank) = maxCount / rank^exponent, with
//    multiplicative jitter. This mimics real search traffic (a few very popular
//    queries, a very long tail) and makes the cache/typeahead behaviour realistic.
//  - A seeded PRNG (mulberry32) makes the whole dataset reproducible, so latency
//    and hit-rate numbers in the report are stable across runs.

import fs from 'node:fs';
import { config } from '../src/config.js';

// ---- Seeded PRNG (deterministic, reproducible dataset) ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(1234567);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// ---- Vocabulary across several domains so prefixes match meaningfully ----
const brands = [
  'apple', 'samsung', 'sony', 'lg', 'dell', 'hp', 'lenovo', 'asus', 'acer',
  'microsoft', 'google', 'amazon', 'nike', 'adidas', 'puma', 'reebok', 'gucci',
  'zara', 'levis', 'canon', 'nikon', 'gopro', 'bose', 'jbl', 'xiaomi', 'oneplus',
  'oppo', 'vivo', 'realme', 'motorola', 'nokia', 'huawei', 'logitech', 'razer',
  'corsair', 'intel', 'amd', 'nvidia', 'tesla', 'toyota', 'honda', 'ford', 'bmw',
  'audi', 'mercedes', 'ikea', 'philips', 'panasonic', 'whirlpool', 'dyson',
];
const products = [
  'iphone', 'galaxy', 'macbook', 'laptop', 'phone', 'tablet', 'headphones',
  'earbuds', 'charger', 'cable', 'case', 'cover', 'screen protector', 'monitor',
  'keyboard', 'mouse', 'webcam', 'speaker', 'soundbar', 'tv', 'camera', 'lens',
  'watch', 'smartwatch', 'fitness band', 'router', 'ssd', 'hard drive', 'pendrive',
  'power bank', 'shoes', 'sneakers', 'running shoes', 'jacket', 'jeans', 'tshirt',
  'backpack', 'sunglasses', 'wallet', 'perfume', 'blender', 'air fryer',
  'microwave', 'refrigerator', 'washing machine', 'vacuum cleaner', 'coffee maker',
];
const techTopics = [
  'java', 'python', 'javascript', 'typescript', 'react', 'node', 'spring boot',
  'kubernetes', 'docker', 'system design', 'data structures', 'algorithms',
  'machine learning', 'deep learning', 'sql', 'mongodb', 'redis', 'kafka',
  'aws', 'azure', 'gcp', 'linux', 'git', 'rust', 'golang', 'c++', 'html', 'css',
  'graphql', 'microservices', 'rest api', 'oauth', 'leetcode', 'dynamic programming',
];
const intents = [
  'tutorial', 'for beginners', 'interview questions', 'cheat sheet', 'course',
  'roadmap', 'project ideas', 'best practices', 'examples', 'documentation',
  'crash course', 'in 2026', 'vs', 'certification', 'pdf', 'notes', 'guide',
];
const shopIntents = [
  'price', 'review', 'near me', 'online', 'deals', 'offers', 'discount',
  'best', 'cheap', 'under 500', 'under 1000', 'pro max', 'plus', '5g', 'specs',
  'comparison', 'replacement', 'original', 'second hand', 'on sale',
];
const howToVerbs = [
  'cook', 'make', 'fix', 'install', 'learn', 'draw', 'bake', 'clean', 'build',
  'reset', 'connect', 'download', 'remove', 'create', 'setup', 'tie', 'grow',
];
const howToNouns = [
  'pasta', 'pizza', 'bread', 'a website', 'a resume', 'a budget', 'rice',
  'pancakes', 'a tie', 'a router', 'windows', 'a garden', 'sourdough',
  'a paper plane', 'a campfire', 'coffee', 'a birdhouse', 'a deck',
];
const places = [
  'paris', 'london', 'tokyo', 'new york', 'dubai', 'singapore', 'bali',
  'goa', 'rome', 'barcelona', 'amsterdam', 'bangkok', 'sydney', 'iceland',
];
const travelIntents = [
  'flights', 'hotels', 'things to do', 'weather', 'tourist places', 'visa',
  'best time to visit', 'itinerary', 'food', 'map', 'tour packages',
];

function* generateCandidates() {
  // 1) single high-frequency terms (head of the distribution)
  const singles = new Set([
    ...products, ...techTopics, ...brands, ...places,
  ]);
  for (const s of singles) yield s;

  // 2) brand + product
  for (const b of brands) for (const p of products) yield `${b} ${p}`;

  // 3) product + shopping intent
  for (const p of products) for (const s of shopIntents) yield `${p} ${s}`;

  // 4) tech topic + learning intent
  for (const t of techTopics) for (const i of intents) yield `${t} ${i}`;

  // 5) how-to queries
  for (const v of howToVerbs) for (const n of howToNouns) yield `how to ${v} ${n}`;

  // 6) travel queries
  for (const pl of places) for (const ti of travelIntents) yield `${pl} ${ti}`;

  // 7) long-tail: brand + product + shopping intent (huge space)
  for (const b of brands)
    for (const p of products)
      for (const s of shopIntents)
        yield `${b} ${p} ${s}`;

  // 8) long-tail: topic + intent + year-ish modifiers
  const years = ['2024', '2025', '2026', 'latest', 'updated', 'free', 'advanced'];
  for (const t of techTopics)
    for (const i of intents)
      for (const y of years)
        yield `${t} ${i} ${y}`;
}

function sanitize(q) {
  // Keep CSV simple: collapse whitespace, drop commas/quotes.
  return q.replace(/[",]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function main() {
  const target = config.dataset.size;
  const { zipfExponent, maxCount } = config.dataset;

  const seen = new Set();
  const queries = [];
  for (const cand of generateCandidates()) {
    const q = sanitize(cand);
    if (!q || seen.has(q)) continue;
    seen.add(q);
    queries.push(q);
    if (queries.length >= target) break;
  }

  if (queries.length < target) {
    console.warn(
      `WARNING: vocabulary produced only ${queries.length} distinct queries ` +
        `(< requested ${target}). Increase vocabulary or templates.`
    );
  }

  // Assign Zipf counts by generation order (rank 1 = most popular).
  const lines = ['query,count'];
  let totalCount = 0;
  for (let i = 0; i < queries.length; i++) {
    const rank = i + 1;
    const base = maxCount / Math.pow(rank, zipfExponent);
    const jitter = 0.6 + rand() * 0.8; // 0.6x .. 1.4x
    const count = Math.max(config.batch.initialCount, Math.round(base * jitter));
    totalCount += count;
    lines.push(`${queries[i]},${count}`);
  }

  fs.mkdirSync(config.paths.data, { recursive: true });
  fs.writeFileSync(config.paths.dataset, lines.join('\n') + '\n');

  console.log(`Generated ${queries.length.toLocaleString()} distinct queries`);
  console.log(`  -> ${config.paths.dataset}`);
  console.log(`  total synthetic search volume: ${totalCount.toLocaleString()}`);
  console.log(
    `  sample head:`,
    queries.slice(0, 3).map((q, i) => `"${q}"`).join(', ')
  );
}

main();
