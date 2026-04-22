// Simple value-averaging planner for crypto portfolio
// All state is stored in localStorage so it survives refreshes.

const STORAGE_KEY = 'crypto_value_averaging_state_v1';

const defaultState = {
  config: {
    initialValue: 0,
    stepPerPeriod: 1000,
    maxAddition: 2000,
    completedPeriods: 0,
    investedSoFar: 0,
    // Efficiency tuning — default values preserve prior behavior (off).
    // See README / settings UI for semantics.
    minTradeSize: 10,         // USD: skip trades with |Δ$| below this
    rebalanceAbsBand: 0,      // pp: drift |Δ%| within this is "in band"
    rebalanceRelBand: 0,      // %: relative to target, combined via max()
    noSellMode: false,        // suppress sells on non-withdraw steps
    // Counter-cyclical amplifier: scales the theoretical step by how far
    // current value is from the period target measured in units of recent
    // portfolio volatility (30-day rolling σ). Below-trend → larger step,
    // above-trend → smaller step. Clamped to [0.5×, 2×].
    zAmplifierEnabled: false,
    zAmplifierK: 0.5,         // sensitivity: 0 = off, typical 0.25–1.0
    // Micro-stepping: display-only hint to split the period's trades into N
    // smaller executions spread over the period. Reduces point-in-time risk.
    microSteps: 1,
  },
  assets: [
    {
      symbol: 'BTC',
      allocation: 60,
      units: 0,
      price: 0,
    },
    {
      symbol: 'ETH',
      allocation: 40,
      units: 0,
      price: 0,
    },
  ],
  lastPricesFetch: null,
};

let state = loadState();

// Whether at least one history snapshot exists — controls units-column lock.
let _hasHistory = false;

// Latest history rows (step snapshots), used by chart/analytics/export.
let _historyRows = [];

// Periodic price snapshots for the continuous performance chart.
let _priceSnapshots = [];

// Chart resolution filter: '7d' | '30d' | '90d' | 'all'
let _chartResolution = '7d';

// Suspend chart renders during initial parallel fetches so we only render once,
// after both history and price snapshots have loaded.
let _suspendChartRender = false;

// Chart.js instance (reused; data updated in-place).
let _chartInstance = null;

// ── Ticker → CoinGecko ID mapping (fetched from server at init) ──────────────
let TICKER_TO_COINGECKO_ID = {};

async function fetchTickerMap() {
  try {
    const res = await fetch('/ticker-map.json');
    if (res.ok) TICKER_TO_COINGECKO_ID = await res.json();
  } catch (e) {
    console.warn('Failed to fetch ticker map from server', e);
  }
}

function tickerToId(symbol) {
  const upper = String(symbol || '').toUpperCase().trim();
  return TICKER_TO_COINGECKO_ID[upper] || upper.toLowerCase();
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(defaultState);
    const parsed = JSON.parse(raw);
    // Normalise assets: drop legacy `id` field from display-perspective,
    // keep it in memory for backward compat; it will be re-derived on price fetch.
    const assets = Array.isArray(parsed.assets) && parsed.assets.length
      ? parsed.assets
      : structuredClone(defaultState.assets);
    return {
      ...structuredClone(defaultState),
      ...parsed,
      config: { ...structuredClone(defaultState.config), ...(parsed.config || {}) },
      assets,
    };
  } catch (e) {
    console.error('Failed to load state, using defaults', e);
    return structuredClone(defaultState);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save state', e);
  }
  scheduleServerSync();
}

// ── Server-side state sync ────────────────────────────────────────────────────
let _serverSyncTimer = null;

function scheduleServerSync() {
  clearTimeout(_serverSyncTimer);
  _serverSyncTimer = setTimeout(syncStateToServer, 500);
}

async function syncStateToServer() {
  try {
    await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
  } catch (e) {
    console.error('Failed to sync state to server', e);
  }
}

function formatUSD(value) {
  if (!Number.isFinite(value)) return '$0';
  const opts = {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
  };
  return new Intl.NumberFormat('en-US', opts).format(value);
}

function escapeAttr(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '0%';
  return `${value.toFixed(2)}%`;
}

function getElements() {
  return {
    // Header
    lastUpdated: document.getElementById('lastUpdated'),

    // Stat cards
    heroPeriod: document.getElementById('heroPeriod'),
    heroDirectionBadge: document.getElementById('heroDirectionBadge'),
    heroAmount: document.getElementById('heroAmount'),
    statPortfolioValue: document.getElementById('statPortfolioValue'),
    statInvested: document.getElementById('statInvested'),
    statPnL: document.getElementById('statPnL'),
    statPnLPct: document.getElementById('statPnLPct'),

    // Config inputs
    initialValueInput: document.getElementById('initialValueInput'),
    stepInput: document.getElementById('stepInput'),
    maxAdditionInput: document.getElementById('maxAdditionInput'),
    completedPeriodsInput: document.getElementById('completedPeriodsInput'),
    investedSoFarInput: document.getElementById('investedSoFarInput'),
    minTradeSizeInput: document.getElementById('minTradeSizeInput'),
    rebalanceAbsBandInput: document.getElementById('rebalanceAbsBandInput'),
    rebalanceRelBandInput: document.getElementById('rebalanceRelBandInput'),
    noSellModeInput: document.getElementById('noSellModeInput'),
    zAmplifierModeInput: document.getElementById('zAmplifierModeInput'),
    zAmplifierKInput: document.getElementById('zAmplifierKInput'),
    microStepsInput: document.getElementById('microStepsInput'),

    // Amplifier status line in step summary
    stepAmplifierLine: document.getElementById('stepAmplifierLine'),

    // Assets table
    assetsTableBody: document.getElementById('assetsTableBody'),
    allocationTotal: document.getElementById('allocationTotal'),

    // Trades panel
    tradesEmpty: document.getElementById('tradesEmpty'),
    tradesContent: document.getElementById('tradesContent'),
    tradesTableBody: document.getElementById('tradesTableBody'),
    stepCurrentValue: document.getElementById('stepCurrentValue'),
    stepTargetValue: document.getElementById('stepTargetValue'),
    stepEffectiveTarget: document.getElementById('stepEffectiveTarget'),
    stepCapNote: document.getElementById('stepCapNote'),
    stepFilterNote: document.getElementById('stepFilterNote'),
    stepEstimatedInvested: document.getElementById('stepEstimatedInvested'),
    stepEstimatedBreakdown: document.getElementById('stepEstimatedBreakdown'),
    stepTotalLabel: document.getElementById('stepTotalLabel'),
    stepTotalSuggested: document.getElementById('stepTotalSuggested'),

    // Step error
    stepError: document.getElementById('stepError'),
    pricesFetchStatus: document.getElementById('pricesFetchStatus'),

    // History
    historyTableBody: document.getElementById('historyTableBody'),
    historyError: document.getElementById('historyError'),

    // Buttons & controls
    saveConfigBtn: document.getElementById('saveConfigBtn'),
    addAssetBtn: document.getElementById('addAssetBtn'),
    refreshPricesBtn: document.getElementById('refreshPricesBtn'),
    applyStepBtn: document.getElementById('applyStepBtn'),
    trackCurrentStateBtn: document.getElementById('trackCurrentStateBtn'),
    stepHint: document.getElementById('stepHint'),
    trackHint: document.getElementById('trackHint'),
    resetAllBtn: document.getElementById('resetAllBtn'),
  };
}

const els = getElements();

function syncConfigInputsFromState() {
  const { config } = state;
  els.initialValueInput.value = config.initialValue || '';
  els.stepInput.value = config.stepPerPeriod || '';
  els.maxAdditionInput.value = config.maxAddition || '';
  els.completedPeriodsInput.value = config.completedPeriods || '';
  els.investedSoFarInput.value = config.investedSoFar || '';
  if (els.minTradeSizeInput) {
    els.minTradeSizeInput.value = config.minTradeSize != null ? config.minTradeSize : '';
  }
  if (els.rebalanceAbsBandInput) {
    els.rebalanceAbsBandInput.value =
      config.rebalanceAbsBand != null ? config.rebalanceAbsBand : '';
  }
  if (els.rebalanceRelBandInput) {
    els.rebalanceRelBandInput.value =
      config.rebalanceRelBand != null ? config.rebalanceRelBand : '';
  }
  if (els.noSellModeInput) {
    els.noSellModeInput.value = config.noSellMode ? 'on' : 'off';
  }
  if (els.zAmplifierModeInput) {
    els.zAmplifierModeInput.value = config.zAmplifierEnabled ? 'on' : 'off';
  }
  if (els.zAmplifierKInput) {
    els.zAmplifierKInput.value = config.zAmplifierK != null ? config.zAmplifierK : '';
  }
  if (els.microStepsInput) {
    els.microStepsInput.value = config.microSteps != null ? config.microSteps : 1;
  }
}

