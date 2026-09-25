<script>
  import SeriesLegend from './SeriesLegend.svelte';
  import { ROLLING_DAYS } from './analytics.js';
  export let series = [];
  export let hidden = [];
  export let rolling = [];
  export let grain = 'day';
  export let sourceGrain = 'day';
  export let allowNative = false;
  export let calendar = 'UTC';
  export let hideUnavailableGrains = false;
  export let showSourceResolution = true;
  export let onHidden = (value) => {};
  export let onRolling = (value) => {};
  export let onGrain = (value) => {};
  let open = false, menu, trigger;
  const grainAvailable = (value, source) => source !== 'epoch'
    && (source !== 'month' || value === 'month') && (source !== 'week' || value === 'week');
  $: grains = ['day', 'week', 'month'].filter(value => !hideUnavailableGrains || grainAvailable(value, sourceGrain));
  $: legendSeries = series.map(item => ({ ...item, label: grain === 'week' ? item.label.replace(/^DAILY /i, 'WEEKLY ') : grain === 'month' ? item.label.replace(/^DAILY /i, 'MONTHLY ') : item.label }));
  const toggle = (list, id) => list.includes(id) ? list.filter(item => item !== id) : [...list, id];
  function dismiss(event) { if (open && !menu?.contains(event.target)) open = false; }
  function escape(event) { if (open && event.key === 'Escape') { open = false; trigger?.focus(); } }
</script>

<svelte:window on:click={dismiss} on:keydown={escape} />
<div class="chart-tools">
  <div class="buckets" role="group" aria-label="Chart buckets">
    {#if allowNative}<button aria-pressed={grain === 'native'} on:click={() => onGrain('native')}>[NATIVE]</button>{/if}
    {#each grains as value}
      <button aria-label={`${value} buckets`} aria-pressed={grain === value}
        disabled={!grainAvailable(value, sourceGrain)}
        title={sourceGrain !== 'day' ? `Source resolution: ${sourceGrain}; finer buckets cannot be reconstructed.` : `${calendar} calendar buckets; weeks start Monday`}
        on:click={() => onGrain(value)}>[{value[0].toUpperCase()}]</button>
    {/each}
  </div>
  <SeriesLegend series={legendSeries} {hidden} onToggle={(id) => onHidden(toggle(hidden, id))} />
  <details bind:this={menu} bind:open>
    <summary bind:this={trigger}>[ROLLING AVGS{rolling.length ? ` · ${rolling.length}` : ''}]</summary>
    <div class="options">
      {#each series.filter(item => item.rolling !== false) as item (item.id)}
        <fieldset><legend><i style={`background:${item.color}`}></i>{item.label}</legend>
          <div class="choices">{#each ROLLING_DAYS as days}
            <label><input type="checkbox" checked={rolling.includes(`${item.id}-${days}d`)} disabled={sourceGrain !== 'day'}
              aria-label={`${days}-day average ${item.label}`} on:change={() => onRolling(toggle(rolling, `${item.id}-${days}d`))} />{days}D</label>
          {/each}</div>
        </fieldset>
      {/each}
      <p>{sourceGrain === 'day' ? 'Trailing daily averages (feature-weighted for rates where applicable), even on W/M views. Full observed windows required. Partial days are not extrapolated. 7D solid · 30D dashed · 90D dotted.' : `Only ${sourceGrain} source data is available; daily rolling averages cannot be reconstructed.`}</p>
    </div>
  </details>
</div>
{#if calendar !== 'UTC'}<p class="resolution">{calendar} buckets · source calendar retained</p>{/if}
{#if showSourceResolution && sourceGrain !== 'day'}<p class="resolution">SOURCE: {sourceGrain.toUpperCase()} · other calendar buckets unavailable</p>{/if}

<style>
  .chart-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px; padding: 6px 0 10px; min-width: 0; }
  .buckets { display: flex; gap: 3px; }
  button, summary, legend, label, p { font: 11px var(--term-font-mono); }
  button, summary { color: var(--term-text-3); background: transparent; border: 1px solid var(--term-border); border-radius: 0; min-height: 32px; padding: 5px 8px; cursor: pointer; }
  button[aria-pressed=true], summary:hover, details[open] summary { color: var(--term-accent); }
  button:disabled, input:disabled { opacity: .45; cursor: not-allowed; }
  button:focus-visible, summary:focus-visible, input:focus-visible { outline: 1px solid var(--term-accent); outline-offset: 2px; }
  details { position: relative; flex: 0 1 300px; min-width: 0; max-width: 100%; }
  summary { display: inline-flex; align-items: center; box-sizing: border-box; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary::after { content: '▾'; margin-left: 8px; }
  details[open] summary::after { content: '▴'; }
  .options { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; width: 100%; max-height: 360px; overflow: auto; box-sizing: border-box; padding: 12px; background: var(--term-surface); border: 1px solid var(--term-border); }
  fieldset { border: 0; padding: 0; margin: 0 0 10px; min-width: 0; }
  legend { padding: 0; color: var(--term-text-body); overflow-wrap: anywhere; }
  i { display: inline-block; width: 9px; height: 9px; margin-right: 7px; }
  .choices { display: flex; flex-wrap: wrap; gap: 5px 14px; }
  label { min-height: 32px; display: flex; align-items: center; gap: 5px; color: var(--term-text-body); cursor: pointer; }
  input { accent-color: var(--term-accent); margin: 0; }
  p { margin: 0; color: var(--term-text-3); line-height: 1.6; }
  .resolution { padding-bottom: 6px; }
</style>
