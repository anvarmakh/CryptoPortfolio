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
    maximumFractionDigits: value >= 1000 ? 0 : 2,
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
    // Summary
    lastUpdated: document.getElementById('lastUpdated'),
    currentValue: document.getElementById('currentValue'),
    investedAmount: document.getElementById('investedAmount'),
    pnlValue: document.getElementById('pnlValue'),
    pnlPercent: document.getElementById('pnlPercent'),

    summaryInitialTarget: document.getElementById('summaryInitialTarget'),
    summaryStep: document.getElementById('summaryStep'),
    summaryMax: document.getElementById('summaryMax'),
    summaryPeriods: document.getElementById('summaryPeriods'),

    nextTargetValue: document.getElementById('nextTargetValue'),
    nextTheoretical: document.getElementById('nextTheoretical'),
    nextRecommended: document.getElementById('nextRecommended'),
    nextDirection: document.getElementById('nextDirection'),

    // Config inputs
    initialValueInput: document.getElementById('initialValueInput'),
    stepInput: document.getElementById('stepInput'),
    maxAdditionInput: document.getElementById('maxAdditionInput'),
    periodsPerMonthInput: document.getElementById('periodsPerMonthInput'),
    completedPeriodsInput: document.getElementById('completedPeriodsInput'),
    investedSoFarInput: document.getElementById('investedSoFarInput'),

    // Assets
    assetsTableBody: document.getElementById('assetsTableBody'),
    allocationTotal: document.getElementById('allocationTotal'),

    // Step section
    stepError: document.getElementById('stepError'),
    stepCurrentValue: document.getElementById('stepCurrentValue'),
    stepTargetValue: document.getElementById('stepTargetValue'),
    stepTheoreticalChange: document.getElementById('stepTheoreticalChange'),
    stepCappedChange: document.getElementById('stepCappedChange'),
    stepDirection: document.getElementById('stepDirection'),
    stepPeriodIndex: document.getElementById('stepPeriodIndex'),
    stepEstimatedInvested: document.getElementById('stepEstimatedInvested'),
    pricesFetchStatus: document.getElementById('pricesFetchStatus'),

    tradesTableBody: document.getElementById('tradesTableBody'),

    // History
    historyTableBody: document.getElementById('historyTableBody'),
    historyError: document.getElementById('historyError'),

    // Other inputs
    priceProviderSelect: document.getElementById('priceProviderSelect'),
    refreshHistoryBtn: document.getElementById('refreshHistoryBtn'),

    // Buttons
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
  els.periodsPerMonthInput.value = config.periodsPerMonth || '';
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
  cfg.periodsPerMonth = Math.max(1, Number(els.periodsPerMonthInput.value) || 2);
  cfg.completedPeriods = Math.max(0, Number(els.completedPeriodsInput.value) || 0);
  const manualInvested = els.investedSoFarInput.value;
  if (manualInvested !== '') {
    cfg.investedSoFar = Number(manualInvested) || 0;
  }
}

