# Architecture

This document explains the data system: the components, the read and write data
flows, and **why** each design choice was made (with the alternatives that were
rejected). It's the companion to the [README](../README.md) and the
[performance report](performance-report.md).

---

## 1. Component overview

```
                         ┌──────────────────────────────────────────────┐
   Browser (public/)     │                 Express server                │
   ┌───────────────┐     │                                              │
   │ search box    │     │  GET /suggest ─► SuggestionService           │
   │ dropdown      │ ───►│       │              │                       │
   │ trending      │     │       │       ┌──────▼───────┐  miss  ┌─────┐ │
   │ node·HIT/MISS │     │       │       │ Distributed  │──────► │Trie │ │
   └───────────────┘     │       │       │   Cache      │◄────── │index│ │
                         │       │       │ (ring + LRU) │  fill  └──┬──┘ │
                         │       │       └──────┬───────┘           │    │
                         │       │              │ hit               │    │
                         │       ▼              ▼                   │    │
                         │  POST /search   re-rank by recency ◄─────┤    │
                         │       │         (Trending scores)        │    │
                         │       ▼                                  │    │
                         │  BatchWriter ──► WAL (durable)           │    │
                         │       │                                  │    │
                         │       │  flush (interval / size)         │    │
                         │       ▼                                  │    │
                         │  ┌─────────┐  upsert counts   ┌──────────▼──┐ │
                         │  │ SQLite  │◄─────────────────│ in-memory   │ │
                         │  │ primary │   + invalidate    │ Trie+Trend. │ │
                         │  │ store   │     cache prefixes└─────────────┘ │
                         │  └─────────┘                                   │
                         └──────────────────────────────────────────────┘
```

**Two stores, two roles:**
- **SQLite** is the durable *system of record* for `(query, count, recency)`.
- The **in‑memory Trie** is the *serving index*, rebuilt from SQLite at startup
  and kept live by the batch writer. Suggestions are served from memory; SQLite
  is only read in bulk at boot and written in batches.

The **distributed cache** sits in front of the Trie so hot prefixes never even
touch it.

---

## 2. Read path — `GET /suggest?q=<prefix>&mode=<count|recency>`

```
prefix ──► normalize (trim, lowercase, cap length)
       ──► empty? ──► return [] (graceful)
       ──► key = "<mode>|<prefix>"
       ──► consistent-hash ring picks the owning cache node
       ──► cache node GET
             ├─ HIT  ──────────────► return cached top-10        (source=cache)
             └─ MISS ──► Trie.topK(prefix, 50)  // candidate pool by all-time count
                      ├─ mode=count   ──► take top-10 by count   (source=store)
                      └─ mode=recency ──► blend with decayed recency,
                                          fold in matching trending,
                                          sort, take top-10
                      ──► cache.set(key, result, TTL)
                      ──► return                                 (source=store)
```

**Why a cache in front of the Trie?** Even though Trie lookups are microseconds,
the cache (a) absorbs repeated hot prefixes so per‑request work is ~constant
under load, and (b) is the component the assignment asks to *distribute*. With a
98 %+ hit rate (see the performance report), the Trie + re‑rank work runs on a
small fraction of requests.

**Why retrieve a candidate pool of 50, then re‑rank?** The Trie stores only the
*static* all‑time count, so navigating it is cheap and a count change is a single
node update. Recency is *volatile* — baking it into the index would mean
re‑indexing constantly. Instead we pull the top‑50‑by‑count completions (cheap,
static) and re‑rank just those 50 by the blended recency score (the
classic *retrieve‑cheap → re‑rank‑expensive* pattern). A surging query with a low
all‑time count that wouldn't make the top‑50 is still injected from the trending
set (`Trending.matching(prefix)`), so recency can always surface it.

---

## 3. Write path — `POST /search`

```
POST /search { query }
   ├─► 200 { "message": "Searched" }            // dummy response, returned immediately
   └─► BatchWriter.record(query):
         1. append "ts<TAB>query" to the WAL    // sequential, durable
         2. buffer[query] += 1                   // in-memory aggregation
         3. Trending.record(query)               // bump decayed recency counter
         4. if buffer has ≥ BATCH_SIZE distinct queries → flush()

BatchWriter.flush()  (also fires every FLUSH_MS):
         1. swap out the buffer
         2. SQLite.applyBatch(entries)            // ONE transaction for the whole batch
         3. Trie.increment(query, delta)          // keep the serving index live
         4. cache.invalidatePrefixesOf(query)     // drop stale cached prefix results
         5. truncate the WAL                      // batch is now durable in SQLite
```

**Why not write to SQLite on every search?** One DB transaction per search is the
classic write‑amplification problem: 4000 searches for 40 queries would be 4000
random B‑tree writes. Aggregating in memory turns that into **40 row‑writes in 1
transaction** (≈ 99 % fewer writes — see the performance report). Sequential WAL
appends are cheap; random index writes are not.

**Cache invalidation on rank change.** When a flush changes a query's count, every
cached prefix result that could contain that query is now stale. Those are exactly
the *prefixes of the query* (`"i"`, `"ip"`, …, `"iphone"`), so the writer deletes
those cache keys. Combined with the short TTL, the cache self‑heals quickly without
a global flush.

---

## 4. Component deep‑dives

### 4.1 Primary store — SQLite (`node:sqlite`)
- **Why:** a real, durable store with visible read/write counts (needed to *prove*
  the write‑reduction claim), but with **zero native dependencies** — `node:sqlite`
  is built into Node ≥ 22.5, so there's nothing to compile and nothing to install
  beyond Express.
