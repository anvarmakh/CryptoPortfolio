const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Database (SQLite via better-sqlite3)
const Database = require('better-sqlite3');

const defaultDbPath = path.join(__dirname, 'data', 'portfolio.sqlite');
const dbPath = process.env.DB_PATH || defaultDbPath;

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
`);

app.use(cors());
app.use(express.json());

// Static files (SPA)
app.use(express.static(__dirname));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
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
  const stmt = db.prepare(
    'SELECT id, created_at, period_index, invested, portfolio_value, pnl, pnl_percent, meta FROM snapshots ORDER BY datetime(created_at) DESC, id DESC'
  );
  const rows = stmt.all();
  res.json(rows);
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
});

// Optional: clear all snapshots (for manual reset)
app.delete('/api/history', (req, res) => {
  db.prepare('DELETE FROM snapshots').run();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Using SQLite database at ${dbPath}`);
});

