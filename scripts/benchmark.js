// Performance benchmark for the /suggest path + a write-reduction demo.
//
//   npm run bench
//   BENCH_N=10000 BENCH_CONC=40 npm run bench
//
// Reports, against a RUNNING server:
//   - client-side p50/p95/p99 latency for /suggest (cold pass then warm pass)
//   - cache hit rate, derived from each response's `source` field
//   - server-side DB read/write counts and the batch write-reduction percentage
//
// Run order for a clean demo:  start server -> npm run bench

import fs from 'node:fs';
import { config } from '../src/config.js';

const HOST = process.env.HOST || `http://localhost:${config.port}`;
const N = Number(process.env.BENCH_N || 6000);
const CONC = Number(process.env.BENCH_CONC || 30);

// ---- Build a realistic prefix workload from the dataset ----
function buildPrefixes() {
  let queries = [];
  try {
    const raw = fs.readFileSync(config.paths.dataset, 'utf8');
    const lines = raw.split('\n').slice(1, 4001);
    queries = lines.map((l) => l.slice(0, l.lastIndexOf(','))).filter(Boolean);
  } catch {
    queries = ['iphone', 'java', 'samsung', 'how to', 'python', 'nike shoes'];
  }
  // Derive prefixes (length 1..6). Popular short prefixes recur naturally,
  // which is what makes the cache effective.
  const prefixes = [];
  for (const q of queries) {
    const len = Math.min(q.length, 1 + (q.charCodeAt(0) % 6));
    prefixes.push(q.slice(0, Math.max(1, len)));
  }
  return prefixes;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function runPass(label, prefixes) {
  const latencies = [];
  let hits = 0;
  let misses = 0;
  let errors = 0;
  let cursor = 0;
  const t0 = performance.now();

  async function worker() {
    while (cursor < prefixes.length) {
      const p = prefixes[cursor++];
      const start = performance.now();
      try {
        const res = await fetch(`${HOST}/suggest?q=${encodeURIComponent(p)}`);
        const data = await res.json();
        latencies.push(performance.now() - start);
        if (data.source === 'cache') hits++;
        else misses++;
      } catch {
        errors++;
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  const wall = performance.now() - t0;
  latencies.sort((a, b) => a - b);
  const lookups = hits + misses;
  return {
    label,
    requests: prefixes.length,
    errors,
    throughput: Math.round((prefixes.length / wall) * 1000),
    hitRatePct: lookups ? Number(((hits / lookups) * 100).toFixed(1)) : 0,
    p50: Number(percentile(latencies, 50).toFixed(2)),
    p95: Number(percentile(latencies, 95).toFixed(2)),
    p99: Number(percentile(latencies, 99).toFixed(2)),
    mean: Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)),
  };
}

async function getMetrics() {
  const res = await fetch(`${HOST}/metrics`);
  return res.json();
}

async function writeReductionDemo() {
  // Send K searches over J distinct queries, then wait for a flush and measure
  // how many DB row-writes actually happened.
  const before = await getMetrics();
  const J = 40; // distinct queries
  const K = 4000; // total searches
  const queries = Array.from({ length: J }, (_, i) => `benchmark query ${i}`);
  let cursor = 0;
  async function worker() {
    while (cursor < K) {
      const q = queries[cursor++ % J];
      try {
        await fetch(`${HOST}/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q }),
        });
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  // Wait for at least one flush interval so the batch is persisted.
  await new Promise((r) => setTimeout(r, config.batch.flushIntervalMs + 600));
  const after = await getMetrics();

  return {
    distinctQueries: J,
    searchesSent: K,
    searchesReceivedDelta: after.searchesReceived - before.searchesReceived,
    dbWriteOpsDelta: after.db.writes - before.db.writes,
    dbRowsWrittenDelta: after.db.rowsWritten - before.db.rowsWritten,
    batchesDelta: after.db.batches - before.db.batches,
  };
}

function bar(title) {
  console.log('\n' + '─'.repeat(58));
  console.log(' ' + title);
  console.log('─'.repeat(58));
}

async function main() {
  // sanity check
  try {
    await fetch(`${HOST}/health`);
  } catch {
    console.error(`Server not reachable at ${HOST}. Start it with: npm start`);
    process.exit(1);
  }

  const prefixes = buildPrefixes();
  // Repeat/shuffle to reach N requests with realistic recurrence.
  const workload = [];
  for (let i = 0; i < N; i++) workload.push(prefixes[(i * 48271) % prefixes.length]);

  bar('SUGGEST LATENCY  (cold cache then warm cache)');
  const cold = await runPass('cold', workload);
  const warm = await runPass('warm', workload);
  for (const r of [cold, warm]) {
    console.log(
      ` ${r.label.padEnd(5)} | reqs ${r.requests} | hit ${String(r.hitRatePct).padStart(
        5
      )}% | p50 ${String(r.p50).padStart(6)}ms | p95 ${String(r.p95).padStart(
        6
      )}ms | p99 ${String(r.p99).padStart(6)}ms | ${r.throughput} rps`
    );
  }

  bar('WRITE REDUCTION  (batched writes vs raw searches)');
  const wr = await writeReductionDemo();
  const reduction =
    wr.dbRowsWrittenDelta === 0
      ? 0
      : (1 - wr.dbRowsWrittenDelta / wr.searchesReceivedDelta) * 100;
  console.log(` searches sent .............. ${wr.searchesSent}`);
  console.log(` distinct queries ........... ${wr.distinctQueries}`);
  console.log(` DB transactions (writes) ... ${wr.dbWriteOpsDelta}`);
  console.log(` DB row-writes .............. ${wr.dbRowsWrittenDelta}`);
  console.log(` batches flushed ............ ${wr.batchesDelta}`);
  console.log(
    ` => ${wr.searchesReceivedDelta} searches collapsed into ${wr.dbRowsWrittenDelta} row-writes ` +
      `(${reduction.toFixed(1)}% fewer writes)`
  );

  bar('SERVER METRICS SNAPSHOT');
  const m = await getMetrics();
  console.log(` dataset rows .............. ${m.datasetRows}`);
  console.log(` trie size ................. ${m.trieSize}`);
  console.log(` cache hit rate (cumulative) ${m.cache.hitRate}%`);
  console.log(` db reads / writes ......... ${m.db.reads} / ${m.db.writes}`);
  console.log(
    ` server-side suggest p50/p95/p99  ${m.suggestLatencyMs.p50} / ${m.suggestLatencyMs.p95} / ${m.suggestLatencyMs.p99} ms`
  );
  console.log(` cache nodes:`);
  for (const n of m.cacheNodes) {
    console.log(
      `   ${n.id}: size ${String(n.size).padStart(5)} | hitRate ${n.hitRate}% | evictions ${n.evictions}`
    );
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
