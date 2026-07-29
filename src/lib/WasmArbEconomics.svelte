<script>
  import { onDestroy, onMount, tick } from 'svelte';

  import { TerminalAlert } from '$lib/components/terminal';
  import { fetchWasmArbEconomics } from './wasm-arb-economics/api.js';
  import {
    ceilWasmArbBucket,
    compareWasmArbEqualWindows,
    normalizeWasmArbEconomicsBuckets
  } from './wasm-arb-economics/model.js';
  import {
    renderWasmArbEfficiencyChart,
    renderWasmArbValueChart
  } from './wasm-arb-economics/charts.js';

  const WINDOW_OPTIONS = [
    { key: 'since', label: 'since change', seconds: 14 * 24 * 60 * 60 },
    { key: '6h', label: '6h', seconds: 6 * 60 * 60 },
    { key: '24h', label: '24h', seconds: 24 * 60 * 60 },
    { key: '3d', label: '3d', seconds: 3 * 24 * 60 * 60 },
    { key: '7d', label: '7d', seconds: 7 * 24 * 60 * 60 }
  ];

  const usd2 = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  });
  const usd4 = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4
  });
  const number0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const number2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

  let dashboard = null;
  let loading = true;
  let refreshing = false;
  let error = '';
  let selectedWindow = 'since';
  let valueCanvas;
  let efficiencyCanvas;
  let valueChart;
  let efficiencyChart;
  let chartRenderKey = '';
  let chartRenderTimer;

  $: rows = normalizeWasmArbEconomicsBuckets(dashboard?.rows || []);
  $: regime = dashboard?.meta?.currentRegime || dashboard?.regimes?.at(-1) || null;
  $: selectedOption = WINDOW_OPTIONS.find((option) => option.key === selectedWindow)
    || WINDOW_OPTIONS[0];
  $: latestEnd = rows.reduce(
    (latest, row) => Math.max(latest, row.startSeconds + row.bucketSeconds),
    0
  );
  $: availableSinceChange = regime
    ? Math.max(300, latestEnd - ceilWasmArbBucket(regime.activationTime))
    : 300;
  $: requestedWindowSeconds = selectedWindow === 'since'
    ? Math.min(selectedOption.seconds, availableSinceChange)
    : selectedOption.seconds;
  $: comparison = regime
    ? compareWasmArbEqualWindows(rows, {
        anchorTime: regime.activationTime,
        windowSeconds: requestedWindowSeconds
      })
    : { ready: false, reason: 'No Mimir regime has been recorded yet.' };
  $: visibleRows = comparison.ready
    ? rows.filter((row) => (
        row.startSeconds >= comparison.bounds.preStart
          && row.startSeconds < comparison.bounds.postEnd
      ))
    : rows;
  $: newChartRenderKey = [
    visibleRows.length,
    visibleRows.at(-1)?.bucketStart || '',
    regime?.activationTime || '',
    selectedWindow,
    comparison.ready ? comparison.windowSeconds : 0
  ].join('|');
  $: if (newChartRenderKey && newChartRenderKey !== chartRenderKey) {
    chartRenderKey = newChartRenderKey;
    scheduleCharts();
  }
  $: metricRows = comparison.ready ? buildMetricRows(comparison) : [];
  $: sourceCoverage = dashboard?.meta?.coverage || {};
  $: comparisonProvisional = comparison?.ready && (
    comparison.truncated
      || (selectedWindow === 'since' && availableSinceChange < selectedOption.seconds)
  );
  $: verdictTone = comparison?.verdict === 'positive'
    ? 'positive'
    : comparison?.verdict === 'negative'
      ? 'negative'
      : 'neutral';

  function formatUsd(value, precise = false) {
    const number = Number(value);
    return Number.isFinite(number) ? (precise ? usd4 : usd2).format(number) : '—';
  }

  function formatCompactUsd(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    if (Math.abs(number) >= 1_000_000) return `$${(number / 1_000_000).toFixed(2)}m`;
    if (Math.abs(number) >= 1_000) return `$${(number / 1_000).toFixed(2)}k`;
    return formatUsd(number);
  }

  function formatCount(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number0.format(number) : '—';
  }

  function formatPercent(value, digits = 2) {
    const number = Number(value);
    return Number.isFinite(number) ? `${(number * 100).toFixed(digits)}%` : '—';
  }

  function formatSignedPercent(value, digits = 1) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return `${number >= 0 ? '+' : ''}${(number * 100).toFixed(digits)}%`;
  }

  function formatBps(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(2)} bps` : '—';
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return `${date.toLocaleString('en-US', {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC'
    })} UTC`;
  }

  function formatDuration(seconds) {
    const totalMinutes = Math.round((Number(seconds) || 0) / 60);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    return [days ? `${days}d` : '', hours ? `${hours}h` : '', minutes ? `${minutes}m` : '']
      .filter(Boolean)
      .join(' ') || '0m';
  }

  function signedUsd(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return `${number >= 0 ? '+' : '−'}${formatUsd(Math.abs(number))}`;
  }

  function deltaClass(value) {
    const number = Number(value);
    return number > 0 ? 'up' : number < 0 ? 'down' : '';
  }

  function shortAddress(value) {
    const address = String(value || '');
    return address.length > 24 ? `${address.slice(0, 13)}…${address.slice(-8)}` : address || '—';
  }

  function buildMetricRows(result) {
    const before = result.before;
    const after = result.after;
    const deltas = result.deltas;
    return [
      {
        label: 'Network executed-leg volume',
        before: formatCompactUsd(before.networkVolumeUsd),
        after: formatCompactUsd(after.networkVolumeUsd),
        delta: formatSignedPercent(deltas.networkVolumeUsd.percent),
        deltaValue: deltas.networkVolumeUsd.absolute
      },
      {
        label: 'Wasm actions',
        before: formatCount(before.wasmActionCount),
        after: formatCount(after.wasmActionCount),
        delta: formatSignedPercent(deltas.wasmActionCount.percent),
        deltaValue: deltas.wasmActionCount.absolute
      },
      {
        label: 'Wasm executed-leg volume',
        before: formatCompactUsd(before.wasmLegVolumeUsd),
        after: formatCompactUsd(after.wasmLegVolumeUsd),
        delta: formatSignedPercent(deltas.wasmLegVolumeUsd.percent),
        deltaValue: deltas.wasmLegVolumeUsd.absolute
      },
      {
        label: 'Wasm share of network volume',
        before: formatPercent(before.wasmNetworkVolumeShare, 3),
        after: formatPercent(after.wasmNetworkVolumeShare, 3),
        delta: formatSignedPercent(deltas.wasmNetworkVolumeShare.percent),
        deltaValue: deltas.wasmNetworkVolumeShare.absolute
      },
      {
        label: 'THOR liquidity fees from Wasm',
        before: formatUsd(before.wasmLiquidityFeeUsd),
        after: formatUsd(after.wasmLiquidityFeeUsd),
        delta: `${signedUsd(deltas.wasmLiquidityFeeUsd.absolute)} · ${formatSignedPercent(deltas.wasmLiquidityFeeUsd.percent)}`,
        deltaValue: deltas.wasmLiquidityFeeUsd.absolute
      },
      {
        label: 'All FIN fees (range included)',
        before: formatUsd(before.finFeeUsd),
        after: formatUsd(after.finFeeUsd),
        delta: `${signedUsd(after.finFeeUsd - before.finFeeUsd)} · ${formatSignedPercent(before.finFeeUsd ? (after.finFeeUsd - before.finFeeUsd) / before.finFeeUsd : null)}`,
        deltaValue: after.finFeeUsd - before.finFeeUsd
      },
      {
        label: 'FIN range subset',
        before: formatUsd(before.finRangeFeeUsd),
        after: formatUsd(after.finRangeFeeUsd),
        delta: signedUsd(after.finRangeFeeUsd - before.finRangeFeeUsd),
        deltaValue: after.finRangeFeeUsd - before.finRangeFeeUsd
      },
      {
        label: 'Wasm-linked Rujira fees',
        before: formatUsd(before.linkedRujiraFeeUsd),
        after: formatUsd(after.linkedRujiraFeeUsd),
        delta: `${signedUsd(deltas.linkedRujiraFeeUsd.absolute)} · ${formatSignedPercent(deltas.linkedRujiraFeeUsd.percent)}`,
        deltaValue: deltas.linkedRujiraFeeUsd.absolute
      },
      {
        label: `TC accrual from linked Rujira (${formatPercent(after.averageTcShare, 0)})`,
        before: formatUsd(before.linkedTcReserveUsd),
        after: formatUsd(after.linkedTcReserveUsd),
        delta: signedUsd(deltas.linkedTcReserveUsd.absolute),
        deltaValue: deltas.linkedTcReserveUsd.absolute
      },
      {
        label: 'TC linked value (LP fees + accrual)',
        before: formatUsd(before.tcLinkedValueUsd),
        after: formatUsd(after.tcLinkedValueUsd),
        delta: `${signedUsd(deltas.tcLinkedValueUsd.absolute)} · ${formatSignedPercent(deltas.tcLinkedValueUsd.percent)}`,
        deltaValue: deltas.tcLinkedValueUsd.absolute,
        emphasis: true
      },
      {
        label: 'Broad TC value (all FIN + AMM)',
        before: formatUsd(before.tcBroadValueUsd),
        after: formatUsd(after.tcBroadValueUsd),
        delta: `${signedUsd(deltas.tcBroadValueUsd.absolute)} · ${formatSignedPercent(deltas.tcBroadValueUsd.percent)}`,
        deltaValue: deltas.tcBroadValueUsd.absolute
      },
      {
        label: 'TC value per $1m network volume',
        before: formatUsd(before.tcPerMillionNetworkVolumeUsd),
        after: formatUsd(after.tcPerMillionNetworkVolumeUsd),
        delta: formatSignedPercent(deltas.tcPerMillionNetworkVolumeUsd.percent),
        deltaValue: deltas.tcPerMillionNetworkVolumeUsd.absolute
      },
      {
        label: 'TC bps per Wasm executed-leg volume',
        before: formatBps(before.tcBpsPerWasmLegVolume),
        after: formatBps(after.tcBpsPerWasmLegVolume),
        delta: formatSignedPercent(deltas.tcBpsPerWasmLegVolume.percent),
        deltaValue: deltas.tcBpsPerWasmLegVolume.absolute
      }
    ];
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
      if (!valueCanvas || !efficiencyCanvas || !visibleRows.length) return;
      valueChart = renderWasmArbValueChart(
        valueCanvas,
        valueChart,
        visibleRows,
        regime?.activationTime
      );
      efficiencyChart = renderWasmArbEfficiencyChart(
        efficiencyCanvas,
        efficiencyChart,
        visibleRows,
        regime?.activationTime
      );
    }, 0);
  }

  onMount(() => load());
  onDestroy(() => {
    clearTimeout(chartRenderTimer);
    valueChart?.destroy();
    efficiencyChart?.destroy();
  });
</script>

<div class="wasm-economics">
  <div class="command-head">
    <div><span class="prompt">$</span> inspect wasm-arb <span class="arg">--economics --equal-window</span></div>
    <div class="command-actions">
      <span class="status-pill" class:warn={!comparison?.dataComplete}>
        <span class="status-dot" class:warn={!comparison?.dataComplete}></span>
        {comparison?.dataComplete ? 'COMPLETE' : 'SYNCING'}
      </span>
      <button class="bracket-button" on:click={() => load(true)} disabled={refreshing}>
        <span>[</span><b>R</b><span>]</span> {refreshing ? 'refreshing' : 'refresh'}
      </button>
    </div>
  </div>

  <header class="page-head">
    <div class="eyebrow">PROTOCOL REVENUE ATTRIBUTION</div>
    <h1><span>›</span> WASM ARB ECONOMICS<span class="cursor">_</span></h1>
    <p>Tracks whether Wasm arbitrage activity adds more value to THORChain than it displaces in pool fees, including the Base Layer share of linked FIN and AMM revenue.</p>
  </header>

  {#if error}
    <TerminalAlert tone="err">{error}</TerminalAlert>
  {/if}
  {#if dashboard?.meta?.warning}
    <TerminalAlert tone="warn">{dashboard.meta.warning}</TerminalAlert>
  {/if}
  {#if !comparison?.dataComplete && dashboard && !loading}
    <TerminalAlert tone="warn">Economic verdict withheld while source backfills, block scans, or historical fee pricing remain incomplete.</TerminalAlert>
  {/if}

  {#if loading}
    <div class="loading-block"><span>▓░░░░</span> loading five-minute economics ledger…</div>
  {:else if dashboard}
    <section class="control-strip" aria-label="Comparison controls">
      <div class="control-copy">
        <span class="control-label">COMPARE</span>
        <span>equal windows around Mimir activation</span>
      </div>
      <div class="window-buttons">
        {#each WINDOW_OPTIONS as option}
          <button
            class:active={selectedWindow === option.key}
            on:click={() => selectedWindow = option.key}
          ><span>[</span>{option.label}<span>]</span></button>
        {/each}
      </div>
    </section>

    {#if comparison.ready}
      <div class="metric-grid">
        <article>
          <span class="metric-index">01</span>
          <span class="metric-label">TC LINKED VALUE</span>
          <strong>{formatUsd(comparison.after.tcLinkedValueUsd)}</strong>
          <span class="metric-delta {deltaClass(comparison.deltas.tcLinkedValueUsd.absolute)}">
            {signedUsd(comparison.deltas.tcLinkedValueUsd.absolute)} · {formatSignedPercent(comparison.deltas.tcLinkedValueUsd.percent)}
          </span>
        </article>
        <article>
          <span class="metric-index">02</span>
          <span class="metric-label">TC / $1M NETWORK VOL</span>
          <strong>{formatUsd(comparison.after.tcPerMillionNetworkVolumeUsd)}</strong>
          <span class="metric-delta {deltaClass(comparison.deltas.tcPerMillionNetworkVolumeUsd.absolute)}">
            {formatSignedPercent(comparison.deltas.tcPerMillionNetworkVolumeUsd.percent)}
          </span>
        </article>
        <article>
          <span class="metric-index">03</span>
          <span class="metric-label">WASM THOR LP FEES</span>
          <strong>{formatUsd(comparison.after.wasmLiquidityFeeUsd)}</strong>
          <span class="metric-delta {deltaClass(comparison.deltas.wasmLiquidityFeeUsd.absolute)}">
            {signedUsd(comparison.deltas.wasmLiquidityFeeUsd.absolute)} · {formatSignedPercent(comparison.deltas.wasmLiquidityFeeUsd.percent)}
          </span>
        </article>
        <article>
          <span class="metric-index">04</span>
          <span class="metric-label">BREAK-EVEN COVERAGE</span>
          <strong>{comparison.breakEven.coverage == null ? 'N/A' : formatPercent(comparison.breakEven.coverage, 1)}</strong>
          <span class="metric-delta" class:down={comparison.breakEven.coverage != null && comparison.breakEven.coverage < 1} class:up={comparison.breakEven.coverage != null && comparison.breakEven.coverage >= 1}>
            TC share of linked lift / LP loss
          </span>
        </article>
      </div>

      <section class="block verdict-block {verdictTone}">
        <div class="block-head">
          <h2><span>▌</span> OBSERVED TC CASH-FLOW VERDICT</h2>
          <span>[{formatDuration(comparison.windowSeconds)} PER SIDE]</span>
        </div>
        <div class="verdict-layout">
          <div class="verdict-value">
            <span>{comparison.dataComplete ? comparison.verdict.toUpperCase() : 'INCOMPLETE'}</span>
            <strong>{signedUsd(comparison.deltas.tcLinkedValueUsd.absolute)}</strong>
            <small>{formatSignedPercent(comparison.deltas.tcLinkedValueUsd.percent)} vs matched pre-change window</small>
          </div>
          <div class="verdict-notes">
            <p><b>Activity:</b> actions {formatSignedPercent(comparison.deltas.wasmActionCount.percent)}; executed-leg volume {formatSignedPercent(comparison.deltas.wasmLegVolumeUsd.percent)}; network share {formatPercent(comparison.before.wasmNetworkVolumeShare, 3)} → {formatPercent(comparison.after.wasmNetworkVolumeShare, 3)}.</p>
            <p><b>Collection:</b> THOR LP fees {formatSignedPercent(comparison.deltas.wasmLiquidityFeeUsd.percent)}; linked Rujira fees {formatSignedPercent(comparison.deltas.linkedRujiraFeeUsd.percent)}; TC value per $1m network volume {formatSignedPercent(comparison.deltas.tcPerMillionNetworkVolumeUsd.percent)}.</p>
            <p class="caveat">Cash-flow verdict only. Price quality, LVR reduction, and arbitrage profit remain outside this calculation.</p>
          </div>
        </div>
      </section>

      <section class="block">
        <div class="block-head">
          <h2><span>▌</span> EQUAL-WINDOW LEDGER</h2>
          <span>[TRANSITION BUCKET EXCLUDED]</span>
        </div>
        <div class="window-meta">
          <div><b>PRE</b> {formatDateTime(comparison.before.startTime)} → {formatDateTime(comparison.before.endTime)}</div>
          <div><b>POST</b> {formatDateTime(comparison.after.startTime)} → {formatDateTime(comparison.after.endTime)}</div>
          {#if comparisonProvisional}<div class="provisional">PROVISIONAL · post window still accumulating</div>{/if}
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>METRIC</th><th>BEFORE</th><th>AFTER</th><th>Δ</th></tr></thead>
            <tbody>
              {#each metricRows as row}
                <tr class:emphasis={row.emphasis}>
                  <td>{row.label}</td>
                  <td>{row.before}</td>
                  <td>{row.after}</td>
                  <td class={deltaClass(row.deltaValue)}>{row.delta}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>

      <div class="chart-grid">
        <section class="block chart-block">
          <div class="block-head">
            <h2><span>▌</span> TC VALUE CAPTURE</h2>
            <span>[USD / HOUR]</span>
          </div>
          <p class="block-lede">THOR pool fees plus the observed Base Layer allocation of Wasm-linked FIN and AMM revenue.</p>
          <div class="chart-shell"><canvas bind:this={valueCanvas}></canvas></div>
        </section>
        <section class="block chart-block">
          <div class="block-head">
            <h2><span>▌</span> UNIT ECONOMICS</h2>
            <span>[NORMALIZED]</span>
          </div>
          <p class="block-lede">TC value per $1m of total network leg volume, alongside Wasm’s share of that volume.</p>
          <div class="chart-shell"><canvas bind:this={efficiencyCanvas}></canvas></div>
        </section>
      </div>

      <div class="detail-grid">
        <section class="block">
          <div class="block-head">
            <h2><span>▌</span> FEE BEHAVIOR</h2>
            <span>[ACTION LEVEL]</span>
          </div>
          <div class="mini-grid">
            <div><span>ZERO SLIP</span><b>{formatPercent(comparison.before.zeroSlipShare, 1)} → {formatPercent(comparison.after.zeroSlipShare, 1)}</b></div>
            <div><span>BELOW OLD FLOOR</span><b>{formatPercent(comparison.before.belowReferenceShare, 1)} → {formatPercent(comparison.after.belowReferenceShare, 1)}</b></div>
            <div><span>ZERO THOR FEE</span><b>{formatPercent(comparison.before.zeroFeeShare, 1)} → {formatPercent(comparison.after.zeroFeeShare, 1)}</b></div>
            <div><span>MEDIAN SLIP</span><b>{comparison.before.medianSlipBps ?? '—'} → {comparison.after.medianSlipBps ?? '—'} bps</b></div>
            <div><span>P90 SLIP</span><b>{comparison.before.p90SlipBps ?? '—'} → {comparison.after.p90SlipBps ?? '—'} bps</b></div>
            <div><span>THOR FEE / LEG VOL</span><b>{formatBps(comparison.before.wasmLegFeeBps)} → {formatBps(comparison.after.wasmLegFeeBps)}</b></div>
          </div>
        </section>

        <section class="block">
          <div class="block-head">
            <h2><span>▌</span> BREAK-EVEN TEST</h2>
            <span>[TC SHARE {formatPercent(comparison.breakEven.tcShare, 0)}]</span>
          </div>
          <div class="break-even">
            <div><span>THOR LP fee loss</span><b>{formatUsd(comparison.breakEven.lpFeeLossUsd)}</b></div>
            <div><span>Required linked Rujira lift</span><b>{formatUsd(comparison.breakEven.breakEvenRujiraIncreaseUsd)}</b></div>
            <div><span>Actual linked Rujira lift</span><b>{signedUsd(comparison.breakEven.actualRujiraIncreaseUsd)}</b></div>
            <div class="coverage-line"><span style={`width:${Math.max(0, Math.min(100, (comparison.breakEven.coverage || 0) * 100))}%`}></span></div>
          </div>
        </section>
      </div>
    {:else}
      <TerminalAlert tone="warn">{comparison.reason}</TerminalAlert>
    {/if}

    <section class="block health-block">
      <div class="block-head">
        <h2><span>▌</span> DATA HEALTH + ATTRIBUTION</h2>
        <span>[AS OF {formatDateTime(dashboard.meta?.sourceUpdatedAt)}]</span>
      </div>
      <div class="health-grid">
        <div><span class:ok={sourceCoverage.networkComplete} class="health-dot"></span><b>NETWORK 5M</b><small>{sourceCoverage.networkComplete ? 'caught up' : 'backfilling'}</small></div>
        <div><span class:ok={sourceCoverage.actionBackfillComplete} class="health-dot"></span><b>WASM ACTIONS</b><small>{sourceCoverage.actionBackfillComplete ? 'caught up' : 'backfilling'}</small></div>
        <div><span class:ok={sourceCoverage.feeBackfillComplete} class="health-dot"></span><b>FIN + AMM FEES</b><small>{sourceCoverage.pendingBlocks || 0} blocks pending</small></div>
        <div><span class:ok={(dashboard.meta?.contracts?.finContractCount || 0) > 0} class="health-dot"></span><b>FIN SCOPE</b><small>{dashboard.meta?.contracts?.finContractCount || '—'} contracts · code {dashboard.meta?.contracts?.finCodeIds?.join(', ') || '—'}</small></div>
      </div>
      <div class="attribution-grid">
        <div><span>WASM ARB</span><code title={dashboard.meta?.contracts?.wasmArb}>{shortAddress(dashboard.meta?.contracts?.wasmArb)}</code></div>
        <div><span>TRADE COLLECTOR</span><code title={dashboard.meta?.contracts?.rujiraTradeCollector}>{shortAddress(dashboard.meta?.contracts?.rujiraTradeCollector)}</code></div>
        <div><span>BASE LAYER</span><code title={dashboard.meta?.contracts?.baseLayerCollector}>{shortAddress(dashboard.meta?.contracts?.baseLayerCollector)}</code></div>
        <div><span>CURRENT MIMIR</span><code>{regime?.mimirValue ?? '—'} bps @ {formatCount(regime?.activationHeight)}</code></div>
      </div>
      <details>
        <summary><span>[+]</span> methodology and guardrails</summary>
        <ul>
          {#each Object.values(dashboard.meta?.methodology || {}) as note}
            <li>{note}</li>
          {/each}
        </ul>
      </details>
    </section>
  {/if}
</div>

<style>
  .wasm-economics {
    max-width: 1400px;
    margin: 0 auto;
    padding: 24px 0 56px;
    color: #c8c8c8;
  }

  .command-head,
  .command-actions,
  .control-strip,
  .window-buttons,
  .block-head,
  .window-meta,
  .attribution-grid > div {
    display: flex;
    align-items: center;
  }

  .command-head {
    justify-content: space-between;
    gap: 16px;
    padding-bottom: 13px;
    border-bottom: 1px solid #1a1a1a;
    color: #666;
    font: 11px 'JetBrains Mono', monospace;
  }

  .prompt,
  h1 > span:first-child,
  .metric-index,
  .block-head h2 span,
  summary span {
    color: #00cc66;
  }

  .arg { color: #444; }
  .command-actions { gap: 8px; }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 7px;
    border: 1px solid #1a1a1a;
    border-radius: 999px;
    color: #00cc66;
    font: 700 9px 'JetBrains Mono', monospace;
  }

  .status-pill.warn { color: #d4a017; }
  .status-dot,
  .health-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #d4a017;
  }
  .status-dot:not(.warn), .health-dot.ok {
    background: #00cc66;
    box-shadow: 0 0 6px rgba(0, 204, 102, 0.4);
  }

  .bracket-button,
  .window-buttons button {
    border: 1px solid #1a1a1a;
    border-radius: 0;
    background: transparent;
    color: #888;
    font: 10px 'JetBrains Mono', monospace;
    cursor: pointer;
  }

  .bracket-button { padding: 5px 10px; }
  .bracket-button span, .window-buttons button span { color: #444; }
  .bracket-button b { color: #00cc66; }
  .bracket-button:hover:not(:disabled), .window-buttons button:hover,
  .window-buttons button.active { border-color: #00cc66; color: #00cc66; }
  .bracket-button:disabled { opacity: 0.45; cursor: default; }

  .page-head { padding: 30px 0 24px; }
  .eyebrow,
  .control-label,
  .metric-label,
  .mini-grid span,
  .break-even span,
  .attribution-grid span {
    color: #666;
    font: 700 9px 'JetBrains Mono', monospace;
    letter-spacing: 0.14em;
  }
  h1 {
    margin: 7px 0 10px;
    color: #e8e8e8;
    font: 800 30px/1.1 'JetBrains Mono', monospace;
    letter-spacing: 0.06em;
  }
  .cursor { animation: blink 1s steps(2, start) infinite; }
  .page-head p { max-width: 820px; margin: 0; color: #888; font-size: 13px; }

  .loading-block {
    border: 1px solid #1a1a1a;
    background: #0a0a0a;
    padding: 28px 20px;
    color: #666;
    font: 11px 'JetBrains Mono', monospace;
  }
  .loading-block span { color: #00cc66; }

  .control-strip {
    justify-content: space-between;
    gap: 16px;
    margin: 18px 0 12px;
    padding: 9px 12px;
    border: 1px solid #1a1a1a;
    background: #080808;
    font: 10px 'JetBrains Mono', monospace;
  }
  .control-copy { display: flex; gap: 10px; color: #666; }
  .control-label { color: #00cc66; }
  .window-buttons { gap: 0; }
  .window-buttons button { padding: 5px 8px; margin-left: -1px; }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    border: 1px solid #1a1a1a;
    margin-bottom: 12px;
  }
  .metric-grid article {
    min-width: 0;
    height: 116px;
    padding: 15px 17px;
    background: #0a0a0a;
    border-right: 1px solid #1a1a1a;
  }
  .metric-grid article:last-child { border-right: 0; }
  .metric-index { display: block; font: 700 9px 'JetBrains Mono', monospace; }
  .metric-label { display: block; margin: 7px 0 8px; }
  .metric-grid strong {
    display: block;
    overflow: hidden;
    color: #e8e8e8;
    font: 800 23px 'JetBrains Mono', monospace;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .metric-delta { display: block; margin-top: 6px; color: #666; font: 10px 'JetBrains Mono', monospace; }
  .up { color: #00cc66 !important; }
  .down { color: #dc5b67 !important; }

  .block {
    margin-bottom: 12px;
    padding: 18px 20px 22px;
    border: 1px solid #1a1a1a;
    border-radius: 0;
    background: #0a0a0a;
  }
  .block-head { justify-content: space-between; gap: 12px; margin-bottom: 16px; }
  .block-head h2 {
    margin: 0;
    color: #e8e8e8;
    font: 700 13px 'JetBrains Mono', monospace;
    letter-spacing: 0.08em;
  }
  .block-head > span { color: #444; font: 9px 'JetBrains Mono', monospace; }
  .block-lede { margin: -6px 0 14px; color: #666; font-size: 12px; }

  .verdict-block { border-left: 3px solid #444; }
  .verdict-block.positive { border-left-color: #00cc66; }
  .verdict-block.negative { border-left-color: #dc3545; }
  .verdict-layout { display: grid; grid-template-columns: minmax(220px, 0.75fr) 2fr; gap: 28px; }
  .verdict-value { display: flex; flex-direction: column; justify-content: center; border-right: 1px solid #1a1a1a; }
  .verdict-value span { color: #888; font: 700 10px 'JetBrains Mono', monospace; letter-spacing: 0.14em; }
  .negative .verdict-value span, .negative .verdict-value strong { color: #dc5b67; }
  .positive .verdict-value span, .positive .verdict-value strong { color: #00cc66; }
  .verdict-value strong { margin: 6px 0; color: #e8e8e8; font: 800 28px 'JetBrains Mono', monospace; }
  .verdict-value small { color: #666; font: 10px 'JetBrains Mono', monospace; }
  .verdict-notes p { margin: 0 0 8px; color: #aaa; font-size: 12px; }
  .verdict-notes b { color: #e8e8e8; font-family: 'JetBrains Mono', monospace; }
  .verdict-notes .caveat { margin: 13px 0 0; padding-top: 10px; border-top: 1px dashed #1a1a1a; color: #666; }

  .window-meta { flex-wrap: wrap; gap: 8px 20px; margin: -4px 0 14px; color: #666; font: 9px 'JetBrains Mono', monospace; }
  .window-meta b { color: #00cc66; }
  .window-meta .provisional { color: #d4a017; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font: 11px 'JetBrains Mono', monospace; }
  th { padding: 8px 10px; border-bottom: 1px solid #2a2a2a; color: #666; font-size: 9px; letter-spacing: 0.12em; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  td { padding: 9px 10px; border-bottom: 1px solid #111; color: #888; text-align: right; white-space: nowrap; }
  td:first-child { color: #c8c8c8; }
  tr:hover td { background: #0d0d0d; }
  tr.emphasis td { border-top: 1px solid #2a2a2a; color: #e8e8e8; font-weight: 700; }
  tr.emphasis td:nth-child(3) { color: #00cc66; }

  .chart-grid, .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .chart-block { min-width: 0; }
  .chart-shell { height: 290px; }
  .chart-shell canvas { width: 100% !important; height: 100% !important; }

  .mini-grid { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid #111; }
  .mini-grid > div { padding: 12px; border-right: 1px solid #111; border-bottom: 1px solid #111; }
  .mini-grid > div:nth-child(3n) { border-right: 0; }
  .mini-grid > div:nth-last-child(-n + 3) { border-bottom: 0; }
  .mini-grid span, .mini-grid b { display: block; }
  .mini-grid b { margin-top: 7px; color: #c8c8c8; font: 700 11px 'JetBrains Mono', monospace; }

  .break-even { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: #111; border: 1px solid #111; }
  .break-even > div:not(.coverage-line) { padding: 15px 12px; background: #080808; }
  .break-even span, .break-even b { display: block; }
  .break-even b { margin-top: 7px; color: #e8e8e8; font: 700 13px 'JetBrains Mono', monospace; }
  .coverage-line { grid-column: 1 / -1; height: 3px; background: #1a1a1a; }
  .coverage-line span { display: block; height: 100%; background: #d4a017; }

  .health-grid { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid #111; }
  .health-grid > div { display: grid; grid-template-columns: 8px 1fr; gap: 4px 8px; padding: 12px; border-right: 1px solid #111; }
  .health-grid > div:last-child { border-right: 0; }
  .health-grid .health-dot { grid-row: 1 / span 2; margin-top: 3px; }
  .health-grid b { color: #c8c8c8; font: 700 10px 'JetBrains Mono', monospace; }
  .health-grid small { color: #666; font: 9px 'JetBrains Mono', monospace; }
  .attribution-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 14px; }
  .attribution-grid > div { justify-content: space-between; gap: 8px; padding-bottom: 7px; border-bottom: 1px dashed #1a1a1a; }
  code { color: #00cc66; font: 9px 'JetBrains Mono', monospace; }
  details { margin-top: 16px; border-top: 1px solid #1a1a1a; padding-top: 12px; }
  summary { color: #888; font: 10px 'JetBrains Mono', monospace; cursor: pointer; list-style: none; }
  details ul { margin: 12px 0 0 18px; padding: 0; color: #777; font-size: 12px; }
  details li { margin-bottom: 7px; }

  @keyframes blink { 50% { opacity: 0; } }

  @media (max-width: 1000px) {
    .metric-grid { grid-template-columns: repeat(2, 1fr); }
    .metric-grid article:nth-child(2) { border-right: 0; }
    .metric-grid article:nth-child(-n + 2) { border-bottom: 1px solid #1a1a1a; }
    .chart-grid, .detail-grid { grid-template-columns: 1fr; }
    .health-grid, .attribution-grid { grid-template-columns: repeat(2, 1fr); }
    .health-grid > div:nth-child(2) { border-right: 0; }
    .health-grid > div:nth-child(-n + 2) { border-bottom: 1px solid #111; }
  }

  @media (max-width: 680px) {
    .wasm-economics { padding-top: 16px; }
    .command-head, .control-strip { align-items: flex-start; flex-direction: column; }
    h1 { font-size: 22px; }
    .window-buttons { width: 100%; overflow-x: auto; }
    .metric-grid { grid-template-columns: 1fr; }
    .metric-grid article { height: 104px; border-right: 0; border-bottom: 1px solid #1a1a1a; }
    .metric-grid article:last-child { border-bottom: 0; }
    .verdict-layout { grid-template-columns: 1fr; gap: 16px; }
    .verdict-value { padding-bottom: 15px; border-right: 0; border-bottom: 1px solid #1a1a1a; }
    .mini-grid, .break-even { grid-template-columns: 1fr; }
    .mini-grid > div { border-right: 0; border-bottom: 1px solid #111 !important; }
    .mini-grid > div:last-child { border-bottom: 0 !important; }
    .health-grid, .attribution-grid { grid-template-columns: 1fr; }
    .health-grid > div { border-right: 0; border-bottom: 1px solid #111; }
    .health-grid > div:last-child { border-bottom: 0; }
    .block { padding: 15px 13px 18px; }
  }
</style>
