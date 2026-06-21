// In-memory prefix index (Trie) for typeahead suggestions.
//
// Why a Trie:
//  - Navigating to a prefix is O(prefix length), independent of dataset size.
//  - Each lookup returns the top-N completions by ALL-TIME count using a bounded
//    min-heap, so memory per lookup is O(N) regardless of subtree size.
//
// The Trie stores only the static all-time count. Volatile recency state lives
// in trending.js; the suggestion service retrieves a candidate pool from the
// Trie (cheap static score) and re-ranks it by the blended recency score
// (expensive dynamic score). This separation keeps the Trie cheap to maintain:
// a count change is a single node update, never a re-index.

// Children use a null-prototype object (lower memory + faster than Map for the
// many small nodes a 100k+ entry trie creates).
function makeNode() {
  return { children: Object.create(null), entry: null };
}

// Fixed-size min-heap keyed by `count`, used to keep the top-K largest while
// scanning a subtree without sorting the whole thing.
class TopKHeap {
  constructor(k) {
    this.k = k;
    this.h = []; // min-heap; smallest count at root
  }
  get size() {
    return this.h.length;
  }
  _swap(i, j) {
    const t = this.h[i];
    this.h[i] = this.h[j];
    this.h[j] = t;
  }
  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.h[p].count <= this.h[i].count) break;
      this._swap(i, p);
      i = p;
    }
  }
  _down(i) {
    const n = this.h.length;
    for (;;) {
      let s = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.h[l].count < this.h[s].count) s = l;
      if (r < n && this.h[r].count < this.h[s].count) s = r;
      if (s === i) break;
      this._swap(i, s);
      i = s;
    }
  }
  offer(item) {
    if (this.h.length < this.k) {
      this.h.push(item);
      this._up(this.h.length - 1);
    } else if (this.h.length > 0 && item.count > this.h[0].count) {
      this.h[0] = item;
      this._down(0);
    }
  }
  // Returns items sorted by count DESC.
  drainSorted() {
    return [...this.h].sort((a, b) => b.count - a.count);
  }
}

export class Trie {
  constructor() {
    this.root = makeNode();
    this.size = 0;
  }

  // Insert or update a query's all-time count (upsert).
  upsert(query, count) {
    let node = this.root;
    for (let i = 0; i < query.length; i++) {
      const ch = query[i];
      let next = node.children[ch];
      if (!next) {
        next = makeNode();
        node.children[ch] = next;
      }
      node = next;
    }
    if (node.entry === null) {
      node.entry = { query, count };
      this.size++;
    } else {
      node.entry.count = count;
    }
  }

  // Increment an existing query's count by delta, inserting if absent.
  // Used by the batch writer when flushing aggregated search increments.
  increment(query, delta) {
    let node = this.root;
    for (let i = 0; i < query.length; i++) {
      const ch = query[i];
      let next = node.children[ch];
      if (!next) {
        next = makeNode();
        node.children[ch] = next;
      }
      node = next;
    }
    if (node.entry === null) {
      node.entry = { query, count: delta };
      this.size++;
    } else {
      node.entry.count += delta;
    }
    return node.entry.count;
  }

  _findNode(prefix) {
    let node = this.root;
    for (let i = 0; i < prefix.length; i++) {
      node = node.children[prefix[i]];
      if (!node) return null;
    }
    return node;
  }

  getCount(query) {
    const node = this._findNode(query);
    return node && node.entry ? node.entry.count : 0;
  }

  // Return up to `k` completions of `prefix`, sorted by all-time count DESC.
  // `visitCap` bounds work for pathological short prefixes (default: unbounded).
  topK(prefix, k, visitCap = Infinity) {
    const start = this._findNode(prefix);
    if (!start) return [];
    const heap = new TopKHeap(k);
    // Iterative DFS to avoid recursion limits on deep tries.
    const stack = [start];
    let visited = 0;
    while (stack.length) {
      const node = stack.pop();
      if (node.entry) heap.offer(node.entry);
      visited++;
      if (visited >= visitCap) break;
      const children = node.children;
      for (const ch in children) stack.push(children[ch]);
    }
    return heap.drainSorted();
  }
}

export default Trie;
