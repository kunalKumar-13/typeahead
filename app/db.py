"""SQLite store — the primary, durable home for query counts.

The whole dataset lives here. At startup the app loads every (query, count) row
into an in-memory trie for fast prefix lookups; SQLite remains the source of
truth that the batch writer flushes aggregated search counts back into.

SQLite is run in WAL journal mode so the batch writer's single-transaction
flushes don't block concurrent readers.
"""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Iterable, List, Tuple

from app.config import config


class Database:
    def __init__(self, path: Path | None = None):
        self.path = Path(path or config.paths.db)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False + an explicit lock: FastAPI may touch the
        # connection from worker threads; we serialize writes ourselves.
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._lock = threading.Lock()
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS queries (
                    query TEXT PRIMARY KEY,
                    count INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            self._conn.commit()

    # ---- bulk load (dataset import) ----
    def bulk_upsert(self, rows: Iterable[Tuple[str, int]], chunk: int = 10_000) -> int:
        """Insert/replace many rows fast (used by the loader)."""
        n = 0
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN")
            buf: List[Tuple[str, int]] = []
            for q, c in rows:
                buf.append((q, c))
                if len(buf) >= chunk:
                    cur.executemany(
                        "INSERT INTO queries(query, count) VALUES(?, ?) "
                        "ON CONFLICT(query) DO UPDATE SET count=excluded.count",
                        buf,
                    )
                    n += len(buf)
                    buf.clear()
            if buf:
                cur.executemany(
                    "INSERT INTO queries(query, count) VALUES(?, ?) "
                    "ON CONFLICT(query) DO UPDATE SET count=excluded.count",
                    buf,
                )
                n += len(buf)
            self._conn.commit()
        return n

    # ---- batch writer flush: aggregate increments, one transaction ----
    def increment_many(self, increments: dict[str, int]) -> int:
        """Add `delta` to count for each query in one transaction.

        New queries are inserted. Returns number of rows touched. This is the
        write-amplification win: thousands of individual searches collapse into
        one transaction with one row per *distinct* query.
        """
        if not increments:
            return 0
        items = list(increments.items())
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN")
            cur.executemany(
                "INSERT INTO queries(query, count) VALUES(?, ?) "
                "ON CONFLICT(query) DO UPDATE SET count=count+excluded.count",
                items,
            )
            self._conn.commit()
        return len(items)

    # ---- reads ----
    def iter_all(self) -> Iterable[Tuple[str, int]]:
        cur = self._conn.cursor()
        cur.execute("SELECT query, count FROM queries")
        while True:
            rows = cur.fetchmany(10_000)
            if not rows:
                break
            yield from rows

    def get_count(self, query: str) -> int | None:
        cur = self._conn.cursor()
        cur.execute("SELECT count FROM queries WHERE query=?", (query,))
        row = cur.fetchone()
        return row[0] if row else None

    def row_count(self) -> int:
        cur = self._conn.cursor()
        cur.execute("SELECT COUNT(*) FROM queries")
        return cur.fetchone()[0]

    def close(self) -> None:
        with self._lock:
            self._conn.close()
