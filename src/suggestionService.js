// Orchestrates the read path: cache -> Trie -> recency re-rank.
//
// suggest(prefix, mode):
//   1. normalise the prefix (trim leading ws, lowercase) and handle empties
//   2. look in the distributed cache (keyed by mode|prefix)
//   3. on a miss, pull a candidate pool (top-N by all-time count) from the Trie
//   4. mode === 'count'   -> order by all-time count            (BASIC version)
//      mode === 'recency' -> order by blended recency score     (ENHANCED version)
//      and also fold in currently-trending matches so a surging low-all-time
//      query can still surface
//   5. cache the result with a TTL and return it
//
// Latency for the whole call (cache hit or miss) is recorded for p50/p95/p99.

import { config } from './config.js';
import { metrics } from './metrics.js';

export class SuggestionService {
  constructor({ trie, cache, trending }) {
    this.trie = trie;
    this.cache = cache;
    this.trending = trending;
    this._trendingCache = { at: 0, value: null };
  }

  normalize(prefix) {
    if (prefix == null) return '';
    let p = String(prefix).replace(/^\s+/, '').toLowerCase();
    if (p.length > config.suggest.maxPrefixLen) {
      p = p.slice(0, config.suggest.maxPrefixLen);
    }
    return p;
  }

  cacheKey(prefix, mode) {
    return `${mode}|${prefix}`;
  }

  suggest(rawPrefix, { mode = 'recency', limit = config.suggest.limit } = {}) {
    const t0 = performance.now();
    const prefix = this.normalize(rawPrefix);

    // Graceful handling of empty / whitespace-only / missing input.
    if (prefix.trim() === '') {
      metrics.suggestLatency.record(performance.now() - t0);
      metrics.api.suggest++;
      return { prefix, mode, source: 'empty', node: null, suggestions: [] };
    }

    const key = this.cacheKey(prefix, mode);
    // Consistent-hash routing decision for this prefix key (surfaced to the UI).
    const node = this.cache.ownerNode(key);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      metrics.suggestLatency.record(performance.now() - t0);
      metrics.api.suggest++;
      return { prefix, mode, source: 'cache', node, suggestions: cached };
    }

    // ---- Cache miss: build from the primary in-memory index ----
    const pool = this.trie.topK(prefix, config.suggest.candidatePool); // [{query,count}]

    let suggestions;
    if (mode === 'count') {
      // BASIC: pure all-time popularity.
      suggestions = pool
        .slice(0, limit)
        .map((c) => ({ query: c.query, count: c.count }));
    } else {
      // ENHANCED: blend all-time popularity with decayed recent activity.
      const now = Date.now();
      const byQuery = new Map();
      for (const c of pool) byQuery.set(c.query, c.count);
      // Fold in trending matches the Trie pool might have missed.
      for (const t of this.trending.matching(prefix, config.suggest.candidatePool, now)) {
        if (!byQuery.has(t.query)) byQuery.set(t.query, this.trie.getCount(t.query));
      }
      const scored = [];
      for (const [query, count] of byQuery) {
        const recent = this.trending.effectiveRecent(query, now);
        scored.push({
          query,
          count,
          recentScore: Number(recent.toFixed(4)),
          score: Number(this.trending.blend(count, recent).toFixed(4)),
        });
      }
      scored.sort((a, b) => b.score - a.score);
      suggestions = scored.slice(0, limit);
    }

    this.cache.set(key, suggestions);
    metrics.suggestLatency.record(performance.now() - t0);
    metrics.api.suggest++;
    return { prefix, mode, source: 'store', node, suggestions };
  }

  // Currently-trending queries (short-TTL cached, since they change often).
  getTrending(limit = config.trending.trendingLimit) {
    const now = Date.now();
    if (this._trendingCache.value && now - this._trendingCache.at < config.trending.cacheTtlMs) {
      return { source: 'cache', trending: this._trendingCache.value };
    }
    const top = this.trending.top(limit, now).map((t) => ({
      query: t.query,
      recentScore: Number(t.recentScore.toFixed(4)),
      count: this.trie.getCount(t.query),
    }));
    this._trendingCache = { at: now, value: top };
    return { source: 'store', trending: top };
  }
}

export default SuggestionService;
