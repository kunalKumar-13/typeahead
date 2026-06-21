// Frontend for the search typeahead.
// - debounced /suggest with keyboard navigation
// - basic (count) / enhanced (recency) ranking toggle
// - visible "matched node · HIT/MISS" indicator + latency
// - trending panel, dummy /search response display, loading/empty/error states

const $ = (id) => document.getElementById(id);
const input = $("search");
const dropdown = $("dropdown");
const statusBadge = $("status");
const cacheIndicator = $("cacheIndicator");
const nodeName = $("nodeName");
const hitmiss = $("hitmiss");
const latencyEl = $("latency");
const searchResult = $("searchResult");

let mode = "count";
let items = [];
let active = -1;
let debounceTimer = null;
let inflight = 0;

// ---------- ranking mode toggle ----------
document.querySelectorAll(".toggle-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".toggle-btn").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    mode = btn.dataset.mode;
    if (input.value.trim()) fetchSuggestions(input.value);
  });
});

// ---------- debounced suggest ----------
input.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  const q = input.value;
  if (!q.trim()) {
    closeDropdown();
    cacheIndicator.hidden = true;
    return;
  }
  statusBadge.innerHTML = '<span class="spinner"></span>';
  debounceTimer = setTimeout(() => fetchSuggestions(q), 120);
});

async function fetchSuggestions(q) {
  const seq = ++inflight;
  try {
    const res = await fetch(`/suggest?q=${encodeURIComponent(q)}&mode=${mode}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== inflight) return; // a newer request superseded this one
    statusBadge.textContent = "";
    items = data.suggestions || [];
    active = -1;
    renderDropdown();
    renderCacheIndicator(data);
  } catch (err) {
    if (seq !== inflight) return;
    statusBadge.textContent = "";
    renderError(err);
  }
}

function renderDropdown() {
  dropdown.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "no matches";
    dropdown.appendChild(li);
    dropdown.hidden = false;
    return;
  }
  items.forEach((it, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    const hot = mode === "recency" && it.recent && it.recent > 1
      ? ` <span class="hot">🔥${Math.round(it.recent)}</span>` : "";
    li.innerHTML = `<span class="q">${escapeHtml(it.query)}</span>` +
      `<span class="meta">${formatCount(it.count)}${hot}</span>`;
    li.addEventListener("mouseenter", () => { active = i; highlight(); });
    li.addEventListener("click", () => choose(i));
    dropdown.appendChild(li);
  });
  dropdown.hidden = false;
}

function renderCacheIndicator(data) {
  const c = data.cache || {};
  cacheIndicator.hidden = false;
  nodeName.textContent = c.node || "—";
  hitmiss.textContent = c.status || "—";
  hitmiss.className = "pill " + (c.status === "HIT" ? "hit" : "miss");
  latencyEl.textContent = data.latency_ms != null ? `${data.latency_ms.toFixed(2)} ms` : "";
}

function renderError(err) {
  dropdown.innerHTML = "";
  const li = document.createElement("li");
  li.className = "empty";
  li.textContent = "error fetching suggestions";
  dropdown.appendChild(li);
  dropdown.hidden = false;
  searchResult.hidden = false;
  searchResult.className = "search-result error";
  searchResult.textContent = `⚠ ${err.message}`;
}

// ---------- keyboard navigation ----------
input.addEventListener("keydown", (e) => {
  if (dropdown.hidden) {
    if (e.key === "Enter" && input.value.trim()) submitSearch(input.value.trim());
    return;
  }
  if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); highlight(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, -1); highlight(); }
  else if (e.key === "Enter") {
    e.preventDefault();
    if (active >= 0 && items[active]) choose(active);
    else if (input.value.trim()) submitSearch(input.value.trim());
  } else if (e.key === "Escape") { closeDropdown(); }
});

function highlight() {
  [...dropdown.children].forEach((li, i) => li.classList.toggle("active", i === active));
  if (active >= 0 && dropdown.children[active]) {
    dropdown.children[active].scrollIntoView({ block: "nearest" });
  }
}

function choose(i) {
  const q = items[i].query;
  input.value = q;
  closeDropdown();
  submitSearch(q);
}

function closeDropdown() { dropdown.hidden = true; active = -1; }

// ---------- POST /search (dummy-response display) ----------
async function submitSearch(q) {
  try {
    const res = await fetch("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    const data = await res.json();
    searchResult.hidden = false;
    searchResult.className = "search-result";
    searchResult.innerHTML = `searched <code>${escapeHtml(q)}</code> → server replied ` +
      `<code>${escapeHtml(JSON.stringify(data))}</code>`;
    loadTrending();
  } catch (err) {
    searchResult.hidden = false;
    searchResult.className = "search-result error";
    searchResult.textContent = `⚠ search failed: ${err.message}`;
  }
}

// ---------- trending panel ----------
async function loadTrending() {
  const el = $("trending");
  try {
    const res = await fetch("/trending?limit=10");
    const data = await res.json();
    const t = data.trending || [];
    if (!t.length) { el.innerHTML = '<li class="muted">no trending activity yet — run a few searches</li>'; return; }
    el.innerHTML = "";
    t.forEach((it) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="q">${escapeHtml(it.query)}</span>` +
        `<span class="score">🔥 ${Math.round(it.recent)} · ${formatCount(it.count)} all-time</span>`;
      li.querySelector(".q").addEventListener("click", () => {
        input.value = it.query; mode = "recency"; syncToggle(); fetchSuggestions(it.query);
      });
      el.appendChild(li);
    });
  } catch (err) {
    el.innerHTML = `<li class="muted">trending unavailable: ${escapeHtml(err.message)}</li>`;
  }
}

function syncToggle() {
  document.querySelectorAll(".toggle-btn").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
}

$("refreshTrending").addEventListener("click", loadTrending);

// ---------- health footer ----------
async function loadHealth() {
  try {
    const res = await fetch("/health");
    const d = await res.json();
    $("health").textContent = `● ${d.queries_loaded.toLocaleString()} queries loaded · up ${d.uptime_s}s`;
  } catch { $("health").textContent = "● backend unreachable"; }
}

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function formatCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-box")) closeDropdown();
});

loadHealth();
loadTrending();
