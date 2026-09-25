<script>
  import {
    SYSTEM_INCOME_POL_RANGES,
    buildSystemIncomePolFeeChart,
    selectSystemIncomePolRange
  } from './model.js';

  import RangeSummary from '../charts/RangeSummary.svelte';
  import TimeSeriesChart from '../charts/TimeSeriesChart.svelte';
  import CurrencySwitch from '../components/terminal/CurrencySwitch.svelte';
  import { buildSystemIncomePolFeeOption, polChartValue, polFeeDetails } from './charts.js';

  export let daily = [];
  let rangeId = '30d';
  let unit = 'usd';
  let selectedDay = '';
  let grain = 'day';
  let chartElement;

  $: rows = selectSystemIncomePolRange(daily, rangeId);
  $: chart = buildSystemIncomePolFeeChart(rows, { unit });
  $: historyPoints = buildSystemIncomePolFeeChart(daily, { unit }).points;
  $: selected = chart.points.find(point => point.day === selectedDay) || null;
  $: if (selectedDay && !chart.points.some(point => point.day === selectedDay)) selectedDay = '';

  function pinDay(day) {
    selectedDay = grain === 'day' && selectedDay !== day ? day : '';
  }

  function dismissTooltip() { selectedDay = ''; }

  function dismissOutside(event) {
    if (!chartElement?.contains(event.target)) dismissTooltip();
  }

  function pointLabel(point) {
    return `${point.day} UTC: ${point.missingReason || polChartValue(point.value, unit)}${point.provisional ? ' · provisional' : ''}`;
  }
</script>

<svelte:window on:pointerdown={dismissOutside} on:keydown={(event) => { if (event.key === 'Escape') dismissTooltip(); }} />

