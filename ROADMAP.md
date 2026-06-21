# Roadmap — Search Typeahead (Python + FastAPI + Redis + Docker)

A distributed search-typeahead system. Primary store: **SQLite**. Distributed
cache: **3 real Redis instances** addressed through an app-layer consistent-hash
ring. Each phase below is its own git commit so the build is reproducible and
resumable from any session.

> The previous Node.js implementation is preserved in git history and at the
> tag `node-complete`. This tree is a clean Python project.

## Phases

- [x] **Step 0** — Safety + setup: tag `node-complete`, remove Node impl, write this roadmap.
- [x] **Phase 1** — FastAPI skeleton; generate/derive a ≥120k query+count dataset into SQLite; build an in-memory trie (prefix → entries) at startup.
- [x] **Phase 2** — `GET /suggest?q=<prefix>&mode=count`: trie → top-10 by all-time count, prefix-matched, case-insensitive, graceful on empty/missing/no-match.
- [x] **Phase 3** — `POST /search` → `{"message":"Searched"}`; append-only WAL buffer; batch writer aggregates repeats in memory and flushes to SQLite on size/interval in one transaction; expose write-reduction stats.
- [x] **Phase 4** — Three Redis instances (compose); app-layer consistent-hash ring with virtual nodes maps a prefix key → one node. `/suggest` checks routed node (HIT) else computes + stores with TTL (MISS). `GET /cache/debug?prefix=` shows routed node, ring position, vnode, HIT/MISS.
- [x] **Phase 5** — Per-query exponentially-decayed recent-activity counter blended with historical count; `mode=recency` and `GET /trending`. Decay prevents permanent over-ranking; invalidate affected Redis keys when ranking shifts.
- [ ] **Phase 6** — `GET /metrics` (p95 latency, hit rate, write reduction, per-node stats). Static frontend served by FastAPI: search box, debounced dropdown w/ keyboard nav, basic/enhanced toggle, trending panel, dummy-response display, loading/empty/error states, visible "matched node · HIT/MISS" indicator.
- [ ] **Phase 7** — `docker-compose.yml` with FastAPI app + 3 Redis instances; `docker compose up` brings the whole system up; dataset generation runs as a setup step. README documents the one-command run.
- [ ] **Phase 8** — Benchmark script producing real numbers (suggest p95, cache hit rate, write reduction, ring balance across the 3 Redis nodes). Run, capture, smoke-test every endpoint.
- [ ] **Phase 9** — `docs/REPORT.md` + `REPORT.pdf`: architecture + diagram, dataset + loading, API docs, design choices & trade-offs, performance report — using real Python/Redis numbers.

## Layout

```
app/            FastAPI application package
  main.py         app factory, routes, startup wiring
  config.py       env-overridable settings
  db.py           SQLite store (primary)
  trie.py         in-memory prefix trie
  suggestions.py  suggestion service (count / recency modes)
  batch_writer.py WAL + in-memory aggregation + batched SQLite flush
  consistent_hash.py  hash ring with virtual nodes
  redis_cache.py  distributed cache over 3 Redis nodes
  trending.py     exponentially-decayed recency tracker
  metrics.py      latency / hit-rate / write-reduction counters
scripts/        generate_dataset.py, load_dataset.py, benchmark.py
static/         frontend (index.html, app.js, styles.css)
data/           generated CSV + SQLite (gitignored)
docs/           REPORT.md + REPORT.pdf
```
