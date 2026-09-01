<script>
  import { onDestroy, onMount } from 'svelte';
  import TerminalAlert from './components/terminal/TerminalAlert.svelte';
  import { subscribeChainHeads } from './api/chain-stream.js';
  import { fetchSystemIncomePol } from './system-income-pol/api.js';
  import {
    SYSTEM_INCOME_POL_RANGES,
    applySystemIncomePolHead,
    buildSystemIncomePolAssetInventory,
    buildSystemIncomePolChart,
    formatE8Asset,
    formatE8Rune,
    formatE8Usd,
    formatPercent,
    normalizeSystemIncomePolPayload,
    selectSystemIncomePolRange
  } from './system-income-pol/model.js';

  const REFRESH_MS = 2 * 60 * 1000;
  let payload = null;
  let loading = true;
  let refreshing = false;
  let loadError = '';
  let rangeId = '90d';
  let chainStreamConnected = false;
  let refreshTimer;
  let chainSubscription;
  let recentHeads = [];
  let latestDeployment = null;

  $: dashboard = normalizeSystemIncomePolPayload(payload || {});
  $: rows = selectSystemIncomePolRange(dashboard.daily, rangeId);
  $: chart = buildSystemIncomePolChart(rows);
  $: coverage = dashboard.coverage;
  $: assetInventory = buildSystemIncomePolAssetInventory(dashboard.summary, dashboard.pools);
  $: latestDay = dashboard.daily.at(-1) || null;

  async function load(forceRefresh = false) {
    if (refreshing) return;
    if (payload) refreshing = true;
    else loading = true;
    loadError = '';
    try {
      let nextPayload = await fetchSystemIncomePol({ forceRefresh });
      for (const head of recentHeads) nextPayload = applySystemIncomePolHead(nextPayload, head);
      payload = nextPayload;
    } catch (error) {
      loadError = error?.message || 'System Income POL data could not be loaded.';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  function handleChainHead(head) {
    chainStreamConnected = true;
    recentHeads = [...recentHeads.filter((candidate) => candidate.height !== head.height), head]
      .sort((left, right) => left.height - right.height)
      .slice(-512);
    const deployments = Array.isArray(head.pol_reserve_deployments)
      ? head.pol_reserve_deployments
      : [];
    if (deployments.length) {
      latestDeployment = {
        height: head.height,
        time: head.time,
        ...deployments.at(-1)
      };
    }
    if (payload) payload = applySystemIncomePolHead(payload, head);
  }

  onMount(() => {
    load(true);
    chainSubscription = subscribeChainHeads({
      onOpen: () => { chainStreamConnected = true; },
      onError: () => { chainStreamConnected = false; },
      onUnavailable: () => { chainStreamConnected = false; },
      onHead: handleChainHead
    });
    refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, REFRESH_MS);
  });

  onDestroy(() => {
    window.clearInterval(refreshTimer);
    chainSubscription?.close();
  });

  function displayTimestamp(value, fallback = '—') {
    const parsed = Date.parse(value || '');
    if (!Number.isFinite(parsed)) return fallback;
    return new Date(parsed).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      second: '2-digit', hour12: false, timeZone: 'UTC'
    }) + ' UTC';
  }

  function displayDay(value) {
    if (!value) return '—';
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime())
      ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
      : value;
  }

  function assetTicker(asset) {
    const symbol = String(asset || '').split('.')[1] || String(asset || '');
    return symbol.split('-')[0] || 'ASSET';
  }

  function compactRuneValue(value) {
    if (!Number.isFinite(value)) return '—';
    return new Intl.NumberFormat('en-US', {
      notation: 'compact', maximumFractionDigits: 2
    }).format(value);
  }

  function coverageValue(source, ...keys) {
    for (const key of keys) {
      const value = source?.[key];
      if (value !== null && value !== undefined && value !== '') return value;
    }
    return '—';
  }
</script>

<svelte:head>
  <title>System Income POL | BooneTools</title>
  <meta
    name="description"
    content="Track live THORChain system income POL funding, deployments, pool ownership, assets held, and estimated fees."
  />
</svelte:head>

