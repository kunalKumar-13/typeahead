"""Benchmark + verification harness — produces the real numbers in the report.

Measures, against a running server (BASE_URL, default http://127.0.0.1:8000):
  1. /suggest latency  — client-side p50/p95/p99 under a realistic, repeating
     prefix workload (repeats exercise the Redis cache)
  2. cache hit rate     — overall + per-node, read from /metrics
  3. write reduction    — logical searches vs SQLite row-writes, from /stats/writes
  4. ring balance       — how evenly keys distribute across the 3 Redis nodes,
     computed directly from the consistent-hash ring (cold, independent of TTL)

It also smoke-tests every endpoint. Numbers are printed and written to
docs/benchmark-results.json.
"""
from __future__ import annotations

import json
import os
import statistics
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.config import config  # noqa: E402
from app.consistent_hash import HashRing  # noqa: E402

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8000")


def _percentile(vals, p):
    if not vals:
        return 0.0
    s = sorted(vals)
    k = (len(s) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] * (1 - (k - lo)) + s[hi] * (k - lo)


def load_prefixes(n_head=2000):
    """Realistic prefix workload: prefixes of the most popular queries."""
    rows = []
    with config.paths.dataset.open() as f:
        next(f)
        for i, line in enumerate(f):
            if i >= n_head:
                break
            rows.append(line.rsplit(",", 1)[0])
    prefixes = []
    for q in rows:
        for L in (1, 2, 3, 4, 5):
            if len(q) >= L:
                prefixes.append(q[:L])
    # de-dup but keep popularity weighting via head ordering
    seen, out = set(), []
    for p in prefixes:
        out.append(p)  # keep repeats -> cache hits
        seen.add(p)
    return out, sorted(seen)


def bench_latency(client, prefixes, requests=4000):
    """Fire `requests` /suggest calls sampling the prefix pool; warm first."""
    pool = prefixes
    # warm pass over distinct prefixes so steady-state reflects a hot cache
    for p in dict.fromkeys(pool):
        client.get(f"/suggest?q={p}")
    # snapshot cache counters so we can report the *steady-state* (post-warm)
    # hit rate, isolated from the cold first-touch fills above
    c0 = client.get("/metrics").json()["cache"]
    lat = []
    n = len(pool)
    t0 = time.perf_counter()
    for i in range(requests):
        p = pool[i % n]
        s = time.perf_counter()
        r = client.get(f"/suggest?q={p}")
        lat.append((time.perf_counter() - s) * 1000)
        r.raise_for_status()
    wall = time.perf_counter() - t0
    c1 = client.get("/metrics").json()["cache"]
    dh = c1["hits"] - c0["hits"]
    dm = c1["misses"] - c0["misses"]
    return {
        "requests": requests,
        "wall_s": round(wall, 2),
        "throughput_rps": round(requests / wall, 1),
        "client_p50_ms": round(_percentile(lat, 0.50), 3),
        "client_p95_ms": round(_percentile(lat, 0.95), 3),
        "client_p99_ms": round(_percentile(lat, 0.99), 3),
        "client_mean_ms": round(statistics.mean(lat), 3),
        "steadystate_hit_rate": round(dh / (dh + dm), 4) if (dh + dm) else 0.0,
    }


def bench_writes(client, searches=20000, distinct=200):
    """Fire many searches over a small distinct set; measure write reduction."""
    before = client.get("/stats/writes").json()
    queries = [f"bench query {i}" for i in range(distinct)]
    for i in range(searches):
        client.post("/search", json={"query": queries[i % distinct]})
    time.sleep(config.flush_interval_s + 0.5)  # let the final flush land
    after = client.get("/stats/writes").json()
    dl = after["logical_writes"] - before["logical_writes"]
    dp = after["physical_writes"] - before["physical_writes"]
    return {
        "searches_fired": searches,
        "distinct_queries": distinct,
        "logical_writes_delta": dl,
        "physical_writes_delta": dp,
        "write_reduction_pct": round((1 - dp / dl) * 100, 2) if dl else 0.0,
        "server_reported": after,
    }


