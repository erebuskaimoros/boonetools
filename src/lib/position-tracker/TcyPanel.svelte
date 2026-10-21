<script>
  import { createEventDispatcher, onDestroy } from 'svelte';
  import Chart from 'chart.js/auto';
  import SeriesLegend from '../charts/SeriesLegend.svelte';
  import { TERMINAL_CHART_PALETTE as P, terminalChartFont } from '../charts/terminal.js';
  import { buildPayoutChartSeries, mergePayoutSeries, weightedTcyPayoutApr } from './model.js';
  import { fmtAmount, fmtDate, fmtPct, shortAddr } from './format.js';

  export let rows = [];
  export let claimRows = [];
  export let labels = {};
  export let money = (value) => String(value);
  export let loading = false;
  export let loadedOnce = false;
  export let tcyPriceUsd = 0;
  export let runePriceUsd = 0;
  export let hasThor = false;
  export let gates = {};

  const dispatch = createEventDispatcher();
  const RANGES = [30, 90, 365, 0];
  const UNITS = [['rune', 'rune'], ['value', 'value at payout']];
  const APR_BASIS = 'Trailing 30-day RUNE payouts at current prices ÷ current staked TCY value × 365/30. The window stays 30 days even for new stakes; stake changes affect this ratio.';
  const APR_UNAVAILABLE = 'Unavailable: payout history, positive current stake and current RUNE/TCY prices are required.';

  let range = 90;
  let unit = 'rune';
  let canvas;
  let chart;

  $: series = mergePayoutSeries(rows);
  $: cutoff = range ? Date.now() / 1000 - range * 86400 : 0;
  $: visible = buildPayoutChartSeries(series, cutoff);
  $: staked = rows.reduce((sum, row) => sum + row.staked, 0);
  $: liquid = rows.reduce((sum, row) => sum + row.liquid, 0);
  $: stakeMissing = rows.some((row) => row.stakeKnown === false);
  $: liquidMissing = rows.some((row) => row.liquidKnown === false);
  $: payoutRune = rows.reduce((sum, row) => sum + row.totalPayoutRune, 0);
  $: payoutUsd = rows.reduce((sum, row) => sum + row.totalPayoutUsdAtPayout, 0);
  $: weightedApr = weightedTcyPayoutApr(rows);
  $: recent = rows
    .flatMap((row) => row.payouts.map((payout) => ({ ...payout, address: row.address })))
    .sort((a, b) => b.date - a.date)
    .slice(0, 12);
  $: if (canvas) drawChart(visible, unit, money);

  // Daily bars and total-paid-out line share a unit, with separate scales.
  function drawChart(points, currentUnit, formatMoney) {
    if (chart && chart.canvas !== canvas) {
      chart.destroy();
      chart = null;
    }
    const inRune = currentUnit === 'rune';
    /** @type {any} */
    const data = {
      labels: points.map((day) => new Date(day.date * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
      datasets: [{
        type: 'bar',
        label: inRune ? 'Daily RUNE' : 'Daily value at payout',
        data: points.map((day) => (inRune ? day.rune : day.usdAtPayout)),
        yAxisID: 'y',
        order: 1,
        backgroundColor: 'rgba(0, 204, 102, 0.55)',
        hoverBackgroundColor: P.accent,
        borderWidth: 0
      }, {
        type: 'line',
        label: inRune ? 'Total paid out RUNE' : 'Total paid out value at payout',
        data: points.map((day) => (inRune ? day.cumulativeRune : day.cumulativeUsdAtPayout)),
        yAxisID: 'cumulative',
        order: 0,
        borderColor: P.amber,
        backgroundColor: P.amber,
        borderWidth: 2,
        pointRadius: points.length === 1 ? 3 : 0,
        pointHoverRadius: 3,
        pointHitRadius: 8,
        tension: 0,
        fill: false
      }]
    };
    /** @type {any} */
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: P.surface,
          borderColor: P.border,
          borderWidth: 1,
          titleFont: terminalChartFont(12),
          bodyFont: terminalChartFont(12),
          callbacks: {
            label: (item) => {
              const day = points[item.dataIndex];
              if (!day) return '';
              const cumulative = item.dataset.yAxisID === 'cumulative';
              return cumulative
                ? [` Total paid out: ${fmtAmount(day.cumulativeRune, 4)} RUNE`, ` ${formatMoney(day.cumulativeUsdAtPayout)} at payout · all time through this date`]
                : [` Daily: ${fmtAmount(day.rune, 4)} RUNE`, ` ${formatMoney(day.usdAtPayout)} at payout`];
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: P.muted, font: terminalChartFont(11), maxTicksLimit: 10 }, grid: { display: false } },
        y: {
          beginAtZero: true,
          title: { display: true, text: inRune ? 'Daily RUNE' : 'Daily value', color: P.muted, font: terminalChartFont(11) },
          ticks: { color: P.muted, font: terminalChartFont(11), callback: (value) => (inRune ? fmtAmount(value, 2) : formatMoney(value)) },
          grid: { color: P.grid },
          border: { display: false }
        },
        cumulative: {
          type: 'linear',
          position: 'right',
          beginAtZero: false,
          grace: '5%',
          title: { display: true, text: inRune ? 'Total paid out RUNE' : 'Total paid out value', color: P.amber, font: terminalChartFont(11) },
          ticks: { color: P.amber, font: terminalChartFont(11), callback: (value) => (inRune ? fmtAmount(value, 2) : formatMoney(value)) },
          grid: { drawOnChartArea: false },
          border: { display: false }
        }
      }
    };
    if (chart) {
      chart.data = data;
      chart.options = options;
      chart.update('none');
      return;
    }
    chart = new Chart(canvas, { data, options });
  }

  onDestroy(() => chart?.destroy());
