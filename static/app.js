// Typeahead frontend — visual refactor only. Same endpoints, same behavior:
//   GET /suggest?q=&mode=count|recency   debounced, keyboard-navigable
//   POST /search                          on select / Enter (dummy response shown)
//   GET /trending, GET /health
// One semantic accent (green = cache HIT); all data rendered monospace.

const $ = (id) => document.getElementById(id);
const input = $("search");
const dropdown = $("dropdown");
const fieldHint = $("fieldHint");
const telemetry = $("telemetry");
const result = $("searchResult");

let mode = "count";
let items = [];
let active = -1;
let debounceTimer = null;
let inflight = 0;

// ---------- ranking mode (Popular = count, Trending = recency) ----------
document.querySelectorAll(".seg").forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
});
function setMode(next) {
  mode = next;
  document.querySelectorAll(".seg").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  if (input.value.trim()) fetchSuggestions(input.value);
}

// ---------- debounced suggest ----------
input.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  const q = input.value;
  if (!q.trim()) {
    closeDropdown();
    fieldHint.textContent = "";
    setTelemetryIdle();
    return;
  }
  fieldHint.textContent = "searching";
  telemetry.classList.add("searching");
  debounceTimer = setTimeout(() => fetchSuggestions(q), 120);
});

async function fetchSuggestions(q) {
  const seq = ++inflight;
  try {
    const res = await fetch(`/suggest?q=${encodeURIComponent(q)}&mode=${mode}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== inflight) return; // superseded by a newer keystroke
    fieldHint.textContent = "";
    telemetry.classList.remove("searching");
    items = data.suggestions || [];
    active = -1;
    renderDropdown();
    renderTelemetry(data);
  } catch (err) {
    if (seq !== inflight) return;
    fieldHint.textContent = "";
    telemetry.classList.remove("searching");
    renderError(err);
  }
}

// ---------- dropdown ----------
function renderDropdown() {
  dropdown.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "note";
    li.textContent = "No matches";
    dropdown.appendChild(li);
    dropdown.hidden = false;
    return;
  }
  items.forEach((it, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    const fire = mode === "recency" && it.recent && it.recent > 1
      ? `<span class="fire">↗ ${Math.round(it.recent).toLocaleString()}</span>` : "";
    li.innerHTML =
      `<span class="q">${escapeHtml(it.query)}</span>` +
      `<span class="c">${formatCount(it.count)}${fire}</span>`;
    li.addEventListener("mousemove", () => { if (active !== i) { active = i; highlight(); } });
    li.addEventListener("click", () => choose(i));
    dropdown.appendChild(li);
  });
  dropdown.hidden = false;
}

// ---------- telemetry: "redis2 · Hit · 0.21 ms" ----------
function renderTelemetry(data) {
  const c = data.cache || {};
  const isHit = c.status === "HIT";
  const node = c.node || "—";
  const status = isHit ? "Hit" : "Miss";
  const lat = data.latency_ms != null ? `${data.latency_ms.toFixed(2)} ms` : "—";
  telemetry.innerHTML =
    `<span class="node">${escapeHtml(node)}</span>` +
    `<span class="sep">·</span>` +
    `<span class="${isHit ? "hit" : "miss"}">${status}</span>` +
    `<span class="sep">·</span>` +
    `<span class="lat">${lat}</span>`;
}
function setTelemetryIdle() {
  telemetry.innerHTML =
    `<span class="tel-muted">routed node · cache status · latency appear here</span>`;
}
function renderError(err) {
  closeDropdownKeepError();
  telemetry.innerHTML = `<span class="miss">request failed</span>` +
    `<span class="sep">·</span><span class="lat">${escapeHtml(err.message)}</span>`;
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
function closeDropdownKeepError() { dropdown.hidden = true; active = -1; }

// ---------- POST /search (dummy response) ----------
async function submitSearch(q) {
  try {
    const res = await fetch("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    const data = await res.json();
    result.hidden = false;
    result.className = "result";
    result.innerHTML =
      `<span class="label">POST /search</span>` +
      `recorded <code>${escapeHtml(q)}</code> — server replied <code>${escapeHtml(JSON.stringify(data))}</code>`;
    loadTrending();
  } catch (err) {
    result.hidden = false;
    result.className = "result is-error";
    result.innerHTML = `<span class="label">POST /search</span>failed — ${escapeHtml(err.message)}`;
  }
}

// ---------- trending ----------
async function loadTrending() {
  const el = $("trending");
  try {
    const res = await fetch("/trending?limit=10");
    const data = await res.json();
    const t = data.trending || [];
    if (!t.length) {
      el.innerHTML = `<li class="trend-empty">No activity yet — run a few searches.</li>`;
      return;
    }
    el.innerHTML = "";
    t.forEach((it, i) => {
      const li = document.createElement("li");
      li.innerHTML =
        `<span class="rank">${String(i + 1).padStart(2, "0")}</span>` +
        `<span class="tq">${escapeHtml(it.query)}</span>` +
        `<span class="tmeta">` +
          `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">` +
            `<path d="M4 18 L11 11 L15 15 L21 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
            `<path d="M15 7h6v6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
          `</svg>` +
          `${Math.round(it.recent).toLocaleString()}` +
        `</span>`;
      li.querySelector(".tq").addEventListener("click", () => {
        input.value = it.query;
        setMode("recency");
      });
      el.appendChild(li);
    });
  } catch (err) {
    el.innerHTML = `<li class="trend-empty">Trending unavailable — ${escapeHtml(err.message)}</li>`;
  }
}

// ---------- health (top bar) ----------
async function loadHealth() {
  try {
    const res = await fetch("/health");
    const d = await res.json();
    $("health").textContent = `${d.queries_loaded.toLocaleString()} queries · ${d.uptime_s}s up`;
  } catch {
    $("health").textContent = "backend unreachable";
  }
}

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function formatCount(n) {
  return Number(n).toLocaleString("en-US"); // thousands separators, e.g. 29,429
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-stack")) closeDropdown();
});

setTelemetryIdle();
loadHealth();
loadTrending();
