#!/bin/sh
# Container entrypoint: dataset generation is a one-time setup step, then the API
# starts. The SQLite DB lives on a named volume, so generation only runs the
# first time `docker compose up` is invoked (or after the volume is removed).
set -e

mkdir -p data

if [ ! -f data/typeahead.db ]; then
  echo "[setup] no SQLite store found — generating dataset (>=120k queries)…"
  python scripts/generate_dataset.py
  echo "[setup] loading dataset into SQLite…"
  python scripts/load_dataset.py
else
  echo "[setup] SQLite store present — skipping dataset generation"
fi

echo "[setup] starting FastAPI on :8000 (redis nodes: ${REDIS_NODES})"
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
