"""Suggestion service — turn a prefix into ranked completions.

The trie hands us a bounded candidate pool (best-first by build-time count); we
re-rank that pool by the requested mode and return the top N. Keeping the pool
small (50) means ranking is cheap even though counts mutate over time.

Modes:
  - count   : rank by all-time count (Phase 2)
  - recency : blend all-time count with an exponentially-decayed recent-activity
              score (Phase 5)
"""
from __future__ import annotations

from typing import List

from app.config import config
from app.trie import Entry, Trie


def normalize(prefix: str) -> str:
    """Case-insensitive, whitespace-collapsed prefix; guard pathological length."""
    p = " ".join((prefix or "").split()).lower()
    return p[: config.suggest_max_prefix_len]


class SuggestionService:
    def __init__(self, trie: Trie, trending=None):
        self.trie = trie
        self.trending = trending  # set in Phase 5; None -> count-only

    def suggest(self, prefix: str, mode: str = "count", limit: int | None = None) -> List[dict]:
        limit = limit or config.suggest_limit
        norm = normalize(prefix)
        if not norm:
            return []
        pool = self.trie.prefix_pool(norm)
        if not pool:
            return []

        if mode == "recency" and self.trending is not None:
            ranked = self._rank_recency(pool)
        else:
            ranked = sorted(pool, key=lambda e: e.count, reverse=True)

        return [self._fmt(e, mode) for e in ranked[:limit]]

    # ---- ranking strategies ----
    def _rank_recency(self, pool: List[Entry]) -> List[Entry]:
        score = self.trending.blended_score
        return sorted(pool, key=score, reverse=True)

    def _fmt(self, e: Entry, mode: str) -> dict:
        out = {"query": e.query, "count": e.count}
        if mode == "recency" and self.trending is not None:
            out["recent"] = round(self.trending.decayed(e), 3)
            out["score"] = round(self.trending.blended_score(e), 4)
        return out
