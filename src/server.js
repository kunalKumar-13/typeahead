// HTTP server: wires the data system together and exposes the API.
//
//   GET  /suggest?q=<prefix>&mode=<count|recency>&limit=<n>
//   POST /search           { query }
//   GET  /trending?limit=<n>
//   GET  /cache/debug?prefix=<prefix>
//   GET  /metrics
//   GET  /health
//   (static frontend served from ../public)

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { metrics } from './metrics.js';
import {
  initDb,
  loadAllForIndex,
  applyBatch,
  totalRows,
  closeDb,
} from './db.js';
import { Trie } from './trie.js';
import { Trending } from './trending.js';
import { DistributedCache } from './distributedCache.js';
import { BatchWriter } from './batchWriter.js';
import { SuggestionService } from './suggestionService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Bootstrap: build the in-memory indexes from the primary store.
// ---------------------------------------------------------------------------
export function bootstrap() {
  const t0 = Date.now();
  initDb();

  const rows = loadAllForIndex();
  if (rows.length === 0) {
    console.error(
      '\n  No data in the store. Run `npm run setup` (generate + load) first.\n'
    );
  }

  const trie = new Trie();
  const trending = new Trending();
  for (const r of rows) trie.upsert(r.query, r.count);
  trending.loadPersisted(rows);

  const cache = new DistributedCache();
  // BatchWriter only needs an object exposing applyBatch(entries, now); we pass a
  // thin adapter over the db module so it stays decoupled (and easy to fake in tests).
  const batchWriter = new BatchWriter({
    db: { applyBatch },
    trie,
    cache,
    trending,
  });

  const recovered = batchWriter.recover();
  batchWriter.start();

  const suggestions = new SuggestionService({ trie, cache, trending });

  const bootMs = Date.now() - t0;
  console.log(
    `Indexed ${rows.length.toLocaleString()} queries into the Trie in ${bootMs}ms` +
      (recovered ? ` (recovered ${recovered} searches from WAL)` : '')
  );

  // Demonstrate consistent-hashing balance over a large set of DISTINCT keys
  // (evenly sampled across the dataset). With virtual nodes this should be
  // close to even — the honest test of ring balance.
  const distinctSample = [];
  const step = Math.max(1, Math.floor(rows.length / 12000));
  for (let i = 0; i < rows.length; i += step) {
    distinctSample.push(`recency|${rows[i].query}`);
  }
  const dist = cache.ringDistribution(distinctSample);
  const ideal = distinctSample.length / cache.nodeSnapshots().length;
  const spread = Object.values(dist).map(
    (v) => `${((v / ideal - 1) * 100).toFixed(1)}%`
  );
  console.log(
    `Consistent-hash balance over ${distinctSample.length} distinct keys:`,
    dist,
    `(deviation from even: ${spread.join(', ')})`
  );

  return { trie, trending, cache, batchWriter, suggestions };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
export function createApp(ctx) {
  const app = express();
  app.use(express.json());

  // GET /suggest?q=<prefix>&mode=<count|recency>&limit=<n>
  app.get('/suggest', (req, res) => {
    const q = req.query.q ?? '';
    const mode = req.query.mode === 'count' ? 'count' : 'recency';
    const limit = clampLimit(req.query.limit, config.suggest.limit);
    const result = ctx.suggestions.suggest(q, { mode, limit });
    res.json(result);
  });

  // POST /search { query }  -> dummy response + records the search (batched)
  app.post('/search', (req, res) => {
    const query = (req.body && req.body.query != null ? String(req.body.query) : '')
      .replace(/[\r\n\t]/g, ' ') // keep the WAL line-oriented
      .trim()
      .toLowerCase();
    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }
    ctx.batchWriter.record(query);
    // Dummy search API, exactly as specified.
    res.json({ message: 'Searched', query });
  });

  // GET /trending?limit=<n>
  app.get('/trending', (req, res) => {
    const limit = clampLimit(req.query.limit, config.trending.trendingLimit);
    res.json(ctx.suggestions.getTrending(limit));
  });

  // GET /cache/debug?prefix=<prefix>  -> routing + hit/miss + ring state
  app.get('/cache/debug', (req, res) => {
    const rawPrefix = req.query.prefix ?? '';
    const mode = req.query.mode === 'count' ? 'count' : 'recency';
    const prefix = ctx.suggestions.normalize(rawPrefix);
    const key = ctx.suggestions.cacheKey(prefix, mode);
    const route = ctx.cache.route(key);
    const presence = ctx.cache.peek(key);

    // Live demo of balance across nodes over many DISTINCT keys (all 2-char
    // [a-z][a-z] prefixes = 676 keys) so the spread reflects the ring, not a
    // skewed sample.
    const sample = [];
    for (let a = 97; a <= 122; a++)
      for (let b = 97; b <= 122; b++)
        sample.push(`${mode}|${String.fromCharCode(a)}${String.fromCharCode(b)}`);
    const distribution = ctx.cache.ringDistribution(sample);

    res.json({
      input: rawPrefix,
      normalizedPrefix: prefix,
      cacheKey: key,
      routedTo: route.nodeId,
      status: presence.present ? 'HIT' : 'MISS',
      detail: {
        keyHash: route.keyHash,
        ringPosition: route.ringPosition,
        vnodeIndex: route.vnodeIndex,
        ringSize: route.ringSize,
        presence,
      },
      nodes: ctx.cache.nodeSnapshots(),
      sampleKeyDistribution: distribution,
      note:
        'Call GET /suggest?q=' +
        encodeURIComponent(prefix) +
        ' to populate this key, then re-check for a HIT.',
    });
  });

  // GET /metrics -> latency percentiles, hit rate, db read/write, batching
  app.get('/metrics', (req, res) => {
    res.json({
      ...metrics.snapshot(),
      batchWriter: ctx.batchWriter.stats(),
      cacheNodes: ctx.cache.nodeSnapshots(),
      datasetRows: totalRows(),
      trendingTracked: ctx.trending.size,
      trieSize: ctx.trie.size,
    });
  });

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // Static frontend
  app.use(express.static(path.join(__dirname, '..', 'public')));

  return app;
}

function clampLimit(raw, fallback) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 50);
}

// ---------------------------------------------------------------------------
// Start (only when run directly)
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const ctx = bootstrap();
  const app = createApp(ctx);
  const server = app.listen(config.port, () => {
    console.log(`\n  Search Typeahead listening on http://localhost:${config.port}`);
    console.log(`  UI:        http://localhost:${config.port}/`);
    console.log(`  Suggest:   http://localhost:${config.port}/suggest?q=ip`);
    console.log(`  Metrics:   http://localhost:${config.port}/metrics`);
    console.log(`  Cache dbg: http://localhost:${config.port}/cache/debug?prefix=ip\n`);
  });

  const shutdown = (sig) => {
    console.log(`\n${sig} received — flushing batch buffer and shutting down...`);
    server.close(() => {
      ctx.batchWriter.shutdown();
      closeDb();
      process.exit(0);
    });
    // Safety: force-exit if close hangs.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