def bench_ring_balance():
    """Cold ring-balance: route every distinct dataset query as a key."""
    ring = HashRing([n["id"] for n in config.redis_nodes], config.cache_vnodes)
    keys = []
    with config.paths.dataset.open() as f:
        next(f)
        for line in f:
            keys.append("suggest:count:" + line.rsplit(",", 1)[0])
    dist = ring.distribution(keys)
    total = sum(dist.values())
    ideal = total / len(dist)
    spread = (max(dist.values()) - min(dist.values())) / ideal * 100
    return {
        "keys_routed": total,
        "vnodes_per_node": config.cache_vnodes,
        "per_node": dist,
        "per_node_pct": {k: round(100 * v / total, 2) for k, v in dist.items()},
        "max_min_spread_pct": round(spread, 2),
    }


def smoke(client):
    checks = {}
    r = client.get("/health"); checks["GET /health"] = r.status_code
    r = client.get("/suggest?q=iphone"); checks["GET /suggest?q=iphone"] = r.status_code
    r = client.get("/suggest?q=mac&mode=recency"); checks["GET /suggest recency"] = r.status_code
    r = client.get("/suggest?q="); checks["GET /suggest empty"] = r.status_code
    r = client.get("/suggest?q=zzzqqxno"); checks["GET /suggest no-match"] = r.status_code
    r = client.post("/search", json={"query": "smoke test"}); checks["POST /search"] = r.status_code
    r = client.get("/trending"); checks["GET /trending"] = r.status_code
    r = client.get("/cache/debug?prefix=iphone"); checks["GET /cache/debug"] = r.status_code
    r = client.get("/stats/writes"); checks["GET /stats/writes"] = r.status_code
    r = client.get("/metrics"); checks["GET /metrics"] = r.status_code
    r = client.get("/"); checks["GET / (frontend)"] = r.status_code
    return checks


def main():
    client = httpx.Client(base_url=BASE, timeout=30.0)
    print(f"== benchmarking {BASE} ==\n")

    print("[smoke] testing every endpoint…")
    checks = smoke(client)
    for k, v in checks.items():
        flag = "ok" if v == 200 else "FAIL"
        print(f"  {flag:4}  {v}  {k}")
    assert all(v == 200 for v in checks.values()), "smoke test failed"

    prefixes, distinct = load_prefixes()
    print(f"\n[latency] {len(distinct)} distinct prefixes, repeating workload…")
    lat = bench_latency(client, prefixes)
    for k, v in lat.items():
        print(f"  {k}: {v}")

    print("\n[writes] write-reduction under bursty repeats…")
    writes = bench_writes(client)
    for k, v in writes.items():
        if k != "server_reported":
            print(f"  {k}: {v}")

    print("\n[ring] cold balance across the 3 Redis nodes…")
    ring = bench_ring_balance()
    print(f"  keys routed: {ring['keys_routed']:,}  vnodes/node: {ring['vnodes_per_node']}")
    for nid, pct in ring["per_node_pct"].items():
        print(f"    {nid}: {ring['per_node'][nid]:,} ({pct}%)")
    print(f"  max-min spread vs ideal: {ring['max_min_spread_pct']}%")

    metrics = client.get("/metrics").json()
    print("\n[cache] hit rate from /metrics…")
    print(f"  steady-state hit_rate (post-warm measured loop): {lat['steadystate_hit_rate']}")
    print(f"  overall hit_rate (incl. cold fills): {metrics['cache']['hit_rate']}  "
          f"(hits={metrics['cache']['hits']}, misses={metrics['cache']['misses']})")
    for nid, s in metrics["cache"]["per_node"].items():
        print(f"    {nid}: hit_rate={s['hit_rate']} keys={s['keys']}")
    print("\n[latency] server-reported percentiles…")
    print(f"  {metrics['latency']}")

    results = {
        "base_url": BASE,
        "latency_client": lat,
        "latency_server": metrics["latency"],
        "cache": metrics["cache"],
        "writes": writes,
        "ring_balance": ring,
        "smoke": checks,
    }
    out = config.paths.root / "docs" / "benchmark-results.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(results, indent=2))
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
