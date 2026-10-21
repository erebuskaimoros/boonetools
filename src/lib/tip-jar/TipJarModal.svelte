<script>
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { thornode } from '../api/index.js';
  import { walletAccounts } from '../limit-orders/store.js';
  import WalletModal from '../position-tracker/WalletModal.svelte';
  import { pickSigner } from '../position-tracker/actions-signer.js';
  import { planSendRune } from '../position-tracker/memos.js';
  import { fmtAmount, shortAddr, txUrl } from '../position-tracker/format.js';
  import '../position-tracker/tracker.css';
  import { DEFAULT_NATIVE_FEE_RUNE, TIP_JAR_ADDRESS, TIP_PRESETS_USD, runeForUsd, tipAmountProblem } from './tip-jar.js';

  const dispatch = createEventDispatcher();
  const accountKey = (account) => `${account.provider}:${account.address}`;

  let amount = '';
  let presetUsd = TIP_PRESETS_USD[0];
  let runePriceUsd = 0;
  let feeRune = DEFAULT_NATIVE_FEE_RUNE;
  let priceUnavailable = false;
  let signerKey = '';
  let balanceRune = null;
  let balanceRequest = 0;
  let walletOpen = false;
  let phase = 'form'; // form | signing | sent | failed
  let note = '';
  let txHash = '';
  let sentAmount = '';
  let errorText = '';
  let copyState = '';
  let copyTimer;
  let amountInput;

  $: thorAccounts = $walletAccounts.filter((account) => account.network === 'THOR');
  $: signer = thorAccounts.find((account) => accountKey(account) === signerKey) || pickSigner($walletAccounts, { chain: 'THOR' });
  $: loadBalance(signer?.address || '');
  $: problem = tipAmountProblem(amount, { balanceRune, feeRune });
  $: usdValue = !problem && runePriceUsd > 0 ? Number(amount) * runePriceUsd : 0;
  $: canSend = phase === 'form' && !!signer && !problem;

  onMount(async () => {
    await tick();
    amountInput?.focus();
    try {
      const network = await thornode.getNetwork();
      runePriceUsd = Number(network?.rune_price_in_tor) / 1e8 || 0;
      const fee = Number(network?.native_tx_fee_rune) / 1e8;
      if (fee > 0) feeRune = fee;
    } catch {
      runePriceUsd = 0;
    }
    priceUnavailable = !runePriceUsd;
    // Prefill the first preset ($3) unless the visitor already typed something.
    if (!amount && presetUsd) amount = runeForUsd(presetUsd, runePriceUsd);
  });

  onDestroy(() => clearTimeout(copyTimer));

  async function loadBalance(address) {
    const request = ++balanceRequest;
    balanceRune = null;
    if (!address) return;
    try {
      const payload = await thornode.getBalance(address, { cache: false });
      if (request !== balanceRequest) return;
      const rune = (payload?.balances || []).find((coin) => coin.denom === 'rune');
      balanceRune = Number(rune?.amount || 0) / 1e8;
    } catch {
      // Unknown balance: the wallet still refuses a send it can't cover.
    }
  }

  function choosePreset(usd) {
    presetUsd = usd;
    amount = runeForUsd(usd, runePriceUsd);
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(TIP_JAR_ADDRESS);
      copyState = 'copied';
    } catch {
      copyState = 'failed';
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyState = ''; }, 2000);
  }

  async function send() {
    if (!canSend) return;
    let plan;
    try {
      plan = planSendRune({ amount, recipient: TIP_JAR_ADDRESS });
    } catch (error) {
      errorText = error.message;
      return;
    }
    phase = 'signing';
    note = 'Preparing transaction…';
    errorText = '';
    try {
      const { executePlan } = await import('../position-tracker/actions.js');
      txHash = String(await executePlan(plan, signer, { onStatus: (text) => { note = text; } }) || '');
      sentAmount = plan.amount;
      phase = 'sent';
    } catch (error) {
      errorText = error?.message || String(error);
      phase = 'failed';
    }
  }

  function close() {
    if (phase === 'signing') return;
    dispatch('close');
  }

  // Capture phase, so Escape closes this panel before the page's own Escape handling.
  // A real modal on top (the wallet dialog, a Thorfolio action review) keeps the keyboard.
  function onKeydown(event) {
    if (walletOpen || document.querySelector('[aria-modal="true"]')) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    const tag = event.target?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'c' && phase === 'form') {
      event.preventDefault();
      copyAddress();
    }
  }
</script>

<svelte:window on:keydown|capture={onKeydown} />

<!-- Docked above the footer like the swap panel: non-modal, the rest of the site stays usable.
     `ptrack-modal-backdrop` only borrows Thorfolio's modal styling scope; tip-dock undoes its backdrop. -->
