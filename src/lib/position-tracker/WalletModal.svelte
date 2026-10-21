<script>
  import { walletAccounts, connectedWallets } from '../limit-orders/store.js';
  import { shortAddr } from './format.js';

  export let open = false;

  // Lineup follows swap.thorchain.org and the Rujira UI; `thor` marks wallets
  // that can sign THORChain MsgDeposit (bond, LP RUNE side, TCY).
  const WALLETS = [
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
  let selected = null;
  let chains = [];
  let phrase = '';
  let connecting = false;
  let error = '';

  $: if (open && !walletModule) loadModule();
  $: supported = selected && walletModule
    ? TRACKED_CHAINS.filter((chain) => (walletModule.supportedChains[selected.option] || []).includes(chain))
    : [];

  async function loadModule() {
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
    if (!selected || !chains.length) return;
    connecting = true;
    error = '';
    try {
      const config = selected.option === 'KEYSTORE' ? { phrase: phrase.trim().replace(/\s+/g, ' ') } : undefined;
      const accounts = await walletModule.connectWallet(selected.option, chains, config);
      if (!accounts.length) throw new Error('The wallet did not return any accounts. Unlock it and approve the connection.');
      phrase = '';
      selected = null;
    } catch (connectError) {
      error = connectError?.message || String(connectError);
    } finally {
      connecting = false;
    }
  }

  function disconnect(option) {
    walletModule?.disconnectWallet(option);
  }

  function close() {
    open = false;
    selected = null;
    phrase = '';
    error = '';
  }

  function onKeydown(event) {
    if (open && event.key === 'Escape') close();
  }

  $: grouped = $connectedWallets.map((provider) => ({
    provider,
    label: WALLETS.find((wallet) => wallet.option === provider)?.label || provider,
    accounts: $walletAccounts.filter((account) => account.provider === provider)
  }));
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
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
            {#each WALLETS as wallet (wallet.option)}
              <button class="wallet-btn" class:unavailable={!available(wallet, walletModule)} on:click={() => choose(wallet)}>
                <b>{wallet.label}</b>
                <span class="wallet-sub">
                  {wallet.thor ? 'THOR' : 'L1 only'}
                  · {wallet.hardware ? (wallet.option === 'LEDGER' ? 'usb' : 'phrase') : available(wallet, walletModule) ? 'detected' : 'not detected'}
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
          {#if selected.option === 'KEYSTORE'}
            <h3 class="modal-label">recovery phrase</h3>
            <textarea class="phrase" bind:value={phrase} rows="3" spellcheck="false" autocomplete="off" placeholder="12 or 24 words, kept in memory for this tab only"></textarea>
            <p class="hint warn-text">Only use a phrase on a device you trust. It never leaves this browser tab.</p>
          {/if}
          {#if !available(selected, walletModule) && !selected.hardware}
            <p class="hint warn-text">{selected.label} wasn't detected in this browser. Install or unlock the extension, then try again.</p>
          {/if}
          {#if error}<p class="hint err-text">{error}</p>{/if}
          <div class="modal-actions">
            <button class="bracket-btn" on:click={() => (selected = null)}>
              <span class="bracket">[</span><span class="key">←</span><span class="bracket">]</span> back
            </button>
            <button class="bracket-btn primary" disabled={connecting || !chains.length || (selected.option === 'KEYSTORE' && phrase.trim().split(/\s+/).length < 12)} on:click={connect}>
              <span class="bracket">[</span><span class="key">↵</span><span class="bracket">]</span> {connecting ? 'connecting…' : `connect ${chains.length} chain${chains.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      {/if}
      {#if error && !selected}<p class="hint err-text">{error}</p>{/if}
    </div>
  </div>
{/if}
