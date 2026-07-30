<script>
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { formatNumber, formatUSD, formatUSDCompact, formatThorAmount, copyToClipboard as copyToClipboardUtil, shortenAddress as shortenAddressUtil, getAddressSuffix } from '$lib/utils/formatting';
  import { fromBaseUnit } from '$lib/utils/blockchain';
  import { hideBrokenImage } from '$lib/utils/dom';
  import {
    CHAIN_ICONS,
    CHAIN_EXPLORERS,
    formatVaultName,
    calculateVaultBond,
    calculateVaultAssetValue,
    VAULT_STATUS
  } from '$lib/utils/network';
  import { getAssetLogo, getAssetDisplayName } from '$lib/constants';
  import { Toast, LoadingBar, ChevronDownIcon } from '$lib/components';
  import { fetchVaultExplorerData } from './vault-explorer/data.js';

  let loading = true;
  let refreshing = false;
  let error = null;
  let data = null;
  let lastUpdated = null;
  let activeTab = 'overview';

  // Crosshair hover state
  let hoveredPool = null;
  let hoveredRow = null;
  let hoveredCol = null;

  // Vault Details state
  let showAssetBalances = false;
  let expandedSignerVaultPubKeys = [];
  let toastMessage = '';
  let showToast = false;
  const FALLBACK_ICON = '/assets/coins/fallback-logo.svg';

  const chainExplorers = {
    ...CHAIN_EXPLORERS,
    'BTC': 'https://blockstream.info/address/',
    'GAIA': 'https://www.mintscan.io/cosmos/account/',
    'THOR': 'https://thorchain.net/address/'
  };

  async function loadVaultData(initial = false) {
    if (refreshing) return;
    if (initial) {
      loading = true;
      error = null;
    } else {
      refreshing = true;
    }

    try {
      data = await fetchVaultExplorerData();
      lastUpdated = new Date();
      error = null;
    } catch (e) {
      const message = e?.message || 'Unable to load vault data';
      if (!data) {
        error = message;
      } else {
        toastMessage = `Refresh failed: ${message}`;
        showToast = true;
      }
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  function formatLastUpdated(date) {
    if (!date) return '';
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  onMount(() => {
    loadVaultData(true);
  });

  function handleCellEnter(e, poolIdx, rowIdx, colIdx) {
    hoveredPool = poolIdx;
    hoveredRow = rowIdx;
    hoveredCol = colIdx;
  }

  function handleCellLeave() {
    hoveredPool = null;
    hoveredRow = null;
    hoveredCol = null;
  }

  function getBarHeight(valueUSD, maxValue) {
    if (!maxValue || !valueUSD) return 0;
    return Math.max(4, (valueUSD / maxValue) * 100);
  }

  async function copyToClipboard(text, description) {
    const success = await copyToClipboardUtil(text, description);
    if (success) {
      toastMessage = `Copied ${description}!`;
      showToast = true;
    }
  }

  function shortenAddress(address, maxLength = 24) {
    if (!address) return '';
    if (address.length <= maxLength) return address;
    const start = Math.ceil(maxLength / 2);
    const end = Math.floor(maxLength / 2);
    return shortenAddressUtil(address, start, end);
  }

  function getVaultExplorerUrl(vault, poolAsset) {
    if (poolAsset === 'THOR.RUNE') return null;
    const chain = poolAsset.split('.')[0];
    const explorerUrl = chainExplorers[chain];
    if (!explorerUrl) return null;
    // ERC-20 tokens (asset contains '-' contract address) are held in the router
    const isToken = poolAsset.split('.')[1]?.includes('-');
    if (isToken && data?.routers?.[chain]) {
      return explorerUrl + data.routers[chain];
    }
    const addr = vault.addresses?.find(a => a.chain.split('.')[0] === chain);
    if (!addr) return null;
    return explorerUrl + addr.address;
  }

  function openExplorer(chain, address) {
    const explorerUrl = chainExplorers[chain];
    if (explorerUrl) window.open(explorerUrl + address, '_blank');
  }

  function getNodeExplorerUrl(nodeAddress) {
    return `https://thorchain.net/node/${nodeAddress}`;
  }

  function getNodeForSignerPubkey(pubkey) {
    return data?.nodesData?.find((node) => node.pub_key_set?.secp256k1 === pubkey) || null;
  }

  function getVaultSignerNodes(vault) {
    return (vault?.membership || []).map((pubkey) => {
      const node = getNodeForSignerPubkey(pubkey);
      const nodeAddress = node?.node_address || '';
      return {
        pubkey,
        nodeAddress,
        suffix: getAddressSuffix(nodeAddress || pubkey, 4)
      };
    });
  }

  function toggleSignerList(vault) {
    expandedSignerVaultPubKeys = expandedSignerVaultPubKeys.includes(vault.pub_key)
      ? expandedSignerVaultPubKeys.filter((pubKey) => pubKey !== vault.pub_key)
      : [...expandedSignerVaultPubKeys, vault.pub_key];
  }

  function getChainIcon(chain) {
    return CHAIN_ICONS[chain] || FALLBACK_ICON;
  }

  function handleIconError(event) {
    const image = event.currentTarget;
    if (!image) return;

    if (image.dataset.fallbackApplied === 'true' || image.getAttribute('src') === FALLBACK_ICON) {
      image.style.visibility = 'hidden';
      return;
    }

    image.dataset.fallbackApplied = 'true';
    image.src = FALLBACK_ICON;
  }

  function getVisibleVaultCoins(vault) {
    return [...(vault.coins || [])]
      .filter(coin => data.prices[coin.asset] && Number(coin.amount) > 0)
      .sort((a, b) => (fromBaseUnit(b.amount) * data.prices[b.asset]) - (fromBaseUnit(a.amount) * data.prices[a.asset]));
  }

  function calculateVaultBondUSD(bondInRune) {
    if (!data?.runePrice) return 0;
    return bondInRune * data.runePrice;
  }

  function formatAssetAmount(amount, symbol) {
    if (amount >= 1000000) return formatNumber(amount, { maximumFractionDigits: 0 });
    if (amount >= 1000) return formatNumber(amount, { maximumFractionDigits: 1 });
    if (amount >= 1) return formatNumber(amount, { maximumFractionDigits: 2 });
    if (amount >= 0.0001) return formatNumber(amount, { maximumFractionDigits: 4 });
    return formatNumber(amount, { maximumFractionDigits: 8 });
  }

  function getBalanceSourceLabel(coin) {
    const labels = {
      eth_chain: 'ETH chain',
      ltc_chain: 'LTC chain'
    };
    return labels[coin?.balance_source] || '';
  }
</script>

<div class="ve">
  {#if loading}
    <div class="loading-wrap">
      <LoadingBar variant="main" width="200px" />
      <LoadingBar variant="sub" width="120px" />
    </div>
  {:else if error}
    <div class="error-wrap">Error: {error}</div>
  {:else if data}
    <!-- Dashboard header: metrics + tabs -->
    <div class="dashboard-header">
    <div class="metrics">
      <div class="metric">
        <div class="metric-val accent">{formatUSDCompact(data.summary.totalVaultValueUSD)}</div>
        <div class="metric-key">TOTAL VAULT VALUE</div>
      </div>
      <div class="metric">
        <div class="metric-val">{data.summary.activeVaultCount}</div>
        <div class="metric-key">ACTIVE VAULTS</div>
      </div>
      <div class="metric">
        <div class="metric-val">{data.summary.totalPools}</div>
        <div class="metric-key">POOLS</div>
      </div>
      <div class="metric">
        <div class="metric-val" style="color: #00cc66">{formatUSDCompact(data.summary.pooledTotalUSD)}</div>
        <div class="metric-key">POOLED</div>
      </div>
      <div class="metric">
        <div class="metric-val" style="color: #5588cc">{formatUSDCompact(data.summary.tradeTotalUSD)}</div>
        <div class="metric-key">TRADE</div>
      </div>
      <div class="metric">
        <div class="metric-val amber">{formatUSDCompact(data.summary.securedTotalUSD)}</div>
        <div class="metric-key">SECURED</div>
      </div>
    </div>

    <!-- Tab bar -->
    <div class="tab-bar" role="tablist" aria-label="Vault Explorer sections">
      <button class="tab-btn" role="tab" aria-selected={activeTab === 'overview'} class:tab-active={activeTab === 'overview'} on:click={() => activeTab = 'overview'}>Overview</button>
      <button class="tab-btn" role="tab" aria-selected={activeTab === 'assets'} class:tab-active={activeTab === 'assets'} on:click={() => activeTab = 'assets'}>Assets</button>
      <button class="tab-btn" role="tab" aria-selected={activeTab === 'details'} class:tab-active={activeTab === 'details'} on:click={() => activeTab = 'details'}>Vault Details</button>
      <div class="tab-spacer"></div>
      {#if lastUpdated}
        <span class="last-updated">Updated {formatLastUpdated(lastUpdated)}</span>
      {/if}
      <button class="refresh-btn" on:click={() => loadVaultData(false)} disabled={refreshing}>
        {refreshing ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>
    </div><!-- /dashboard-header -->

    {#if activeTab === 'overview'}
      <!-- Pool Grid Visualizations -->
      <div class="pools-grid">
      {#each data.pools as pool, poolIdx}
        <section class="pool-section">
          <div class="pool-header">
            {#if getAssetLogo(pool.poolAsset)}
              <img src={getAssetLogo(pool.poolAsset)} alt={pool.displayName} class="pool-icon" on:error={hideBrokenImage} />
            {/if}
            <a class="pool-name" href="https://thorchain.net/pool/{pool.poolAsset}" target="_blank" rel="noopener noreferrer">{pool.displayName}</a>
            {#if pool.status !== 'Available'}
              <span class="pool-inactive-badge">{pool.status}</span>
            {/if}
            <span class="pool-total">{formatUSDCompact(pool.totalValueUSD)}</span>
            <span class="pool-type-pills">
              {#each pool.assetTypes as at}
                <span class="type-pill" style="background: {at.colorAlpha}; color: {at.color}; border-color: {at.color}">{at.label}</span>
              {/each}
            </span>
          </div>

          <!-- Mosaic grid: square, proportional columns + rows -->
          <div class="mosaic-wrap">
            <!-- Vault column headers -->
            <div class="mosaic-col-headers" style="grid-template-columns: {pool.vaultPcts.map(p => Math.max(p, 0.02).toFixed(4) + 'fr').join(' ')}">
              {#each data.vaults as vault, vi}
                {@const nativeAt = pool.assetTypes.find(at => at.type === 'native')}
                {@const vaultAmount = nativeAt?.vaultBalances[vi]?.amount || 0}
                {@const vaultUSD = pool.assetTypes.reduce((s, at) => {
                  if (at.isPerVault) return s + (at.vaultBalances[vi]?.valueUSD || 0);
                  return s + at.totalValueUSD * pool.vaultPcts[vi];
                }, 0)}
                {@const explorerUrl = getVaultExplorerUrl(vault, pool.poolAsset)}
                <div class="mosaic-col-header"
                     class:col-hl={hoveredPool === poolIdx && hoveredCol === vi}>
                  {#if explorerUrl}
                    <a class="col-name" href={explorerUrl} target="_blank" rel="noopener noreferrer">{vault.name}</a>
                  {:else}
                    <span class="col-name">{vault.name}</span>
                  {/if}
                  {#if hoveredPool === poolIdx && hoveredCol === vi}
                    <span class="axis-detail">{formatAssetAmount(vaultAmount)} {pool.displayName}</span>
                    <span class="axis-usd">{formatUSDCompact(vaultUSD)}</span>
                  {:else}
                    <span class="col-pct">{(pool.vaultPcts[vi] * 100).toFixed(1)}%</span>
                  {/if}
                </div>
              {/each}
            </div>

            <div class="mosaic-body">
              <!-- Row labels (left side) -->
              <div class="mosaic-row-labels">
                {#each pool.assetTypes as assetType, ri}
                  <div class="mosaic-row-label" style="flex: {Math.max(assetType.pct, 0.02).toFixed(4)}"
                       class:row-hl={hoveredPool === poolIdx && hoveredRow === ri}>
                    <div class="row-label-line">
                      <span class="type-dot" style="background: {assetType.color}"></span>
                      <span class="type-label">{assetType.label}</span>
                      {#if !(hoveredPool === poolIdx && hoveredRow === ri)}
                        <span class="row-pct">{(assetType.pct * 100).toFixed(1)}%</span>
                      {/if}
                    </div>
                    {#if hoveredPool === poolIdx && hoveredRow === ri}
                      <div class="row-label-detail">
                        <span class="axis-detail">{formatAssetAmount(assetType.totalAmount)} {pool.displayName}</span>
                        <span class="axis-usd">{formatUSDCompact(assetType.totalValueUSD)}</span>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>

              <!-- The square mosaic -->
              <div class="mosaic-square">
                {#each pool.assetTypes as assetType, ri}
                  <div class="mosaic-row" style="flex: {Math.max(assetType.pct, 0.02).toFixed(4)}">
                    {#each data.vaults as vault, vi}
                      {@const cell = assetType.isPerVault ? assetType.vaultBalances[vi] : { amount: assetType.totalAmount * pool.vaultPcts[vi], valueUSD: assetType.totalValueUSD * pool.vaultPcts[vi] }}
                      <div class="mosaic-cell"
                           style="flex: {Math.max(pool.vaultPcts[vi], 0.02).toFixed(4)}; background: {assetType.colorAlpha}; border-right: 1px solid #0d0d0d"
                           class:row-hl={hoveredPool === poolIdx && hoveredRow === ri}
                           class:col-hl={hoveredPool === poolIdx && hoveredCol === vi}
                           class:cell-active={hoveredPool === poolIdx && hoveredRow === ri && hoveredCol === vi}
                           on:mouseenter={() => handleCellEnter(null, poolIdx, ri, vi)}
                           on:mouseleave={handleCellLeave}>
                      </div>
                    {/each}
                  </div>
                {/each}
              </div>
            </div>
          </div>
        </section>
      {/each}
      </div>

    {:else if activeTab === 'assets'}
      <section class="assets-panel" aria-label="Assets">
        <div class="asset-summary-grid">
          <div class="asset-summary-cell">
            <span class="asset-summary-value">{formatUSDCompact(data.assetSummary.totalValueUSD)}</span>
            <span class="asset-summary-label">EXOGENOUS TOTAL</span>
          </div>
          <div class="asset-summary-cell pooled">
            <span class="asset-summary-value">{formatUSDCompact(data.assetSummary.pooledTotalUSD)}</span>
            <span class="asset-summary-label">POOLED</span>
          </div>
          <div class="asset-summary-cell trade">
            <span class="asset-summary-value">{formatUSDCompact(data.assetSummary.tradeTotalUSD)}</span>
            <span class="asset-summary-label">TRADE</span>
          </div>
          <div class="asset-summary-cell secured">
            <span class="asset-summary-value">{formatUSDCompact(data.assetSummary.securedTotalUSD)}</span>
            <span class="asset-summary-label">SECURED</span>
          </div>
        </div>

        <div class="assets-heading">
          <div>
            <div class="assets-title-row">
              <span class="assets-title-marker"></span>
              <h2>EXOGENOUS ASSET CUSTODY</h2>
            </div>
            <p>Current non-RUNE inventory across pooled, trade, and secured balances. Values use the same live state and prices as Overview.</p>
          </div>
          <span class="assets-count">{data.assetSummary.assetCount} ASSETS</span>
        </div>

        <div class="assets-table-wrap">
          <table class="assets-table">
            <thead>
              <tr>
                <th scope="col">ASSET</th>
                <th scope="col">TOTAL CUSTODIED</th>
                <th scope="col" class="pooled-col">POOLED</th>
                <th scope="col" class="trade-col">TRADE</th>
                <th scope="col" class="secured-col">SECURED</th>
              </tr>
            </thead>
            <tbody>
              {#each data.assets as asset (asset.poolAsset)}
                <tr>
                  <td>
                    <div class="asset-identity">
                      {#if getAssetLogo(asset.poolAsset)}
                        <img src={getAssetLogo(asset.poolAsset)} alt="" class="custody-asset-logo" on:error={handleIconError} />
                      {/if}
                      <div class="asset-identity-text">
                        <div class="asset-name-row">
                          <a href="https://thorchain.net/pool/{asset.poolAsset}" target="_blank" rel="noopener noreferrer">{asset.displayName}</a>
                          {#if asset.status !== 'Available'}
                            <span class="pool-inactive-badge">{asset.status}</span>
                          {/if}
                        </div>
                        <span class="asset-code">{asset.poolAsset}</span>
                      </div>
                    </div>
                  </td>
                  <td class="amount-cell total-cell">
                    <span class="bucket-amount">{formatAssetAmount(asset.totalAmount)} {asset.displayName}</span>
                    <span class="bucket-usd">{formatUSD(asset.totalValueUSD)}</span>
                  </td>
                  <td class="amount-cell pooled-cell">
                    {#if asset.pooled.amount > 0}
                      <span class="bucket-amount">{formatAssetAmount(asset.pooled.amount)} {asset.displayName}</span>
                      <span class="bucket-usd">{formatUSD(asset.pooled.valueUSD)}</span>
                    {:else}
                      <span class="bucket-empty">—</span>
                    {/if}
                  </td>
                  <td class="amount-cell trade-cell">
                    {#if asset.trade.amount > 0}
                      <span class="bucket-amount">{formatAssetAmount(asset.trade.amount)} {asset.displayName}</span>
                      <span class="bucket-usd">{formatUSD(asset.trade.valueUSD)}</span>
                    {:else}
                      <span class="bucket-empty">—</span>
                    {/if}
                  </td>
                  <td class="amount-cell secured-cell">
                    {#if asset.secured.amount > 0}
                      <span class="bucket-amount">{formatAssetAmount(asset.secured.amount)} {asset.displayName}</span>
                      <span class="bucket-usd">{formatUSD(asset.secured.valueUSD)}</span>
                    {:else}
                      <span class="bucket-empty">—</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>

    {:else if activeTab === 'details'}
      <!-- Vault Details (ported from Vaults.svelte) -->
      <div class="vaults-grid">
        {#each data.rawVaults as vault (vault.pub_key)}
          <div class="vault-card">
            <div class="vault-card-header" class:retiring={vault.status === 'RetiringVault'}>
              <div class="vault-name-row">
                <span class="vault-name">Vault {formatVaultName(vault.pub_key)}</span>
                <span class="vault-status-badge" class:active={vault.status === 'ActiveVault'} class:ret={vault.status === 'RetiringVault'}>
                  {vault.status === 'ActiveVault' ? 'Active' : 'Retiring'}
                </span>
              </div>
              <button class="pubkey-btn" on:click={() => copyToClipboard(vault.pub_key, 'ECDSA pubkey')}>
                ECDSA: {shortenAddress(vault.pub_key)}
              </button>
              {#if vault.pub_key_eddsa}
                <button class="pubkey-btn" on:click={() => copyToClipboard(vault.pub_key_eddsa, 'EdDSA pubkey')}>
                  EdDSA: {shortenAddress(vault.pub_key_eddsa)}
                </button>
              {/if}
            </div>

            <div class="vault-card-body">
              <div class="vault-section-title">CHAIN ADDRESSES</div>
              {#each vault.addresses as addr (`${addr.chain}:${addr.address}`)}
                {@const chain = addr.chain.split('.')[0]}
                <div class="addr-row">
                  <img src={getChainIcon(chain)} alt={addr.chain} class="addr-chain-icon"
                       on:error={handleIconError} loading="eager" decoding="async" />
                  <span class="addr-chain">{chain}</span>
                  <button class="addr-val" on:click={() => copyToClipboard(addr.address, `${addr.chain} address`)}>
                    {shortenAddress(addr.address, 20)}
                  </button>
                  {#if chainExplorers[chain]}
                    <button class="addr-explorer" on:click={() => openExplorer(chain, addr.address)} title="View on explorer">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                        <polyline points="15,3 21,3 21,9"></polyline>
                        <line x1="10" y1="14" x2="21" y2="3"></line>
                      </svg>
                    </button>
                  {/if}
                </div>
              {/each}

              <div class="vault-divider"></div>

              <div class="vault-stats-grid">
                <div class="vault-stat">
                  <span class="vault-stat-label">TX IN</span>
                  <span class="vault-stat-val">{(vault.inbound_tx_count || 0).toLocaleString()}</span>
                </div>
                <div class="vault-stat">
                  <span class="vault-stat-label">TX OUT</span>
                  <span class="vault-stat-val">{(vault.outbound_tx_count || 0).toLocaleString()}</span>
                </div>
                <div class="vault-stat">
                  <span class="vault-stat-label">BOND</span>
                  <span class="vault-stat-val">{formatNumber(Math.floor(calculateVaultBond(vault, data.nodesData)), { maximumFractionDigits: 0 })} ᚱ</span>
                </div>
                <div class="vault-stat">
                  <span class="vault-stat-label">BOND VALUE</span>
                  <span class="vault-stat-val">{formatUSDCompact(calculateVaultBondUSD(calculateVaultBond(vault, data.nodesData)))}</span>
                </div>
                <div class="vault-stat">
                  <span class="vault-stat-label">ASSET VALUE</span>
                  <span class="vault-stat-val accent">{formatUSDCompact(calculateVaultAssetValue(vault.coins, data.prices))}</span>
                </div>
                <button
                  type="button"
                  class="vault-stat vault-stat-button"
                  class:expanded={expandedSignerVaultPubKeys.includes(vault.pub_key)}
                  aria-expanded={expandedSignerVaultPubKeys.includes(vault.pub_key)}
                  aria-label="Toggle signers for Vault {formatVaultName(vault.pub_key)}"
                  on:click={() => toggleSignerList(vault)}
                >
                  <span class="vault-stat-label">SIGNERS</span>
                  <span class="vault-stat-val signer-stat-val">
                    {vault.membership?.length || 0}
                    <ChevronDownIcon size={12} />
                  </span>
                </button>
              </div>

              {#if expandedSignerVaultPubKeys.includes(vault.pub_key)}
                <div class="signer-list" transition:slide={{ duration: 160 }} aria-label="Vault signers">
                  {#each getVaultSignerNodes(vault) as signer (signer.pubkey)}
                    {#if signer.nodeAddress}
                      <a class="signer-link" href={getNodeExplorerUrl(signer.nodeAddress)} target="_blank" rel="noopener noreferrer" title={signer.nodeAddress}>
                        {signer.suffix}
                      </a>
                    {:else}
                      <span class="signer-link signer-link-missing" title={signer.pubkey}>
                        {signer.suffix}
                      </span>
                    {/if}
                  {/each}
                </div>
              {/if}

              <div class="vault-divider"></div>

              <button class="expand-toggle" class:expanded={showAssetBalances} on:click={() => showAssetBalances = !showAssetBalances}>
                <span>Asset Balances</span>
                <ChevronDownIcon size={16} />
              </button>

              {#if showAssetBalances}
                <div class="asset-list" transition:slide={{ duration: 200 }}>
                  {#each getVisibleVaultCoins(vault) as coin (coin.asset)}
                    {@const logo = getAssetLogo(coin.asset)}
                    {@const name = getAssetDisplayName(coin.asset)}
                    {@const sourceLabel = getBalanceSourceLabel(coin)}
                    <div class="asset-row">
                      <div class="asset-id">
                        {#if logo}
                          <img src={logo} alt={name} class="asset-logo" on:error={handleIconError} loading="eager" decoding="async" />
                        {/if}
                        <span>{name}</span>
                        {#if sourceLabel}
                          <span class="asset-source">{sourceLabel}</span>
                        {/if}
                      </div>
                      <div class="asset-vals">
                        <span class="asset-amount">{formatAssetAmount(fromBaseUnit(coin.amount))}</span>
                        <span class="asset-usd">{formatUSD(fromBaseUnit(coin.amount) * data.prices[coin.asset])}</span>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  <!-- Tooltip -->

  <Toast message={toastMessage} visible={showToast} on:hide={() => showToast = false} />
</div>

<style>
  /* ---- WRAPPER ---- */
  .ve {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0;
    font-family: 'DM Sans', -apple-system, sans-serif;
    color: var(--term-text-body, #e8e8e8);
    position: relative;
  }

  .loading-wrap, .error-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 60px 20px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: var(--term-text-3);
  }

  /* ---- DASHBOARD HEADER ---- */
  .dashboard-header {
    background: #0d0d0d;
  }

  /* ---- METRICS ---- */
  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    border-bottom: 1px solid #1a1a1a;
    background: #0d0d0d;
  }

  .metric {
    padding: 20px 16px;
    border-right: 1px solid #1a1a1a;
    text-align: center;
  }

  .metric:last-child { border-right: none; }

  .metric-val {
    font-family: 'JetBrains Mono', monospace;
    font-size: 26px;
    font-weight: 700;
    color: var(--term-text-body, #e8e8e8);
    letter-spacing: -0.02em;
    line-height: 1;
    margin-bottom: 8px;
  }

  .metric-val.accent { color: #00cc66; }
  .metric-val.amber { color: #d4a017; }

  .metric-key {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    color: var(--term-text-4);
    text-transform: uppercase;
  }

  /* ---- TAB BAR ---- */
  .tab-bar {
    display: flex;
    align-items: center;
    gap: 0;
    background: #0a0a0a;
    border-bottom: 1px solid #1a1a1a;
    padding: 0 16px;
  }

  .tab-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--term-text-4);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 10px 16px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  .tab-btn:hover { color: var(--term-text-4, #bcbcbc); }
  .tab-active { color: #00cc66; border-bottom-color: #00cc66; }

  .tab-spacer {
    flex: 1;
  }

  .last-updated {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--term-text-4);
    margin-right: 10px;
    white-space: nowrap;
  }

  .refresh-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: #00cc66;
    background: rgba(0, 204, 102, 0.08);
    border: 1px solid rgba(0, 204, 102, 0.35);
    border-radius: 4px;
    padding: 6px 10px;
    cursor: pointer;
    text-transform: uppercase;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }

  .refresh-btn:hover:not(:disabled) {
    background: rgba(0, 204, 102, 0.14);
    border-color: rgba(0, 204, 102, 0.6);
    color: #66ffaa;
  }

  .refresh-btn:disabled {
    color: var(--term-text-4);
    border-color: #222;
    background: #111;
    cursor: wait;
  }

  /* ---- POOL SECTIONS ---- */
  .pools-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
    gap: 1px;
    background: #1a1a1a;
  }

  .pool-section {
    background: #0d0d0d;
  }

  .pool-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px 10px;
    background: #0a0a0a;
    border-bottom: 1px solid #141414;
  }

  .pool-icon {
    width: 22px;
    height: 22px;
    border-radius: 50%;
  }

  .pool-name {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: var(--term-text-2, #d8d8d8);
    text-decoration: none;
    transition: color 0.15s;
  }

  .pool-name:hover {
    color: #00cc66;
  }

  .pool-inactive-badge {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 2px;
    background: rgba(212, 160, 23, 0.15);
    color: #d4a017;
    border: 1px solid rgba(212, 160, 23, 0.3);
  }

  .pool-total {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--term-text-4);
    margin-left: auto;
  }

  .pool-type-pills {
    display: flex;
    gap: 4px;
    margin-left: 8px;
  }

  .type-pill {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 2px;
    border: 1px solid;
  }

  /* ---- MOSAIC GRID ---- */
  .mosaic-wrap {
    padding: 12px 16px 16px;
    background: #0d0d0d;
    max-width: 460px;
    margin: 0 auto;
  }

  .mosaic-col-headers {
    display: grid;
    margin-left: 90px;
    overflow: visible;
  }

  .mosaic-col-header {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--term-text-4);
    text-align: center;
    padding: 6px 0;
    transition: color 0.1s;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    overflow: visible;
    white-space: nowrap;
    position: relative;
    z-index: 1;
  }

  .mosaic-col-header.col-hl { color: var(--term-text-3, #c8c8c8); }

  a.col-name {
    color: inherit;
    text-decoration: none;
  }
  a.col-name:hover {
    color: #00cc66;
    text-decoration: underline;
  }

  .col-pct, .row-pct {
    font-size: 11px;
    color: var(--term-text-3);
    font-weight: 500;
  }

  .mosaic-body {
    display: flex;
    gap: 0;
  }

  .mosaic-row-labels {
    width: 90px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    overflow: visible;
  }

  .mosaic-row-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    color: var(--term-text-4);
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 1px;
    padding: 2px 8px;
    transition: color 0.1s;
    min-height: 0;
    overflow: visible;
    position: relative;
    z-index: 1;
  }

  .row-label-line {
    display: flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }

  .row-label-detail {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding-left: 11px;
  }

  .mosaic-row-label.row-hl { color: var(--term-text-3, #c8c8c8); }

  .type-dot {
    width: 6px;
    height: 6px;
    border-radius: 1px;
    flex-shrink: 0;
  }

  .type-label {
    white-space: nowrap;
    letter-spacing: 0.06em;
  }

  .mosaic-square {
    flex: 1;
    aspect-ratio: 1;
    display: flex;
    flex-direction: column;
    border: 1px solid #1a1a1a;
    border-radius: 3px;
    overflow: hidden;
  }

  .mosaic-row {
    display: flex;
    min-height: 0;
  }

  .mosaic-cell {
    min-width: 0;
    cursor: crosshair;
    transition: filter 0.1s, outline-color 0.15s;
    position: relative;
  }

  .mosaic-cell.row-hl,
  .mosaic-cell.col-hl {
    filter: brightness(1.3);
  }

  .mosaic-cell.cell-active {
    filter: brightness(1.6);
    outline: 2px solid rgba(255, 255, 255, 0.3);
    outline-offset: -2px;
    z-index: 1;
  }


  /* ---- AXIS DETAIL (hover info) ---- */
  .axis-detail {
    font-size: 11px;
    font-weight: 600;
    color: var(--term-text-2, #d8d8d8);
    white-space: nowrap;
  }

  .axis-usd {
    font-size: 11px;
    color: #00cc66;
    white-space: nowrap;
  }

  /* ---- ASSETS TAB ---- */
  .assets-panel {
    background: #0a0a0a;
    min-width: 0;
  }

  .asset-summary-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    background: #1a1a1a;
    gap: 1px;
    border-bottom: 1px solid #1a1a1a;
  }

  .asset-summary-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 16px;
    background: #0d0d0d;
    text-align: center;
  }

  .asset-summary-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 20px;
    font-weight: 700;
    line-height: 1;
    color: var(--term-text-body, #e8e8e8);
  }

  .asset-summary-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    color: var(--term-text-4);
  }

  .asset-summary-cell.pooled .asset-summary-value { color: #00cc66; }
  .asset-summary-cell.trade .asset-summary-value { color: #5588cc; }
  .asset-summary-cell.secured .asset-summary-value { color: #d4a017; }

  .assets-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    padding: 16px;
    border-bottom: 1px solid #1a1a1a;
    background: #080808;
  }

  .assets-title-row {
    display: flex;
    align-items: center;
    gap: 9px;
  }

  .assets-title-marker {
    width: 3px;
    height: 14px;
    background: #00cc66;
  }

  .assets-title-row h2 {
    margin: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--term-text-body);
  }

  .assets-heading p {
    margin: 7px 0 0 12px;
    max-width: 760px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--term-text-3);
  }

  .assets-count {
    flex-shrink: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: #00cc66;
    border: 1px solid rgba(0, 204, 102, 0.25);
    padding: 4px 7px;
  }

  .assets-table-wrap {
    width: 100%;
    overflow-x: auto;
  }

  .assets-table {
    width: 100%;
    min-width: 960px;
    border-collapse: collapse;
    table-layout: fixed;
    font-family: 'JetBrains Mono', monospace;
  }

  .assets-table th,
  .assets-table td {
    border-right: 1px solid #161616;
    border-bottom: 1px solid #161616;
    text-align: left;
  }

  .assets-table th:last-child,
  .assets-table td:last-child {
    border-right: 0;
  }

  .assets-table th {
    position: sticky;
    top: 0;
    z-index: 2;
    padding: 9px 14px;
    background: #0d0d0d;
    color: var(--term-text-4);
    font-size: 11px;
    line-height: 1.4;
    font-weight: 700;
    letter-spacing: 0.1em;
    white-space: nowrap;
  }

  .assets-table th:first-child { width: 24%; }
  .assets-table th:not(:first-child) { width: 19%; }
  .assets-table th.pooled-col { color: #008844; }
  .assets-table th.trade-col { color: #456faa; }
  .assets-table th.secured-col { color: #9a7511; }

  .assets-table td {
    padding: 11px 14px;
    background: #0a0a0a;
    vertical-align: middle;
  }

  .assets-table tbody tr:hover td {
    background: #0e0e0e;
  }

  .asset-identity {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .custody-asset-logo {
    width: 24px;
    height: 24px;
    flex: 0 0 24px;
    border-radius: 50%;
    object-fit: contain;
  }

  .asset-identity-text {
    min-width: 0;
  }

  .asset-name-row {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .asset-name-row a {
    color: var(--term-text-body);
    font-size: 12px;
    font-weight: 700;
    text-decoration: none;
  }

  .asset-name-row a:hover { color: #00cc66; }

  .asset-code {
    display: block;
    max-width: 100%;
    margin-top: 3px;
    overflow: hidden;
    color: var(--term-text-5);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .amount-cell {
    white-space: nowrap;
  }

  .bucket-amount,
  .bucket-usd {
    display: block;
  }

  .bucket-amount {
    color: var(--term-text-4, #bcbcbc);
    font-size: 11px;
    font-weight: 600;
  }

  .bucket-usd {
    margin-top: 3px;
    color: var(--term-text-4);
    font-size: 11px;
  }

  .total-cell .bucket-amount { color: var(--term-text-body, #e8e8e8); }
  .total-cell .bucket-usd { color: var(--term-text-3); }
  .pooled-cell .bucket-amount { color: #00cc66; }
  .trade-cell .bucket-amount { color: #5588cc; }
  .secured-cell .bucket-amount { color: #d4a017; }

  .bucket-empty {
    color: var(--term-text-6);
    font-size: 12px;
  }

  /* ---- VAULT DETAILS TAB ---- */
  .vaults-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: 1px;
    background: #1a1a1a;
  }

  .vault-card {
    background: #0d0d0d;
    display: flex;
    flex-direction: column;
  }

  .vault-card-header {
    padding: 14px 16px;
    background: linear-gradient(135deg, #0a2a1a 0%, #0d0d0d 100%);
    border-bottom: 1px solid #1a1a1a;
  }

  .vault-card-header.retiring {
    background: linear-gradient(135deg, #2a1a0a 0%, #0d0d0d 100%);
  }

  .vault-name-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .vault-name {
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    font-weight: 700;
    color: var(--term-text-body, #e8e8e8);
    letter-spacing: 0.04em;
  }

  .vault-status-badge {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 2px;
  }

  .vault-status-badge.active {
    background: rgba(0, 204, 102, 0.15);
    color: #00cc66;
    border: 1px solid rgba(0, 204, 102, 0.3);
  }

  .vault-status-badge.ret {
    background: rgba(212, 160, 23, 0.15);
    color: #d4a017;
    border: 1px solid rgba(212, 160, 23, 0.3);
  }

  .pubkey-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--term-text-4);
    background: none;
    border: none;
    padding: 2px 0;
    cursor: pointer;
    display: block;
    text-align: left;
    transition: color 0.15s;
  }

  .pubkey-btn:hover { color: var(--term-text-4, #bcbcbc); }

  .vault-card-body {
    padding: 12px 16px;
    flex: 1;
  }

  .vault-section-title {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    color: var(--term-text-5);
    margin-bottom: 8px;
  }

  .addr-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    font-size: 11px;
  }

  .addr-chain-icon {
    width: 16px;
    height: 16px;
    flex: 0 0 16px;
    object-fit: contain;
  }

  .addr-chain {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    color: var(--term-text-3);
    min-width: 40px;
  }

  .addr-val {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--term-text-4);
    background: none;
    border: none;
    cursor: pointer;
    flex: 1;
    text-align: left;
    padding: 2px 0;
    transition: color 0.15s;
  }

  .addr-val:hover { color: #00cc66; }

  .addr-explorer {
    background: none;
    border: none;
    color: var(--term-text-5);
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
    transition: color 0.15s;
  }

  .addr-explorer:hover { color: #00cc66; }

  .vault-divider {
    height: 1px;
    background: #1a1a1a;
    margin: 10px 0;
  }

  .vault-stats-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    background: #1a1a1a;
    border-radius: 3px;
    overflow: hidden;
  }

  .vault-stat {
    background: #111;
    padding: 8px 10px;
    text-align: center;
  }

  .vault-stat-button {
    border: 0;
    color: inherit;
    cursor: pointer;
    font: inherit;
    width: 100%;
    transition: background 0.15s;
  }

  .vault-stat-button:hover,
  .vault-stat-button.expanded {
    background: #141414;
  }

  .vault-stat-button:hover .vault-stat-label,
  .vault-stat-button.expanded .vault-stat-label {
    color: var(--term-text-3);
  }

  .vault-stat-button:hover .vault-stat-val,
  .vault-stat-button.expanded .vault-stat-val {
    color: #00cc66;
  }

  .vault-stat-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    color: var(--term-text-5);
    display: block;
    margin-bottom: 4px;
  }

  .vault-stat-val {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    font-weight: 600;
    color: var(--term-text-3, #c8c8c8);
  }

  .vault-stat-val.accent { color: #00cc66; }

  .signer-stat-val {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
  }

  .signer-stat-val :global(svg) {
    transition: transform 0.15s;
  }

  .vault-stat-button.expanded .signer-stat-val :global(svg) {
    transform: rotate(180deg);
  }

  .signer-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(48px, 1fr));
    gap: 6px;
    margin-top: 8px;
  }

  .signer-link {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 700;
    color: var(--term-text-3, #c8c8c8);
    text-decoration: none;
    background: #111;
    border: 1px solid #1e1e1e;
    border-radius: 3px;
    padding: 5px 6px;
    text-align: center;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }

  .signer-link:hover {
    color: #00cc66;
    background: rgba(0, 204, 102, 0.06);
    border-color: rgba(0, 204, 102, 0.35);
  }

  .signer-link-missing {
    color: var(--term-text-3);
    cursor: default;
  }

  .signer-link-missing:hover {
    color: var(--term-text-3);
    background: #111;
    border-color: #1e1e1e;
  }

  .expand-toggle {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--term-text-4);
    background: none;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
    transition: color 0.15s;
    width: 100%;
  }

  .expand-toggle:hover { color: var(--term-text-4, #bcbcbc); }

  .expand-toggle.expanded :global(svg) {
    transform: rotate(180deg);
  }

  .expand-toggle :global(svg) {
    transition: transform 0.2s;
  }

  .asset-list {
    margin-top: 8px;
  }

  .asset-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
    border-bottom: 1px solid #111;
  }

  .asset-row:last-child { border-bottom: none; }

  .asset-id {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--term-text-2);
  }

  .asset-logo {
    width: 16px;
    height: 16px;
    flex: 0 0 16px;
    border-radius: 50%;
    object-fit: contain;
  }

  .asset-source {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: #00cc66;
    background: rgba(0, 204, 102, 0.1);
    border: 1px solid rgba(0, 204, 102, 0.25);
    border-radius: 3px;
    padding: 1px 4px;
    text-transform: uppercase;
  }

  .asset-vals {
    display: flex;
    gap: 12px;
    align-items: center;
  }

  .asset-amount {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--term-text-3);
  }

  .asset-usd {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #00cc66;
    min-width: 70px;
    text-align: right;
  }

  /* ---- RESPONSIVE ---- */
  @media (max-width: 900px) {
    .metrics {
      grid-template-columns: repeat(3, 1fr);
    }

    .metric-val {
      font-size: 20px;
    }

    .pool-grid {
      overflow-x: auto;
    }

    .vaults-grid {
      grid-template-columns: 1fr;
    }

    .pool-header {
      flex-wrap: wrap;
    }

    .pool-type-pills {
      margin-left: 0;
    }

    .asset-summary-value {
      font-size: 17px;
    }
  }

  @media (max-width: 600px) {
    .metrics {
      grid-template-columns: repeat(2, 1fr);
    }

    .metric-val {
      font-size: 18px;
    }

    .tab-btn {
      font-size: 12px;
      padding: 8px 12px;
    }

    .tab-bar {
      flex-wrap: wrap;
      gap: 4px;
      padding: 0 12px 8px;
    }

    .last-updated {
      order: 3;
      width: 100%;
      margin: 0;
    }

    .asset-summary-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .asset-summary-cell {
      padding: 13px 10px;
    }

    .assets-heading {
      flex-direction: column;
      gap: 10px;
    }

    .assets-heading p {
      margin-left: 0;
    }
  }
</style>
