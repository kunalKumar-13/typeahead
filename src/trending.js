// Trending / recency-aware ranking.
//
// Each query carries an exponentially-decayed "recent activity" counter:
//
//   on each search:   recent = recent * 2^(-Δt / halfLife) + 1 ;  ts = now
//   to read it:       effective = recent * 2^(-(now - ts) / halfLife)
//
// Properties this gives us (the points the assignment asks us to explain):
//
//  * How recent searches are tracked:  a single decayed float + timestamp per
//    active query — no need to store every individual search event.
//  * How recent activity affects ranking:  the blended score adds
//    recencyWeight * effectiveRecent on top of log(allTimeCount), so a query
//    being searched a lot right now climbs above an equally-or-more popular
//    all-time query.
//  * Why short-lived spikes don't dominate forever:  the decay is exponential,
//    so a burst loses half its weight every `halfLife` ms. A query that was hot
//    for five minutes is back near zero soon after — only sustained activity
//    keeps a high recent score. All-time count (monotonic) preserves long-term
//    popularity; recency only re-orders.
//
// Only queries with recent activity live in this map, so it stays small and the
// top-N scan for /trending is cheap. Negligible entries are pruned.

import { config } from './config.js';

const LN2 = Math.log(2);

export class Trending {
  constructor({
    halfLifeMs = config.trending.halfLifeMs,
    recencyWeight = config.trending.recencyWeight,
    maxTracked = 20_000,
    epsilon = 1e-3, // prune entries whose effective score falls below this
  } = {}) {
    this.halfLifeMs = halfLifeMs;
    this.recencyWeight = recencyWeight;
    this.maxTracked = maxTracked;
    this.epsilon = epsilon;
    this.map = new Map(); // query -> { recent, ts }
  }

  _decay(dtMs) {
    if (dtMs <= 0) return 1;
    return Math.pow(2, -dtMs / this.halfLifeMs);
  }

  // Register a search for `query`.
  record(query, now = Date.now()) {
    const e = this.map.get(query);
    if (!e) {
      this.map.set(query, { recent: 1, ts: now });
    } else {
      e.recent = e.recent * this._decay(now - e.ts) + 1;
      e.ts = now;
    }
    if (this.map.size > this.maxTracked) this.prune(now);
  }

  // Effective (decayed-to-now) recent score for a query, 0 if untracked.
  effectiveRecent(query, now = Date.now()) {
    const e = this.map.get(query);
    if (!e) return 0;
    return e.recent * this._decay(now - e.ts);
  }

  // Blended ranking score used by the enhanced suggestion ordering.
  // log10 compresses the Zipf-huge all-time counts so recency can meaningfully
  // reorder without a single mega-popular query swamping everything.
  blend(allTimeCount, effectiveRecent) {
    return Math.log10(allTimeCount + 1) + this.recencyWeight * effectiveRecent;
  }

  // Persisted recency state for the batch writer to flush to the DB.
  snapshotFor(query, now = Date.now()) {
    const e = this.map.get(query);
    if (!e) return { recentScore: 0, recentTs: now };
    return { recentScore: e.recent * this._decay(now - e.ts), recentTs: now };
  }

  // Seed recency state from the DB at startup (so trending survives a restart).
  loadPersisted(rows, now = Date.now()) {
    for (const r of rows) {
      if (r.recent_score && r.recent_score > this.epsilon && r.recent_ts) {
        this.map.set(r.query, { recent: r.recent_score, ts: r.recent_ts });
      }
    }
    this.prune(now);
  }

  // Top-N currently-trending queries by effective recent score.
  top(limit = config.trending.trendingLimit, now = Date.now()) {
    const arr = [];
    for (const [query, e] of this.map) {
      const eff = e.recent * this._decay(now - e.ts);
      if (eff > this.epsilon) arr.push({ query, recentScore: eff });
    }
    arr.sort((a, b) => b.recentScore - a.recentScore);
    return arr.slice(0, limit);
  }

  // Trending queries that start with `prefix` — injected into the suggestion
  // candidate pool so a surging query can surface even if its all-time count is
  // too low to be in the Trie's top-N-by-count pool.
  matching(prefix, limit, now = Date.now()) {
    const out = [];
    for (const [query, e] of this.map) {
      if (query.startsWith(prefix)) {
        const eff = e.recent * this._decay(now - e.ts);
        if (eff > this.epsilon) out.push({ query, recentScore: eff });
      }
    }
    out.sort((a, b) => b.recentScore - a.recentScore);
    return out.slice(0, limit);
  }

  // Drop negligible entries; if still over capacity, keep only the strongest.
  prune(now = Date.now()) {
    for (const [query, e] of this.map) {
      const eff = e.recent * this._decay(now - e.ts);
      if (eff <= this.epsilon) this.map.delete(query);
    }
    if (this.map.size > this.maxTracked) {
      const sorted = [...this.map.entries()].sort(
        (a, b) =>
          b[1].recent * this._decay(now - b[1].ts) -
          a[1].recent * this._decay(now - a[1].ts)
      );
      this.map = new Map(sorted.slice(0, this.maxTracked));
    }
  }

  get size() {
    return this.map.size;
  }
}

export default Trending;
