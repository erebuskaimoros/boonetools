<script>
  import { createEventDispatcher } from 'svelte';

  export let voteKey = '';
  /** @type {import('./adr-preference.js').AdrPreference | null} */
  export let preference = null;
  export let expanded = false;
  const dispatch = createEventDispatcher();

  $: preferred = preference && preference.variants.length > 1 && preference.state === 'preferred';
  $: tied = preference && preference.variants.length > 1 && preference.state === 'tied'
    && preference.count === preference.variants[0].count;

  function open(event) {
    event.stopPropagation();
    dispatch('open', { key: voteKey, trigger: event.currentTarget });
  }
</script>

<button
  class="info-button"
  type="button"
  aria-label={`About vote key ${voteKey}`}
  aria-haspopup="dialog"
  aria-expanded={expanded}
  title={`About ${voteKey}`}
  on:click={open}
>
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" />
    <path d="M8 7v4" stroke="currentColor" stroke-width="1.5" />
    <circle cx="8" cy="4.5" r=".85" fill="currentColor" />
  </svg>
</button>
{#if preferred && preference}
  <span class="preference" title={`Most current active-validator votes among spellings of ADR ${preference.number}: ${preference.count}. Votes remain separate.`}>most voted · {preference.count}</span>
{:else if tied && preference}
  <span class="preference tied" title="These spellings have equal current active-validator support; no preferred key is selected.">tied · {preference.count}</span>
{/if}

<style>
  .info-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    flex: 0 0 auto;
    background: transparent;
    color: var(--term-text-2, #c8c8c8);
    border: 1px solid var(--border, #1a1a1a);
    cursor: pointer;
  }
  .info-button:hover, .info-button:focus-visible, .info-button[aria-expanded='true'] {
    color: var(--accent, #00cc66);
    border-color: var(--accent, #00cc66);
    outline: none;
  }
  .preference {
    color: var(--accent, #00cc66);
    border: 1px solid var(--accent-edge, rgba(0, 204, 102, .4));
    padding: 2px 5px;
    font: 600 10px/1.4 'JetBrains Mono', monospace;
    white-space: nowrap;
  }
  .preference.tied { color: var(--amber, #d4a017); border-color: var(--amber, #d4a017); }
  @media (pointer: coarse) { .info-button { width: 36px; height: 36px; } }
</style>
