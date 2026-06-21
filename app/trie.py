"""In-memory prefix trie: prefix -> top candidate entries.

Lookup must be fast (it's on the typeahead hot path), so instead of walking the
whole subtree on every keystroke each node caches a bounded list of the
highest-count entries that pass through it (the "candidate pool"). We build the
trie by inserting entries in *descending count order*, so a node's cached list
is naturally sorted best-first and we simply stop appending once it is full.

The cached list is a pool (default 50), larger than the 10 we return, leaving
headroom for the suggestion service to re-rank by recency without a subtree scan.
Counts mutate in place (the batch writer holds the same Entry objects), so the
counts shown stay live; popularity ordering is refreshed on the next rebuild.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from app.config import config


@dataclass(eq=False)  # identity equality/hash: entries are unique mutable objects
class Entry:
    query: str
    count: int
    # exponentially-decayed recent-activity state (used from Phase 5 on)
    recent: float = 0.0
    last_ts: float = 0.0


class _Node:
    __slots__ = ("children", "top")

    def __init__(self):
        self.children: dict[str, _Node] = {}
        self.top: list[Entry] = []


class Trie:
    def __init__(self, pool: int | None = None):
        self.root = _Node()
        self.pool = pool or config.suggest_candidate_pool
        self.entries: dict[str, Entry] = {}

    # ---- build ----
    @classmethod
    def build(cls, rows, pool: int | None = None) -> "Trie":
        """Build from an iterable of (query, count). Sorts by count desc first."""
        t = cls(pool)
        items = sorted(rows, key=lambda r: r[1], reverse=True)
        for q, c in items:
            entry = Entry(query=q, count=c)
            t.entries[q] = entry
            t._index(entry)
        return t

    def _index(self, entry: Entry) -> None:
        node = self.root
        # root node represents the empty prefix (used by trending/global views)
        if len(node.top) < self.pool:
            node.top.append(entry)
        for ch in entry.query:
            nxt = node.children.get(ch)
            if nxt is None:
                nxt = _Node()
                node.children[ch] = nxt
            node = nxt
            if len(node.top) < self.pool:
                node.top.append(entry)

    # ---- runtime insert of a brand-new query ----
    def insert(self, query: str, count: int) -> Entry:
        existing = self.entries.get(query)
        if existing is not None:
            return existing
        entry = Entry(query=query, count=count)
        self.entries[query] = entry
        self._index(entry)
        return entry

    def get(self, query: str) -> Entry | None:
        return self.entries.get(query)

    # ---- lookup ----
    def prefix_pool(self, prefix: str) -> list[Entry]:
        """Return the cached candidate pool for `prefix` (best-first by build count)."""
        node = self.root
        for ch in prefix:
            node = node.children.get(ch)
            if node is None:
                return []
        return node.top

    def __len__(self) -> int:
        return len(self.entries)
