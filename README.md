# Search Typeahead

A distributed search-typeahead system: **FastAPI** API + frontend, an in-memory
**trie** for prefix completions over a **≥120k** query dataset stored in
**SQLite**, a **3-node Redis** distributed cache addressed by an app-layer
**consistent-hash ring** with virtual nodes, **batched writes** with a
write-ahead log, and **recency-aware trending** via an exponentially-decayed
activity counter.

> SQLite is the primary store (source of truth). Redis is the distributed cache.
> The previous Node.js implementation is preserved in git history at tag
> `node-complete`; this tree is a clean Python project.

## Run it (one command, Docker)

```bash
docker compose up --build
```

This brings up the FastAPI app plus three Redis instances. On first boot the app
**generates and loads the ≥120k dataset** as a setup step (subsequent boots reuse
the persisted SQLite volume). Then open:

- **http://localhost:8000** — the frontend (search box, trending, node/HIT-MISS indicator)
- **http://localhost:8000/docs** — interactive API docs (Swagger)
- **http://localhost:8000/metrics** — live latency / hit-rate / write-reduction

Tear down (and wipe the dataset volume):

```bash
docker compose down -v
```

## Run it locally (without Docker)

Requires Python 3.9+ and a local Redis (`brew install redis`).

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 3 local Redis instances on :6390 :6391 :6392
sh scripts/run_local_redis.sh start

# generate + load the dataset (once)
python scripts/generate_dataset.py
python scripts/load_dataset.py

# start the API + frontend
uvicorn app.main:app --reload --port 8000
```

Stop Redis with `sh scripts/run_local_redis.sh stop`.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/suggest?q=<prefix>&mode=count\|recency` | Top-10 prefix completions. `count` ranks by all-time count; `recency` blends decayed recent activity. Served through the routed Redis node (HIT) or computed + cached (MISS). |
| POST | `/search` `{"query": "..."}` | Records a search. Returns `{"message":"Searched"}`. Aggregated in memory + WAL, batch-flushed to SQLite. |
| GET  | `/trending?limit=10` | Top queries by exponentially-decayed recent activity. |
| GET  | `/cache/debug?prefix=<p>&mode=` | Routing detail for a prefix: routed node, key hash, ring position, vnode replica, and current HIT/MISS. |
| GET  | `/metrics` | Latency p50/p95/p99, cache hit rate + per-node stats, write reduction, Redis liveness. |
| GET  | `/stats/writes` | Batch-writer write-reduction stats. |
| GET  | `/health` | Liveness + queries loaded. |

### Examples

```bash
curl 'http://localhost:8000/suggest?q=iphone'
curl 'http://localhost:8000/suggest?q=mac&mode=recency'
curl -X POST localhost:8000/search -H 'content-type: application/json' -d '{"query":"iphone 15 pro"}'
curl 'http://localhost:8000/cache/debug?prefix=iphone'
curl localhost:8000/trending
curl localhost:8000/metrics
```

## Architecture & configuration

See [docs/REPORT.md](docs/REPORT.md) for the architecture diagram, dataset
details, design trade-offs, and the measured performance report. Tunables
(ports, cache TTL, batch size/interval, decay half-life, dataset size) live in
[app/config.py](app/config.py) and are overridable via environment variables.

## Tests / benchmark

```bash
python scripts/benchmark.py        # suggest p95, hit rate, write reduction, ring balance
```

## Project layout

```
app/      FastAPI app (main, config, db, trie, suggestions, batch_writer,
          consistent_hash, redis_cache, trending, metrics)
scripts/  generate_dataset.py, load_dataset.py, benchmark.py, run_local_redis.sh
static/   frontend (index.html, app.js, styles.css)
docs/     REPORT.md + REPORT.pdf
```
