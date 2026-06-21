// Batch writer: collects search-count increments and flushes them to the
// primary store in aggregated batches instead of one DB write per search.
//
// Pipeline per search:
//   record(query)
//     -> append "ts<TAB>query" to the write-ahead log (durable, sequential)
//     -> buffer.set(query, delta + 1)               (in-memory aggregation)
//     -> trending.record(query)                     (recency counter)
//     -> flush early if the buffer holds >= maxBufferSize distinct queries
//
// flush() (also fired on a periodic timer):
//   1. swap out the buffer
//   2. build aggregated entries with persisted recency snapshots
//   3. db.applyBatch(entries)        -- ONE transaction for the whole batch
//   4. trie.increment(...)           -- keep the in-memory index live
//   5. cache.invalidatePrefixesOf(q) -- drop stale cached prefix results
//   6. truncate the WAL              -- those writes are now durable in the DB
//
// Write-reduction: N repeated searches for the same query become a single
// "+N" row-write; many distinct queries share one transaction.
//
// Crash trade-off: a process crash between flushes loses nothing that reached
// the WAL — on restart recover() replays the log into the DB. The residual
// window is power-loss between the OS buffering the append and it hitting disk
// (we don't fsync per line, to keep the write path cheap); for stronger
// guarantees, fsync each WAL append at the cost of latency. Without the WAL,
// a crash would lose all un-flushed in-memory increments.

import fs from 'node:fs';
import { config } from './config.js';
import { metrics } from './metrics.js';

export class BatchWriter {
  constructor({ db, trie, cache, trending, opts = {} }) {
    this.db = db;
    this.trie = trie;
    this.cache = cache;
    this.trending = trending;
    this.flushIntervalMs = opts.flushIntervalMs ?? config.batch.flushIntervalMs;
    this.maxBufferSize = opts.maxBufferSize ?? config.batch.maxBufferSize;
    this.walPath = opts.walPath ?? config.paths.wal;

    this.buffer = new Map(); // query -> aggregated delta
    this.timer = null;
    this.walFd = null;
    this.lastFlush = { entries: 0, searchesCollapsed: 0, at: 0 };
  }

  start() {
    // Open the WAL for appending and keep the fd for fast sequential writes.
    this.walFd = fs.openSync(this.walPath, 'a');
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    // Don't keep the event loop alive solely for the flush timer.
    if (this.timer.unref) this.timer.unref();
  }

  // Replay any WAL left over from a previous crash, before serving traffic.
  // Returns the number of recovered search events.
  recover(now = Date.now()) {
    if (!fs.existsSync(this.walPath)) return 0;
    const raw = fs.readFileSync(this.walPath, 'utf8');
    if (!raw.trim()) return 0;

    const agg = new Map(); // query -> { delta, lastTs }
    let recovered = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      const ts = parseInt(line.slice(0, tab), 10);
      const query = line.slice(tab + 1);
      if (!query) continue;
      const cur = agg.get(query) || { delta: 0, lastTs: 0 };
      cur.delta += 1;
      cur.lastTs = Number.isFinite(ts) ? Math.max(cur.lastTs, ts) : now;
      agg.set(query, cur);
      // Rebuild recency from the logged timestamps.
      this.trending.record(query, Number.isFinite(ts) ? ts : now);
      recovered++;
    }

    // Apply recovered increments directly to DB + trie, then clear the WAL.
    const entries = [];
    for (const [query, { delta }] of agg) {
      const snap = this.trending.snapshotFor(query, now);
      entries.push({
        query,
        countDelta: delta,
        recentScore: snap.recentScore,
        recentTs: snap.recentTs,
      });
      this.trie.increment(query, delta);
    }
    if (entries.length) {
      this.db.applyBatch(entries, now);
      metrics.searchesReceived += recovered; // count them as received
    }
    fs.truncateSync(this.walPath, 0);
    return recovered;
  }

  // Record a single search submission.
  record(query, now = Date.now()) {
    metrics.searchesReceived++;
    metrics.api.search++;
    // 1) durable append (sequential write — cheap relative to a DB txn)
    if (this.walFd !== null) {
      fs.writeSync(this.walFd, `${now}\t${query}\n`);
    }
    // 2) in-memory aggregation
    this.buffer.set(query, (this.buffer.get(query) || 0) + 1);
    // 3) recency counter
    this.trending.record(query, now);
    // 4) size-based flush trigger
    if (this.buffer.size >= this.maxBufferSize) this.flush(now);
  }

  // Flush the aggregation buffer to the primary store as one batch.
  flush(now = Date.now()) {
    if (this.buffer.size === 0) return { entries: 0, searchesCollapsed: 0 };

    const pending = this.buffer;
    this.buffer = new Map(); // swap so new searches accumulate independently

    let searchesCollapsed = 0;
    const entries = [];
    for (const [query, delta] of pending) {
      searchesCollapsed += delta;
      const snap = this.trending.snapshotFor(query, now);
      entries.push({
        query,
        countDelta: delta,
        recentScore: snap.recentScore,
        recentTs: snap.recentTs,
      });
    }

    // 1) durable primary-store write (single transaction)
    this.db.applyBatch(entries, now);

    // 2) keep the in-memory Trie counts live (no DB read needed)
    // 3) invalidate cached prefix results that could now be stale
    for (const e of entries) {
      this.trie.increment(e.query, e.countDelta);
      this.cache.invalidatePrefixesOf(e.query);
    }

    // 4) the buffered writes are now durable in the DB — clear the WAL
    if (this.walFd !== null) fs.ftruncateSync(this.walFd, 0);

    this.lastFlush = { entries: entries.length, searchesCollapsed, at: now };
    return this.lastFlush;
  }

  stats() {
    return {
      bufferedDistinctQueries: this.buffer.size,
      flushIntervalMs: this.flushIntervalMs,
      maxBufferSize: this.maxBufferSize,
      lastFlush: this.lastFlush,
    };
  }

  // Flush remaining buffer and release resources (called on shutdown).
  shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.flush();
    if (this.walFd !== null) {
      fs.closeSync(this.walFd);
      this.walFd = null;
    }
  }
}

export default BatchWriter;