function syncStateFromConfigInputs() {
  const cfg = state.config;
  cfg.initialValue = Math.max(0, Number(els.initialValueInput.value) || 0);
  cfg.stepPerPeriod = Math.max(0, Number(els.stepInput.value) || 0);
  cfg.maxAddition = Math.max(0, Number(els.maxAdditionInput.value) || 0);
  cfg.completedPeriods = Math.max(0, Math.floor(Number(els.completedPeriodsInput.value) || 0));
  const manualInvested = els.investedSoFarInput.value;
  if (manualInvested !== '') {
    cfg.investedSoFar = Math.max(0, Number(manualInvested) || 0);
  }
  if (els.minTradeSizeInput) {
    cfg.minTradeSize = Math.max(0, Number(els.minTradeSizeInput.value) || 0);
  }
  if (els.rebalanceAbsBandInput) {
    cfg.rebalanceAbsBand = Math.max(0, Number(els.rebalanceAbsBandInput.value) || 0);
  }
  if (els.rebalanceRelBandInput) {
    cfg.rebalanceRelBand = Math.max(0, Number(els.rebalanceRelBandInput.value) || 0);
  }
  if (els.noSellModeInput) {
    cfg.noSellMode = els.noSellModeInput.value === 'on';
  }
  if (els.zAmplifierModeInput) {
    cfg.zAmplifierEnabled = els.zAmplifierModeInput.value === 'on';
  }
  if (els.zAmplifierKInput) {
    const raw = Number(els.zAmplifierKInput.value);
    cfg.zAmplifierK = Number.isFinite(raw) && raw >= 0 ? raw : 0.5;
  }
  if (els.microStepsInput) {
    const raw = Math.floor(Number(els.microStepsInput.value) || 1);
    cfg.microSteps = Math.max(1, Math.min(10, raw));
  }
}

function renderAssetsTable() {
  els.assetsTableBody.innerHTML = '';
  const fragment = document.createDocumentFragment();

  const totalPortfolioValue = computePortfolioValue();
  const unitsLocked = _hasHistory;

  state.assets.forEach((asset, index) => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/60';

    const currentAssetValue = (Number(asset.price) || 0) * (Number(asset.units) || 0);
    const targetPct = Number(asset.allocation) || 0;

    let currentPctCell = '<td class="py-2 px-2 text-right text-slate-500 whitespace-nowrap">–</td>';
    if (totalPortfolioValue > 0 && currentAssetValue > 0) {
      const currentPct = (currentAssetValue / totalPortfolioValue) * 100;
      const drift = Math.abs(currentPct - targetPct);
      const color = drift <= 1 ? 'text-emerald-300' : drift <= 5 ? 'text-amber-300' : 'text-rose-300';
      const driftSign = currentPct >= targetPct ? '+' : '';
      const driftStr = `${driftSign}${(currentPct - targetPct).toFixed(1)}%`;
      currentPctCell = `<td class="py-2 px-2 text-right whitespace-nowrap">
        <span class="${color} font-medium">${currentPct.toFixed(1)}%</span>
        <span class="text-[10px] text-slate-500 ml-1">${driftStr}</span>
      </td>`;
    }

    // Ticker: locked (plain text, no border) once a symbol has been entered
    const tickerLocked = !!asset.symbol;
    const tickerCell = tickerLocked
      ? `<td class="py-2 pr-2 whitespace-nowrap">
           <span class="text-xs font-medium text-slate-100 px-1">${escapeHtml(asset.symbol)}</span>
         </td>`
      : `<td class="py-2 pr-2 whitespace-nowrap">
           <input data-index="${index}" data-field="symbol" type="text"
                  class="w-20 md:w-24 rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/70 focus:border-emerald-400"
                  value="" placeholder="BTC" />
         </td>`;

    // Units: editable only before history; afterwards shown as plain 4dp text
    const unitsNum = Number(asset.units) || 0;
    const unitsDisplay = unitsNum ? unitsNum.toFixed(4) : '–';
    const unitsCell = unitsLocked
      ? `<td class="py-2 px-2 text-right text-slate-400 text-xs whitespace-nowrap hidden sm:table-cell cursor-help" title="Units are locked after the first snapshot. Use &quot;Mark step applied&quot; to update holdings.">${unitsDisplay}</td>`
      : `<td class="py-2 px-2 text-right whitespace-nowrap hidden sm:table-cell">
           <input data-index="${index}" data-field="units" type="number" step="0.00000001"
                  class="number-input w-24 rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1 text-xs text-right text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/70 focus:border-emerald-400"
                  value="${escapeAttr(asset.units ?? '')}" />
         </td>`;

    tr.innerHTML = `
      ${tickerCell}
      <td class="py-2 px-2 text-right whitespace-nowrap">
        <input data-index="${index}" data-field="allocation" type="number" step="0.1"
               class="number-input w-20 rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1 text-xs text-right text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/70 focus:border-emerald-400"
               value="${escapeAttr(asset.allocation ?? '')}" />
      </td>
      ${unitsCell}
      <td class="py-2 px-2 text-right whitespace-nowrap ${asset.price ? 'text-slate-200' : (state.lastPricesFetch ? 'text-amber-400' : 'text-slate-500')}">
        ${asset.price
          ? formatUSD(asset.price)
          : (state.lastPricesFetch ? '⚠ no price' : '–')}
      </td>
      <td class="py-2 px-2 text-right text-slate-200 whitespace-nowrap">
        ${asset.price && asset.units ? formatUSD(asset.price * asset.units) : '–'}
      </td>
      ${currentPctCell}
      <td class="py-2 pl-2 text-right whitespace-nowrap">
        <button data-index="${index}" data-action="remove-asset"
                class="text-[11px] px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:border-rose-500 hover:text-rose-300 transition-colors">
          ✕
        </button>
      </td>
    `;

    fragment.appendChild(tr);
  });

  els.assetsTableBody.appendChild(fragment);

  // Update allocation total
  const totalAllocation = state.assets.reduce((sum, a) => sum + (Number(a.allocation) || 0), 0);
  els.allocationTotal.textContent = `${totalAllocation.toFixed(1)}%`;
  els.allocationTotal.className =
    'text-xs font-semibold ' +
    (Math.abs(totalAllocation - 100) < 0.01 ? 'text-emerald-300' : 'text-amber-300');
}

function computePortfolioValue() {
  return state.assets.reduce((sum, a) => {
    const units = Number(a.units) || 0;
    const price = Number(a.price) || 0;
    return sum + units * price;
  }, 0);
}

function computePnL() {
  const currentValue = computePortfolioValue();
  const invested = state.config.investedSoFar || 0;
  const pnl = currentValue - invested;
  const pnlPct = invested !== 0 ? (pnl / invested) * 100 : 0;
  return { currentValue, invested, pnl, pnlPct };
}

