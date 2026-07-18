<script>
  import { onMount } from 'svelte';
  import { getAssetLogo, getChainLogo, getAssetDisplayName } from '$lib/constants/assets';
  import {
    formatCryptoAmount,
    formatUSD,
    formatUSDWithDecimals,
    getAddressSuffix,
    shortenAddress
  } from '$lib/utils/formatting';
  import { getExplorerUrl } from '$lib/utils/network';
  import { fetchTreasurySnapshot } from '$lib/treasury/api';

  const NOTE_TEXT =
    'The Original section shows the live treasury module address, including module balances, LP positions, and any node bonds. Active THOR addresses include THOR balances, TCY staking positions, LP positions, and node bonds. External-chain addresses show native balances, and the New ETH Treasury also lists Ethereum ERC-20 holdings plus supported BSC, Avalanche, and Base balances for the same EVM address.';

  let loading = true;
  let error = null;
  let runePrice = 0;
  let sections = [];
  let consolidatedSection = null;
  let snapshotWarning = '';
  let viewportWidth = 1440;

  function formatUsdValue(value) {
    if (!value) return '$0';
    return value < 100 ? formatUSDWithDecimals(value, 2) : formatUSD(value);
  }

  /**
   * @param {Event} event
   * @param {string} fallbackSrc
   */
  function useImageFallback(event, fallbackSrc) {
    const image = /** @type {HTMLImageElement} */ (event.currentTarget);
    image.onerror = null;
    image.src = fallbackSrc;
  }

  /** @param {Event} event */
  function useCoinFallback(event) {
    useImageFallback(event, '/assets/coins/fallback-logo.svg');
  }

  /** @param {Event} event */
  function useChainFallback(event) {
    useImageFallback(event, '/assets/chains/fallback-logo.svg');
  }

  function hasKnownUsdValue(value) {
    return value != null && Number.isFinite(value);
  }

  function formatHoldingUsdValue(holding) {
    if (holding?.hasMissingPrice) {
      if (hasKnownUsdValue(holding.usdValue) && holding.usdValue > 0) {
        return `>= ${formatUsdValue(holding.usdValue)}`;
      }

      return 'Unpriced';
    }

    return formatUsdValue(holding?.usdValue || 0);
  }

  function formatAmount(value) {
    if (!value) return '0.00';

    const absoluteValue = Math.abs(value);
    if (absoluteValue >= 1000) return formatCryptoAmount(value, 2);
    if (absoluteValue >= 1) return formatCryptoAmount(value, 4);
    if (absoluteValue >= 0.01) return formatCryptoAmount(value, 6);
    return formatCryptoAmount(value, 8);
  }

  function summarizeSection(entries) {
    return entries.reduce(
      (summary, entry) => {
        summary.walletValue += entry.summary.walletValue;
        summary.stakeValue += entry.summary.stakeValue || 0;
        summary.lpValue += entry.summary.lpValue;
        summary.bondValue += entry.summary.bondValue;
        summary.totalValue += entry.summary.totalValue;
        return summary;
      },
      {
        addressCount: entries.length,
        walletValue: 0,
        stakeValue: 0,
        lpValue: 0,
        bondValue: 0,
        totalValue: 0
      }
    );
  }

  function hasVisibleBalances(entry) {
    return entry.balances.length > 0;
  }

  function hasVisibleStakes(entry) {
    return (entry.stakedPositions || []).length > 0;
  }

  function hasVisibleBonds(entry) {
    return entry.bonds.length > 0;
  }

  function shouldShowEntryEmptyState(entry) {
    return !hasVisibleBalances(entry)
      && !hasVisibleStakes(entry)
      && entry.lpPositions.length === 0
      && !entry.showLpSection
      && !hasVisibleBonds(entry);
  }

  function usesCompactBondLayout(entry) {
    return Boolean(
      entry?.compactBondLayout &&
        hasVisibleBalances(entry) &&
        hasVisibleBonds(entry) &&
        (entry.lpPositions.length > 0 || entry.showLpSection)
    );
  }

  function sortHoldingsByValue(holdings) {
    return holdings.slice().sort((left, right) => {
      const leftValue = left.usdValue ?? left.amount;
      const rightValue = right.usdValue ?? right.amount;
      return rightValue - leftValue;
    });
  }

  function buildConsolidatedBalances(entries) {
    const balancesByAsset = new Map();

    for (const entry of entries) {
      for (const balance of entry.balances) {
        const existing = balancesByAsset.get(balance.asset) || {
          asset: balance.asset,
          chain: balance.chain,
          amount: 0,
          usdValue: 0,
          hasMissingPrice: false
        };

        existing.amount += Number(balance.amount || 0);
        existing.usdValue += Number(balance.usdValue || 0);
        existing.hasMissingPrice ||= balance.hasMissingPrice || !hasKnownUsdValue(balance.usdValue);
        balancesByAsset.set(balance.asset, existing);
      }
    }

    return sortHoldingsByValue(Array.from(balancesByAsset.values()));
  }

  function buildConsolidatedLpPositions(entries) {
    const positionsByPool = new Map();

    for (const entry of entries) {
      for (const position of entry.lpPositions) {
        const existing = positionsByPool.get(position.fullPool) || {
          pool: position.pool,
          fullPool: position.fullPool,
          assetAmount: 0,
          runeAmount: 0,
          assetUsdValue: 0,
          runeUsdValue: 0,
          totalUsdValue: 0
        };

        existing.assetAmount += Number(position.assetAmount || 0);
        existing.runeAmount += Number(position.runeAmount || 0);
        existing.assetUsdValue += Number(position.assetUsdValue || 0);
        existing.runeUsdValue += Number(position.runeUsdValue || 0);
        existing.totalUsdValue += Number(position.totalUsdValue || 0);
        positionsByPool.set(position.fullPool, existing);
      }
    }

    return Array.from(positionsByPool.values()).sort(
      (left, right) => right.totalUsdValue - left.totalUsdValue
    );
  }

  function buildConsolidatedStakedPositions(entries) {
    const positionsByAsset = new Map();

    for (const entry of entries) {
      for (const position of entry.stakedPositions || []) {
        const existing = positionsByAsset.get(position.asset) || {
          asset: position.asset,
          chain: position.chain,
          amount: 0,
          usdValue: 0,
          hasMissingPrice: false
        };

        existing.amount += Number(position.amount || 0);
        existing.usdValue += Number(position.usdValue || 0);
        existing.hasMissingPrice ||= position.hasMissingPrice || !hasKnownUsdValue(position.usdValue);
        positionsByAsset.set(position.asset, existing);
      }
    }

    return sortHoldingsByValue(Array.from(positionsByAsset.values()));
  }

  function buildConsolidatedBonds(entries) {
    const bondsByNode = new Map();

    for (const entry of entries) {
      for (const bond of entry.bonds) {
        const key = bond.nodeAddress.toLowerCase();
        const existing = bondsByNode.get(key) || {
          nodeAddress: bond.nodeAddress,
          nodeStatus: bond.nodeStatus,
          amount: 0
        };

        existing.amount += Number(bond.amount || 0);
        if (existing.nodeStatus !== bond.nodeStatus) {
          existing.nodeStatus = 'Mixed';
        }
        bondsByNode.set(key, existing);
      }
    }

    return Array.from(bondsByNode.values()).sort((left, right) => right.amount - left.amount);
  }

  function buildConsolidatedSection(sourceSections = []) {
    const entries = sourceSections.flatMap((section) => section.entries);

    return {
      key: 'consolidated',
      title: 'Consolidated Positions',
      description: `Aggregated balances, staked positions, LP positions, and node bonds across ${entries.length} tracked treasury addresses.`,
      balances: buildConsolidatedBalances(entries),
      stakedPositions: buildConsolidatedStakedPositions(entries),
      lpPositions: buildConsolidatedLpPositions(entries),
      bonds: buildConsolidatedBonds(entries),
      summary: summarizeSection(entries)
    };
  }

  function countUnpricedBalances(sourceSections = []) {
    return sourceSections
      .flatMap((section) => section.entries)
      .flatMap((entry) => [...entry.balances, ...(entry.stakedPositions || [])])
      .filter((balance) => balance.hasMissingPrice)
      .length;
  }

  function getActiveTileColumnCount(width = viewportWidth) {
    if (width <= 900) return 1;
    if (width <= 1320) return 2;
    return 3;
  }

  function estimateEntryTileWeight(entry) {
    let weight = 140;

    if (entry.entryError || shouldShowEntryEmptyState(entry)) {
      return weight + 40;
    }

    const balanceWeight = hasVisibleBalances(entry) ? 36 + entry.balances.length * 38 : 0;
    const stakeWeight = hasVisibleStakes(entry) ? 36 + entry.stakedPositions.length * 38 : 0;
    const lpWeight =
      entry.lpPositions.length > 0 || entry.showLpSection
        ? 32 + Math.max(entry.lpPositions.length, 1) * 52
        : 0;
    const bondWeight = hasVisibleBonds(entry) ? 32 + entry.bonds.length * 38 : 0;

    if (usesCompactBondLayout(entry)) {
      return weight + Math.max(balanceWeight + bondWeight, lpWeight);
    }

    if (hasVisibleBalances(entry)) {
      weight += balanceWeight;
    }

    if (hasVisibleStakes(entry)) {
      weight += stakeWeight;
    }

    if (entry.lpPositions.length > 0 || entry.showLpSection) {
      weight += lpWeight;
    }

    if (hasVisibleBonds(entry)) {
      weight += bondWeight;
    }

    return weight;
  }

  function buildEntryColumns(entries = [], columnCount = 1) {
    if (columnCount <= 1) {
      return [entries];
    }

    const columns = Array.from({ length: columnCount }, () => []);
    const columnHeights = Array(columnCount).fill(0);

    for (const entry of entries) {
      const targetColumn = columnHeights.indexOf(Math.min(...columnHeights));
      columns[targetColumn].push(entry);
      columnHeights[targetColumn] += estimateEntryTileWeight(entry);
    }

    return columns.filter((column) => column.length > 0);
  }

  function getSectionEntryColumns(section) {
    if (section?.key !== 'active') {
      return [section.entries];
    }

    return buildEntryColumns(section.entries, getActiveTileColumnCount());
  }

  function hydrateSnapshotEntry(entry) {
    return {
      ...entry,
      explorerUrl: getExplorerUrl(entry.chain, entry.address)
    };
  }

  async function loadTracker() {
    loading = true;
    error = null;
    snapshotWarning = '';

    try {
      const payload = await fetchTreasurySnapshot();
      if (!Array.isArray(payload?.sections)) {
        throw new Error('Treasury snapshot returned an invalid payload');
      }

      runePrice = Number(payload.runePrice || 0);
      sections = payload.sections.map((section) => ({
        ...section,
        entries: (section.entries || []).map(hydrateSnapshotEntry)
      }));
      consolidatedSection = payload.consolidatedSection || buildConsolidatedSection(sections);
      snapshotWarning = payload.stale
        ? 'Showing the last successful Treasury snapshot while providers recover.'
        : payload.partial
          ? `${payload.warnings?.length || 1} provider segment${payload.warnings?.length === 1 ? '' : 's'} reused last successful data.`
          : '';
    } catch (err) {
      console.error('Failed to load Treasury snapshot:', err);
      error = 'Failed to load Treasury Tracker.';
      sections = [];
      consolidatedSection = null;
    } finally {
      loading = false;
    }
  }

  $: totalSummary = summarizeSection(sections.flatMap((section) => section.entries));
  $: unpricedBalanceCount = countUnpricedBalances(sections);

  onMount(() => {
    loadTracker();
  });
