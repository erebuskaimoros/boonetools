<script>
  export let chartLabel = 'Time series';
  export let windowStart = '—';
  export let windowEnd = '—';
  export let customDuration = '';
  export let rangeOptions = [];
  export let bucketOptions = [];
  export let selectedRange = 'all';
  export let selectedBucket = '1h';
  export let zoomed = false;
  export let hasCoarserSourceBuckets = false;
  /** @type {(key: string) => void} */
  export let onRange = () => {};
  /** @type {(key: string) => void} */
  export let onBucket = () => {};
  export let onReset = () => {};
</script>

<div class="chart-controls" aria-label={`${chartLabel} chart controls`}>
  <div class="window-copy">
    <span class="control-label">WINDOW</span>
    <span>{windowStart} → {windowEnd}</span>
    {#if zoomed}<b>CUSTOM · {customDuration}</b>{/if}
  </div>

  <div class="control-actions">
    <div class="control-group">
      <span class="control-label">RANGE</span>
      <div class="button-row">
        {#each rangeOptions as option}
          <button
            class:active={!zoomed && selectedRange === option.key}
            aria-pressed={!zoomed && selectedRange === option.key}
            on:click={() => onRange(option.key)}
          ><span>[</span>{option.label}<span>]</span></button>
        {/each}
      </div>
    </div>

    <div class="control-group">
      <span class="control-label">BUCKET</span>
      <div class="button-row">
        {#each bucketOptions as option}
          <button
            class:active={selectedBucket === option.key}
            aria-pressed={selectedBucket === option.key}
            on:click={() => onBucket(option.key)}
          ><span>[</span>{option.label}<span>]</span></button>
        {/each}
      </div>
    </div>

    <button class="zoom-reset" on:click={onReset} disabled={!zoomed}>[reset zoom]</button>
  </div>

  <div class="zoom-hint">
    <span>DRAG TO ZOOM SHARED WINDOW · PINCH ON TOUCH · DOUBLE-CLICK TO RESET</span>
    {#if hasCoarserSourceBuckets}
      <b>OLDER SOURCE DATA RETAINS DAILY GRAIN</b>
    {/if}
  </div>
</div>

<style>
  .chart-controls,
  .window-copy,
  .control-actions,
  .control-group,
  .button-row,
  .zoom-hint {
    display: flex;
    align-items: center;
  }

  .chart-controls {
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 8px 14px;
    margin-top: 12px;
    padding: 8px 10px;
    border: 1px solid var(--term-border);
    background: var(--term-surface-deep);
    color: var(--term-text-3);
    font: 10px/1.4 var(--term-font-mono);
  }

  .window-copy {
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
  }

  .window-copy b {
    color: var(--term-amber);
    font-weight: 700;
  }

  .control-label {
    color: var(--term-accent);
    font-weight: 700;
    letter-spacing: 0.12em;
  }

  .control-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px 12px;
  }

  .control-group { gap: 6px; }
  .button-row { flex-wrap: wrap; gap: 4px; }

  button {
    padding: 4px 6px;
    border: 1px solid var(--term-border);
    background: transparent;
    color: var(--term-text-2);
    cursor: pointer;
    font: 600 10px var(--term-font-mono);
    text-transform: uppercase;
    transition: border-color var(--term-transition), color var(--term-transition);
  }

  button span { color: var(--term-text-5); }
  button:hover:not(:disabled),
  button.active {
    border-color: var(--term-accent);
    color: var(--term-accent);
  }
  button:disabled { opacity: 0.45; cursor: default; }
  .zoom-reset { white-space: nowrap; }

  .zoom-hint {
    flex-basis: 100%;
    justify-content: space-between;
    gap: 10px;
    padding-top: 6px;
    border-top: 1px solid var(--term-border-faint);
    color: var(--term-text-4);
    letter-spacing: 0.03em;
  }

  .zoom-hint b { color: var(--term-amber); font-weight: 700; }

  @media (max-width: 760px) {
    .chart-controls,
    .control-actions,
    .control-group,
    .zoom-hint {
      align-items: flex-start;
      flex-direction: column;
    }

    .control-actions { width: 100%; }
  }
</style>
