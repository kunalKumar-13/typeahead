"""Recency-aware ranking via an exponentially-decayed activity counter.

Each query carries a `recent` score that decays with a configurable half-life.
On every search we first decay the old score to *now*, then add 1. Because the
score halves every `half_life` seconds, a burst of activity boosts a query
temporarily and then fades — so a one-day-popular query can't permanently
out-rank everything (the failure mode of a raw lifetime counter).

Two consumers:
  - mode=recency suggestions blend it with the historical count:
        score = log(count + 1) + recency_weight * decayed_recent
    The log compresses the huge spread of all-time counts so a genuine recent
    surge can actually move a suggestion up, without letting recency erase the
    signal that some queries are simply always popular.
  - GET /trending ranks purely by decayed recent activity.

When a flush changes activity, the recency-mode cache entries for the affected
prefixes are stale, so on_flush() invalidates exactly those Redis keys (plus the
global trending key).
"""
from __future__ import annotations

import math
import threading
import time
from typing import List, Optional

from app.config import config
from app.trie import Entry


class TrendingTracker:
    def __init__(self, cache=None, half_life_s: Optional[float] = None,
                 recency_weight: Optional[float] = None):
        self.cache = cache  # DistributedCache, for invalidation
        self.half_life_s = half_life_s if half_life_s is not None else config.trend_half_life_s
        self.recency_weight = recency_weight if recency_weight is not None else config.recency_weight
        self._decay_per_s = math.log(2) / self.half_life_s
        self._active: set[Entry] = set()
        self._lock = threading.Lock()

    def _now(self) -> float:
        return time.time()

    # ---- decay math ----
    def decayed(self, entry: Entry, now: Optional[float] = None) -> float:
        """Current decayed recent score (does not mutate the entry)."""
        if entry.recent <= 0.0:
            return 0.0
        now = now if now is not None else self._now()
        dt = now - entry.last_ts
        if dt <= 0:
            return entry.recent
        return entry.recent * math.exp(-self._decay_per_s * dt)

    def blended_score(self, entry: Entry, now: Optional[float] = None) -> float:
        return math.log(entry.count + 1) + self.recency_weight * self.decayed(entry, now)

    # ---- hot path: record one search (called from BatchWriter.record) ----
    def record(self, entry: Entry) -> None:
        now = self._now()
        entry.recent = self.decayed(entry, now) + 1.0
        entry.last_ts = now
        with self._lock:
            self._active.add(entry)

    # ---- trending list ----
    def trending(self, limit: Optional[int] = None) -> List[dict]:
        limit = limit or config.trending_limit
        now = self._now()
        with self._lock:
            active = list(self._active)
        scored = []
        survivors = []
        for e in active:
            d = self.decayed(e, now)
            if d < 1e-3:
                continue  # faded out — drop from the active set
            survivors.append(e)
            scored.append((e, d))
        # prune faded entries so the active set stays bounded
        if len(survivors) != len(active):
            with self._lock:
                self._active = set(survivors) | (self._active - set(active))
        scored.sort(key=lambda t: t[1], reverse=True)
        return [
            {"query": e.query, "recent": round(d, 3), "count": e.count,
             "score": round(self.blended_score(e, now), 4)}
            for e, d in scored[:limit]
        ]

    # ---- cache invalidation on flush ----
    def on_flush(self, snapshot: dict[str, int]) -> int:
        """Invalidate recency-mode cache for prefixes whose ranking may have moved.

        Returns the number of Redis keys invalidated. A flush means recent
        activity changed, so recency-mode results for any prefix of a searched
        query are potentially stale.
        """
        if self.cache is None:
            return 0
        prefixes: set[str] = set()
        for q in snapshot:
            for i in range(1, len(q) + 1):
                prefixes.add(q[:i])
        invalidated = 0
        for p in prefixes:
            self.cache.delete(self.cache.key_for(p, "recency"))
            invalidated += 1
        # global trending list is recomputed each flush
        self.cache.delete("trending:global")
        invalidated += 1
        return invalidated
