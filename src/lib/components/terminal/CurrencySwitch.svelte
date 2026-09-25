<script>
  export let unit = 'rune';
  export let usdAvailable = true;
  export let ariaLabel = 'Values in US dollars';
  export let title = '';
  export let onChange = (_unit) => {};
</script>

<button type="button" class="currency-switch" role="switch"
  aria-label={ariaLabel} aria-checked={unit === 'usd'}
  disabled={unit !== 'usd' && !usdAvailable} {title}
  on:click={() => onChange(unit === 'usd' ? 'rune' : 'usd')}>
  <span class:active={unit === 'rune'} aria-hidden="true">RUNE</span>
  <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
  <span class:active={unit === 'usd'} aria-hidden="true">$</span>
</button>

<style>
  .currency-switch { display: inline-flex; flex-shrink: 0; align-items: center; gap: 8px; min-height: 34px; padding: 4px; border: 0; background: transparent; color: var(--term-text-3); font: 11px var(--term-font-mono); cursor: pointer; }
  .active { color: var(--term-accent); }
  .switch-track { position: relative; flex: 0 0 36px; height: 18px; box-sizing: border-box; border: 1px solid var(--term-accent-edge); border-radius: 2px; background: var(--term-accent-soft); }
  .switch-thumb { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; background: var(--term-accent); transition: transform .15s ease; }
  [aria-checked="true"] .switch-thumb { transform: translateX(18px); }
  button:focus-visible { outline: 2px solid var(--term-accent); outline-offset: 2px; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  @media (prefers-reduced-motion: reduce) { .switch-thumb { transition: none; } }
</style>