<main class="sipol-shell">
  <header class="terminal-header">
    <div>
      <span class="eyebrow">THORCHAIN · SYSTEM ECONOMICS</span>
      <h1>SYSTEM INCOME POL<span>_</span></h1>
      <p>System income routed into protocol-owned pool positions, observed from block events and reconciled against current pool state.</p>
    </div>
    <button class="refresh" on:click={() => load(true)} disabled={refreshing}>
      <span>[{refreshing ? '…' : 'R'}]</span> {refreshing ? 'RECONCILING' : 'REFRESH'}
    </button>
  </header>

  <section class="freshness-strip" aria-label="Data freshness">
    <div class:offline={!chainStreamConnected}>
      <i></i>
      <b>{chainStreamConnected ? `LIVE · BLOCK ${dashboard.liveHeight.toLocaleString('en-US')}` : 'EVENT STREAM · FALLBACK'}</b>
      <span>{displayTimestamp(dashboard.freshness.events_as_of || dashboard.liveTime)}</span>
    </div>
    <div>
      <i></i>
      <b>POSITIONS · 2M</b>
      <span>{displayTimestamp(dashboard.freshness.positions_as_of, 'AWAITING RECONCILIATION')}</span>
    </div>
    <div>
      <i class="amber"></i>
      <b>FEES · ESTIMATE</b>
      <span>{displayTimestamp(dashboard.freshness.fees_as_of, 'AWAITING RECONCILIATION')}</span>
    </div>
  </section>

  {#if loadError}
    <TerminalAlert tone="err" tag="ERR">
      {loadError} <button class="inline-action" on:click={() => load(true)}>retry</button>
    </TerminalAlert>
  {:else if loading}
    <TerminalAlert tone="info" tag="SYNC">Loading the System Income POL read model…</TerminalAlert>
  {/if}
  {#if dashboard.stale}
    <TerminalAlert tone="warn" tag="STALE">Serving the last successful position reconciliation.</TerminalAlert>
  {/if}
  {#each dashboard.warnings as warning}
    <TerminalAlert tone="warn" tag="DATA">{warning}</TerminalAlert>
  {/each}

  <section class="metric-grid" aria-label="System Income POL summary">
    <article class="metric metric--accent">
      <span class="metric-index">01</span>
      <span class="metric-label">POL TVL</span>
      <strong>{formatE8Usd(dashboard.summary.totalPositionValueUsdE8, true)}</strong>
      <small>CURRENT LP POSITION VALUE</small>
    </article>
    <article class="metric">
      <span class="metric-index">02</span>
      <span class="metric-label">RUNE DEPOSITED</span>
      <strong>{formatE8Rune(dashboard.summary.totalDeployedE8, true)}</strong>
      <small>TOTAL · EXACT BLOCK FLOW</small>
    </article>
    <article class="metric metric--fees">
      <span class="metric-index">03</span>
      <span class="metric-label">EST. FEES EARNED</span>
      <strong>{formatE8Usd(dashboard.summary.totalEstimatedFeesUsdE8, true)}</strong>
      <small>{dashboard.summary.feeEstimateComplete ? 'OWNERSHIP-WEIGHTED · COMPLETE' : 'KNOWN COVERAGE · PARTIAL ESTIMATE'}</small>
    </article>
    <article class="metric">
      <span class="metric-index">04</span>
      <span class="metric-label">SYSTEM INCOME → POL</span>
      <strong>{formatPercent(dashboard.summary.systemIncomePolSharePercent)}</strong>
      <small>{formatE8Rune(dashboard.summary.totalFundedE8, true)} RUNE OF SYSTEM INCOME</small>
    </article>
    <article class="metric metric--position">
      <span class="metric-index">05</span>
      <span class="metric-label">RUNE “BURNED”</span>
      <strong>{formatE8Rune(dashboard.summary.totalRuneHeldE8, true)}</strong>
      <small>RUNE HELD · {formatPercent(dashboard.summary.runeHeldSystemIncomeSharePercent)} OF SYSTEM INCOME</small>
    </article>
  </section>

  {#if latestDeployment}
    <section class="deployment-tape" aria-label="Latest deployment">
      <span>LAST DEPLOYMENT</span>
      <b>{latestDeployment.asset}</b>
      <strong>+{formatE8Rune(latestDeployment.rune_e8)} RUNE</strong>
      <small>BLOCK {latestDeployment.height.toLocaleString('en-US')} · {displayTimestamp(latestDeployment.time)}</small>
    </section>
  {/if}

  <section class="panel asset-panel" aria-labelledby="assets-title">
    <div class="panel-heading">
      <div>
        <h2 id="assets-title">CURRENT ASSETS HELD BY POL</h2>
        <p>Redeemable LP inventory at the latest position reconciliation.</p>
      </div>
      <span class="panel-meta">{assetInventory.length} ASSETS · {displayTimestamp(dashboard.freshness.positions_as_of)}</span>
    </div>
    <div class="asset-grid">
      {#each assetInventory as asset}
        <article>
          <span>{asset.asset}</span>
          <strong>{asset.ticker === 'RUNE' ? formatE8Rune(asset.amountE8) : formatE8Asset(asset.amountE8)}</strong>
          <small>{asset.ticker} · {formatE8Usd(asset.valueUsdE8)}</small>
        </article>
      {:else}
        <p class="empty">NO CURRENT POL ASSETS OBSERVED</p>
      {/each}
    </div>
  </section>

  <section class="panel" aria-labelledby="positions-title">
    <div class="panel-heading">
      <div>
        <span class="section-index">[01]</span>
        <h2 id="positions-title">CURRENT POOL POSITIONS</h2>
        <p>LP ownership and redeemable pool legs. Deployments update per block; values reconcile with the current pool snapshot.</p>
      </div>
      <span class="panel-meta">{dashboard.pools.length} POOLS · {displayTimestamp(dashboard.freshness.positions_as_of)}</span>
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>POOL</th>
            <th>POSITION VALUE</th>
            <th>POL SHARE</th>
            <th>RUNE HELD</th>
            <th>ASSET HELD</th>
            <th>GROSS DEPLOYED</th>
            <th>EST. FEES</th>
          </tr>
        </thead>
        <tbody>
          {#each dashboard.pools as pool}
            <tr>
              <td>
                <strong>{pool.asset}</strong>
                <small>{pool.status || 'UNKNOWN'}</small>
              </td>
              <td class="accent">{formatE8Usd(pool.positionValueUsdE8)} <small>USD · CURRENT</small></td>
              <td>{formatPercent(pool.sharePercent)} <small>{pool.shareBps === null ? '—' : `${pool.shareBps.toLocaleString('en-US')} BPS`}</small></td>
              <td>{formatE8Rune(pool.runeHeldE8)} <small>RUNE</small></td>
              <td>{formatE8Asset(pool.assetHeldE8)} <small>{assetTicker(pool.asset)}</small></td>
              <td>{formatE8Rune(pool.runeDepositedE8)} <small>RUNE</small></td>
              <td class="fee">{formatE8Usd(pool.estimatedFeesUsdE8)} <small>USD · EST.</small></td>
            </tr>
          {:else}
            <tr><td class="empty" colspan="7">NO SYSTEM INCOME POL POSITIONS OBSERVED</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="panel history-panel" aria-labelledby="history-title">
    <div class="panel-heading">
      <div>
        <span class="section-index">[02]</span>
        <h2 id="history-title">DAILY FUNDING + DEPLOYMENT HISTORY</h2>
        <p>UTC block-event totals with ownership-weighted liquidity fees shown as a separate estimate.</p>
      </div>
      <div class="range-group" aria-label="History range">
        {#each SYSTEM_INCOME_POL_RANGES as range}
          <button class:active={rangeId === range.id} on:click={() => rangeId = range.id}>[{range.label}]</button>
        {/each}
      </div>
    </div>

    {#if rows.length}
      <div class="chart-wrap">
        <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label="Daily System Income POL funding, deployment, and estimated fees in RUNE">
          {#each chart.yTicks as tick}
            <line class="grid" x1={chart.plot.left} x2={chart.plot.right} y1={tick.y} y2={tick.y}></line>
            <text class="y-label" x={chart.plot.left - 10} y={tick.y + 3}>{compactRuneValue(tick.value)}</text>
          {/each}
          {#each chart.xTicks as tick}
            <text class="x-label" x={tick.x} y={chart.height - 9}>{displayDay(tick.day)}</text>
          {/each}
          {#if chart.fundedPath}<path class="series funded" d={chart.fundedPath}></path>{/if}
          {#if chart.deployedPath}<path class="series deployed" d={chart.deployedPath}></path>{/if}
          {#if chart.feesPath}<path class="series fees" d={chart.feesPath}></path>{/if}
        </svg>
      </div>
      <div class="legend">
        <span><i class="funded"></i> FUNDED</span>
        <span><i class="deployed"></i> DEPLOYED</span>
        <span><i class="fees"></i> EST. FEES</span>
        <small>{displayDay(rows[0]?.day)} → {displayDay(rows.at(-1)?.day)} · RUNE</small>
      </div>
    {:else}
      <div class="empty-chart">NO DAILY HISTORY AVAILABLE</div>
    {/if}
  </section>

  <section class="coverage-grid" aria-label="DATA COVERAGE">
    <article class="panel coverage-panel">
      <div class="panel-heading compact">
        <div><span class="section-index">[03]</span><h2>DATA COVERAGE</h2></div>
      </div>
      <dl>
        <div><dt>EVENT HEIGHT RANGE</dt><dd>{coverageValue(coverage, 'first_height', 'start_height')} → {coverageValue(coverage, 'last_height', 'end_height')}</dd></div>
        <div><dt>OBSERVED BLOCKS</dt><dd>{coverageValue(coverage, 'observed_blocks', 'blocks_observed')}</dd></div>
        <div><dt>MISSING / REPAIRED</dt><dd>{coverageValue(coverage, 'missing_blocks')} / {coverageValue(coverage, 'repaired_blocks')}</dd></div>
        <div><dt>POSITION POOLS</dt><dd>{coverageValue(coverage, 'position_pools', 'pools_observed', 'active_pool_count')}</dd></div>
        <div><dt>HISTORY THROUGH</dt><dd>{displayDay(coverageValue(coverage, 'through_day', 'history_through_day') === '—' ? latestDay?.day : coverageValue(coverage, 'through_day', 'history_through_day'))}</dd></div>
      </dl>
    </article>
    <article class="panel method-panel">
      <div class="panel-heading compact">
        <div><span class="section-index">[04]</span><h2>ACCOUNTING NOTES</h2></div>
      </div>
      <p><b>Exact flows:</b> system income funding and deployments are read from finalized block events and replayed after stream gaps.</p>
      <p><b>Current holdings:</b> LP units, pool ownership, RUNE held, and external assets held reconcile against THORNode pool state.</p>
      <p><b>Fee estimate:</b> pool liquidity fees are multiplied by SIPOL’s time-weighted pool share. This is not position P&amp;L.</p>
      <span class="source-line">SOURCE · THORNODE BLOCK EVENTS + CORE POOL SNAPSHOT + POOL ANALYSIS READ MODEL</span>
    </article>
  </section>
</main>

<style>
  .sipol-shell {
    min-height: 100%;
    padding: 26px 24px 70px;
    color: var(--term-text-body);
    background: var(--term-bg);
    font-family: 'JetBrains Mono', monospace;
  }
  .terminal-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    max-width: 1440px;
    margin: 0 auto 18px;
  }
  .eyebrow, .section-index, .source-line {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .14em;
    text-transform: uppercase;
  }
  .metric-label, th, dt {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .12em;
    text-transform: uppercase;
  }
  .eyebrow, .section-index { color: var(--term-green); }
  h1 {
    margin: 7px 0 8px;
    color: var(--term-text);
    font: 800 30px/1.1 'JetBrains Mono', monospace;
    letter-spacing: .05em;
  }
  h1 span { color: var(--term-green); animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .terminal-header p, .panel-heading p {
    max-width: 880px;
    margin: 0;
    color: var(--term-text-3);
    font: 13px/1.55 'DM Sans', sans-serif;
  }
  .refresh, .range-group button, .inline-action {
    border: 1px solid var(--term-border);
    border-radius: 0;
    color: var(--term-text-2);
    background: transparent;
    font: 600 11px/1 'JetBrains Mono', monospace;
    cursor: pointer;
  }
  .refresh { padding: 9px 12px; }
  .refresh span { color: var(--term-green); }
  .refresh:hover, .range-group button:hover, .range-group button.active { border-color: var(--term-green); color: var(--term-green); }
  .refresh:disabled { opacity: .55; cursor: wait; }
  .inline-action { margin-left: 8px; padding: 3px 6px; color: var(--term-green); }
  .freshness-strip {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    max-width: 1440px;
    margin: 0 auto 14px;
    border: 1px solid var(--term-border);
    background: var(--term-surface);
  }
  .freshness-strip > div {
    display: grid;
    grid-template-columns: 7px auto 1fr;
    align-items: center;
    gap: 8px;
    min-height: 38px;
    padding: 7px 11px;
    border-right: 1px solid var(--term-border);
    font-size: 11px;
  }
  .freshness-strip > div:last-child { border-right: 0; }
  .freshness-strip i { width: 6px; height: 6px; border-radius: 50%; background: var(--term-green); box-shadow: 0 0 6px rgba(0, 204, 102, .4); }
  .freshness-strip i.amber { background: var(--term-amber); box-shadow: none; }
  .freshness-strip .offline i { background: var(--term-text-5); box-shadow: none; }
  .freshness-strip b { color: var(--term-text); letter-spacing: .05em; }
  .freshness-strip span { color: var(--term-text-4); text-align: right; }
  :global(.sipol-shell > .terminal-alert) { max-width: 1440px; margin-left: auto; margin-right: auto; }
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    max-width: 1440px;
    margin: 0 auto 14px;
    border: 1px solid var(--term-border);
    background: var(--term-surface);
  }
  .metric {
    position: relative;
    min-height: 112px;
    padding: 17px 18px;
    border-right: 1px solid var(--term-border);
  }
  .metric:last-child { border-right: 0; }
  .metric:hover { background: var(--term-surface-hover); }
  .metric-index { position: absolute; top: 10px; right: 11px; color: var(--term-green); font-size: 9px; }
  .metric-label { display: block; margin-bottom: 12px; color: var(--term-text-4); }
  .metric strong { display: block; color: var(--term-text); font-size: 25px; line-height: 1.1; }
  .metric small { display: block; margin-top: 8px; color: var(--term-text-5); font-size: 11px; letter-spacing: .04em; }
  .metric--accent strong, .metric--position strong { color: var(--term-green); }
  .metric--fees strong { color: var(--term-amber); }
  .deployment-tape {
    display: grid;
    grid-template-columns: auto auto auto 1fr;
    align-items: center;
    gap: 16px;
    max-width: 1440px;
    margin: 0 auto 14px;
    padding: 9px 12px;
    border: 1px solid rgba(0, 204, 102, .35);
    background: rgba(0, 204, 102, .035);
    font-size: 11px;
  }
  .deployment-tape > span { color: var(--term-text-4); letter-spacing: .08em; }
  .deployment-tape b { color: var(--term-text); }
  .deployment-tape strong { color: var(--term-green); }
  .deployment-tape small { color: var(--term-text-5); text-align: right; }
  .panel {
    max-width: 1440px;
    margin: 0 auto 14px;
    border: 1px solid var(--term-border);
    background: var(--term-surface);
  }
  .panel-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    padding: 16px 18px;
    border-bottom: 1px solid var(--term-border);
  }
  .panel-heading > div:first-child { position: relative; padding-left: 36px; }
  .section-index { position: absolute; left: 0; top: 2px; }
  h2 { margin: 0 0 5px; color: var(--term-text); font: 700 13px/1.2 'JetBrains Mono', monospace; letter-spacing: .07em; }
  .panel-meta { color: var(--term-text-5); font-size: 11px; white-space: nowrap; }
  .asset-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  }
  .asset-grid article {
    min-height: 96px;
    padding: 15px 18px;
    border-right: 1px solid var(--term-border-faint);
  }
  .asset-grid article:last-child { border-right: 0; }
  .asset-grid span, .asset-grid small {
    display: block;
    color: var(--term-text-5);
    font-size: 10px;
    letter-spacing: .08em;
  }
  .asset-grid strong {
    display: block;
    margin: 9px 0 6px;
    color: var(--term-green);
    font-size: 23px;
  }
  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font: 12px/1.4 'JetBrains Mono', monospace; }
  th, td { padding: 11px 14px; border-bottom: 1px solid var(--term-border-faint); text-align: right; white-space: nowrap; }
  th { position: sticky; top: 0; color: var(--term-text-4); background: var(--term-surface); }
  th:first-child, td:first-child { text-align: left; }
  td { color: var(--term-text-2); }
  td strong { color: var(--term-text); }
  td small { display: block; margin-top: 4px; color: var(--term-text-5); font-size: 11px; }
  td.accent { color: var(--term-green); }
  td.fee { color: var(--term-amber); }
  tbody tr:hover { background: var(--term-surface-hover); }
  .empty { padding: 28px; color: var(--term-text-5); text-align: center !important; }
  .range-group { display: flex; gap: 5px; }
  .range-group button { padding: 6px 8px; }
  .chart-wrap { height: 280px; padding: 8px 14px 0; }
  svg { display: block; width: 100%; height: 100%; overflow: visible; }
  .grid { stroke: var(--term-border-faint); stroke-width: 1; }
  .y-label, .x-label { fill: var(--term-text-5); font: 11px 'JetBrains Mono', monospace; }
  .y-label { text-anchor: end; }
  .x-label { text-anchor: middle; }
  .series { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; }
  .series.funded { stroke: var(--term-green); }
  .series.deployed { stroke: var(--term-amber); }
  .series.fees { stroke: var(--term-info); stroke-width: 1.5; stroke-dasharray: 4 3; }
  .legend { display: flex; align-items: center; gap: 18px; padding: 11px 18px; border-top: 1px solid var(--term-border-faint); color: var(--term-text-3); font-size: 11px; }
  .legend span { display: flex; align-items: center; gap: 6px; }
  .legend i { width: 14px; height: 2px; }
  .legend i.funded { background: var(--term-green); }
  .legend i.deployed { background: var(--term-amber); }
  .legend i.fees { border-top: 2px dashed var(--term-info); }
  .legend small { margin-left: auto; color: var(--term-text-5); }
  .empty-chart { padding: 60px 20px; color: var(--term-text-5); text-align: center; font-size: 11px; }
  .coverage-grid { display: grid; grid-template-columns: minmax(300px, .8fr) minmax(420px, 1.2fr); gap: 14px; max-width: 1440px; margin: 0 auto; }
  .coverage-grid .panel { width: 100%; margin: 0; }
  .panel-heading.compact { padding: 13px 16px; }
  .panel-heading.compact h2 { margin: 0; }
  dl { margin: 0; }
  dl > div { display: flex; justify-content: space-between; gap: 20px; padding: 10px 16px; border-bottom: 1px solid var(--term-border-faint); }
  dl > div:last-child { border-bottom: 0; }
  dt { color: var(--term-text-5); }
  dd { margin: 0; color: var(--term-text); font-size: 11px; text-align: right; }
  .method-panel > p { margin: 12px 16px; color: var(--term-text-3); font: 12px/1.55 'DM Sans', sans-serif; }
  .method-panel b { color: var(--term-text); font-family: 'JetBrains Mono', monospace; font-size: 11px; }
  .source-line { display: block; margin: 14px 16px; color: var(--term-text-5); font-size: 11px; line-height: 1.5; }
  @media (max-width: 900px) {
    .sipol-shell { padding: 18px 12px 56px; }
    .terminal-header, .panel-heading { align-items: flex-start; flex-direction: column; }
    .freshness-strip, .metric-grid { grid-template-columns: 1fr; }
    .freshness-strip > div { border-right: 0; border-bottom: 1px solid var(--term-border); }
    .freshness-strip > div:last-child { border-bottom: 0; }
    .metric { border-right: 0; border-bottom: 1px solid var(--term-border) !important; }
    .metric:last-child { border-bottom: 0 !important; }
    .asset-grid { grid-template-columns: 1fr; }
    .asset-grid article { border-right: 0; border-bottom: 1px solid var(--term-border-faint); }
    .asset-grid article:last-child { border-bottom: 0; }
    .coverage-grid { grid-template-columns: 1fr; }
    .deployment-tape { grid-template-columns: auto auto; }
    .deployment-tape small { text-align: left; }
    .chart-wrap { height: 220px; }
  }
  @media (max-width: 560px) {
    h1 { font-size: 24px; }
    .terminal-header .refresh { width: 100%; }
    .panel-heading .range-group { width: 100%; }
    .range-group button { flex: 1; }
    .legend { flex-wrap: wrap; }
    .legend small { width: 100%; margin-left: 0; }
  }
</style>
