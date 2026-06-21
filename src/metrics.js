// Lightweight in-process metrics. No dependencies so everything else can import
// it freely. Tracks DB read/write counts, cache hits/misses, search/suggest
// volume, and a latency histogram for the /suggest path (for p50/p95/p99).

class Histogram {
  constructor() {
    this.samples = []; // ms; kept bounded
    this.max = 50_000;
  }
  record(ms) {
    this.samples.push(ms);
    if (this.samples.length > this.max) this.samples.shift();
  }
  percentile(p) {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.min(
      sorted.length - 1,
      Math.floor((p / 100) * sorted.length)
    );
    return sorted[idx];
  }
  get count() {
    return this.samples.length;
  }
  mean() {
    if (!this.samples.length) return 0;
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
  }
}

export const metrics = {
  db: { reads: 0, writes: 0, rowsWritten: 0, batches: 0 },
  cache: { hits: 0, misses: 0, sets: 0, evictions: 0, invalidations: 0 },
  api: { suggest: 0, search: 0 },
  searchesReceived: 0, // raw POST /search events (before aggregation)
  suggestLatency: new Histogram(),

  reset() {
    this.db = { reads: 0, writes: 0, rowsWritten: 0, batches: 0 };
    this.cache = { hits: 0, misses: 0, sets: 0, evictions: 0, invalidations: 0 };
    this.api = { suggest: 0, search: 0 };
    this.searchesReceived = 0;
    this.suggestLatency = new Histogram();
  },

  snapshot() {
    const totalCacheLookups = this.cache.hits + this.cache.misses;
    const hitRate =
      totalCacheLookups === 0 ? 0 : this.cache.hits / totalCacheLookups;
    // Write reduction: how many raw search events were collapsed into how few
    // DB row-writes by the batch writer.
    const writeReduction =
      this.db.rowsWritten === 0
        ? 0
        : 1 - this.db.rowsWritten / Math.max(1, this.searchesReceived);
    return {
      db: { ...this.db },
      cache: {
        ...this.cache,
        hitRate: Number((hitRate * 100).toFixed(2)),
      },
      api: { ...this.api },
      searchesReceived: this.searchesReceived,
      writeReductionPct: Number((writeReduction * 100).toFixed(2)),
      suggestLatencyMs: {
        count: this.suggestLatency.count,
        mean: Number(this.suggestLatency.mean().toFixed(3)),
        p50: Number(this.suggestLatency.percentile(50).toFixed(3)),
        p95: Number(this.suggestLatency.percentile(95).toFixed(3)),
        p99: Number(this.suggestLatency.percentile(99).toFixed(3)),
      },
    };
  },
};

export default metrics;
