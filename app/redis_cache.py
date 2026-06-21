"""Distributed cache over three real Redis instances.

The app owns the sharding: a consistent-hash ring maps each cache key (a prefix
+ mode) to exactly one of the three Redis nodes. That node is checked first
(HIT); on a miss the caller computes the value and stores it back on the same
routed node with a TTL (MISS). No Redis Cluster — the ring lives in the app, so
routing is observable via /cache/debug and the report.

Per-node hit/miss/set counters back the /metrics endpoint. Redis calls are
wrapped so a single dead node degrades to a miss instead of failing the request.
"""
from __future__ import annotations

import json
import threading
from typing import List, Optional

import redis

from app.config import config
from app.consistent_hash import HashRing


class DistributedCache:
    def __init__(self, nodes: Optional[List[dict]] = None, vnodes: Optional[int] = None,
                 ttl_s: Optional[float] = None):
        self.nodes = nodes or config.redis_nodes
        self.ttl_s = ttl_s if ttl_s is not None else config.cache_ttl_s
        self.ring = HashRing([n["id"] for n in self.nodes], vnodes or config.cache_vnodes)

        self._clients: dict[str, redis.Redis] = {}
        for n in self.nodes:
            self._clients[n["id"]] = redis.Redis(
                host=n["host"], port=n["port"], db=0,
                socket_connect_timeout=1.0, socket_timeout=1.0,
                decode_responses=True,
            )

        self._lock = threading.Lock()
        self._stats = {n["id"]: {"hits": 0, "misses": 0, "sets": 0, "errors": 0}
                       for n in self.nodes}

    # ---- key helpers ----
    @staticmethod
    def key_for(prefix: str, mode: str) -> str:
        return f"suggest:{mode}:{prefix}"

    def node_meta(self, node_id: str) -> dict:
        n = next(x for x in self.nodes if x["id"] == node_id)
        return {"id": node_id, "host": n["host"], "port": n["port"]}

    # ---- core ops ----
    def get(self, key: str) -> Optional[object]:
        node_id = self.ring.route(key)
        client = self._clients[node_id]
        try:
            raw = client.get(key)
        except redis.RedisError:
            with self._lock:
                self._stats[node_id]["errors"] += 1
            return None
        with self._lock:
            if raw is None:
                self._stats[node_id]["misses"] += 1
            else:
                self._stats[node_id]["hits"] += 1
        return json.loads(raw) if raw is not None else None

    def set(self, key: str, value: object, ttl_s: Optional[float] = None) -> None:
        node_id = self.ring.route(key)
        client = self._clients[node_id]
        ttl = ttl_s if ttl_s is not None else self.ttl_s
        try:
            client.set(key, json.dumps(value), ex=int(ttl))
            with self._lock:
                self._stats[node_id]["sets"] += 1
        except redis.RedisError:
            with self._lock:
                self._stats[node_id]["errors"] += 1

    def exists(self, key: str) -> bool:
        """Presence check that does NOT touch hit/miss counters (for diagnostics)."""
        node_id = self.ring.route(key)
        try:
            return bool(self._clients[node_id].exists(key))
        except redis.RedisError:
            return False

    def delete(self, key: str) -> None:
        node_id = self.ring.route(key)
        try:
            self._clients[node_id].delete(key)
        except redis.RedisError:
            with self._lock:
                self._stats[node_id]["errors"] += 1

    # ---- diagnostics ----
    def debug(self, key: str) -> dict:
        loc = self.ring.locate(key)
        node = self.node_meta(loc["node"])
        return {**loc, "redis": node}

    def ping(self) -> dict[str, bool]:
        out = {}
        for nid, client in self._clients.items():
            try:
                out[nid] = bool(client.ping())
            except redis.RedisError:
                out[nid] = False
        return out

    def stats(self) -> dict:
        with self._lock:
            per_node = {nid: dict(s) for nid, s in self._stats.items()}
        total_hits = sum(s["hits"] for s in per_node.values())
        total_misses = sum(s["misses"] for s in per_node.values())
        lookups = total_hits + total_misses
        for nid, s in per_node.items():
            ln = s["hits"] + s["misses"]
            s["hit_rate"] = round(s["hits"] / ln, 4) if ln else 0.0
            try:
                s["keys"] = self._clients[nid].dbsize()
            except redis.RedisError:
                s["keys"] = None
        return {
            "nodes": [self.node_meta(n["id"]) for n in self.nodes],
            "vnodes_per_node": self.ring.vnodes,
            "ttl_s": self.ttl_s,
            "hits": total_hits,
            "misses": total_misses,
            "lookups": lookups,
            "hit_rate": round(total_hits / lookups, 4) if lookups else 0.0,
            "per_node": per_node,
        }

    def flush_all(self) -> None:
        for client in self._clients.values():
            try:
                client.flushdb()
            except redis.RedisError:
                pass
