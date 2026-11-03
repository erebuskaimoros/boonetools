<script>
  import { tick } from 'svelte';
  import { walletAccounts, connectedWallets } from '../limit-orders/store.js';
  import { walletConnectEnabled } from '../limit-orders/wallet-config.js';
  import { shortAddr } from './format.js';

  export let open = false;

  // Lineup follows swap.thorchain.org and the Rujira UI; `thor` marks wallets
  // that can sign THORChain MsgDeposit (bond, LP RUNE side, TCY).
  const WALLETS = [
    { option: 'WALLETCONNECT', label: 'WalletConnect', thor: true, remote: true },
    { option: 'VULTISIG', label: 'Vultisig', thor: true },
    { option: 'KEPLR', label: 'Keplr', thor: true },
    { option: 'LEAP', label: 'Leap', thor: true },
    { option: 'COSMOSTATION', label: 'Cosmostation', thor: true },
    { option: 'CTRL', label: 'CTRL (XDEFI)', thor: true },
    { option: 'OKX', label: 'OKX', thor: false },
    { option: 'METAMASK', label: 'MetaMask', thor: false },
    { option: 'PHANTOM', label: 'Phantom', thor: false },
    { option: 'LEDGER', label: 'Ledger', thor: true, hardware: true },
    { option: 'KEYSTORE', label: 'Keystore', thor: true, hardware: true }
  ];
  const TRACKED_CHAINS = ['THOR', 'BTC', 'ETH', 'BSC', 'AVAX', 'BASE', 'LTC', 'BCH', 'DOGE', 'GAIA', 'XRP', 'SOL', 'TRON', 'ZEC'];
  const DEFAULT_CHAINS = ['THOR', 'BTC', 'ETH'];

  let walletModule = null;
  let walletLoading = false;
  let selected = null;
  let chains = [];
  let phrase = '';
  let connecting = false;
  let error = '';
  let notice = '';
  let pairing = false;
  let connectButton;

  $: if (open && !walletModule && !walletLoading) loadModule();
  $: if (open && walletModule && walletConnectEnabled()) walletModule.preloadWalletConnect();
  $: availableWallets = WALLETS.filter((wallet) => !wallet.remote || walletConnectEnabled());
  $: supported = selected && walletModule
    ? TRACKED_CHAINS.filter((chain) => (walletModule.supportedChains[selected.option] || []).includes(chain))
    : [];

  async function loadModule() {
    walletLoading = true;
    try {
      walletModule = await import('../limit-orders/wallet.js');
    } catch (loadError) {
      error = `Wallet support failed to load: ${loadError.message}`;
    }
  }

  function available(wallet, module) {
    return module ? module.isWalletAvailable(wallet.option) : false;
  }

  function choose(wallet) {
    selected = wallet;
    error = '';
    notice = '';
    phrase = '';
    const options = (walletModule?.supportedChains[wallet.option] || []).filter((chain) => TRACKED_CHAINS.includes(chain));
    chains = wallet.option === 'LEDGER'
      ? options.slice(0, 1)
      : options.filter((chain) => DEFAULT_CHAINS.includes(chain));
    if (!chains.length) chains = options.slice(0, 1);
  }

  function toggleChain(chain) {
    chains = chains.includes(chain) ? chains.filter((item) => item !== chain) : [...chains, chain];
  }

  async function connect() {
    if (!selected || !chains.length || !walletModule || connecting) return;
    const wallet = selected;
    const requestedChains = [...chains];
    connecting = true;
    error = '';
    notice = '';
    pairing = wallet.remote === true;
    // Let WalletConnect's QR dialog own focus and pointer input while pairing.
    if (pairing) await tick();
    try {
      const config = wallet.option === 'KEYSTORE' ? { phrase: phrase.trim().replace(/\s+/g, ' ') } : undefined;
      const accounts = await walletModule.connectWallet(wallet.option, requestedChains, config);
      if (!accounts.length) throw new Error('The wallet did not return any accounts. Unlock it and approve the connection.');
      const missing = requestedChains.filter((chain) => !accounts.some((account) => account.network === chain));
      if (missing.length) notice = `Connected. ${wallet.label} did not connect ${missing.join(', ')}.`;
      phrase = '';
      selected = null;
    } catch (connectError) {
      if (wallet.remote && walletModule.isWalletconnectDismissed(connectError)) {
        notice = 'Connection cancelled. You can try again.';
      } else {
        error = wallet.remote
          ? walletModule.describeWalletConnectError(connectError)
          : connectError?.message || String(connectError);
      }
    } finally {
      connecting = false;
      pairing = false;
      await tick();
      connectButton?.focus();
    }
  }

  function disconnect(option) {
    walletModule?.disconnectWallet(option);
    notice = '';
    error = '';
  }

  function close() {
    open = false;
    if (!walletModule) walletLoading = false;
    selected = null;
    phrase = '';
    error = '';
    notice = '';
  }

  function onKeydown(event) {
    if (open && !pairing && event.key === 'Escape') close();
  }

  $: grouped = $connectedWallets.map((provider) => ({
    provider,
    label: WALLETS.find((wallet) => wallet.option === provider)?.label || provider,
    accounts: $walletAccounts.filter((account) => account.provider === provider)
  }));
