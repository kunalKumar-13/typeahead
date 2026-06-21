// Frontend for the Search Typeahead system. Vanilla JS, no build step.
//
// Highlights:
//  - debounced /suggest calls (avoids a backend hit per keystroke)
//  - AbortController cancels in-flight requests so stale responses can't
//    overwrite fresher ones (out-of-order protection)
//  - full keyboard navigation (Up/Down/Enter/Escape)
//  - live ranking-mode toggle to show basic (count) vs enhanced (recency)
//  - trending panel, loading + error states, backend health indicator

const $ = (sel) => document.querySelector(sel);

const input = $('#search-input');
const box = $('.search-box');
const list = $('#suggestions');
const clearBtn = $('#clear-btn');
const searchBtn = $('#search-btn');
const latencyBadge = $('#latency-badge');
const responseCard = $('#response-card');
const responseBody = $('#response-body');
const trendingList = $('#trending-list');
const errorToast = $('#error-toast');

const DEBOUNCE_MS = 120;
let activeIndex = -1; // highlighted suggestion for keyboard nav
let currentSuggestions = [];
let reqSeq = 0; // monotonically increasing; guards against stale renders
let inflight = null; // AbortController for the latest /suggest

const getMode = () =>
  document.querySelector('input[name="mode"]:checked').value;

// --------------------------------------------------------------------------
// Networking
// --------------------------------------------------------------------------
async function fetchSuggestions(prefix) {
  const seq = ++reqSeq;
  if (inflight) inflight.abort();
  inflight = new AbortController();
  const mode = getMode();
  const t0 = performance.now();
  try {
    const res = await fetch(
      `/suggest?q=${encodeURIComponent(prefix)}&mode=${mode}`,
      { signal: inflight.signal }
    );
    if (!res.ok) throw new Error(`suggest ${res.status}`);
    const data = await res.json();
    const ms = (performance.now() - t0).toFixed(1);
    // Ignore if a newer request has since been issued.
    if (seq !== reqSeq) return;
    latencyBadge.textContent = `${data.source} · ${ms} ms`;
    latencyBadge.className =
      'latency-badge ' + (data.source === 'cache' ? 'tag-cache' : 'tag-store');
    renderSuggestions(data.suggestions, prefix, data.source, ms);
  } catch (err) {
    if (err.name === 'AbortError') return; // superseded — not an error
    showError('Could not fetch suggestions');
    closeDropdown();
  }
}

async function submitSearch(rawQuery) {
  const query = rawQuery.trim();
  if (!query) return;
  closeDropdown();
  try {
    const res = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`search ${res.status}`);
    const data = await res.json();
    showResponse(data);
    // Reflect the new activity: refresh trending and re-query suggestions.
    loadTrending();
  } catch (err) {
    showError('Search request failed');
  }
}

async function loadTrending() {
  try {
    const res = await fetch('/trending');
    if (!res.ok) throw new Error('trending');
    const data = await res.json();
    renderTrending(data.trending);
  } catch {
    trendingList.innerHTML = '<li class="muted">Trending unavailable</li>';
  }
}

