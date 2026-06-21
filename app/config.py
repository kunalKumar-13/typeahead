"""Central configuration.

Every tunable lives here so design trade-offs are easy to find, explain, and
change. Values can be overridden via environment variables (handy for Docker).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import List

ROOT = Path(__file__).resolve().parent.parent


def _num(env: str, fallback):
    val = os.environ.get(env)
    if val is None or val == "":
        return fallback
    return type(fallback)(val)


def _redis_nodes() -> List[dict]:
    """Redis topology.

    Override with REDIS_NODES="host1:6379,host2:6379,host3:6379" (Docker), else
    default to three local instances on ports 6390/6391/6392 used by the local
    dev/benchmark harness (scripts/run_local_redis.sh).
    """
    raw = os.environ.get("REDIS_NODES", "")
    if raw.strip():
        specs = [s.strip() for s in raw.split(",") if s.strip()]
    else:
        specs = ["127.0.0.1:6390", "127.0.0.1:6391", "127.0.0.1:6392"]
    nodes = []
    for i, spec in enumerate(specs):
        host, _, port = spec.partition(":")
        nodes.append({"id": f"redis{i + 1}", "host": host, "port": int(port or 6379)})
    return nodes


@dataclass(frozen=True)
class Paths:
    root: Path = ROOT
    data: Path = ROOT / "data"
    dataset: Path = ROOT / "data" / "queries.csv"
    db: Path = ROOT / "data" / "typeahead.db"
    # Write-ahead log for the batch writer (crash durability for buffered counts).
    wal: Path = ROOT / "data" / "pending-writes.log"
    static: Path = ROOT / "static"


@dataclass(frozen=True)
class Config:
    port: int = field(default_factory=lambda: _num("PORT", 8000))
    paths: Paths = field(default_factory=Paths)

    # ---- Suggestions ----
    suggest_limit: int = field(default_factory=lambda: _num("SUGGEST_LIMIT", 10))
    suggest_max_prefix_len: int = 64
    suggest_candidate_pool: int = field(default_factory=lambda: _num("CANDIDATE_POOL", 50))

    # ---- Distributed cache (real Redis on a consistent-hash ring) ----
    redis_nodes: List[dict] = field(default_factory=_redis_nodes)
    cache_vnodes: int = field(default_factory=lambda: _num("VNODES", 150))
    cache_ttl_s: float = field(default_factory=lambda: _num("CACHE_TTL_S", 30.0))

    # ---- Batch writer ----
    flush_interval_s: float = field(default_factory=lambda: _num("FLUSH_S", 1.0))
    batch_max_buffer: int = field(default_factory=lambda: _num("BATCH_SIZE", 500))
    initial_count: int = 1  # count for a brand-new query on first search

    # ---- Trending / recency-aware ranking ----
    # Half-life of the exponentially-decayed "recent activity" counter (seconds).
    trend_half_life_s: float = field(default_factory=lambda: _num("TREND_HALFLIFE_S", 300.0))
    # blended score = log(all_time_count + 1) + recency_weight * decayed_recent
    recency_weight: float = field(default_factory=lambda: _num("RECENCY_WEIGHT", 3.0))
    trending_limit: int = field(default_factory=lambda: _num("TRENDING_LIMIT", 10))
    trending_ttl_s: float = field(default_factory=lambda: _num("TRENDING_TTL_S", 5.0))

    # ---- Dataset generation ----
    dataset_size: int = field(default_factory=lambda: _num("DATASET_SIZE", 120_000))
    zipf_exponent: float = 1.05
    max_count: int = 1_000_000


config = Config()
