<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import TerminalAlert from './components/terminal/TerminalAlert.svelte';
  import CurrencySelector from './components/CurrencySelector.svelte';
  import BondPanel from './position-tracker/BondPanel.svelte';
  import BondMetrics from './position-tracker/BondMetrics.svelte';
  import BondHistory from './position-tracker/BondHistory.svelte';
  import LpPanel from './position-tracker/LpPanel.svelte';
  import TcyPanel from './position-tracker/TcyPanel.svelte';
  import WalletModal from './position-tracker/WalletModal.svelte';
  import ActionModal from './position-tracker/ActionModal.svelte';
  import './position-tracker/tracker.css';
  import {
    addAddresses,
    displayAddress,
    isThorAddress,
    loadTrackedAddresses,
    normalizeTrackedAddress,
    pickRandomBondAddress,
    relabelAddress,
    removeAddress,
    saveTrackedAddresses,
    MAX_TRACKED_ADDRESSES
  } from './position-tracker/addresses.js';
  import { loadActionGates, loadBonds, loadLiquidity, loadMarket, loadNodes, loadTcy } from './position-tracker/data.js';
  import { COMPACT_MAX_WIDTH, getTrackerStorage, isCompactLayout, loadLayoutPreference, saveLayoutPreference } from './position-tracker/layout.js';
  import { buildRuneRows, rowsFor, summarize, summarizeByAddress } from './position-tracker/model.js';
  import { fmtAmount, fmtPct, shortAddr } from './position-tracker/format.js';
  import { walletAccounts, connectedWallets } from './limit-orders/store.js';
  import { currentCurrency, exchangeRates, formatCurrency, formatCurrencyWithDecimals, initCurrency } from './stores/currency.js';
  import { formatCountdown } from './utils/formatting.js';

  const TABS = [
    { id: 'bond', key: '1', label: 'bond' },
    { id: 'lp', key: '2', label: 'lp' },
    { id: 'tcy', key: '3', label: 'tcy' }
  ];
  // The compact view moves totals and addresses behind a tab so the bond board fits on one screen.
  const PORTFOLIO_TAB = { id: 'portfolio', key: '4', label: 'portfolio' };
  const STALE_AFTER_MS = 5 * 60 * 1000;
  const TAB_KEY = 'position_tracker_tab';
  const ALLOCATION = [
    { id: 'rune', label: 'held rune', key: 'runeUsd' },
    { id: 'bond', label: 'bond', key: 'bondUsd' },
    { id: 'lp', label: 'liquidity', key: 'lpUsd' },
    { id: 'tcy', label: 'tcy', key: 'tcyUsd' }
  ];

  let tracked = [];
  let addressesExpanded = true;
  let addressInput = '';
  let addressFeedback = '';
  let randomLoading = false;
  let editingLabel = '';
  let labelDraft = '';
  let focusAddress = '';

  let activeTab = 'bond';
  let loading = false;
  let loadedOnce = false;
  let lastUpdated = null;
  let errors = [];
  let requestId = 0;

  let market = { runePriceUsd: 0, tcyPriceUsd: 0, prices: {}, pools: [], churnState: null };
  let gates = {};
  let bondRows = [];
  let bondNodes = [];
  let nodesExpanded = false;
  let bondHistory = [];
  let bondHistoryLoading = false;
  let bondHistoryLoaded = false;
  let bondHistoryError = '';
  let bondHistoryScope = '';
  let lpRows = [];
  let tcyRows = [];
  let claimRows = [];
  let walletBalances = {};

  let walletOpen = false;
  let actionSpec = null;
  let refreshTimer = null;
  let clockTimer = null;
  let now = Date.now() / 1000;
  let viewportWidth = 1024;
  let layoutPreference = loadLayoutPreference();
  let layoutToggleButton;

  // Whole units hide small payouts and LP drift, so values under 100 keep their decimals.
  $: money = (usd) => (Math.abs(usd) > 0 && Math.abs(usd) < 100 ? formatCurrencyWithDecimals : formatCurrency)($exchangeRates, usd, $currentCurrency);
  $: addresses = tracked.map((entry) => entry.address);
  $: labels = Object.fromEntries(tracked.map((entry) => [entry.address, displayAddress(entry)]));
  $: runeRows = buildRuneRows({ addresses, walletBalances, runePriceUsd: market.runePriceUsd });
  $: view = {
    runeRows: rowsFor(runeRows, focusAddress),
    bondRows: rowsFor(bondRows, focusAddress),
    lpRows: rowsFor(lpRows, focusAddress),
    tcyRows: rowsFor(tcyRows, focusAddress),
    claimRows: rowsFor(claimRows, focusAddress)
  };
  $: totals = summarize(view);
  $: portfolioUsd = summarize({ bondRows, lpRows, tcyRows, runeRows }).totalUsd;
  $: addressRows = summarizeByAddress({ addresses, bondRows, lpRows, tcyRows, runeRows }).map((row, index) => ({ ...tracked[index], ...row }));
  $: allocation = ALLOCATION.map((part) => ({ ...part, share: totals.totalUsd > 0 ? totals[part.key] / totals.totalUsd : 0 }));
  $: bondedAddresses = [...new Set(view.bondRows.map((row) => row.address))];
  // Clear summary values immediately when the selected address changes, even
  // when its empty current bond list removes the history component entirely.
  $: {
    const scope = [...bondedAddresses].sort().join(',');
    if (scope !== bondHistoryScope) {
      bondHistoryScope = scope;
      bondHistory = [];
      bondHistoryLoading = false;
      bondHistoryLoaded = false;
      bondHistoryError = '';
    }
  }
  $: thorTracked = addresses.filter(isThorAddress);
  $: hasThor = focusAddress ? isThorAddress(focusAddress) : thorTracked.length > 0;
  $: connectedNew = $walletAccounts.filter((account) => !addresses.includes(account.address.toLowerCase()) && !addresses.includes(account.address));
  $: nextChurnIn = market.churnState?.nextChurnTimestamp ? formatCountdown(market.churnState.nextChurnTimestamp - now) : '';
  $: churnProgress = churnElapsed(market.churnState, now);
  $: tabCounts = { bond: view.bondRows.length, lp: view.lpRows.length, tcy: view.tcyRows.length + view.claimRows.length };
  $: statusLabel = loading ? 'SYNCING' : errors.length ? 'DEGRADED' : loadedOnce ? 'LIVE' : 'IDLE';
  $: compact = isCompactLayout(viewportWidth, layoutPreference);
  $: tabs = compact ? [...TABS, PORTFOLIO_TAB] : TABS;
  // The desktop layout shows the portfolio block, so a saved portfolio tab opens bonds there.
  $: panel = !compact && activeTab === PORTFOLIO_TAB.id ? 'bond' : activeTab;
  $: showPortfolio = !compact || panel === PORTFOLIO_TAB.id || !tracked.length;
  $: bondOwners = [...new Set(bondRows.map((row) => row.address))];
  $: scopeOptions = [...new Set([...bondOwners, focusAddress].filter(Boolean))];
  $: updatedAt = lastUpdated ? lastUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  $: bondMetricsProps = {
    rows: view.bondRows,
    history: bondHistory,
    loading,
    loadedOnce,
    historyLoading: bondHistoryLoading,
    loaded: bondedAddresses.length ? bondHistoryLoaded : loadedOnce,
    error: bondHistoryError,
    bondError: errors.find((message) => message.startsWith('bonds —') || message.startsWith('market data —')) || '',
    runePriceUsd: market.runePriceUsd,
    money,
    nextChurnIn,
    churnProgress,
    churnHalted: !!market.churnState?.isHalted,
    nodesExpanded
  };

  function churnElapsed(churnState, nowSec) {
    const start = Number(churnState?.lastChurnTimestamp) || 0;
    const end = Number(churnState?.nextChurnTimestamp) || 0;
    if (!start || end <= start) return null;
    return Math.min(1, Math.max(0, (nowSec - start) / (end - start)));
  }

  function persist(list) {
    tracked = list;
    if (!list.length) addressesExpanded = true;
    saveTrackedAddresses(list, getTrackerStorage());
    syncUrl();
  }

  function syncUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete('bond_address');
    url.searchParams.delete('node_address');
    if (tracked.length) url.searchParams.set('addresses', tracked.map((entry) => entry.address).join(','));
    else url.searchParams.delete('addresses');
    window.history.replaceState({}, '', url);
  }

  function submitAddresses(event) {
    event?.preventDefault();
    const { list, added, rejected } = addAddresses(tracked, addressInput);
    addressFeedback = rejected.length
      ? `Skipped ${rejected.length} entr${rejected.length === 1 ? 'y' : 'ies'} that ${list.length >= MAX_TRACKED_ADDRESSES ? 'exceed the limit or ' : ''}aren't recognized addresses: ${rejected.slice(0, 3).map((value) => shortAddr(value)).join(', ')}`
      : '';
    if (added.length) {
      addressInput = '';
      persist(list);
      refresh();
    }
  }

  function addConnected() {
    const { list, added } = addAddresses(tracked, connectedNew.map((account) => account.address).join(','));
    if (added.length) {
      persist(list);
      refresh();
    }
  }

  async function trackRandomBondProvider() {
    if (randomLoading) return;
    randomLoading = true;
    addressFeedback = '';
    try {
      const nodes = await loadNodes();
      const address = pickRandomBondAddress(nodes);
      if (!address) throw new Error('No active bond providers with more than 1 RUNE were found.');
      const { list, added, rejected } = addAddresses(tracked, address);
      if (rejected.length) throw new Error(`Remove an address before adding another; the limit is ${MAX_TRACKED_ADDRESSES}.`);
      if (added.length) persist(list);
      focusAddress = address;
      selectTab('bond');
      await refresh();
    } catch (error) {
      addressFeedback = `Unable to load a random bond provider. ${error.message}`;
    } finally {
      randomLoading = false;
    }
  }

  function untrack(address) {
    if (focusAddress === address) focusAddress = '';
    persist(removeAddress(tracked, address));
    refresh();
  }

  function toggleFocus(address) {
    focusAddress = focusAddress === address ? '' : address;
  }

  function startLabel(entry) {
    editingLabel = entry.address;
    labelDraft = entry.label;
  }

  function saveLabel() {
    persist(relabelAddress(tracked, editingLabel, labelDraft));
    editingLabel = '';
  }

  async function refresh() {
    const id = ++requestId;
    const list = tracked.map((entry) => entry.address);
    if (!list.length) {
      bondRows = [];
      lpRows = [];
      tcyRows = [];
      claimRows = [];
      walletBalances = {};
      errors = [];
      return;
    }
    loading = true;
    const nextErrors = [];
    try {
      const nextMarket = await loadMarket();
      if (id !== requestId) return;
      market = nextMarket;
      const [bonds, liquidity, tcy, nextGates] = await Promise.all([
        loadBonds(list, nextMarket, { fresh: loadedOnce }).catch((error) => { nextErrors.push(`bonds — ${error.message}`); return null; }),
        loadLiquidity(list, nextMarket).catch((error) => { nextErrors.push(`liquidity — ${error.message}`); return null; }),
        loadTcy(list, nextMarket).catch((error) => { nextErrors.push(`tcy — ${error.message}`); return null; }),
        loadActionGates()
      ]);
      if (id !== requestId) return;
      if (bonds) {
        bondRows = bonds.rows;
        bondNodes = bonds.nodes;
      }
      if (liquidity) {
        lpRows = liquidity.rows;
        nextErrors.push(...liquidity.errors.map((message) => `liquidity — ${message}`));
      }
      if (tcy) {
        tcyRows = tcy.rows;
        claimRows = tcy.claimRows;
        walletBalances = tcy.walletBalances;
        nextErrors.push(...tcy.errors);
      } else {
        walletBalances = {};
      }
      gates = nextGates;
      lastUpdated = new Date();
      loadedOnce = true;
    } catch (error) {
      if (id === requestId) nextErrors.push(`market data — ${error.message}`);
    } finally {
      if (id === requestId) {
        errors = nextErrors;
        loading = false;
      }
    }
  }

  function selectTab(id) {
    activeTab = id;
    try { localStorage.setItem(TAB_KEY, id); } catch { /* storage unavailable */ }
  }

  async function toggleLayout() {
    layoutPreference = layoutPreference === 'mobile' ? 'auto' : 'mobile';
    saveLayoutPreference(layoutPreference);
    await tick();
    layoutToggleButton?.focus();
  }

  function openAction(event) {
    actionSpec = event.detail;
  }

  function handleSubmitted() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 15000);
  }

  function handleKeydown(event) {
    // Any open dialog (including the footer's coffee modal) keeps the keyboard.
    if (walletOpen || actionSpec || document.querySelector('[aria-modal="true"]')) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const key = event.key.toLowerCase();
    if (key === 'escape') focusAddress = '';
    else if (key === 'r' && !loading) refresh();
    else if (key === 'w') walletOpen = true;
    else {
      const tab = tabs.find((item) => item.key === key);
      if (tab) selectTab(tab.id);
    }
  }

  // A tab left open (often a phone's background tab) catches up when it is looked at again.
  function refreshIfStale() {
    if (document.visibilityState !== 'visible' || loading || !tracked.length || !lastUpdated) return;
    if (Date.now() - lastUpdated.getTime() >= STALE_AFTER_MS) refresh();
  }

  function isKnownTab(id) {
    return TABS.some((tab) => tab.id === id) || id === PORTFOLIO_TAB.id;
  }

  onMount(() => {
    initCurrency();
    tracked = loadTrackedAddresses({ storage: getTrackerStorage(), search: window.location.search });
    addressesExpanded = tracked.length === 0;
    const params = new URLSearchParams(window.location.search);
    const legacyAddress = params.has('addresses') ? '' : normalizeTrackedAddress(params.get('bond_address'));
    if (legacyAddress && tracked.some((entry) => entry.address === legacyAddress)) focusAddress = legacyAddress;
    const sharedTab = params.get('tab');
    if (isKnownTab(sharedTab)) activeTab = sharedTab;
    else if (legacyAddress) activeTab = 'bond';
    else {
      try {
        const savedTab = localStorage.getItem(TAB_KEY);
        if (isKnownTab(savedTab)) activeTab = savedTab;
      } catch { /* storage unavailable */ }
    }
    if (tracked.length) {
      saveTrackedAddresses(tracked, getTrackerStorage());
      syncUrl();
      refresh();
    }
    clockTimer = setInterval(() => {
      now = Date.now() / 1000;
      refreshIfStale();
    }, 30000);
  });

  onDestroy(() => {
    clearTimeout(refreshTimer);
    clearInterval(clockTimer);
  });
