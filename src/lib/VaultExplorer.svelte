<script>
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { formatNumber, formatUSD, formatUSDCompact, formatThorAmount, copyToClipboard as copyToClipboardUtil, shortenAddress as shortenAddressUtil } from '$lib/utils/formatting';
  import { fromBaseUnit } from '$lib/utils/blockchain';
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
  let error = null;
  let data = null;
  let activeTab = 'overview';

  // Crosshair hover state
  let hoveredPool = null;
  let hoveredRow = null;
  let hoveredCol = null;

  // Vault Details state
  let showAssetBalances = false;
  let toastMessage = '';
  let showToast = false;

  const chainExplorers = {
    ...CHAIN_EXPLORERS,
    'BTC': 'https://blockstream.info/address/',
    'GAIA': 'https://www.mintscan.io/cosmos/account/',
    'THOR': 'https://thorchain.net/address/'
  };

  onMount(async () => {
    try {
      data = await fetchVaultExplorerData();
    } catch (e) {
      error = e.message;
    }
    loading = false;
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

  function calculateVaultBondUSD(bondInRune) {
    if (!data?.runePrice) return 0;
    return bondInRune * data.runePrice;
  }

  function formatAssetAmount(amount, symbol) {
    if (amount >= 1000000) return formatNumber(amount, { maximumFractionDigits: 0 });
    if (amount >= 1000) return formatNumber(amount, { maximumFractionDigits: 1 });
    if (amount >= 1) return formatNumber(amount, { maximumFractionDigits: 2 });
    return formatNumber(amount, { maximumFractionDigits: 4 });
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
    <!-- Sticky header: metrics + tabs -->
    <div class="sticky-header">
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
    <div class="tab-bar">
      <button class="tab-btn" class:tab-active={activeTab === 'overview'} on:click={() => activeTab = 'overview'}>Overview</button>
      <button class="tab-btn" class:tab-active={activeTab === 'details'} on:click={() => activeTab = 'details'}>Vault Details</button>
    </div>
    </div><!-- /sticky-header -->

    {#if activeTab === 'overview'}
      <!-- Pool Grid Visualizations -->
      <div class="pools-grid">
      {#each data.pools as pool, poolIdx}
        <section class="pool-section">
          <div class="pool-header">
            {#if getAssetLogo(pool.poolAsset)}
              <img src={getAssetLogo(pool.poolAsset)} alt={pool.displayName} class="pool-icon" on:error={(e) => { e.target.style.display = 'none'; }} />
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

    {:else if activeTab === 'details'}
      <!-- Vault Details (ported from Vaults.svelte) -->
      <div class="vaults-grid">
        {#each data.rawVaults as vault}
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
              {#each vault.addresses as addr}
                <div class="addr-row">
                  <img src={CHAIN_ICONS[addr.chain.split('.')[0]]} alt={addr.chain} class="addr-chain-icon"
                       on:error={(e) => { e.target.src = '/assets/coins/fallback-logo.svg'; }} />
                  <span class="addr-chain">{addr.chain.split('.')[0]}</span>
                  <button class="addr-val" on:click={() => copyToClipboard(addr.address, `${addr.chain} address`)}>
                    {shortenAddress(addr.address, 20)}
                  </button>
                  {#if chainExplorers[addr.chain.split('.')[0]]}
                    <button class="addr-explorer" on:click={() => openExplorer(addr.chain.split('.')[0], addr.address)} title="View on explorer">
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
                <div class="vault-stat">
                  <span class="vault-stat-label">SIGNERS</span>
                  <span class="vault-stat-val">{vault.membership?.length || 0}</span>
                </div>
              </div>

              <div class="vault-divider"></div>

              <button class="expand-toggle" class:expanded={showAssetBalances} on:click={() => showAssetBalances = !showAssetBalances}>
                <span>Asset Balances</span>
                <ChevronDownIcon size={16} />
              </button>

              {#if showAssetBalances}
                <div class="asset-list" transition:slide={{ duration: 200 }}>
                  {#each vault.coins
                    .filter(coin => data.prices[coin.asset])
                    .sort((a, b) => (fromBaseUnit(b.amount) * data.prices[b.asset]) - (fromBaseUnit(a.amount) * data.prices[a.asset]))
                  as coin}
                    {@const logo = getAssetLogo(coin.asset)}
                    {@const name = getAssetDisplayName(coin.asset)}
                    <div class="asset-row">
                      <div class="asset-id">
                        {#if logo}
                          <img src={logo} alt={name} class="asset-logo" on:error={(e) => { e.target.src = '/assets/coins/fallback-logo.svg'; }} />
                        {/if}
                        <span>{name}</span>
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
    color: #c8c8c8;
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
    color: #666;
  }

  /* ---- STICKY HEADER ---- */
  .sticky-header {
    position: sticky;
    top: 36px; /* below the fixed site navbar (36px) */
    z-index: 10;
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
    color: #e0e0e0;
    letter-spacing: -0.02em;
    line-height: 1;
    margin-bottom: 8px;
  }

  .metric-val.accent { color: #00cc66; }
  .metric-val.amber { color: #d4a017; }

  .metric-key {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.12em;
    color: #555;
    text-transform: uppercase;
  }

  /* ---- TAB BAR ---- */
  .tab-bar {
    display: flex;
    gap: 0;
    background: #0a0a0a;
    border-bottom: 1px solid #1a1a1a;
    padding: 0 16px;
  }

  .tab-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: #555;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 10px 16px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  .tab-btn:hover { color: #999; }
  .tab-active { color: #00cc66; border-bottom-color: #00cc66; }

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
    color: #ccc;
    text-decoration: none;
    transition: color 0.15s;
  }

  .pool-name:hover {
    color: #00cc66;
  }

  .pool-inactive-badge {
    font-family: 'JetBrains Mono', monospace;
    font-size: 8px;
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
    color: #555;
    margin-left: auto;
  }

  .pool-type-pills {
    display: flex;
    gap: 4px;
    margin-left: 8px;
  }

  .type-pill {
    font-family: 'JetBrains Mono', monospace;
    font-size: 8px;
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
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: #555;
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

  .mosaic-col-header.col-hl { color: #aaa; }

  a.col-name {
    color: inherit;
    text-decoration: none;
  }
  a.col-name:hover {
    color: #00cc66;
    text-decoration: underline;
  }

  .col-pct, .row-pct {
    font-size: 10px;
    color: #667;
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
    font-size: 10px;
    font-weight: 600;
    color: #555;
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

  .mosaic-row-label.row-hl { color: #aaa; }

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
    font-size: 9px;
    font-weight: 600;
    color: #ccc;
    white-space: nowrap;
  }

  .axis-usd {
    font-size: 9px;
    color: #00cc66;
    white-space: nowrap;
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
    color: #e0e0e0;
    letter-spacing: 0.04em;
  }

  .vault-status-badge {
    font-family: 'JetBrains Mono', monospace;
    font-size: 8px;
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
    font-size: 10px;
    color: #555;
    background: none;
    border: none;
    padding: 2px 0;
    cursor: pointer;
    display: block;
    text-align: left;
    transition: color 0.15s;
  }

  .pubkey-btn:hover { color: #999; }

  .vault-card-body {
    padding: 12px 16px;
    flex: 1;
  }

  .vault-section-title {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.12em;
    color: #444;
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
  }

  .addr-chain {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    color: #666;
    min-width: 40px;
  }

  .addr-val {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #555;
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
    color: #444;
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

  .vault-stat-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 8px;
    font-weight: 600;
    letter-spacing: 0.1em;
    color: #444;
    display: block;
    margin-bottom: 4px;
  }

  .vault-stat-val {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    font-weight: 600;
    color: #aaa;
  }

  .vault-stat-val.accent { color: #00cc66; }

  .expand-toggle {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: #555;
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

  .expand-toggle:hover { color: #999; }

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
    color: #888;
  }

  .asset-logo {
    width: 16px;
    height: 16px;
    border-radius: 50%;
  }

  .asset-vals {
    display: flex;
    gap: 12px;
    align-items: center;
  }

  .asset-amount {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #777;
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
  }

  @media (max-width: 600px) {
    .metrics {
      grid-template-columns: repeat(2, 1fr);
    }

    .metric-val {
      font-size: 18px;
    }

    .tab-btn {
      font-size: 10px;
      padding: 8px 12px;
    }
  }
</style>
