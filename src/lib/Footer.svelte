<script>
  import { tick } from 'svelte';
  import { STO_WIDGET_API_KEY, STO_WIDGET_ENABLED, swapOpen } from './swap/sto-widget.js';
  import { TIP_JAR_ADDRESS } from './tip-jar/tip-jar.js';

  const SOURCE_URL = 'https://github.com/erebuskaimoros/boonetools';
  const AUTHOR_URL = 'https://x.com/boonew';

  // The send-RUNE panel and its wallet code load on first click, keeping every page's footer light.
  let TipJarModal = null;
  let tipOpen = false;
  let tipButton;

  // One docked panel at a time: opening swap closes the coffee panel, and vice versa.
  $: if ($swapOpen) tipOpen = false;

  async function toggleTipJar() {
    if (tipOpen) {
      closeTipJar();
      return;
    }
    trackFooterClick('Tip jar');
    TipJarModal ??= (await import('./tip-jar/TipJarModal.svelte')).default;
    swapOpen.set(false);
    tipOpen = true;
  }

  async function closeTipJar() {
    tipOpen = false;
    await tick();
    tipButton?.focus();
  }

  function trackFooterClick(elementName) {
    if (typeof gtag !== 'undefined') {
      gtag('event', 'footer_click', { element_name: elementName });
    }
  }
</script>

<!-- Status line continuing the sidebar's bottom row: about links on the left, swap on the right. -->
<footer class="site-footer">
  <nav class="footer-links" aria-label="About BooneTools">
    <a class="footer-source" href={SOURCE_URL} target="_blank" rel="noopener noreferrer" on:click={() => trackFooterClick('Source')}>source</a>
    <span class="sep footer-source" aria-hidden="true">│</span>
    <span class="footer-by">by <a href={AUTHOR_URL} target="_blank" rel="noopener noreferrer" on:click={() => trackFooterClick('boonew')}>@boonew</a></span>
    <span class="sep" aria-hidden="true">│</span>
    <span class="tip-group">
      <span class="tip-label">buy me a coffee?</span>
      <button
        class="tip"
        class:active={tipOpen}
        bind:this={tipButton}
        aria-expanded={tipOpen}
        aria-controls="tip-panel"
        title="Send RUNE to boonew's tip jar"
        on:click={toggleTipJar}
      >
        <span class="tip-address">{TIP_JAR_ADDRESS}</span>
      </button>
    </span>
  </nav>

  {#if STO_WIDGET_ENABLED && STO_WIDGET_API_KEY}
    <button
      id="swap-launcher"
      class="swap-launcher"
      class:active={$swapOpen}
      aria-expanded={$swapOpen}
      aria-controls="swap-panel"
      aria-keyshortcuts="S"
      on:click={() => swapOpen.update((open) => !open)}
    >
      <span class="swap-key" aria-hidden="true"><span class="bracket">[</span><span class="key">s</span><span class="bracket">]</span></span>
      <span class="prompt" aria-hidden="true">&gt;</span>
      <span class="swap-label">swap on THORChain</span>
    </button>
  {/if}
</footer>

<!-- Outside the fixed footer, so the panel layers like the swap panel rather than inside the footer's stacking context. -->
{#if tipOpen && TipJarModal}
  <svelte:component this={TipJarModal} on:close={closeTipJar} />
{/if}

<style>
  .site-footer {
    position: fixed;
    left: var(--footer-inset, 0px);
    right: 0;
    bottom: 0;
    z-index: 100;
    box-sizing: border-box;
    height: var(--footer-height, 41px);
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 12px 0 16px;
    background: var(--term-surface);
    border-top: 1px solid var(--term-border-soft);
    color: var(--term-text-5);
    font-family: var(--term-font-mono);
    font-size: var(--term-type-label);
    line-height: 1;
  }

  .site-footer * {
    font-family: var(--term-font-mono);
  }

  .footer-links {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    white-space: nowrap;
    overflow: hidden;
  }

  .footer-links a {
    color: var(--term-text-3);
    text-decoration: none;
    transition: color var(--term-transition);
  }

  .footer-links a:hover,
  .footer-links a:focus-visible {
    color: var(--term-accent);
  }

  .footer-links a:focus-visible,
  .tip:focus-visible {
    outline: 1px solid var(--term-accent);
    outline-offset: 3px;
  }

  .sep {
    color: #787878;
  }

  .tip-group {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .tip {
    display: flex;
    min-width: 0;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
    font-size: var(--term-type-label);
  }

  .tip-label {
    flex: none;
    color: var(--term-text-3);
  }

  .tip-address {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--term-text-3);
    transition: color var(--term-transition);
  }

  .tip:hover .tip-address,
  .tip:focus-visible .tip-address,
  .tip.active .tip-address {
    color: var(--term-accent);
  }

  /* Terminal bracket button (DESIGN.md) that opens the sitewide swap panel:
     `[s] > swap on THORChain`. */
  .swap-launcher {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 26px;
    padding: 0 11px;
    border: 0;
    background: #0a0a0a;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 0.15s ease;
  }

  .swap-launcher span {
    font-size: 12px;
    line-height: 1;
  }

  .swap-launcher .bracket {
    color: #787878;
  }

  .swap-launcher .key,
  .swap-launcher .prompt {
    color: #00cc66;
    font-weight: 700;
  }

  .swap-launcher .swap-label {
    color: #e8e8e8;
    font-weight: 600;
  }

  .swap-launcher:hover,
  .swap-launcher.active {
    background: #09180f;
  }

  .swap-launcher:hover .swap-label,
  .swap-launcher.active .swap-label {
    color: #00cc66;
  }

  .swap-launcher:focus-visible {
    outline: 1px solid #f5f5f5;
    outline-offset: 2px;
  }

  @media (max-width: 600px) {
    .site-footer {
      gap: 10px;
      padding: 0 8px 0 12px;
    }

    /* Keep the address action available when the explanatory label won't fit. */
    .tip-label {
      display: none;
    }

    .swap-launcher {
      height: 24px; /* minimum touch target */
      gap: 6px;
      padding: 0 9px;
    }

    .swap-launcher span {
      font-size: 11px;
    }
  }

  @media (max-width: 400px) {
    .footer-source {
      display: none;
    }
  }

  /* Touch screens have no S key to press. */
  @media (hover: none) {
    .swap-launcher .swap-key {
      display: none;
    }
  }
</style>
