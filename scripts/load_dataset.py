"""Load data/queries.csv into the SQLite store (the primary store).

Idempotent: re-running replaces counts for existing queries. Run after
scripts/generate_dataset.py. The app builds its in-memory trie from this table
at startup.
"""
from __future__ import annotations

import csv
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.config import config  # noqa: E402
from app.db import Database  # noqa: E402


def _rows(path: Path):
    with path.open(newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if header != ["query", "count"]:
            raise SystemExit(f"unexpected CSV header: {header!r} (expected query,count)")
        for row in reader:
            if len(row) != 2:
                continue
            q, c = row[0].strip(), row[1].strip()
            if not q:
                continue
            try:
                yield q, int(c)
            except ValueError:
                continue


def main() -> None:
    dataset = config.paths.dataset
    if not dataset.exists():
        raise SystemExit(
            f"dataset not found at {dataset}. Run scripts/generate_dataset.py first."
        )
    db = Database()
    t0 = time.time()
    n = db.bulk_upsert(_rows(dataset))
    dt = time.time() - t0
    print(f"Loaded {n:,} rows into {config.paths.db} in {dt:.1f}s")
    print(f"  total distinct queries in store: {db.row_count():,}")
    db.close()


if __name__ == "__main__":
    main()