- **Schema:** `queries(query PK, count, recent_score, recent_ts, updated_at)` with an
  index on `count` for the SQL fallback path. WAL journal mode + `synchronous=NORMAL`
  for a good durability/throughput balance.
- **Rejected:** Postgres (needs Docker), Redis‑as‑primary (blurs the cache/store
  separation the assignment wants).

### 4.2 Suggestion index — Trie
- **Why:** prefix navigation is `O(prefix length)`, independent of dataset size, and
  each node update is `O(prefix length)` — perfect for a live‑updating index.
- **Top‑N:** a subtree scan feeds a fixed‑size **min‑heap** (size = candidate pool),
  so memory per lookup is `O(N)` regardless of how big the subtree is.
- **Rejected:** `SELECT … WHERE query LIKE 'p%' ORDER BY count DESC LIMIT 10` on every
  keystroke — correct but it hits the DB on the hot path and scales with row count.
  It's kept only as a fallback (`db.prefixSearchSql`).

### 4.3 Consistent‑hash ring
- **Why:** with plain `hash(key) % N`, changing `N` (add/remove a cache node) remaps
  almost every key. Consistent hashing remaps only ≈ `1/N` of keys.
- **Virtual nodes:** each physical node gets `VNODES` (150) positions on the ring, so
  the key space is split into many small arcs and load is even. Measured spread over
  12k distinct keys across 4 nodes is within ≈ ±8 % (see performance report). More
  vnodes → tighter balance, more memory.
- **Hash:** 32‑bit FNV‑1a + an xorshift‑multiply avalanche finalizer for good bit
  dispersion; dependency‑free and fast. Routing a key is an `O(log V)` binary search
  over the sorted ring positions.

### 4.4 Distributed cache
- **Logical nodes:** `DistributedCache` owns N `CacheNode`s and routes every key
  through the ring. This *is* a distributed cache in structure — the only thing that
  makes it in‑process is that `CacheNode` is a local `Map`. **Swap `CacheNode` for a
  Redis client keyed by the same ring and it becomes a real multi‑host cache with no
  change to callers.**
- **Per node:** an LRU (Map insertion‑order) for capacity + per‑entry **TTL** for
  staleness. Two independent eviction reasons: too big (LRU) or too old (TTL).

### 4.5 Trending / recency‑aware ranking
Each active query keeps an **exponentially‑decayed counter**:

```
on each search:   recent = recent · 2^(−Δt / halfLife) + 1 ;  ts = now
to read it:       effective = recent · 2^(−(now − ts) / halfLife)
```

- **How recent searches are tracked:** one decayed float + timestamp per *active*
  query — no need to store every individual event, and only recently‑searched queries
  occupy the map (negligible entries are pruned), so the trending scan stays cheap.
- **How recency affects ranking:** the blended score
  `log10(count + 1) + recencyWeight · effective` adds recent activity on top of
  compressed all‑time popularity. `log10` keeps a mega‑popular query (count 1 000 000+)
  from swamping everything so recency can actually reorder.
- **Why short‑lived spikes don't dominate forever:** decay is exponential — a burst
  loses half its weight every `halfLife` (default 5 min). Sustained activity keeps a
  high score; a five‑minute spike is back near zero soon after. All‑time count
  (monotonic) preserves long‑term popularity; recency only re‑orders.
- **Cache coherence when rankings change:** the batch flush invalidates the affected
  prefixes; the global trending list is cached with a short (5 s) TTL because it
  changes constantly.
- **Trade‑off (freshness vs latency vs complexity):** recomputing the blend per request
  costs a few µs over a ≤ 50‑item pool (latency ✓); freshness is bounded by the cache
  TTL + flush interval (≤ ~1 s); complexity is one float per active query (no event
  log, no background job).

### 4.6 Batch writer
- **Aggregation:** repeated searches for the same query collapse into a single `+N`.
- **Flush triggers:** whichever comes first — every `FLUSH_MS` (1 s) or after
  `BATCH_SIZE` (500) distinct queries buffer. Time bounds staleness; size bounds memory
  and burst latency.
- **Crash durability (WAL):** every search is appended to an append‑only log *before*
  it's acknowledged. On restart, `recover()` replays the log into SQLite, so a crash
  between flushes loses nothing that reached the WAL. (Full failure analysis — including
  the residual power‑loss window and the fsync trade‑off — is in the
  [performance report](performance-report.md#batching-failure-trade-offs).)

---

## 5. Design trade‑offs at a glance

| Decision | Win | Cost / limitation |
|----------|-----|-------------------|
| In‑memory Trie as serving index | µs lookups, live updates | rebuilt at startup; bounded by RAM |
| Cache in front of Trie | ~constant work under load, distributable | possible brief staleness (TTL + invalidation) |
| In‑process logical cache nodes | zero‑dependency demo of consistent hashing | not cross‑host until `CacheNode`→Redis |
| Retrieve‑50 then re‑rank | recency without re‑indexing | a surging query needs trending‑injection to surface |
| Batch writes + WAL | ~99 % fewer DB writes, crash‑safe | counts are eventually (≤ ~1 s) consistent |
| Exponential‑decay recency | tiny state, spikes fade | half‑life is a tuning knob, not a hard window |

## 6. Making it truly multi‑host (future work)

1. Replace each `CacheNode` with a Redis client; keep the same ring → real
   distributed cache, cache survives restarts.
2. Move the batch writer behind a durable queue (Kafka / Redis Streams) so multiple
   app instances share one aggregation + flush pipeline.
3. Shard the Trie by first character(s) across instances, or rebuild per‑instance from
   the shared store, for horizontal read scaling.

The module boundaries (`DistributedCache`, `BatchWriter`, `db`) are drawn so these
swaps don't touch the request handlers.