</script>

<svelte:window bind:innerWidth={viewportWidth} />

<div class="tt">
  {#if loading}
    <div class="loading-wrap">Loading treasury balances...</div>
  {:else if error}
    <div class="loading-wrap err-text">{error}</div>
  {:else}
    <div class="dashboard-header">
      <div class="metrics">
        <div class="metric">
          <div class="metric-val accent">{formatUSD(totalSummary.totalValue)}</div>
          <div class="metric-key">TOTAL VALUE</div>
        </div>
        <div class="metric">
          <div class="metric-val">{formatUSD(sections.find((s) => s.key === 'original')?.summary.totalValue || 0)}</div>
          <div class="metric-key">ORIGINAL</div>
        </div>
        <div class="metric">
          <div class="metric-val">{formatUSD(sections.find((s) => s.key === 'active')?.summary.totalValue || 0)}</div>
          <div class="metric-key">ACTIVE</div>
        </div>
        <div class="metric">
          <div class="metric-val">{totalSummary.addressCount}</div>
          <div class="metric-key">ADDRESSES</div>
        </div>
      </div>
    </div>

    {#if unpricedBalanceCount > 0}
      <div class="scope-note warn-text">
        {unpricedBalanceCount} balance{unpricedBalanceCount === 1 ? '' : 's'} lack reliable pricing — excluded from USD totals.
      </div>
    {/if}

    {#if snapshotWarning}
      <div class="scope-note warn-text">{snapshotWarning}</div>
    {/if}

      {#if consolidatedSection}
        <section class="data-section">
          <div class="section-head">
            <h3>CONSOLIDATED POSITIONS</h3>
            <span class="section-sub">Across {consolidatedSection.summary.addressCount} addresses</span>
            <div class="head-stats">
              <span>Wallets <strong>{formatUSD(consolidatedSection.summary.walletValue)}</strong></span>
              <span class="sep">|</span>
              <span>Staked <strong>{formatUSD(consolidatedSection.summary.stakeValue || 0)}</strong></span>
              <span class="sep">|</span>
              <span>LP <strong>{formatUSD(consolidatedSection.summary.lpValue)}</strong></span>
              <span class="sep">|</span>
              <span>Bonds <strong>{formatUSD(consolidatedSection.summary.bondValue)}</strong></span>
            </div>
          </div>

          <div class="consol-grid">
            <div class="consol-col">
              <div class="col-head">BALANCES</div>
              {#if consolidatedSection.balances.length > 0}
                {#each consolidatedSection.balances as balance}
                  <div class="asset-row">
                    <div class="asset-left">
                      <div class="logo-wrap">
                        <img src={getAssetLogo(balance.asset) || '/assets/coins/fallback-logo.svg'} alt={getAssetDisplayName(balance.asset)} class="asset-icon" on:error={useCoinFallback} />
                        <div class="chain-badge"><img src={getChainLogo(balance.chain) || '/assets/chains/fallback-logo.svg'} alt={balance.chain} class="chain-icon" on:error={useChainFallback} /></div>
                      </div>
                      <span class="asset-name">{getAssetDisplayName(balance.asset)}</span>
                    </div>
                    <div class="asset-right">
                      <span class="mono">{formatAmount(balance.amount)}</span>
                      <span class="dim">{formatHoldingUsdValue(balance)}</span>
                    </div>
                  </div>
                {/each}
              {:else}
                <div class="empty">No balances.</div>
              {/if}
            </div>

            <div class="consol-col">
              <div class="col-head">STAKED POSITIONS</div>
              {#if (consolidatedSection.stakedPositions || []).length > 0}
                {#each consolidatedSection.stakedPositions as position}
                  <div class="asset-row">
                    <div class="asset-left">
                      <div class="logo-wrap">
                        <img src={getAssetLogo(position.asset) || '/assets/coins/fallback-logo.svg'} alt={getAssetDisplayName(position.asset)} class="asset-icon" on:error={useCoinFallback} />
                        <div class="chain-badge"><img src={getChainLogo(position.chain) || '/assets/chains/fallback-logo.svg'} alt={position.chain} class="chain-icon" on:error={useChainFallback} /></div>
                      </div>
                      <span class="asset-name">{getAssetDisplayName(position.asset)}</span>
                    </div>
                    <div class="asset-right">
                      <span class="mono">{formatAmount(position.amount)}</span>
                      <span class="dim">{formatHoldingUsdValue(position)}</span>
                    </div>
                  </div>
                {/each}
              {:else}
                <div class="empty">No staked positions.</div>
              {/if}
            </div>

            <div class="consol-col">
              <div class="col-head">LP POSITIONS</div>
              {#if consolidatedSection.lpPositions.length > 0}
                {#each consolidatedSection.lpPositions as position}
                  <div class="lp-row">
                    <div class="lp-top">
                      <div class="asset-left">
                        <div class="logo-wrap">
                          <img src={getAssetLogo(position.fullPool) || '/assets/coins/fallback-logo.svg'} alt={position.pool} class="asset-icon" on:error={useCoinFallback} />
                          <div class="chain-badge"><img src={getChainLogo(position.fullPool.split('.')[0]) || '/assets/chains/fallback-logo.svg'} alt={position.fullPool.split('.')[0]} class="chain-icon" on:error={useChainFallback} /></div>
                        </div>
                        <span class="asset-name">{position.pool}</span>
                      </div>
                      <strong class="mono">{formatUsdValue(position.totalUsdValue)}</strong>
                    </div>
                    <div class="lp-detail">
                      <span>{formatAmount(position.assetAmount)} {position.pool} <span class="dim">{formatUsdValue(position.assetUsdValue)}</span></span>
                      <span>{formatAmount(position.runeAmount)} RUNE <span class="dim">{formatUsdValue(position.runeUsdValue)}</span></span>
                    </div>
                  </div>
                {/each}
              {:else}
                <div class="empty">No LP positions.</div>
              {/if}
            </div>

            <div class="consol-col">
              <div class="col-head">NODE BONDS</div>
              {#if consolidatedSection.bonds.length > 0}
                {#each consolidatedSection.bonds as bond}
                  <div class="asset-row">
                    <div class="asset-left">
                      <span class="bond-tag">{getAddressSuffix(bond.nodeAddress, 4)}</span>
                      <span class="dim">{bond.nodeStatus}</span>
                    </div>
                    <div class="asset-right">
                      <span class="mono">{formatAmount(bond.amount)} RUNE</span>
                      <span class="dim">{formatUsdValue(bond.amount * runePrice)}</span>
                    </div>
                  </div>
                {/each}
              {:else}
                <div class="empty">No bonds.</div>
              {/if}
            </div>
          </div>
        </section>
      {/if}

      {#each sections as section}
        <section class="data-section">
          <div class="section-head">
            <h3>{section.title}</h3>
            <span class="section-sub">{section.description}</span>
            <div class="head-stats">
              <span>W <strong>{formatUSD(section.summary.walletValue)}</strong></span>
              <span class="sep">|</span>
              <span>S <strong>{formatUSD(section.summary.stakeValue || 0)}</strong></span>
              <span class="sep">|</span>
              <span>LP <strong>{formatUSD(section.summary.lpValue)}</strong></span>
              <span class="sep">|</span>
              <span>B <strong>{formatUSD(section.summary.bondValue)}</strong></span>
              <span class="sep">|</span>
              <span>Total <strong class="accent">{formatUSD(section.summary.totalValue)}</strong></span>
            </div>
          </div>

          <div
            class="entries-grid"
            class:entries-grid--tiled={section.key === 'active' && getActiveTileColumnCount() > 1}
            style={`--entry-columns: ${section.key === 'active' ? getActiveTileColumnCount() : 1};`}
          >
            {#each getSectionEntryColumns(section) as column}
              <div class="entry-column">
                {#each column as entry}
                  <div class="entry">
                    <div class="entry-head">
                      <div class="entry-id">
                        <div class="logo-wrap">
                          <img src={getAssetLogo(entry.primaryAsset) || '/assets/coins/fallback-logo.svg'} alt={entry.label} class="asset-icon" on:error={useCoinFallback} />
                          <div class="chain-badge"><img src={getChainLogo(entry.chain) || '/assets/chains/fallback-logo.svg'} alt={entry.chain} class="chain-icon" on:error={useChainFallback} /></div>
                        </div>
                        <span class="entry-name">{entry.label}</span>
                        <span class="chain-tag">{entry.chain}</span>
                        {#if entry.explorerUrl}
                          <a class="entry-addr" href={entry.explorerUrl} target="_blank" rel="noreferrer" title={entry.address}>{shortenAddress(entry.address, 12, 8)}</a>
                        {:else}
                          <span class="entry-addr">{shortenAddress(entry.address, 12, 8)}</span>
                        {/if}
                      </div>
                      <div class="entry-summary">
                        <span>W {formatUsdValue(entry.summary.walletValue)}</span>
                        <span class="sep">|</span>
                        <span>S {formatUsdValue(entry.summary.stakeValue || 0)}</span>
                        <span class="sep">|</span>
                        <span>LP {formatUsdValue(entry.summary.lpValue)}</span>
                        <span class="sep">|</span>
                        <span>B {formatUsdValue(entry.summary.bondValue)}</span>
                        <span class="sep">|</span>
                        <strong class="accent">{formatUsdValue(entry.summary.totalValue)}</strong>
                      </div>
                    </div>

                    {#if entry.entryError}
                      <div class="entry-err">{entry.entryError}</div>
                    {:else if shouldShowEntryEmptyState(entry)}
                      <div class="empty">No balances or positions found.</div>
                    {:else}
                      <div class="entry-body" class:entry-body--compact-bonds={usesCompactBondLayout(entry)}>
                        {#if hasVisibleBalances(entry)}
                          <div class="detail-block detail-block--balances">
                            <div class="detail-label">BALANCES</div>
                            {#each entry.balances as balance}
                              <div class="asset-row">
                                <div class="asset-left">
                                  <div class="logo-wrap sm">
                                    <img src={getAssetLogo(balance.asset) || '/assets/coins/fallback-logo.svg'} alt={getAssetDisplayName(balance.asset)} class="asset-icon" on:error={useCoinFallback} />
                                    <div class="chain-badge"><img src={getChainLogo(balance.chain) || '/assets/chains/fallback-logo.svg'} alt={balance.chain} class="chain-icon" on:error={useChainFallback} /></div>
                                  </div>
                                  <span class="asset-name">{balance.displayName || getAssetDisplayName(balance.asset)}</span>
                                </div>
                                <div class="asset-right">
                                  <span class="mono">{formatAmount(balance.amount)}</span>
                                  <span class="dim">{formatHoldingUsdValue(balance)}</span>
                                </div>
                              </div>
                            {/each}
                          </div>
                        {/if}

                        {#if hasVisibleStakes(entry)}
                          <div class="detail-block detail-block--stakes">
                            <div class="detail-label">STAKED POSITIONS</div>
                            {#each entry.stakedPositions as position}
                              <div class="asset-row">
                                <div class="asset-left">
                                  <div class="logo-wrap sm">
                                    <img src={getAssetLogo(position.asset) || '/assets/coins/fallback-logo.svg'} alt={getAssetDisplayName(position.asset)} class="asset-icon" on:error={useCoinFallback} />
                                    <div class="chain-badge"><img src={getChainLogo(position.chain) || '/assets/chains/fallback-logo.svg'} alt={position.chain} class="chain-icon" on:error={useChainFallback} /></div>
                                  </div>
                                  <span class="asset-name">{getAssetDisplayName(position.asset)}</span>
                                </div>
                                <div class="asset-right">
                                  <span class="mono">{formatAmount(position.amount)}</span>
                                  <span class="dim">{formatHoldingUsdValue(position)}</span>
                                </div>
                              </div>
                            {/each}
                          </div>
                        {/if}

                        {#if entry.lpPositions.length > 0 || entry.showLpSection}
                          <div class="detail-block detail-block--lp">
                            <div class="detail-label">LP POSITIONS</div>
                            {#if entry.lpPositions.length > 0}
                              {#each entry.lpPositions as position}
                                <div class="lp-row">
                                  <div class="lp-top">
                                    <div class="asset-left">
                                      <div class="logo-wrap sm">
                                        <img src={getAssetLogo(position.fullPool) || '/assets/coins/fallback-logo.svg'} alt={position.pool} class="asset-icon" on:error={useCoinFallback} />
                                        <div class="chain-badge"><img src={getChainLogo(position.fullPool.split('.')[0]) || '/assets/chains/fallback-logo.svg'} alt={position.fullPool.split('.')[0]} class="chain-icon" on:error={useChainFallback} /></div>
                                      </div>
                                      <span class="asset-name">{position.pool}</span>
                                    </div>
                                    <strong class="mono">{formatUsdValue(position.totalUsdValue)}</strong>
                                  </div>
                                  <div class="lp-detail">
                                    <span>{formatAmount(position.assetAmount)} {position.pool} <span class="dim">{formatUsdValue(position.assetUsdValue)}</span></span>
                                    <span>{formatAmount(position.runeAmount)} RUNE <span class="dim">{formatUsdValue(position.runeUsdValue)}</span></span>
                                  </div>
                                </div>
                              {/each}
                            {:else}
                              <div class="empty">No active LP positions.</div>
                            {/if}
                          </div>
                        {/if}

                        {#if hasVisibleBonds(entry)}
                          <div class="detail-block detail-block--bonds">
                            <div class="detail-label">NODE BONDS</div>
                            {#each entry.bonds as bond}
                              <div class="asset-row">
                                <div class="asset-left">
                                  <span class="bond-tag">{getAddressSuffix(bond.nodeAddress, 4)}</span>
                                  <span class="dim">{bond.nodeStatus}</span>
                                </div>
                                <div class="asset-right">
                                  <span class="mono">{formatAmount(bond.amount)} RUNE</span>
                                  <span class="dim">{formatUsdValue(bond.amount * runePrice)}</span>
                                </div>
                              </div>
                            {/each}
                          </div>
                        {/if}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/each}
          </div>
        </section>
      {/each}
    {/if}
</div>

<style>
  .tt {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0;
    font-family: 'DM Sans', -apple-system, sans-serif;
    color: #c8c8c8;
  }

  .loading-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 60px 20px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: #666;
  }

  .err-text { color: #cc4444; }

  .dashboard-header {
    background: #0d0d0d;
  }

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

  .metric-key {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.12em;
    color: #555;
    text-transform: uppercase;
  }

  .scope-note {
    padding: 8px 16px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #555;
    background: #0a0a0a;
    border-bottom: 1px solid #1a1a1a;
  }

  .warn-text { color: #d4a017; }

  .data-section {
    border-bottom: 1px solid #1a1a1a;
  }

  .section-head {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 14px 16px 10px;
    background: #0a0a0a;
    border-bottom: 1px solid #141414;
    flex-wrap: wrap;
  }

  .section-head h3 {
    margin: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: #888;
    text-transform: uppercase;
  }

  .section-sub {
    font-size: 11px;
    color: #444;
  }

  .head-stats {
    margin-left: auto;
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #555;
  }

  .head-stats strong { color: #ccc; }
  .sep { color: #333; margin: 0 2px; }
  .accent { color: #00cc66; }

  .consol-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1px;
    background: #1a1a1a;
  }

  .consol-col {
    background: #0d0d0d;
  }

  .col-head {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.1em;
    color: #555;
    text-transform: uppercase;
    padding: 10px 14px 8px;
    border-bottom: 1px solid #141414;
  }

  .asset-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid #111;
    transition: background 0.1s;
  }

  .asset-row:hover { background: #141414; }
  .asset-row:last-child { border-bottom: none; }

  .asset-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .asset-name {
    font-size: 13px;
    color: #ccc;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .asset-right {
    text-align: right;
    flex-shrink: 0;
  }

  .asset-right .mono {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #ccc;
  }

  .asset-right .dim {
    display: block;
    font-size: 11px;
    color: #555;
  }

  .logo-wrap {
    position: relative;
    width: 24px;
    height: 24px;
    flex-shrink: 0;
  }

  .logo-wrap.sm {
    width: 20px;
    height: 20px;
  }

  .asset-icon {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .chain-badge {
    position: absolute;
    right: -3px;
    bottom: -3px;
    width: 12px;
    height: 12px;
  }

  .logo-wrap.sm .chain-badge {
    width: 10px;
    height: 10px;
    right: -2px;
    bottom: -2px;
  }

  .chain-icon {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .lp-row {
    padding: 8px 14px;
    border-bottom: 1px solid #111;
    transition: background 0.1s;
  }

  .lp-row:last-child { border-bottom: none; }
  .lp-row:hover { background: #141414; }

  .lp-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .lp-top strong {
    color: #ccc;
    font-size: 12px;
  }

  .lp-detail {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-left: 32px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #666;
  }

  .bond-tag {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 1px 6px;
    background: rgba(85, 136, 204, 0.15);
    color: #5588cc;
    border-radius: 2px;
  }

  .entries-grid {
    border-top: 1px solid #1a1a1a;
  }

  .entries-grid--tiled {
    display: grid;
    grid-template-columns: repeat(var(--entry-columns), minmax(0, 1fr));
    gap: 14px;
    padding: 14px;
    background: #0a0a0a;
    border-top: 1px solid #1a1a1a;
  }

  .entry-column {
    display: flex;
    flex-direction: column;
  }

  .entry {
    background: #0d0d0d;
    border-bottom: 1px solid #1a1a1a;
  }

  .entries-grid--tiled .entry {
    margin: 0 0 14px;
    border: 1px solid #1a1a1a;
    box-sizing: border-box;
  }

  .entries-grid--tiled .entry:last-child {
    margin-bottom: 0;
  }

  .entry-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    background: #0a0a0a;
    border-bottom: 1px solid #141414;
    flex-wrap: wrap;
  }

  .entry-id {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .entry-name {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    font-weight: 700;
    color: #ccc;
    letter-spacing: 0.03em;
  }

  .chain-tag {
    font-family: 'JetBrains Mono', monospace;
    font-size: 8px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.06);
    color: #666;
  }

  .entry-addr {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #5588cc;
    text-decoration: none;
  }

  .entry-addr:hover { color: #77aaee; text-decoration: underline; }

  .entry-summary {
    margin-left: auto;
    display: flex;
    align-items: baseline;
    gap: 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #555;
    flex-shrink: 0;
  }

  .entry-summary strong { color: #ccc; }

  .entry-err {
    padding: 10px 16px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #cc4444;
    background: rgba(204, 68, 68, 0.08);
  }

  .entry-body {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 1px;
    background: #1a1a1a;
  }

  .entry-body--compact-bonds {
    grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr);
    grid-template-areas:
      'balances lp'
      'bonds lp';
    align-items: start;
  }

  .entry-body--compact-bonds .detail-block--balances {
    grid-area: balances;
  }

  .entry-body--compact-bonds .detail-block--bonds {
    grid-area: bonds;
  }

  .entry-body--compact-bonds .detail-block--lp {
    grid-area: lp;
    align-self: stretch;
  }

  .entry-body--compact-bonds .detail-block--bonds .asset-row {
    padding-top: 6px;
    padding-bottom: 6px;
  }

  .entry-body--compact-bonds .detail-block--bonds .detail-label {
    padding-bottom: 2px;
  }

  .detail-block {
    background: #0d0d0d;
  }

  .detail-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.1em;
    color: #444;
    text-transform: uppercase;
    padding: 8px 14px 4px;
  }

  .empty {
    padding: 16px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #444;
  }

  .mono { font-family: 'JetBrains Mono', monospace; }
  .dim { color: #555; }

  @media (max-width: 900px) {
    .consol-grid { grid-template-columns: 1fr; }
    .entry-body { grid-template-columns: 1fr; }
    .entry-body--compact-bonds {
      grid-template-columns: 1fr;
      grid-template-areas: none;
    }

    .entry-body--compact-bonds .detail-block--balances,
    .entry-body--compact-bonds .detail-block--lp,
    .entry-body--compact-bonds .detail-block--bonds {
      grid-area: auto;
    }

    .entries-grid--tiled {
      grid-template-columns: 1fr;
      padding: 0;
      background: transparent;
      gap: 0;
    }

    .entries-grid--tiled .entry {
      margin: 0;
      border-left: none;
      border-right: none;
      border-top: none;
    }

    .metrics {
      grid-template-columns: repeat(2, 1fr);
    }

    .metric:nth-child(n+3) {
      border-top: 1px solid #1a1a1a;
    }

    .head-stats {
      margin-left: 0;
      flex-basis: 100%;
    }

    .entry-head {
      flex-direction: column;
      align-items: flex-start;
    }

    .entry-summary { margin-left: 0; }
  }

  @media (max-width: 600px) {
    .metric-val { font-size: 20px; }
    .metric { padding: 14px 12px; }
    .lp-detail { padding-left: 0; }
  }
</style>
