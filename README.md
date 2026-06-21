# 🔎 Search Typeahead System

A search‑as‑you‑type system like the suggestion bar on search engines and
e‑commerce sites. It serves the **top‑10 popularity‑ranked suggestions** for a
prefix with sub‑millisecond backend latency, records search submissions, and
keeps popularity counts up to date — using a **distributed cache with consistent
hashing**, **recency‑aware trending**, and **batched writes** to stay fast under
load.

> Built as a high‑level‑design (HLD) assignment. The focus is the backend data
> system: how query‑count data is stored, how suggestions are served quickly,
> how the cache is distributed, and how write pressure is reduced.

- **Architecture & design rationale:** [docs/architecture.md](docs/architecture.md)
- **Performance report (p95, hit rate, write reduction, crash trade‑offs):** [docs/performance-report.md](docs/performance-report.md)

---

## Contents
- [Features](#features)
- [Tech stack & why](#tech-stack--why)
- [Quick start](#quick-start)
- [Project layout](#project-layout)
- [API documentation](#api-documentation)
- [Ranking: basic vs enhanced](#ranking-basic-vs-enhanced)
- [Configuration](#configuration)
- [Scripts](#scripts)
- [Dataset](#dataset)

---

## Features

| # | Requirement | How it's met |
|---|-------------|--------------|
| 1 | Typeahead suggestions, top 10 by count | In‑memory **Trie** prefix index, top‑N by count via a bounded min‑heap |
| 2 | Search UI | Vanilla HTML/CSS/JS SPA served by the backend (debounce, keyboard nav, trending) |
| 3 | Dummy search API | `POST /search` → `{ "message": "Searched" }` |
| 4 | Update counts on search | Search events are aggregated and flushed to SQLite by the **batch writer** |
| 5 | Storage + cache for low latency | SQLite primary store + in‑memory Trie, fronted by a distributed cache |
| 6 | Distributed cache via consistent hashing | N logical cache nodes on a **consistent‑hash ring** (virtual nodes, per‑node LRU+TTL) |
| 7 | Trending searches | **Exponentially‑decayed** per‑query recency counters |
| 8 | Batch writes | In‑memory aggregation buffer + **append‑only WAL** for crash durability |

Plus: graceful handling of empty / missing / mixed‑case / no‑match input,
debounced client requests, p50/p95/p99 latency + cache‑hit + write‑reduction
metrics, and a `/cache/debug` endpoint that shows consistent‑hash routing.

## Tech stack & why

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | **Node.js (≥ 22.5)** | Single language across server + tooling; `node:sqlite` is built in |
| Server | **Express** | Minimal, readable routing; the only runtime dependency |
| Primary store | **SQLite** via built‑in `node:sqlite` | Real durable store with visible read/write counts; **zero native deps**, zero setup |
| Suggestion index | **In‑memory Trie** | `O(prefix length)` navigation independent of dataset size |
| Cache | **In‑process logical nodes on a consistent‑hash ring** | Satisfies "distributed cache via consistent hashing" with no external services; swap `CacheNode` for a Redis client keyed by the same ring to make it multi‑host |
| Frontend | **Vanilla HTML/CSS/JS** | No build step, one process, no CORS — fast to run and demo |

**One process, one command, no Docker, no native compilation.** See
[docs/architecture.md](docs/architecture.md) for the trade‑offs behind each choice.

## Quick start

**Prerequisites:** Node.js **≥ 22.5** (uses the built‑in `node:sqlite`). Check with `node -v`.

```bash
# 1. install (only dependency is express)
npm install

# 2. generate the dataset (120k queries) and load it into SQLite
npm run setup

# 3. run the server
npm start
```

Then open the UI:

```
http://localhost:3000
```

Type `ip`, `java`, `how to`, `samsung`… to see suggestions. Toggle
**Enhanced / Basic** ranking, submit a search (Enter or the button) to see the
dummy response, and watch the **Trending** panel and the **matched node ·
HIT/MISS** pill update.

**Optional — generate traffic and measure performance** (server must be running):

```bash
npm run seed-traffic   # posts ~3000 searches; populates trending + exercises batching
npm run bench          # p50/p95/p99 latency, cache hit rate, write‑reduction demo
```

A fresh clone only needs: `npm install && npm run setup && npm start`
(`node_modules/` and `data/` are git‑ignored and regenerated).

## Project layout

```
search-typeahead/
├── src/
│   ├── server.js            Express app + bootstrap (build index, recover WAL) + routes
│   ├── config.js            All tunables (cache nodes, TTLs, batch size, decay…)
│   ├── db.js                SQLite primary store (node:sqlite) + read/write metrics
│   ├── trie.js              In-memory prefix index (top-N by count, min-heap)
│   ├── consistentHash.js    Hash ring with virtual nodes (FNV-1a + avalanche)
│   ├── cacheNode.js         One logical cache node: LRU + per-entry TTL
│   ├── distributedCache.js  N cache nodes routed by the ring
│   ├── trending.js          Exponentially-decayed recency counters + blended score
│   ├── batchWriter.js       Aggregation buffer + WAL + periodic/size flush
│   ├── suggestionService.js Read path: cache → Trie → recency re-rank
│   └── metrics.js           Counters + latency histogram
├── public/                  Frontend (index.html, styles.css, app.js)
├── scripts/
│   ├── generate-dataset.js  Reproducible Zipf dataset → data/queries.csv
│   ├── load-dataset.js      CSV → SQLite (chunked transactions)
│   ├── seed-traffic.js      Drives search traffic at a running server
│   └── benchmark.js         Latency + hit-rate + write-reduction benchmark
├── docs/                    architecture.md, performance-report.md
└── data/                    generated CSV + SQLite DB + WAL (git-ignored)
```

## API documentation

Base URL: `http://localhost:3000`

### `GET /suggest`
Returns up to 10 prefix‑matching suggestions, sorted by ranking.

| Query param | Required | Default | Notes |
|-------------|----------|---------|-------|
| `q` | yes | — | the typed prefix (trimmed, lowercased; empty → empty result) |
| `mode` | no | `recency` | `recency` (enhanced) or `count` (basic) |
| `limit` | no | `10` | 1–50 |

```bash
curl 'http://localhost:3000/suggest?q=ip&mode=recency'
```
```json
{
  "prefix": "ip",
  "mode": "recency",
  "source": "store",
  "node": "cache-node-1",
  "suggestions": [
    { "query": "iphone", "count": 1085974, "recentScore": 0, "score": 6.0358 },
    { "query": "iphone plus", "count": 137, "recentScore": 0, "score": 2.1399 }
  ]
}
```
- `source`: `cache` (HIT) · `store` (MISS, served from the Trie) · `empty`.
- `node`: the logical cache node that owns this prefix key (consistent‑hash routing).
- `mode=count` omits `recentScore`/`score` and orders purely by all‑time `count`.

### `POST /search`
Dummy search endpoint; records the submission (batched, asynchronously persisted).

```bash
curl -X POST http://localhost:3000/search \
  -H 'Content-Type: application/json' -d '{"query":"java tutorial"}'
```
```json
{ "message": "Searched", "query": "java tutorial" }
```
- Missing/empty `query` → `400 { "error": "query is required" }`.
- New queries are inserted; existing queries have their count incremented — both on the next batch flush.

### `GET /trending`
Currently‑trending queries by decayed recent activity (short‑TTL cached).

```bash
curl 'http://localhost:3000/trending?limit=10'
```
```json
{
  "source": "store",
  "trending": [
    { "query": "air fryer deals", "recentScore": 224.93, "count": 242 }
  ]
}
```

### `GET /cache/debug`
Shows which cache node owns a prefix and whether it's currently a HIT or MISS.

```bash
curl 'http://localhost:3000/cache/debug?prefix=ip'
```
```json
{
  "input": "ip",
  "normalizedPrefix": "ip",
  "cacheKey": "recency|ip",
  "routedTo": "cache-node-1",
  "status": "HIT",
  "detail": { "keyHash": 832076088, "ringPosition": 842654025, "vnodeIndex": 120, "ringSize": 600 },
  "nodes": [ /* per-node size / hit / miss / evictions */ ],
  "sampleKeyDistribution": { "cache-node-0": 170, "cache-node-1": 168, "...": 0 }
}
```

### `GET /metrics`
Latency percentiles, cache hit rate, DB read/write counts, write‑reduction %, batch‑writer + per‑node stats.

```bash
curl 'http://localhost:3000/metrics'
```

### `GET /health`
`{ "status": "ok" }`.

## Ranking: basic vs enhanced

The **same** `/suggest` endpoint supports both rankings via `mode`:

- **Basic** (`mode=count`) — order strictly by all‑time `count`. Historically
  popular queries always win.
- **Enhanced** (`mode=recency`) — order by a blended score
  `log10(count + 1) + recencyWeight · decayedRecent`, so a query being searched
  a lot *right now* can climb above an equally/more popular all‑time query.
  Recent activity decays exponentially, so short‑lived spikes don't dominate
  forever. Details and the windowing math: [docs/architecture.md](docs/architecture.md).

The UI toggle switches `mode` live so you can see the same prefix reorder.

## Configuration

All tunables live in [src/config.js](src/config.js) and can be overridden by env vars:

| Env var | Default | Meaning |
|---------|---------|---------|
| `PORT` | `3000` | server port |
| `CACHE_NODES` | `4` | number of logical cache nodes |
| `VNODES` | `150` | virtual nodes per physical node on the ring |
| `CACHE_CAP` | `5000` | LRU entries per cache node |
| `CACHE_TTL_MS` | `30000` | suggestion cache TTL |
| `FLUSH_MS` | `1000` | batch flush interval |
| `BATCH_SIZE` | `500` | flush early after this many distinct buffered queries |
| `TREND_HALFLIFE_MS` | `300000` | recency half‑life (5 min) |
| `RECENCY_WEIGHT` | `3.0` | weight of recent activity in the blended score |
| `DATASET_SIZE` | `120000` | queries to generate (≥ 100k required) |

Example: `CACHE_NODES=8 FLUSH_MS=500 npm start`.

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run setup` | generate dataset **and** load it into SQLite |
| `npm run generate` | (re)generate `data/queries.csv` (reproducible, Zipf‑skewed) |
| `npm run load` | load `data/queries.csv` into SQLite |
| `npm start` | run the server |
| `npm run dev` | run with `--watch` (auto‑restart on file change) |
| `npm run seed-traffic` | drive search traffic at a running server |
| `npm run bench` | benchmark latency, hit rate, and write reduction |

## Dataset

The generator produces **120,000 distinct queries** (≥ the 100k minimum) with
Zipf‑distributed counts — a few very popular queries and a long tail, like real
search traffic. It's seeded, so runs are reproducible.

**Use your own dataset** instead: place a CSV with a `query,count` header at
`data/queries.csv` and run `npm run load` (or point `DATASET=/path/to.csv npm run load`).

```
query,count
iphone,100000
iphone 15,85000
java tutorial,40000
```