<div class="ptrack-modal-backdrop tip-dock">
  <div id="tip-panel" class="ptrack-modal" role="dialog" aria-modal="false" aria-labelledby="tip-jar-title">
    <div class="modal-head">
      <span id="tip-jar-title"><span class="prompt">$</span> buy boonew a coffee</span>
      <button class="bracket-btn" on:click={close} disabled={phase === 'signing'}>
        <span class="bracket">[</span><span class="key">esc</span><span class="bracket">]</span> close
      </button>
    </div>

    {#if phase === 'form'}
      <div class="modal-section">
        <span class="modal-label">send rune to</span>
        <div class="tip-to">
          <code class="tip-address">{TIP_JAR_ADDRESS}</code>
          <button class="bracket-btn" type="button" on:click={copyAddress}>
            <span class="bracket">[</span><span class="key">c</span><span class="bracket">]</span>
            {copyState === 'copied' ? 'copied' : copyState === 'failed' ? 'copy blocked' : 'copy address'}
          </button>
        </div>
        <p class="hint">Tips go to boonew, who builds and runs boone.tools. Thank you.</p>
      </div>

      <form on:submit|preventDefault={send}>
        <div class="modal-section form-grid">
          <label class="field">
            <span class="modal-label">amount (rune){#if balanceRune != null} · available {fmtAmount(balanceRune, 2)}{/if}</span>
            <input
              class="field-input"
              bind:this={amountInput}
              bind:value={amount}
              inputmode="decimal"
              placeholder="0.0"
              autocomplete="off"
              on:input={() => (presetUsd = null)}
            />
          </label>
          <div class="seg" role="group" aria-label="Amount in dollars">
            {#each TIP_PRESETS_USD as usd}
              <button type="button" class="seg-btn" class:active={presetUsd === usd} aria-pressed={presetUsd === usd} disabled={!runePriceUsd} on:click={() => choosePreset(usd)}>${usd}</button>
            {/each}
          </div>
          <p class="hint">
            {#if priceUnavailable}Couldn't load the RUNE price, so enter an amount in RUNE.
            {:else if usdValue}≈ ${usdValue.toFixed(2)}, plus a {feeRune} RUNE network fee.
            {:else}Plus a {feeRune} RUNE network fee.{/if}
          </p>

          <div class="field">
            <span class="modal-label">from</span>
            {#if thorAccounts.length > 1}
              <select class="field-input" value={signer ? accountKey(signer) : ''} on:change={(event) => (signerKey = event.currentTarget.value)}>
                {#each thorAccounts as account (accountKey(account))}
                  <option value={accountKey(account)}>{account.provider.toLowerCase()} · {shortAddr(account.address, 10, 6)}</option>
                {/each}
              </select>
            {:else if signer}
              <span class="tip-from">{signer.provider.toLowerCase()} · <span title={signer.address}>{shortAddr(signer.address, 10, 6)}</span></span>
            {:else}
              <p class="hint">Connect a wallet with a THORChain account to send RUNE.</p>
            {/if}
          </div>

          {#if amount && problem}<p class="hint warn-text">{problem}</p>{/if}
          {#if errorText}<p class="hint err-text">{errorText}</p>{/if}
        </div>

        <div class="modal-actions">
          {#if !signer}
            <button class="bracket-btn" type="button" on:click={() => (walletOpen = true)}>
              <span class="bracket">[</span><span class="key">W</span><span class="bracket">]</span> connect wallet
            </button>
          {/if}
          <button class="bracket-btn primary" type="submit" disabled={!canSend}>
            <span class="bracket">[</span><span class="key">↵</span><span class="bracket">]</span>
            send {problem ? '' : `${amount} `}rune
          </button>
        </div>
      </form>
    {:else}
      <div class="modal-section">
        <div class="review">
          <div class="review-title">
            <span class="pill" class:ok={phase === 'sent'} class:warn={phase === 'signing'} class:err={phase === 'failed'}>{phase}</span>
            {phase === 'sent' ? `${sentAmount} RUNE sent. Thank you!` : `Send ${amount} RUNE to …${TIP_JAR_ADDRESS.slice(-4)}`}
          </div>
          {#if phase === 'signing'}<p class="hint">{note}</p>{/if}
          {#if phase === 'failed'}<p class="hint err-text">{errorText}</p>{/if}
          {#if txHash}
            <p class="hint">tx <a href={txUrl(txHash)} target="_blank" rel="noopener noreferrer">{shortAddr(txHash, 10, 8)}</a></p>
          {/if}
        </div>
      </div>
      <div class="modal-actions">
        {#if phase === 'failed'}
          <button class="bracket-btn" on:click={() => (phase = 'form')}>
            <span class="bracket">[</span><span class="key">←</span><span class="bracket">]</span> back
          </button>
        {/if}
        <button class="bracket-btn" disabled={phase === 'signing'} on:click={close}>
          <span class="bracket">[</span><span class="key">esc</span><span class="bracket">]</span> close
        </button>
      </div>
    {/if}
  </div>
</div>

<WalletModal bind:open={walletOpen} />

<style>
  /* Undo the shared backdrop: no full-screen overlay, just a panel above the footer's left end. */
  .tip-dock {
    inset: auto;
    left: calc(var(--footer-inset, 0px) + 16px);
    bottom: calc(var(--footer-height, 41px) + 8px);
    z-index: 150; /* same layer as the swap panel: above the footer, below dialogs */
    display: block;
    width: min(440px, calc(100vw - var(--footer-inset, 0px) - 32px));
    max-height: calc(100dvh - var(--footer-height, 41px) - 24px);
    padding: 0;
    overflow-y: auto;
    background: transparent;
  }

  .tip-dock .ptrack-modal {
    width: 100%;
  }

  /* Phones: a full-height sheet between the top bar and the footer, like the swap panel. */
  @media (max-width: 600px) {
    .tip-dock {
      top: var(--topbar-height, 40px);
      right: 0;
      bottom: var(--footer-height, 32px);
      left: 0;
      width: auto;
      max-height: none;
      background: var(--term-surface, #0a0a0a);
    }

    .tip-dock .ptrack-modal {
      border-width: 1px 0 0;
    }
  }

  .tip-to {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .tip-address {
    flex: 1 1 260px;
    min-width: 0;
    color: var(--term-text, #f5f5f5);
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    word-break: break-all;
  }

  .tip-from {
    color: var(--term-text-body, #e8e8e8);
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }
</style>
