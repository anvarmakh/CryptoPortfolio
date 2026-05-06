const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Database (SQLite via better-sqlite3)
const Database = require('better-sqlite3');

// On Railway the code directory (/app) is read-only, but /data (or a mounted
// volume) is writable. Locally we default to ./data inside the project.
const isRailway = !!process.env.RAILWAY_ENVIRONMENT;

const localDefaultDbPath = path.join(__dirname, 'data', 'portfolio.sqlite');
const railwayDefaultDbPath = path.join('/data', 'portfolio.sqlite');

const dbPath = process.env.DB_PATH || (isRailway ? railwayDefaultDbPath : localDefaultDbPath);

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    period_index INTEGER NOT NULL,
    invested REAL NOT NULL,
    portfolio_value REAL NOT NULL,
    pnl REAL NOT NULL,
    pnl_percent REAL NOT NULL,
    meta TEXT
  );

  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    portfolio_value REAL NOT NULL,
    invested REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'browser'
  );
`);

// Migrate existing DBs that pre-date the source column
try {
  db.exec("ALTER TABLE price_snapshots ADD COLUMN source TEXT NOT NULL DEFAULT 'browser'");
} catch (err) {
  if (!/duplicate column name/i.test(err.message)) throw err;
}

// ── Ticker → CoinGecko ID (single source of truth in ticker-map.json) ────────
const TICKER_TO_COINGECKO_ID = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'ticker-map.json'), 'utf-8')
);

function serverTickerToId(symbol) {
  const upper = String(symbol || '').toUpperCase().trim();
  return TICKER_TO_COINGECKO_ID[upper] || upper.toLowerCase();
}

// ── In-memory price cache, keyed per-id so a request for {BTC} doesn't ───────
// invalidate cached ETH/SOL prices.
const PRICE_CACHE_TTL_MS = 60 * 1000; // 1 minute
const priceCache = new Map(); // id -> { usd, fetchedAt }

async function fetchFromCoinGecko(ids, maxAttempts) {
  const url =
    'https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=' +
    encodeURIComponent(ids.join(','));

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      if (!resp.ok) {
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        err.headers = resp.headers;
        throw err;
      }
      return await resp.json();
    } catch (err) {
      lastError = err;
      const status = err.status;
      if (status === 429) {
        const retryAfter = parseInt(err.headers?.get?.('retry-after') || '0', 10);
        const waitMs = (retryAfter > 0 ? retryAfter : 60 * attempt) * 1000;
        console.warn(
          `[coingecko] 429 Rate limited — waiting ${waitMs / 1000}s before attempt ${attempt + 1}/${maxAttempts}`
        );
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, waitMs));
      } else {
        console.warn(
          `[coingecko] Attempt ${attempt}/${maxAttempts} failed (${err.message})`
        );
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 5000 * attempt));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError;
}

/**
 * Fetch prices from CoinGecko with per-id caching. Only stale ids hit the API.
 *
 * @param {string[]} ids  CoinGecko coin IDs to fetch
 * @param {number}   maxAttempts
 * @returns {Promise<object>}  Normalised `{ id: { usd: number } }` map
 */
async function fetchCoinGeckoPrices(ids, maxAttempts = 4) {
  const now = Date.now();
  const stale = ids.filter((id) => {
    const e = priceCache.get(id);
    return !e || (now - e.fetchedAt) >= PRICE_CACHE_TTL_MS;
  });

  if (stale.length) {
    const fresh = await fetchFromCoinGecko(stale, maxAttempts);
    if (fresh && typeof fresh === 'object') {
      for (const id of Object.keys(fresh)) {
        const v = fresh[id]?.usd;
        if (typeof v === 'number' && Number.isFinite(v)) {
          priceCache.set(id, { usd: v, fetchedAt: now });
        }
      }
    }
  }

  const result = {};
  for (const id of ids) {
    const e = priceCache.get(id);
    if (e) result[id] = { usd: e.usd };
  }
  return result;
}

// ── Scheduled price snapshot (runs server-side at 00:00, 06:00, 12:00, 18:00 UTC) ─
const SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
// If any snapshot (browser or server) lands within this window of a scheduled
// fire, skip the scheduled one to avoid clustering near-duplicate rows.
const SCHEDULER_CLUSTER_SUPPRESS_MS = 30 * 60 * 1000; // 30 minutes

let _schedulerRunning = false;

async function recordScheduledPriceSnapshot() {
  // Mutex: prevent overlapping runs (e.g. startup catch-up firing while the
  // aligned timer also fires).
  if (_schedulerRunning) {
    console.log('[scheduler] Already running, skipping duplicate invocation');
    return;
  }
  _schedulerRunning = true;
  try {
    // Independent 6h cadence: only count server-source rows so the safety net
    // keeps firing regardless of user activity.
    const lastServer = db
      .prepare("SELECT created_at FROM price_snapshots WHERE source = 'server' ORDER BY id DESC LIMIT 1")
      .get();
    if (lastServer) {
      const elapsedMs = Date.now() - new Date(lastServer.created_at).getTime();
      if (elapsedMs < SNAPSHOT_INTERVAL_MS) {
        const hAgo = (elapsedMs / 3_600_000).toFixed(1);
        console.log(`[scheduler] Skipping — last server snapshot was ${hAgo}h ago`);
        return;
      }
    }

    // Cluster suppression: if any snapshot (any source) is very recent, skip.
    // A browser-recorded snapshot from a few minutes ago carries the same data,
    // so a second row would just be noise on the chart.
    const lastAny = db
      .prepare("SELECT created_at, source FROM price_snapshots ORDER BY id DESC LIMIT 1")
      .get();
    if (lastAny) {
      const elapsedMs = Date.now() - new Date(lastAny.created_at).getTime();
      if (elapsedMs < SCHEDULER_CLUSTER_SUPPRESS_MS) {
        const mAgo = (elapsedMs / 60_000).toFixed(1);
        console.log(`[scheduler] Skipping — ${lastAny.source} snapshot recorded ${mAgo}m ago`);
        return;
      }
    }

    // Load assets + invested from persisted app state
    const stateRow = db.prepare('SELECT state_json FROM app_state WHERE id = 1').get();
    if (!stateRow) { console.log('[scheduler] No app state saved yet, skipping'); return; }

    let appState;
    try {
      appState = JSON.parse(stateRow.state_json);
    } catch (e) {
      console.error('[scheduler] Failed to parse app_state JSON', e.message);
      return;
    }

    const assets = Array.isArray(appState.assets) ? appState.assets : [];
    const invested = Number(appState.config?.investedSoFar) || 0;
    if (!assets.length) { console.log('[scheduler] No assets configured, skipping'); return; }

    // Collect unique CoinGecko IDs
    const idSet = new Set();
    assets.forEach((a) => { const id = serverTickerToId(a.symbol); if (id) idSet.add(id); });
    const ids = [...idSet];
    if (!ids.length) return;

    // Fetch current prices from CoinGecko (with retry + rate-limit handling)
    let priceData;
    try {
      priceData = await fetchCoinGeckoPrices(ids);
    } catch (e) {
      console.error(`[scheduler] CoinGecko fetch failed after all retries: ${e.message}`);
      return;
    }

    if (!priceData || typeof priceData !== 'object' || !Object.keys(priceData).length) {
      console.error('[scheduler] CoinGecko returned no usable prices, skipping snapshot');
      return;
    }

    // Compute portfolio value
    let portfolioValue = 0;
    for (const a of assets) {
      const price = priceData[serverTickerToId(a.symbol)]?.usd;
      const units = Number(a.units) || 0;
      if (price && units) portfolioValue += price * units;
    }

    if (portfolioValue <= 0) {
      console.log('[scheduler] Portfolio value is $0 — no prices resolved, skipping');
      return;
    }

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO price_snapshots (created_at, portfolio_value, invested, source) VALUES (?, ?, ?, 'server')"
    ).run(now, portfolioValue, invested);
    console.log(`[scheduler] Price snapshot recorded — portfolio $${portfolioValue.toFixed(2)}, invested $${invested.toFixed(2)}`);
  } finally {
    _schedulerRunning = false;
  }
}

app.use(cors());
app.use(express.json());

// Serve only the frontend files; never expose server.js, package.json, or the DB.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/main.js', (_req, res) => res.sendFile(path.join(__dirname, 'main.js')));
app.get('/favicon.svg', (_req, res) => res.sendFile(path.join(__dirname, 'favicon.svg')));
app.get('/ticker-map.json', (_req, res) => res.sendFile(path.join(__dirname, 'ticker-map.json')));

app.get('/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Health check DB failure:', err.message);
    res.status(503).json({ status: 'degraded', error: 'database unavailable' });
  }
});

// ── Validation helpers ───────────────────────────────────────────────────────
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function isFiniteNonNegative(v) {
  return isFiniteNumber(v) && v >= 0;
}
function isValidStateShape(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj.config != null && (typeof obj.config !== 'object' || Array.isArray(obj.config))) return false;
  if (obj.assets != null && !Array.isArray(obj.assets)) return false;
  return true;
}

// App state: persist the full frontend state server-side so it survives
// across different devices and browsers.
app.get('/api/state', (req, res) => {
  try {
    const row = db.prepare('SELECT state_json FROM app_state WHERE id = 1').get();
    if (!row) return res.json(null);
    res.json(JSON.parse(row.state_json));
  } catch (err) {
    console.error('DB error on GET /api/state', err.message);
    res.status(500).json({ error: 'Failed to retrieve state' });
  }
});

app.put('/api/state', (req, res) => {
  const body = req.body;
  if (!isValidStateShape(body)) {
    return res.status(400).json({ error: 'Invalid state payload' });
  }
  try {
    const stateJson = JSON.stringify(body);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO app_state (id, state_json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
    `).run(stateJson, now);
    res.json({ ok: true });
  } catch (err) {
    console.error('DB error on PUT /api/state', err.message);
    res.status(500).json({ error: 'Failed to save state' });
  }
});

