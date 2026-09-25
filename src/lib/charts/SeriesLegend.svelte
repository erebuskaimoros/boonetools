<script>
  /** @type {ReadonlyArray<{ id: string, label: string, mark: string, color: string }>} */
  export let series = [];
  export let hidden = [];
  /** @type {((id: string) => void) | null} */
  export let onToggle = null;
</script>

<div class="series-legend" aria-label="Chart series">
  {#each series as item (item.id)}
    {#if onToggle}
      <button class:muted={hidden.includes(item.id)} aria-pressed={!hidden.includes(item.id)} on:click={() => onToggle(item.id)}>
        <span class:line={item.mark === 'line'} style={`--series-color:${item.color}`} aria-hidden="true"></span>{item.label}
      </button>
    {:else}
      <span class="series-label"><span class:line={item.mark === 'line'} style={`--series-color:${item.color}`} aria-hidden="true"></span>{item.label}</span>
    {/if}
  {/each}
</div>

<style>
  .series-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; }
  button, .series-label { display: inline-flex; align-items: center; gap: 7px; min-height: 32px; padding: 4px 0; border: 0; background: transparent; color: var(--term-text-body); font: 11px var(--term-font-mono); }
  button { cursor: pointer; }
  button:hover { color: var(--term-text-1); }
  button:focus-visible { outline: 1px solid var(--term-accent); outline-offset: 3px; }
  button.muted { opacity: .5; text-decoration: line-through; }
  button > span, .series-label > span { width: 10px; height: 10px; flex: 0 0 10px; border: 1px solid var(--series-color); background: var(--series-color); }
  button > span.line, .series-label > span.line { height: 2px; border: 0; }
</style>
