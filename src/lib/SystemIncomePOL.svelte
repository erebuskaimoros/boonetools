<script>
  import { onDestroy, onMount } from 'svelte';
  import TerminalAlert from './components/terminal/TerminalAlert.svelte';
  import { subscribeChainHeads } from './api/chain-stream.js';
  import { getAssetLogo } from './constants/assets.js';
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
    projectSystemIncomePolChartSelection,
    selectSystemIncomePolRange
  } from './system-income-pol/model.js';

  const REFRESH_MS = 2 * 60 * 1000;
  const REDUNDANT_FEE_WARNING = 'Estimated fees exclude hours without an ownership seed';
  let payload = null;
  let loading = true;
  let refreshing = false;
  let loadError = '';
  let rangeId = '30d';
  let chartUnit = 'rune';
  let hoverIndex = -1;
  let zoomStartDay = '';
  let zoomEndDay = '';
  let selecting = false;
  let selectionStartX = null;
  let selectionEndX = null;
  let refreshTimer;
  let chainSubscription;
  let deploymentPulseTimer;
  let recentHeads = [];
  let deploymentPulse = null;

  $: dashboard = normalizeSystemIncomePolPayload(payload || {});
  $: rangeRows = selectSystemIncomePolRange(dashboard.daily, rangeId);
  $: rows = zoomStartDay && zoomEndDay
    ? rangeRows.filter((row) => row.day >= zoomStartDay && row.day <= zoomEndDay)
    : rangeRows;
  $: isChartZoomed = Boolean(zoomStartDay && zoomEndDay && rows.length > 1) && (
    rows[0]?.day !== rangeRows[0]?.day || rows.at(-1)?.day !== rangeRows.at(-1)?.day
  );
  $: usdChartAvailable = dashboard.summary.runePriceUsdE8 !== null
    && Number(dashboard.summary.runePriceUsdE8) > 0;
  $: if (chartUnit === 'usd' && !usdChartAvailable) chartUnit = 'rune';
  $: chartUnitLabel = chartUnit === 'usd' ? 'USD' : 'RUNE';
  $: chart = buildSystemIncomePolChart(rows, {
    unit: chartUnit,
    runePriceUsdE8: dashboard.summary.runePriceUsdE8
  });
  $: hoveredChartPoint = hoverIndex >= 0 ? chart.points[hoverIndex] || null : null;
  $: coverage = dashboard.coverage;
  $: feeApr24h = dashboard.summary.feeAprWindows['24h'];
  $: feeApr7d = dashboard.summary.feeAprWindows['7d'];
  $: feeApr30d = dashboard.summary.feeAprWindows['30d'];
  $: assetInventory = buildSystemIncomePolAssetInventory(dashboard.summary, dashboard.pools);
  $: visibleWarnings = dashboard.warnings.filter((warning) => warning !== REDUNDANT_FEE_WARNING);
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
    const isNewHead = !recentHeads.some((candidate) => candidate.height === head.height);
    recentHeads = [...recentHeads.filter((candidate) => candidate.height !== head.height), head]
      .sort((left, right) => left.height - right.height)
      .slice(-512);
    const deployments = Array.isArray(head.pol_reserve_deployments)
      ? head.pol_reserve_deployments
      : [];
    if (isNewHead && deployments.length) {
      const runeE8 = deployments.reduce((total, deployment) => {
        try {
          return total + BigInt(deployment.rune_e8 || 0);
        } catch {
          return total;
        }
      }, 0n).toString();
      deploymentPulse = { height: head.height, runeE8 };
      window.clearTimeout(deploymentPulseTimer);
      deploymentPulseTimer = window.setTimeout(() => {
        if (deploymentPulse?.height === head.height) deploymentPulse = null;
      }, 1000);
    }
    if (payload) payload = applySystemIncomePolHead(payload, head);
  }

  onMount(() => {
    load(true);
    chainSubscription = subscribeChainHeads({
      onHead: handleChainHead
    });
    refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, REFRESH_MS);
  });

  onDestroy(() => {
    window.clearInterval(refreshTimer);
    window.clearTimeout(deploymentPulseTimer);
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

  function thorchainAddressUrl(address) {
    return `https://thorchain.net/address/${encodeURIComponent(address)}`;
  }

  function thorchainPoolUrl(asset) {
    return `https://thorchain.net/pool/${encodeURIComponent(asset)}`;
  }

  function compactChartValue(value) {
    if (!Number.isFinite(value)) return '—';
    const formatted = new Intl.NumberFormat('en-US', {
      notation: 'compact', maximumFractionDigits: 2
    }).format(value);
    return chartUnit === 'usd' ? `$${formatted}` : formatted;
  }

  function displayChartValue(value) {
    if (!Number.isFinite(value)) return '—';
    const formatted = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value);
    return chartUnit === 'usd' ? `$${formatted}` : formatted;
  }

  function feeEstimateLabel(summary) {
    if (summary.feeEstimateComplete) return 'HOURLY · COMPLETE';
    if (summary.feeHoursTotal <= 0) return 'HOURLY SEED · WARMING';
    const state = [];
    if (summary.feeHoursSeeded > 0) state.push('SEEDED');
    if (summary.feeHoursProvisional > 0) state.push('LIVE');
    const prefix = state.length ? `HOURLY · ${state.join(' + ')}` : 'HOURLY ESTIMATE';
    return `${prefix} · ${summary.feeHoursCovered}/${summary.feeHoursTotal} HOURS`;
  }

  function feeAprCoverageLabel(window) {
    if (!window || window.aprPercent === null) return 'WARMING · NO COMPLETE CAPITAL HOURS';
    const parts = [window.status.toUpperCase(), `${window.coveredHours}/${window.targetHours}H`];
    if (window.seededHours > 0) parts.push(`${window.seededHours} SEEDED`);
    return parts.join(' · ');
  }

  function setChartUnit(nextUnit) {
    if (nextUnit === 'usd' && !usdChartAvailable) return;
    chartUnit = nextUnit === 'usd' ? 'usd' : 'rune';
    hoverIndex = -1;
  }

  function setChartRange(nextRange) {
    rangeId = nextRange;
    resetChartZoom();
  }

  function resetChartZoom() {
    zoomStartDay = '';
    zoomEndDay = '';
    hoverIndex = -1;
    selecting = false;
    selectionStartX = null;
    selectionEndX = null;
  }

  function updateChartHover(event) {
    if (selecting || !rows.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const relative = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    hoverIndex = Math.round(relative * Math.max(0, rows.length - 1));
  }

  function pointerChartX(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const relative = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    return chart.plot.left + relative * (chart.plot.right - chart.plot.left);
  }

  function startZoomSelection(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    hoverIndex = -1;
    selecting = true;
    selectionStartX = pointerChartX(event);
    selectionEndX = selectionStartX;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is optional; selection still works inside the chart.
    }
  }

  function updateChartPointer(event) {
    if (!selecting) {
      updateChartHover(event);
      return;
    }
    selectionEndX = pointerChartX(event);
  }

  function finishZoomSelection(event) {
    if (!selecting) return;
    selectionEndX = pointerChartX(event);
    selecting = false;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // The browser may already have released this pointer.
    }

    const selection = projectSystemIncomePolChartSelection({
      rowCount: rows.length,
      plotLeft: chart.plot.left,
      plotRight: chart.plot.right,
      startX: selectionStartX,
      endX: selectionEndX
    });
    selectionStartX = null;
    selectionEndX = null;
    if (!selection) return;

    const selectedRows = rows.slice(selection.startIndex, selection.endIndex + 1);
    if (selectedRows.length < 2) return;
    if (selectedRows.length === rangeRows.length) {
      resetChartZoom();
      return;
    }
    zoomStartDay = selectedRows[0].day;
    zoomEndDay = selectedRows.at(-1).day;
    hoverIndex = -1;
  }

  function cancelZoomSelection(event) {
    selecting = false;
    selectionStartX = null;
    selectionEndX = null;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // The browser may already have released this pointer.
    }
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
  {#each visibleWarnings as warning}
    <TerminalAlert tone="warn" tag="DATA">{warning}</TerminalAlert>
  {/each}

  <section class="metric-grid" aria-label="System Income POL summary">
    <article class="metric metric--accent">
      <span class="metric-index">01</span>
      <span class="metric-label">POL TVL</span>
      <strong class="metric-value--green">{formatE8Usd(dashboard.summary.totalPositionValueUsdE8, true)}</strong>
      <small>CURRENT LP POSITION VALUE</small>
    </article>
    <article class="metric">
      <span class="metric-index">02</span>
      <span class="metric-label">RUNE DEPOSITED</span>
      {#if dashboard.moduleAddress}
        <a
          class="metric-link"
          href={thorchainAddressUrl(dashboard.moduleAddress)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`View POL module address ${dashboard.moduleAddress} on thorchain.net (opens in a new tab)`}
        >
          <img class="metric-rune-icon" src="/assets/coins/RUNE-ICON.svg" alt="" aria-hidden="true" />
          <strong>{formatE8Rune(dashboard.summary.totalDeployedE8, true)}</strong>
          <span class="external-mark" aria-hidden="true">↗</span>
        </a>
      {:else}
        <strong>{formatE8Rune(dashboard.summary.totalDeployedE8, true)}</strong>
      {/if}
      {#if deploymentPulse}
        {#key deploymentPulse.height}
          <span
            class="deployment-pulse"
            role="status"
            aria-live="polite"
            aria-label={`New POL deployment: ${formatE8Rune(deploymentPulse.runeE8)} RUNE added`}
          >+{formatE8Rune(deploymentPulse.runeE8)} RUNE ADDED</span>
        {/key}
      {:else}
        <small>TOTAL · EXACT BLOCK FLOW</small>
      {/if}
    </article>
    <article class="metric metric--fees">
      <span class="metric-index">03</span>
      <span class="metric-label">EST. FEES EARNED</span>
      <div class="metric-pair fee-metric-pair">
        <span>
          <strong>{formatE8Usd(dashboard.summary.totalEstimatedFeesUsdE8, true)}</strong>
          <small>TOTAL EST.</small>
        </span>
        <span class="metric-separator" aria-hidden="true">/</span>
        <span>
          <strong>{formatPercent(feeApr24h?.aprPercent, 1)}</strong>
          <small>24H EST. APR</small>
        </span>
      </div>
      <small class="metric-foot">{feeAprCoverageLabel(feeApr24h)}</small>
    </article>
    <article class="metric">
      <span class="metric-index">04</span>
      <span class="metric-label">SYSTEM INCOME → POL</span>
      <strong>{formatPercent(dashboard.summary.polReserveSystemIncomePercent, 1)}</strong>
      <small>POLRESERVESYSTEMINCOMEBPS</small>
    </article>
    <article class="metric metric--position">
      <span class="metric-index">05</span>
      <span class="metric-label">RUNE “BURNED”</span>
      <div class="metric-pair">
        <span>
          <strong class="metric-value--orange">{formatE8Rune(dashboard.summary.totalRuneHeldE8, true)}</strong>
          <small>RUNE HELD</small>
        </span>
        <span class="metric-separator" aria-hidden="true">/</span>
        <span>
          <strong class="metric-value--orange">{formatPercent(dashboard.summary.runeHeldSystemIncomeSharePercent, 1)}</strong>
          <small>OF SYSTEM INCOME</small>
        </span>
      </div>
    </article>
  </section>

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
          <div class="asset-value">
            <img src={getAssetLogo(asset.asset) || '/assets/coins/fallback-logo.svg'} alt="" aria-hidden="true" />
            <strong>{asset.ticker === 'RUNE' ? formatE8Rune(asset.amountE8) : formatE8Asset(asset.amountE8)}</strong>
          </div>
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
                <a
                  class="pool-link"
                  href={thorchainPoolUrl(pool.asset)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`View ${pool.asset} pool on thorchain.net (opens in a new tab)`}
                >
                  <img class="table-token-icon" src={getAssetLogo(pool.asset) || '/assets/coins/fallback-logo.svg'} alt="" aria-hidden="true" />
                  <strong>{pool.asset}</strong>
                  <span class="external-mark" aria-hidden="true">↗</span>
                </a>
                <small>{pool.status || 'UNKNOWN'}</small>
              </td>
              <td class="accent">{formatE8Usd(pool.positionValueUsdE8)} <small>USD · CURRENT</small></td>
              <td>{formatPercent(pool.sharePercent)} <small>{pool.shareBps === null ? '—' : `${pool.shareBps.toLocaleString('en-US')} BPS`}</small></td>
              <td>{formatE8Rune(pool.runeHeldE8)} <small class="token-name"><img src={getAssetLogo('THOR.RUNE')} alt="" aria-hidden="true" />RUNE</small></td>
              <td>{formatE8Asset(pool.assetHeldE8)} <small class="token-name"><img src={getAssetLogo(pool.asset) || '/assets/coins/fallback-logo.svg'} alt="" aria-hidden="true" />{assetTicker(pool.asset)}</small></td>
              <td>{formatE8Rune(pool.runeDepositedE8)} <small class="token-name"><img src={getAssetLogo('THOR.RUNE')} alt="" aria-hidden="true" />RUNE</small></td>
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
        <h2 id="history-title">DAILY + CUMULATIVE POL DEPOSITS</h2>
        <p>
          Daily gross POL deployments shown as bars with the all-time total overlaid. Hover for values; drag to zoom.
          {#if chartUnit === 'usd'}USD values use the current RUNE price ({formatE8Usd(dashboard.summary.runePriceUsdE8)}).{/if}
        </p>
      </div>
      <div class="chart-controls">
        <div class="unit-group" aria-label="Chart denomination">
          <button class:active={chartUnit === 'rune'} aria-pressed={chartUnit === 'rune'} on:click={() => setChartUnit('rune')}>[RUNE]</button>
          <button class:active={chartUnit === 'usd'} aria-pressed={chartUnit === 'usd'} disabled={!usdChartAvailable} title={usdChartAvailable ? 'Show values at the current RUNE/USD price' : 'Current RUNE/USD price unavailable'} on:click={() => setChartUnit('usd')}>[$]</button>
        </div>
        <div class="range-group" aria-label="History range">
          {#each SYSTEM_INCOME_POL_RANGES as range}
            <button class:active={rangeId === range.id} on:click={() => setChartRange(range.id)}>[{range.label}]</button>
          {/each}
          <button class="zoom-reset" disabled={!isChartZoomed} on:click={resetChartZoom}>[RESET]</button>
        </div>
      </div>
    </div>

    {#if rows.length}
      <div class="chart-wrap">
        <svg
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          role="img"
          aria-label={`Daily and cumulative POL deposits denominated in ${chartUnitLabel} by UTC day. Drag horizontally to zoom; double-click to reset.`}
          on:dblclick={resetChartZoom}
        >
          {#each chart.yTicks as tick}
            <line class="grid" x1={chart.plot.left} x2={chart.plot.right} y1={tick.y} y2={tick.y}></line>
            <text class="y-label" x={chart.plot.left - 10} y={tick.y + 3}>{compactChartValue(tick.value)}</text>
          {/each}
          {#each chart.xTicks as tick}
            <text class="x-label" x={tick.x} y={chart.height - 9}>{displayDay(tick.day)}</text>
          {/each}
          {#each chart.cumulativeYTicks as tick}
            <text class="y-label cumulative-label" x={chart.plot.right + 10} y={tick.y + 3}>{compactChartValue(tick.value)}</text>
          {/each}
          {#each chart.depositBars as bar}
            <rect class="bar deposited" x={bar.x} y={bar.y} width={bar.width} height={bar.height}>
              <title>{displayDay(bar.day)} · {displayChartValue(bar.value)} {chartUnitLabel} deposited by POL</title>
            </rect>
          {/each}
          {#if chart.cumulativeDepositedPath}
            <path class="series cumulative" d={chart.cumulativeDepositedPath}></path>
            {#each chart.points as point}
              <circle class="cumulative-point" cx={point.x} cy={chart.cumulativeYTicks.length ? chart.plot.bottom - (point.cumulativeDepositedValue / chart.cumulativeYMax) * (chart.plot.bottom - chart.plot.top) : chart.plot.bottom} r="3">
                <title>{displayDay(point.day)} · {displayChartValue(point.cumulativeDepositedValue)} {chartUnitLabel} cumulative deposited</title>
              </circle>
            {/each}
          {/if}
          {#if hoverIndex >= 0 && chart.points[hoverIndex]}
            <line
              class="cursor-line"
              x1={chart.points[hoverIndex].x}
              x2={chart.points[hoverIndex].x}
              y1={chart.plot.top}
              y2={chart.plot.bottom}
            ></line>
          {/if}
          {#if selecting && selectionStartX !== null && selectionEndX !== null}
            <rect
              class="zoom-selection"
              x={Math.min(selectionStartX, selectionEndX)}
              y={chart.plot.top}
              width={Math.abs(selectionEndX - selectionStartX)}
              height={chart.plot.bottom - chart.plot.top}
            ></rect>
          {/if}
          <rect
            role="presentation"
            class="zoom-capture"
            x={chart.plot.left}
            y={chart.plot.top}
            width={chart.plot.right - chart.plot.left}
            height={chart.plot.bottom - chart.plot.top}
            fill="transparent"
            on:pointerdown={startZoomSelection}
            on:pointermove={updateChartPointer}
            on:pointerup={finishZoomSelection}
            on:pointercancel={cancelZoomSelection}
            on:mouseleave={() => { if (!selecting) hoverIndex = -1; }}
          ></rect>
        </svg>
        {#if hoveredChartPoint}
          <div
            class="chart-tooltip"
            class:align-right={hoveredChartPoint.x > chart.width * 0.7}
            style={`--tooltip-x:${(hoveredChartPoint.x / chart.width) * 100}%`}
            role="tooltip"
          >
            <strong>{displayDay(hoveredChartPoint.day)}{hoveredChartPoint.partial ? ' · PARTIAL' : ''}</strong>
            <span class="tooltip-row daily">
              <i></i><span>DAILY DEPOSIT</span><b>{displayChartValue(hoveredChartPoint.depositedPlotValue)} {chartUnitLabel}</b>
            </span>
            <span class="tooltip-row cumulative">
              <i></i><span>CUMULATIVE</span><b>{displayChartValue(hoveredChartPoint.cumulativeDepositedValue)} {chartUnitLabel}</b>
            </span>
          </div>
        {/if}
      </div>
      <div class="legend">
        <span><i class="deposited"></i> DAILY POL DEPOSITED · {chartUnitLabel}</span>
        <span><i class="cumulative"></i> CUMULATIVE POL DEPOSITED · {chartUnitLabel}</span>
        <small>{displayDay(rows[0]?.day)} → {displayDay(rows.at(-1)?.day)} · {chartUnitLabel}{chartUnit === 'usd' ? ' · CURRENT RUNE PRICE' : ''}</small>
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
        <div><dt>24H EST. FEE APR</dt><dd>{formatPercent(feeApr24h?.aprPercent, 1)} · {feeAprCoverageLabel(feeApr24h)}</dd></div>
        <div><dt>7D EST. FEE APR</dt><dd>{formatPercent(feeApr7d?.aprPercent, 1)} · {feeAprCoverageLabel(feeApr7d)}</dd></div>
        <div><dt>30D EST. FEE APR</dt><dd>{formatPercent(feeApr30d?.aprPercent, 1)} · {feeAprCoverageLabel(feeApr30d)}</dd></div>
      </dl>
    </article>
    <article class="panel method-panel">
      <div class="panel-heading compact">
        <div><span class="section-index">[04]</span><h2>ACCOUNTING NOTES</h2></div>
      </div>
      <p><b>Exact flows:</b> system income funding and deployments are read from finalized block events and replayed after stream gaps.</p>
      <p><b>Current holdings:</b> LP units, pool ownership, RUNE held, and external assets held reconcile against THORNode pool state.</p>
      <p><b>Fee estimate:</b> pool liquidity fees are multiplied by SIPOL’s time-weighted pool share. This is not position P&amp;L.</p>
      <p><b>Estimated APR:</b> completed hourly fee estimates are divided by matching average SIPOL position-value hours and annualized without compounding. Seeded hours are labeled until measured values replace them.</p>
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
    font-size: 12px;
    font-weight: 700;
    letter-spacing: .12em;
    text-transform: uppercase;
  }
  .eyebrow, .section-index { color: var(--term-accent); }
  h1 {
    margin: 7px 0 8px;
    color: var(--term-text);
    font: 800 30px/1.1 'JetBrains Mono', monospace;
    letter-spacing: .05em;
  }
  h1 span { color: var(--term-accent); animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .terminal-header p, .panel-heading p {
    max-width: 880px;
    margin: 0;
    color: var(--term-text-2);
    font: 14px/1.55 'DM Sans', sans-serif;
  }
  .refresh, .unit-group button, .range-group button, .inline-action {
    border: 1px solid var(--term-border);
    border-radius: 0;
    color: var(--term-text-2);
    background: transparent;
    font: 600 12px/1 'JetBrains Mono', monospace;
    cursor: pointer;
  }
  .refresh { padding: 9px 12px; }
  .refresh span { color: var(--term-accent); }
  .refresh:hover, .unit-group button:hover, .unit-group button.active, .range-group button:hover, .range-group button.active { border-color: var(--term-accent); color: var(--term-accent); }
  .refresh:disabled { opacity: .55; cursor: wait; }
  .inline-action { margin-left: 8px; padding: 3px 6px; color: var(--term-accent); }
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
  .metric-index { position: absolute; top: 10px; right: 11px; color: var(--term-accent); font-size: 9px; }
  .metric-label { display: block; margin-bottom: 12px; color: var(--term-text-3); }
  .metric strong { display: block; color: var(--term-text); font-size: 25px; line-height: 1.1; }
  .metric small { display: block; margin-top: 8px; color: var(--term-text-3); font-size: 12px; letter-spacing: .04em; }
  .metric .metric-value--green { color: var(--term-accent); }
  .metric .metric-value--orange { color: var(--term-amber); }
  .metric--fees strong { color: var(--term-amber); }
  .metric-pair { display: grid; grid-template-columns: auto auto auto; align-items: flex-start; justify-content: start; gap: 10px; }
  .metric-pair > span { min-width: 0; }
  .metric-pair strong { font-size: clamp(21px, 1.6vw, 25px); white-space: nowrap; }
  .fee-metric-pair { gap: 8px; }
  .metric-pair.fee-metric-pair strong { font-size: clamp(18px, 1.35vw, 23px); }
  .fee-metric-pair small { margin-top: 6px; }
  .metric .metric-foot { margin-top: 7px; font-size: 10px; white-space: nowrap; }
  .metric-pair small { white-space: nowrap; }
  .metric-pair .metric-separator { color: var(--term-amber); font-size: clamp(21px, 1.6vw, 25px); font-weight: 700; line-height: 1.1; }
  .metric-link, .pool-link { color: inherit; text-decoration: none; }
  .metric-link { display: inline-flex; align-items: center; gap: 6px; }
  .metric-rune-icon { width: 20px; height: 20px; flex: 0 0 20px; object-fit: contain; }
  .pool-link { display: inline-flex; align-items: baseline; gap: 5px; }
  .table-token-icon { width: 14px; height: 14px; flex: 0 0 14px; align-self: center; object-fit: contain; }
  .metric-link:hover strong, .pool-link:hover strong { color: var(--term-accent); }
  .metric-link:focus-visible, .pool-link:focus-visible { outline: 1px solid var(--term-accent); outline-offset: 3px; }
  .external-mark { color: var(--term-accent); font-size: 10px; line-height: 1; }
  .deployment-pulse {
    display: block;
    margin-top: 8px;
    color: var(--term-accent);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .04em;
    animation: deployment-flash 1s ease-out both;
  }
  @keyframes deployment-flash {
    0% { opacity: 0; }
    12%, 72% { opacity: 1; }
    100% { opacity: 0; }
  }
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
  .asset-panel .panel-heading > div:first-child { padding-left: 0; }
  .section-index { position: absolute; left: 0; top: 2px; }
  h2 { margin: 0 0 5px; color: var(--term-text); font: 700 13px/1.2 'JetBrains Mono', monospace; letter-spacing: .07em; }
  .panel-heading:not(.compact) h2 { color: var(--term-text-strong); font-size: 16px; font-weight: 800; letter-spacing: .075em; }
  .panel-meta { color: var(--term-text-3); font-size: 12px; white-space: nowrap; }
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
    color: var(--term-text-3);
    font-size: 12px;
    letter-spacing: .08em;
  }
  .asset-grid span { overflow-wrap: anywhere; }
  .asset-value {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 9px 0 6px;
  }
  .asset-value img { width: 22px; height: 22px; flex: 0 0 22px; object-fit: contain; }
  .asset-grid strong {
    display: block;
    color: var(--term-accent);
    font-size: 23px;
  }
  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font: 13px/1.45 'JetBrains Mono', monospace; }
  th, td { padding: 11px 14px; border-bottom: 1px solid var(--term-border-faint); text-align: right; white-space: nowrap; }
  th { position: sticky; top: 0; color: var(--term-text-3); background: var(--term-surface); }
  .table-scroll th { font-size: 12px; }
  th:first-child, td:first-child { text-align: left; }
  td { color: var(--term-text-2); }
  td strong { color: var(--term-text); }
  td small { display: block; margin-top: 4px; color: var(--term-text-3); font-size: 12px; }
  td small.token-name { display: flex; align-items: center; justify-content: flex-end; gap: 5px; }
  .token-name img { width: 13px; height: 13px; object-fit: contain; }
  td.accent { color: var(--term-accent); }
  td.fee { color: var(--term-amber); }
  tbody tr:hover { background: var(--term-surface-hover); }
  .empty { padding: 28px; color: var(--term-text-3); text-align: center !important; font-size: 12px; }
  .chart-controls { display: flex; align-items: center; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
  .unit-group, .range-group { display: flex; gap: 5px; }
  .unit-group { padding-right: 10px; border-right: 1px solid var(--term-border); }
  .unit-group button, .range-group button { padding: 6px 8px; }
  .range-group .zoom-reset { color: var(--term-accent); border-color: var(--term-accent-edge); }
  .unit-group button:disabled, .range-group button:disabled { color: var(--term-text-5); border-color: var(--term-border); opacity: .45; cursor: default; }
  .chart-wrap { position: relative; height: 280px; padding: 8px 14px 0; }
  svg { display: block; width: 100%; height: 100%; overflow: visible; }
  .grid { stroke: var(--term-border-faint); stroke-width: 1; }
  .y-label, .x-label { fill: var(--term-text-3); font: 12px 'JetBrains Mono', monospace; }
  .y-label { text-anchor: end; }
  .y-label.cumulative-label { fill: var(--term-amber); text-anchor: start; }
  .x-label { text-anchor: middle; }
  .bar.deposited { fill: var(--term-accent); opacity: .82; }
  .bar.deposited:hover { opacity: 1; }
  .series { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; }
  .series.cumulative { stroke: var(--term-amber); }
  .cumulative-point { fill: var(--term-amber); stroke: var(--term-surface-deep); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .cursor-line { stroke: var(--term-text-4); stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; pointer-events: none; }
  .zoom-selection { fill: var(--term-accent-soft); stroke: var(--term-accent); stroke-width: 1; vector-effect: non-scaling-stroke; pointer-events: none; }
  .zoom-capture { cursor: crosshair; touch-action: none; }
  .chart-tooltip {
    position: absolute;
    z-index: 2;
    top: 16px;
    left: var(--tooltip-x);
    min-width: 245px;
    padding: 10px;
    border: 1px solid var(--term-border-strong);
    background: rgba(5, 5, 5, .96);
    color: var(--term-text-2);
    transform: translateX(10px);
    pointer-events: none;
    font: 12px/1.4 'JetBrains Mono', monospace;
  }
  .chart-tooltip.align-right { transform: translateX(calc(-100% - 10px)); }
  .chart-tooltip > strong { display: block; margin-bottom: 7px; color: var(--term-text); font-size: 12px; }
  .tooltip-row { display: grid; grid-template-columns: 8px 1fr auto; align-items: center; gap: 7px; padding: 3px 0; }
  .tooltip-row i { width: 7px; height: 7px; }
  .tooltip-row.daily i { background: var(--term-accent); }
  .tooltip-row.cumulative i { height: 2px; background: var(--term-amber); }
  .tooltip-row span { color: var(--term-text-3); }
  .tooltip-row b { color: var(--term-text); font-weight: 600; white-space: nowrap; }
  .legend { display: flex; align-items: center; gap: 18px; padding: 11px 18px; border-top: 1px solid var(--term-border-faint); color: var(--term-text-2); font-size: 12px; }
  .legend span { display: flex; align-items: center; gap: 6px; }
  .legend i { width: 14px; height: 8px; }
  .legend i.deposited { background: var(--term-accent); }
  .legend i.cumulative { height: 2px; background: var(--term-amber); }
  .legend small { margin-left: auto; color: var(--term-text-3); }
  .empty-chart { padding: 60px 20px; color: var(--term-text-3); text-align: center; font-size: 12px; }
  .coverage-grid { display: grid; grid-template-columns: minmax(300px, .8fr) minmax(420px, 1.2fr); gap: 14px; max-width: 1440px; margin: 0 auto; }
  .coverage-grid .panel { width: 100%; margin: 0; }
  .panel-heading.compact { padding: 13px 16px; }
  .panel-heading.compact h2 { margin: 0; }
  dl { margin: 0; }
  dl > div { display: flex; justify-content: space-between; gap: 20px; padding: 10px 16px; border-bottom: 1px solid var(--term-border-faint); }
  dl > div:last-child { border-bottom: 0; }
  dt { color: var(--term-text-3); }
  dd { margin: 0; color: var(--term-text); font-size: 12px; text-align: right; }
  .method-panel > p { margin: 12px 16px; color: var(--term-text-2); font: 14px/1.55 'DM Sans', sans-serif; }
  .method-panel b { color: var(--term-text); font-family: 'JetBrains Mono', monospace; font-size: 12px; }
  .source-line { display: block; margin: 14px 16px; color: var(--term-text-3); font-size: 12px; line-height: 1.5; }
  @media (max-width: 900px) {
    .sipol-shell { padding: 18px 12px 56px; }
    .terminal-header, .panel-heading { align-items: flex-start; flex-direction: column; }
    .metric-grid { grid-template-columns: 1fr; }
    .metric { border-right: 0; border-bottom: 1px solid var(--term-border) !important; }
    .metric:last-child { border-bottom: 0 !important; }
    .asset-grid { grid-template-columns: 1fr; }
    .asset-grid article { border-right: 0; border-bottom: 1px solid var(--term-border-faint); }
    .asset-grid article:last-child { border-bottom: 0; }
    .coverage-grid { grid-template-columns: 1fr; }
    .chart-wrap { height: 220px; }
  }
  @media (max-width: 560px) {
    h1 { font-size: 24px; }
    .terminal-header .refresh { width: 100%; }
    .panel-heading .chart-controls, .panel-heading .range-group { width: 100%; }
    .chart-controls { justify-content: flex-start; }
    .unit-group { width: 100%; padding: 0 0 8px; border-right: 0; border-bottom: 1px solid var(--term-border); }
    .unit-group button { flex: 1; }
    .range-group button { flex: 1; }
    .legend { flex-wrap: wrap; }
    .legend small { width: 100%; margin-left: 0; }
  }
</style>