</script>

<section class="block">
  <div class="block-head">
    <div class="block-title"><span class="title-marker">▌</span><h2>tcy stakes</h2></div>
    <div class="block-actions">
      <span class="block-meta">[tcy {fmtAmount(tcyPriceUsd, 4)} · rune {fmtAmount(runePriceUsd, 3)}]</span>
      <button class="bracket-btn" disabled={!hasThor || gates.tcyStakingHalted} on:click={() => dispatch('action', { kind: 'tcy-stake' })}>
        <span class="bracket">[</span><span class="key">+</span><span class="bracket">]</span> stake tcy
      </button>
    </div>
  </div>

  {#if gates.tcyStakingHalted || gates.tcyUnstakingHalted || gates.tcyClaimingHalted}
    <p class="hint warn-text">
      {[gates.tcyStakingHalted && 'staking', gates.tcyUnstakingHalted && 'unstaking', gates.tcyClaimingHalted && 'claiming'].filter(Boolean).join(', ')} halted by mimir
    </p>
  {/if}

  {#if !hasThor && claimRows.length === 0}
    <p class="hint">Add a thor1 address to see TCY stakes and payouts, or an L1 address to check for unclaimed TCY.</p>
  {:else if !loadedOnce && loading}
    <p class="loader">▓░░░░ loading tcy</p>
  {:else}
    <div class="metric-grid compact">
      <div class="metric">
        <span class="metric-index">T1</span>
        <span class="metric-label">staked</span>
        <strong class="metric-value">{stakeMissing ? '—' : fmtAmount(staked, 0)}</strong>
        <span class="metric-sub">{stakeMissing ? 'Stake unavailable' : money(staked * tcyPriceUsd)} · {liquidMissing ? 'Wallet balance unavailable' : `${fmtAmount(liquid, 0)} unstaked in wallet`}</span>
        {#if stakeMissing && staked > 0}<span class="metric-sub warn-text">Partial · {fmtAmount(staked, 0)} TCY known</span>{/if}
      </div>
      <div class="metric">
        <span class="metric-index">T2</span>
        <span class="metric-label">payouts received</span>
        <strong class="metric-value">{fmtAmount(payoutRune, 2)} ᚱ</strong>
        <span class="metric-sub">{money(payoutUsd)} at payout · {money(payoutRune * runePriceUsd)} today</span>
      </div>
      <div class="metric" title={APR_BASIS}>
        <span class="metric-index">T3</span>
        <span class="metric-label">30d payout APR</span>
        <strong class="metric-value" title={weightedApr === null ? APR_UNAVAILABLE : APR_BASIS}>{weightedApr === null ? '—' : fmtPct(weightedApr, 2)}</strong>
        <span class="metric-sub">current stake &amp; prices</span>
      </div>
      <div class="metric">
        <span class="metric-index">T4</span>
        <span class="metric-label">unclaimed</span>
        <strong class="metric-value">{fmtAmount(claimRows.reduce((sum, row) => sum + row.amount, 0), 2)}</strong>
        <span class="metric-sub">{claimRows.length} L1 claim{claimRows.length === 1 ? '' : 's'} open</span>
      </div>
    </div>

    {#if rows.length}
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>address</th>
              <th class="right">staked</th>
              <th class="right">in wallet</th>
              <th class="right">value</th>
              <th class="right" title={APR_BASIS}>30d payout APR</th>
              <th class="right">last payout</th>
              <th class="right">total paid ᚱ</th>
              <th class="right">paid value</th>
              <th class="right">manage</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.address)}
              <tr>
                <td title={row.address}>{labels[row.address] || shortAddr(row.address)}</td>
                <td class="right accent" title={row.stakeKnown === false ? 'Stake unavailable' : undefined}>{row.stakeKnown === false ? '—' : fmtAmount(row.staked, 2)}</td>
                <td class="right" title={row.liquidKnown === false ? 'Wallet balance unavailable' : undefined}>{row.liquidKnown === false ? '—' : fmtAmount(row.liquid, 2)}</td>
                <td class="right" title={row.stakeKnown === false || row.liquidKnown === false ? 'TCY balance unavailable' : undefined}>{row.stakeKnown === false || row.liquidKnown === false ? '—' : money(row.stakedUsd + row.liquidUsd)}</td>
                <td class="right" title={Number.isFinite(row.apr) ? APR_BASIS : APR_UNAVAILABLE}>{Number.isFinite(row.apr) ? fmtPct(row.apr, 2) : '—'}</td>
                <td class="right nowrap">{row.lastPayout ? `${fmtAmount(row.lastPayout.rune, 4)} · ${fmtDate(row.lastPayout.date)}` : '--'}</td>
                <td class="right">{fmtAmount(row.totalPayoutRune, 2)}</td>
                <td class="right">{money(row.totalPayoutUsdAtPayout)}</td>
                <td class="right nowrap">
                  <button class="row-btn" aria-label="Stake TCY from {labels[row.address] || shortAddr(row.address)}" disabled={gates.tcyStakingHalted || row.liquidKnown === false || row.liquid <= 0} on:click={() => dispatch('action', { kind: 'tcy-stake', owner: row.address, max: row.liquid })}>+stake</button>
                  <button class="row-btn" aria-label="Unstake TCY from {labels[row.address] || shortAddr(row.address)}" disabled={gates.tcyUnstakingHalted || row.stakeKnown === false || row.staked <= 0} on:click={() => dispatch('action', { kind: 'tcy-unstake', owner: row.address, max: row.staked })}>−unstake</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if hasThor}
      <p class="hint">None of the tracked THOR addresses hold or stake TCY.</p>
    {/if}
  {/if}
</section>

{#if claimRows.length}
  <section class="block">
    <div class="block-head">
      <div class="block-title"><span class="title-marker">▌</span><h2>unclaimed tcy</h2></div>
      <div class="block-meta">[claim from the L1 address, sent to a thor1 address]</div>
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr><th>l1 address</th><th>from</th><th class="right">claimable tcy</th><th class="right">value</th><th class="right">manage</th></tr>
        </thead>
        <tbody>
          {#each claimRows as row (row.key)}
            <tr>
              <td title={row.address}>{labels[row.address] || shortAddr(row.address)}</td>
              <td>{row.asset}</td>
              <td class="right accent">{fmtAmount(row.amount, 2)}</td>
              <td class="right">{money(row.valueUsd)}</td>
              <td class="right"><button class="row-btn" disabled={gates.tcyClaimingHalted} on:click={() => dispatch('action', { kind: 'tcy-claim', claim: row })}>claim</button></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
{/if}

{#if series.length}
  <section class="block">
    <div class="block-head">
      <div class="block-title"><span class="title-marker">▌</span><h2>daily payouts</h2></div>
      <div class="block-actions">
        <div class="seg-group" role="group" aria-label="Chart unit">
          {#each UNITS as [value, label]}
            <button class="range-btn" class:active={unit === value} aria-pressed={unit === value} on:click={() => (unit = value)}>{label}</button>
          {/each}
        </div>
        <div class="seg-group" role="group" aria-label="Date range">
          {#each RANGES as option}
            <button class="range-btn" class:active={range === option} aria-pressed={range === option} on:click={() => (range = option)}>{option ? `${option}d` : 'all'}</button>
          {/each}
        </div>
      </div>
    </div>
    <SeriesLegend series={[
      { id: 'daily', label: 'Daily payouts', mark: 'bar', color: P.accent },
      { id: 'cumulative', label: 'Total paid out', mark: 'line', color: P.amber }
    ]} />
    <div class="chart-box"><canvas bind:this={canvas} aria-label="Daily payouts and total paid out through each date, including payouts before the selected date range"></canvas></div>
    {#if recent.length}
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>date</th><th>address</th><th class="right">rune</th><th class="right">usd at payout</th><th class="right">usd today</th></tr></thead>
          <tbody>
            {#each recent as payout (`${payout.address}:${payout.date}`)}
              <tr>
                <td class="nowrap">{fmtDate(payout.date)}</td>
                <td title={payout.address}>{labels[payout.address] || shortAddr(payout.address)}</td>
                <td class="right accent">{fmtAmount(payout.rune, 4)}</td>
                <td class="right">{money(payout.usdAtPayout)}</td>
                <td class="right">{money(payout.usdNow)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}
