# Performance Report

Measured numbers for the three things the assignment asks to report: **suggestion
latency (incl. p95)**, **cache hit rate**, and **write reduction through
batching** — plus consistent‑hash balance and the **batching crash trade‑off**.

All figures are reproducible: start the server and run `npm run bench`.

---

## Test environment

| | |
|---|---|
| Machine | Apple Silicon (arm64), 15 cores |
| OS / Runtime | macOS (Darwin 25.x) · Node.js v26.3.0 |
| Dataset | 120,000 generated queries (Zipf‑skewed), loaded into SQLite |
| Config | defaults: 4 cache nodes · 150 vnodes · 5000 LRU/node · 30 s TTL · flush 1 s · batch 500 |
| Load tool | `scripts/benchmark.js` — 10,000 `/suggest` requests, concurrency 40, over the loopback HTTP interface |

> Latency is measured **client‑side, end‑to‑end over HTTP** (the honest "what the
> caller sees"). The server also records its own in‑process processing time,
> reported separately below.

---

## 1. Suggestion latency

10,000 requests over a realistic prefix workload (popular short prefixes recur,
so the cache is exercised the way it would be in production), run twice — once
cold, once warm:

| Pass | Requests | Cache hit | p50 | **p95** | p99 | Throughput |
|------|----------|-----------|-----|---------|-----|------------|
| Cold | 10,000 | 98.3 % | 1.30 ms | **3.29 ms** | 6.88 ms | 22,490 rps |
| Warm | 10,000 | 100 % | 1.15 ms | **2.73 ms** | 3.04 ms | 29,790 rps |

**Server‑side processing latency** (the suggestion logic only, excluding HTTP):

| | p50 | p95 | p99 |
|---|-----|-----|-----|
| `/suggest` in‑process | 0.001 ms | 0.001 ms | 0.008 ms |

**Reading this:** the actual suggestion work — ring routing + cache/Trie lookup +
recency re‑rank — takes **single‑digit microseconds**. The ~1–3 ms the client
sees is HTTP + loopback + JSON overhead, not the data system. p95 stays low and
*tightens* once warm (3.29 → 2.73 ms) because more requests are pure cache hits.

---

## 2. Cache hit rate

| Scope | Hit rate |
|-------|----------|
| Cold pass (first sight of each prefix) | 98.3 % |
| Warm pass | 100 % |
| Cumulative (server `/metrics`) | 99.1 % |

Per‑node (consistent‑hash routed), after the run:

| Node | Entries | Hit rate | Evictions |
|------|---------|----------|-----------|
| cache-node-0 | 43 | 99.23 % | 0 |
| cache-node-1 | 39 | 98.96 % | 0 |
| cache-node-2 | 46 | 99.39 % | 0 |
| cache-node-3 | 45 | 98.51 % | 0 |

The high cold‑pass hit rate reflects how typeahead traffic really looks: a small
set of short, popular prefixes accounts for most requests, so the cache fills
almost immediately. Each node carries a similar share (39–46 entries) — see the
balance section.

---

## 3. Write reduction through batching

Concentrated demo — 4,000 searches across 40 distinct queries (`benchmark.js`):

| Metric | Value |
|--------|-------|
| Raw search events sent | 4,000 |
| Distinct queries | 40 |
| **DB row‑writes** | **40** |
| DB transactions | 1 |
| Batches flushed | 1 |
| **Write reduction** | **99.0 %** |

The 4,000 events collapsed to 40 row‑writes inside a single transaction. Without
batching this workload would issue 4,000 individual writes.

Realistic mixed traffic (the `seed-traffic` run — 3,000 searches, ~1,200 distinct
queries, several flushes) still showed **~59 % fewer writes** via `/metrics`
`writeReductionPct` — lower than the concentrated demo because there's less
repetition to aggregate, which is exactly what you'd expect. Reduction scales with
how repetitive and bursty the traffic is.

**DB read/write counts** (`/metrics`, cumulative after the benchmark): **3 reads,
1 batch write transaction** — reads are the one bulk index‑build at startup plus
metrics‑driven `COUNT(*)`s; writes are batched, not per‑search.

---

## 4. Consistent‑hash balance

Distribution of **12,005 distinct keys** across the 4 logical nodes (150 vnodes
each), logged at startup:

| Node | Keys | Deviation from even |
|------|------|---------------------|
| cache-node-0 | 2,945 | −1.9 % |
| cache-node-1 | 2,748 | −8.4 % |
| cache-node-2 | 3,143 | +4.7 % |
| cache-node-3 | 3,169 | +5.6 % |

Within ≈ ±8 % of a perfectly even split — the expected variance for 150 vnodes
per node. Raising `VNODES` tightens this (at the cost of more ring memory).
`GET /cache/debug?prefix=<p>` shows the live routing and per‑node distribution.

> Note: an earlier startup log measured balance over a *duplicate‑heavy* sample of
> the first 2,000 queries' 3‑char prefixes and looked falsely lopsided
> (250/429/884/437). That was sample skew, not ring skew — measuring over
> **distinct** keys (above) is the correct test.

---

## 5. Startup / indexing

| Step | Cost |
|------|------|
| Build the in‑memory Trie from 120k SQLite rows | ~185–195 ms |
| Dataset load (CSV → SQLite, chunked transactions) | ~0.2 s |

---

## Batching failure trade-offs

The batch writer trades a small, bounded durability window for a large reduction
in write load. The failure modes:

**1. Process crash between flushes.**
Every search is appended to the **write‑ahead log (WAL)** *before* it's
acknowledged, then aggregated in memory. On restart, `BatchWriter.recover()`
replays the WAL into SQLite (reconstructing both counts and recency timestamps)
and only then truncates it. **Result: a crash between flushes loses nothing that
reached the WAL.** The in‑memory aggregation buffer can be lost — but it's
redundant with the WAL, which is the source of truth for un‑flushed writes.

**2. Power loss / OS crash (not just the process).**
The WAL append goes through `fs.writeSync`, which reaches the OS page cache but is
**not `fsync`'d per line** (that's the deliberate trade‑off — an `fsync` per search
would reintroduce the per‑write cost batching exists to avoid). So a true power
loss can lose the small window of WAL appends still buffered by the OS. For
search‑popularity counters this is acceptable: losing a few counts among millions
doesn't change rankings. If stronger guarantees were needed, `fsync`‑per‑append (or
group‑commit `fsync` every k ms) is a one‑line change with a latency cost.

