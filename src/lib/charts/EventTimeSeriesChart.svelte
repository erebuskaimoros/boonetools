<script>
  import ChartTools from './ChartTools.svelte';
  import TimeSeriesChart from './TimeSeriesChart.svelte';
  import { eventCalendarDays, buildEventCalendarOption } from './event-calendar.js';
  export let events = [];
  export let metrics = [];
  export let hidden = [];
  export let grain = 'native';
  export let zoomWindow = null;
  export let onZoom = (_window) => {};
  export let ariaLabel;
  let rolling = [];
  $: days = eventCalendarDays(events, metrics);
  $: options = { metrics, hidden, analysis: { grain: grain === 'native' ? 'day' : grain, hidden, rolling } };
  function changeRolling(ids) {
    rolling = ids;
    if (ids.length && grain === 'native') grain = 'day';
  }
</script>

<ChartTools series={metrics} {hidden} {rolling} {grain} allowNative
  onHidden={(ids) => hidden = ids} onRolling={changeRolling} onGrain={(value) => grain = value} />
<div style:display={grain === 'native' ? 'contents' : 'none'}><slot /></div>
{#if grain !== 'native'}
  <p class="calendar-note">UTC calendar view · observed samples only; empty days are gaps. Rolling averages switch to calendar view and require consecutive observed days.</p>
  <TimeSeriesChart points={days} {options} buildOption={buildEventCalendarOption} tools={false}
    {zoomWindow} onZoom={(value) => { zoomWindow = value; onZoom(value); }}
    hasData={days.length > 0} {ariaLabel} height="430px" />
{/if}

<style>
  .calendar-note { color: var(--term-text-3); font: 11px/1.6 var(--term-font-mono); margin: 0 0 8px; }
</style>
