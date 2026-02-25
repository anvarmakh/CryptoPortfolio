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
  priceProvider: 'coingecko',
  assets: [
    {
      id: 'bitcoin',
      symbol: 'BTC',
      allocation: 60,
      units: 0,
      price: 0,
    },
    {
      id: 'ethereum',
      symbol: 'ETH',
      allocation: 40,
      units: 0,
      price: 0,
    },
  ],
  lastPricesFetch: null,
};

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(defaultState);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(defaultState),
      ...parsed,
      config: { ...structuredClone(defaultState.config), ...(parsed.config || {}) },
      assets: Array.isArray(parsed.assets) && parsed.assets.length ? parsed.assets : structuredClone(defaultState.assets),
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

// Escape a string for safe use inside an HTML attribute (value="...").
function escapeAttr(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

// Escape a string for safe use as HTML text content.
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

    // Hero
    heroPeriod: document.getElementById('heroPeriod'),
    heroDirectionBadge: document.getElementById('heroDirectionBadge'),
    heroAmount: document.getElementById('heroAmount'),
    heroCurrentValue: document.getElementById('heroCurrentValue'),
    heroTargetValue: document.getElementById('heroTargetValue'),
    heroGap: document.getElementById('heroGap'),
    heroCappedNote: document.getElementById('heroCappedNote'),
    heroCap: document.getElementById('heroCap'),

    // Stats row
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

    // Step error
    stepError: document.getElementById('stepError'),
    pricesFetchStatus: document.getElementById('pricesFetchStatus'),

    // History
    historyTableBody: document.getElementById('historyTableBody'),
    historyError: document.getElementById('historyError'),

    // Buttons & controls
    priceProviderSelect: document.getElementById('priceProviderSelect'),
    refreshHistoryBtn: document.getElementById('refreshHistoryBtn'),
    saveConfigBtn: document.getElementById('saveConfigBtn'),
    addAssetBtn: document.getElementById('addAssetBtn'),
    rebalanceAllocBtn: document.getElementById('rebalanceAllocBtn'),
    refreshPricesBtn: document.getElementById('refreshPricesBtn'),
    applyStepBtn: document.getElementById('applyStepBtn'),
    resetAllBtn: document.getElementById('resetAllBtn'),
  };
}

const els = getElements();

function syncConfigInputsFromState() {
  const { config } = state;
  els.initialValueInput.value = config.initialValue || '';
  els.stepInput.value = config.stepPerPeriod || '';
  els.maxAdditionInput.value = config.maxAddition || '';
  // periodsPerMonth is kept in state for backwards-compat but no longer shown in the UI.
  els.completedPeriodsInput.value = config.completedPeriods || '';
  els.investedSoFarInput.value = config.investedSoFar || '';
  if (els.priceProviderSelect) {
    els.priceProviderSelect.value = state.priceProvider || 'coingecko';
  }
}

function syncStateFromConfigInputs() {
  const cfg = state.config;
  cfg.initialValue = Number(els.initialValueInput.value) || 0;
  cfg.stepPerPeriod = Number(els.stepInput.value) || 0;
  cfg.maxAddition = Number(els.maxAdditionInput.value) || 0;
  // periodsPerMonth no longer editable in UI; preserve whatever is in state.
  cfg.completedPeriods = Math.max(0, Number(els.completedPeriodsInput.value) || 0);
  const manualInvested = els.investedSoFarInput.value;
  if (manualInvested !== '') {
    cfg.investedSoFar = Number(manualInvested) || 0;
  }
}