</script>

<svelte:window on:keydown={handleKeydown} bind:innerWidth={viewportWidth} />
<svelte:document on:visibilitychange={refreshIfStale} />

<section class="ptrack" class:compact>
  {#if compact}
    <div class="mbar">
      <h1 class="sr-only">Thorfolio</h1>
      <span class="status" title={statusLabel === 'LIVE' ? `Updated ${lastUpdated?.toLocaleTimeString()}` : statusLabel.toLowerCase()}>
        <span class="dot" class:ok={statusLabel === 'LIVE'} class:warn={statusLabel === 'DEGRADED' || statusLabel === 'SYNCING'}></span>
        {loading ? 'syncing' : updatedAt || statusLabel.toLowerCase()}
      </span>
      <button class="bracket-btn" on:click={refresh} disabled={loading || !tracked.length} aria-label="Refresh">
        <span class="bracket">[</span><span class="key">R</span><span class="bracket">]</span><span class="btn-label">refresh</span>
      </button>
      <button class="bracket-btn" class:active={$walletAccounts.length > 0} on:click={() => (walletOpen = true)} aria-label="Wallet">
        <span class="bracket">[</span><span class="key">W</span><span class="bracket">]</span><span class="btn-label">{$walletAccounts.length ? `wallet · ${$connectedWallets.length}` : 'wallet'}</span>
      </button>
      {#if viewportWidth > COMPACT_MAX_WIDTH}
        <button type="button" class="bracket-btn" bind:this={layoutToggleButton} on:click={toggleLayout} aria-label={compact ? 'Use desktop view' : 'Use mobile view'}>
          <span class="bracket" aria-hidden="true">[</span>
          desktop view
          <span class="bracket" aria-hidden="true">]</span>
        </button>
      {/if}
      <CurrencySelector />
    </div>
  {:else}
  <div class="head">
    <div class="head-top">
      <div class="head-left">
        <span class="prompt">$</span>
        <span class="cmd">track</span>
        <span class="arg">--rune --bond --lp --tcy · {tracked.length} address{tracked.length === 1 ? '' : 'es'}</span>
      </div>
      <div class="head-right">
        <CurrencySelector />
        <span class="status">
          <span class="dot" class:ok={statusLabel === 'LIVE'} class:warn={statusLabel === 'DEGRADED' || statusLabel === 'SYNCING'}></span>
          {statusLabel}
        </span>
        <span class="sep">│</span>
        <div class="head-actions">
          <button class="bracket-btn" class:active={$walletAccounts.length > 0} on:click={() => (walletOpen = true)}>
            <span class="bracket">[</span><span class="key">W</span><span class="bracket">]</span>
            {$walletAccounts.length ? `wallet · ${$connectedWallets.length}` : 'connect wallet'}
          </button>
          <button class="bracket-btn" on:click={refresh} disabled={loading || !tracked.length}>
            <span class="bracket">[</span><span class="key">R</span><span class="bracket">]</span>
            {loading ? 'refreshing' : 'refresh'}
          </button>
          <button type="button" class="bracket-btn" bind:this={layoutToggleButton} on:click={toggleLayout} aria-label={compact ? 'Use desktop view' : 'Use mobile view'}>
            <span class="bracket" aria-hidden="true">[</span>
            mobile view
            <span class="bracket" aria-hidden="true">]</span>
          </button>
        </div>
      </div>
    </div>
    <h1 class="title">THORFOLIO<span class="cursor">_</span></h1>
    <p class="lede">
      RUNE holdings, bonds, liquidity and TCY across all your addresses. Connect a wallet to manage positions; every
      transaction is shown for review before you sign.
    </p>
    <div class="rule"></div>
  </div>
  {/if}

  {#if compact && tracked.length}
    <div class="tabs" role="tablist">
      {#each tabs as tab}
        <button class="tab" class:active={activeTab === tab.id} role="tab" aria-selected={activeTab === tab.id} on:click={() => selectTab(tab.id)}>
          {tab.label}
          {#if tab.id !== PORTFOLIO_TAB.id}<span class="tab-count" class:zero={loadedOnce && !tabCounts[tab.id]}>{loadedOnce ? tabCounts[tab.id] : '·'}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}

  {#if tracked.length && showPortfolio}
    <div class="portfolio-summary">
    <div class="metric-grid portfolio-metrics">
      <div class="metric">
        <span class="metric-index">01</span>
        <span class="metric-label">{focusAddress ? 'address total' : 'total tracked'}</span>
        <strong class="metric-value">{loadedOnce ? money(totals.totalUsd) : '—'}</strong>
        <span class="metric-sub">RUNE ${fmtAmount(market.runePriceUsd, 3)} · TCY ${fmtAmount(market.tcyPriceUsd, 4)}</span>
        {#if loadedOnce && (totals.runeBalanceMissing || totals.tcyBalanceMissing)}<span class="metric-sub warn-text">Partial · {totals.runeBalanceMissing ? 'wallet balances' : 'TCY balances'} unavailable</span>{/if}
      </div>
      <div class="metric">
        <span class="metric-index">02</span>
        <span class="metric-label">rune held</span>
        <strong class="metric-value">{loadedOnce && (!view.runeRows.length || totals.runeBalanceMissing < view.runeRows.length) ? money(totals.runeUsd) : '—'}</strong>
        <span class="metric-sub">{!loadedOnce ? 'Loading wallet balances…' : totals.runeBalanceMissing === view.runeRows.length && view.runeRows.length ? 'Balance unavailable' : `${fmtAmount(totals.runeHeld, 8)} ᚱ in wallets`}</span>
        {#if loadedOnce && totals.runeBalanceMissing && totals.runeBalanceMissing < view.runeRows.length}<span class="metric-sub warn-text">Partial · {totals.runeBalanceMissing} balance{totals.runeBalanceMissing === 1 ? '' : 's'} unavailable</span>{/if}
      </div>
      <div class="metric">
        <span class="metric-index">03</span>
        <span class="metric-label">bonded</span>
        <strong class="metric-value">{loadedOnce ? money(totals.bondUsd) : '—'}</strong>
        <span class="metric-sub">{fmtAmount(totals.bondRune, 0)} ᚱ · +{fmtAmount(totals.pendingRewardRune, 2)} ᚱ pending</span>
      </div>
      <button class="metric metric-action" type="button" aria-label="Show LP tab" aria-pressed={activeTab === 'lp'} on:click={() => selectTab('lp')}>
        <span class="metric-index">04</span>
        <span class="metric-label">liquidity</span>
        <strong class="metric-value">{loadedOnce ? money(totals.lpUsd) : '—'}</strong>
        <span class="metric-sub" class:pos={totals.lpGainUsd > 0} class:neg={totals.lpGainUsd < 0}>
          {view.lpRows.length} position{view.lpRows.length === 1 ? '' : 's'} · {totals.lpGainUsd >= 0 ? '+' : ''}{money(totals.lpGainUsd)} vs deposit
        </span>
      </button>
      <button class="metric metric-action" type="button" aria-label="Show TCY tab" aria-pressed={activeTab === 'tcy'} on:click={() => selectTab('tcy')}>
        <span class="metric-index">05</span>
        <span class="metric-label">tcy</span>
        <strong class="metric-value">{loadedOnce && !totals.tcyBalanceMissing ? money(totals.tcyUsd) : '—'}</strong>
        <span class="metric-sub">{totals.tcyStakeMissing ? 'Stake unavailable' : `${fmtAmount(totals.tcyStaked, 0)} TCY`} · {fmtAmount(totals.tcyPayoutRune, 2)} ᚱ paid out</span>
        {#if loadedOnce && totals.tcyBalanceMissing}<span class="metric-sub warn-text">{totals.tcyUsd > 0 ? `Partial · ${money(totals.tcyUsd)} known` : 'Balance unavailable'}</span>{/if}
      </button>
      <div class="alloc">
        <div class="alloc-bar" role="img" aria-label={allocation.map((part) => `${part.label} ${fmtPct(part.share * 100, 1)}`).join(', ')}>
          {#each allocation as part (part.id)}
            {#if part.share > 0}<span class="alloc-seg {part.id}" style="flex-grow: {part.share}"></span>{/if}
          {/each}
        </div>
        <ul class="alloc-legend">
          {#each allocation as part (part.id)}
            <li class:zero={!part.share}><span class="alloc-key {part.id}"></span>{part.label} <b>{loadedOnce ? fmtPct(part.share * 100, 1) : '—'}</b></li>
          {/each}
        </ul>
      </div>
    </div>
    </div>
  {/if}

  {#if showPortfolio}
  <section class="block">
    <div class="block-head" class:collapsed={!addressesExpanded}>
      <div class="block-title">
        <span class="title-marker" aria-hidden="true">▌</span>
        <h2>
          <button class="address-toggle" type="button" aria-expanded={addressesExpanded} aria-controls="tracked-addresses-content" on:click={() => addressesExpanded = !addressesExpanded}>
            addresses <span class="toggle-state" aria-hidden="true">[{addressesExpanded ? '−' : '+'}]</span>
          </button>
        </h2>
      </div>
      <div class="block-meta">[{tracked.length}/{MAX_TRACKED_ADDRESSES}]</div>
    </div>

    <div id="tracked-addresses-content" hidden={!addressesExpanded}>
      {#if tracked.length && compact}
        <ul class="addr-list">
          {#each addressRows as row (row.address)}
            <li class:focused={focusAddress === row.address}>
              {#if editingLabel === row.address}
                <form class="label-form" on:submit|preventDefault={saveLabel}>
                  <span class="chip-chain">{row.chain}</span>
                  <!-- svelte-ignore a11y_autofocus -->
                  <input class="label-input" bind:value={labelDraft} maxlength="32" placeholder="label" aria-label="Label for {row.address}" autofocus on:blur={saveLabel} />
                </form>
              {:else}
                <button
                  class="addr-focus"
                  aria-pressed={focusAddress === row.address}
                  title={focusAddress === row.address ? 'Show all addresses' : `Show only ${row.address}`}
                  on:click={() => toggleFocus(row.address)}
                >
                  <span class="chip-chain">{row.chain}</span>
                  {#if row.label}<b>{row.label}</b><span class="addr-text">…{row.address.slice(-4)}</span>{:else}<span class="addr-text">{shortAddr(row.address, 8, 4)}</span>{/if}
                </button>
              {/if}
              <span class="addr-total">
                {loadedOnce ? money(row.totalUsd) : '—'}{#if loadedOnce && (row.runeBalanceMissing || row.tcyBalanceMissing)}<span class="tag">partial</span>{/if}
              </span>
              <span class="addr-actions">
                <button class="row-btn" aria-label="Label {row.address}" on:click={() => startLabel(row)}>label</button>
                <button class="row-btn remove" aria-label="Stop tracking {row.address}" title="Stop tracking" on:click={() => untrack(row.address)}>×</button>
              </span>
            </li>
          {/each}
        </ul>
      {:else if tracked.length}
        <div class="table-wrap addr-wrap">
          <table class="table addr-table">
            <thead>
              <tr>
                <th>address</th>
                <th class="right">rune held</th>
                <th class="right">bonded</th>
                <th class="right">liquidity</th>
                <th class="right">tcy</th>
                <th class="right">total</th>
                <th class="right">share</th>
                <th class="right"><span class="sr-only">manage</span></th>
              </tr>
            </thead>
            <tbody>
              {#each addressRows as row (row.address)}
                <tr class:focused={focusAddress === row.address}>
                  <td>
                    {#if editingLabel === row.address}
                      <form class="label-form" on:submit|preventDefault={saveLabel}>
                        <span class="chip-chain">{row.chain}</span>
                        <!-- svelte-ignore a11y_autofocus -->
                        <input class="label-input" bind:value={labelDraft} maxlength="32" placeholder="label" aria-label="Label for {row.address}" autofocus on:blur={saveLabel} />
                      </form>
                    {:else}
                      <button
                        class="addr-focus"
                        aria-pressed={focusAddress === row.address}
                        title={focusAddress === row.address ? 'Show all addresses' : `Show only ${row.address}`}
                        on:click={() => toggleFocus(row.address)}
                      >
                        <span class="chip-chain">{row.chain}</span>
                        {#if row.label}<b>{row.label}</b>{/if}
                        <span class="addr-text">{shortAddr(row.address, 8, 6)}</span>
                      </button>
                    {/if}
                  </td>
                  <td class="right" title={row.runeBalanceMissing ? 'Wallet balance unavailable' : `${fmtAmount(row.runeHeld, 8)} RUNE`}>
                    {loadedOnce && isThorAddress(row.address) && !row.runeBalanceMissing ? money(row.runeUsd) : '—'}
                  </td>
                  {#each ['bondUsd', 'lpUsd', 'tcyUsd'] as key}
                    <td class="right" class:nil={!row[key]} title={key === 'tcyUsd' && row.tcyBalanceMissing ? 'TCY balance unavailable' : undefined}>{loadedOnce && row[key] && !(key === 'tcyUsd' && row.tcyBalanceMissing) ? money(row[key]) : '—'}</td>
                  {/each}
                  <td class="right strong">{loadedOnce ? money(row.totalUsd) : '—'}{#if loadedOnce && (row.runeBalanceMissing || row.tcyBalanceMissing)}<span class="tag">partial</span>{/if}</td>
                  <td class="right">{loadedOnce && portfolioUsd > 0 ? fmtPct((row.totalUsd / portfolioUsd) * 100, 1) : '—'}</td>
                  <td class="right nowrap">
                    <button class="row-btn" aria-label="Label {row.address}" on:click={() => startLabel(row)}>label</button>
                    <button class="row-btn remove" aria-label="Stop tracking {row.address}" title="Stop tracking" on:click={() => untrack(row.address)}>×</button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      <form class="address-form" on:submit={submitAddresses}>
        <span class="prompt">&gt;</span>
        <input
          class="address-input"
          bind:value={addressInput}
          placeholder="paste thor1… or L1 addresses"
          aria-label="Addresses to track, separated by commas or spaces"
          spellcheck="false"
          autocomplete="off"
        />
        <button class="bracket-btn" type="submit" disabled={!addressInput.trim()}>
          <span class="bracket">[</span><span class="key">+</span><span class="bracket">]</span> track
        </button>
        <button class="bracket-btn" type="button" disabled={randomLoading} on:click={trackRandomBondProvider} title="Track a random funded provider on an active node">
          <span class="bracket">[</span><span class="key">?</span><span class="bracket">]</span> {randomLoading ? 'finding provider' : 'random bond provider'}
        </button>
        {#if connectedNew.length}
          <button class="bracket-btn" type="button" on:click={addConnected}>
            <span class="bracket">[</span><span class="key">W</span><span class="bracket">]</span> add {connectedNew.length} wallet address{connectedNew.length === 1 ? '' : 'es'}
          </button>
        {/if}
      </form>
      {#if addressFeedback}<p class="hint warn-text">{addressFeedback}</p>{/if}
      <p class="hint">
        {#if tracked.length}Select an address to show only its positions.{/if}
        THOR addresses show held RUNE, bonds, LP and TCY; L1 addresses show their side of LP and any unclaimed TCY.
      </p>
    </div>
  </section>
  {/if}

  {#if errors.length}
    <div class="alerts">
      {#each errors as message}
        <TerminalAlert tone="warn">{message}</TerminalAlert>
      {/each}
    </div>
  {/if}

  {#if !tracked.length}
    <section class="block empty">
      <p class="empty-line"><span class="prompt">$</span> no addresses tracked yet</p>
      <p class="hint">Paste one or more addresses above, or connect a wallet and add its addresses in one click.</p>
      <button class="bracket-btn" on:click={() => (walletOpen = true)}>
        <span class="bracket">[</span><span class="key">W</span><span class="bracket">]</span> connect wallet
      </button>
    </section>
  {:else}
    {#if !compact}
    <div class="tabs" role="tablist">
      {#each TABS as tab}
        <button
          class="tab"
          class:active={activeTab === tab.id}
          role="tab"
          aria-selected={activeTab === tab.id}
          on:click={() => selectTab(tab.id)}
        >
          <span class="bracket">[</span><span class="key">{tab.key}</span><span class="bracket">]</span>
          {tab.label}
          <span class="tab-count" class:zero={loadedOnce && !tabCounts[tab.id]}>{loadedOnce ? tabCounts[tab.id] : '·'}</span>
        </button>
      {/each}
      <span class="tabs-meta">
        {#if focusAddress}
          <span class="focus-note">only {labels[focusAddress] || shortAddr(focusAddress, 8, 6)}</span>
          <button class="row-btn" on:click={() => (focusAddress = '')}>
            <span class="bracket">[</span><span class="key">esc</span><span class="bracket">]</span> show all
          </button>
        {:else if lastUpdated}updated {lastUpdated.toLocaleTimeString()}{/if}
      </span>
    </div>
    {:else if focusAddress && panel !== 'bond' && panel !== PORTFOLIO_TAB.id}
      <p class="focus-line">
        <span class="focus-note">only {labels[focusAddress] || shortAddr(focusAddress, 8, 4)}</span>
        <button class="row-btn" on:click={() => (focusAddress = '')}>show all</button>
      </p>
    {/if}

    {#if panel === 'bond'}
      {#if compact && tracked.length > 1 && (scopeOptions.length > 1 || focusAddress)}
        <div class="scope" role="group" aria-label="Bond addresses shown">
          <button class="scope-btn" aria-pressed={!focusAddress} on:click={() => (focusAddress = '')}>all</button>
          {#each scopeOptions as address (address)}
            <button class="scope-btn" aria-pressed={focusAddress === address} title={address} on:click={() => toggleFocus(address)}>{labels[address] || `…${address.slice(-4)}`}</button>
          {/each}
        </div>
      {/if}
      {#if compact && hasThor}
        <BondMetrics compact {...bondMetricsProps} on:showNodes={() => (nodesExpanded = true)} />
      {/if}
      <BondPanel
        {gates}
        rows={view.bondRows}
        {labels}
        {money}
        {loading}
        {loadedOnce}
        {hasThor}
        {compact}
        {nextChurnIn}
        churnHalted={!!market.churnState?.isHalted}
        bind:expanded={nodesExpanded}
        on:action={openAction}
      />
      {#if !compact && hasThor}
        <BondMetrics {...bondMetricsProps} on:showNodes={() => (nodesExpanded = true)} />
      {/if}
      {#if bondedAddresses.length}
        <BondHistory
          addresses={bondedAddresses}
          hasOperator={view.bondRows.some((row) => row.isOperator)}
          scope={bondedAddresses.length === 1 ? labels[bondedAddresses[0]] || shortAddr(bondedAddresses[0]) : `${bondedAddresses.length} addresses combined`}
          fileTag={bondedAddresses.length === 1 ? bondedAddresses[0].slice(-4) : 'portfolio'}
          refreshKey={requestId}
          refreshing={loading}
          on:refresh={refresh}
          bind:history={bondHistory}
          bind:loading={bondHistoryLoading}
          bind:loaded={bondHistoryLoaded}
          bind:error={bondHistoryError}
        />
      {/if}
    {:else if panel === 'lp'}
      <LpPanel rows={view.lpRows} {labels} {money} {loading} {loadedOnce} lpPaused={gates.lpPaused} on:action={openAction} />
    {:else if panel === 'tcy'}
      <TcyPanel
        rows={view.tcyRows}
        claimRows={view.claimRows}
        {labels}
        {money}
        {loading}
        {loadedOnce}
        tcyPriceUsd={market.tcyPriceUsd}
        runePriceUsd={market.runePriceUsd}
        {hasThor}
        {gates}
        on:action={openAction}
      />
    {/if}

    <p class="foot">
      <span class="mono-dim">sources:</span> THORNode and Midgard. Values use current pool prices; TCY payouts use
      the RUNE price on the day they were paid. Bond APY is projected from the reward earned so far this churn.
    </p>
  {/if}
</section>

<WalletModal bind:open={walletOpen} />

{#if actionSpec}
  <ActionModal
    spec={actionSpec}
    accounts={$walletAccounts}
    {market}
    {gates}
    nodes={bondNodes}
    thorAddresses={[...new Set([...thorTracked, ...$walletAccounts.filter((account) => account.network === 'THOR').map((account) => account.address)])]}
    on:close={() => (actionSpec = null)}
    on:connect={() => (walletOpen = true)}
    on:submitted={handleSubmitted}
  />
{/if}

<style>
  .portfolio-summary { container: portfolio-summary / inline-size; }
  .portfolio-metrics { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .portfolio-metrics .metric { border-right: 1px solid var(--pt-border); border-bottom: 0; }
  .portfolio-metrics .metric:nth-child(5) { border-right: 0; }
  .metric-action {
    border-top: 0;
    border-left: 0;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .metric-action:hover .metric-label { color: var(--pt-accent); }
  .portfolio-metrics .metric-action:focus-visible { outline: 1px solid var(--pt-accent); outline-offset: -2px; }
  @container portfolio-summary (max-width: 1000px) {
    .portfolio-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .portfolio-metrics .metric:first-child { grid-column: 1 / -1; border-right: 0; }
    .portfolio-metrics .metric:nth-child(3) { border-right: 0; }
    .portfolio-metrics .metric:nth-child(-n + 3) { border-bottom: 1px solid var(--pt-border); }
  }
  .block-head.collapsed { margin-bottom: 0; }
  .address-toggle {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 0;
    background: transparent;
    border: 0;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    cursor: pointer;
  }
  .address-toggle:hover { color: var(--pt-accent); }
  .address-toggle:focus-visible { outline: 1px solid var(--pt-accent); outline-offset: 4px; }
  .toggle-state { color: var(--pt-accent); font-size: 11px; }
</style>
