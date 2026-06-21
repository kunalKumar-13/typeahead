"""Latency metrics — percentiles over a bounded window of recent samples.

We keep the last N /suggest latencies in a ring buffer and compute p50/p95/p99
on demand. A bounded window keeps memory flat and makes the percentiles reflect
*recent* behaviour rather than being dragged by cold-start outliers. Cache
hit-rate, per-node stats and write-reduction are owned by their own modules;
/metrics just stitches them together.
"""
from __future__ import annotations

import threading
from collections import deque
from typing import Deque


class Metrics:
    def __init__(self, window: int = 5000):
        self._suggest_ms: Deque[float] = deque(maxlen=window)
        self._lock = threading.Lock()
        self.suggest_requests = 0

    def record_suggest(self, ms: float) -> None:
        with self._lock:
            self._suggest_ms.append(ms)
            self.suggest_requests += 1

    @staticmethod
    def _percentile(sorted_vals, p: float) -> float:
        if not sorted_vals:
            return 0.0
        k = (len(sorted_vals) - 1) * p
        lo = int(k)
        hi = min(lo + 1, len(sorted_vals) - 1)
        frac = k - lo
        return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac

    def latency(self) -> dict:
        with self._lock:
            vals = sorted(self._suggest_ms)
            n = len(vals)
            total = self.suggest_requests
        return {
            "suggest_requests": total,
            "window_samples": n,
            "p50_ms": round(self._percentile(vals, 0.50), 3),
            "p95_ms": round(self._percentile(vals, 0.95), 3),
            "p99_ms": round(self._percentile(vals, 0.99), 3),
            "max_ms": round(vals[-1], 3) if vals else 0.0,
            "mean_ms": round(sum(vals) / n, 3) if n else 0.0,
        }
