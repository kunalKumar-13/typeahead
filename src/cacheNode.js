// A single logical cache node: an LRU cache with per-entry TTL.
//
// LRU is implemented on top of a JS Map, which preserves insertion order — so
// the first key is the least-recently-used and re-inserting a key moves it to
// the most-recently-used position. TTL handles staleness; LRU handles capacity.

export class CacheNode {
  constructor(id, { capacity, ttlMs }) {
    this.id = id;
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> { value, expiresAt }
    this.stats = { hits: 0, misses: 0, sets: 0, evictions: 0, expirations: 0 };
  }

  get(key, now = Date.now()) {
    const entry = this.map.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.map.delete(key);
      this.stats.expirations++;
      this.stats.misses++;
      return undefined;
    }
    // Mark as most-recently-used.
    this.map.delete(key);
    this.map.set(key, entry);
    this.stats.hits++;
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs, now = Date.now()) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: now + ttlMs });
    this.stats.sets++;
    // Evict least-recently-used while over capacity.
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
      this.stats.evictions++;
    }
  }

  delete(key) {
    return this.map.delete(key);
  }

  get size() {
    return this.map.size;
  }

  snapshot() {
    const lookups = this.stats.hits + this.stats.misses;
    return {
      id: this.id,
      size: this.size,
      capacity: this.capacity,
      ...this.stats,
      hitRate: lookups ? Number(((this.stats.hits / lookups) * 100).toFixed(2)) : 0,
    };
  }
}

export default CacheNode;