function renderAssetsTable() {
  els.assetsTableBody.innerHTML = '';
  const fragment = document.createDocumentFragment();

  state.assets.forEach((asset, index) => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/60';

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
      <td class="py-2 pl-2 text-right">
        <button data-index="${index}" data-action="remove-asset"
                class="text-[11px] px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:border-rose-500 hover:text-rose-300 transition-colors">
          Remove
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

  els.currentValue.textContent = formatUSD(currentValue);
  els.investedAmount.textContent = formatUSD(invested);
  els.pnlValue.textContent = formatUSD(pnl);
  els.pnlValue.className =
    'text-lg md:text-xl font-semibold ' +
    (pnl > 0 ? 'text-emerald-300' : pnl < 0 ? 'text-rose-300' : 'text-slate-200');
  els.pnlPercent.textContent = formatPercent(pnlPct);

  const { config } = state;
  els.summaryInitialTarget.textContent = formatUSD(config.initialValue);
  els.summaryStep.textContent = formatUSD(config.stepPerPeriod);
  els.summaryMax.textContent = formatUSD(config.maxAddition);
  els.summaryPeriods.textContent = String(config.completedPeriods ?? 0);

  // Reuse computeStepDetails so the summary and the step section always agree.
  const { targetValue, theoreticalChange, cappedChange, direction } = computeStepDetails();

  els.nextTargetValue.textContent = formatUSD(targetValue);
  els.nextTheoretical.textContent = formatUSD(theoreticalChange);
  els.nextRecommended.textContent = formatUSD(cappedChange);

  let directionText = 'Hold';
  if (direction === 'Invest') directionText = `Invest ${formatUSD(cappedChange)}`;
  else if (direction === 'Withdraw') directionText = `Withdraw ${formatUSD(Math.abs(cappedChange))}`;
  els.nextDirection.textContent = directionText;
  els.nextDirection.className =
    'font-medium ' +
    (cappedChange > 0
      ? 'text-emerald-300'
      : cappedChange < 0
      ? 'text-rose-300'
      : 'text-slate-300');

  if (state.lastPricesFetch) {
    const date = new Date(state.lastPricesFetch);
    els.lastUpdated.textContent = `Last updated: ${date.toLocaleString()}`;
  } else {
    els.lastUpdated.textContent = 'Last updated: –';
  }
}

function computeStepDetails() {
  const { config } = state;
  const currentValue = computePortfolioValue();
  const nextPeriodIndex = (config.completedPeriods || 0) + 1;
  const targetValue = config.initialValue + nextPeriodIndex * config.stepPerPeriod;
  const theoreticalChange = targetValue - currentValue;

  let cappedChange = theoreticalChange;
  if (theoreticalChange > config.maxAddition) {
    cappedChange = config.maxAddition;
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
    els.stepError.textContent = 'Please add at least one asset.';
    els.stepError.classList.remove('hidden');
    return;
  }

  if (!config.stepPerPeriod || config.stepPerPeriod <= 0) {
    els.stepError.textContent = 'Please configure a valid step per period.';
    els.stepError.classList.remove('hidden');
    return;
  }

  // Warn when allocations don't sum to 100% — trades will be mis-weighted.
  const totalAlloc = assets.reduce((s, a) => s + (Number(a.allocation) || 0), 0);
  if (Math.abs(totalAlloc - 100) > 0.1) {
    els.stepError.textContent =
      `Allocation total is ${totalAlloc.toFixed(1)}% — normalize to exactly 100% for accurate per-asset trade suggestions.`;
    els.stepError.classList.remove('hidden');
    // Don't return: still render the computed values so the user can see them.
  }

  const details = computeStepDetails();
  els.stepCurrentValue.textContent = formatUSD(details.currentValue);
  els.stepTargetValue.textContent = formatUSD(details.targetValue);
  els.stepTheoreticalChange.textContent = formatUSD(details.theoreticalChange);
  els.stepCappedChange.textContent = formatUSD(details.cappedChange);
  els.stepPeriodIndex.textContent = String(details.nextPeriodIndex);
  els.stepEstimatedInvested.textContent = formatUSD(details.estimatedInvested);

  els.stepDirection.textContent =
    details.direction === 'Invest'
      ? `Invest ${formatUSD(details.cappedChange)}`
      : details.direction === 'Withdraw'
      ? `Withdraw ${formatUSD(Math.abs(details.cappedChange))}`
      : 'Hold';
  els.stepDirection.className =
    'font-medium ' +
    (details.cappedChange > 0
      ? 'text-emerald-300'
      : details.cappedChange < 0
      ? 'text-rose-300'
      : 'text-slate-200');

  const trades = computePerAssetTrades(details);

  els.tradesTableBody.innerHTML = '';
  const fragment = document.createDocumentFragment();

  trades.forEach((t) => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/60';
    tr.innerHTML = `
      <td class="py-2 pr-2 text-slate-100">${escapeHtml(t.symbol)}</td>
      <td class="py-2 px-2 text-right text-slate-200">${formatUSD(t.targetValue)}</td>
      <td class="py-2 px-2 text-right text-slate-200">${formatUSD(t.currentValue)}</td>
      <td class="py-2 px-2 text-right ${
        t.rawDelta >= 0 ? 'text-emerald-300' : 'text-rose-300'
      }">${formatUSD(t.rawDelta)}</td>
      <td class="py-2 px-2 text-right ${
        t.suggestedValue >= 0 ? 'text-emerald-300' : 'text-rose-300'
      }">${formatUSD(t.suggestedValue)}</td>
      <td class="py-2 pl-2 text-right text-slate-200">${
        Number.isFinite(t.suggestedUnits) ? t.suggestedUnits.toFixed(6) : '–'
      }</td>
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

  // Loading state on the button.
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
      '<td colspan="6" class="py-3 px-2 text-center text-xs text-slate-500">No snapshots yet. Apply a step to create the first one.</td>';
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

  ['initialValueInput', 'stepInput', 'maxAdditionInput', 'periodsPerMonthInput', 'completedPeriodsInput', 'investedSoFarInput'].forEach(
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
}

function init() {
  syncConfigInputsFromState();
  renderAssetsTable();
  renderSummaryAndNextStep();
  renderStepDetailsAndTrades();
  attachEventListeners();
  fetchPrices();
  fetchHistory();
}

document.addEventListener('DOMContentLoaded', init);

