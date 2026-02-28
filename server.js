const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');

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
    invested REAL NOT NULL
  );
`);

// ── Ticker → CoinGecko ID (mirrored from main.js for server-side scheduling) ─
const TICKER_TO_COINGECKO_ID = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin',
  XRP: 'ripple', DOGE: 'dogecoin', ADA: 'cardano', TRX: 'tron',
  AVAX: 'avalanche-2', LINK: 'chainlink', DOT: 'polkadot',
  MATIC: 'matic-network', POL: 'matic-network', SHIB: 'shiba-inu',
  LTC: 'litecoin', UNI: 'uniswap', ATOM: 'cosmos', TON: 'the-open-network',
  OP: 'optimism', ARB: 'arbitrum', FTM: 'fantom', NEAR: 'near',
  APT: 'aptos', SUI: 'sui', INJ: 'injective-protocol', PEPE: 'pepe',
  WIF: 'dogwifcoin', BONK: 'bonk', JUP: 'jupiter-exchange-solana',
  SEI: 'sei-network', TIA: 'celestia', PYTH: 'pyth-network',
  STX: 'blockstack', IMX: 'immutable-x', RUNE: 'thorchain',
  FET: 'fetch-ai', RENDER: 'render-token', GRT: 'the-graph',
  LDO: 'lido-dao', MKR: 'maker', AAVE: 'aave', SNX: 'havven',
  CRV: 'curve-dao-token', COMP: 'compound-governance-token',
  ALGO: 'algorand', XLM: 'stellar', VET: 'vechain',
  HBAR: 'hedera-hashgraph', ICP: 'internet-computer', FIL: 'filecoin',
  SAND: 'the-sandbox', MANA: 'decentraland', AXS: 'axie-infinity',
  CHZ: 'chiliz',
};

function serverTickerToId(symbol) {
  const upper = String(symbol || '').toUpperCase().trim();
  return TICKER_TO_COINGECKO_ID[upper] || upper.toLowerCase();
}

// ── Scheduled price snapshot (runs server-side every 12 h) ───────────────────
const SNAPSHOT_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

async function recordScheduledPriceSnapshot() {
  // Skip if a snapshot already exists within the last 12 h
  const last = db
    .prepare('SELECT created_at FROM price_snapshots ORDER BY datetime(created_at) DESC LIMIT 1')
    .get();
  if (last) {
    const elapsedMs = Date.now() - new Date(last.created_at).getTime();
    if (elapsedMs < SNAPSHOT_INTERVAL_MS) {
      const hAgo = (elapsedMs / 3_600_000).toFixed(1);
      console.log(`[scheduler] Skipping — last snapshot was ${hAgo}h ago`);
      return;
    }
  }

  // Load assets + invested from persisted app state
  const stateRow = db.prepare('SELECT state_json FROM app_state WHERE id = 1').get();
  if (!stateRow) { console.log('[scheduler] No app state saved yet, skipping'); return; }

  let appState;
  try { appState = JSON.parse(stateRow.state_json); } catch { return; }

  const assets = Array.isArray(appState.assets) ? appState.assets : [];
  const invested = Number(appState.config?.investedSoFar) || 0;
  if (!assets.length) { console.log('[scheduler] No assets configured, skipping'); return; }

  // Collect unique CoinGecko IDs
  const idSet = new Set();
  assets.forEach((a) => { const id = serverTickerToId(a.symbol); if (id) idSet.add(id); });
  const ids = [...idSet];
  if (!ids.length) return;

  // Fetch current prices from CoinGecko
  const url =
    'https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=' +
    encodeURIComponent(ids.join(','));
  const { data: priceData } = await axios.get(url, { timeout: 15000 });

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
    'INSERT INTO price_snapshots (created_at, portfolio_value, invested) VALUES (?, ?, ?)'
  ).run(now, portfolioValue, invested);
  console.log(`[scheduler] Price snapshot recorded — portfolio $${portfolioValue.toFixed(2)}, invested $${invested.toFixed(2)}`);
}

app.use(cors());
app.use(express.json());

// Serve only the two frontend files; never expose server.js, package.json, or the DB.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/main.js', (_req, res) => res.sendFile(path.join(__dirname, 'main.js')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

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
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
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
    const url =
      'https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=' +
      encodeURIComponent(ids.join(','));
    const response = await axios.get(url, { timeout: 10000 });
    return res.json(response.data);
  } catch (err) {
    console.error('CoinGecko error', err.message);
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
    typeof periodIndex !== 'number' ||
    typeof invested !== 'number' ||
    typeof portfolioValue !== 'number' ||
    typeof pnl !== 'number' ||
    typeof pnlPercent !== 'number'
  ) {
    return res.status(400).json({ error: 'Invalid snapshot payload' });
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

// Optional: clear all snapshots (for manual reset) — also clears price_snapshots
app.delete('/api/history', (req, res) => {
  try {
    db.prepare('DELETE FROM snapshots').run();
    db.prepare('DELETE FROM price_snapshots').run();
    res.json({ ok: true });
  } catch (err) {
    console.error('DB error on DELETE /api/history', err.message);
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

// Price snapshots: periodic portfolio value recordings for the performance chart
app.get('/api/price-snapshots', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT id, created_at, portfolio_value, invested FROM price_snapshots ORDER BY datetime(created_at) ASC'
    ).all();
    res.json(rows);
  } catch (err) {
    console.error('DB error on GET /api/price-snapshots', err.message);
    res.status(500).json({ error: 'Failed to retrieve price snapshots' });
  }
});

app.post('/api/price-snapshots', (req, res) => {
  const { createdAt, portfolioValue, invested } = req.body || {};
  if (
    typeof createdAt !== 'string' ||
    typeof portfolioValue !== 'number' ||
    typeof invested !== 'number'
  ) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  try {
    const info = db.prepare(
      'INSERT INTO price_snapshots (created_at, portfolio_value, invested) VALUES (?, ?, ?)'
    ).run(createdAt, portfolioValue, invested);
    const row = db.prepare(
      'SELECT id, created_at, portfolio_value, invested FROM price_snapshots WHERE id = ?'
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

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Using SQLite database at ${dbPath}`);

  // Run once 30 s after startup (gives Railway/local time to settle),
  // then repeat every 12 h — fully independent of the browser being open.
  setTimeout(() => {
    recordScheduledPriceSnapshot().catch((err) =>
      console.error('[scheduler] Error on first run:', err.message)
    );
    setInterval(() => {
      recordScheduledPriceSnapshot().catch((err) =>
        console.error('[scheduler] Error:', err.message)
      );
    }, SNAPSHOT_INTERVAL_MS);
  }, 30_000);
});