<section class="fee-panel" aria-labelledby="daily-fees-title">
  <header>
    <div>
      <h2 id="daily-fees-title"><span aria-hidden="true">▌</span> DAILY ESTIMATED FEES</h2>
      <p>POL's estimated share of pool swap fees, per UTC day.</p>
    </div>
  </header>

  {#if rows.length}
    <div class="chart-container" bind:this={chartElement}>
      <RangeSummary rows={chart.points} metrics={[{ field: 'value', label: 'Estimated fees', kind: 'flow', unit: unit === 'usd' ? 'usd' : 'RUNE' }]} />
      <div class="chart">
        <TimeSeriesChart points={chart.points} {historyPoints} onGrainChange={value => { grain = value; dismissTooltip(); }} options={{ unit, selectedDay }} buildOption={buildSystemIncomePolFeeOption}
          hasData={chart.points.length > 0} onSelect={pinDay}
          ariaLabel={`Daily estimated POL fees in ${unit.toUpperCase()}. Tap a day to pin details, or use the day selector below.`}
          height="240px" narrowHeight="240px">
          <div slot="controls" class="controls" role="group" aria-label="Daily fee plot controls">
            <div class="unit-controls" role="group" aria-label="Daily fee denomination">
              <CurrencySwitch {unit} ariaLabel="Daily POL fees in US dollars"
                title="Use each UTC day’s closing RUNE/USD price"
                onChange={value => { unit = value; dismissTooltip(); }} />
            </div>
            <div class="range-controls" role="group" aria-label="Daily fee history range">
              {#each SYSTEM_INCOME_POL_RANGES as range}
                <button type="button" class:active={rangeId === range.id} aria-pressed={rangeId === range.id} on:click={() => { rangeId = range.id; dismissTooltip(); }}>[{range.label}]</button>
              {/each}
            </div>
          </div>
          <svelte:fragment slot="overlay">
            {#if selected && grain === 'day'}
              <div id="daily-fees-tooltip" class="fee-tooltip" role="tooltip">
                <strong>{selected.day} <span>UTC</span></strong>
                <div class="tooltip-value"><span><i aria-hidden="true"></i> EST. FEES</span><b>{polChartValue(selected.value, unit)}</b></div>
                {#each polFeeDetails(selected, unit) as detail}<p>{detail}</p>{/each}
              </div>
            {/if}
          </svelte:fragment>
        </TimeSeriesChart>
      </div>
      {#if grain === 'day'}
      <div class="day-controls">
        <label for="pol-fee-day">INSPECT DAY</label>
        <select id="pol-fee-day" bind:value={selectedDay}
          aria-describedby={selected ? 'daily-fees-tooltip' : undefined}
          on:focus={() => { if (!selectedDay) selectedDay = chart.points[0]?.day || ''; }}>
          <option value="">Choose a UTC day</option>
          {#each chart.points as point}<option value={point.day}>{pointLabel(point)}</option>{/each}
        </select>
        <button type="button" disabled={!selected} on:click={dismissTooltip}>[DISMISS]</button>
      </div>
      {/if}
    </div>
    <footer>
      <span><i></i> DAILY EST. FEES · {unit.toUpperCase()}</span>
      <span><i class="provisional"></i> PARTIAL / PROVISIONAL</span>
      {#if chart.missingDays}<span>× {chart.missingDays} UNAVAILABLE {chart.missingDays === 1 ? 'DAY' : 'DAYS'}</span>{/if}
<span>{grain === 'day' ? 'HOVER / CHOOSE DAY FOR DETAILS · TAP TO PIN · ESC TO DISMISS' : 'HOVER CALENDAR BUCKETS FOR TOTALS · D FOR DAILY DETAILS'}</span>
    </footer>
    {#if chart.points.every(point => point.value === null)}
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
  .controls { flex-wrap: wrap; align-items: center; gap: 6px 12px; justify-content: flex-end; padding-bottom: 8px; }
  .range-controls { flex-wrap: wrap; }
  .unit-controls { padding-right: 10px; border-right: 1px solid var(--term-border); }
  button { min-height: 34px; padding: 6px 8px; border: 1px solid var(--term-border); border-radius: 0; background: transparent; color: var(--term-text-2); font: 600 12px/1 'JetBrains Mono', monospace; cursor: pointer; }
  button:hover, button.active { border-color: var(--term-accent); color: var(--term-accent); }
  button:focus-visible { outline: 2px solid var(--term-accent); outline-offset: 3px; }
  .chart-container { padding: 10px 18px 0; }
  .chart { position: relative; width: 100%; }
  .fee-tooltip { position: absolute; z-index: 2; top: 12px; right: 8px; width: min(280px, calc(100% - 16px)); box-sizing: border-box; padding: 12px; border: 1px solid var(--term-amber-edge); background: var(--term-surface-deep); color: var(--term-text-2); font: 12px/1.5 'JetBrains Mono', monospace; pointer-events: none; }
  .fee-tooltip strong, .fee-tooltip span, .fee-tooltip b { font-family: 'JetBrains Mono', monospace; }
  .fee-tooltip strong { display: block; margin-bottom: 8px; color: var(--term-text); }
  .fee-tooltip strong span { color: var(--term-text-3); font-weight: 400; }
  .tooltip-value { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 4px 12px; padding-bottom: 8px; border-bottom: 1px solid var(--term-border); }
  .tooltip-value b { color: var(--term-amber); font-size: 14px; }
  .tooltip-value i { display: inline-block; width: 12px; height: 12px; vertical-align: middle; }
  .fee-tooltip p { margin: 7px 0 0; font: inherit; }
  .day-controls { display: flex; align-items: center; gap: 8px; padding: 8px 0 12px; }
  .day-controls label { font-size: 11px; flex-shrink: 0; }
  select { min-width: 0; max-width: 100%; border: 1px solid var(--term-border); border-radius: 0; background: var(--term-surface); color: var(--term-text-2); padding: 6px; font: 12px 'JetBrains Mono', monospace; }
  select:focus-visible { outline: 2px solid var(--term-accent); outline-offset: 2px; }
  button:disabled { opacity: .45; cursor: default; }
  @media (max-width: 560px) { .day-controls { flex-wrap: wrap; } .day-controls select { flex: 1; } }
  footer { display: flex; flex-wrap: wrap; gap: 10px 20px; padding: 10px 18px; border-top: 1px solid var(--term-border-faint); }
  footer span { display: flex; align-items: center; gap: 7px; }
  i { width: 12px; height: 8px; background: var(--term-amber); }
  i.provisional { background: transparent; border: 1px dashed var(--term-amber); }
  .note { padding: 0 18px 14px; font-size: 13px; }
  .empty { padding: 36px 18px; text-align: center; }
  @media (max-width: 900px) { header { flex-direction: column; } }
  @media (max-width: 560px) { .chart-container { padding: 8px 8px 0; } .controls { width: 100%; } .unit-controls { padding: 0; border: 0; } }
</style>
