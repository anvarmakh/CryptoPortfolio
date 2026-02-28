// Simple value-averaging planner for crypto portfolio
// All state is stored in localStorage so it survives refreshes.

const STORAGE_KEY = 'crypto_value_averaging_state_v1';

const defaultState = {
  config: {
    initialValue: 0,
    stepPerPeriod: 1000,
    maxAddition: 2000,
    periodsPerMonth: 2,
    completedPeriods: 0,
    investedSoFar: 0,
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

// ── Ticker → CoinGecko ID mapping ────────────────────────────────────────────
const TICKER_TO_COINGECKO_ID = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  DOGE: 'dogecoin',
  ADA: 'cardano',
  TRX: 'tron',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  DOT: 'polkadot',
  MATIC: 'matic-network',
  POL: 'matic-network',
  SHIB: 'shiba-inu',
  LTC: 'litecoin',
  UNI: 'uniswap',
  ATOM: 'cosmos',
  TON: 'the-open-network',
  OP: 'optimism',
  ARB: 'arbitrum',
  FTM: 'fantom',
  NEAR: 'near',
  APT: 'aptos',
  SUI: 'sui',
  INJ: 'injective-protocol',
  PEPE: 'pepe',
  WIF: 'dogwifcoin',
  BONK: 'bonk',
  JUP: 'jupiter-exchange-solana',
  SEI: 'sei-network',
  TIA: 'celestia',
  PYTH: 'pyth-network',
  STX: 'blockstack',
  IMX: 'immutable-x',
  RUNE: 'thorchain',
  FET: 'fetch-ai',
  RENDER: 'render-token',
  GRT: 'the-graph',
  LDO: 'lido-dao',
  MKR: 'maker',
  AAVE: 'aave',
  SNX: 'havven',
  CRV: 'curve-dao-token',
  COMP: 'compound-governance-token',
  ALGO: 'algorand',
  XLM: 'stellar',
  VET: 'vechain',
  HBAR: 'hedera-hashgraph',
  ICP: 'internet-computer',
  FIL: 'filecoin',
  SAND: 'the-sandbox',
  MANA: 'decentraland',
  AXS: 'axie-infinity',
  CHZ: 'chiliz',
};

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
  if (!Number.isFinite(value)) return '$ 0';
  const opts = {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
  };
  return new Intl.NumberFormat('en-US', opts).format(value).replace('$', '$ ');
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

    // Assets table
    assetsTableBody: document.getElementById('assetsTableBody'),
    allocationTotal: document.getElementById('allocationTotal'),

    // Trades panel
    tradesEmpty: document.getElementById('tradesEmpty'),
    tradesContent: document.getElementById('tradesContent'),
    tradesTableBody: document.getElementById('tradesTableBody'),
    stepCurrentValue: document.getElementById('stepCurrentValue'),
    stepTargetValue: document.getElementById('stepTargetValue'),
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
    refreshHistoryBtn: document.getElementById('refreshHistoryBtn'),
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
}

