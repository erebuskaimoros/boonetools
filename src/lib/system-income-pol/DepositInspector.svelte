<script>
  import { polDepositBuckets, polDepositTooltip } from './charts.js';
  export let rows = [];
  export let unit = 'rune';
  export let grain = 'day';
  let selectedDay = '';
  $: buckets = polDepositBuckets(rows, grain);
  $: selected = buckets.find(row => row.day === selectedDay);
  $: if (selectedDay && !buckets.some(row => row.day === selectedDay)) selectedDay = '';
</script>

<svelte:window on:keydown={event => { if (event.key === 'Escape') selectedDay = ''; }} />
<div class="inspect-controls">
  <label for="pol-deposit-bucket">INSPECT {grain.toUpperCase()}</label>
  <select id="pol-deposit-bucket" bind:value={selectedDay} aria-describedby={selected ? 'pol-deposit-detail' : undefined}>
    <option value="">Choose a UTC {grain}</option>
    {#each buckets as bucket}<option value={bucket.day}>{bucket.fromDay ? `${bucket.fromDay} → ${bucket.throughDay}` : bucket.day}{bucket.partial ? ' · partial' : ''}</option>{/each}
  </select>
  <button type="button" disabled={!selected} on:click={() => selectedDay = ''}>[DISMISS]</button>
</div>
{#if selected}
  <div id="pol-deposit-detail" class="deposit-detail" aria-live="polite">{@html polDepositTooltip(selected, unit)}</div>
{/if}

<style>
  .inspect-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 0; }
  label, select, button, .deposit-detail { font: 12px/1.6 var(--term-font-mono); color: var(--term-text-2); }
  select, button { background: var(--term-surface); border: 1px solid var(--term-border); border-radius: 0; min-height: 32px; padding: 5px 8px; max-width: 100%; }
  button { cursor: pointer; }
  button:disabled { opacity: .45; cursor: default; }
  select:focus-visible, button:focus-visible { outline: 2px solid var(--term-accent); outline-offset: 2px; }
  .deposit-detail { border-top: 1px solid var(--term-border); padding: 12px 0; overflow-wrap: anywhere; }
</style>