async function checkHealth() {
  const dot = $('#health-dot');
  const text = $('#health-text');
  try {
    const res = await fetch('/health');
    if (!res.ok) throw new Error();
    dot.className = 'dot ok';
    text.textContent = 'backend healthy';
  } catch {
    dot.className = 'dot bad';
    text.textContent = 'backend unreachable';
  }
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function highlightPrefix(query, prefix) {
  const safe = escapeHtml(query);
  if (prefix && query.toLowerCase().startsWith(prefix.toLowerCase())) {
    return `<b>${escapeHtml(query.slice(0, prefix.length))}</b>${escapeHtml(
      query.slice(prefix.length)
    )}`;
  }
  return safe;
}

function renderSuggestions(suggestions, prefix, source, ms) {
  currentSuggestions = suggestions || [];
  activeIndex = -1;
  if (!currentSuggestions.length) {
    list.innerHTML = `<li class="suggest-empty">No matches for “${escapeHtml(
      prefix
    )}”</li>`;
    openDropdown();
    return;
  }
  const rows = currentSuggestions
    .map((s, i) => {
      const hot =
        s.recentScore && s.recentScore > 0.05
          ? `<span class="badge hot" title="recent activity score">🔥 ${s.recentScore.toFixed(
              1
            )}</span>`
          : '';
      return `<li class="suggestion" role="option" data-index="${i}" data-query="${escapeHtml(
        s.query
      )}">
        <span class="q">${highlightPrefix(s.query, prefix)}</span>
        <span class="meta">${hot}<span class="badge" title="all-time count">${formatCount(
        s.count
      )}</span></span>
      </li>`;
    })
    .join('');
  const tag = source === 'cache' ? 'tag-cache' : 'tag-store';
  list.innerHTML =
    rows +
    `<li class="source-line"><span>served from <span class="${tag}">${source}</span></span><span>${ms} ms</span></li>`;
  openDropdown();
}

function renderTrending(items) {
  if (!items || !items.length) {
    trendingList.innerHTML =
      '<li class="muted">No trending searches yet — submit a few searches.</li>';
    return;
  }
  trendingList.innerHTML = items
    .map(
      (t) => `<li data-query="${escapeHtml(t.query)}">
        <div class="t-row">
          <span class="t-query">${escapeHtml(t.query)}</span>
          <span class="t-score">🔥 ${t.recentScore.toFixed(2)} · ${formatCount(
        t.count
      )} all-time</span>
        </div>
      </li>`
    )
    .join('');
}

function showResponse(data) {
  responseBody.textContent = JSON.stringify(data, null, 2);
  responseCard.hidden = false;
}

function formatCount(n) {
  if (n == null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

let errorTimer = null;
function showError(msg) {
  errorToast.textContent = msg;
  errorToast.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => (errorToast.hidden = true), 2600);
}

// --------------------------------------------------------------------------
// Dropdown + keyboard nav
// --------------------------------------------------------------------------
function openDropdown() {
  list.hidden = false;
  box.setAttribute('aria-expanded', 'true');
}
function closeDropdown() {
  list.hidden = true;
  activeIndex = -1;
  box.setAttribute('aria-expanded', 'false');
}
function setActive(i) {
  const items = list.querySelectorAll('.suggestion');
  if (!items.length) return;
  activeIndex = (i + items.length) % items.length;
  items.forEach((el, idx) => {
    el.classList.toggle('active', idx === activeIndex);
    if (idx === activeIndex) el.scrollIntoView({ block: 'nearest' });
  });
}

// --------------------------------------------------------------------------
// Events
// --------------------------------------------------------------------------
const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

const debouncedSuggest = debounce((val) => fetchSuggestions(val), DEBOUNCE_MS);

input.addEventListener('input', () => {
  const val = input.value;
  clearBtn.classList.toggle('show', val.length > 0);
  if (val.trim() === '') {
    closeDropdown();
    latencyBadge.textContent = '';
    return;
  }
  debouncedSuggest(val);
});

input.addEventListener('keydown', (e) => {
  const open = !list.hidden;
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      if (!open && input.value.trim()) fetchSuggestions(input.value);
      else setActive(activeIndex + 1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      setActive(activeIndex - 1);
      break;
    case 'Enter':
      if (open && activeIndex >= 0 && currentSuggestions[activeIndex]) {
        input.value = currentSuggestions[activeIndex].query;
      }
      submitSearch(input.value);
      break;
    case 'Escape':
      closeDropdown();
      break;
  }
});

// Re-query when the ranking mode changes, so the user sees the difference live.
document.querySelectorAll('input[name="mode"]').forEach((r) =>
  r.addEventListener('change', () => {
    if (input.value.trim()) fetchSuggestions(input.value);
  })
);

list.addEventListener('click', (e) => {
  const li = e.target.closest('.suggestion');
  if (!li) return;
  input.value = li.dataset.query;
  submitSearch(li.dataset.query);
});

trendingList.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-query]');
  if (!li) return;
  input.value = li.dataset.query;
  submitSearch(li.dataset.query);
});

searchBtn.addEventListener('click', () => submitSearch(input.value));

clearBtn.addEventListener('click', () => {
  input.value = '';
  clearBtn.classList.remove('show');
  closeDropdown();
  latencyBadge.textContent = '';
  input.focus();
});

$('#response-close').addEventListener('click', () => (responseCard.hidden = true));
$('#trending-refresh').addEventListener('click', loadTrending);

// Close dropdown when clicking outside.
document.addEventListener('click', (e) => {
  if (!box.contains(e.target)) closeDropdown();
});

// --------------------------------------------------------------------------
// Init
// --------------------------------------------------------------------------
checkHealth();
loadTrending();
setInterval(loadTrending, 10_000); // keep trending fresh
input.focus();