function syncStateFromConfigInputs() {
  const cfg = state.config;
  cfg.initialValue = Number(els.initialValueInput.value) || 0;
  cfg.stepPerPeriod = Number(els.stepInput.value) || 0;
  cfg.maxAddition = Number(els.maxAdditionInput.value) || 0;
  cfg.completedPeriods = Math.max(0, Number(els.completedPeriodsInput.value) || 0);
  const manualInvested = els.investedSoFarInput.value;
  if (manualInvested !== '') {
    cfg.investedSoFar = Number(manualInvested) || 0;
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
      ? `<td class="py-2 px-2 text-right text-slate-400 text-xs whitespace-nowrap hidden sm:table-cell">${unitsDisplay}</td>`
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
  const { cappedChange, direction, nextPeriodIndex } = computeStepDetails();

  els.heroPeriod.textContent = String(nextPeriodIndex);

  if (direction === 'Invest') {
    els.heroDirectionBadge.textContent = '↑ Invest';
    els.heroDirectionBadge.className = 'text-xs sm:text-sm font-bold text-emerald-300';
    els.heroAmount.textContent = formatUSD(cappedChange);
    els.heroAmount.className = 'text-sm sm:text-xl font-bold tracking-tight text-emerald-300 mt-0.5';
  } else if (direction === 'Withdraw') {
    els.heroDirectionBadge.textContent = '↓ Withdraw';
    els.heroDirectionBadge.className = 'text-xs sm:text-sm font-bold text-rose-300';
    els.heroAmount.textContent = formatUSD(Math.abs(cappedChange));
    els.heroAmount.className = 'text-sm sm:text-xl font-bold tracking-tight text-rose-300 mt-0.5';
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

  // ── Header timestamp ───────────────────────────────────────────
  if (state.lastPricesFetch) {
    const date = new Date(state.lastPricesFetch);
    const minsAgo = Math.round((Date.now() - date.getTime()) / 60000);
    els.lastUpdated.textContent =
      minsAgo < 1
        ? 'Prices: just now'
        : minsAgo < 60
        ? `Prices: ${minsAgo}m ago`
        : `Prices: ${date.toLocaleTimeString()}`;
  } else {
    els.lastUpdated.textContent = 'Prices not yet loaded · refresh to start';
  }
}

function computeStepDetails() {
  const { config } = state;
  const currentValue = computePortfolioValue();
  const nextPeriodIndex = (config.completedPeriods || 0) + 1;
  const targetValue = config.initialValue + nextPeriodIndex * config.stepPerPeriod;
  const theoreticalChange = targetValue - currentValue;

  let cappedChange = theoreticalChange;
  if (config.maxAddition > 0) {
    if (theoreticalChange > config.maxAddition) {
      cappedChange = config.maxAddition;
    } else if (theoreticalChange < -config.maxAddition) {
      cappedChange = -config.maxAddition;
    }
  }

  let direction = 'Hold';
  if (cappedChange > 0.5) direction = 'Invest';
  else if (cappedChange < -0.5) direction = 'Withdraw';

  const estimatedInvested = (config.investedSoFar || 0) + cappedChange;

  return {
    currentValue,
    targetValue,
    theoreticalChange,
    cappedChange,
    direction,
    nextPeriodIndex,
    estimatedInvested,
  };
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
  }

  const details = computeStepDetails();
  const hasAction = Math.abs(details.cappedChange) >= 0.5;

  els.tradesEmpty.classList.toggle('hidden', hasAction);
  els.tradesContent.classList.toggle('hidden', !hasAction);

  els.stepCurrentValue.textContent = formatUSD(details.currentValue);
  els.stepTargetValue.textContent = formatUSD(details.targetValue);
  els.stepEstimatedInvested.textContent = formatUSD(details.estimatedInvested);
  if (els.stepEstimatedBreakdown) {
    const current = config.investedSoFar || 0;
    const step = details.cappedChange;
    const sign = step >= 0 ? '+' : '−';
    els.stepEstimatedBreakdown.textContent =
      `${formatUSD(current)} ${sign} ${formatUSD(Math.abs(step))}`;
  }

  if (els.stepTotalLabel && els.stepTotalSuggested) {
    if (details.direction === 'Withdraw') {
      els.stepTotalLabel.textContent = 'Total to withdraw';
      els.stepTotalSuggested.className = 'text-rose-300 font-medium';
    } else {
      els.stepTotalLabel.textContent = 'Total to invest';
      els.stepTotalSuggested.className = 'text-emerald-300 font-medium';
    }
    els.stepTotalSuggested.textContent = formatUSD(Math.abs(details.cappedChange));
  }

  if (!hasAction) return;

  // ── Per-asset trades table with units-delta entry ──────────────
  const trades = computePerAssetTrades(details);
  els.tradesTableBody.innerHTML = '';
  const fragment = document.createDocumentFragment();

  trades.forEach((t) => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/30';

    const isBuy = t.suggestedValue > 0.5;
    const isSell = t.suggestedValue < -0.5;
    const actionBadge = isBuy
      ? '<span class="text-[10px] font-bold text-emerald-300 bg-emerald-500/10 ' +
        'border border-emerald-500/30 rounded px-1.5 py-0.5">BUY</span>'
      : isSell
      ? '<span class="text-[10px] font-bold text-rose-300 bg-rose-500/10 ' +
        'border border-rose-500/30 rounded px-1.5 py-0.5">SELL</span>'
      : '<span class="text-[10px] text-slate-600">—</span>';

    const amountText =
      Math.abs(t.suggestedValue) >= 0.5
        ? formatUSD(Math.abs(t.suggestedValue))
        : '—';
    const amountClass = isBuy
      ? 'text-emerald-300 font-medium'
      : isSell
      ? 'text-rose-300 font-medium'
      : 'text-slate-600';

    // Pre-fill the units-delta input with the suggested units value
    const suggestedUnitsVal =
      Number.isFinite(t.suggestedUnits) && Math.abs(t.suggestedUnits) >= 1e-8
        ? t.suggestedUnits.toFixed(6)
        : '';

    tr.innerHTML = `
      <td class="py-2 pr-2 text-slate-100 font-medium whitespace-nowrap">${escapeHtml(t.symbol)}</td>
      <td class="py-2 px-2 text-center whitespace-nowrap">${actionBadge}</td>
      <td class="py-2 px-2 text-right whitespace-nowrap ${amountClass}">${amountText}</td>
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

function computePerAssetTrades(stepDetails) {
  const { targetValue, cappedChange } = stepDetails;
  const { assets } = state;

  const trades = assets.map((a, assetIndex) => {
    const allocation = Number(a.allocation) || 0;
    const units = Number(a.units) || 0;
    const price = Number(a.price) || 0;

    const targetAssetValue = (allocation / 100) * targetValue;
    const currentAssetValue = units * price;
    const rawDelta = targetAssetValue - currentAssetValue;

    return {
      assetIndex,
      symbol: a.symbol,
      allocation,
      price,
      targetValue: targetAssetValue,
      currentValue: currentAssetValue,
      rawDelta,
    };
  });

  if (Math.abs(cappedChange) < 0.5) {
    return trades.map((t) => ({ ...t, suggestedValue: 0, suggestedUnits: 0 }));
  }

  const isInvest = cappedChange > 0;
  const positiveTotal = trades.reduce((sum, t) => {
    const v = isInvest ? Math.max(t.rawDelta, 0) : Math.max(-t.rawDelta, 0);
    return sum + v;
  }, 0);

  if (positiveTotal <= 0) {
    return trades.map((t) => ({ ...t, suggestedValue: 0, suggestedUnits: 0 }));
  }

  return trades.map((t) => {
    const basis = isInvest ? Math.max(t.rawDelta, 0) : Math.max(-t.rawDelta, 0);
    const weight = basis / positiveTotal;
    const suggestedAbs = weight * Math.abs(cappedChange);
    const suggestedValue = isInvest ? suggestedAbs : -suggestedAbs;
    const suggestedUnits = t.price ? suggestedValue / t.price : NaN;
    return {
      ...t,
      suggestedValue,
      suggestedUnits,
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

  try {
    const res = await fetch(`/api/prices?${params.toString()}`);
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
  } catch (err) {
    console.error(err);
    els.stepError.textContent =
      'Failed to fetch prices. Please check your connection or try again in a moment.';
    els.stepError.classList.remove('hidden');
  } finally {
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

  const isEmpty = !Array.isArray(rows) || !rows.length;
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
}

async function createSnapshotFromStep(details) {
  els.applyStepBtn.disabled = true;
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
      periodIndex: 0,
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
      asset.symbol = String(target.value || '').trim();
    } else if (field === 'allocation') {
      asset.allocation = Number(target.value) || 0;
      const total = state.assets.reduce((s, a) => s + (Number(a.allocation) || 0), 0);
      els.allocationTotal.textContent = `${total.toFixed(1)}%`;
      els.allocationTotal.className =
        'font-semibold ' +
        (Math.abs(total - 100) < 0.01 ? 'text-emerald-300' : 'text-amber-300');
    } else if (field === 'units' && !_hasHistory) {
      asset.units = Number(target.value) || 0;
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
      createInitialSnapshot();
    });
  }

  els.applyStepBtn.addEventListener('click', () => {
    const details = computeStepDetails();
    const { config } = state;

    // Read units-delta from the trades table inputs and update asset holdings
    const deltaInputs = els.tradesTableBody.querySelectorAll('input[data-asset-index]');
    deltaInputs.forEach((input) => {
      const assetIndex = Number(input.getAttribute('data-asset-index'));
      const delta = Number(input.value) || 0;
      if (Number.isInteger(assetIndex) && state.assets[assetIndex]) {
        state.assets[assetIndex].units =
          (Number(state.assets[assetIndex].units) || 0) + delta;
      }
    });

    config.completedPeriods = (config.completedPeriods || 0) + 1;
    config.investedSoFar = (config.investedSoFar || 0) + details.cappedChange;
    els.investedSoFarInput.value = config.investedSoFar;

    saveState();
    renderAssetsTable();
    renderSummaryAndNextStep();
    renderStepDetailsAndTrades();

    createSnapshotFromStep(details);

    showToast('Step recorded ✓  Holdings updated with entered units.');
  });

  els.resetAllBtn.addEventListener('click', async () => {
    if (!window.confirm('Reset all configuration and data? This cannot be undone.')) return;
    state = structuredClone(defaultState);
    _hasHistory = false;
    saveState();
    syncConfigInputsFromState();
    renderAssetsTable();
    renderSummaryAndNextStep();
    renderStepDetailsAndTrades();
    try {
      await fetch('/api/history', { method: 'DELETE' });
    } catch (err) {
      console.error('Failed to clear server history during reset', err);
    }
    fetchHistory();
  });

  ['initialValueInput', 'stepInput', 'maxAdditionInput', 'completedPeriodsInput', 'investedSoFarInput'].forEach(
    (key) => {
      const input = els[key];
      if (!input) return;
      input.addEventListener('change', () => {
        syncStateFromConfigInputs();
        saveState();
        renderSummaryAndNextStep();
        renderStepDetailsAndTrades();
      });
    }
  );

  if (els.refreshHistoryBtn) {
    els.refreshHistoryBtn.addEventListener('click', () => {
      fetchHistory();
    });
  }

  if (els.historyTableBody) {
    els.historyTableBody.addEventListener('click', async (e) => {
      const btn = e.target.closest('.history-delete-btn');
      if (!btn) return;
      const id = Number(btn.dataset.id);
      if (!id) return;
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
  fetchHistory();

  const isFirstRun = !state.config.initialValue && !state.config.stepPerPeriod;
  if (isFirstRun) {
    const panel = document.getElementById('settingsPanel');
    if (panel) panel.open = true;
  }
}

// ── Font toggle ──────────────────────────────────────────────────────────────
(function initFontToggle() {
  const FONT_KEY = 'va_font';
  const MONO_CLASS = 'font-mono-mode';

  const sansBtn = document.getElementById('fontSansBtn');
  const monoBtn = document.getElementById('fontMonoBtn');

  function applyFont(mono) {
    document.body.classList.toggle(MONO_CLASS, mono);
    if (sansBtn && monoBtn) {
      sansBtn.className = mono
        ? 'px-2.5 py-1 text-slate-500 hover:text-slate-300 transition-colors'
        : 'px-2.5 py-1 text-slate-300 bg-slate-800 transition-colors';
      monoBtn.className = mono
        ? 'px-2.5 py-1 text-slate-300 bg-slate-800 transition-colors font-mono'
        : 'px-2.5 py-1 text-slate-500 hover:text-slate-300 transition-colors font-mono';
    }
  }

  const saved = localStorage.getItem(FONT_KEY);
  applyFont(saved === 'mono');

  if (sansBtn) sansBtn.addEventListener('click', () => {
    localStorage.setItem(FONT_KEY, 'sans');
    applyFont(false);
  });
  if (monoBtn) monoBtn.addEventListener('click', () => {
    localStorage.setItem(FONT_KEY, 'mono');
    applyFont(true);
  });
})();

document.addEventListener('DOMContentLoaded', init);
