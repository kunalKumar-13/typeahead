"""Generate a reproducible, realistically-skewed search dataset.

Output: data/queries.csv  with header `query,count`.

Design notes (for the viva):
  - We emit single terms first, then 2-grams, then long-tail combinations.
    Counts are assigned by generation order, so short/common queries ("iphone")
    land at the head of the distribution and long-tail queries at the bottom.
  - Counts follow a Zipf law: count(rank) = max_count / rank**exponent, with
    multiplicative jitter. This mimics real search traffic (a few very popular
    queries, a very long tail) and makes the cache/typeahead behaviour realistic.
  - A seeded PRNG (mulberry32) makes the whole dataset reproducible, so latency
    and hit-rate numbers in the report are stable across runs. The same
    algorithm/seed as the original Node generator are used for continuity.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.config import config  # noqa: E402


# ---- Seeded PRNG (deterministic, reproducible dataset) -- mulberry32 ----
class Mulberry32:
    MASK = 0xFFFFFFFF

    def __init__(self, seed: int):
        self.a = seed & self.MASK

    def random(self) -> float:
        self.a = (self.a + 0x6D2B79F5) & self.MASK
        t = self.a
        t = (t ^ (t >> 15)) * (1 | t) & self.MASK
        t = (t + ((t ^ (t >> 7)) * (61 | t) & self.MASK)) & self.MASK ^ t
        t &= self.MASK
        return ((t ^ (t >> 14)) & self.MASK) / 4294967296.0


rand = Mulberry32(1234567)


# ---- Vocabulary across several domains so prefixes match meaningfully ----
brands = [
    "apple", "samsung", "sony", "lg", "dell", "hp", "lenovo", "asus", "acer",
    "microsoft", "google", "amazon", "nike", "adidas", "puma", "reebok", "gucci",
    "zara", "levis", "canon", "nikon", "gopro", "bose", "jbl", "xiaomi", "oneplus",
    "oppo", "vivo", "realme", "motorola", "nokia", "huawei", "logitech", "razer",
    "corsair", "intel", "amd", "nvidia", "tesla", "toyota", "honda", "ford", "bmw",
    "audi", "mercedes", "ikea", "philips", "panasonic", "whirlpool", "dyson",
    "boat", "noise", "fossil", "casio", "titan", "uniqlo", "wrangler", "crocs",
    "skechers", "new balance", "under armour", "fitbit", "garmin", "anker",
    "sandisk", "seagate", "kingston", "msi", "gigabyte", "tcl", "haier", "godrej",
    "bosch", "kitchenaid", "lego", "redmi", "poco", "asics", "hitachi", "epson",
]
products = [
    "iphone", "galaxy", "macbook", "laptop", "phone", "tablet", "headphones",
    "earbuds", "charger", "cable", "case", "cover", "screen protector", "monitor",
    "keyboard", "mouse", "webcam", "speaker", "soundbar", "tv", "camera", "lens",
    "watch", "smartwatch", "fitness band", "router", "ssd", "hard drive", "pendrive",
    "power bank", "shoes", "sneakers", "running shoes", "jacket", "jeans", "tshirt",
    "backpack", "sunglasses", "wallet", "perfume", "blender", "air fryer",
    "microwave", "refrigerator", "washing machine", "vacuum cleaner", "coffee maker",
    "gaming chair", "office chair", "standing desk", "printer", "projector",
    "tripod", "microphone", "graphics card", "motherboard", "processor", "ram",
    "cpu cooler", "led bulb", "smart bulb", "doorbell", "security camera",
    "thermostat", "kettle", "toaster", "iron", "hair dryer", "trimmer", "shaver",
    "toothbrush", "water bottle", "yoga mat", "dumbbells", "treadmill", "drone",
]
tech_topics = [
    "java", "python", "javascript", "typescript", "react", "node", "spring boot",
    "kubernetes", "docker", "system design", "data structures", "algorithms",
    "machine learning", "deep learning", "sql", "mongodb", "redis", "kafka",
    "aws", "azure", "gcp", "linux", "git", "rust", "golang", "c++", "html", "css",
    "graphql", "microservices", "rest api", "oauth", "leetcode", "dynamic programming",
]
intents = [
    "tutorial", "for beginners", "interview questions", "cheat sheet", "course",
    "roadmap", "project ideas", "best practices", "examples", "documentation",
    "crash course", "in 2026", "vs", "certification", "pdf", "notes", "guide",
]
shop_intents = [
    "price", "review", "near me", "online", "deals", "offers", "discount",
    "best", "cheap", "under 500", "under 1000", "pro max", "plus", "5g", "specs",
    "comparison", "replacement", "original", "second hand", "on sale",
]
how_to_verbs = [
    "cook", "make", "fix", "install", "learn", "draw", "bake", "clean", "build",
    "reset", "connect", "download", "remove", "create", "setup", "tie", "grow",
]
how_to_nouns = [
    "pasta", "pizza", "bread", "a website", "a resume", "a budget", "rice",
    "pancakes", "a tie", "a router", "windows", "a garden", "sourdough",
    "a paper plane", "a campfire", "coffee", "a birdhouse", "a deck",
]
places = [
    "paris", "london", "tokyo", "new york", "dubai", "singapore", "bali",
    "goa", "rome", "barcelona", "amsterdam", "bangkok", "sydney", "iceland",
]
travel_intents = [
    "flights", "hotels", "things to do", "weather", "tourist places", "visa",
    "best time to visit", "itinerary", "food", "map", "tour packages",
]


def generate_candidates():
    # 1) single high-frequency terms (head of the distribution)
    seen_singles = []
    seen_set = set()
    for s in [*products, *tech_topics, *brands, *places]:
        if s not in seen_set:
            seen_set.add(s)
            seen_singles.append(s)
    for s in seen_singles:
        yield s

    # 2) brand + product
    for b in brands:
        for p in products:
            yield f"{b} {p}"

    # 3) product + shopping intent
    for p in products:
        for s in shop_intents:
            yield f"{p} {s}"

    # 4) tech topic + learning intent
    for t in tech_topics:
        for i in intents:
            yield f"{t} {i}"

    # 5) how-to queries
    for v in how_to_verbs:
        for n in how_to_nouns:
            yield f"how to {v} {n}"

    # 6) travel queries
    for pl in places:
        for ti in travel_intents:
            yield f"{pl} {ti}"

    # 7) long-tail: brand + product + shopping intent (huge space)
    for b in brands:
        for p in products:
            for s in shop_intents:
                yield f"{b} {p} {s}"

    # 8) long-tail: topic + intent + year-ish modifiers
    years = ["2024", "2025", "2026", "latest", "updated", "free", "advanced"]
    for t in tech_topics:
        for i in intents:
            for y in years:
                yield f"{t} {i} {y}"


_punct = re.compile(r'[",]')
_ws = re.compile(r"\s+")


def sanitize(q: str) -> str:
    return _ws.sub(" ", _punct.sub("", q)).strip().lower()


def main() -> None:
    target = config.dataset_size
    zipf_exponent = config.zipf_exponent
    max_count = config.max_count

    seen = set()
    queries = []
    for cand in generate_candidates():
        q = sanitize(cand)
        if not q or q in seen:
            continue
        seen.add(q)
        queries.append(q)
        if len(queries) >= target:
            break

    if len(queries) < target:
        print(
            f"WARNING: vocabulary produced only {len(queries):,} distinct queries "
            f"(< requested {target:,}). Increase vocabulary or templates.",
            file=sys.stderr,
        )

    # Assign Zipf counts by generation order (rank 1 = most popular).
    lines = ["query,count"]
    total_count = 0
    for i, q in enumerate(queries):
        rank = i + 1
        base = max_count / (rank ** zipf_exponent)
        jitter = 0.6 + rand.random() * 0.8  # 0.6x .. 1.4x
        count = max(config.initial_count, round(base * jitter))
        total_count += count
        lines.append(f"{q},{count}")

    config.paths.data.mkdir(parents=True, exist_ok=True)
    config.paths.dataset.write_text("\n".join(lines) + "\n")

    print(f"Generated {len(queries):,} distinct queries")
    print(f"  -> {config.paths.dataset}")
    print(f"  total synthetic search volume: {total_count:,}")
    print("  sample head:", ", ".join(f'"{q}"' for q in queries[:3]))


if __name__ == "__main__":
    main()
