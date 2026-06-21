// Central configuration. Every tunable lives here so design trade-offs are
// easy to find, explain, and change. Values can be overridden via env vars.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const num = (envVal, fallback) =>
  envVal !== undefined && envVal !== '' ? Number(envVal) : fallback;

export const config = {
  // ---- Server ----
  port: num(process.env.PORT, 3000),

  // ---- Paths ----
  paths: {
    root: ROOT,
    data: path.join(ROOT, 'data'),
    dataset: path.join(ROOT, 'data', 'queries.csv'),
    db: path.join(ROOT, 'data', 'typeahead.db'),
    // Write-ahead log for the batch writer (crash durability for buffered counts)
    wal: path.join(ROOT, 'data', 'pending-writes.log'),
  },

  // ---- Suggestions ----
  suggest: {
    limit: 10,            // max suggestions returned
    maxPrefixLen: 64,     // guard against pathological input
    candidatePool: 50,    // top-N by count pulled from the Trie before recency re-rank
  },

  // ---- Distributed cache (logical nodes on a consistent-hash ring) ----
  cache: {
    nodeCount: num(process.env.CACHE_NODES, 4),     // # of logical cache nodes
    virtualNodes: num(process.env.VNODES, 150),     // vnodes per physical node on the ring
    perNodeCapacity: num(process.env.CACHE_CAP, 5000), // LRU entries per node
    ttlMs: num(process.env.CACHE_TTL_MS, 30_000),   // suggestion-result TTL
  },

  // ---- Batch writer ----
  batch: {
    flushIntervalMs: num(process.env.FLUSH_MS, 1000), // periodic flush
    maxBufferSize: num(process.env.BATCH_SIZE, 500),  // flush early when this many
                                                      // distinct queries are buffered
    initialCount: 1,   // count assigned to a brand-new query on first search
  },

  // ---- Trending / recency-aware ranking ----
  trending: {
    // Half-life of the exponentially-decayed "recent activity" counter.
    // After this many ms, a burst of activity contributes half as much.
    halfLifeMs: num(process.env.TREND_HALFLIFE_MS, 5 * 60_000), // 5 min
    // Blended suggestion score = log(allTimeCount + 1) + recencyWeight * decayedRecent
    // recencyWeight controls how strongly recent activity reorders suggestions.
    recencyWeight: num(process.env.RECENCY_WEIGHT, 3.0),
    trendingLimit: num(process.env.TRENDING_LIMIT, 10),
    // Cache TTL for the (global) trending list — short, because it changes often.
    cacheTtlMs: num(process.env.TRENDING_TTL_MS, 5_000),
  },

  // ---- Dataset generation ----
  dataset: {
    size: num(process.env.DATASET_SIZE, 120_000), // >= 100k required
    zipfExponent: 1.05, // skew of the popularity distribution
    maxCount: 1_000_000,
  },
};

export default config;
