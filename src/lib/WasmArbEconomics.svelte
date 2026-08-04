<script>
  import { onDestroy, onMount, tick } from 'svelte';

  import { TerminalAlert } from '$lib/components/terminal';
  import './styles/variables.css';
  import { fetchWasmArbEconomics } from './wasm-arb-economics/api.js';
  import ChartControls from './wasm-arb-economics/ChartControls.svelte';
  import {
    aggregateWasmArbEconomicsBuckets,
    ceilWasmArbBucket,
    normalizeWasmArbEconomicsBuckets,
    summarizeWasmArbWindow
  } from './wasm-arb-economics/model.js';
  import {
    renderWasmArbActivityChart,
    renderWasmArbEfficiencyChart,
    renderWasmArbFeeBehaviorChart,
    renderWasmArbOracleChart,
    renderWasmArbValueChart
  } from './wasm-arb-economics/charts.js';

  const RANGE_OPTIONS = [
    { key: 'all', label: 'all since zero', seconds: null },
    { key: '1mo', label: '1mo', seconds: 30 * 24 * 60 * 60 },
    { key: '1w', label: '1w', seconds: 7 * 24 * 60 * 60 },
    { key: '24h', label: '24h', seconds: 24 * 60 * 60 }
  ];
  const BUCKET_OPTIONS = [
    { key: '1h', label: '1h', seconds: 60 * 60 },
    { key: '1d', label: '1d', seconds: 24 * 60 * 60 },
    { key: '1w', label: '1w', seconds: 7 * 24 * 60 * 60 }
  ];

  const usd2 = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  });
  const number0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

  let dashboard = null;
  let loading = true;
  let refreshing = false;
  let error = '';
  let selectedRange = 'all';
  let selectedBucket = '1h';
  let zoomRange = null;
  let valueCanvas;
  let activityCanvas;
  let efficiencyCanvas;
  let feeCanvas;
  let oracleCanvas;
  let valueChart;
  let activityChart;
  let efficiencyChart;
  let feeChart;
  let oracleChart;
  let chartRenderTimer;
  let chartRenderKey = '';

  $: rows = normalizeWasmArbEconomicsBuckets(dashboard?.rows || []);
  $: trackingRegime = dashboard?.meta?.trackingRegime
    || dashboard?.meta?.currentRegime
    || null;
  $: trackingStart = dashboard?.meta?.trackingStart
    || trackingRegime?.activationTime
    || rows[0]?.bucketStart
    || null;
  $: trackingStartSeconds = trackingStart ? ceilWasmArbBucket(trackingStart) : 0;
  $: postChangeRows = rows.filter((row) => row.startSeconds >= trackingStartSeconds);
  $: latestEnd = postChangeRows.reduce(
    (latest, row) => Math.max(latest, row.startSeconds + row.bucketSeconds),
    0
  );
  $: selectedOption = RANGE_OPTIONS.find((option) => option.key === selectedRange)
    || RANGE_OPTIONS[0];
  $: selectedBucketOption = BUCKET_OPTIONS.find((option) => option.key === selectedBucket)
    || BUCKET_OPTIONS[0];
  $: presetStart = selectedOption.seconds
    ? Math.max(trackingStartSeconds, latestEnd - selectedOption.seconds)
    : trackingStartSeconds;
  $: visibleStart = zoomRange
    ? Math.max(presetStart, zoomRange.startSeconds)
    : presetStart;
  $: visibleEnd = zoomRange
    ? Math.min(latestEnd, zoomRange.endSeconds)
    : latestEnd;
  $: visibleRows = postChangeRows.filter((row) => (
    row.startSeconds + row.bucketSeconds > visibleStart
      && row.startSeconds < visibleEnd
  ));
  $: visibleSeconds = Math.max(0, visibleEnd - visibleStart);
  $: chartGrainSeconds = selectedBucketOption.seconds;
  $: chartSeries = aggregateWasmArbEconomicsBuckets(visibleRows, chartGrainSeconds);
  $: trailingBucketPartial = Boolean(chartSeries.at(-1)?.partial);
  $: hasCoarserSourceBuckets = chartSeries.some(
    (row) => row.bucketSeconds > chartGrainSeconds
  );
  $: summary = summarizeWasmArbWindow(visibleRows);
  $: chartControlProps = {
    windowStart: formatDateTime(visibleRows[0]?.bucketStart),
    windowEnd: formatDateTime(summary.endTime),
    customDuration: formatDuration(visibleSeconds),
    rangeOptions: RANGE_OPTIONS,
    bucketOptions: BUCKET_OPTIONS,
    selectedRange,
    selectedBucket,
    zoomed: Boolean(zoomRange),
    hasCoarserSourceBuckets,
    onRange: setRange,
    onBucket: setBucket,
    onReset: resetZoom
  };
  $: interventions = dashboard?.meta?.interventions || dashboard?.regimes || [];
  $: visibleMilestones = interventions.filter((row) => {
    const timestamp = Date.parse(row?.activationTime || '') / 1000;
    return Number(row?.activationHeight) !== Number(trackingRegime?.activationHeight)
      && Number.isFinite(timestamp)
      && timestamp >= visibleStart
      && timestamp < visibleEnd;
  });
  $: sourceCoverage = dashboard?.meta?.coverage || {};
  $: oracleGapCount = Number(
    sourceCoverage.oracleGapCount || sourceCoverage.oracleGaps?.length || 0
  );
  $: economicsComplete = summary.bucketCount > 0
    && summary.networkBucketCoverage >= 0.98
    && summary.actionBucketCoverage >= 0.98
    && summary.feeBucketCoverage >= 0.98
    && summary.pricingCoverage >= 0.98;
  $: oracleComplete = summary.bucketCount > 0
    && summary.oracleCoverageComplete
    && summary.oracleBucketCoverage >= 0.98;
  $: newChartRenderKey = [
    visibleRows.length,
    visibleRows[0]?.bucketStart || '',
    visibleRows.at(-1)?.bucketStart || '',
    dashboard?.meta?.sourceUpdatedAt || '',
    chartGrainSeconds,
    visibleEnd,
    visibleMilestones.map((row) => row.activationHeight).join(',')
  ].join('|');
  $: if (newChartRenderKey && newChartRenderKey !== chartRenderKey) {
    chartRenderKey = newChartRenderKey;
    scheduleCharts();
  }

  function asFiniteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatUsd(value) {
    const number = asFiniteNumber(value);
    return number === null ? '—' : usd2.format(number);
  }

  function formatCompactUsd(value) {
    const number = asFiniteNumber(value);
    if (number === null) return '—';
    if (Math.abs(number) >= 1_000_000) return `$${(number / 1_000_000).toFixed(2)}m`;
    if (Math.abs(number) >= 1_000) return `$${(number / 1_000).toFixed(2)}k`;
    return formatUsd(number);
  }

  function formatCount(value) {
    const number = asFiniteNumber(value);
    return number === null ? '—' : number0.format(number);
  }

  function formatPercent(value, digits = 2) {
    const number = asFiniteNumber(value);
    return number === null ? '—' : `${(number * 100).toFixed(digits)}%`;
  }

  function formatBps(value) {
    const number = asFiniteNumber(value);
    return number === null ? '—' : `${number.toFixed(2)} bps`;
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return `${date.toLocaleString('en-US', {
      month: 'short',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC'
    })} UTC`;
  }

  function formatDuration(seconds) {
    const totalHours = Math.max(0, Math.round((Number(seconds) || 0) / 3600));
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return [days ? `${days}d` : '', hours ? `${hours}h` : ''].filter(Boolean).join(' ') || '<1h';
  }

  function formatGrain(seconds) {
    if (seconds >= 7 * 24 * 60 * 60) return '1W';
    if (seconds >= 24 * 60 * 60) return '1D';
    if (seconds >= 60 * 60) return `${seconds / 3600}H`;
    return `${seconds / 60}M`;
  }

  function setRange(key) {
    selectedRange = key;
    zoomRange = null;
  }

  function setBucket(key) {
    selectedBucket = key;
  }

  function applyChartZoom(range) {
    const startSeconds = Math.max(visibleStart, Number(range?.startSeconds) || visibleStart);
    const endSeconds = Math.min(visibleEnd, Number(range?.endSeconds) || visibleEnd);
    if (endSeconds <= startSeconds || endSeconds - startSeconds >= visibleSeconds) return;
    zoomRange = { startSeconds, endSeconds };
  }

  function resetZoom() {
    zoomRange = null;
  }

  function shortAddress(value) {
    const address = String(value || '');
    return address.length > 24 ? `${address.slice(0, 13)}…${address.slice(-8)}` : address || '—';
  }

  function milestoneLabel(row) {
    if (row?.changeKind?.includes('spread')) return `SPREAD_BPS → ${row.spreadBps}`;
    return `MIMIR → ${row?.mimirValue ?? '—'}`;
  }

  async function load(forceRefresh = false) {
    if (forceRefresh) refreshing = true;
    else loading = true;
    error = '';
    try {
      dashboard = await fetchWasmArbEconomics({ forceRefresh });
    } catch (loadError) {
      error = loadError?.message || 'Wasm arb economics data is unavailable';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  function scheduleCharts() {
    clearTimeout(chartRenderTimer);
    chartRenderTimer = setTimeout(async () => {
      await tick();
      if (!visibleRows.length) return;
      valueChart = renderWasmArbValueChart(
        valueCanvas,
        valueChart,
        visibleRows,
        chartGrainSeconds,
        visibleMilestones,
        applyChartZoom
      );
      activityChart = renderWasmArbActivityChart(
        activityCanvas,
        activityChart,
        visibleRows,
        chartGrainSeconds,
        visibleMilestones,
        applyChartZoom
      );
      efficiencyChart = renderWasmArbEfficiencyChart(
        efficiencyCanvas,
        efficiencyChart,
        visibleRows,
        chartGrainSeconds,
        visibleMilestones,
        applyChartZoom
      );
      feeChart = renderWasmArbFeeBehaviorChart(
        feeCanvas,
        feeChart,
        visibleRows,
        chartGrainSeconds,
        visibleMilestones,
        applyChartZoom
      );
      oracleChart = renderWasmArbOracleChart(
        oracleCanvas,
        oracleChart,
        visibleRows,
        chartGrainSeconds,
        visibleMilestones,
        applyChartZoom
      );
    }, 0);
  }

  onMount(() => load());
  onDestroy(() => {
    clearTimeout(chartRenderTimer);
    valueChart?.destroy();
    activityChart?.destroy();
    efficiencyChart?.destroy();
    feeChart?.destroy();
    oracleChart?.destroy();
  });
</script>

<div class="wasm-monitor">
  <div class="command-head">
    <div><span class="prompt">$</span> monitor wasm-arb <span class="arg">--since-mimir-zero</span></div>
    <div class="command-actions">
      <span class="status-pill" class:warn={!economicsComplete}>
        <span class="status-dot" class:warn={!economicsComplete}></span>
        {economicsComplete ? 'COMPLETE' : 'SYNCING'}
      </span>
      <button class="bracket-button" on:click={() => load(true)} disabled={refreshing}>
        <span>[</span><b>R</b><span>]</span> {refreshing ? 'refreshing' : 'refresh'}
      </button>
    </div>
  </div>

  <header class="page-head">
    <div class="eyebrow">POST-CHANGE ECONOMIC TELEMETRY</div>
    <h1><span>›</span> WASM ARB MONITOR<span class="cursor">_</span></h1>
    <p>A continuous time series beginning when <code>WasmArbSlipMinBps</code> changed to zero. It tracks THORChain value accrued, Wasm activity, unit economics, fee behavior, and pool/oracle alignment without anchoring the dashboard to a pre-change window.</p>
  </header>

  {#if error}
    <TerminalAlert tone="err">{error}</TerminalAlert>
  {/if}
  {#if dashboard?.meta?.warning}
    <TerminalAlert tone="warn">{dashboard.meta.warning}</TerminalAlert>
  {/if}

  {#if loading}
    <div class="loading-block"><span>▓░░░░</span> loading post-change economics series…</div>
  {:else if dashboard && postChangeRows.length}
    <section class="tracking-strip" aria-label="Tracking origin">
      <div>
        <span>TRACKING ORIGIN</span>
        <b>MIMIR {trackingRegime?.previousMimirValue ?? '—'} → {trackingRegime?.mimirValue ?? 0}</b>
        <small>{formatDateTime(trackingStart)} · height {formatCount(trackingRegime?.activationHeight)}</small>
      </div>
      <div>
        <span>OBSERVED</span>
        <b>{formatDuration(latestEnd - trackingStartSeconds)}</b>
        <small>{formatCount(postChangeRows.length)} series buckets</small>
      </div>
      <div>
        <span>CHART BUCKET</span>
        <b>{formatGrain(chartGrainSeconds)}</b>
        <small>{formatCount(chartSeries.length)} plotted buckets{hasCoarserSourceBuckets ? ' · mixed source floor' : ''}</small>
      </div>
      <div>
        <span>CURRENT SETTINGS</span>
        <b>MIMIR {dashboard.meta?.currentRegime?.mimirValue ?? '—'} · SPREAD {dashboard.meta?.currentSpreadRegime?.spreadBps ?? '—'}</b>
        <small>later changes appear as chart markers</small>
      </div>
    </section>

    <div class="metric-grid">
      <article>
        <span class="metric-index">01</span>
        <span class="metric-label">ACCRUED TC VALUE</span>
        <strong>{formatUsd(summary.tcLinkedValueUsd)}</strong>
        <small>pool fees {formatUsd(summary.wasmLiquidityFeeUsd)} + app accrual {formatUsd(summary.linkedTcReserveUsd)}</small>
      </article>
      <article>
        <span class="metric-index">02</span>
        <span class="metric-label">WASM EXECUTED VOLUME</span>
        <strong>{formatCompactUsd(summary.wasmLegVolumeUsd)}</strong>
        <small>{formatPercent(summary.wasmNetworkVolumeShare, 3)} of network volume</small>
      </article>
      <article>
        <span class="metric-index">03</span>
        <span class="metric-label">TC / $1M WASM VOL</span>
        <strong>{formatUsd(summary.tcPerMillionWasmVolumeUsd)}</strong>
        <small>{formatUsd(summary.tcPerMillionNetworkVolumeUsd)} per $1m network volume</small>
      </article>
      <article>
        <span class="metric-index">04</span>
        <span class="metric-label">LINKED APP FEES</span>
        <strong>{formatUsd(summary.linkedRujiraFeeUsd)}</strong>
        <small>{formatPercent(summary.averageTcShare, 0)} allocated to TC · settlement not implied</small>
      </article>
    </div>

    <section class="block chart-block primary-chart">
      <div class="block-head">
        <h2><span>▌</span> ACCRUED TC VALUE</h2>
        <span>[USD / {formatGrain(chartGrainSeconds)}{trailingBucketPartial ? ' · LIVE BUCKET DIMMED' : ''}]</span>
      </div>
      <p class="block-lede">Each column is split into the two attributable sources: Wasm THOR pool fees and THORChain’s configured share of Wasm-linked FIN + AMM fees.</p>
      <ChartControls {...chartControlProps} chartLabel="Accrued TC value" />
      <div class="chart-shell primary"><canvas bind:this={valueCanvas} on:dblclick={resetZoom} aria-label="Accrued THORChain value time series; drag to zoom"></canvas></div>
    </section>

    <div class="chart-grid">
      <section class="block chart-block">
        <div class="block-head">
          <h2><span>▌</span> WASM ACTIVITY</h2>
          <span>[VOLUME + NETWORK SHARE]</span>
        </div>
        <p class="block-lede">Executed-leg volume through the Wasm arb path and its share of total THORChain executed-leg volume.</p>
        <ChartControls {...chartControlProps} chartLabel="Wasm activity" />
        <div class="chart-shell"><canvas bind:this={activityCanvas} on:dblclick={resetZoom} aria-label="Wasm activity time series; drag to zoom"></canvas></div>
      </section>

      <section class="block chart-block">
        <div class="block-head">
          <h2><span>▌</span> VALUE DENSITY</h2>
          <span>[TC VALUE / $1M]</span>
        </div>
        <p class="block-lede">Value accrued to THORChain per unit of both Wasm volume and total network volume.</p>
        <ChartControls {...chartControlProps} chartLabel="Value density" />
        <div class="chart-shell"><canvas bind:this={efficiencyCanvas} on:dblclick={resetZoom} aria-label="THORChain value density time series; drag to zoom"></canvas></div>
      </section>

      <section class="block chart-block">
        <div class="block-head">
          <h2><span>▌</span> FEE + EXECUTION BEHAVIOR</h2>
          <span>[BASIS POINTS]</span>
        </div>
        <p class="block-lede">Effective THOR pool-fee yield alongside the median and p90 action slip paid by Wasm swaps.</p>
        <ChartControls {...chartControlProps} chartLabel="Fee and execution behavior" />
        <div class="chart-shell"><canvas bind:this={feeCanvas} on:dblclick={resetZoom} aria-label="Fee and execution behavior time series; drag to zoom"></canvas></div>
      </section>

      <section class="block chart-block">
        <div class="block-head">
          <h2><span>▌</span> POOL / ORACLE ALIGNMENT</h2>
          <span>[SAME-HEIGHT SAMPLES]</span>
        </div>
        <p class="block-lede">Depth-weighted absolute pool-price deviation from THORChain’s oracle, with an LTC-excluded line and the share within 10 bps.</p>
        <ChartControls {...chartControlProps} chartLabel="Pool and oracle alignment" />
        {#if !oracleComplete}<div class="inline-warning">WRN · selected range has incomplete oracle coverage</div>{/if}
        <div class="chart-shell"><canvas bind:this={oracleCanvas} on:dblclick={resetZoom} aria-label="Pool and oracle alignment time series; drag to zoom"></canvas></div>
      </section>
    </div>

    {#if visibleMilestones.length}
      <section class="block milestone-block">
        <div class="block-head">
          <h2><span>▌</span> REGIME MARKERS</h2>
          <span>[WITHIN VISIBLE RANGE]</span>
        </div>
        <div class="milestone-list">
          {#each visibleMilestones as milestone}
            <div>
              <span>{milestoneLabel(milestone)}</span>
              <b>{formatDateTime(milestone.activationTime)}</b>
              <small>height {formatCount(milestone.activationHeight)}</small>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <div class="detail-grid">
      <section class="block">
        <div class="block-head">
          <h2><span>▌</span> VISIBLE-RANGE TOTALS</h2>
          <span>[{zoomRange ? `CUSTOM · ${formatDuration(visibleSeconds)}` : selectedOption.label.toUpperCase()}]</span>
        </div>
        <div class="ledger-grid">
          <div><span>NETWORK LEG VOLUME</span><b>{formatCompactUsd(summary.networkVolumeUsd)}</b></div>
          <div><span>WASM ACTIONS</span><b>{formatCount(summary.wasmActionCount)}</b></div>
          <div><span>WASM THOR FEES</span><b>{formatUsd(summary.wasmLiquidityFeeUsd)}</b></div>
          <div><span>THOR FEE YIELD</span><b>{formatBps(summary.wasmLegFeeBps)}</b></div>
          <div><span>ZERO-SLIP ACTIONS</span><b>{formatPercent(summary.zeroSlipShare, 1)}</b></div>
          <div><span>ZERO-THOR-FEE ACTIONS</span><b>{formatPercent(summary.zeroFeeShare, 1)}</b></div>
          <div><span>ALL TRACKED APP FEES</span><b>{formatUsd(summary.allRujiraFeeUsd)}</b></div>
          <div><span>LINKED FEE PRICING</span><b>{formatPercent(summary.pricingCoverage, 1)}</b></div>
        </div>
      </section>

      <section class="block health-block">
        <div class="block-head">
          <h2><span>▌</span> DATA HEALTH</h2>
          <span>[AS OF {formatDateTime(dashboard.meta?.sourceUpdatedAt)}]</span>
        </div>
        <div class="health-grid">
          <div><span class:ok={sourceCoverage.networkComplete} class="health-dot"></span><b>NETWORK 5M</b><small>{sourceCoverage.networkComplete ? 'caught up' : 'backfilling'}</small></div>
          <div><span class:ok={sourceCoverage.actionBackfillComplete} class="health-dot"></span><b>WASM ACTIONS</b><small>{sourceCoverage.actionBackfillComplete ? 'caught up' : 'backfilling'}</small></div>
          <div><span class:ok={sourceCoverage.feeBackfillComplete} class="health-dot"></span><b>FIN + AMM FEES</b><small>{sourceCoverage.pendingBlocks || 0} blocks pending</small></div>
          <div><span class:ok={sourceCoverage.oracleCoverageComplete} class:warn={sourceCoverage.oracleBackfillComplete && oracleGapCount > 0} class="health-dot"></span><b>POOL / ORACLE</b><small>{sourceCoverage.oracleBackfillComplete ? (oracleGapCount > 0 ? `${oracleGapCount} source gap${oracleGapCount === 1 ? '' : 's'}` : 'caught up') : 'backfilling'}</small></div>
        </div>
      </section>
    </div>

    <section class="block attribution-block">
      <div class="block-head">
        <h2><span>▌</span> ATTRIBUTION + GUARDRAILS</h2>
        <span>[CORRECTED ACCOUNTING V2]</span>
      </div>
      <div class="attribution-grid">
        <div><span>WASM ARB</span><code title={dashboard.meta?.contracts?.wasmArb}>{shortAddress(dashboard.meta?.contracts?.wasmArb)}</code></div>
        <div><span>TRADE COLLECTOR</span><code title={dashboard.meta?.contracts?.rujiraTradeCollector}>{shortAddress(dashboard.meta?.contracts?.rujiraTradeCollector)}</code></div>
        <div><span>BASE LAYER</span><code title={dashboard.meta?.contracts?.baseLayerCollector}>{shortAddress(dashboard.meta?.contracts?.baseLayerCollector)}</code></div>
        <div><span>FIN SCOPE</span><code>{dashboard.meta?.contracts?.finContractCount || '—'} contracts · code {dashboard.meta?.contracts?.finCodeIds?.join(', ') || '—'}</code></div>
      </div>
      <details>
        <summary><span>[+]</span> methodology and guardrails</summary>
        <ul>
          {#each Object.values(dashboard.meta?.methodology || {}) as note}
            <li>{note}</li>
          {/each}
        </ul>
      </details>
      <p class="scope-note">This is an observed cash-flow monitor, not a causal verdict. It does not price LVR reduction or arbitrage profit, and the app-fee allocation represents economic accrual rather than same-period Reserve settlement.</p>
    </section>
  {:else if dashboard}
    <TerminalAlert tone="warn">No complete post-change series is available yet.</TerminalAlert>
  {/if}
</div>

<style>
  .wasm-monitor {
    max-width: 1400px;
    margin: 0 auto;
    padding: 24px 0 56px;
    color: var(--term-text-body);
    font-family: var(--term-font-body);
    font-size: var(--term-type-body);
    line-height: var(--term-leading-body);
  }

  .command-head,
  .command-actions,
  .block-head,
  .attribution-grid > div {
    display: flex;
    align-items: center;
  }

  .command-head {
    justify-content: space-between;
    gap: 16px;
    padding-bottom: 13px;
    border-bottom: 1px solid var(--term-border);
    color: var(--term-text-3);
    font: 12px var(--term-font-mono);
  }

  .prompt,
  h1 > span:first-child,
  .metric-index,
  .block-head h2 span {
    color: var(--term-accent);
  }

  .arg { color: var(--term-text-5); }
  .command-actions { gap: 9px; }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border: 1px solid var(--term-border);
    border-radius: 999px;
    color: var(--term-accent);
    font: 700 10px var(--term-font-mono);
    letter-spacing: 0.08em;
  }

  .status-pill.warn { color: var(--term-amber); }
  .status-dot,
  .health-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--term-text-6);
  }
  .status-dot { background: var(--term-accent); animation: pulse-dot 2s infinite; }
  .status-dot.warn { background: var(--term-amber); animation: none; }
  .health-dot.ok { background: var(--term-accent); box-shadow: var(--term-accent-glow); }
  .health-dot.warn { background: var(--term-amber); box-shadow: 0 0 6px var(--term-amber); }

  .bracket-button {
    border: 1px solid var(--term-border);
    background: transparent;
    color: var(--term-text-2);
    cursor: pointer;
    font: 600 11px var(--term-font-mono);
    transition: border-color var(--term-transition), color var(--term-transition);
  }
  .bracket-button { padding: 5px 10px; }
  .bracket-button span { color: var(--term-text-5); }
  .bracket-button b { color: var(--term-accent); }
  .bracket-button:hover { border-color: var(--term-accent); color: var(--term-accent); }
  .bracket-button:disabled { opacity: 0.55; cursor: wait; }

  .page-head { padding: 28px 0 24px; }
  .eyebrow {
    color: var(--term-accent);
    font: 700 11px var(--term-font-mono);
    letter-spacing: 0.16em;
  }
  h1 {
    margin: 6px 0 10px;
    color: var(--term-text);
    font: 800 30px/1.1 var(--term-font-mono);
    letter-spacing: 0.06em;
  }
  .cursor { color: var(--term-accent); animation: cursor-blink 1s steps(1) infinite; }
  .page-head p,
  .block-lede,
  .scope-note {
    max-width: 940px;
    margin: 0;
    color: var(--term-text-2);
    font-size: 14px;
    line-height: 1.65;
  }
  .page-head code {
    padding: 1px 5px;
    border: 1px solid var(--term-border);
    background: var(--term-border-faint);
    color: var(--term-accent);
    font: 12px var(--term-font-mono);
  }

  .loading-block {
    padding: 34px 20px;
    border: 1px solid var(--term-border);
    background: var(--term-surface);
    color: var(--term-text-3);
    font: 12px var(--term-font-mono);
  }
  .loading-block span { color: var(--term-accent); }

  .tracking-strip,
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border: 1px solid var(--term-border);
    background: var(--term-surface);
  }
  .tracking-strip { margin-bottom: 12px; }
  .tracking-strip > div,
  .metric-grid article {
    min-width: 0;
    padding: 15px 17px;
    border-right: 1px solid var(--term-border);
  }
  .tracking-strip > div:last-child,
  .metric-grid article:last-child { border-right: none; }
  .tracking-strip span,
  .metric-label,
  .ledger-grid span,
  .attribution-grid span,
  .milestone-list span {
    display: block;
    color: var(--term-text-4);
    font: 700 11px var(--term-font-mono);
    letter-spacing: 0.1em;
  }
  .tracking-strip b {
    display: block;
    margin: 5px 0 2px;
    color: var(--term-text);
    font: 700 13px var(--term-font-mono);
  }
  .tracking-strip small,
  .metric-grid small,
  .milestone-list small {
    display: block;
    color: var(--term-text-4);
    font: 11px/1.5 var(--term-font-mono);
  }

  .metric-grid { margin-bottom: 12px; }
  .metric-grid article { min-height: 118px; }
  .metric-index { font: 700 11px var(--term-font-mono); }
  .metric-label { margin-top: 5px; color: var(--term-text-3); }
  .metric-grid strong {
    display: block;
    margin: 8px 0 5px;
    color: var(--term-text-strong);
    font: 800 24px/1.1 var(--term-font-mono);
    letter-spacing: -0.01em;
  }

  .block {
    min-width: 0;
    border: 1px solid var(--term-border);
    background: var(--term-surface);
    padding: 18px 20px 22px;
  }
  .block-head {
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 10px;
    color: var(--term-text-4);
    font: 11px var(--term-font-mono);
  }
  .block-head h2 {
    margin: 0;
    color: var(--term-text);
    font: 700 14px/1.2 var(--term-font-mono);
    letter-spacing: 0.08em;
  }
  .block-head h2 span { margin-right: 7px; }
  .primary-chart { margin-bottom: 12px; }
  .chart-grid,
  .detail-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 12px;
  }
  .chart-shell { position: relative; height: 300px; margin-top: 12px; }
  .chart-shell.primary { height: 340px; }
  .inline-warning {
    margin-top: 9px;
    color: var(--term-amber);
    font: 11px var(--term-font-mono);
  }

  .milestone-block { margin-bottom: 12px; }
  .milestone-list {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1px;
    background: var(--term-border);
  }
  .milestone-list > div { padding: 13px 14px; background: var(--term-surface-deep); }
  .milestone-list span { color: var(--term-amber); }
  .milestone-list b {
    display: block;
    margin-top: 5px;
    color: var(--term-text);
    font: 600 12px var(--term-font-mono);
  }

  .ledger-grid,
  .health-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1px;
    background: var(--term-border);
  }
  .ledger-grid > div,
  .health-grid > div {
    padding: 12px 13px;
    background: var(--term-surface-deep);
  }
  .ledger-grid b {
    display: block;
    margin-top: 5px;
    color: var(--term-text);
    font: 700 13px var(--term-font-mono);
  }
  .health-grid > div {
    display: grid;
    grid-template-columns: 10px 1fr;
    align-items: center;
    column-gap: 7px;
  }
  .health-grid b { color: var(--term-text); font: 700 11px var(--term-font-mono); }
  .health-grid small {
    grid-column: 2;
    color: var(--term-text-4);
    font: 11px var(--term-font-mono);
  }

  .attribution-block { margin-top: 0; }
  .attribution-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1px;
    background: var(--term-border);
  }
  .attribution-grid > div {
    justify-content: space-between;
    gap: 10px;
    min-width: 0;
    padding: 11px 12px;
    background: var(--term-surface-deep);
  }
  .attribution-grid code {
    overflow: hidden;
    color: var(--term-text-2);
    font: 11px var(--term-font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  details { margin-top: 14px; border-top: 1px solid var(--term-border); padding-top: 12px; }
  summary {
    color: var(--term-text-2);
    cursor: pointer;
    font: 600 12px var(--term-font-mono);
  }
  summary span { color: var(--term-accent); }
  details ul { margin: 12px 0 0; padding-left: 18px; color: var(--term-text-2); }
  details li { margin: 6px 0; font-size: 13px; line-height: 1.55; }
  .scope-note { max-width: none; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--term-border); }

  @keyframes cursor-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
  @keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

  @media (max-width: 1050px) {
    .tracking-strip,
    .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .tracking-strip > div:nth-child(2),
    .metric-grid article:nth-child(2) { border-right: none; }
    .tracking-strip > div:nth-child(-n + 2),
    .metric-grid article:nth-child(-n + 2) { border-bottom: 1px solid var(--term-border); }
    .attribution-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }

  @media (max-width: 760px) {
    .wasm-monitor { padding: 16px 0 40px; }
    .command-head { align-items: flex-start; flex-direction: column; }
    .command-actions { width: 100%; justify-content: space-between; }
    h1 { font-size: 24px; }
    .chart-grid,
    .detail-grid { grid-template-columns: 1fr; }
    .chart-shell,
    .chart-shell.primary { height: 290px; }
    .block { padding: 16px 14px 18px; }
    .block-head { align-items: flex-start; flex-direction: column; gap: 4px; }
    .milestone-list,
    .attribution-grid { grid-template-columns: 1fr; }
  }

  @media (max-width: 520px) {
    .tracking-strip,
    .metric-grid { grid-template-columns: 1fr; }
    .tracking-strip > div,
    .metric-grid article { border-right: none; border-bottom: 1px solid var(--term-border); }
    .tracking-strip > div:last-child,
    .metric-grid article:last-child { border-bottom: none; }
    .ledger-grid,
    .health-grid { grid-template-columns: 1fr; }
  }
</style>
