"""Build data/queries.csv from a REAL open dataset: Wikimedia pageviews.

Source: Wikimedia hourly "pageviews" dump
  https://dumps.wikimedia.org/other/pageviews/<YYYY>/<YYYY-MM>/pageviews-<YYYYMMDD-HH0000>.gz

Each line is `domain page_title view_count response_bytes`. We use English
Wikipedia (domains `en` desktop + `en.m` mobile): the page **title** becomes the
query and the **view count** becomes the popularity count — a real, openly
downloadable (text, popularity) dataset.

Why a page-title popularity proxy? Real search-query logs are not published for
privacy reasons, so a public page-title + pageview-count signal is used as an
openly-licensed stand-in (CC0 dump) — exactly the kind of derivable-count open
dataset the brief allows.

Pipeline (deterministic + reproducible — fixed dump URL, deterministic sort):
  1. download the hourly dump (cached under data/) if not already present
  2. keep only `en` / `en.m` rows
  3. drop namespaced / special pages (titles containing ':', `Main_Page`, `-`)
  4. percent-decode, `_`->space, lowercase, collapse whitespace
  5. keep English-ish titles only (ASCII letters/digits + a little punctuation),
     length 2..64
  6. aggregate view counts per normalized title (desktop + mobile summed)
  7. take the top-N by count (ties broken by title) and write `query,count`

Output: data/queries.csv  (header `query,count`) — identical schema to before,
so load_dataset.py, the trie, and everything downstream are unchanged.
"""
from __future__ import annotations

import gzip
import os
import re
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.config import config  # noqa: E402

# Fixed, reproducible default dump (override via env). 2024-01-15 12:00 UTC.
DUMP_DATE = os.environ.get("DATASET_DATE", "2024-01-15")
DUMP_HOUR = os.environ.get("DATASET_HOUR", "12")
_y, _m, _d = DUMP_DATE.split("-")
DEFAULT_URL = (
    f"https://dumps.wikimedia.org/other/pageviews/{_y}/{_y}-{_m}/"
    f"pageviews-{_y}{_m}{_d}-{DUMP_HOUR}0000.gz"
)
URL = os.environ.get("WIKI_PAGEVIEWS_URL", DEFAULT_URL)

# Keep at most this many rows (top-by-count). >= 100k required.
TARGET = int(os.environ.get("DATASET_SIZE", config.dataset_size or 120_000))

# CSV-safe charset (no comma/quote, matching the original sanitizer) so the
# emitted query,count file parses cleanly with one query per row.
_allowed = re.compile(r"^[a-z0-9 .&'()/\-]+$")


def download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"[fetch] using cached dump {dest.name} ({dest.stat().st_size:,} bytes)")
        return
    print(f"[fetch] downloading {url}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as r, tmp.open("wb") as out:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
    tmp.rename(dest)
    print(f"[fetch] saved {dest.name} ({dest.stat().st_size:,} bytes)")


def normalize(title: str) -> str | None:
    if ":" in title or title in ("Main_Page", "-"):
        return None
    t = urllib.parse.unquote(title).replace("_", " ")
    t = t.replace('"', "").replace(",", "")  # CSV-safe, matches original sanitizer
    t = " ".join(t.split()).strip().lower()
    if len(t) < 2 or len(t) > 64:
        return None
    if not _allowed.match(t):
        return None
    if not any(c.isalpha() for c in t):
        return None
    return t


def aggregate(gz_path: Path) -> dict[str, int]:
    agg: dict[str, int] = defaultdict(int)
    raw_en = 0
    with gzip.open(gz_path, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.split(" ")
            if len(parts) < 3:
                continue
            domain, title, count = parts[0], parts[1], parts[2]
            if domain not in ("en", "en.m"):
                continue
            raw_en += 1
            t = normalize(title)
            if t is None:
                continue
            try:
                agg[t] += int(count)
            except ValueError:
                continue
    print(f"[agg] english rows scanned: {raw_en:,}; distinct clean titles: {len(agg):,}")
    return agg


def main() -> None:
    gz = config.paths.data / Path(urllib.parse.urlparse(URL).path).name
    download(URL, gz)
    agg = aggregate(gz)
    if len(agg) < 100_000:
        raise SystemExit(
            f"only {len(agg):,} distinct titles (< 100k). Set WIKI_PAGEVIEWS_URL to "
            f"a busier hour or aggregate multiple hours."
        )

    # top-N by count; deterministic tiebreak on title
    ranked = sorted(agg.items(), key=lambda kv: (-kv[1], kv[0]))[:TARGET]
    total = sum(c for _, c in ranked)

    config.paths.data.mkdir(parents=True, exist_ok=True)
    with config.paths.dataset.open("w") as out:
        out.write("query,count\n")
        for q, c in ranked:
            # query is already sanitized to a CSV-safe charset (no commas/quotes)
            out.write(f"{q},{c}\n")

    print(f"[write] {len(ranked):,} rows -> {config.paths.dataset}")
    print(f"[write] source dump: {URL}")
    print(f"[write] total real pageviews across kept titles: {total:,}")
    print("[write] sample head:", ", ".join(f'"{q}"' for q, _ in ranked[:3]))


if __name__ == "__main__":
    main()
