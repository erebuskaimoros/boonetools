<script>
  import { tick } from 'svelte';
  import { STO_WIDGET_API_KEY, STO_WIDGET_ORIGIN, isSwapShortcut, stoWidgetUrl, swapOpen } from './sto-widget.js';

  const widgetUrl = STO_WIDGET_API_KEY ? stoWidgetUrl(STO_WIDGET_API_KEY) : '';

  let panel;
  // The iframe is created on first open and then kept, so closing the panel or
  // switching dashboards never discards a swap in progress.
  let mounted = false;
  let loaded = false;

  $: if ($swapOpen) mounted = true;
  $: if ($swapOpen) focusPanel();

  async function focusPanel() {
    await tick();
    panel?.focus();
  }

  function close() {
    swapOpen.set(false);
    document.getElementById('swap-launcher')?.focus();
  }

  function onKeydown(event) {
    if (!widgetUrl) return;
    // A page dialog (e.g. a Thorfolio action review) keeps Escape for itself.
    if (event.key === 'Escape' && $swapOpen && !document.querySelector('[aria-modal="true"]')) {
      event.stopPropagation();
      close();
    } else if (isSwapShortcut(event) && !document.querySelector('[aria-modal="true"]')) {
      event.preventDefault();
      if ($swapOpen) close();
      else swapOpen.set(true);
    }
  }
</script>

<!-- Capture phase so Escape closes the panel before a page's own Escape handling runs. -->
<svelte:window on:keydown|capture={onKeydown} />

{#if widgetUrl}
  <div
    id="swap-panel"
    class="swap-panel"
    class:open={$swapOpen}
    role="dialog"
    aria-modal="false"
    aria-label="Swap"
    tabindex="-1"
    bind:this={panel}
  >
    <header class="swap-head">
      <span class="swap-title"><span class="prompt">$</span> swap</span>
      <a class="swap-source" href={STO_WIDGET_ORIGIN} target="_blank" rel="noopener noreferrer">via swap.thorchain.org</a>
      <button class="swap-close" on:click={close}>
        <span class="bracket">[</span><span class="key">esc</span><span class="bracket">]</span> close
      </button>
    </header>
    <div class="swap-body">
      {#if mounted}
        {#if !loaded}<p class="swap-loading">▓░░░░ loading swap</p>{/if}
        <iframe
          src={widgetUrl}
          title="THORChain swap"
          allow="clipboard-write"
          class:ready={loaded}
          on:load={() => (loaded = true)}
        ></iframe>
      {/if}
    </div>
  </div>
{/if}

<style>
  .swap-panel {
    position: fixed;
    right: 16px;
    bottom: calc(var(--footer-height, 41px) + 8px);
    z-index: 150; /* above the footer, below the nav dropdown and page dialogs */
    display: none;
    flex-direction: column;
    width: min(440px, calc(100vw - 32px));
    height: min(680px, calc(100dvh - var(--footer-height, 41px) - 24px));
    background: #0a0a0a;
    border: 1px solid #2a2a2a;
    font-family: 'JetBrains Mono', monospace;
  }

  .swap-panel.open {
    display: flex;
  }

  .swap-panel:focus-visible {
    outline: 1px solid #00cc66;
    outline-offset: -1px;
  }

  .swap-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px 8px 12px;
    border-bottom: 1px solid #1a1a1a;
    font-size: 12px;
  }

  .swap-head * {
    font-family: 'JetBrains Mono', monospace;
  }

  .swap-title {
    color: #f5f5f5;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .prompt {
    color: #00cc66;
  }

  .swap-source {
    margin-right: auto;
    color: #b2b2b2;
    font-size: 11px;
    text-decoration: none;
  }

  .swap-source:hover {
    color: #00cc66;
  }

  .swap-close {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border: 1px solid #1a1a1a;
    background: transparent;
    color: #c8c8c8;
    font-size: 11px;
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease;
  }

  .swap-close:hover,
  .swap-close:focus-visible {
    border-color: #00cc66;
    color: #00cc66;
    outline: none;
  }

  .bracket {
    color: #787878;
  }

  .key {
    color: #00cc66;
    font-weight: 700;
  }

  .swap-body {
    position: relative;
    flex: 1;
    min-height: 0;
    background: #0d0d0d;
  }

  .swap-loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0;
    color: #b2b2b2;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }

  iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    color-scheme: dark;
    visibility: hidden;
  }

  iframe.ready {
    visibility: visible;
  }

  /* Phones: a full-height sheet between the top bar and the footer. */
  @media (max-width: 600px) {
    .swap-panel {
      top: var(--topbar-height, 40px);
      right: 0;
      bottom: var(--footer-height, 32px);
      left: 0;
      width: auto;
      height: auto;
      border-width: 1px 0 0;
    }
  }
</style>