</script>

<svelte:window on:keydown={onKeydown} />

{#if open && !pairing}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="ptrack-modal-backdrop" on:click|self={close}>
    <div class="ptrack-modal" role="dialog" aria-modal="true" aria-label="Wallet">
      <div class="modal-head">
        <span><span class="prompt">$</span> wallet {selected ? `--connect ${selected.label.toLowerCase()}` : ''}</span>
        <button class="chip-x" aria-label="Close" on:click={close}>×</button>
      </div>

      {#if !selected}
        {#if grouped.length}
          <div class="modal-section">
            <h3 class="modal-label">connected</h3>
            {#each grouped as group (group.provider)}
              <div class="wallet-group">
                <div class="wallet-group-head">
                  <b>{group.label}</b>
                  <button class="row-btn" on:click={() => disconnect(group.provider)}>disconnect</button>
                </div>
                {#each group.accounts as account (account.network + account.address)}
                  <div class="wallet-account"><span class="chip-chain">{account.network}</span><span class="mono-dim" title={account.address}>{shortAddr(account.address, 10, 6)}</span></div>
                {/each}
              </div>
            {/each}
          </div>
        {/if}

        <div class="modal-section">
          <h3 class="modal-label">{grouped.length ? 'add a wallet' : 'choose a wallet'}</h3>
          <div class="wallet-grid">
            {#each availableWallets as wallet (wallet.option)}
              <button class="wallet-btn" disabled={!walletModule || connecting} class:unavailable={!available(wallet, walletModule)} on:click={() => choose(wallet)}>
                <b>{wallet.label}</b>
                <span class="wallet-sub">
                  {wallet.thor ? 'THOR' : 'L1 only'}
                  · {wallet.remote ? 'THORWallet / mobile' : wallet.hardware ? (wallet.option === 'LEDGER' ? 'usb' : 'phrase') : available(wallet, walletModule) ? 'detected' : 'not detected'}
                </span>
              </button>
            {/each}
          </div>
          <p class="hint">Bonding, the RUNE side of LP, and TCY staking need a wallet marked THOR. Asset-side LP deposits and TCY claims are signed by the wallet that holds that chain.</p>
        </div>
      {:else}
        <div class="modal-section">
          <h3 class="modal-label">chains</h3>
          <div class="chain-grid">
            {#each supported as chain}
              <label class="chain-opt" class:on={chains.includes(chain)}>
                <input type={selected.option === 'LEDGER' ? 'radio' : 'checkbox'} name="chains" checked={chains.includes(chain)}
                  on:change={() => (selected.option === 'LEDGER' ? (chains = [chain]) : toggleChain(chain))} />
                {chain}
              </label>
            {/each}
          </div>
          {#if selected.option === 'LEDGER'}
            <p class="hint">Open the matching app on your Ledger, then connect one chain at a time.</p>
          {/if}
          {#if selected.remote}
            <p class="hint">Scan the QR code with THORWallet or another WalletConnect wallet. On mobile, choose your wallet in the next window. Only chains approved by your wallet will connect.</p>
          {/if}
          {#if selected.option === 'KEYSTORE'}
            <h3 class="modal-label">recovery phrase</h3>
            <textarea class="phrase" bind:value={phrase} rows="3" spellcheck="false" autocomplete="off" placeholder="12 or 24 words, kept in memory for this tab only"></textarea>
            <p class="hint warn-text">Only use a phrase on a device you trust. It never leaves this browser tab.</p>
          {/if}
          {#if !available(selected, walletModule) && !selected.hardware && !selected.remote}
            <p class="hint warn-text">{selected.label} wasn't detected in this browser. Install or unlock the extension, then try again.</p>
          {/if}
          {#if error}<p class="hint err-text">{error}</p>{/if}
          <div class="modal-actions">
            <button class="bracket-btn" disabled={connecting} on:click={() => (selected = null)}>
              <span class="bracket">[</span><span class="key">←</span><span class="bracket">]</span> back
            </button>
            <button bind:this={connectButton} class="bracket-btn primary" disabled={connecting || !walletModule || !chains.length || (selected.option === 'KEYSTORE' && phrase.trim().split(/\s+/).length < 12)} on:click={connect}>
              <span class="bracket">[</span><span class="key">↵</span><span class="bracket">]</span> {connecting ? 'connecting…' : `connect ${chains.length} chain${chains.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      {/if}
      {#if error && !selected}<p class="hint err-text">{error}</p>{/if}
      {#if notice}<p class="hint warn-text" role="status">{notice}</p>{/if}
    </div>
  </div>
{/if}