function renderSummaryAndNextStep() {
  const { currentValue, invested, pnl, pnlPct } = computePnL();

  // ── Card 1: Recommended action ─────────────────────────────────
  const details = computeStepDetails();
  const trades = computePerAssetTrades(details);
  const stepKind = classifyStepKind(details, trades);
  const { cappedChange, nextPeriodIndex } = details;

  els.heroPeriod.textContent = String(nextPeriodIndex);

  if (stepKind === 'Invest') {
    els.heroDirectionBadge.textContent = '↑ Invest';
    els.heroDirectionBadge.className = 'text-xs sm:text-sm font-bold text-emerald-300';
    els.heroAmount.textContent = formatUSD(cappedChange);
    els.heroAmount.className = 'text-sm sm:text-xl font-bold tracking-tight text-emerald-300 mt-0.5';
  } else if (stepKind === 'Withdraw') {
    els.heroDirectionBadge.textContent = '↓ Withdraw';
    els.heroDirectionBadge.className = 'text-xs sm:text-sm font-bold text-rose-300';
    els.heroAmount.textContent = formatUSD(Math.abs(cappedChange));
    els.heroAmount.className = 'text-sm sm:text-xl font-bold tracking-tight text-rose-300 mt-0.5';
  } else if (stepKind === 'Rebalance') {
    const turnover = trades.reduce((s, t) => s + Math.max(t.suggestedValue, 0), 0);
    els.heroDirectionBadge.textContent = '↻ Rebalance';
    els.heroDirectionBadge.className = 'text-xs sm:text-sm font-bold text-sky-300';
    els.heroAmount.textContent = formatUSD(turnover);
    els.heroAmount.className = 'text-sm sm:text-xl font-bold tracking-tight text-sky-300 mt-0.5';
  } else {
    els.heroDirectionBadge.textContent = '— Hold';
    els.heroDirectionBadge.className = 'text-xs sm:text-sm font-bold text-slate-400';
    els.heroAmount.textContent = 'On target';
    els.heroAmount.className = 'text-sm sm:text-xl font-semibold tracking-tight text-slate-400 mt-0.5';
  }

  // ── Card 2: Portfolio + Invested ───────────────────────────────
  els.statPortfolioValue.textContent = formatUSD(currentValue);
  els.statInvested.textContent = formatUSD(invested);

  // ── Card 3: P&L ────────────────────────────────────────────────
  els.statPnL.textContent = (pnl >= 0 ? '+' : '') + formatUSD(pnl);
  els.statPnL.className =
    'text-sm sm:text-xl font-bold ' +
    (pnl > 0 ? 'text-emerald-300' : pnl < 0 ? 'text-rose-300' : 'text-slate-200');

  els.statPnLPct.textContent = (pnl >= 0 ? '+' : '') + formatPercent(pnlPct);
  els.statPnLPct.className =
    'text-[10px] sm:text-xs font-semibold mt-0.5 ' +
    (pnl > 0 ? 'text-emerald-300' : pnl < 0 ? 'text-rose-300' : 'text-slate-400');

  // ── Track-state button is meaningless without prices ───────────
  if (els.trackCurrentStateBtn) {
    const ready = !!state.lastPricesFetch;
    els.trackCurrentStateBtn.disabled = !ready;
    els.trackCurrentStateBtn.classList.toggle('opacity-50', !ready);
    els.trackCurrentStateBtn.classList.toggle('cursor-not-allowed', !ready);
  }

  // ── Header timestamp ───────────────────────────────────────────
  if (state.lastPricesFetch) {
    const date = new Date(state.lastPricesFetch);
    const minsAgo = Math.round((Date.now() - date.getTime()) / 60000);
    const stale = minsAgo >= 30;
    els.lastUpdated.textContent =
      minsAgo < 1
        ? 'Prices: just now'
        : minsAgo < 60
        ? `Prices: ${minsAgo}m ago` + (stale ? ' — may be stale' : '')
        : `Prices: ${date.toLocaleTimeString()} — may be stale`;
    els.lastUpdated.className = stale
      ? 'text-[11px] text-amber-400 mt-0.5'
      : 'text-[11px] text-slate-500 mt-0.5';
  } else {
    els.lastUpdated.textContent = 'Prices not yet loaded · refresh to start';
    els.lastUpdated.className = 'text-[11px] text-slate-500 mt-0.5';
  }
}

// Sample standard deviation of portfolio_value over the last `windowDays` of
// recorded price snapshots. Returns { sigma, samples }. Uses portfolio-value
// levels (not returns) — the amplifier's z-score divides raw USD gaps by
// raw USD volatility, so the units cancel cleanly without needing a returns
// model. Insufficient samples → sigma = 0, which disables the amplifier.
function computePortfolioSigma(windowDays) {
  const snapshots = Array.isArray(_priceSnapshots) ? _priceSnapshots : [];
  if (!snapshots.length) return { sigma: 0, samples: 0 };
  const cutoff = Date.now() - windowDays * 24 * 3_600_000;
  const values = [];
  for (const s of snapshots) {
    const t = new Date(s.created_at).getTime();
    const v = Number(s.portfolio_value);
    if (Number.isFinite(t) && Number.isFinite(v) && t >= cutoff) values.push(v);
  }
  if (values.length < 3) return { sigma: 0, samples: values.length };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1);
  return { sigma: Math.sqrt(variance), samples: values.length };
}

// Counter-cyclical amplifier. When enabled, scales the raw step size by
//     multiplier = clamp(1 − k·z, 0.5, 2.0)
// where z = (currentValue − periodTarget) / σ. Portfolio well below target
// → z < 0 → multiplier > 1 → larger contribution. Above target → smaller.
// Degenerates safely (multiplier = 1) on insufficient history.
const Z_AMPLIFIER_WINDOW_DAYS = 30;
const Z_AMPLIFIER_MIN_MULT = 0.5;
const Z_AMPLIFIER_MAX_MULT = 2.0;
function computeZAmplifier(currentValue, periodTarget, config) {
  if (!config.zAmplifierEnabled) {
    return { enabled: false, active: false, multiplier: 1, z: null, sigma: 0, samples: 0, reason: 'disabled' };
  }
  const { sigma, samples } = computePortfolioSigma(Z_AMPLIFIER_WINDOW_DAYS);
  if (!(sigma > 0) || samples < 3) {
    return { enabled: true, active: false, multiplier: 1, z: null, sigma, samples, reason: 'insufficient-history' };
  }
  const k = Number(config.zAmplifierK);
  if (!Number.isFinite(k) || k <= 0) {
    return { enabled: true, active: false, multiplier: 1, z: 0, sigma, samples, reason: 'k-zero' };
  }
  const z = (currentValue - periodTarget) / sigma;
  const rawMult = 1 - k * z;
  const multiplier = Math.max(Z_AMPLIFIER_MIN_MULT, Math.min(Z_AMPLIFIER_MAX_MULT, rawMult));
  return { enabled: true, active: true, multiplier, z, sigma, samples, reason: null };
}

function computeStepDetails() {
  const { config } = state;
  const currentValue = computePortfolioValue();
  const nextPeriodIndex = (config.completedPeriods || 0) + 1;
  const periodTarget = config.initialValue + nextPeriodIndex * config.stepPerPeriod;
  const rawChange = periodTarget - currentValue;

  // Amplifier scales the raw step before the max-addition cap is applied.
  // This preserves the cap's semantics ("max I'll ever deploy per step")
  // while letting the amplifier shape behavior within that budget.
  const amplifier = computeZAmplifier(currentValue, periodTarget, config);
  const amplifiedChange = rawChange * amplifier.multiplier;

  let cappedChange = amplifiedChange;
  let capBinding = false;
  if (config.maxAddition > 0) {
    if (amplifiedChange > config.maxAddition) {
      cappedChange = config.maxAddition;
      capBinding = true;
    } else if (amplifiedChange < -config.maxAddition) {
      cappedChange = -config.maxAddition;
      capBinding = true;
    }
  }

  // effectiveTarget is what the portfolio will actually sum to after the step.
  // Per-asset trades are computed against this (not the uncapped periodTarget),
  // so sum(trades) === cappedChange and post-trade allocations exactly match targets.
  const effectiveTarget = currentValue + cappedChange;

  let direction = 'Hold';
  if (cappedChange > 0.5) direction = 'Invest';
  else if (cappedChange < -0.5) direction = 'Withdraw';

  const estimatedInvested = (config.investedSoFar || 0) + cappedChange;

  return {
    currentValue,
    periodTarget,
    targetValue: periodTarget,    // alias retained for snapshot meta compatibility
    effectiveTarget,
    rawChange,
    theoreticalChange: rawChange, // alias retained for snapshot meta compatibility
    amplifier,
    amplifiedChange,
    cappedChange,
    capBinding,
    direction,
    nextPeriodIndex,
    estimatedInvested,
  };
}

// Trade significance threshold (USD). Values below this are considered noise
// and don't count as a "real" trade for classification/rendering purposes.
const TRADE_EPSILON_USD = 0.5;

function classifyStepKind(stepDetails, trades) {
  const { cappedChange } = stepDetails;
  if (cappedChange > TRADE_EPSILON_USD) return 'Invest';
  if (cappedChange < -TRADE_EPSILON_USD) return 'Withdraw';
  // cappedChange ≈ 0: either rebalance-only (drift > epsilon) or genuinely on target.
  const anyDrift = (trades || []).some(
    (t) => Math.abs(t.suggestedValue) >= TRADE_EPSILON_USD,
  );
  return anyDrift ? 'Rebalance' : 'Hold';
}

