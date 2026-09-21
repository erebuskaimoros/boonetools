<script>
  import {
    SYSTEM_INCOME_POL_RANGES,
    buildSystemIncomePolFeeChart,
    selectSystemIncomePolRange
  } from './model.js';

  export let daily = [];
  let rangeId = '30d';
  let unit = 'usd';
  let chartWidth = 0;
  let selectedDay = '';

  $: rows = selectSystemIncomePolRange(daily, rangeId);
  $: chart = buildSystemIncomePolFeeChart(rows, { unit, width: chartWidth || 1000 });
  $: selected = chart.points.find(point => point.day === selectedDay) || null;

  function dayLabel(day) {
    return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', timeZone: 'UTC'
    });
  }

  function valueLabel(value, compact = false) {
    if (!Number.isFinite(value)) return 'Unavailable';
    const formatted = new Intl.NumberFormat('en-US', {
      notation: compact ? 'compact' : 'standard',
      minimumFractionDigits: compact ? 0 : 2,
      maximumFractionDigits: 2
    }).format(value);
    return unit === 'usd' ? `$${formatted}` : `${formatted}${compact ? '' : ' RUNE'}`;
  }

  function pointLabel(point) {
    return `${point.day} UTC: ${point.missingReason || `${valueLabel(point.value)} estimated fees`}${point.provisional ? ', partial or provisional' : ''}`;
  }

  function selectWithKeyboard(event, day) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectedDay = day;
  }
</script>