// Price proxy: CoinGecko only
app.get('/api/prices', async (req, res) => {
  const idsRaw = (req.query.ids || '').toString();

  const ids = idsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!ids.length) {
    return res.status(400).json({ error: 'No asset ids provided' });
  }

  try {
    const data = await fetchCoinGeckoPrices(ids);
    return res.json(data);
  } catch (err) {
    console.error('CoinGecko error', err.message);
    if (err.status === 429) {
      return res.status(429).json({ error: 'CoinGecko rate limit exceeded — please retry shortly' });
    }
    return res.status(502).json({ error: 'Failed to fetch prices from CoinGecko' });
  }
});

// History: get all snapshots (most recent first)
app.get('/api/history', (req, res) => {
  try {
    const stmt = db.prepare(
      'SELECT id, created_at, period_index, invested, portfolio_value, pnl, pnl_percent, meta FROM snapshots ORDER BY datetime(created_at) DESC, id DESC'
    );
    const rows = stmt.all();
    res.json(rows);
  } catch (err) {
    console.error('DB error on GET /api/history', err.message);
    res.status(500).json({ error: 'Failed to retrieve history' });
  }
});

// Create a snapshot
app.post('/api/history', (req, res) => {
  const {
    createdAt,
    periodIndex,
    invested,
    portfolioValue,
    pnl,
    pnlPercent,
    meta,
  } = req.body || {};

  if (
    typeof createdAt !== 'string' ||
    !createdAt.length ||
    !Number.isInteger(periodIndex) || periodIndex < 0 ||
    !isFiniteNonNegative(invested) ||
    !isFiniteNonNegative(portfolioValue) ||
    !isFiniteNumber(pnl) ||
    !isFiniteNumber(pnlPercent)
  ) {
    return res.status(400).json({ error: 'Invalid snapshot payload' });
  }
  if (Number.isNaN(Date.parse(createdAt))) {
    return res.status(400).json({ error: 'createdAt is not a valid ISO timestamp' });
  }

  try {
    const stmt = db.prepare(
      `INSERT INTO snapshots (created_at, period_index, invested, portfolio_value, pnl, pnl_percent, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    const info = stmt.run(
      createdAt,
      periodIndex,
      invested,
      portfolioValue,
      pnl,
      pnlPercent,
      meta ? JSON.stringify(meta) : null
    );

    const row = db
      .prepare(
        'SELECT id, created_at, period_index, invested, portfolio_value, pnl, pnl_percent, meta FROM snapshots WHERE id = ?'
      )
      .get(info.lastInsertRowid);

    res.status(201).json(row);
  } catch (err) {
    console.error('DB error on POST /api/history', err.message);
    res.status(500).json({ error: 'Failed to save snapshot' });
  }
});

// Clear step-history snapshots only. To wipe the continuous performance chart,
// call DELETE /api/price-snapshots separately.
app.delete('/api/history', (_req, res) => {
  try {
    db.prepare('DELETE FROM snapshots').run();
    res.json({ ok: true });
  } catch (err) {
    console.error('DB error on DELETE /api/history', err.message);
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

app.delete('/api/price-snapshots', (_req, res) => {
  try {
    db.prepare('DELETE FROM price_snapshots').run();
    res.json({ ok: true });
  } catch (err) {
    console.error('DB error on DELETE /api/price-snapshots', err.message);
    res.status(500).json({ error: 'Failed to clear price snapshots' });
  }
});

// Price snapshots: periodic portfolio value recordings for the performance chart
app.get('/api/price-snapshots', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT id, created_at, portfolio_value, invested, source FROM price_snapshots ORDER BY datetime(created_at) ASC'
    ).all();
    res.json(rows);
  } catch (err) {
    console.error('DB error on GET /api/price-snapshots', err.message);
    res.status(500).json({ error: 'Failed to retrieve price snapshots' });
  }
});

// Minimum gap between any two price snapshots, regardless of source.
// Guards against two browser tabs (or scheduler + browser) inserting at once.
const PRICE_SNAPSHOT_MIN_GAP_MS = 60_000;

app.post('/api/price-snapshots', (req, res) => {
  const { portfolioValue, invested } = req.body || {};
  if (
    !isFiniteNonNegative(portfolioValue) ||
    !isFiniteNonNegative(invested)
  ) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  try {
    // Order by id (monotonic) instead of datetime(created_at) so that a skewed
    // client clock — back when this endpoint trusted client createdAt — cannot
    // hide a recent row from the gap check.
    const last = db
      .prepare('SELECT created_at FROM price_snapshots ORDER BY id DESC LIMIT 1')
      .get();
    if (last && Date.now() - new Date(last.created_at).getTime() < PRICE_SNAPSHOT_MIN_GAP_MS) {
      return res.status(429).json({ error: 'Snapshot too soon after previous one' });
    }
    // Always stamp server-side so ordering is consistent across clients.
    const createdAt = new Date().toISOString();
    const info = db.prepare(
      "INSERT INTO price_snapshots (created_at, portfolio_value, invested, source) VALUES (?, ?, ?, 'browser')"
    ).run(createdAt, portfolioValue, invested);
    const row = db.prepare(
      'SELECT id, created_at, portfolio_value, invested, source FROM price_snapshots WHERE id = ?'
    ).get(info.lastInsertRowid);
    res.status(201).json(row);
  } catch (err) {
    console.error('DB error on POST /api/price-snapshots', err.message);
    res.status(500).json({ error: 'Failed to save price snapshot' });
  }
});

// Delete a single snapshot by id
app.delete('/api/history/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  try {
    const result = db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'Record not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DB error on DELETE /api/history/:id', err.message);
    res.status(500).json({ error: 'Failed to delete record' });
  }
});

// Schedule a one-shot timeout aligned to the next 6-hour UTC boundary
// (00:00, 06:00, 12:00, 18:00), then reschedule itself after each run.
function scheduleNextSnapshot() {
  const nowMs = Date.now();
  const nextWindowMs = (Math.floor(nowMs / SNAPSHOT_INTERVAL_MS) + 1) * SNAPSHOT_INTERVAL_MS;
  const delay = nextWindowMs - nowMs;
  console.log(`[scheduler] Next snapshot at ${new Date(nextWindowMs).toISOString()} (in ${(delay / 3_600_000).toFixed(2)}h)`);
  setTimeout(() => {
    recordScheduledPriceSnapshot()
      .catch((err) => console.error('[scheduler] Error:', err.message))
      .finally(scheduleNextSnapshot);
  }, delay);
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Using SQLite database at ${dbPath}`);

  // Catch-up run 30 s after startup in case a window was missed while the server was down.
  setTimeout(() => {
    recordScheduledPriceSnapshot().catch((err) =>
      console.error('[scheduler] Error on startup run:', err.message)
    );
  }, 30_000);

  // Align future runs to fixed UTC windows: 00:00, 06:00, 12:00, 18:00.
  scheduleNextSnapshot();
});