function renderStepDetailsAndTrades() {
  const { config, assets } = state;
  els.stepError.classList.add('hidden');
  els.stepError.textContent = '';

  if (!assets.length) {
    els.stepError.textContent = 'Add at least one asset to calculate suggested trades.';
    els.stepError.classList.remove('hidden');
    els.tradesEmpty.classList.remove('hidden');
    els.tradesContent.classList.add('hidden');
    return;
  }

  if (!config.stepPerPeriod || config.stepPerPeriod <= 0) {
    els.stepError.textContent =
      'Set a Step size in Plan settings to calculate your next action.';
    els.stepError.classList.remove('hidden');
    els.tradesEmpty.classList.remove('hidden');
    els.tradesContent.classList.add('hidden');
    return;
  }

  const totalAlloc = assets.reduce((s, a) => s + (Number(a.allocation) || 0), 0);
  if (Math.abs(totalAlloc - 100) > 0.1) {
    els.stepError.textContent =
      `Allocation total is ${totalAlloc.toFixed(1)}% — it must equal exactly 100% for per-asset trade amounts to be correct.`;
    els.stepError.classList.remove('hidden');
    els.tradesEmpty.classList.remove('hidden');
    els.tradesContent.classList.add('hidden');
    return;
  }

  const details = computeStepDetails();
  const trades = computePerAssetTrades(details);
  const stepKind = classifyStepKind(details, trades);
  const hasAction = stepKind !== 'Hold';

  els.tradesEmpty.classList.toggle('hidden', hasAction);
  els.tradesContent.classList.toggle('hidden', !hasAction);

  els.stepCurrentValue.textContent = formatUSD(details.currentValue);
  els.stepTargetValue.textContent = formatUSD(details.periodTarget);
  if (els.stepEffectiveTarget) {
    els.stepEffectiveTarget.textContent = formatUSD(details.effectiveTarget);
  }
  if (els.stepCapNote) {
    if (details.capBinding) {
      const shortfall = details.periodTarget - details.effectiveTarget;
      const noun = shortfall >= 0 ? 'below' : 'above';
      els.stepCapNote.textContent =
        `Max-per-step cap applied — ${formatUSD(Math.abs(shortfall))} ${noun} period target.`;
      els.stepCapNote.classList.remove('hidden');
    } else {
      els.stepCapNote.classList.add('hidden');
      els.stepCapNote.textContent = '';
    }
  }
  // Actual net after filters may differ from cappedChange (e.g. dust skipped,
  // no-sell suppresses drift corrections). Use it for the user-facing numbers.
  const actualNet = trades.reduce((s, t) => s + t.suggestedValue, 0);
  const totalBuys = trades.reduce((s, t) => s + Math.max(t.suggestedValue, 0), 0);
  const filteredCount = trades.filter((t) => t.filters && t.filters.length > 0).length;
  const filteredUsd = trades.reduce(
    (s, t) => s + Math.max(Math.abs(t.rawSuggestedValue) - Math.abs(t.suggestedValue), 0),
    0,
  );

  els.stepEstimatedInvested.textContent = formatUSD((config.investedSoFar || 0) + actualNet);
  if (els.stepEstimatedBreakdown) {
    const currentInv = config.investedSoFar || 0;
    const sign = actualNet >= 0 ? '+' : '−';
    els.stepEstimatedBreakdown.textContent =
      `${formatUSD(currentInv)} ${sign} ${formatUSD(Math.abs(actualNet))}`;
  }

  if (els.stepTotalLabel && els.stepTotalSuggested) {
    if (stepKind === 'Withdraw') {
      els.stepTotalLabel.textContent = 'Net to withdraw';
      els.stepTotalSuggested.className = 'text-rose-300 font-medium';
      els.stepTotalSuggested.textContent = formatUSD(Math.abs(actualNet));
    } else if (stepKind === 'Rebalance') {
      els.stepTotalLabel.textContent = 'Rebalance turnover';
      els.stepTotalSuggested.className = 'text-sky-300 font-medium';
      els.stepTotalSuggested.textContent = formatUSD(totalBuys);
    } else {
      els.stepTotalLabel.textContent = 'Net to invest';
      els.stepTotalSuggested.className = 'text-emerald-300 font-medium';
      els.stepTotalSuggested.textContent = formatUSD(Math.abs(actualNet));
    }
  }

  if (els.stepFilterNote) {
    if (filteredCount > 0 && filteredUsd >= TRADE_EPSILON_USD) {
      const plural = filteredCount === 1 ? '' : 's';
      els.stepFilterNote.textContent =
        `Filters skipped ${formatUSD(filteredUsd)} across ${filteredCount} asset${plural} ` +
        `(bands / dust / no-sell). See row badges.`;
      els.stepFilterNote.classList.remove('hidden');
    } else {
      els.stepFilterNote.classList.add('hidden');
      els.stepFilterNote.textContent = '';
    }
  }

  if (els.stepAmplifierLine) {
    const amp = details.amplifier;
    if (!amp || !amp.enabled) {
      els.stepAmplifierLine.classList.add('hidden');
      els.stepAmplifierLine.textContent = '';
    } else if (!amp.active) {
      const msg =
        amp.reason === 'insufficient-history'
          ? `Amplifier: waiting for 30-day history (${amp.samples}/3 samples, need more price snapshots)`
          : `Amplifier: enabled (k = 0, no scaling)`;
      els.stepAmplifierLine.textContent = msg;
      els.stepAmplifierLine.classList.remove('hidden');
    } else {
      const zStr = amp.z.toFixed(2);
      const multStr = amp.multiplier.toFixed(2);
      const shapedBy = details.amplifiedChange - details.rawChange;
      const shapedSign = shapedBy >= 0 ? '+' : '−';
      els.stepAmplifierLine.textContent =
        `Amplifier: z = ${zStr}σ · mult = ×${multStr} ` +
        `(σ30d = ${formatUSD(amp.sigma)}, n = ${amp.samples}) ` +
        `→ shaped step by ${shapedSign}${formatUSD(Math.abs(shapedBy))}`;
      els.stepAmplifierLine.classList.remove('hidden');
    }
  }

  if (!hasAction) return;

  // ── Per-asset trades table with units-delta entry ──────────────
  els.tradesTableBody.innerHTML = '';
  const fragment = document.createDocumentFragment();

  trades.forEach((t) => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/30';

    const isBuy = t.suggestedValue > TRADE_EPSILON_USD;
    const isSell = t.suggestedValue < -TRADE_EPSILON_USD;
    const filterBadges = (t.filters || []).map((f) => {
      const label = f === 'band' ? 'in band' : f === 'dust' ? 'dust' : 'held';
      const title =
        f === 'band'
          ? `Within rebalance band — drift ${(
              ((t.currentValue / (details.currentValue || 1)) * 100) - t.allocation
            ).toFixed(1)}pp`
          : f === 'dust'
          ? `Below minimum trade size`
          : `No-sell mode active`;
      return (
        `<span class="ml-1 text-[9px] text-slate-500 bg-slate-800/60 border border-slate-700 ` +
        `rounded px-1 py-0.5" title="${escapeAttr(title)}">${escapeHtml(label)}</span>`
      );
    }).join('');

    const actionBadge = isBuy
      ? '<span class="text-[10px] font-bold text-emerald-300 bg-emerald-500/10 ' +
        'border border-emerald-500/30 rounded px-1.5 py-0.5">BUY</span>'
      : isSell
      ? '<span class="text-[10px] font-bold text-rose-300 bg-rose-500/10 ' +
        'border border-rose-500/30 rounded px-1.5 py-0.5">SELL</span>'
      : (t.filters && t.filters.length
          ? '<span class="text-[10px] font-bold text-slate-500 bg-slate-800/40 ' +
            'border border-slate-700 rounded px-1.5 py-0.5">HOLD</span>'
          : '<span class="text-[10px] text-slate-600">—</span>');

    const microSteps = Math.max(1, Math.floor(Number(config.microSteps) || 1));
    const amountMain =
      Math.abs(t.suggestedValue) >= TRADE_EPSILON_USD
        ? formatUSD(Math.abs(t.suggestedValue))
        : '—';
    const microHint =
      microSteps > 1 && Math.abs(t.suggestedValue) >= TRADE_EPSILON_USD
        ? `<div class="text-[9px] text-slate-500 font-normal">` +
          `${microSteps}× ${formatUSD(Math.abs(t.suggestedValue) / microSteps)}</div>`
        : '';
    const amountText = `<div>${amountMain}</div>${microHint}`;
    const amountClass = isBuy
      ? 'text-emerald-300 font-medium'
      : isSell
      ? 'text-rose-300 font-medium'
      : 'text-slate-600';

    // Pre-fill the units-delta input with the signed suggested units.
    // Negative values (SELLs) are preserved — user reviewing an invest period
    // can still see which overweight assets should be trimmed.
    const suggestedUnitsVal =
      Number.isFinite(t.suggestedUnits) && Math.abs(t.suggestedUnits) >= 1e-8
        ? t.suggestedUnits.toFixed(6)
        : '';

    const targetText = t.targetValue >= 0.005 ? formatUSD(t.targetValue) : '—';

    tr.innerHTML = `
      <td class="py-2 pr-2 text-slate-100 font-medium whitespace-nowrap">
        ${escapeHtml(t.symbol)}${filterBadges}
      </td>
      <td class="py-2 px-2 text-center whitespace-nowrap">${actionBadge}</td>
      <td class="py-2 px-2 text-right whitespace-nowrap ${amountClass}">${amountText}</td>
      <td class="py-2 px-2 text-right whitespace-nowrap text-slate-400">${targetText}</td>
      <td class="py-2 pl-2 text-right whitespace-nowrap">
        <input data-asset-index="${t.assetIndex}" type="number" step="0.00000001"
               class="number-input w-24 rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1 text-xs text-right text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/70 focus:border-emerald-400"
               value="${escapeAttr(suggestedUnitsVal)}"
               placeholder="0" />
      </td>
    `;
    fragment.appendChild(tr);
  });

  els.tradesTableBody.appendChild(fragment);
}

