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
from app.suggestions import SuggestionService
from app.trie import Trie


class AppContext:
    """Holds the long-lived singletons shared across requests."""

    def __init__(self):
        self.db: Database | None = None
        self.trie: Trie | None = None
        self.suggestions: SuggestionService | None = None
        self.batch: BatchWriter | None = None
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
    ctx.suggestions = SuggestionService(ctx.trie)
    ctx.batch = BatchWriter(ctx.db, ctx.trie)
    ctx.batch.start()
    print(f"[startup] loaded {len(ctx.trie):,} queries; trie built in {build_ms:.0f}ms")
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
    """Top-10 prefix completions. Case-insensitive; graceful on empty/no-match."""
    results = ctx.suggestions.suggest(q, mode=mode)
    return {
        "query": q,
        "mode": mode,
        "count": len(results),
        "suggestions": results,
    }


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


@app.get("/")
def root():
    return {
        "service": "search-typeahead",
        "endpoints": ["/health", "/suggest", "/search", "/trending", "/cache/debug", "/metrics"],
    }