function renderAssetsTable() {
  els.assetsTableBody.innerHTML = '';
  const fragment = document.createDocumentFragment();

  // Pre-compute total portfolio value so each row can show its actual weight.
  const totalPortfolioValue = computePortfolioValue();

  state.assets.forEach((asset, index) => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/60';

    const currentAssetValue = (Number(asset.price) || 0) * (Number(asset.units) || 0);
    const targetPct = Number(asset.allocation) || 0;

    let currentPctCell = '<td class="py-2 px-2 text-right text-slate-500">–</td>';
    if (totalPortfolioValue > 0 && currentAssetValue > 0) {
      const currentPct = (currentAssetValue / totalPortfolioValue) * 100;
      const drift = Math.abs(currentPct - targetPct);
      const color = drift <= 1 ? 'text-emerald-300' : drift <= 5 ? 'text-amber-300' : 'text-rose-300';
      const driftSign = currentPct >= targetPct ? '+' : '';
      const driftStr = `${driftSign}${(currentPct - targetPct).toFixed(1)}%`;
      currentPctCell = `<td class="py-2 px-2 text-right">
        <span class="${color} font-medium">${currentPct.toFixed(1)}%</span>
        <span class="text-[10px] text-slate-500 ml-1">${driftStr}</span>
      </td>`;
    }

    tr.innerHTML = `
      <td class="py-2 pr-2">
        <input data-index="${index}" data-field="symbol" type="text"
               class="w-20 md:w-24 rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/70 focus:border-emerald-400"
               value="${escapeAttr(asset.symbol)}" />
      </td>
      <td class="py-2 px-2">
        <input data-index="${index}" data-field="id" type="text"
               class="w-32 md:w-40 rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/70 focus:border-emerald-400"
               value="${escapeAttr(asset.id)}" placeholder="e.g. bitcoin, avalanche-2" />
      </td>
      <td class="py-2 px-2 text-right">
        <input data-index="${index}" data-field="allocation" type="number" step="0.1"
               class="number-input w-20 rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1 text-xs text-right text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/70 focus:border-emerald-400"
               value="${escapeAttr(asset.allocation ?? '')}" />
      </td>
      <td class="py-2 px-2 text-right">
        <input data-index="${index}" data-field="units" type="number" step="0.00000001"
               class="number-input w-24 rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1 text-xs text-right text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/70 focus:border-emerald-400"
               value="${escapeAttr(asset.units ?? '')}" />
      </td>
      <td class="py-2 px-2 text-right ${asset.price ? 'text-slate-200' : (state.lastPricesFetch ? 'text-amber-400' : 'text-slate-500')}">
        ${asset.price
          ? formatUSD(asset.price)
          : (state.lastPricesFetch ? '⚠ no price' : '–')}
      </td>
      <td class="py-2 px-2 text-right text-slate-200">
        ${asset.price && asset.units ? formatUSD(asset.price * asset.units) : '–'}
      </td>
      ${currentPctCell}
      <td class="py-2 pl-2 text-right">
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
    'font-semibold ' +
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
  const { config } = state;

  // ── Stats row ──────────────────────────────────────────────────
  els.statPortfolioValue.textContent = formatUSD(currentValue);
  els.statInvested.textContent = formatUSD(invested);

  els.statPnL.textContent = (pnl >= 0 ? '+' : '') + formatUSD(pnl);
  els.statPnL.className =
    'text-sm sm:text-xl font-bold ' +
    (pnl > 0 ? 'text-emerald-300' : pnl < 0 ? 'text-rose-300' : 'text-slate-200');

  els.statPnLPct.textContent = (pnl >= 0 ? '+' : '') + formatPercent(pnlPct);
  els.statPnLPct.className =
    'text-xs font-semibold mt-0.5 ' +
    (pnl > 0 ? 'text-emerald-300' : pnl < 0 ? 'text-rose-300' : 'text-slate-400');

  // ── Hero section ───────────────────────────────────────────────
  // Reuse computeStepDetails so hero and trades section always agree.
  const { targetValue, theoreticalChange, cappedChange, direction, nextPeriodIndex } =
    computeStepDetails();

  els.heroPeriod.textContent = String(nextPeriodIndex);
  els.heroCurrentValue.textContent = formatUSD(currentValue);
  els.heroTargetValue.textContent = formatUSD(targetValue);

  // Gap shows the raw distance; colour hints at whether we're under or over.
  els.heroGap.textContent = formatUSD(Math.abs(theoreticalChange));
  els.heroGap.className =
    'ml-1 font-medium ' +
    (theoreticalChange > 0.5
      ? 'text-emerald-300'
      : theoreticalChange < -0.5
      ? 'text-rose-300'
      : 'text-slate-300');

  // Only show the capped note when the cap actually bites.
  const isCapped =
    config.maxAddition > 0 && Math.abs(theoreticalChange) > config.maxAddition + 0.5;
  els.heroCappedNote.textContent = isCapped
    ? `(capped from ${formatUSD(Math.abs(theoreticalChange))})`
    : '';

  els.heroCap.textContent =
    config.maxAddition > 0 ? `±${formatUSD(config.maxAddition)} per step` : 'no cap';

  // Direction badge + big amount — these are the primary visual.
  if (direction === 'Invest') {
    els.heroDirectionBadge.textContent = '↑ Invest';
    els.heroDirectionBadge.className =
      'shrink-0 px-3 py-1.5 rounded-xl text-sm font-bold uppercase border ' +
      'text-emerald-300 bg-emerald-500/10 border-emerald-500/30';
    els.heroAmount.textContent = formatUSD(cappedChange);
    els.heroAmount.className = 'text-3xl sm:text-4xl font-bold tracking-tight text-emerald-300';
  } else if (direction === 'Withdraw') {
    els.heroDirectionBadge.textContent = '↓ Withdraw';
    els.heroDirectionBadge.className =
      'shrink-0 px-3 py-1.5 rounded-xl text-sm font-bold uppercase border ' +
      'text-rose-300 bg-rose-500/10 border-rose-500/30';
    els.heroAmount.textContent = formatUSD(Math.abs(cappedChange));
    els.heroAmount.className = 'text-3xl sm:text-4xl font-bold tracking-tight text-rose-300';
  } else {
    els.heroDirectionBadge.textContent = '— Hold';
    els.heroDirectionBadge.className =
      'shrink-0 px-3 py-1.5 rounded-xl text-sm font-bold uppercase border ' +
      'text-slate-400 bg-slate-800/60 border-slate-700';
    els.heroAmount.textContent = 'On target';
    els.heroAmount.className = 'text-xl sm:text-2xl font-semibold tracking-tight text-slate-400 self-center';
  }

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
      // Apply the cap symmetrically: a large withdrawal is also capped.
      cappedChange = -config.maxAddition;
    }
  }

  let direction = 'Hold';
  if (cappedChange > 0.5) direction = 'Invest';
  else if (cappedChange < -0.5) direction = 'Withdraw';

  // "Invested if applied" = what investedSoFar will become after clicking Apply Step.
  const estimatedInvested = (config.investedSoFar || 0) + cappedChange;
  // Note: estimatedPnL is intentionally NOT included here — by value-averaging design,
  // P&L (currentValue − invested) does not change when you make a perfectly-sized
  // step investment: both sides of the equation increase by the same cappedChange.

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

  // Warn when allocations don't sum to 100% — trades will be mis-weighted.
  const totalAlloc = assets.reduce((s, a) => s + (Number(a.allocation) || 0), 0);
  if (Math.abs(totalAlloc - 100) > 0.1) {
    els.stepError.textContent =
      `Allocation total is ${totalAlloc.toFixed(1)}% — it must equal exactly 100% for per-asset trade amounts to be correct.`;
    els.stepError.classList.remove('hidden');
    // Don't return: still render so the user can see the effect.
  }

  const details = computeStepDetails();
  const hasAction = Math.abs(details.cappedChange) >= 0.5;

  // Show/hide the trades panel vs the "no action" placeholder.
  els.tradesEmpty.classList.toggle('hidden', hasAction);
  els.tradesContent.classList.toggle('hidden', !hasAction);

  // Always update the step summary numbers (used inside tradesContent).
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

  if (!hasAction) return;

  // ── Per-asset trades table ─────────────────────────────────────
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

    const units = t.suggestedUnits;
    const unitsText =
      Number.isFinite(units) && Math.abs(units) >= 1e-8
        ? (units > 0 ? '+' : '') + units.toFixed(6)
        : '—';

    tr.innerHTML = `
      <td class="py-2 pr-2 text-slate-100 font-medium">${escapeHtml(t.symbol)}</td>
      <td class="py-2 px-2 text-center">${actionBadge}</td>
      <td class="py-2 px-2 text-right ${amountClass}">${amountText}</td>
      <td class="py-2 pl-2 text-right text-slate-500">${unitsText}</td>
    `;
    fragment.appendChild(tr);
  });

  els.tradesTableBody.appendChild(fragment);
}

function computePerAssetTrades(stepDetails) {
  const { targetValue, cappedChange } = stepDetails;
  const { assets } = state;

  const trades = assets.map((a) => {
    const allocation = Number(a.allocation) || 0;
    const units = Number(a.units) || 0;
    const price = Number(a.price) || 0;

    const targetAssetValue = (allocation / 100) * targetValue;
    const currentAssetValue = units * price;
    const rawDelta = targetAssetValue - currentAssetValue;

    return {
      id: a.id,
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

  // Deduplicate as pairs keyed by id so uniqueIds[i] always corresponds to uniqueSymbols[i].
  const seenIds = new Set();
  const uniqueIds = [];
  const uniqueSymbols = [];

  assets.forEach((a) => {
    const id = typeof a.id === 'string' ? a.id.trim() : '';
    if (id && !seenIds.has(id)) {
      seenIds.add(id);
      uniqueIds.push(id);
      uniqueSymbols.push(String(a.symbol || '').trim().toUpperCase());
    }
  });

  if (!uniqueIds.length) {
    els.stepError.textContent = 'Please set CoinGecko IDs (e.g. bitcoin, ethereum) for your assets.';
    els.stepError.classList.remove('hidden');
    return;
  }

  els.stepError.classList.add('hidden');
  els.stepError.textContent = '';
  if (els.pricesFetchStatus) {
    els.pricesFetchStatus.classList.add('hidden');
    els.pricesFetchStatus.textContent = '';
  }

  // Loading state on the Refresh prices button.
  const btn = els.refreshPricesBtn;
  const origLabel = btn.textContent;
  btn.textContent = 'Fetching…';
  btn.disabled = true;

  const provider = state.priceProvider || 'coingecko';

  const params = new URLSearchParams();
  params.set('provider', provider);
  params.set('ids', uniqueIds.join(','));
  params.set('symbols', uniqueSymbols.join(','));

  try {
    const res = await fetch(`/api/prices?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Price API error: ${res.status}`);
    }
    const data = await res.json();

    // Track which IDs the API actually returned prices for.
    const returnedIds = new Set(Object.keys(data));

    state.assets.forEach((asset) => {
      const id = asset.id;
      if (id && data[id] && typeof data[id].usd === 'number') {
        asset.price = data[id].usd;
      }
    });

    // Identify assets whose IDs were sent but got no price back.
    const failedAssets = state.assets.filter((a) => {
      const id = typeof a.id === 'string' ? a.id.trim() : '';
      return id && !returnedIds.has(id);
    });

    if (failedAssets.length > 0 && els.pricesFetchStatus) {
      const list = failedAssets
        .map((a) => `<strong>${escapeHtml(a.symbol || a.id)}</strong> (ID: <code>${escapeHtml(a.id)}</code>)`)
        .join(', ');
      els.pricesFetchStatus.innerHTML =
        `Price not found for: ${list}. ` +
        `Check the CoinGecko ID — common fixes: ` +
        `AVAX&nbsp;→&nbsp;<code>avalanche-2</code>, ` +
        `INJ&nbsp;→&nbsp;<code>injective-protocol</code>, ` +
        `MATIC&nbsp;→&nbsp;<code>matic-network</code>.`;
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

  if (!Array.isArray(rows) || !rows.length) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td colspan="7" class="py-3 px-2 text-center text-xs text-slate-500">No snapshots yet. Apply a step to create the first one.</td>';
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
      <td class="py-2 px-2 text-slate-200">${date ? date.toLocaleString() : '–'}</td>
      <td class="py-2 px-2 text-right text-slate-200">${row.period_index}</td>
      <td class="py-2 px-2 text-right text-slate-200">${formatUSD(row.invested)}</td>
      <td class="py-2 px-2 text-right text-slate-200">${formatUSD(row.portfolio_value)}</td>
      <td class="py-2 px-2 text-right ${pnlClass}">${formatUSD(row.pnl)}</td>
      <td class="py-2 px-2 text-right ${pnlClass}">${formatPercent(row.pnl_percent)}</td>
      <td class="py-2 pl-2 text-right">
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
    const portfolioValueAfter = details.currentValue + details.cappedChange;
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
      },
    };

    const res = await fetch('/api/history', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`History save failed: ${res.status}`);
    }

    await res.json(); // consume the response
    // Always re-fetch the full list so the table stays consistent with the server.
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

function attachEventListeners() {
  els.saveConfigBtn.addEventListener('click', () => {
    syncStateFromConfigInputs();
    saveState();
    renderSummaryAndNextStep();
    renderStepDetailsAndTrades();
    // Brief visual confirmation.
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
      id: '',
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

    if (field === 'symbol' || field === 'id') {
      asset[field] = String(target.value || '').trim();
    } else if (field === 'allocation') {
      asset.allocation = Number(target.value) || 0;
      // Surgically update the allocation total without re-rendering the table.
      const total = state.assets.reduce((s, a) => s + (Number(a.allocation) || 0), 0);
      els.allocationTotal.textContent = `${total.toFixed(1)}%`;
      els.allocationTotal.className =
        'font-semibold ' +
        (Math.abs(total - 100) < 0.01 ? 'text-emerald-300' : 'text-amber-300');
    } else if (field === 'units') {
      asset.units = Number(target.value) || 0;
      // Surgically update only the value cell (cells[5]) for this row.
      const tr = target.closest('tr');
      if (tr && tr.cells[5]) {
        tr.cells[5].textContent =
          asset.price && asset.units ? formatUSD(asset.price * asset.units) : '–';
      }
    }

    saveState();
    // Do NOT call renderAssetsTable() here — it destroys all inputs and loses
    // cursor position. Only the computed panels below the table need updating.
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

  els.rebalanceAllocBtn.addEventListener('click', () => {
    if (!state.assets.length) return;
    const equal = 100 / state.assets.length;
    state.assets.forEach((a) => {
      a.allocation = equal;
    });
    saveState();
    renderAssetsTable();
    renderSummaryAndNextStep();
    renderStepDetailsAndTrades();
  });

  els.refreshPricesBtn.addEventListener('click', () => {
    fetchPrices();
  });

  els.applyStepBtn.addEventListener('click', () => {
    const details = computeStepDetails();
    const { config } = state;
    config.completedPeriods = (config.completedPeriods || 0) + 1;
    config.investedSoFar = (config.investedSoFar || 0) + details.cappedChange;
    els.investedSoFarInput.value = config.investedSoFar;

    saveState();
    renderSummaryAndNextStep();
    renderStepDetailsAndTrades();

    // Persist a snapshot on the backend
    createSnapshotFromStep(details);

    // Remind user to update their holdings after executing trades.
    showToast(
      'Step recorded ✓  Update your asset units in Holdings to reflect the trades you executed.'
    );
  });

  els.resetAllBtn.addEventListener('click', async () => {
    if (!window.confirm('Reset all configuration and data? This cannot be undone.')) return;
    state = structuredClone(defaultState);
    saveState();
    syncConfigInputsFromState();
    renderAssetsTable();
    renderSummaryAndNextStep();
    renderStepDetailsAndTrades();
    // Also wipe server-side history so the table doesn't repopulate on reload.
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

  if (els.priceProviderSelect) {
    els.priceProviderSelect.addEventListener('change', () => {
      state.priceProvider = els.priceProviderSelect.value || 'coingecko';
      saveState();
      fetchPrices();
    });
  }

  if (els.refreshHistoryBtn) {
    els.refreshHistoryBtn.addEventListener('click', () => {
      fetchHistory();
    });
  }

  // Per-row delete: single delegated listener on the table body.
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

function init() {
  syncConfigInputsFromState();
  renderAssetsTable();
  renderSummaryAndNextStep();
  renderStepDetailsAndTrades();
  attachEventListeners();
  fetchPrices();
  fetchHistory();

  // Auto-open settings panel for first-time users who haven't configured anything yet.
  const isFirstRun = !state.config.initialValue && !state.config.stepPerPeriod;
  if (isFirstRun) {
    const panel = document.getElementById('settingsPanel');
    if (panel) panel.open = true;
  }
}

// ── Font toggle ──────────────────────────────────────────────────────────────
(function initFontToggle() {
  const STORAGE_KEY = 'va_font';
  const MONO_CLASS = 'font-mono-mode';

  const sansBtn = document.getElementById('fontSansBtn');
  const monoBtn = document.getElementById('fontMonoBtn');

  function applyFont(mono) {
    document.body.classList.toggle(MONO_CLASS, mono);
    // Active button: filled/bright. Inactive: dim.
    if (sansBtn && monoBtn) {
      sansBtn.className = mono
        ? 'px-2.5 py-1 text-slate-500 hover:text-slate-300 transition-colors'
        : 'px-2.5 py-1 text-slate-300 bg-slate-800 transition-colors';
      monoBtn.className = mono
        ? 'px-2.5 py-1 text-slate-300 bg-slate-800 transition-colors font-mono'
        : 'px-2.5 py-1 text-slate-500 hover:text-slate-300 transition-colors font-mono';
    }
  }

  const saved = localStorage.getItem(STORAGE_KEY);
  applyFont(saved === 'mono');

  if (sansBtn) sansBtn.addEventListener('click', () => {
    localStorage.setItem(STORAGE_KEY, 'sans');
    applyFont(false);
  });
  if (monoBtn) monoBtn.addEventListener('click', () => {
    localStorage.setItem(STORAGE_KEY, 'mono');
    applyFont(true);
  });
})();

document.addEventListener('DOMContentLoaded', init);