// Per-asset trades under a value-averaging plan.
//
// Base formula (canonical multi-asset VA):
//     tradeᵢ = wᵢ × effectiveTarget − currentAssetValueᵢ
// where effectiveTarget = currentValue + cappedChange. Sum of trades equals
// cappedChange, and post-trade allocations land exactly on target.
//
// Efficiency filters (applied in order, each may zero or reduce a trade):
//   1. Rebalance bands — if |drift%| is within the asset's band threshold
//      (max(absBand, targetPct × relBand/100)), keep only the *deploy* share
//      (wᵢ × cappedChange) and drop the drift-correction component. This is
//      the 5/25 rule extended to VA: deploy new cash into target shares, but
//      don't churn on small drift.
//   2. No-sell mode — on non-withdraw steps, zero out negative trades.
//      Edleson's recommended variant: tax-efficient, low IRR penalty.
//   3. Minimum trade size — trades whose absolute USD size falls below the
//      configured floor are zeroed out as "dust".
//
// Filters break the sum==cappedChange invariant by design (that's the point
// — fewer, bigger, cleaner trades). The UI surfaces the actual post-filter
// net cash flow so the user sees what they're really committing to.
function computePerAssetTrades(stepDetails) {
  const { effectiveTarget, currentValue, cappedChange } = stepDetails;
  const { config, assets } = state;

  const minTrade = Math.max(0, Number(config.minTradeSize) || 0);
  const absBand = Math.max(0, Number(config.rebalanceAbsBand) || 0);
  const relBand = Math.max(0, Number(config.rebalanceRelBand) || 0);
  const noSell = !!config.noSellMode;
  const isWithdrawStep = cappedChange < -TRADE_EPSILON_USD;

  return assets.map((a, assetIndex) => {
    const allocation = Number(a.allocation) || 0;
    const units = Number(a.units) || 0;
    const price = Number(a.price) || 0;

    const currentAssetValue = units * price;
    const idealTarget = (allocation / 100) * effectiveTarget;
    let suggestedValue = idealTarget - currentAssetValue;
    const rawSuggestedValue = suggestedValue;
    const filters = [];

    // Drift measured as percentage points of total portfolio.
    const currentPct = currentValue > 0 ? (currentAssetValue / currentValue) * 100 : 0;
    const driftPp = currentPct - allocation;
    const bandThreshold = Math.max(absBand, (allocation * relBand) / 100);
    const withinBand = bandThreshold > 0 && Math.abs(driftPp) < bandThreshold;

    // (1) Rebalance band: drop the drift-correction component, keep deploy share.
    if (withinBand) {
      suggestedValue = (allocation / 100) * cappedChange;
      filters.push('band');
    }

    // (2) No-sell: suppress sells on non-withdraw steps.
    if (noSell && !isWithdrawStep && suggestedValue < 0) {
      suggestedValue = 0;
      filters.push('noSell');
    }

    // (3) Minimum trade size: dust filter (last, so it catches post-band residuals).
    if (minTrade > 0 && Math.abs(suggestedValue) < minTrade) {
      suggestedValue = 0;
      if (Math.abs(rawSuggestedValue) >= TRADE_EPSILON_USD) filters.push('dust');
    }

    const suggestedUnits = price ? suggestedValue / price : 0;

    return {
      assetIndex,
      symbol: a.symbol,
      allocation,
      price,
      currentValue: currentAssetValue,
      idealTarget,                             // full VA target (pre-filter)
      targetValue: currentAssetValue + suggestedValue,  // post-trade value (what user sees)
      suggestedValue,                          // signed USD (+ buy, − sell)
      suggestedUnits,                          // signed units
      rawSuggestedValue,                       // unfiltered trade, for diagnostics
      withinBand,
      filters,                                 // e.g. ['band','dust']
    };
  });
}

async function fetchPrices() {
  const assets = state.assets || [];

  // Derive CoinGecko IDs from ticker symbols and deduplicate.
  const seenIds = new Set();
  const uniqueIds = [];

  assets.forEach((a) => {
    const id = tickerToId(a.symbol);
    // Also update asset.id for snapshot metadata storage
    a.id = id;
    if (id && !seenIds.has(id)) {
      seenIds.add(id);
      uniqueIds.push(id);
    }
  });

  if (!uniqueIds.length) {
    els.stepError.textContent = 'Please add assets with valid ticker symbols to fetch prices.';
    els.stepError.classList.remove('hidden');
    return;
  }

  els.stepError.classList.add('hidden');
  els.stepError.textContent = '';
  if (els.pricesFetchStatus) {
    els.pricesFetchStatus.classList.add('hidden');
    els.pricesFetchStatus.textContent = '';
  }

  const btn = els.refreshPricesBtn;
  const origLabel = btn.textContent;
  btn.textContent = 'Fetching…';
  btn.disabled = true;

  const params = new URLSearchParams();
  params.set('ids', uniqueIds.join(','));

  // Cap how long we wait for the server proxy. The server itself may retry
  // CoinGecko for several minutes on a 429, so without this the browser tab
  // can hang indefinitely.
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 60_000);

  try {
    const res = await fetch(`/api/prices?${params.toString()}`, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`Price API error: ${res.status}`);
    }
    const data = await res.json();

    const returnedIds = new Set(Object.keys(data));

    state.assets.forEach((asset) => {
      const id = tickerToId(asset.symbol);
      if (id && data[id] && typeof data[id].usd === 'number') {
        asset.price = data[id].usd;
      }
    });

    // Identify assets whose ticker didn't resolve to a known CoinGecko ID
    const failedAssets = state.assets.filter((a) => {
      const id = tickerToId(a.symbol);
      return id && !returnedIds.has(id);
    });

    if (failedAssets.length > 0 && els.pricesFetchStatus) {
      const list = failedAssets
        .map((a) => `<strong>${escapeHtml(a.symbol)}</strong>`)
        .join(', ');
      els.pricesFetchStatus.innerHTML =
        `Price not found for: ${list}. ` +
        `The ticker may not be recognized by CoinGecko. ` +
        `Common fixes: AVAX (not AVALANCHE), POL/MATIC (interchangeable).`;
      els.pricesFetchStatus.classList.remove('hidden');
    }

    state.lastPricesFetch = new Date().toISOString();
    saveState();
    renderAssetsTable();
    renderSummaryAndNextStep();
    renderStepDetailsAndTrades();
    maybeRecordPriceSnapshot();
  } catch (err) {
    console.error(err);
    els.stepError.textContent = err.name === 'AbortError'
      ? 'Price fetch timed out. The provider may be rate-limited — please try again shortly.'
      : 'Failed to fetch prices. Please check your connection or try again in a moment.';
    els.stepError.classList.remove('hidden');
  } finally {
    clearTimeout(timeoutId);
    btn.textContent = origLabel;
    btn.disabled = false;
  }
}

async function fetchHistory() {
  try {
    const res = await fetch('/api/history');
    if (!res.ok) {
      throw new Error(`History API error: ${res.status}`);
    }
    const rows = await res.json();
    renderHistory(rows);
  } catch (err) {
    console.error(err);
    if (els.historyError) {
      els.historyError.textContent =
        'Failed to load history from the server. The backend might be unavailable.';
      els.historyError.classList.remove('hidden');
    }
  }
}

