// Primary data store: SQLite via Node's built-in `node:sqlite` (no native deps).
//
// The `queries` table is the durable source of truth for query counts and the
// persisted recency state. The in-memory Trie (trie.js) is rebuilt from this
// table at startup and is what actually serves suggestions at request time; the
// DB is the system of record that the batch writer flushes into.
//
// Every DB operation bumps a metrics counter so we can report read/write counts
// and demonstrate the write-reduction effect of batching.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { config } from './config.js';
import { metrics } from './metrics.js';

let db = null;

export function initDb() {
  fs.mkdirSync(config.paths.data, { recursive: true });
  db = new DatabaseSync(config.paths.db);
  // WAL gives better read/write concurrency; NORMAL sync is a good
  // durability/throughput trade-off for this workload.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS queries (
      query        TEXT PRIMARY KEY,
      count        INTEGER NOT NULL DEFAULT 0,
      recent_score REAL    NOT NULL DEFAULT 0,
      recent_ts    INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Index supports the SQL fallback path (prefix scan ordered by count).
  db.exec('CREATE INDEX IF NOT EXISTS idx_queries_count ON queries(count DESC);');
  return db;
}

export function getDb() {
  if (!db) throw new Error('DB not initialised — call initDb() first');
  return db;
}

function runInTransaction(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const result = fn(d);
    d.exec('COMMIT');
    return result;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

// Bulk insert used by the dataset loader. `rows` = [{query, count}].
export function bulkInsert(rows, now = Date.now()) {
  const d = getDb();
  const stmt = d.prepare(
    `INSERT INTO queries (query, count, recent_score, recent_ts, updated_at)
     VALUES (?, ?, 0, 0, ?)
     ON CONFLICT(query) DO UPDATE SET count = excluded.count`
  );
  let written = 0;
  runInTransaction(() => {
    for (const r of rows) {
      stmt.run(r.query, r.count, now);
      written++;
    }
  });
  metrics.db.writes += 1; // one batched write op
  metrics.db.rowsWritten += written;
  return written;
}

// Bulk read of the entire table to build the in-memory Trie at startup.
// Counts as a single (large) read operation.
export function loadAllForIndex() {
  const d = getDb();
  const rows = d
    .prepare('SELECT query, count, recent_score, recent_ts FROM queries')
    .all();
  metrics.db.reads += 1;
  return rows;
}

// Apply one aggregated batch from the batch writer.
// `entries` = [{ query, countDelta, recentScore, recentTs }].
// Upserts counts (+= delta) and overwrites the persisted recency state.
// This is the ONLY hot write path; it is invoked once per flush, not per search.
export function applyBatch(entries, now = Date.now()) {
  if (entries.length === 0) return 0;
  const d = getDb();
  const stmt = d.prepare(
    `INSERT INTO queries (query, count, recent_score, recent_ts, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(query) DO UPDATE SET
       count        = count + excluded.count,
       recent_score = excluded.recent_score,
       recent_ts    = excluded.recent_ts,
       updated_at   = excluded.updated_at`
  );
  let written = 0;
  runInTransaction(() => {
    for (const e of entries) {
      stmt.run(e.query, e.countDelta, e.recentScore, e.recentTs, now);
      written++;
    }
  });
  metrics.db.writes += 1; // one transaction == one logical write op
  metrics.db.rowsWritten += written;
  metrics.db.batches += 1;
  return written;
}

// SQL fallback for suggestions (used only if the Trie is unavailable).
export function prefixSearchSql(prefix, limit) {
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT query, count FROM queries
       WHERE query LIKE ? ESCAPE '\\'
       ORDER BY count DESC
       LIMIT ?`
    )
    .all(escapeLike(prefix) + '%', limit);
  metrics.db.reads += 1;
  return rows;
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

export function totalRows() {
  const d = getDb();
  const row = d.prepare('SELECT COUNT(*) AS n FROM queries').get();
  metrics.db.reads += 1;
  return row.n;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
