<script>
  import { currentCurrency, currencies, currencyConfig, setCurrency } from '$lib/stores/currency';
  import { ChevronDownIcon } from '$lib/components';

  let isOpen = false;

  function select(currency) {
    setCurrency(currency);
    isOpen = false;
  }

  function handleClickOutside(event) {
    if (isOpen && !event.target.closest('.currency-selector')) {
      isOpen = false;
    }
  }
</script>

<svelte:window on:click={handleClickOutside} />

<div class="currency-selector">
  <button class="selector-btn" on:click|stopPropagation={() => isOpen = !isOpen}>
    <span class="selector-symbol">{currencyConfig[$currentCurrency].symbol.trim()}</span>
    <span class="selector-code">{$currentCurrency}</span>
    <span class="selector-chevron" class:open={isOpen}><ChevronDownIcon size={10} /></span>
  </button>

  {#if isOpen}
    <div class="selector-dropdown" on:click|stopPropagation>
      {#each currencies as currency}
        <button
          class="selector-option"
          class:active={$currentCurrency === currency}
          on:click={() => select(currency)}
        >
          <span class="option-symbol">{currencyConfig[currency].symbol.trim()}</span>
          <span class="option-code">{currency}</span>
          <span class="option-label">{currencyConfig[currency].label}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .currency-selector {
    position: relative;
    display: inline-block;
  }

  .selector-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    color: #888;
    background: #111;
    border: 1px solid #222;
    border-radius: 3px;
    padding: 4px 8px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
    white-space: nowrap;
  }

  .selector-btn:hover {
    color: #ccc;
    border-color: #333;
    background: #1a1a1a;
  }

  .selector-symbol {
    color: #00cc66;
  }

  .selector-chevron {
    display: inline-flex;
    transition: transform 0.15s;
    color: #555;
  }

  .selector-chevron.open {
    transform: rotate(180deg);
  }

  .selector-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 20;
    background: #111;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    min-width: 200px;
    max-height: 320px;
    overflow-y: auto;
    padding: 4px 0;
  }

  .selector-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px;
    background: none;
    border: none;
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #888;
    transition: background 0.1s, color 0.1s;
    text-align: left;
  }

  .selector-option:hover {
    background: #1a1a1a;
    color: #ccc;
  }

  .selector-option.active {
    color: #00cc66;
  }

  .option-symbol {
    width: 28px;
    text-align: right;
    color: inherit;
    font-weight: 600;
    flex-shrink: 0;
  }

  .option-code {
    width: 32px;
    font-weight: 600;
    flex-shrink: 0;
  }

  .option-label {
    color: #555;
    font-size: 10px;
    font-weight: 400;
  }

  .selector-option.active .option-label {
    color: #00cc6688;
  }
</style>
