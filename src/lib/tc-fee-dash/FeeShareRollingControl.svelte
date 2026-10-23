<script>
  export let value = 0;
  let open = false, menu, trigger;
  function select(days) { value = value === days ? 0 : days; }
  function dismiss(event) { if (open && !menu?.contains(event.target)) open = false; }
  function escape(event) { if (open && event.key === 'Escape') { open = false; trigger?.focus(); } }
</script>

<svelte:window on:click={dismiss} on:keydown={escape} />
<details bind:this={menu} bind:open>
  <summary bind:this={trigger}>[ROLLING AVGS{value ? ` · ${value}D` : ''}]</summary>
  <div class="options" role="group" aria-label="Pool fee share rolling average">
    <div class="choices">
      {#each [7, 30] as days}
        <label><input type="checkbox" checked={value === days}
          aria-label={`${days}-day fee share average`} on:change={() => select(days)} />{days}D</label>
      {/each}
    </div>
    <p>Choose one to replace all four areas with trailing fee-weighted shares. Clear it to restore the regular series.</p>
  </div>
</details>

<style>
  details { position: relative; flex: 0 1 300px; min-width: 0; max-width: 100%; }
  summary, label, p { font: 11px var(--term-font-mono); }
  summary { display: inline-flex; align-items: center; box-sizing: border-box; list-style: none; min-height: 32px; padding: 5px 8px; color: var(--term-text-3); background: transparent; border: 1px solid var(--term-border); border-radius: 0; cursor: pointer; }
  summary:hover, details[open] summary { color: var(--term-accent); }
  summary:focus-visible, input:focus-visible { outline: 1px solid var(--term-accent); outline-offset: 2px; }
  summary::-webkit-details-marker { display: none; }
  summary::after { content: '▾'; margin-left: 8px; }
  details[open] summary::after { content: '▴'; }
  .options { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; width: 100%; box-sizing: border-box; padding: 12px; background: var(--term-surface); border: 1px solid var(--term-border); }
  .choices { display: flex; flex-wrap: wrap; gap: 5px 14px; margin-bottom: 8px; }
  label { min-height: 32px; display: flex; align-items: center; gap: 5px; color: var(--term-text-body); cursor: pointer; }
  input { accent-color: var(--term-accent); margin: 0; }
  p { margin: 0; color: var(--term-text-3); line-height: 1.6; }
</style>
