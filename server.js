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
`);

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

// Price proxy: supports provider=coingecko or provider=cmc
app.get('/api/prices', async (req, res) => {
  const provider = (req.query.provider || 'coingecko').toString().toLowerCase();
  const idsRaw = (req.query.ids || '').toString();
  const symbolsRaw = (req.query.symbols || '').toString();

  const ids = idsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const symbols = symbolsRaw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (!ids.length) {
    return res.status(400).json({ error: 'No asset ids provided' });
  }

  if (provider === 'coingecko') {
    try {
      const url =
        'https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=' +
        encodeURIComponent(ids.join(','));
      const response = await axios.get(url, { timeout: 10000 });
      return res.json(response.data);
    } catch (err) {
      console.error('Coingecko error', err.message);
      return res.status(502).json({ error: 'Failed to fetch prices from CoinGecko' });
    }
  }

  if (provider === 'cmc') {
    const apiKey = process.env.CMC_API_KEY;
    if (!apiKey) {
      return res
        .status(400)
        .json({ error: 'CMC_API_KEY is not configured in the environment' });
    }

    if (!symbols.length) {
      return res
        .status(400)
        .json({ error: 'symbols query parameter is required for provider=cmc' });
    }

    try {
      const url = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest';
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'X-CMC_PRO_API_KEY': apiKey,
        },
        params: {
          symbol: symbols.join(','),
          convert: 'USD',
        },
      });

      const data = response.data && response.data.data ? response.data.data : {};

      // Normalize into a CoinGecko-like shape keyed by our ids array
      const result = {};
      ids.forEach((id, idx) => {
        const symbol = symbols[idx];
        if (symbol && data[symbol] && data[symbol].quote && data[symbol].quote.USD) {
          const price = data[symbol].quote.USD.price;
          result[id] = { usd: price };
        }
      });

      return res.json(result);
    } catch (err) {
      console.error('CMC error', err.message);
      return res.status(502).json({ error: 'Failed to fetch prices from CoinMarketCap' });
    }
  }

  return res.status(400).json({ error: `Unsupported provider: ${provider}` });
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

// Optional: clear all snapshots (for manual reset)
app.delete('/api/history', (req, res) => {
  try {
    db.prepare('DELETE FROM snapshots').run();
    res.json({ ok: true });
  } catch (err) {
    console.error('DB error on DELETE /api/history', err.message);
    res.status(500).json({ error: 'Failed to clear history' });
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
});

