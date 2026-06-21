"""FastAPI application — search typeahead.

Wiring grows by phase; Phase 1 establishes the skeleton: on startup it opens the
SQLite store and builds the in-memory trie from it, exposing a /health endpoint
that proves the dataset is loaded.
"""
from __future__ import annotations

import time
from contextlib import asynccontextmanager

from fastapi import Body, FastAPI, Query

from app.batch_writer import BatchWriter
from app.config import config
from app.db import Database
from app.redis_cache import DistributedCache
from app.suggestions import SuggestionService
from app.trending import TrendingTracker
from app.trie import Trie


class AppContext:
    """Holds the long-lived singletons shared across requests."""

    def __init__(self):
        self.db: Database | None = None
        self.trie: Trie | None = None
        self.suggestions: SuggestionService | None = None
        self.batch: BatchWriter | None = None
        self.cache: DistributedCache | None = None
        self.trending: TrendingTracker | None = None
        self.started_at: float = 0.0


ctx = AppContext()


@asynccontextmanager
async def lifespan(app: FastAPI):
    ctx.started_at = time.time()
    ctx.db = Database()
    n = ctx.db.row_count()
    if n == 0:
        raise RuntimeError(
            "SQLite store is empty. Run scripts/generate_dataset.py then "
            "scripts/load_dataset.py before starting the app."
        )
    # Crash recovery: replay any un-flushed WAL into SQLite before the trie is
    # built so the in-memory view starts consistent with durable storage.
    recovered = BatchWriter.recover(ctx.db)
    if recovered:
        print(f"[startup] recovered {recovered:,} searches from WAL")
    t0 = time.time()
    ctx.trie = Trie.build(ctx.db.iter_all())
    build_ms = (time.time() - t0) * 1000
    # cache -> trending -> suggestions -> batch (trending invalidates cache;
    # suggestions and the batch writer both consult the trending tracker)
    ctx.cache = DistributedCache()
    ctx.trending = TrendingTracker(cache=ctx.cache)
    ctx.suggestions = SuggestionService(ctx.trie, trending=ctx.trending)
    ctx.batch = BatchWriter(ctx.db, ctx.trie, trending=ctx.trending)
    ctx.batch.start()
    pings = ctx.cache.ping()
    up = sum(1 for v in pings.values() if v)
    print(f"[startup] loaded {len(ctx.trie):,} queries; trie built in {build_ms:.0f}ms")
    print(f"[startup] redis nodes up: {up}/{len(pings)} {pings}")
    try:
        yield
    finally:
        if ctx.batch:
            ctx.batch.stop()
        if ctx.db:
            ctx.db.close()


app = FastAPI(title="Search Typeahead", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "queries_loaded": len(ctx.trie) if ctx.trie else 0,
        "uptime_s": round(time.time() - ctx.started_at, 1),
    }


@app.get("/suggest")
def suggest(
    q: str = Query("", description="prefix to complete"),
    mode: str = Query("count", description="ranking mode: count | recency"),
):
    """Top-10 prefix completions, served through the distributed Redis cache.

    The prefix routes (consistent hash) to one Redis node; that node is checked
    first (HIT) else we compute from the trie and store with a TTL (MISS).
    """
    from app.suggestions import normalize

    norm = normalize(q)
    key = DistributedCache.key_for(norm, mode)
    routed = ctx.cache.ring.route(key) if norm else None

    cached = ctx.cache.get(key) if norm else None
    if cached is not None:
        status, results = "HIT", cached
    else:
        status = "MISS"
        results = ctx.suggestions.suggest(q, mode=mode)
        if norm and results:
            ctx.cache.set(key, results)

    return {
        "query": q,
        "mode": mode,
        "count": len(results),
        "suggestions": results,
        "cache": {"status": status, "node": routed, "key": key if norm else None},
    }


@app.get("/trending")
def trending(limit: int = Query(10, ge=1, le=50)):
    """Top queries by exponentially-decayed recent activity (short-TTL cached)."""
    cached = ctx.cache.get("trending:global")
    if cached is not None:
        return {"trending": cached[:limit], "cache": {"status": "HIT", "key": "trending:global"}}
    items = ctx.trending.trending(limit=max(limit, config.trending_limit))
    ctx.cache.set("trending:global", items, ttl_s=config.trending_ttl_s)
    return {"trending": items[:limit], "cache": {"status": "MISS", "key": "trending:global"}}


@app.post("/search")
def search(payload: dict = Body(...)):
    """Record a search. Aggregated in memory + WAL, batch-flushed to SQLite."""
    query = (payload or {}).get("query", "")
    ctx.batch.record(query)
    return {"message": "Searched"}


@app.get("/stats/writes")
def write_stats():
    """Write-reduction stats from the batch writer."""
    return ctx.batch.stats()


@app.get("/cache/debug")
def cache_debug(
    prefix: str = Query("", description="prefix to route"),
    mode: str = Query("count", description="ranking mode: count | recency"),
):
    """Show how a prefix routes on the ring and whether it's currently cached."""
    from app.suggestions import normalize

    norm = normalize(prefix)
    key = DistributedCache.key_for(norm, mode)
    info = ctx.cache.debug(key)
    # Is the value live on the routed node right now? (non-counting peek)
    present = ctx.cache.exists(key) if norm else False
    info["status"] = "HIT" if present else "MISS"
    info["normalized_prefix"] = norm
    return info


@app.get("/")
def root():
    return {
        "service": "search-typeahead",
        "endpoints": ["/health", "/suggest", "/search", "/trending", "/cache/debug", "/metrics"],
    }
