<script>
  import { onMount } from 'svelte';
  import { thornode } from '$lib/api';
  import { getAssetLogo, getChainLogo, getAssetDisplayName } from '$lib/constants/assets';
  import {
    formatCryptoAmount,
    formatUSD,
    formatUSDWithDecimals,
    getAddressSuffix,
    shortenAddress
  } from '$lib/utils/formatting';
  import { denomToAsset } from '$lib/utils/wallet';
  import { fromBaseUnit } from '$lib/utils/blockchain';
  import { calculateTotalBondValue, getBondsForAddresses } from '$lib/utils/nodes';
  import { getExplorerUrl, getRunePrice } from '$lib/utils/network';
  import {
    getThorTreasuryAddresses,
    NATIVE_ASSET_BY_CHAIN,
    TREASURY_SECTIONS
  } from '$lib/treasury/config';
  import {
    fetchEthHoldings,
    fetchEvmChainHoldings,
    fetchNativeBalance,
    hydrateMissingEvmTokenPrices
  } from '$lib/treasury/fetchers';

  const NOTE_TEXT =
    'The Original section shows the live treasury module address, including module balances, LP positions, and any node bonds. Active THOR addresses include THOR balances, LP positions, and node bonds. External-chain addresses show native balances, and the New ETH Treasury also lists Ethereum ERC-20 holdings plus supported BSC, Avalanche, and Base balances for the same EVM address.';
  const LP_CONCURRENCY = 8;

  let loading = true;
  let error = null;
  let runePrice = 0;
  let assetPrices = {};
  let lpAssets = [];
  let sections = [];
  let consolidatedSection = null;
  let viewportWidth = 1440;

  function formatUsdValue(value) {
    if (!value) return '$0';
    return value < 100 ? formatUSDWithDecimals(value, 2) : formatUSD(value);
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

  function isNotFoundError(err) {
    const message = err?.message || String(err);
    return message.includes('404') || message.toLowerCase().includes('not found');
  }

  function sumUsd(items, key = 'usdValue') {
    return items.reduce((total, item) => total + Number(item[key] || 0), 0);
  }

  function getAssetUsdValue(asset, amount) {
    const price = assetPrices[asset];
    if (!price && price !== 0) return null;
    return amount * price;
  }

  function summarizeEntry(entry) {
    const walletValue = sumUsd(entry.balances);
    const lpValue = entry.lpPositions.reduce(
      (total, position) => total + Number(position.totalUsdValue || 0),
      0
    );
    const bondValue = calculateTotalBondValue(entry.bonds, runePrice);

    return {
      walletValue,
      lpValue,
      bondValue,
      totalValue: walletValue + lpValue + bondValue
    };
  }

  function summarizeSection(entries) {
    return entries.reduce(
      (summary, entry) => {
        summary.walletValue += entry.summary.walletValue;
        summary.lpValue += entry.summary.lpValue;
        summary.bondValue += entry.summary.bondValue;
        summary.totalValue += entry.summary.totalValue;
        return summary;
      },
      {
        addressCount: entries.length,
        walletValue: 0,
        lpValue: 0,
        bondValue: 0,
        totalValue: 0
      }
    );
  }

  function buildBondsByAddress(bonds) {
    return bonds.reduce((map, bond) => {
      const key = bond.bondAddress.toLowerCase();
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push(bond);
      return map;
    }, new Map());
  }

  function buildTrackedEvmAssetsByChain(pools) {
    const chains = ['BSC', 'AVAX', 'BASE'];

    return chains.reduce((map, chain) => {
      map[chain] = pools
        .filter((pool) => pool.asset.startsWith(`${chain}.`) && pool.asset.includes('-0X'))
        .map((pool) => pool.asset);
      return map;
    }, {});
  }

  function resolveSectionEntry(entry, treasuryModule) {
    if (entry.addressSource !== 'treasury-module') {
      return entry;
    }

    return {
      ...entry,
      address: treasuryModule?.address || entry.address,
      moduleBalances: treasuryModule?.coins || []
    };
  }

  function buildResolvedSections(treasuryModule) {
    return TREASURY_SECTIONS.map((section) => ({
      ...section,
      addresses: section.addresses.map((entry) => resolveSectionEntry(entry, treasuryModule))
    }));
  }

  function mergeBalances(primaryBalances = [], secondaryBalances = []) {
    const balancesByDenom = new Map();

    for (const balance of secondaryBalances) {
      if (balance?.denom) {
        balancesByDenom.set(balance.denom, balance);
      }
    }

    for (const balance of primaryBalances) {
      if (balance?.denom) {
        balancesByDenom.set(balance.denom, balance);
      }
    }

    return Array.from(balancesByDenom.values());
  }

  function hasVisibleBalances(entry) {
    return entry.balances.length > 0;
  }

  function hasVisibleBonds(entry) {
    return entry.bonds.length > 0;
  }

  function shouldShowEntryEmptyState(entry) {
    return !hasVisibleBalances(entry) && entry.lpPositions.length === 0 && !entry.showLpSection && !hasVisibleBonds(entry);
  }

  function usesCompactBondLayout(entry) {
    return Boolean(
      entry?.compactBondLayout &&
        hasVisibleBalances(entry) &&
        hasVisibleBonds(entry) &&
        (entry.lpPositions.length > 0 || entry.showLpSection)
    );
  }

  function finalizeEntry(entry) {
    const summary = summarizeEntry(entry);

    return {
      ...entry,
      explorerUrl: getExplorerUrl(entry.chain, entry.address),
      primaryAsset: entry.primaryAsset || entry.balances[0]?.asset || NATIVE_ASSET_BY_CHAIN[entry.chain],
      summary
    };
  }

  function buildThorHolding(balance) {
    const asset = denomToAsset(balance.denom);
    const amount = fromBaseUnit(balance.amount);
    const usdValue = getAssetUsdValue(asset, amount);

    return {
      asset,
      chain: asset.split('.')[0],
      amount,
      usdValue,
      hasMissingPrice: !hasKnownUsdValue(usdValue)
    };
  }

  function buildNativeHolding(entry, amount) {
    const asset = NATIVE_ASSET_BY_CHAIN[entry.chain];
    const usdValue = getAssetUsdValue(asset, amount);

    return {
      asset,
      chain: entry.chain,
      amount,
      usdValue,
      hasMissingPrice: !hasKnownUsdValue(usdValue)
    };
  }

  function enrichHolding(holding) {
    if (hasKnownUsdValue(holding.usdValue)) {
      return {
        ...holding,
        hasMissingPrice: false
      };
    }

    const usdValue = getAssetUsdValue(holding.asset, holding.amount);

    return {
      ...holding,
      usdValue,
      hasMissingPrice: !hasKnownUsdValue(usdValue)
    };
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
      description: `Aggregated balances, LP positions, and node bonds across ${entries.length} tracked treasury addresses.`,
      balances: buildConsolidatedBalances(entries),
      lpPositions: buildConsolidatedLpPositions(entries),
      bonds: buildConsolidatedBonds(entries),
      summary: summarizeSection(entries)
    };
  }

  function countUnpricedBalances(sourceSections = []) {
    return sourceSections
      .flatMap((section) => section.entries)
      .flatMap((entry) => entry.balances)
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

  async function mapWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let index = 0;

    async function runWorker() {
      while (index < items.length) {
        const currentIndex = index++;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      () => runWorker()
    );

    await Promise.all(workers);
    return results;
  }

  function toLpPosition(data) {
    const assetAmount = fromBaseUnit(data.asset_redeem_value);
    const runeAmount = fromBaseUnit(data.rune_redeem_value);
    const assetUsdValue = getAssetUsdValue(data.asset, assetAmount) || 0;
    const runeUsdValue = runeAmount * runePrice;

    return {
      pool: data.asset.split('.')[1]?.split('-')[0] || data.asset,
      fullPool: data.asset,
      assetAmount,
      runeAmount,
      assetUsdValue,
      runeUsdValue,
      totalUsdValue: assetUsdValue + runeUsdValue
    };
  }

  function isVisibleLpPosition(position) {
    return position.totalUsdValue >= 1;
  }

  async function fetchThorLpPositions(address) {
    if (!lpAssets.length) return [];

    if (import.meta.env.DEV) {
      const response = await fetch(`/__treasury_lp_scan?address=${encodeURIComponent(address)}`);

      if (!response.ok) {
        throw new Error(`Failed to scan LP positions for ${address}`);
      }

      const data = await response.json();
      return data
        .map(toLpPosition)
        .filter(isVisibleLpPosition)
        .sort((left, right) => right.totalUsdValue - left.totalUsdValue);
    }

    const positions = await mapWithConcurrency(lpAssets, LP_CONCURRENCY, async (asset) => {
      try {
        const data = await thornode.getLiquidityProvider(asset, address);
        if (!data?.units || Number(data.units) === 0) {
          return null;
        }

        return toLpPosition(data);
      } catch (err) {
        if (!isNotFoundError(err)) {
          console.warn(`Failed to fetch LP position for ${address} in ${asset}:`, err);
        }
        return null;
      }
    });

    return positions
      .filter(Boolean)
      .filter(isVisibleLpPosition)
      .sort((left, right) => right.totalUsdValue - left.totalUsdValue);
  }

  async function fetchThorEntry(entry, bondsByAddress) {
    const balancePromise = thornode
      .getBalance(entry.address)
      .catch((err) => (isNotFoundError(err) ? { balances: [] } : Promise.reject(err)));

    const [balanceData, lpPositions] = await Promise.all([balancePromise, fetchThorLpPositions(entry.address)]);

    const balances = mergeBalances(entry.moduleBalances, balanceData?.balances || [])
      .map(buildThorHolding)
      .filter((holding) => holding.amount > 0)
      .sort((left, right) => {
        const leftValue = left.usdValue ?? left.amount;
        const rightValue = right.usdValue ?? right.amount;
        return rightValue - leftValue;
      });

    const bonds = (bondsByAddress.get(entry.address.toLowerCase()) || []).filter(
      (bond) => bond.amount > 0
    );

    return finalizeEntry({
      ...entry,
      balances,
      lpPositions,
      bonds,
      entryError: null
    });
  }

  async function fetchNativeEntry(entry, evmAssetsByChain = {}) {
    if (entry.chain === 'ETH' && entry.includeTokenBalances) {
      const [ethBalances, extraEvmBalances] = await Promise.all([
        fetchEthHoldings(entry.address),
        entry.includeEvmChainBalances?.length
          ? Promise.all(
              entry.includeEvmChainBalances.map((chain) =>
                fetchEvmChainHoldings(entry.address, chain, evmAssetsByChain[chain] || [])
              )
            )
          : Promise.resolve([])
      ]);

      const balances = sortHoldingsByValue(
        await hydrateMissingEvmTokenPrices(
          [...ethBalances, ...extraEvmBalances.flat()]
          .map(enrichHolding)
          .filter((holding) => holding.amount > 0)
        )
      );

      return finalizeEntry({
        ...entry,
        primaryAsset: NATIVE_ASSET_BY_CHAIN[entry.chain],
        balances,
        lpPositions: [],
        bonds: [],
        entryError: null
      });
    }

    const amount = await fetchNativeBalance(entry);

    return finalizeEntry({
      ...entry,
      balances: sortHoldingsByValue([buildNativeHolding(entry, amount)]),
      lpPositions: [],
      bonds: [],
      entryError: null
    });
  }

  async function loadEntry(entry, bondsByAddress, evmAssetsByChain) {
    try {
      return entry.chain === 'THOR'
        ? await fetchThorEntry(entry, bondsByAddress)
        : await fetchNativeEntry(entry, evmAssetsByChain);
    } catch (err) {
      console.error(`Failed to load treasury entry for ${entry.label}:`, err);

      return finalizeEntry({
        ...entry,
        balances: [],
        lpPositions: [],
        bonds: [],
        entryError: `Failed to load ${entry.label}.`
      });
    }
  }

  async function loadTracker() {
    loading = true;
    error = null;

    try {
      const [currentRunePrice, pools, treasuryModule] = await Promise.all([
        getRunePrice(),
        thornode.getPools(),
        thornode.fetch('/thorchain/balance/module/treasury').catch((err) => {
          console.error('Failed to fetch treasury module address:', err);
          return null;
        })
      ]);

      runePrice = currentRunePrice;
      const resolvedSections = buildResolvedSections(treasuryModule);
      const bonds = await getBondsForAddresses(getThorTreasuryAddresses(resolvedSections)).catch((err) => {
        console.error('Failed to fetch treasury bonds:', err);
        return [];
      });

      const availablePools = pools.filter((pool) => pool.status === 'Available');
      assetPrices = availablePools.reduce(
        (priceMap, pool) => {
          const price = fromBaseUnit(pool.asset_tor_price);
          const assetPart = pool.asset.split('.').slice(1).join('.');

          priceMap[pool.asset] = price;

          // THOR synth balances use THOR.<asset-part> bank denoms but should
          // inherit the redeemable pool price from the underlying L1 asset.
          if (assetPart) {
            priceMap[`THOR.${assetPart}`] = price;
          }

          return priceMap;
        },
        {
          'THOR.RUNE': currentRunePrice
        }
      );
      lpAssets = availablePools.map((pool) => pool.asset);

      const bondsByAddress = buildBondsByAddress(bonds);
      const evmAssetsByChain = buildTrackedEvmAssetsByChain(availablePools);

      sections = await Promise.all(
        resolvedSections.map(async (section) => {
          const entries = await Promise.all(
            section.addresses.map((entry) => loadEntry(entry, bondsByAddress, evmAssetsByChain))
          );

          return {
            ...section,
            entries,
            summary: summarizeSection(entries)
          };
        })
      );
      consolidatedSection = buildConsolidatedSection(sections);
    } catch (err) {
      console.error('Failed to load Treasury Tracker:', err);
      error = 'Failed to load Treasury Tracker.';
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
    <div class="sticky-header">
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

      {#if consolidatedSection}
        <section class="data-section">
          <div class="section-head">
            <h3>CONSOLIDATED POSITIONS</h3>
            <span class="section-sub">Across {consolidatedSection.summary.addressCount} addresses</span>
            <div class="head-stats">
              <span>Wallets <strong>{formatUSD(consolidatedSection.summary.walletValue)}</strong></span>
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
                        <img src={getAssetLogo(balance.asset) || '/assets/coins/fallback-logo.svg'} alt={getAssetDisplayName(balance.asset)} class="asset-icon" on:error={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = '/assets/coins/fallback-logo.svg'; }} />
                        <div class="chain-badge"><img src={getChainLogo(balance.chain) || '/assets/chains/fallback-logo.svg'} alt={balance.chain} class="chain-icon" on:error={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = '/assets/chains/fallback-logo.svg'; }} /></div>
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
              <div class="col-head">LP POSITIONS</div>
              {#if consolidatedSection.lpPositions.length > 0}
                {#each consolidatedSection.lpPositions as position}
                  <div class="lp-row">
                    <div class="lp-top">
                      <div class="asset-left">
                        <div class="logo-wrap">
                          <img src={getAssetLogo(position.fullPool) || '/assets/coins/fallback-logo.svg'} alt={position.pool} class="asset-icon" on:error={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = '/assets/coins/fallback-logo.svg'; }} />
                          <div class="chain-badge"><img src={getChainLogo(position.fullPool.split('.')[0]) || '/assets/chains/fallback-logo.svg'} alt={position.fullPool.split('.')[0]} class="chain-icon" on:error={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = '/assets/chains/fallback-logo.svg'; }} /></div>
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
                          <img src={getAssetLogo(entry.primaryAsset) || '/assets/coins/fallback-logo.svg'} alt={entry.label} class="asset-icon" on:error={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = '/assets/coins/fallback-logo.svg'; }} />
                          <div class="chain-badge"><img src={getChainLogo(entry.chain) || '/assets/chains/fallback-logo.svg'} alt={entry.chain} class="chain-icon" on:error={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = '/assets/chains/fallback-logo.svg'; }} /></div>
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
                                    <img src={getAssetLogo(balance.asset) || '/assets/coins/fallback-logo.svg'} alt={getAssetDisplayName(balance.asset)} class="asset-icon" on:error={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = '/assets/coins/fallback-logo.svg'; }} />
                                    <div class="chain-badge"><img src={getChainLogo(balance.chain) || '/assets/chains/fallback-logo.svg'} alt={balance.chain} class="chain-icon" on:error={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = '/assets/chains/fallback-logo.svg'; }} /></div>
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

                        {#if entry.lpPositions.length > 0 || entry.showLpSection}
                          <div class="detail-block detail-block--lp">
                            <div class="detail-label">LP POSITIONS</div>
                            {#if entry.lpPositions.length > 0}
                              {#each entry.lpPositions as position}
                                <div class="lp-row">
                                  <div class="lp-top">
                                    <div class="asset-left">
                                      <div class="logo-wrap sm">
                                        <img src={getAssetLogo(position.fullPool) || '/assets/coins/fallback-logo.svg'} alt={position.pool} class="asset-icon" on:error={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = '/assets/coins/fallback-logo.svg'; }} />
                                        <div class="chain-badge"><img src={getChainLogo(position.fullPool.split('.')[0]) || '/assets/chains/fallback-logo.svg'} alt={position.fullPool.split('.')[0]} class="chain-icon" on:error={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = '/assets/chains/fallback-logo.svg'; }} /></div>
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

  .sticky-header {
    position: sticky;
    top: 36px;
    z-index: 10;
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
    grid-template-columns: repeat(3, 1fr);
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
