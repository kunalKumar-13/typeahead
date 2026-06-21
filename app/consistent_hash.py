"""Consistent-hash ring with virtual nodes.

A prefix's cache key is hashed onto a 2^32 ring; we walk clockwise to the first
virtual node and route to the physical Redis node that owns it. Virtual nodes
(default 150 per physical node) smooth out the otherwise lumpy key distribution
you get with only 3 physical nodes, so load stays balanced and adding/removing a
node only remaps keys in the arcs adjacent to it (not the whole keyspace).
"""
from __future__ import annotations

import bisect
import hashlib
from typing import List


def _hash(key: str) -> int:
    """Stable 32-bit ring position from an MD5 digest (first 4 bytes)."""
    digest = hashlib.md5(key.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big")


class HashRing:
    def __init__(self, node_ids: List[str], vnodes: int = 150):
        self.vnodes = vnodes
        self.node_ids = list(node_ids)
        self._ring: dict[int, str] = {}          # ring position -> physical node id
        self._vnode_of: dict[int, int] = {}      # ring position -> replica index
        self._sorted: List[int] = []
        for nid in self.node_ids:
            self._add(nid)
        self._sorted = sorted(self._ring.keys())

    def _add(self, node_id: str) -> None:
        for v in range(self.vnodes):
            pos = _hash(f"{node_id}#{v}")
            # collision is astronomically unlikely; last writer wins deterministically
            self._ring[pos] = node_id
            self._vnode_of[pos] = v

    def route(self, key: str) -> str:
        """Return the physical node id that owns `key`."""
        return self.locate(key)["node"]

    def locate(self, key: str) -> dict:
        """Full routing detail for `key` (used by /cache/debug)."""
        if not self._sorted:
            raise RuntimeError("ring is empty")
        pos = _hash(key)
        idx = bisect.bisect_right(self._sorted, pos)
        if idx == len(self._sorted):
            idx = 0  # wrap around the ring
        vnode_pos = self._sorted[idx]
        return {
            "key": key,
            "key_hash": pos,                 # where the key lands on the ring
            "ring_position": vnode_pos,      # the owning virtual node's position
            "vnode_replica": self._vnode_of[vnode_pos],  # which replica of that node
            "node": self._ring[vnode_pos],   # physical Redis node id
            "ring_size": len(self._sorted),
        }

    def distribution(self, keys: List[str]) -> dict[str, int]:
        """Count how many of `keys` route to each node (balance diagnostics)."""
        counts = {nid: 0 for nid in self.node_ids}
        for k in keys:
            counts[self.route(k)] += 1
        return counts