function renderHistory(rows) {
  if (!els.historyTableBody) return;
  els.historyTableBody.innerHTML = '';

  _historyRows = Array.isArray(rows) ? rows : [];
  const isEmpty = !_historyRows.length;
  const hadHistory = _hasHistory;
  _hasHistory = !isEmpty;

  // Re-render assets table if history state changed (to lock/unlock units column)
  if (_hasHistory !== hadHistory) {
    renderAssetsTable();
  }

  // Toggle between "track current state" (no history) and "mark step applied" (has history)
  if (els.trackCurrentStateBtn) els.trackCurrentStateBtn.classList.toggle('hidden', !isEmpty);
  if (els.applyStepBtn) els.applyStepBtn.classList.toggle('hidden', isEmpty);
  if (els.stepHint) els.stepHint.classList.toggle('hidden', isEmpty);
  if (els.trackHint) els.trackHint.classList.toggle('hidden', !isEmpty);

  if (isEmpty) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td colspan="7" class="py-3 px-2 text-center text-xs text-slate-500">No snapshots yet. Track current state to create the first one.</td>';
    els.historyTableBody.appendChild(tr);
    renderAnalytics([]);
    renderChart();
    return;
  }

  const fragment = document.createDocumentFragment();

  rows.forEach((row) => {
    const tr = document.createElement('tr');
    const date = row.created_at ? new Date(row.created_at) : null;
    const pnlClass =
      row.pnl > 0 ? 'text-emerald-300' : row.pnl < 0 ? 'text-rose-300' : 'text-slate-200';

    tr.innerHTML = `
      <td class="py-2 px-2 text-slate-200 whitespace-nowrap">${date ? date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '–'}</td>
      <td class="py-2 px-2 text-right text-slate-200 whitespace-nowrap">${row.period_index}</td>
      <td class="py-2 px-2 text-right text-slate-200 whitespace-nowrap">${formatUSD(row.invested)}</td>
      <td class="py-2 px-2 text-right text-slate-200 whitespace-nowrap">${formatUSD(row.portfolio_value)}</td>
      <td class="py-2 px-2 text-right whitespace-nowrap ${pnlClass}">${formatUSD(row.pnl)}</td>
      <td class="py-2 px-2 text-right whitespace-nowrap ${pnlClass}">${formatPercent(row.pnl_percent)}</td>
      <td class="py-2 pl-2 text-right whitespace-nowrap">
        <button data-id="${row.id}" class="history-delete-btn text-[11px] text-slate-500 hover:text-rose-400 transition-colors px-1.5 py-0.5 rounded hover:bg-rose-500/10 border border-transparent hover:border-rose-500/30" title="Delete this record">✕</button>
      </td>
    `;

    fragment.appendChild(tr);
  });

  els.historyTableBody.appendChild(fragment);
  if (els.historyError) {
    els.historyError.classList.add('hidden');
    els.historyError.textContent = '';
  }

  renderAnalytics(rows);
  renderChart();
}

async function createSnapshotFromStep(details) {
  try {
    const { config } = state;
    const periodIndex = config.completedPeriods || 0;
    const investedAfter = config.investedSoFar || 0;
    // Use actual portfolio value (units already updated before this call)
    const portfolioValueAfter = computePortfolioValue();
    const pnl = portfolioValueAfter - investedAfter;
    const pnlPercent = investedAfter !== 0 ? (pnl / investedAfter) * 100 : 0;

    const payload = {
      createdAt: new Date().toISOString(),
      periodIndex,
      invested: investedAfter,
      portfolioValue: portfolioValueAfter,
      pnl,
      pnlPercent,
      meta: {
        step: {
          targetValue: details.targetValue,
          theoreticalChange: details.theoreticalChange,
          cappedChange: details.cappedChange,
          actualNet: Number.isFinite(details.actualNet) ? details.actualNet : details.cappedChange,
        },
        holdings: state.assets.map((a) => ({
          symbol: a.symbol,
          allocation: a.allocation,
          units: a.units,
          price: a.price,
        })),
      },
    };

    const res = await fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`History save failed: ${res.status}`);
    }

    await res.json();
    await fetchHistory();
  } catch (err) {
    console.error(err);
    if (els.historyError) {
      els.historyError.textContent =
        'Failed to save snapshot to the server. Your local config is still updated.';
      els.historyError.classList.remove('hidden');
    }
  } finally {
    els.applyStepBtn.disabled = false;
  }
}

async function createInitialSnapshot() {
  if (els.trackCurrentStateBtn) els.trackCurrentStateBtn.disabled = true;
  try {
    const { config } = state;
    const portfolioValue = computePortfolioValue();
    const invested = config.investedSoFar || 0;
    const pnl = portfolioValue - invested;
    const pnlPercent = invested !== 0 ? (pnl / invested) * 100 : 0;

    const payload = {
      createdAt: new Date().toISOString(),
      periodIndex: Math.max(0, Number(config.completedPeriods) || 0),
      invested,
      portfolioValue,
      pnl,
      pnlPercent,
      meta: {
        type: 'initial',
        holdings: state.assets.map((a) => ({
          symbol: a.symbol,
          allocation: a.allocation,
          units: a.units,
          price: a.price,
        })),
      },
    };

    const res = await fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`Snapshot save failed: ${res.status}`);
    await res.json();
    await fetchHistory();
    showToast('Current state recorded ✓  Now apply steps to track your value-averaging progress.');
  } catch (err) {
    console.error(err);
    if (els.historyError) {
      els.historyError.textContent = 'Failed to save initial snapshot to the server.';
      els.historyError.classList.remove('hidden');
    }
  } finally {
    if (els.trackCurrentStateBtn) els.trackCurrentStateBtn.disabled = false;
  }
}

