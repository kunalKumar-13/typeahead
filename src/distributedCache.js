// Distributed cache: N logical CacheNodes placed on a consistent-hash ring.
//
// A prefix key is hashed onto the ring to choose its owning node, so the same
// prefix always routes to the same node (cache affinity), and adding/removing a
// node only remaps ~1/N of keys. This is the "distributed cache using consistent
// hashing" the assignment requires, implemented with in-process logical nodes so
// it runs with zero external services. Swapping CacheNode for a real Redis client
// keyed by the same ring would make it a true multi-host cache with no change to
// callers.

import { CacheNode } from './cacheNode.js';
import { ConsistentHashRing } from './consistentHash.js';
import { config } from './config.js';
import { metrics } from './metrics.js';

export class DistributedCache {
  constructor({
    nodeCount = config.cache.nodeCount,
    virtualNodes = config.cache.virtualNodes,
    capacity = config.cache.perNodeCapacity,
    ttlMs = config.cache.ttlMs,
  } = {}) {
    this.ttlMs = ttlMs;
    this.nodes = new Map(); // nodeId -> CacheNode
    const ids = [];
    for (let i = 0; i < nodeCount; i++) {
      const id = `cache-node-${i}`;
      ids.push(id);
      this.nodes.set(id, new CacheNode(id, { capacity, ttlMs }));
    }
    this.ring = new ConsistentHashRing(ids, virtualNodes);
  }

  _nodeFor(key) {
    const id = this.ring.getNode(key);
    return this.nodes.get(id);
  }

  get(key) {
    const node = this._nodeFor(key);
    const value = node ? node.get(key) : undefined;
    if (value === undefined) metrics.cache.misses++;
    else metrics.cache.hits++;
    return value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    const node = this._nodeFor(key);
    if (node) {
      node.set(key, value, ttlMs);
      metrics.cache.sets++;
    }
  }

  invalidate(key) {
    const node = this._nodeFor(key);
    if (node && node.delete(key)) metrics.cache.invalidations++;
  }

  // Invalidate every cached prefix-result that could contain `query`, i.e. all
  // prefixes of the query. Used after a batch flush changes a query's ranking.
  invalidatePrefixesOf(query, maxLen = config.suggest.maxPrefixLen) {
    const upto = Math.min(query.length, maxLen);
    for (let i = 1; i <= upto; i++) this.invalidate(query.slice(0, i));
  }

  // ---- Introspection for /cache/debug ----
  route(key) {
    return this.ring.getNodeDetailed(key);
  }

  peek(key) {
    // Does the owning node currently hold a (live) entry for this key?
    const node = this._nodeFor(key);
    if (!node) return { present: false };
    const entry = node.map.get(key);
    if (!entry) return { present: false };
    const live = entry.expiresAt > Date.now();
    return {
      present: live,
      expired: !live,
      expiresInMs: Math.max(0, entry.expiresAt - Date.now()),
    };
  }

  nodeSnapshots() {
    return [...this.nodes.values()].map((n) => n.snapshot());
  }

  ringDistribution(sampleKeys) {
    return this.ring.distribution(sampleKeys);
  }
}

export default DistributedCache;