<section class="fee-panel" aria-labelledby="daily-fees-title">
  <header>
    <div>
      <h2 id="daily-fees-title"><span aria-hidden="true">▌</span> DAILY ESTIMATED FEES</h2>
      <p>POL's estimated share of pool swap fees, per UTC day.</p>
    </div>
    <div class="controls">
      <div class="unit-controls" role="group" aria-label="Daily fee denomination">
        <button type="button" class:active={unit === 'usd'} aria-pressed={unit === 'usd'} on:click={() => unit = 'usd'}>[USD]</button>
        <button type="button" class:active={unit === 'rune'} aria-pressed={unit === 'rune'} on:click={() => unit = 'rune'}>[RUNE]</button>
      </div>
      <div class="range-controls" role="group" aria-label="Daily fee history range">
        {#each SYSTEM_INCOME_POL_RANGES as range}
          <button type="button" class:active={rangeId === range.id} aria-pressed={rangeId === range.id} on:click={() => { rangeId = range.id; selectedDay = ''; }}>[{range.label}]</button>
        {/each}
      </div>
    </div>
  </header>

  {#if rows.length}
    <div class="chart-container">
      <div class="chart" bind:clientWidth={chartWidth}>
        <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="group" aria-label={`Daily estimated POL fees in ${unit.toUpperCase()}. Each day can be focused for details.`}>
          {#each chart.yTicks as tick}
            <line class="grid" x1={chart.plot.left} x2={chart.plot.right} y1={tick.y} y2={tick.y} />
            <text class="y-label" x={chart.plot.left - 10} y={tick.y + 4}>{valueLabel(tick.value, true)}</text>
          {/each}
          {#each chart.xTicks as tick}
            <text class="x-label" x={tick.x} y={chart.height - 10}>{dayLabel(tick.day)}</text>
          {/each}
          {#each chart.bars as bar}
            <rect class="fee-bar" class:provisional={bar.provisional} x={bar.left} y={bar.y} width={chart.barWidth} height={bar.height} />
            {#if bar.value === 0}
              <line class="zero-mark" x1={bar.left} x2={bar.left + chart.barWidth} y1={chart.plot.bottom} y2={chart.plot.bottom} />
            {/if}
          {/each}
          {#each chart.points as point}
            <g
              role="button"
              tabindex="0"
              aria-label={pointLabel(point)}
              aria-pressed={selectedDay === point.day}
              on:mouseenter={() => selectedDay = point.day}
              on:focus={() => selectedDay = point.day}
              on:click={() => selectedDay = point.day}
              on:keydown={(event) => selectWithKeyboard(event, point.day)}
            >
              <title>{pointLabel(point)}</title>
              {#if point.value === null}
                <text class="missing-mark" x={point.x} y={chart.plot.bottom - 6}>×</text>
              {/if}
              <rect class="day-target" class:selected={selectedDay === point.day} x={point.x - chart.slotWidth / 2} y={chart.plot.top} width={chart.slotWidth} height={chart.plot.bottom - chart.plot.top} />
            </g>
          {/each}
        </svg>
      </div>
    </div>
    <div class="readout">
      {#if selected}
        <strong>{selected.day} UTC</strong>
        <span class="value">{selected.missingReason || `${valueLabel(selected.value)} EST. FEES`}</span>
        {#if selected.provisional}<span>PARTIAL / PROVISIONAL</span>{/if}
        {#if selected.feeCoverage?.seededHours > 0}<span>INCLUDES SEEDED OWNERSHIP</span>{/if}
      {:else}
        <span>Hover, tap or focus a day for details.</span>
      {/if}
    </div>
    <footer>
      <span><i></i> DAILY EST. FEES · {unit.toUpperCase()}</span>
      <span><i class="provisional"></i> PARTIAL / PROVISIONAL</span>
      {#if chart.missingDays}<span>× {chart.missingDays} UNAVAILABLE {chart.missingDays === 1 ? 'DAY' : 'DAYS'}</span>{/if}
    </footer>
    {#if chart.bars.length === 0}
      <p class="note">No {unit.toUpperCase()} fee estimates are available in this range. Unavailable days are not zero-fee days.</p>
    {/if}
  {:else}
    <p class="empty">DAILY FEE HISTORY IS NOT AVAILABLE YET</p>
  {/if}
  <p class="note">
    {#if unit === 'usd'}USD bars use each UTC day's closing RUNE price (today's latest price is provisional). The headline instead values total estimated fees at the current RUNE price.{:else}Bars show each day's estimated fees in RUNE, not cumulative fees or POL deposits.{/if}
    Partial days are not extrapolated. Missing estimates or prices remain gaps.
  </p>
</section>

<style>
  .fee-panel { max-width: 1440px; margin: 0 auto 14px; border: 1px solid var(--term-border); background: var(--term-surface); color: var(--term-text-2); font: 12px/1.5 'JetBrains Mono', monospace; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; padding: 16px 18px; border-bottom: 1px solid var(--term-border); }
  h2 { margin: 0 0 5px; color: var(--term-text-strong); font: 800 16px/1.2 'JetBrains Mono', monospace; letter-spacing: .075em; }
  h2 span { color: var(--term-accent); }
  header p, .note { margin: 0; color: var(--term-text-2); font: 14px/1.55 'DM Sans', sans-serif; }
  .controls, .unit-controls, .range-controls { display: flex; gap: 5px; }
  .controls { flex-wrap: wrap; gap: 10px; justify-content: flex-end; }
  .unit-controls { padding-right: 10px; border-right: 1px solid var(--term-border); }
  button { padding: 6px 8px; border: 1px solid var(--term-border); border-radius: 0; background: transparent; color: var(--term-text-2); font: 600 12px/1 'JetBrains Mono', monospace; cursor: pointer; }
  button:hover, button.active { border-color: var(--term-accent); color: var(--term-accent); }
  button:focus-visible { outline: 2px solid var(--term-accent); outline-offset: 3px; }
  .chart-container { padding: 10px 18px 0; }
  .chart { width: 100%; }
  svg { display: block; width: 100%; height: 240px; overflow: visible; }
  .grid { stroke: var(--term-border-faint); }
  .y-label, .x-label, .missing-mark { fill: var(--term-text-3); font: 12px 'JetBrains Mono', monospace; }
  .y-label { text-anchor: end; }
  .x-label, .missing-mark { text-anchor: middle; }
  .fee-bar { fill: var(--term-amber); }
  .fee-bar.provisional { fill-opacity: .45; stroke: var(--term-amber); stroke-dasharray: 3 2; }
  .zero-mark { stroke: var(--term-amber); stroke-width: 2; }
  .day-target { fill: transparent; cursor: crosshair; }
  .day-target.selected, g:hover .day-target, g:focus .day-target { fill: var(--term-accent-soft); stroke: var(--term-accent); stroke-width: 1; }
  g:focus { outline: none; }
  .readout { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; min-height: 42px; box-sizing: border-box; padding: 10px 18px; border-top: 1px solid var(--term-border-faint); color: var(--term-text-3); }
  .readout strong { color: var(--term-text); }
  .readout .value { color: var(--term-amber); }
  footer { display: flex; flex-wrap: wrap; gap: 10px 20px; padding: 10px 18px; border-top: 1px solid var(--term-border-faint); }
  footer span { display: flex; align-items: center; gap: 7px; }
  i { width: 12px; height: 8px; background: var(--term-amber); }
  i.provisional { background: transparent; border: 1px dashed var(--term-amber); }
  .note { padding: 0 18px 14px; font-size: 13px; }
  .empty { padding: 36px 18px; text-align: center; }
  @media (max-width: 900px) { header { flex-direction: column; } .controls { justify-content: flex-start; } }
  @media (max-width: 560px) { .chart-container { padding: 8px 8px 0; } .controls { width: 100%; } .unit-controls { padding: 0; border: 0; } }
</style>