function renderAnalytics(rows) {
  const analyticsEl = document.getElementById('historyAnalytics');
  if (!analyticsEl) return;

  if (!Array.isArray(rows) || !rows.length) {
    analyticsEl.classList.add('hidden');
    return;
  }

  analyticsEl.classList.remove('hidden');

  const sorted = [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  // Count step snapshots (exclude the initial tracking snapshot)
  const stepRows = rows.filter((r) => {
    try {
      const meta = r.meta ? (typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta) : null;
      return !meta || meta.type !== 'initial';
    } catch (_) { return true; }
  });

  // Total return from the most recent snapshot
  const latest = sorted[sorted.length - 1];
  const totalReturnPct = latest.pnl_percent;

  // Best and worst period-over-period market gain.
  // Subtract newly invested cash so the figure reflects price movement only,
  // not the size of the contribution.
  let bestChange = null;
  let worstChange = null;
  for (let i = 1; i < sorted.length; i++) {
    const valueDelta = sorted[i].portfolio_value - sorted[i - 1].portfolio_value;
    const investedDelta = sorted[i].invested - sorted[i - 1].invested;
    const change = valueDelta - investedDelta;
    if (bestChange === null || change > bestChange) bestChange = change;
    if (worstChange === null || change < worstChange) worstChange = change;
  }

  const periodCountEl = document.getElementById('analyticsPeriodsCount');
  const totalReturnEl = document.getElementById('analyticsTotalReturn');
  const bestEl = document.getElementById('analyticsBestPeriod');
  const worstEl = document.getElementById('analyticsWorstPeriod');

  if (periodCountEl) periodCountEl.textContent = stepRows.length;

  if (totalReturnEl) {
    totalReturnEl.textContent = (totalReturnPct >= 0 ? '+' : '') + formatPercent(totalReturnPct);
    totalReturnEl.className =
      'text-sm font-bold mt-0.5 ' +
      (totalReturnPct > 0 ? 'text-emerald-300' : totalReturnPct < 0 ? 'text-rose-300' : 'text-slate-200');
  }

  if (bestEl) {
    bestEl.textContent = bestChange !== null
      ? (bestChange >= 0 ? '+' : '') + formatUSD(bestChange)
      : '—';
  }

  if (worstEl) {
    const worstPositive = worstChange !== null && worstChange >= 0;
    worstEl.textContent = worstChange !== null
      ? (worstChange >= 0 ? '+' : '') + formatUSD(worstChange)
      : '—';
    worstEl.className =
      'text-sm font-bold mt-0.5 ' + (worstPositive ? 'text-emerald-300' : 'text-rose-300');
  }
}

// Validate a snapshot row has the fields needed for charting: a parseable timestamp
// and finite numeric portfolio_value + invested. Guards against NaN x-values or
// corrupted rows crashing Chart.js.
function isValidSnapshot(row) {
  if (!row || typeof row !== 'object') return false;
  const t = new Date(row.created_at).getTime();
  if (!Number.isFinite(t)) return false;
  if (!Number.isFinite(Number(row.portfolio_value))) return false;
  if (!Number.isFinite(Number(row.invested))) return false;
  return true;
}

// Return price snapshots sampled at most once per `intervalHours`.
// Input must already be sorted ASC by created_at.
function sampleByInterval(snapshots, intervalHours) {
  if (!snapshots.length) return [];
  const ms = intervalHours * 3_600_000;
  const out = [];
  let lastT = -Infinity;
  for (const s of snapshots) {
    const t = new Date(s.created_at).getTime();
    if (t - lastT >= ms) { out.push(s); lastT = t; }
  }
  return out;
}

async function fetchPriceSnapshots() {
  try {
    const res = await fetch('/api/price-snapshots');
    if (!res.ok) throw new Error(`status ${res.status}`);
    _priceSnapshots = await res.json(); // already ASC from server
    renderChart();
  } catch (err) {
    console.error('Failed to fetch price snapshots', err);
    if (els.historyError) {
      els.historyError.textContent =
        'Failed to load performance chart data. The backend might be unavailable.';
      els.historyError.classList.remove('hidden');
    }
  }
}

// Record a price snapshot at most once per 12 hours after a successful price fetch.
async function maybeRecordPriceSnapshot() {
  const portfolioValue = computePortfolioValue();
  if (portfolioValue <= 0) return;

  const MIN_INTERVAL_MS = 12 * 3_600_000;
  if (_priceSnapshots.length) {
    const lastT = new Date(_priceSnapshots[_priceSnapshots.length - 1].created_at).getTime();
    if (Date.now() - lastT < MIN_INTERVAL_MS) return;
  }

  try {
    const res = await fetch('/api/price-snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        createdAt: new Date().toISOString(),
        portfolioValue,
        invested: state.config.investedSoFar || 0,
      }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const row = await res.json();
    _priceSnapshots.push(row);
    renderChart();
  } catch (err) {
    console.error('Failed to record price snapshot', err);
  }
}

function fmtAxisLabel(ms) {
  const d = new Date(ms);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function fmtTooltipLabel(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()}/${d.getMonth() + 1} ${hh}:${mm}`;
}

// Chart uses _priceSnapshots for the continuous lines and _historyRows for step markers.
// Falls back to _historyRows as line source when price snapshots are not yet available.
function renderChart() {
  if (_suspendChartRender) return;
  const chartWrap = document.getElementById('historyChartWrap');
  const canvas = document.getElementById('historyChart');
  if (!chartWrap || !canvas) return;

  try {
    // Drop rows with malformed timestamps or non-finite numeric fields so a single
    // bad row cannot break the x-axis or crash Chart.js with NaN coordinates.
    const validPriceSnaps = _priceSnapshots.filter(isValidSnapshot);
    const validHistoryRows = _historyRows.filter(isValidSnapshot);

    // --- resolve line data source ---
    let lineSnaps = validPriceSnaps; // already sorted ASC
    const resDays  = { '7d': 7, '30d': 30, '90d': 90 };
    const resHours = { '7d': 6, '30d': 24, '90d': 72 };
    const windowDays = resDays[_chartResolution] ?? 0;
    const visibleCutoff = (_chartResolution !== 'all' && windowDays)
      ? Date.now() - windowDays * 24 * 3_600_000
      : 0;
    if (lineSnaps.length >= 2 && _chartResolution !== 'all') {
      // Filter to the selected time window first, then sample
      if (visibleCutoff) {
        lineSnaps = lineSnaps.filter((s) => new Date(s.created_at).getTime() >= visibleCutoff);
      }
      lineSnaps = sampleByInterval(lineSnaps, resHours[_chartResolution] ?? 12);
    }

    // Fallback: use step history rows when no price snapshots yet
    const fallback = lineSnaps.length < 2
      ? [...validHistoryRows]
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
          .filter((s) => new Date(s.created_at).getTime() >= visibleCutoff)
      : null;
    const useSource = lineSnaps.length >= 2 ? lineSnaps : (fallback || []);

    if (useSource.length < 2) {
      chartWrap.classList.add('hidden');
      if (_chartInstance) { _chartInstance.destroy(); _chartInstance = null; }
      return;
    }
    chartWrap.classList.remove('hidden');

    // Show data source hint when using fallback
    const chartSourceHint = document.getElementById('chartSourceHint');
    if (chartSourceHint) {
      if (fallback) {
        chartSourceHint.textContent = 'Showing step history (price snapshots not yet available)';
        chartSourceHint.classList.remove('hidden');
      } else {
        chartSourceHint.classList.add('hidden');
      }
    }

    // Portfolio and invested lines (x = timestamp ms)
    const portfolioData = useSource.map((s) => ({
      x: new Date(s.created_at).getTime(),
      y: Number(s.portfolio_value),
    }));
    const investedData = useSource.map((s) => ({
      x: new Date(s.created_at).getTime(),
      y: Number(s.invested),
    }));

    // Step markers: non-initial snapshots from history, filtered to visible window
    const stepData = validHistoryRows
      .filter((r) => {
        try {
          const m = r.meta ? (typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta) : null;
          if (m && m.type === 'initial') return false;
        } catch (_) { /* keep */ }
        return new Date(r.created_at).getTime() >= visibleCutoff;
      })
      .map((r) => ({ x: new Date(r.created_at).getTime(), y: Number(r.portfolio_value) }));

    // Update existing chart in-place
    if (_chartInstance) {
      _chartInstance.data.datasets[0].data = portfolioData;
      _chartInstance.data.datasets[1].data = investedData;
      _chartInstance.data.datasets[2].data = stepData;
      _chartInstance.update();
      return;
    }

    // Create chart
    _chartInstance = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Portfolio',
          data: portfolioData,
          borderColor: '#34d399',
          backgroundColor: 'rgba(52,211,153,0.07)',
          fill: true,
          tension: 0.3,
          pointStyle: 'circle',
          pointRadius: 2,
          pointHoverRadius: 4,
          order: 2,
        },
        {
          label: 'Invested',
          data: investedData,
          borderColor: '#38bdf8',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          borderDash: [5, 4],
          pointStyle: 'circle',
          pointRadius: 2,
          pointHoverRadius: 4,
          order: 3,
        },
        {
          label: 'Step applied',
          type: 'scatter',
          data: stepData,
          backgroundColor: '#f59e0b',
          borderColor: '#92400e',
          borderWidth: 1,
          pointStyle: 'triangle',
          pointRadius: 7,
          pointHoverRadius: 9,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      layout: { padding: { top: 12, bottom: 8 } },
      plugins: {
        legend: { display: false }, // legend replaced by inline HTML legend below chart
        tooltip: {
          backgroundColor: '#0f172a',
          borderColor: '#334155',
          borderWidth: 1,
          titleColor: '#94a3b8',
          bodyColor: '#e2e8f0',
          padding: 10,
          bodyFont: { family: "'IBM Plex Sans', sans-serif", size: 11 },
          titleFont: { family: "'IBM Plex Sans', sans-serif", size: 10 },
          callbacks: {
            title: (items) => (items.length ? fmtTooltipLabel(items[0].parsed.x) : ''),
            label: (ctx) => {
              const label = ctx.dataset.label === 'Step applied' ? 'Step' : ctx.dataset.label;
              return `${label}: ${formatUSD(ctx.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            color: '#94a3b8',
            font: { family: "'IBM Plex Sans', sans-serif", size: 10 },
            maxTicksLimit: 6,
            callback: fmtAxisLabel,
            padding: 6,
          },
          grid: { color: 'rgba(30,41,59,0.8)' },
          border: { color: '#1e293b' },
        },
        y: {
          ticks: {
            color: '#94a3b8',
            font: { family: "'IBM Plex Sans', sans-serif", size: 10 },
            callback: (v) =>
              '$' + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v.toFixed(0))),
            padding: 6,
          },
          grid: { color: 'rgba(30,41,59,0.8)' },
          border: { color: '#1e293b' },
        },
      },
    },
  });
  } catch (err) {
    console.error('Failed to render chart', err);
    chartWrap.classList.add('hidden');
    if (_chartInstance) {
      try { _chartInstance.destroy(); } catch (_) {}
      _chartInstance = null;
    }
  }
}

