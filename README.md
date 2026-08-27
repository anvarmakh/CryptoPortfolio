# Crypto Value-Averaging Planner

Simple web app to manage a crypto portfolio using a **value averaging** strategy.

## Features

- **Plan configuration**
  - Initial target portfolio value.
  - Target increase per period (e.g. $1,000).
  - Maximum addition per step (e.g. $2,000).
  - Completed periods and total net invested.
- **Assets & allocation**
  - Per-asset allocation %.
  - Ticker symbol (resolved to a CoinGecko ID via `ticker-map.json`).
  - Units held, live USD prices, and current value.
- **Value-averaging step calculator**
  - Next target portfolio value along the VA path.
  - Theoretical change needed to reach target.
  - Capped change based on your max addition per step.
  - Per-asset suggested trades (USD and units), weighted by allocation drift.
- **History with persistence**
  - Each time you click **"Mark step applied"**:
    - Holdings are updated from the units you entered in the trades table.
    - Configuration is advanced to the next period.
    - A snapshot is sent to the backend and stored in SQLite:
      timestamp, period index, invested amount, portfolio value, P&L and P&L %.
  - History is shown in the UI (History table) and survives browser refreshes
    and device changes when deployed.
  - A **Track current state** button records a baseline snapshot before your
    first step.
- **Continuous performance chart**
  - Server records a price snapshot every 6 hours (00:00, 06:00, 12:00, 18:00 UTC).
  - Browser also records up to one snapshot per 12 hours after a manual price refresh.
  - Chart shows portfolio value, total invested, and step markers.
- **Price provider via backend proxy**
  - `CoinGecko` only (no API key required).
  - Frontend talks **only** to your backend at `/api/prices`, never directly to CoinGecko.
  - Per-id in-memory cache (60 s TTL) on the server avoids hammering the upstream.
- **Fear & Greed Index**
  - Sourced from `Alternative.me` — CoinGecko does not provide this metric.
  - Frontend talks **only** to your backend at `/api/fear-greed`, never directly to Alternative.me.
  - Server caches the value for 30 minutes since it only updates ~once/day upstream.

---

## Local development

Requirements:

- Node.js 18+ (uses native `fetch`).

Install dependencies and run:

```bash
npm install
npm start
```

Then open `http://localhost:3000` in your browser.

The app will:

- Serve `index.html`, `main.js`, `favicon.svg`, and `ticker-map.json` from the
  same Express process (`server.js`).
- Initialize a SQLite DB at `./data/portfolio.sqlite` by default.

---

## Railway deployment

1. **Create a new Railway project** — deploy from GitHub or upload this folder
   as a service. The working directory must contain `package.json`.

2. **Environment variables**

   - `PORT` — Railway injects this automatically; Express uses
     `process.env.PORT || 3000`.
   - `DB_PATH` (recommended) — e.g. `/data/portfolio.sqlite`. Lets you mount a
     persistent volume so history survives restarts.

3. **Persistent storage on Railway**

   - Add a Volume (e.g. 1 GB) and mount it at `/data`.
   - Set `DB_PATH=/data/portfolio.sqlite`.
   - Restart the service.

4. **Build & run**

   Railway detects Node from `package.json` and runs `npm install && npm start`.

   The Express server:

   - Listens on `PORT`.
   - Serves the frontend assets explicitly (no directory listing).
   - Exposes the API documented below.

---

## API

### Health

- `GET /health` — `{ status: 'ok' }` when the DB responds, `503 { status: 'degraded' }` otherwise.

### State sync

- `GET /api/state` — returns the persisted frontend state (or `null`).
- `PUT /api/state` — replaces the persisted state. Body must be a JSON object.

### Prices

- `GET /api/prices?ids=bitcoin,ethereum`

  Response (normalised CoinGecko shape):

  ```jsonc
  {
    "bitcoin":  { "usd": 63123.45 },
    "ethereum": { "usd": 3210.12 }
  }
  ```

### Fear & Greed Index

- `GET /api/fear-greed`

  Response (sourced from Alternative.me; `timestamp`/`fetchedAt` are epoch ms):

  ```jsonc
  {
    "value": 62,
    "valueClassification": "Greed",
    "timestamp": 1740441600000,
    "fetchedAt": 1740441823456
  }
  ```

### Step history (snapshots)

- `GET /api/history` — array of snapshots, most recent first.
- `POST /api/history` — body:

  ```jsonc
  {
    "createdAt": "2026-02-25T20:25:00.000Z",
    "periodIndex": 3,
    "invested": 9000,
    "portfolioValue": 9500,
    "pnl": 500,
    "pnlPercent": 5.55,
    "meta": { "step": { "...": "..." }, "holdings": [ ] }
  }
  ```

  All numeric fields are validated with `Number.isFinite`; `invested` and
  `portfolioValue` must be ≥ 0.

- `DELETE /api/history` — clears step history only.
- `DELETE /api/history/:id` — deletes a single snapshot.

### Continuous price snapshots (chart)

- `GET /api/price-snapshots` — chronological array used by the performance chart.
- `POST /api/price-snapshots` — body:

  ```jsonc
  { "createdAt": "...", "portfolioValue": 9500, "invested": 9000, "source": "browser" }
  ```

  Requests within 60 s of the previous snapshot return `429`.

- `DELETE /api/price-snapshots` — clears the chart data.

---

## How the app uses history

When you click **"Mark step applied"**:

1. The frontend reads the units delta you entered in the trades table and
   updates each asset's holdings.
2. `completedPeriods` and `investedSoFar` are advanced locally.
3. A snapshot is POSTed to `/api/history`.
4. The History table refreshes.

Even if browser data is lost, the server-side SQLite database keeps history.

---

## Notes

- `ticker-map.json` maps common ticker symbols (BTC, ETH, …) to CoinGecko IDs.
  Unknown tickers are passed through as lowercase and may not resolve.
- The frontend stores a copy of state in `localStorage` for instant first paint,
  then reconciles with the server on load.
