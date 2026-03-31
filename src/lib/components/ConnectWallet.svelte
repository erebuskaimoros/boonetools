<script>
  import { createEventDispatcher } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { thornode } from '../api/thornode.js';
  import {
    walletAccounts,
    connectedWallets,
    selectedAccount,
    chainAssignments,
    tradeOwner,
    getAccountsForChain,
    getAssignedAccount,
    getTradeOwnerAccount,
    setSelectedAccount,
    setChainAssignment,
    setTradeOwnerAccount
  } from '../limit-orders/store.js';
  import { getChainFromAsset } from '../utils/blockchain.js';

  export let open = false;

  const dispatch = createEventDispatcher();

  let walletMod = null;
  let walletReady = false;
  let view = 'manage';
  let activeTab = 'l1';

  const wallets = [
    { key: 'metamask', option: 'METAMASK', label: 'MetaMask', type: 'browser' },
    { key: 'vultisig', option: 'VULTISIG', label: 'Vultisig', type: 'browser' },
    { key: 'phantom', option: 'PHANTOM', label: 'Phantom', type: 'browser' },
    { key: 'ctrl', option: 'CTRL', label: 'CTRL (XDEFI)', type: 'browser' },
    { key: 'keplr', option: 'KEPLR', label: 'Keplr', type: 'browser' },
    { key: 'okx', option: 'OKX', label: 'OKX', type: 'browser' },
    { key: 'ledger', option: 'LEDGER', label: 'Ledger', type: 'hardware' },
    { key: 'keystore', option: 'KEYSTORE', label: 'Keystore', type: 'hardware' },
  ];

  const walletMeta = wallets.reduce((acc, wallet) => {
    acc[wallet.option] = wallet;
    return acc;
  }, {});

  let selectedWallet = null;
  let selectedWalletChains = [];
  let connecting = false;
  let connectError = '';

  let refreshingL1Balances = false;
  let refreshingTradeBalances = false;
  let l1BalanceError = '';
  let tradeBalanceError = '';
  let l1BalanceGroups = [];
  let tradeBalances = [];

  let selectedL1Key = '';
  let selectedTradeAsset = '';

  let depositAmount = '';
  let depositError = '';
  let depositSuccess = '';
  let depositing = false;

  let withdrawAmount = '';
  let withdrawDestination = '';
  let lastAutoWithdrawDestination = '';
  let lastWithdrawChain = '';
  let withdrawError = '';
  let withdrawSuccess = '';
  let withdrawing = false;

  let lastRefreshKey = '';

  function close() {
    open = false;
    view = 'manage';
    selectedWallet = null;
    selectedWalletChains = [];
    connecting = false;
    connectError = '';
    lastRefreshKey = '';
    dispatch('close');
  }

  function openConnectFlow() {
    view = 'connect';
    selectedWallet = null;
    selectedWalletChains = [];
    connecting = false;
    connectError = '';
  }

  function backToManage() {
    view = 'manage';
    selectedWallet = null;
    selectedWalletChains = [];
    connecting = false;
    connectError = '';
  }

  function handleBackdropClick(event) {
    if (event.target === event.currentTarget) close();
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') close();
  }

  function handleBackdropKeydown(event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      close();
    }
  }

  function trimAddress(address) {
    if (!address) return '';
    return `${address.slice(0, 8)}...${address.slice(-6)}`;
  }

  function accountValue(account) {
    return account ? `${account.provider}:${account.network}:${account.address}` : '';
  }

  function findAccountByValue(accounts, value) {
    return (Array.isArray(accounts) ? accounts : []).find((account) => accountValue(account) === value) || null;
  }

  function formatExactAmount(value, decimals = 8) {
    const normalized = String(value ?? '').trim();
    if (!normalized) return '0';

    const negative = normalized.startsWith('-');
    const unsigned = negative ? normalized.slice(1) : normalized;

    if (!/^\d+$/.test(unsigned)) {
      return normalized;
    }

    const padded = unsigned.padStart(decimals + 1, '0');
    const whole = padded.slice(0, -decimals) || '0';
    const fraction = padded.slice(-decimals).replace(/0+$/, '');
    const result = fraction ? `${whole}.${fraction}` : whole;
    return negative ? `-${result}` : result;
  }

  function formatAmount(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return String(value ?? '0');
    }
    if (numeric === 0) return '0';
    if (numeric >= 1000) {
      return numeric.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    if (numeric >= 1) {
      return numeric.toLocaleString(undefined, { maximumFractionDigits: 4 });
    }
    return numeric.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }

  function parsePositiveAmount(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
  }

  function sortBalanceRows(left, right) {
    if (left.depositable !== right.depositable) {
      return left.depositable ? -1 : 1;
    }

    const leftValue = parsePositiveAmount(left.amountExact);
    const rightValue = parsePositiveAmount(right.amountExact);
    if (leftValue !== rightValue) {
      return rightValue - leftValue;
    }

    return left.ticker.localeCompare(right.ticker);
  }

  function mapBalanceRow(account, balance) {
    const chain = account.network;
    const identifier = balance.toString({ includeSynthProtocol: true });
    const amountExact = balance.getValue('string');
    const ticker = String(balance.ticker || balance.symbol || identifier).replace(/-.*$/, '').toUpperCase();
    const depositable = !balance.isSynthetic && !balance.isTradeAsset && chain !== 'THOR' && identifier.toUpperCase() !== 'THOR.RUNE';

    return {
      key: `${account.provider}:${account.address}:${identifier}`,
      provider: account.provider,
      address: account.address,
      chain,
      ticker,
      identifier,
      displayIdentifier: identifier.toUpperCase(),
      amountExact,
      amountDisplay: formatAmount(amountExact),
      depositable,
      sourceAccount: account
    };
  }

  function mapTradeBalance(entry) {
    const amountExact = formatExactAmount(entry.units, 8);
    return {
      asset: String(entry.asset || ''),
      displayAsset: String(entry.asset || '').toUpperCase(),
      amountExact,
      amountDisplay: formatAmount(amountExact),
      chain: getChainFromAsset(entry.asset).toUpperCase(),
      owner: entry.owner || '',
      lastAddHeight: Number(entry.last_add_height || 0),
      lastWithdrawHeight: Number(entry.last_withdraw_height || 0),
      rawUnits: String(entry.units || '0')
    };
  }

  function getWalletLabel(option) {
    return walletMeta[option]?.label || option;
  }

  function getWalletIcon(option) {
    const key = walletMeta[option]?.key;
    return key ? `assets/wallets/${key}.svg` : 'assets/wallets/metamask.svg';
  }

  function resetDepositState() {
    depositAmount = '';
    depositError = '';
    depositSuccess = '';
  }

  function resetWithdrawState() {
    withdrawAmount = '';
    withdrawError = '';
    withdrawSuccess = '';
  }

  function getAssignedChainAccount(chain) {
    return getAssignedAccount($walletAccounts, $chainAssignments, chain);
  }

  function getSelectedTradeOwner() {
    return getTradeOwnerAccount($walletAccounts, $tradeOwner);
  }

  function getAutoWithdrawDestination(asset) {
    const chain = getChainFromAsset(asset).toUpperCase();
    return getAssignedChainAccount(chain)?.address || '';
  }

  async function refreshL1Balances() {
    if (!walletReady || $walletAccounts.length === 0) {
      l1BalanceGroups = [];
      l1BalanceError = '';
      return;
    }

    refreshingL1Balances = true;
    l1BalanceError = '';

    try {
      const groups = await Promise.all(($walletAccounts || []).map(async (account) => {
        try {
          const balances = await walletMod.getProviderChainBalance(account.provider, account.network, true);
          const rows = (balances || [])
            .filter((balance) => parsePositiveAmount(balance?.getValue?.('string')) > 0)
            .map((balance) => mapBalanceRow(account, balance))
            .sort(sortBalanceRows);

          return {
            key: accountValue(account),
            account,
            balances: rows,
            chain: account.network,
            provider: account.provider,
            error: ''
          };
        } catch (error) {
          return {
            key: accountValue(account),
            account,
            balances: [],
            chain: account.network,
            provider: account.provider,
            error: error.message || `Failed to load ${account.network} balances`
          };
        }
      }));

      const nextGroups = groups.sort((left, right) => {
        const chainCompare = left.chain.localeCompare(right.chain);
        return chainCompare !== 0 ? chainCompare : left.provider.localeCompare(right.provider);
      });
      const nextRows = nextGroups.flatMap((group) => group.balances);

      l1BalanceGroups = nextGroups;

      if (!nextRows.find((row) => row.key === selectedL1Key)) {
        const nextSelection = nextRows.find((row) => row.depositable) || nextRows[0];
        selectedL1Key = nextSelection?.key || '';
        resetDepositState();
      }
    } catch (error) {
      l1BalanceGroups = [];
      l1BalanceError = error.message || 'Failed to load wallet balances';
    }

    refreshingL1Balances = false;
  }

  async function refreshTradeBalances() {
    if (!tradeOwnerAddress) {
      tradeBalances = [];
      tradeBalanceError = '';
      selectedTradeAsset = '';
      return;
    }

    refreshingTradeBalances = true;
    tradeBalanceError = '';

    try {
      const response = await thornode.getTradeAccount(tradeOwnerAddress);
      const nextTradeBalances = (Array.isArray(response) ? response : [])
        .map(mapTradeBalance)
        .sort((left, right) => parsePositiveAmount(right.amountExact) - parsePositiveAmount(left.amountExact));

      tradeBalances = nextTradeBalances;

      if (!nextTradeBalances.find((entry) => entry.asset === selectedTradeAsset)) {
        selectedTradeAsset = nextTradeBalances[0]?.asset || '';
        resetWithdrawState();
      }
    } catch (error) {
      tradeBalances = [];
      tradeBalanceError = error.message || 'Failed to load trade balances';
    }

    refreshingTradeBalances = false;
  }

  async function refreshModalData() {
    await Promise.all([
      refreshL1Balances(),
      refreshTradeBalances()
    ]);
  }

  function pickWallet(wallet) {
    selectedWallet = wallet;
    connectError = '';
    selectedWalletChains = [];
  }

  function toggleChain(chain) {
    if (selectedWalletChains.includes(chain)) {
      selectedWalletChains = selectedWalletChains.filter((entry) => entry !== chain);
    } else {
      selectedWalletChains = [...selectedWalletChains, chain];
    }
  }

  async function handleConnect() {
    if (!selectedWallet || selectedWalletChains.length === 0 || !walletMod) return;

    connecting = true;
    connectError = '';

    try {
      const accounts = await walletMod.connectWallet(selectedWallet.option, selectedWalletChains);
      if (accounts.length > 0) {
        if (!$selectedAccount) {
          setSelectedAccount(accounts[0]);
        }
        dispatch('connected', { accounts });
        backToManage();
        lastRefreshKey = '';
        await refreshModalData();
      } else {
        connectError = 'No accounts returned. Is the wallet unlocked?';
      }
    } catch (error) {
      connectError = error.message || 'Connection failed';
    }

    connecting = false;
  }

  async function handleDisconnect(walletOption) {
    if (!walletMod) return;

    walletMod.disconnectWallet(walletOption);
    lastRefreshKey = '';
    await refreshModalData();
  }

  function handleChainAssignmentChange(chain, value) {
    const account = findAccountByValue(getAccountsForChain($walletAccounts, chain), value);
    if (account) {
      setChainAssignment(chain, account, 'manual');
    }
  }

  function handleTradeOwnerChange(value) {
    const account = findAccountByValue(getAccountsForChain($walletAccounts, 'THOR'), value);
    if (account) {
      setTradeOwnerAccount(account, 'manual');
    }
  }

  function selectL1Asset(row) {
    selectedL1Key = row.key;
    resetDepositState();
  }

  function selectTradeAsset(row) {
    selectedTradeAsset = row.asset;
    resetWithdrawState();
  }

  function useMaxDeposit() {
    if (selectedL1Asset) {
      depositAmount = selectedL1Asset.amountExact;
    }
  }

  function useMaxWithdraw() {
    if (selectedTradeBalance) {
      withdrawAmount = selectedTradeBalance.amountExact;
    }
  }

  async function handleDepositToTrade() {
    depositError = '';
    depositSuccess = '';

    if (!selectedL1Asset) {
      depositError = 'Select an L1 asset first';
      return;
    }

    if (!selectedL1Asset.depositable) {
      depositError = 'This asset cannot be deposited into a trade account';
      return;
    }

    if (!tradeOwnerAccount?.address) {
      depositError = 'Assign a THOR trade owner first';
      return;
    }

    const sourceAccount = getAssignedChainAccount(selectedL1Asset.chain);
    if (!sourceAccount?.provider) {
      depositError = `Assign a ${selectedL1Asset.chain} source wallet first`;
      return;
    }

    if (sourceAccount.provider !== selectedL1Asset.provider || sourceAccount.address !== selectedL1Asset.address) {
      depositError = `Deposit uses the assigned ${selectedL1Asset.chain} wallet. Select a balance from that wallet or reassign the chain slot.`;
      return;
    }

    const requestedAmount = parsePositiveAmount(depositAmount);
    const availableAmount = parsePositiveAmount(selectedL1Asset.amountExact);
    if (!requestedAmount) {
      depositError = 'Enter a valid amount';
      return;
    }

    if (requestedAmount > availableAmount) {
      depositError = 'Amount exceeds available balance';
      return;
    }

    depositing = true;

    try {
      const txHash = await walletMod.broadcastTradeAccountDeposit({
        amount: depositAmount,
        asset: selectedL1Asset.identifier,
        owner: tradeOwnerAccount.address
      }, {
        provider: sourceAccount.provider
      });

      depositSuccess = `Deposit submitted: ${txHash.slice(0, 12)}...`;
      depositAmount = '';
      dispatch('connected');
      setTimeout(() => {
        lastRefreshKey = '';
        refreshModalData();
      }, 6000);
    } catch (error) {
      depositError = error.message || 'Trade deposit failed';
    }

    depositing = false;
  }

  async function handleWithdrawFromTrade() {
    withdrawError = '';
    withdrawSuccess = '';

    if (!selectedTradeBalance) {
      withdrawError = 'Select a trade asset first';
      return;
    }

    if (!tradeOwnerAccount?.provider) {
      withdrawError = 'Assign a THOR trade owner to withdraw trade assets';
      return;
    }

    const requestedAmount = parsePositiveAmount(withdrawAmount);
    const availableAmount = parsePositiveAmount(selectedTradeBalance.amountExact);
    if (!requestedAmount) {
      withdrawError = 'Enter a valid amount';
      return;
    }

    if (requestedAmount > availableAmount) {
      withdrawError = 'Amount exceeds available trade balance';
      return;
    }

    const destination = withdrawDestination.trim();
    if (!destination) {
      withdrawError = `Enter a ${selectedTradeBalance.chain} destination address`;
      return;
    }

    withdrawing = true;

    try {
      const txHash = await walletMod.broadcastTradeAccountWithdrawal({
        amount: withdrawAmount,
        asset: selectedTradeBalance.asset,
        destinationAddress: destination
      }, {
        provider: tradeOwnerAccount.provider
      });

      withdrawSuccess = `Withdrawal submitted: ${txHash.slice(0, 12)}...`;
      withdrawAmount = '';
      dispatch('connected');
      setTimeout(() => {
        lastRefreshKey = '';
        refreshModalData();
      }, 6000);
    } catch (error) {
      withdrawError = error.message || 'Trade withdrawal failed';
    }

    withdrawing = false;
  }

  $: if (open && !walletMod) {
    import('../limit-orders/wallet.js').then((mod) => {
      walletMod = mod;
      walletReady = true;
      lastRefreshKey = '';
      refreshModalData();
    }).catch((error) => {
      connectError = error.message || 'Failed to load wallet module';
    });
  }

  $: refreshKey = open
    ? [
        view,
        activeTab,
        walletReady ? 'ready' : 'loading',
        tradeOwnerAddress,
        JSON.stringify($chainAssignments || {}),
        $walletAccounts
          .map((account) => `${account.provider}:${account.network}:${account.address}`)
          .sort()
          .join('|')
      ].join('|')
    : '';

  $: if (open && view === 'manage' && walletReady && refreshKey && refreshKey !== lastRefreshKey) {
    lastRefreshKey = refreshKey;
    refreshModalData();
  }

  $: connectedSet = new Set($connectedWallets);
  $: installedWallets = walletMod
    ? wallets.filter((wallet) => walletMod.isWalletAvailable(wallet.option) || connectedSet.has(wallet.option))
    : [];
  $: otherWallets = wallets.filter((wallet) => !installedWallets.find((entry) => entry.option === wallet.option));
  $: accountsByProvider = ($walletAccounts || []).reduce((acc, account) => {
    if (!acc[account.provider]) acc[account.provider] = [];
    acc[account.provider].push(account);
    return acc;
  }, {});
  $: providerEntries = Object.entries(accountsByProvider).sort(([left], [right]) => left.localeCompare(right));
  $: chainRoutingEntries = Array.from(new Set(($walletAccounts || []).map((account) => account.network)))
    .sort()
    .map((chain) => ({
      chain,
      assigned: getAssignedChainAccount(chain),
      candidates: getAccountsForChain($walletAccounts, chain)
    }));
  $: tradeOwnerCandidates = getAccountsForChain($walletAccounts, 'THOR');
  $: tradeOwnerAccount = getSelectedTradeOwner();
  $: tradeOwnerAddress = tradeOwnerAccount?.address || '';
  $: l1BalanceRows = l1BalanceGroups.flatMap((group) => group.balances);
  $: selectedL1Asset = l1BalanceRows.find((row) => row.key === selectedL1Key) || null;
  $: selectedTradeBalance = tradeBalances.find((entry) => entry.asset === selectedTradeAsset) || null;

  $: {
    const nextWithdrawChain = selectedTradeBalance?.chain || '';
    const nextAutoDestination = selectedTradeBalance ? getAutoWithdrawDestination(selectedTradeBalance.asset) : '';
    const chainChanged = nextWithdrawChain !== lastWithdrawChain;
    const shouldReplaceDestination =
      chainChanged ||
      !withdrawDestination ||
      withdrawDestination === lastAutoWithdrawDestination;

    if (shouldReplaceDestination) {
      withdrawDestination = nextAutoDestination;
    }

    lastAutoWithdrawDestination = nextAutoDestination;
    lastWithdrawChain = nextWithdrawChain;
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open}
  <div
    class="cw-backdrop"
    role="button"
    tabindex="0"
    aria-label="Close wallet manager"
    on:click={handleBackdropClick}
    on:keydown={handleBackdropKeydown}
    transition:fade={{ duration: 150 }}
  >
    <div class="cw-dialog" transition:fly={{ y: 20, duration: 200 }}>
      <div class="cw-header">
        <div class="cw-header-copy">
          <h3>
            {#if view === 'connect' && selectedWallet}
              <button class="cw-back" type="button" aria-label="Back" on:click={() => { selectedWallet = null; connectError = ''; }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
              </button>
            {:else if view === 'connect'}
              <button class="cw-back" type="button" aria-label="Back" on:click={backToManage}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
              </button>
            {/if}
            {view === 'connect'
              ? (selectedWallet ? selectedWallet.label : 'Add Wallet')
              : 'Wallets & Trade Assets'}
          </h3>
          {#if view === 'manage'}
            <p class="cw-subtitle">Manage connected wallets, L1 balances, and THOR trade-account assets.</p>
          {/if}
        </div>

        <div class="cw-header-actions">
          {#if view === 'manage'}
            <button class="cw-refresh" type="button" aria-label="Refresh balances" on:click={refreshModalData} title="Refresh balances">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="23 4 23 10 17 10"></polyline>
                <polyline points="1 20 1 14 7 14"></polyline>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
              </svg>
            </button>
            <button class="cw-add-wallet" type="button" on:click={openConnectFlow}>Add Wallet</button>
          {/if}
          <button class="cw-close" type="button" aria-label="Close" on:click={close}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </div>

      {#if view === 'connect'}
        {#if !selectedWallet}
          <div class="cw-list">
            {#if installedWallets.length > 0}
              <div class="cw-group-label">Detected</div>
              {#each installedWallets as wallet}
                {#if connectedSet.has(wallet.option)}
                  <div class="cw-wallet-item connected">
                    <img src="assets/wallets/{wallet.key}.svg" alt={wallet.label} class="cw-wallet-icon" />
                    <span class="cw-wallet-name">{wallet.label}</span>
                    <span class="cw-badge connected-badge">Connected</span>
                    <button class="cw-disconnect-btn" type="button" on:click={() => handleDisconnect(wallet.option)}>
                      Disconnect
                    </button>
                  </div>
                {:else}
                  <button class="cw-wallet-item" type="button" on:click={() => pickWallet(wallet)}>
                    <img src="assets/wallets/{wallet.key}.svg" alt={wallet.label} class="cw-wallet-icon" />
                    <span class="cw-wallet-name">{wallet.label}</span>
                    <span class="cw-badge chain-count">{((walletMod?.supportedChains || {})[wallet.option] || []).length} chains</span>
                  </button>
                {/if}
              {/each}
            {/if}

            {#if otherWallets.length > 0}
              <div class="cw-group-label">Other Wallets</div>
              {#each otherWallets as wallet}
                <button class="cw-wallet-item unavailable" type="button" on:click={() => pickWallet(wallet)}>
                  <img src="assets/wallets/{wallet.key}.svg" alt={wallet.label} class="cw-wallet-icon" />
                  <span class="cw-wallet-name">{wallet.label}</span>
                  <span class="cw-badge">{wallet.type === 'hardware' ? 'Hardware' : 'Not detected'}</span>
                </button>
              {/each}
            {/if}
          </div>
        {:else}
          <div class="cw-chain-select">
            <div class="cw-chain-header">
              <span>Approve Chains</span>
              <button class="cw-select-all" type="button" on:click={() => {
                const all = (walletMod?.supportedChains || {})[selectedWallet.option] || [];
                selectedWalletChains = selectedWalletChains.length === all.length ? [] : [...all];
              }}>
                {selectedWalletChains.length === ((walletMod?.supportedChains || {})[selectedWallet.option] || []).length ? 'Deselect All' : 'Select All'}
              </button>
            </div>

            <div class="cw-note cw-note--connect">
              Choose the chains you want this wallet to expose. Multichain wallets only connect the chains you explicitly approve here.
            </div>

            <div class="cw-chains-grid">
              {#each ((walletMod?.supportedChains || {})[selectedWallet.option] || []) as chain}
                <button class="cw-chain-item" type="button" class:selected={selectedWalletChains.includes(chain)} on:click={() => toggleChain(chain)}>
                  <span class="cw-chain-name">{chain}</span>
                  {#if selectedWalletChains.includes(chain)}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00cc66" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  {/if}
                </button>
              {/each}
            </div>

            {#if connectError}
              <div class="cw-error">{connectError}</div>
            {/if}

            <button class="cw-connect-btn" type="button" on:click={handleConnect} disabled={connecting || selectedWalletChains.length === 0}>
              {#if connecting}
                <div class="cw-spinner"></div>
                Connecting...
              {:else}
                Connect {selectedWallet.label}
              {/if}
            </button>
          </div>
        {/if}
      {:else}
        <div class="cw-manage">
          <div class="cw-wallets">
            <div class="cw-section-head">
              <span>Connected Wallets</span>
              {#if tradeOwnerAddress}
                <span class="cw-owner">Trade owner {trimAddress(tradeOwnerAddress)}</span>
              {/if}
            </div>

            {#if providerEntries.length === 0}
              <div class="cw-empty-state">
                <div class="cw-empty-title">No wallets connected</div>
                <div class="cw-empty-copy">Connect at least one wallet, and add a THOR wallet if you want to manage trade assets directly.</div>
                <button class="cw-primary-btn" type="button" on:click={openConnectFlow}>Connect Wallet</button>
              </div>
            {:else}
              <div class="cw-provider-grid">
                {#each providerEntries as [provider, accounts]}
                  <div class="cw-provider-card">
                    <div class="cw-provider-head">
                      <div class="cw-provider-meta">
                        <img src={getWalletIcon(provider)} alt={getWalletLabel(provider)} class="cw-provider-icon" />
                        <div>
                          <div class="cw-provider-name">{getWalletLabel(provider)}</div>
                          <div class="cw-provider-count">{accounts.length} chain{accounts.length === 1 ? '' : 's'}</div>
                        </div>
                      </div>
                      <button class="cw-provider-disconnect" on:click={() => handleDisconnect(provider)}>Disconnect</button>
                    </div>

                    <div class="cw-account-list">
                      {#each accounts as account}
                        <button
                          class="cw-account-chip"
                          type="button"
                          class:selected={$selectedAccount?.address === account.address && $selectedAccount?.network === account.network}
                          on:click={() => setSelectedAccount(account)}
                        >
                          <span class="cw-account-network">{account.network}</span>
                          <span class="cw-account-address mono">{trimAddress(account.address)}</span>
                        </button>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>

              <div class="cw-routing-grid">
                <div class="cw-routing-card">
                  <div class="cw-card-head">
                    <span>Trade Owner</span>
                  </div>

                  {#if tradeOwnerCandidates.length === 0}
                    <div class="cw-empty-copy">Connect a THOR wallet to manage trade assets and sign trade-account actions.</div>
                  {:else}
                    <label class="cw-label">
                      THOR Account
                      <select class="cw-select" value={accountValue(tradeOwnerAccount)} on:change={(event) => handleTradeOwnerChange(event.currentTarget.value)}>
                        {#if !tradeOwnerAccount}
                          <option value="">Select THOR owner…</option>
                        {/if}
                        {#each tradeOwnerCandidates as account}
                          <option value={accountValue(account)}>
                            {getWalletLabel(account.provider)} · {trimAddress(account.address)}
                          </option>
                        {/each}
                      </select>
                    </label>
                  {/if}
                </div>

                <div class="cw-routing-card">
                  <div class="cw-card-head">
                    <span>Chain Routing</span>
                  </div>

                  {#if chainRoutingEntries.length === 0}
                    <div class="cw-empty-copy">Connect wallets to assign source wallets by chain.</div>
                  {:else}
                    <div class="cw-routing-list">
                      {#each chainRoutingEntries as entry}
                        <label class="cw-label cw-label--compact">
                          <span class="cw-routing-chain">{entry.chain}</span>
                          <select class="cw-select" value={accountValue(entry.assigned)} on:change={(event) => handleChainAssignmentChange(entry.chain, event.currentTarget.value)}>
                            {#if !entry.assigned}
                              <option value="">Select {entry.chain} wallet…</option>
                            {/if}
                            {#each entry.candidates as account}
                              <option value={accountValue(account)}>
                                {getWalletLabel(account.provider)} · {trimAddress(account.address)}
                              </option>
                            {/each}
                          </select>
                        </label>
                      {/each}
                    </div>
                  {/if}
                </div>
              </div>
            {/if}
          </div>

          <div class="cw-tabs">
            <button class="cw-tab" type="button" class:active={activeTab === 'l1'} on:click={() => activeTab = 'l1'}>L1 Assets</button>
            <button class="cw-tab" type="button" class:active={activeTab === 'trade'} on:click={() => activeTab = 'trade'}>Trade Assets</button>
          </div>

          {#if activeTab === 'l1'}
            <div class="cw-tab-panel">
              <div class="cw-panel-grid">
                <div class="cw-panel-card">
                  <div class="cw-card-head">
                    <span>L1 Wallet Balances</span>
                    {#if refreshingL1Balances}
                      <span class="cw-inline-status">Refreshing…</span>
                    {/if}
                  </div>

                  {#if l1BalanceError}
                    <div class="cw-error">{l1BalanceError}</div>
                  {/if}

                  {#if !$walletAccounts.length}
                    <div class="cw-empty-copy">Connect a wallet to load balances.</div>
                  {:else if refreshingL1Balances && l1BalanceRows.length === 0}
                    <div class="cw-loading-row"><div class="cw-spinner"></div></div>
                  {:else if l1BalanceRows.length === 0}
                    <div class="cw-empty-copy">No non-zero balances found on connected chains.</div>
                  {:else}
                    <div class="cw-balance-groups">
                      {#each l1BalanceGroups as group}
                        <div class="cw-balance-group">
                          <div class="cw-balance-group-head">
                            <span>{group.chain} · {getWalletLabel(group.provider)}</span>
                            <span class="mono">{trimAddress(group.account?.address || '')}</span>
                          </div>

                          {#if group.error}
                            <div class="cw-empty-copy">{group.error}</div>
                          {:else if group.balances.length === 0}
                            <div class="cw-empty-copy">No non-zero balances</div>
                          {:else}
                            {#each group.balances as row}
                              <button class="cw-asset-row" type="button" class:selected={selectedL1Key === row.key} on:click={() => selectL1Asset(row)}>
                                <div class="cw-asset-main">
                                  <span class="cw-asset-ticker">{row.ticker}</span>
                                  <span class="cw-asset-id">{row.displayIdentifier}</span>
                                </div>
                                <div class="cw-asset-side">
                                  <span class="cw-asset-amount">{row.amountDisplay}</span>
                                  {#if getAssignedChainAccount(row.chain)?.provider === row.provider && getAssignedChainAccount(row.chain)?.address === row.address}
                                    <span class="cw-asset-tag">Assigned</span>
                                  {/if}
                                  <span class="cw-asset-tag" class:cw-asset-tag--disabled={!row.depositable}>
                                    {row.depositable ? 'Deposit ready' : 'Not depositable'}
                                  </span>
                                </div>
                              </button>
                            {/each}
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>

                <div class="cw-panel-card">
                  <div class="cw-card-head">
                    <span>Deposit To Trade</span>
                  </div>

                  {#if !selectedL1Asset}
                    <div class="cw-empty-copy">Select an L1 asset balance to deposit into your THOR trade account.</div>
                  {:else}
                    <div class="cw-action-summary">
                      <div class="cw-action-row">
                        <span>Asset</span>
                        <span>{selectedL1Asset.displayIdentifier}</span>
                      </div>
                      <div class="cw-action-row">
                        <span>Available</span>
                        <span>{selectedL1Asset.amountDisplay} {selectedL1Asset.ticker}</span>
                      </div>
                      <div class="cw-action-row">
                        <span>Trade Owner</span>
                        <span class="mono">{tradeOwnerAddress ? trimAddress(tradeOwnerAddress) : 'Connect THOR wallet'}</span>
                      </div>
                      <div class="cw-action-row">
                        <span>Source Wallet</span>
                        <span class="mono">
                          {#if selectedL1Asset && getAssignedChainAccount(selectedL1Asset.chain)}
                            {getWalletLabel(getAssignedChainAccount(selectedL1Asset.chain).provider)} · {trimAddress(getAssignedChainAccount(selectedL1Asset.chain).address)}
                          {:else if selectedL1Asset}
                            Assign a {selectedL1Asset.chain} wallet
                          {:else}
                            --
                          {/if}
                        </span>
                      </div>
                    </div>

                    {#if !selectedL1Asset.depositable}
                      <div class="cw-note">This asset cannot be deposited to a trade account. Trade deposits are for external L1 assets, not THOR.RUNE or THOR-hosted assets.</div>
                    {:else}
                      <label class="cw-label">
                        Amount
                        <div class="cw-input-row">
                          <input bind:value={depositAmount} class="cw-input" placeholder={`0.0 ${selectedL1Asset.ticker}`} />
                          <button class="cw-inline-btn" type="button" on:click={useMaxDeposit}>Max</button>
                        </div>
                      </label>

                      <button class="cw-primary-btn" type="button" on:click={handleDepositToTrade} disabled={depositing || !tradeOwnerAddress || !depositAmount}>
                        {#if depositing}
                          <div class="cw-spinner cw-spinner--tiny"></div>
                          Depositing…
                        {:else}
                          Deposit To Trade
                        {/if}
                      </button>
                    {/if}
                  {/if}

                  {#if depositError}
                    <div class="cw-error">{depositError}</div>
                  {/if}
                  {#if depositSuccess}
                    <div class="cw-success">{depositSuccess}</div>
                  {/if}
                  <div class="cw-note">Limit-order submits can still auto-fund from L1 via the SDK. This panel is for manual prefunding.</div>
                </div>
              </div>
            </div>
          {:else}
            <div class="cw-tab-panel">
              <div class="cw-panel-grid">
                <div class="cw-panel-card">
                  <div class="cw-card-head">
                    <span>Trade Account Balances</span>
                    {#if refreshingTradeBalances}
                      <span class="cw-inline-status">Refreshing…</span>
                    {/if}
                  </div>

                  {#if !tradeOwnerAddress}
                    <div class="cw-empty-state cw-empty-state--compact">
                      <div class="cw-empty-title">No THOR owner connected</div>
                      <div class="cw-empty-copy">Connect a THOR wallet to inspect and manage trade assets.</div>
                    </div>
                  {:else if tradeBalanceError}
                    <div class="cw-error">{tradeBalanceError}</div>
                  {:else if refreshingTradeBalances && tradeBalances.length === 0}
                    <div class="cw-loading-row"><div class="cw-spinner"></div></div>
                  {:else if tradeBalances.length === 0}
                    <div class="cw-empty-copy">No trade balances for {trimAddress(tradeOwnerAddress)}.</div>
                  {:else}
                    <div class="cw-balance-groups">
                      {#each tradeBalances as row}
                        <button class="cw-asset-row" type="button" class:selected={selectedTradeAsset === row.asset} on:click={() => selectTradeAsset(row)}>
                          <div class="cw-asset-main">
                            <span class="cw-asset-ticker">{row.chain}</span>
                            <span class="cw-asset-id">{row.displayAsset}</span>
                          </div>
                          <div class="cw-asset-side">
                            <span class="cw-asset-amount">{row.amountDisplay}</span>
                            <span class="cw-asset-tag">Trade asset</span>
                          </div>
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>

                <div class="cw-panel-card">
                  <div class="cw-card-head">
                    <span>Withdraw To L1</span>
                  </div>

                  {#if !selectedTradeBalance}
                    <div class="cw-empty-copy">Select a trade asset balance to withdraw back to its L1 chain.</div>
                  {:else}
                    <div class="cw-action-summary">
                      <div class="cw-action-row">
                        <span>Asset</span>
                        <span>{selectedTradeBalance.displayAsset}</span>
                      </div>
                      <div class="cw-action-row">
                        <span>Available</span>
                        <span>{selectedTradeBalance.amountDisplay}</span>
                      </div>
                      <div class="cw-action-row">
                        <span>Destination Chain</span>
                        <span>{selectedTradeBalance.chain}</span>
                      </div>
                    </div>

                    <label class="cw-label">
                      Amount
                      <div class="cw-input-row">
                        <input bind:value={withdrawAmount} class="cw-input" placeholder={`0.0 ${selectedTradeBalance.chain}`} />
                        <button class="cw-inline-btn" type="button" on:click={useMaxWithdraw}>Max</button>
                      </div>
                    </label>

                    <label class="cw-label">
                      Destination Address
                      <input bind:value={withdrawDestination} class="cw-input mono" placeholder={`Enter ${selectedTradeBalance.chain} address`} />
                    </label>

                    <button class="cw-primary-btn" type="button" on:click={handleWithdrawFromTrade} disabled={withdrawing || !withdrawAmount || !withdrawDestination}>
                      {#if withdrawing}
                        <div class="cw-spinner cw-spinner--tiny"></div>
                        Withdrawing…
                      {:else}
                        Withdraw To L1
                      {/if}
                    </button>
                  {/if}

                  {#if withdrawError}
                    <div class="cw-error">{withdrawError}</div>
                  {/if}
                  {#if withdrawSuccess}
                    <div class="cw-success">{withdrawSuccess}</div>
                  {/if}
                  <div class="cw-note">Trade assets live in the THOR trade account, not in your external wallet. Withdrawals are signed by your THOR wallet and sent out to the selected L1 address.</div>
                </div>
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .cw-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.74);
    backdrop-filter: blur(5px);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
  }

  .cw-dialog {
    width: min(72rem, 100%);
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    background: #0f0f0f;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 1rem;
    overflow: hidden;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
  }

  .cw-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 1.1rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    background: #141414;
  }

  .cw-header-copy h3 {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: #f1f1f1;
  }

  .cw-subtitle {
    margin: 0.35rem 0 0;
    color: #8a8a8a;
    font-size: 0.77rem;
    line-height: 1.35;
  }

  .cw-header-actions {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex-shrink: 0;
  }

  .cw-refresh,
  .cw-close,
  .cw-add-wallet,
  .cw-inline-btn,
  .cw-provider-disconnect,
  .cw-disconnect-btn,
  .cw-select-all,
  .cw-back,
  .cw-primary-btn,
  .cw-connect-btn {
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: #181818;
    color: #d4d4d4;
    border-radius: 0.55rem;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }

  .cw-refresh,
  .cw-close,
  .cw-back {
    width: 2.1rem;
    height: 2.1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }

  .cw-add-wallet,
  .cw-primary-btn,
  .cw-connect-btn {
    padding: 0.72rem 1rem;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .cw-primary-btn,
  .cw-connect-btn {
    background: #00a958;
    border-color: rgba(0, 204, 102, 0.45);
    color: #041a0d;
  }

  .cw-add-wallet:hover,
  .cw-refresh:hover,
  .cw-close:hover,
  .cw-inline-btn:hover,
  .cw-provider-disconnect:hover,
  .cw-disconnect-btn:hover,
  .cw-select-all:hover,
  .cw-back:hover {
    background: #202020;
    border-color: rgba(255, 255, 255, 0.18);
  }

  .cw-primary-btn:hover,
  .cw-connect-btn:hover {
    background: #18ba69;
  }

  .cw-primary-btn:disabled,
  .cw-connect-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .cw-manage,
  .cw-list,
  .cw-chain-select {
    padding: 1rem 1.1rem 1.1rem;
    overflow: auto;
  }

  .cw-wallets {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  .cw-section-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #8d8d8d;
  }

  .cw-owner {
    font-size: 0.69rem;
    color: #00cc66;
    letter-spacing: 0.03em;
  }

  .cw-provider-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: 0.85rem;
  }

  .cw-routing-grid {
    display: grid;
    grid-template-columns: minmax(14rem, 0.8fr) minmax(0, 1.2fr);
    gap: 0.85rem;
    margin-top: 0.9rem;
  }

  .cw-provider-card,
  .cw-panel-card,
  .cw-routing-card {
    background: #111111;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.85rem;
    padding: 0.9rem;
  }

  .cw-provider-head,
  .cw-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.8rem;
  }

  .cw-provider-meta {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .cw-provider-icon {
    width: 1.8rem;
    height: 1.8rem;
    object-fit: contain;
    border-radius: 0.45rem;
    background: rgba(255, 255, 255, 0.04);
    padding: 0.2rem;
  }

  .cw-provider-name {
    font-size: 0.86rem;
    font-weight: 700;
    color: #f1f1f1;
  }

  .cw-provider-count,
  .cw-inline-status {
    font-size: 0.72rem;
    color: #777;
  }

  .cw-provider-disconnect {
    padding: 0.45rem 0.7rem;
    font-size: 0.72rem;
  }

  .cw-account-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
  }

  .cw-account-chip {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.45rem 0.6rem;
    border-radius: 999px;
    background: #171717;
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: #c8c8c8;
    cursor: pointer;
  }

  .cw-account-chip.selected {
    border-color: rgba(0, 204, 102, 0.45);
    background: rgba(0, 204, 102, 0.1);
  }

  .cw-account-network {
    font-size: 0.68rem;
    font-weight: 800;
    letter-spacing: 0.06em;
  }

  .cw-account-address {
    font-size: 0.72rem;
  }

  .cw-tabs {
    display: inline-flex;
    gap: 0.4rem;
    padding: 0.9rem 0 0.2rem;
  }

  .cw-tab {
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: #131313;
    color: #909090;
    padding: 0.65rem 0.9rem;
    border-radius: 0.7rem;
    cursor: pointer;
    font-weight: 700;
    font-size: 0.78rem;
  }

  .cw-tab.active {
    color: #f1f1f1;
    border-color: rgba(0, 204, 102, 0.35);
    background: rgba(0, 204, 102, 0.08);
  }

  .cw-tab-panel {
    padding-top: 0.85rem;
  }

  .cw-panel-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.3fr) minmax(18rem, 0.9fr);
    gap: 0.9rem;
  }

  .cw-balance-groups {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  .cw-balance-group {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .cw-balance-group-head {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    color: #8a8a8a;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .cw-asset-row {
    display: flex;
    justify-content: space-between;
    gap: 0.85rem;
    width: 100%;
    padding: 0.7rem 0.8rem;
    border-radius: 0.75rem;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: #151515;
    color: #d9d9d9;
    cursor: pointer;
    text-align: left;
  }

  .cw-asset-row.selected {
    border-color: rgba(0, 204, 102, 0.35);
    background: rgba(0, 204, 102, 0.08);
  }

  .cw-asset-main,
  .cw-asset-side {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .cw-asset-side {
    align-items: flex-end;
  }

  .cw-asset-ticker {
    font-weight: 800;
    font-size: 0.78rem;
    color: #f1f1f1;
  }

  .cw-asset-id {
    font-size: 0.69rem;
    color: #7f7f7f;
    word-break: break-all;
  }

  .cw-asset-amount {
    font-weight: 700;
    font-size: 0.78rem;
    color: #f1f1f1;
  }

  .cw-asset-tag {
    font-size: 0.64rem;
    color: #00cc66;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .cw-asset-tag--disabled {
    color: #888;
  }

  .cw-action-summary {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    margin-bottom: 0.85rem;
  }

  .cw-action-row {
    display: flex;
    justify-content: space-between;
    gap: 0.8rem;
    font-size: 0.76rem;
    color: #b3b3b3;
  }

  .cw-label {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-bottom: 0.75rem;
    color: #b8b8b8;
    font-size: 0.74rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .cw-label--compact {
    margin-bottom: 0.55rem;
  }

  .cw-routing-list {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .cw-routing-chain {
    color: #f1f1f1;
    font-weight: 700;
  }

  .cw-input-row {
    display: flex;
    gap: 0.55rem;
  }

  .cw-input {
    width: 100%;
    background: #101010;
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 0.7rem;
    padding: 0.78rem 0.85rem;
    color: #f0f0f0;
    font-size: 0.84rem;
    min-width: 0;
  }

  .cw-input:focus {
    outline: none;
    border-color: rgba(0, 204, 102, 0.4);
  }

  .cw-select {
    width: 100%;
    background: #101010;
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 0.7rem;
    padding: 0.78rem 0.85rem;
    color: #f0f0f0;
    font-size: 0.84rem;
    min-width: 0;
  }

  .cw-select:focus {
    outline: none;
    border-color: rgba(0, 204, 102, 0.4);
  }

  .cw-inline-btn {
    flex-shrink: 0;
    padding: 0.72rem 0.85rem;
    font-size: 0.72rem;
    font-weight: 700;
  }

  .cw-group-label {
    margin: 0.2rem 0 0.55rem;
    color: #777;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .cw-wallet-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.78rem 0.85rem;
    margin-bottom: 0.5rem;
    background: #121212;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.8rem;
    color: #f0f0f0;
    cursor: pointer;
  }

  .cw-wallet-item.unavailable {
    color: #9e9e9e;
  }

  .cw-wallet-item.connected {
    border-color: rgba(0, 204, 102, 0.35);
  }

  .cw-wallet-icon {
    width: 1.55rem;
    height: 1.55rem;
    object-fit: contain;
  }

  .cw-wallet-name {
    flex: 1;
    text-align: left;
    font-weight: 700;
  }

  .cw-badge {
    font-size: 0.68rem;
    color: #8f8f8f;
  }

  .connected-badge {
    color: #00cc66;
  }

  .cw-disconnect-btn {
    padding: 0.35rem 0.55rem;
    font-size: 0.69rem;
  }

  .cw-chain-header {
    display: flex;
    justify-content: space-between;
    gap: 0.8rem;
    align-items: center;
    margin-bottom: 0.75rem;
    color: #d0d0d0;
    font-size: 0.82rem;
    font-weight: 700;
  }

  .cw-select-all {
    padding: 0.45rem 0.7rem;
    font-size: 0.7rem;
  }

  .cw-chains-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
    gap: 0.55rem;
  }

  .cw-chain-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.55rem;
    background: #131313;
    color: #cbcbcb;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.7rem;
    padding: 0.75rem;
    cursor: pointer;
  }

  .cw-chain-item.selected {
    border-color: rgba(0, 204, 102, 0.35);
    background: rgba(0, 204, 102, 0.08);
  }

  .cw-error,
  .cw-success,
  .cw-note,
  .cw-empty-copy {
    border-radius: 0.7rem;
    padding: 0.72rem 0.8rem;
    font-size: 0.74rem;
    line-height: 1.45;
  }

  .cw-error {
    margin-top: 0.75rem;
    background: rgba(204, 51, 51, 0.12);
    border: 1px solid rgba(204, 51, 51, 0.28);
    color: #f2aaaa;
  }

  .cw-success {
    margin-top: 0.75rem;
    background: rgba(0, 204, 102, 0.11);
    border: 1px solid rgba(0, 204, 102, 0.25);
    color: #9fe0b6;
  }

  .cw-note {
    margin-top: 0.75rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    color: #8a8a8a;
  }

  .cw-note--connect {
    margin-top: 0;
    margin-bottom: 0.75rem;
  }

  .cw-empty-copy {
    background: #131313;
    border: 1px dashed rgba(255, 255, 255, 0.08);
    color: #7a7a7a;
  }

  .cw-empty-state {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 1rem;
    border-radius: 0.85rem;
    background: #111111;
    border: 1px dashed rgba(255, 255, 255, 0.08);
  }

  .cw-empty-state--compact {
    padding: 0.9rem;
  }

  .cw-empty-title {
    font-size: 0.85rem;
    font-weight: 700;
    color: #f1f1f1;
  }

  .cw-loading-row {
    display: flex;
    justify-content: center;
    padding: 1rem 0;
  }

  .cw-spinner,
  .cw-spinner--tiny {
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.18);
    border-top-color: #00cc66;
    animation: cw-spin 1s linear infinite;
  }

  .cw-spinner--tiny {
    width: 0.8rem;
    height: 0.8rem;
  }

  .mono {
    font-family: 'JetBrains Mono', monospace;
  }

  @keyframes cw-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 960px) {
    .cw-panel-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 720px) {
    .cw-backdrop {
      padding: 0.6rem;
    }

    .cw-dialog {
      max-height: 94vh;
    }

    .cw-header {
      flex-direction: column;
      align-items: stretch;
    }

    .cw-header-actions {
      justify-content: flex-end;
    }

    .cw-provider-grid {
      grid-template-columns: 1fr;
    }

    .cw-routing-grid {
      grid-template-columns: 1fr;
    }

    .cw-tabs {
      width: 100%;
    }

    .cw-tab {
      flex: 1;
    }

    .cw-input-row {
      flex-direction: column;
    }

    .cw-inline-btn {
      width: 100%;
    }

    .cw-asset-row {
      flex-direction: column;
      align-items: stretch;
    }

    .cw-asset-side {
      align-items: flex-start;
    }

    .cw-balance-group-head,
    .cw-action-row,
    .cw-section-head {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