function exportHistoryCsv() {
  if (!_historyRows || !_historyRows.length) {
    showToast('No history to export.');
    return;
  }

  const headers = ['Date', 'Period', 'Invested (USD)', 'Portfolio Value (USD)', 'P&L (USD)', 'P&L (%)'];
  const sorted = [..._historyRows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const csvRows = sorted.map((r) => {
    const d = r.created_at ? new Date(r.created_at).toLocaleString() : '';
    return [
      `"${d}"`,
      r.period_index,
      r.invested.toFixed(2),
      r.portfolio_value.toFixed(2),
      r.pnl.toFixed(2),
      r.pnl_percent.toFixed(4),
    ].join(',');
  });

  const csv = [headers.join(','), ...csvRows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `portfolio_history_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('History exported as CSV ✓');
}

function attachEventListeners() {
  els.saveConfigBtn.addEventListener('click', () => {
    syncStateFromConfigInputs();
    saveState();
    renderSummaryAndNextStep();
    renderStepDetailsAndTrades();
    const orig = els.saveConfigBtn.textContent;
    els.saveConfigBtn.textContent = 'Saved ✓';
    els.saveConfigBtn.classList.replace('bg-emerald-500', 'bg-emerald-700');
    setTimeout(() => {
      els.saveConfigBtn.textContent = orig;
      els.saveConfigBtn.classList.replace('bg-emerald-700', 'bg-emerald-500');
    }, 1400);
  });

  els.addAssetBtn.addEventListener('click', () => {
    state.assets.push({
      symbol: '',
      allocation: 0,
      units: 0,
      price: 0,
    });
    saveState();
    renderAssetsTable();
    renderSummaryAndNextStep();
    renderStepDetailsAndTrades();
  });

  els.assetsTableBody.addEventListener('input', (event) => {
    const target = event.target;
    const index = Number(target.getAttribute('data-index'));
    const field = target.getAttribute('data-field');
    if (!Number.isInteger(index) || !field) return;

    const asset = state.assets[index];
    if (!asset) return;

    if (field === 'symbol') {
      asset.symbol = String(target.value || '').trim().toUpperCase();
    } else if (field === 'allocation') {
      asset.allocation = Math.max(0, Number(target.value) || 0);
      const total = state.assets.reduce((s, a) => s + (Number(a.allocation) || 0), 0);
      els.allocationTotal.textContent = `${total.toFixed(1)}%`;
      els.allocationTotal.className =
        'text-xs font-semibold ' +
        (Math.abs(total - 100) < 0.01 ? 'text-emerald-300' : 'text-amber-300');
    } else if (field === 'units' && !_hasHistory) {
      asset.units = Math.max(0, Number(target.value) || 0);
      // Surgically update the value cell (cells[4] after ID column removal)
      const tr = target.closest('tr');
      if (tr && tr.cells[4]) {
        tr.cells[4].textContent =
          asset.price && asset.units ? formatUSD(asset.price * asset.units) : '–';
      }
    }

    saveState();
    renderSummaryAndNextStep();
    renderStepDetailsAndTrades();
  });

  els.assetsTableBody.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action="remove-asset"]');
    if (!btn) return;
    const index = Number(btn.getAttribute('data-index'));
    if (!Number.isInteger(index)) return;
    state.assets.splice(index, 1);
    saveState();
    renderAssetsTable();
    renderSummaryAndNextStep();
    renderStepDetailsAndTrades();
  });

  els.refreshPricesBtn.addEventListener('click', () => {
    fetchPrices();
  });

  if (els.trackCurrentStateBtn) {
    els.trackCurrentStateBtn.addEventListener('click', () => {
      if (!state.lastPricesFetch) {
        showToast('Refresh prices before tracking your baseline.');
        return;
      }
      createInitialSnapshot();
    });
  }

  els.applyStepBtn.addEventListener('click', () => {
    if (els.applyStepBtn.disabled) return;
    if (!window.confirm('Mark this step as applied? This will update your holdings and create a snapshot.')) return;
    els.applyStepBtn.disabled = true;
    const details = computeStepDetails();
    const { config } = state;

    // Read units-delta from the trades table inputs, update asset holdings, and
    // sum the actual USD cash flow (priced at fetch-time prices). This is what
    // went in/out — not details.cappedChange, which may be theoretical when
    // filters (bands / dust / no-sell) shaved the per-asset trades.
    let actualNetUsd = 0;
    const deltaInputs = els.tradesTableBody.querySelectorAll('input[data-asset-index]');
    deltaInputs.forEach((input) => {
      const assetIndex = Number(input.getAttribute('data-asset-index'));
      const delta = Number(input.value) || 0;
      if (Number.isInteger(assetIndex) && state.assets[assetIndex]) {
        const asset = state.assets[assetIndex];
        const price = Number(asset.price) || 0;
        const next = (Number(asset.units) || 0) + delta;
        asset.units = Math.max(0, next);
        actualNetUsd += delta * price;
      }
    });

    config.completedPeriods = (config.completedPeriods || 0) + 1;
    config.investedSoFar = (config.investedSoFar || 0) + actualNetUsd;
    els.investedSoFarInput.value = config.investedSoFar;

    // Store both the theoretical step and the actually applied net in the
    // snapshot so history reflects what really happened.
    const enrichedDetails = { ...details, actualNet: actualNetUsd };

    saveState();
    renderAssetsTable();
    renderSummaryAndNextStep();
    renderStepDetailsAndTrades();

    createSnapshotFromStep(enrichedDetails);

    showToast('Step recorded ✓  Holdings updated with entered units.');
  });

  els.resetAllBtn.addEventListener('click', async () => {
    if (!window.confirm('Reset all configuration, history, and performance chart data? This cannot be undone.')) return;
    state = structuredClone(defaultState);
    _hasHistory = false;
    _historyRows = [];
    _priceSnapshots = [];
    saveState();
    syncConfigInputsFromState();
    renderAssetsTable();
    renderSummaryAndNextStep();
    renderStepDetailsAndTrades();
    try {
      await Promise.all([
        fetch('/api/history', { method: 'DELETE' }),
        fetch('/api/price-snapshots', { method: 'DELETE' }),
      ]);
    } catch (err) {
      console.error('Failed to clear server data during reset', err);
    }
    fetchHistory();
    fetchPriceSnapshots();
  });

  [
    'initialValueInput', 'stepInput', 'maxAdditionInput',
    'completedPeriodsInput', 'investedSoFarInput',
    'minTradeSizeInput', 'rebalanceAbsBandInput', 'rebalanceRelBandInput',
    'noSellModeInput', 'zAmplifierModeInput', 'zAmplifierKInput', 'microStepsInput',
  ].forEach((key) => {
    const input = els[key];
    if (!input) return;
    input.addEventListener('change', () => {
      syncStateFromConfigInputs();
      saveState();
      renderSummaryAndNextStep();
      renderStepDetailsAndTrades();
    });
  });

  const exportCsvBtn = document.getElementById('exportCsvBtn');
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', exportHistoryCsv);
  }

  // Resolution toggle buttons
  function applyResolutionBtn(active) {
    document.querySelectorAll('.chart-res-btn').forEach((b) => {
      const isActive = b.dataset.res === active;
      b.className =
        'chart-res-btn text-[10px] px-2 py-0.5 rounded border transition-colors ' +
        (isActive
          ? 'border-slate-500 text-slate-200 bg-slate-800'
          : 'border-slate-700 text-slate-500 hover:text-slate-300');
    });
  }
  applyResolutionBtn(_chartResolution);
  document.querySelectorAll('.chart-res-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      _chartResolution = btn.dataset.res;
      applyResolutionBtn(_chartResolution);
      renderChart();
    });
  });

  if (els.historyTableBody) {
    els.historyTableBody.addEventListener('click', async (e) => {
      const btn = e.target.closest('.history-delete-btn');
      if (!btn) return;
      const id = Number(btn.dataset.id);
      if (!id) return;
      if (!window.confirm('Delete this history record? This cannot be undone.')) return;
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const res = await fetch(`/api/history/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(await res.text());
        await fetchHistory();
      } catch (err) {
        console.error('Failed to delete history record', err);
        btn.disabled = false;
        btn.textContent = '✕';
        if (els.historyError) {
          els.historyError.textContent = 'Failed to delete record.';
          els.historyError.classList.remove('hidden');
        }
      }
    });
  }
}

let _toastTimer = null;
function showToast(message, duration = 5000) {
  const toast = document.getElementById('toast');
  const msg = document.getElementById('toastMsg');
  if (!toast || !msg) return;
  msg.textContent = message;
  toast.style.opacity = '1';
  toast.style.pointerEvents = 'auto';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.pointerEvents = 'none';
  }, duration);
}

async function init() {
  // Load ticker→id map BEFORE any price fetch can be triggered (either by the
  // initial fetchPrices below or by a user clicking Refresh during init).
  await fetchTickerMap();

  syncConfigInputsFromState();
  renderAssetsTable();
  renderSummaryAndNextStep();
  renderStepDetailsAndTrades();
  attachEventListeners();

  try {
    const res = await fetch('/api/state');
    if (res.ok) {
      const serverState = await res.json();
      if (serverState && typeof serverState === 'object') {
        state = {
          ...structuredClone(defaultState),
          ...serverState,
          config: { ...structuredClone(defaultState.config), ...(serverState.config || {}) },
          assets:
            Array.isArray(serverState.assets) && serverState.assets.length
              ? serverState.assets
              : structuredClone(defaultState.assets),
        };
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_e) {}
        syncConfigInputsFromState();
        renderAssetsTable();
        renderSummaryAndNextStep();
        renderStepDetailsAndTrades();
      }
    }
  } catch (e) {
    console.warn('Could not load state from server — using local state', e);
  }

  fetchPrices();
  // Suspend intermediate chart renders until both history and price snapshots
  // have loaded, then render once with a consistent data set.
  _suspendChartRender = true;
  Promise.allSettled([fetchHistory(), fetchPriceSnapshots()]).then(() => {
    _suspendChartRender = false;
    renderChart();
  });

  const isFirstRun = !state.config.initialValue && !state.config.stepPerPeriod;
  if (isFirstRun) {
    const panel = document.getElementById('settingsPanel');
    if (panel) panel.open = true;
  }
}

document.addEventListener('DOMContentLoaded', init);

