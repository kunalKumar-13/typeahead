// Consistent hashing ring with virtual nodes.
//
// Why consistent hashing: when a cache node is added or removed, only ~1/N of
// the keys are remapped (instead of nearly all of them, as with `hash % N`).
// Virtual nodes (many ring positions per physical node) smooth out the key
// distribution so no single node gets a disproportionate share.
//
// Routing a key is O(log V) — a binary search over the sorted ring positions.

// 32-bit FNV-1a with an avalanche finalizer for better bit dispersion.
// Deterministic and dependency-free.
export function hash32(str) {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  // avalanche (xorshift-multiply finalizer)
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return h >>> 0; // unsigned 32-bit
}

export class ConsistentHashRing {
  constructor(nodeIds = [], virtualNodes = 150) {
    this.virtualNodes = virtualNodes;
    this.ring = []; // sorted array of { pos, nodeId }
    this.positions = []; // parallel sorted array of positions (for binary search)
    this.nodeIds = new Set();
    for (const id of nodeIds) this.addNode(id, /*rebuild*/ false);
    this._rebuildIndex();
  }

  _vnodeKey(nodeId, i) {
    return `${nodeId}#${i}`;
  }

  addNode(nodeId, rebuild = true) {
    if (this.nodeIds.has(nodeId)) return;
    this.nodeIds.add(nodeId);
    for (let i = 0; i < this.virtualNodes; i++) {
      this.ring.push({ pos: hash32(this._vnodeKey(nodeId, i)), nodeId });
    }
    if (rebuild) this._rebuildIndex();
  }

  removeNode(nodeId, rebuild = true) {
    if (!this.nodeIds.has(nodeId)) return;
    this.nodeIds.delete(nodeId);
    this.ring = this.ring.filter((v) => v.nodeId !== nodeId);
    if (rebuild) this._rebuildIndex();
  }

  _rebuildIndex() {
    this.ring.sort((a, b) => a.pos - b.pos);
    this.positions = this.ring.map((v) => v.pos);
  }

  // First ring entry clockwise from the key's hash (wrapping around).
  _locate(keyHash) {
    const pos = this.positions;
    if (pos.length === 0) return -1;
    let lo = 0;
    let hi = pos.length - 1;
    if (keyHash > pos[hi]) return 0; // wrap to first
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pos[mid] < keyHash) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Returns the node id that owns `key`.
  getNode(key) {
    const idx = this._locate(hash32(key));
    return idx === -1 ? null : this.ring[idx].nodeId;
  }

  // Detailed routing info for debugging / the /cache/debug endpoint.
  getNodeDetailed(key) {
    const keyHash = hash32(key);
    const idx = this._locate(keyHash);
    if (idx === -1) return { key, keyHash, nodeId: null };
    return {
      key,
      keyHash,
      nodeId: this.ring[idx].nodeId,
      ringPosition: this.ring[idx].pos,
      vnodeIndex: idx,
      ringSize: this.ring.length,
    };
  }

  nodes() {
    return [...this.nodeIds];
  }

  // Distribution of a set of sample keys across nodes — used in /cache/debug
  // and the docs to show that virtual nodes balance the load.
  distribution(keys) {
    const counts = {};
    for (const id of this.nodeIds) counts[id] = 0;
    for (const k of keys) {
      const n = this.getNode(k);
      if (n != null) counts[n]++;
    }
    return counts;
  }
}

export default ConsistentHashRing;
