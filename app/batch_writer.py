"""Batched write path with a write-ahead log (WAL).

Every POST /search is a tiny write. Writing each one straight to SQLite would
mean one transaction per search — terrible write amplification under load.
Instead:

  1. record(query) appends the raw query to an append-only WAL file (crash
     durability) and bumps an in-memory aggregation buffer (query -> pending
     delta). The live trie count is bumped immediately so suggestions react
     instantly.
  2. A background flusher persists the *aggregated* buffer to SQLite in ONE
     transaction when the buffer hits a size threshold or a time interval
     elapses, then truncates the WAL.

Aggregation is the win: 10,000 searches for "iphone" become a single
`count = count + 10000` row write. We expose this as a write-reduction ratio.

Crash model: if the process dies before a flush, the WAL still holds every
recorded search; on the next startup recover() replays it into SQLite before the
trie is built, so no search is lost.

The flush holds the buffer lock for its whole duration (swap -> SQLite write ->
WAL truncate). That briefly serializes concurrent searches, but flushes are
infrequent (~1/s) and write a single transaction, so the cost is negligible and
it keeps the WAL/SQLite/buffer trio strictly consistent (no lost-on-truncate
race).
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict
from pathlib import Path

from app.config import config
from app.db import Database
from app.trie import Trie


class BatchWriter:
    def __init__(self, db: Database, trie: Trie, trending=None, wal_path: Path | None = None):
        self.db = db
        self.trie = trie
        self.trending = trending  # Phase 5: record recency on each search
        self.wal_path = Path(wal_path or config.paths.wal)
        self.wal_path.parent.mkdir(parents=True, exist_ok=True)

        self._buffer: dict[str, int] = defaultdict(int)
        self._lock = threading.Lock()
        self._wal = open(self.wal_path, "a", buffering=1)  # line-buffered

        # ---- write-reduction stats ----
        self.logical_writes = 0   # individual searches recorded
        self.physical_writes = 0  # rows written to SQLite across all flushes
        self.flushes = 0
        self.last_flush_ts = time.time()
        self.recency_invalidations = 0  # Phase 5

        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ---- recovery (called at startup, before trie build) ----
    @staticmethod
    def recover(db: Database, wal_path: Path | None = None) -> int:
        """Replay an un-flushed WAL into SQLite. Returns #searches recovered."""
        wal_path = Path(wal_path or config.paths.wal)
        if not wal_path.exists() or wal_path.stat().st_size == 0:
            return 0
        agg: dict[str, int] = defaultdict(int)
        n = 0
        with wal_path.open() as f:
            for line in f:
                q = line.rstrip("\n")
                if q:
                    agg[q] += 1
                    n += 1
        if agg:
            db.increment_many(agg)
        wal_path.write_text("")  # truncate after durable persist
        return n

    # ---- hot path ----
    def record(self, query: str) -> None:
        q = " ".join((query or "").split()).lower()
        if not q:
            return
        with self._lock:
            self._wal.write(q + "\n")          # durability first
            self._buffer[q] += 1
            self.logical_writes += 1
            # live in-memory update so suggestions reflect the search immediately
            entry = self.trie.get(q)
            if entry is None:
                entry = self.trie.insert(q, config.initial_count)
            else:
                entry.count += 1
            if self.trending is not None:
                self.trending.record(entry)
            buffer_full = len(self._buffer) >= config.batch_max_buffer
        if buffer_full:
            self.flush(reason="size")

    # ---- flush ----
    def flush(self, reason: str = "interval") -> int:
        with self._lock:
            if not self._buffer:
                return 0
            snapshot = dict(self._buffer)
            self._buffer.clear()
            rows = self.db.increment_many(snapshot)      # one transaction
            self._wal.flush()
            self._wal.seek(0)
            self._wal.truncate()                          # WAL consumed
            self.physical_writes += rows
            self.flushes += 1
            self.last_flush_ts = time.time()
            if self.trending is not None:
                self.recency_invalidations += self.trending.on_flush(snapshot)
        return rows

    # ---- background flusher ----
    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="batch-flusher", daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        interval = config.flush_interval_s
        while not self._stop.wait(interval):
            try:
                self.flush(reason="interval")
            except Exception as e:  # pragma: no cover - keep flusher alive
                print(f"[batch] flush error: {e}")

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        self.flush(reason="shutdown")
        self._wal.close()

    # ---- stats ----
    def stats(self) -> dict:
        with self._lock:
            logical = self.logical_writes
            physical = self.physical_writes
            pending = len(self._buffer)
        reduction = (1 - physical / logical) if logical else 0.0
        return {
            "logical_writes": logical,          # individual searches received
            "physical_writes": physical,        # rows written to SQLite
            "pending_in_buffer": pending,
            "flushes": self.flushes,
            "write_reduction": round(reduction, 4),
            "write_reduction_pct": round(reduction * 100, 2),
            "avg_rows_per_flush": round(physical / self.flushes, 1) if self.flushes else 0,
            "recency_invalidations": self.recency_invalidations,
        }