**3. No WAL at all (hypothetical).**
Then a crash would lose **every** un‑flushed in‑memory increment — up to one full
flush interval / batch of searches. The WAL is what turns "lose the last second of
writes on any crash" into "lose nothing on a process crash, and only an OS‑buffered
sliver on power loss."

**Consistency model:** counts are **eventually consistent** — a submitted search is
reflected in suggestions/trending after the next flush (≤ `FLUSH_MS`, default 1 s).
The dummy `POST /search` returns immediately and does **not** wait for the flush,
so submission latency is independent of DB write latency.

| Knob | Effect of increasing it |
|------|-------------------------|
| `FLUSH_MS` | fewer, larger writes · larger crash/staleness window |
| `BATCH_SIZE` | flush sooner under bursts · more memory before a size‑flush |
| `fsync` per append (not default) | stronger durability · higher per‑search latency |

---

## How to reproduce

```bash
npm install
npm run setup          # generate 120k dataset + load into SQLite
npm start              # terminal 1
npm run bench          # terminal 2 — prints the latency / hit-rate / write-reduction tables
# optional, for trending + mixed-traffic write reduction:
npm run seed-traffic && curl -s localhost:3000/metrics
```

Absolute numbers vary with hardware, but the **shape** is stable: microsecond
in‑process work, low‑single‑digit‑ms end‑to‑end p95, ~99 % hit rate on repetitive
prefixes, and ~99 % write reduction on repetitive search traffic.
