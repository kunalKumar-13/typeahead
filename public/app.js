// Frontend for the Search Typeahead system. Vanilla JS, no build step.
//
//  - debounced /suggest calls (avoids a backend hit per keystroke)
//  - AbortController cancels in-flight requests so a stale response can't
//    overwrite a fresher one (out-of-order protection)
//  - full keyboard navigation (Up / Down / Enter / Escape) with a clearly
//    highlighted active row
//  - segmented Enhanced/Basic ranking toggle (recency vs all-time count)
//  - a demo-facing "matched node · HIT/MISS" pill fed by the consistent-hash
//    routing decision returned from /suggest
//  - delayed loading state + empty + error states; trending panel; health dot

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const input = $('#search-input');
const box = $('.search-box');
const list = $('#suggestions');
const clearBtn = $('#clear-btn');
const searchBtn = $('#search-btn');
const responseCard = $('#response-card');
const responseBody = $('#response-body');
const trendingList = $('#trending-list');
const errorToast = $('#error-toast');

// route pill elements
const routePill = $('#route-pill');
const routeNode = $('#route-node');
const routeStatus = $('#route-status');
const routeLatency = $('#route-latency');

const DEBOUNCE_MS = 110;
const LOADING_DELAY_MS = 120;

let mode = 'recency';
let activeIndex = -1;
let currentSuggestions = [];
let reqSeq = 0;
let inflight = null;
let loadingTimer = null;

// --------------------------------------------------------------------------
// Networking
// --------------------------------------------------------------------------
async function fetchSuggestions(prefix) {
  const seq = ++reqSeq;
  if (inflight) inflight.abort();
  inflight = new AbortController();

  // Delayed loading state — only shows if the response is slow, so it never
  // flickers on the usual sub-millisecond responses.
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => {
    if (seq === reqSeq) showLoading();
  }, LOADING_DELAY_MS);

  const t0 = performance.now();
  try {
    const res = await fetch(
      `/suggest?q=${encodeURIComponent(prefix)}&mode=${mode}`,
      { signal: inflight.signal }
    );
    if (!res.ok) throw new Error(`suggest ${res.status}`);
    const data = await res.json();
    const ms = performance.now() - t0;
    if (seq !== reqSeq) return; // a newer request superseded this one
    clearTimeout(loadingTimer);
    updateRoutePill(data, ms);
    renderSuggestions(data.suggestions, prefix, data.source, ms);
  } catch (err) {
    if (err.name === 'AbortError') return;
    clearTimeout(loadingTimer);
    showSuggestError();
    showError('Could not fetch suggestions');
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
    loadTrending(); // reflect the new activity
  } catch {
    showError('Search request failed');
  }
}

async function loadTrending() {
  try {
    const res = await fetch('/trending');
    if (!res.ok) throw new Error();
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
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function highlightPrefix(query, prefix) {
  if (prefix && query.toLowerCase().startsWith(prefix.toLowerCase())) {
    return `<b>${escapeHtml(query.slice(0, prefix.length))}</b>${escapeHtml(
      query.slice(prefix.length)
    )}`;
  }
  return escapeHtml(query);
}

function formatCount(n) {
  if (n == null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function showLoading() {
  list.innerHTML = `<li class="suggest-loading"><span class="spinner"></span>Searching…</li>`;
  openDropdown();
}

function showSuggestError() {
  list.innerHTML = `<li class="suggest-error">⚠ Couldn’t load suggestions</li>`;
  openDropdown();
}

function renderSuggestions(suggestions, prefix, source, ms) {
  currentSuggestions = suggestions || [];
  activeIndex = -1;
  if (!currentSuggestions.length) {
    list.innerHTML = `<li class="suggest-empty">🔍 No matches for “${escapeHtml(prefix)}”</li>`;
    openDropdown();
    return;
  }
  const rows = currentSuggestions
    .map((s, i) => {
      const hot =
        s.recentScore && s.recentScore > 0.05
          ? `<span class="badge hot" title="recent activity score">🔥 ${s.recentScore.toFixed(1)}</span>`
          : '';
      return `<li class="suggestion" role="option" data-index="${i}" data-query="${escapeHtml(s.query)}">
        <span class="q">${highlightPrefix(s.query, prefix)}</span>
        <span class="meta">
          ${hot}
          <span class="badge" title="all-time search count">${formatCount(s.count)}</span>
          <span class="enter-hint">↵</span>
        </span>
      </li>`;
    })
    .join('');
  const tag = source === 'cache' ? 'tag-hit' : 'tag-miss';
  const label = source === 'cache' ? 'cache HIT' : 'store MISS';
  list.innerHTML =
    rows +
    `<li class="source-line"><span class="${tag}">${label}</span><span>${ms.toFixed(1)} ms · ${currentSuggestions.length} results</span></li>`;
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
        <span class="t-query">${escapeHtml(t.query)}</span>
        <span class="t-meta">
          <span class="badge hot" title="recency score">🔥 ${t.recentScore.toFixed(2)}</span>
          <span class="badge" title="all-time count">${formatCount(t.count)}</span>
        </span>
      </li>`
    )
    .join('');
}

function updateRoutePill(data, ms) {
  if (!data || data.source === 'empty' || !data.node) {
    routePill.className = 'route-pill idle';
    routeNode.textContent = 'no query yet';
    routeStatus.textContent = '';
    routeLatency.textContent = '';
    return;
  }
  const hit = data.source === 'cache';
  routePill.className = 'route-pill ' + (hit ? 'hit' : 'miss');
  routeNode.textContent = data.node;        // e.g. cache-node-1
  routeStatus.textContent = hit ? 'HIT' : 'MISS';
  routeLatency.textContent = `· ${ms.toFixed(1)} ms`;
}

function showResponse(data) {
  responseBody.textContent = JSON.stringify(data, null, 2);
  responseCard.hidden = false;
}

let errorTimer = null;
function showError(msg) {
  errorToast.textContent = msg;
  errorToast.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => (errorToast.hidden = true), 2600);
}

// --------------------------------------------------------------------------
// Dropdown + keyboard navigation
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
    const on = idx === activeIndex;
    el.classList.toggle('active', on);
    if (on) el.scrollIntoView({ block: 'nearest' });
  });
}

// --------------------------------------------------------------------------
// Events
// --------------------------------------------------------------------------
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
const debouncedSuggest = debounce((v) => fetchSuggestions(v), DEBOUNCE_MS);

input.addEventListener('input', () => {
  const val = input.value;
  clearBtn.classList.toggle('show', val.length > 0);
  if (val.trim() === '') {
    closeDropdown();
    updateRoutePill(null);
    return;
  }
  debouncedSuggest(val);
});

input.addEventListener('keydown', (e) => {
  const open = !list.hidden && list.querySelector('.suggestion');
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

// Segmented ranking toggle
$$('.seg').forEach((btn) =>
  btn.addEventListener('click', () => {
    if (btn.dataset.mode === mode) return;
    mode = btn.dataset.mode;
    $$('.seg').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    if (input.value.trim()) fetchSuggestions(input.value); // show the difference live
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
  updateRoutePill(null);
  input.focus();
});

$('#response-close').addEventListener('click', () => (responseCard.hidden = true));
$('#trending-refresh').addEventListener('click', loadTrending);

document.addEventListener('click', (e) => {
  if (!box.contains(e.target)) closeDropdown();
});

// --------------------------------------------------------------------------
// Init
// --------------------------------------------------------------------------
checkHealth();
loadTrending();
setInterval(loadTrending, 10_000);
input.focus();
