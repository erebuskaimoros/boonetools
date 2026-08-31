<script>
  import { onDestroy, onMount } from 'svelte';

  import { fetchStatusDashboard, fetchStatusLive } from './status/api.js';
  import BlockProductionChart from './status/BlockProductionChart.svelte';
  import { formatChurnCountdown } from './status/churn-countdown.js';
  import { groupStuckTransactionsByChain } from './status/stuck-transactions.js';

  const DASHBOARD_REFRESH_INTERVAL_MS = 60_000;
  const LIVE_REFRESH_INTERVAL_MS = 15_000;
  const number = new Intl.NumberFormat('en-US');
  const blockLagNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

  let dashboard = null;
  let liveStatus = null;
  let lastUpdated = null;
  let loading = true;
  let refreshing = false;
  let coreError = '';
  let liveError = '';
  let votesError = '';
  let churnError = '';
  let stuckError = '';
  let refreshTimer;
  let liveRefreshTimer;
  let countdownTimer;
  let countdownNowMs = Date.now();
  let statusRequestInFlight = false;
  let liveRequestInFlight = false;
  let visibilityHandler;

  $: currentDashboard = mergeLiveStatus(dashboard, liveStatus);
  $: chainStatuses = currentDashboard?.chains || [];
  $: networkSummary = currentDashboard?.network?.summary || {
    total: 0,
    tradingEnabled: 0,
    depositsEnabled: 0,
    withdrawalsEnabled: 0,
    lpEnabled: 0,
    lpPartial: 0,
    signingEnabled: 0,
    degradedChains: [],
    tone: 'err',
    label: 'Unavailable'
  };
  $: networkConsensus = currentDashboard?.network?.consensus || {
    state: 'unknown',
    signing_blocks: false,
    last_block_at: null,
    block_age_seconds: null
  };
  $: consensusStalled = networkConsensus.state === 'stalled';
  $: displayNetworkTone = consensusStalled ? 'err' : networkSummary.tone;
  $: displayNetworkLabel = consensusStalled ? 'Stalled' : networkSummary.label;
  $: activeNodeCount = Number(currentDashboard?.network?.active_node_count || 0);
  $: networkVersion = currentDashboard?.network?.majority_version || '-';
  $: thorchainHeight = Number(currentDashboard?.network?.height || 0);
  $: churnStatus = currentDashboard?.churn || {
    isPaused: false,
    isInProgress: false,
    mimirValue: 0,
    lastChurnHeight: 0,
    lastChurnTimestampMs: 0,
    blocksSince: 0,
    nextChurnHeight: 0,
    nextChurnTimestampMs: 0,
    nextChurnSource: 'unavailable',
    blocksRemaining: 0,
    estimated: true
  };
  $: churnCountdown = formatChurnCountdown(churnStatus, countdownNowMs, { consensusStalled });
  $: governanceVotes = currentDashboard?.votes?.governance || [];
  $: statusUpdates = currentDashboard?.votes?.status_updates || [];
  $: stuckDashboard = currentDashboard?.stuck_transactions || null;
  $: stuckTransactions = stuckDashboard?.transactions || [];
  $: stuckTransactionGroups = groupStuckTransactionsByChain(stuckTransactions);
  $: hasStuckTransactions = stuckTransactions.length > 0 || Number(stuckDashboard?.count || 0) > 0;
  $: haltedChains = chainStatuses.filter((chain) => chain.trading === 'paused').map((chain) => chain.chain);
  $: statusError = [coreError, liveError].filter(Boolean).join('; ');
  $: lastUpdated = newestDate(
    currentDashboard?.sources?.network?.as_of,
    currentDashboard?.as_of
  );

  onMount(() => {
    loadStatus();
    loadLiveStatus({ revalidate: true });
    refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible') loadStatus({ silent: true });
    }, DASHBOARD_REFRESH_INTERVAL_MS);
    liveRefreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible') loadLiveStatus({ revalidate: true });
    }, LIVE_REFRESH_INTERVAL_MS);
    countdownTimer = setInterval(() => {
      countdownNowMs = Date.now();
    }, 1_000);
    visibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;
      loadLiveStatus({ revalidate: true });
      const dashboardAgeMs = Date.now() - Date.parse(dashboard?.as_of || '');
      if (!Number.isFinite(dashboardAgeMs) || dashboardAgeMs >= DASHBOARD_REFRESH_INTERVAL_MS) {
        loadStatus({ silent: true });
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
    window.addEventListener('focus', visibilityHandler);
  });

  onDestroy(() => {
    clearInterval(refreshTimer);
    clearInterval(liveRefreshTimer);
    clearInterval(countdownTimer);
    document.removeEventListener('visibilitychange', visibilityHandler);
    window.removeEventListener('focus', visibilityHandler);
  });

  function newestDate(...values) {
    const timestamps = values
      .map((value) => Date.parse(String(value || '')))
      .filter(Number.isFinite);
    return timestamps.length ? new Date(Math.max(...timestamps)) : null;
  }

  function mergeLiveStatus(snapshot, live) {
    if (!snapshot) {
      if (!live) return null;
      return {
        schema_version: 1,
        as_of: live.as_of,
        network: live.network,
        chains: live.chains,
        churn: live.churn,
        sources: { network: live.source },
        partial: true,
        stale: Boolean(live.stale),
        warnings: live.warnings || []
      };
    }
    if (!live) return snapshot;
    const snapshotTime = Date.parse(snapshot?.sources?.network?.as_of || '');
    const liveTime = Date.parse(live?.source?.as_of || live?.as_of || '');
    if (Number.isFinite(snapshotTime) && (!Number.isFinite(liveTime) || liveTime < snapshotTime)) {
      return snapshot;
    }
    return {
      ...snapshot,
      network: live.network || snapshot.network,
      chains: live.chains || snapshot.chains,
      churn: live.churn || snapshot.churn,
      sources: {
        ...snapshot.sources,
        network: live.source || snapshot?.sources?.network
      },
      partial: Boolean(snapshot.partial || live.partial),
      stale: Boolean(snapshot.stale || live.stale),
      warnings: [...new Set([...(snapshot.warnings || []), ...(live.warnings || [])])]
    };
  }

  async function loadStatus(options = {}) {
    if (statusRequestInFlight) return;
    statusRequestInFlight = true;
    if (!options.silent) {
      loading = chainStatuses.length === 0;
    }

    coreError = '';
    votesError = '';
    churnError = '';
    stuckError = '';

    try {
      const nextDashboard = await fetchStatusDashboard({ forceRefresh: Boolean(options.revalidate) });
      dashboard = nextDashboard;
      const warnings = Array.isArray(nextDashboard?.warnings) ? nextDashboard.warnings : [];
      coreError = nextDashboard?.partial || nextDashboard?.stale ? warnings.join('; ') : '';
      votesError = nextDashboard?.votes ? '' : 'Vote and Mimir history is unavailable.';
      churnError = nextDashboard?.churn ? '' : 'Churn history is unavailable.';
      stuckError = nextDashboard?.stuck_transactions?.partial
        ? `${nextDashboard.stuck_transactions.failed_lookups || 0} transaction lookups failed; this scan may be incomplete.`
        : '';
    } catch (loadError) {
      coreError = loadError?.message || 'Cached network status is unavailable.';
      votesError = 'Vote and Mimir history is unavailable.';
      stuckError = 'Stuck transaction history is unavailable.';
    } finally {
      statusRequestInFlight = false;
      loading = false;
    }
  }

  async function loadLiveStatus(options = {}) {
    if (liveRequestInFlight) return;
    liveRequestInFlight = true;
    try {
      const nextLiveStatus = await fetchStatusLive({ revalidate: Boolean(options.revalidate) });
      liveStatus = nextLiveStatus;
      const warnings = Array.isArray(nextLiveStatus?.warnings) ? nextLiveStatus.warnings : [];
      liveError = nextLiveStatus?.partial || nextLiveStatus?.stale ? warnings.join('; ') : '';
    } catch (loadError) {
      liveError = loadError?.message || 'Live network status is unavailable.';
    } finally {
      liveRequestInFlight = false;
    }
  }

  async function refreshStatus() {
    if (refreshing) return;
    refreshing = true;
    try {
      await Promise.all([
        loadStatus({ revalidate: true }),
        loadLiveStatus({ revalidate: true })
      ]);
    } finally {
      refreshing = false;
    }
  }

  function formatDateTime(value) {
    if (!value) return '-';
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '-';
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function formatAge(value) {
    const time = new Date(value || '').getTime();
    if (!Number.isFinite(time)) return '-';
    const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
    if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function formatDurationSeconds(value) {
    if (value === null || value === undefined || value === '') return '-';
    const parsedSeconds = Number(value);
    if (!Number.isFinite(parsedSeconds)) return '-';
    const totalSeconds = Math.max(0, Math.floor(parsedSeconds));
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  function stateLabel(state) {
    if (state === 'enabled') return 'ENABLED';
    if (state === 'partial') return 'PARTIAL';
    return 'PAUSED';
  }

  function formatAverageBlockLag(chain) {
    const value = Number(chain?.avgBlocksBehindTip);
    return chain?.avgBlocksBehindTip === null || !Number.isFinite(value)
      ? '-'
      : blockLagNumber.format(value);
  }

  function blockLagTitle(chain) {
    if (!chain?.reportingValidators) return 'No active validator scanner reports available';
    return `Mean Bifrost scanner lag across ${number.format(chain.reportingValidators)} active validators; highest reported chain height ${number.format(chain.tipHeight)}`;
  }

  function formatElapsed(value) {
    const time = Number(value);
    if (!Number.isFinite(time) || time <= 0) return '-';
    const totalMinutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${Math.max(1, minutes)}m`;
  }

  function txUrl(txId) {
    return `https://thorchain.net/tx/${encodeURIComponent(txId)}`;
  }

  function shortValue(value, start = 8, end = 6) {
    const text = String(value || '');
    if (text.length <= start + end + 1) return text || '-';
    return `${text.slice(0, start)}…${text.slice(-end)}`;
  }

  function formatBaseAmount(value) {
    try {
      const amount = BigInt(String(value || '0'));
      const whole = amount / 100_000_000n;
      const fraction = String(amount % 100_000_000n).padStart(8, '0').replace(/0+$/, '');
      return `${number.format(Number(whole))}${fraction ? `.${fraction}` : ''}`;
    } catch {
      return '-';
    }
  }

  function formatOutstanding(row) {
    const formatted = formatBaseAmount(row?.amount);
    return formatted === '0'
      ? `Pending ${row?.asset_ticker || row?.chain || 'output'}`
      : `${formatted} ${row?.asset_ticker || ''}`.trim();
  }

  function formatBundleStages(bundle) {
    const labels = Array.isArray(bundle?.stageLabels) ? bundle.stageLabels : [];
    if (labels.length === 0) return 'Unknown stage';
    const visible = labels.slice(0, 2).join(' · ');
    return labels.length > 2 ? `${visible} +${labels.length - 2}` : visible;
  }

  function formatBlockDuration(value) {
    const totalMinutes = Math.max(0, Math.floor((Number(value) * 6) / 60));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${Math.max(1, minutes)}m`;
  }
</script>

<svelte:head>
  <meta name="description" content="Live THORChain network, chain, stuck transaction, governance, and Mimir status." />
</svelte:head>

<div class="status-dashboard">
  <section class="terminal-header">
    <div class="command-line">
      <span class="prompt">$</span>
      <span>network-status --mainnet --live</span>
      <span class="status-pill {displayNetworkTone}">
        <span class="dot"></span>{displayNetworkLabel}
      </span>
    </div>
    <div class="title-row">
      <div>
        <h1>THORCHAIN STATUS<span class="cursor">_</span></h1>
        <p>One live view of chain availability, network changes, and governance activity.</p>
      </div>
      <button class="bracket-button" on:click={refreshStatus} disabled={refreshing}>
        <span>[</span>R<span>]</span> {refreshing ? 'refreshing' : 'refresh'}
      </button>
    </div>
  </section>

  {#if consensusStalled}
    <div class="alert err stall-alert" role="alert" aria-live="assertive">
      <span>ERR</span>
      <div>
        <strong>Block production is stalled.</strong>
        <p>
          No THORChain block has committed for {formatDurationSeconds(networkConsensus.block_age_seconds)}.
          Height {number.format(thorchainHeight)} has not advanced; last commit: {formatDateTime(networkConsensus.last_block_at)}.
        </p>
        <p>Validators may still be signing consensus votes, but no proposed block is reaching commit quorum. On-chain actions cannot progress until consensus resumes.</p>
        <p>Mimir and configured chain lanes below can still show ENABLED. “Outbound Signing” reports TSS/config state, not block-finalization health.</p>
      </div>
    </div>
  {/if}

  {#if statusError}
    <div class="alert err"><span>ERR</span>{statusError}</div>
  {/if}

  {#if loading}
    <div class="loading-panel"><span>▓░░░░</span> Reading live network state...</div>
  {:else if chainStatuses.length > 0}
    <div class="overview-grid">
      <section class="network-callout {displayNetworkTone}">
        <div class="network-state">
          <span class="state-dot"></span>
          <div>
            <small>NETWORK STATE</small>
            <strong>{displayNetworkLabel}</strong>
          </div>
        </div>
        <div class="network-notes">
          {#if consensusStalled}
            <p><strong>No new block commits are being finalized.</strong> Network height remains at {number.format(thorchainHeight)}.</p>
            <p>Configured lane state remains visible below for incident context; it does not mean transactions can execute.</p>
          {:else}
            <p>
              Trading is available on <strong>{networkSummary.tradingEnabled} of {networkSummary.total}</strong> connected chains.
              {#if haltedChains.length}Paused: <span>{haltedChains.join(', ')}</span>.{/if}
            </p>
            <p>
              LP actions are available on <strong>{networkSummary.lpEnabled} of {networkSummary.total}</strong> chains;
              outbound signing configured on <strong>{networkSummary.signingEnabled} of {networkSummary.total}</strong>.
              {#if networkSummary.lpPartial}Partial LP availability: <span>{networkSummary.lpPartial}</span>.{/if}
            </p>
          {/if}
        </div>
        <a class="text-link" href="https://thorchain.net/network" target="_blank" rel="noopener noreferrer">
          Full network <span>↗</span>
        </a>
      </section>

      <section class="churn-card" class:paused={churnStatus.isPaused} class:stalled={consensusStalled} aria-label="Validator churn status">
        <div class="churn-main">
          <div class="churn-head">
            <span class="churn-dot"></span>
            <div>
              <small>VALIDATOR CHURN</small>
              <strong>{consensusStalled ? 'BLOCKED' : churnStatus.isInProgress ? 'CHURNING' : churnStatus.isPaused ? 'PAUSED' : 'ACTIVE'}</strong>
              <span class="churn-mimir">[HALTCHURNING={churnStatus.mimirValue}]</span>
            </div>
          </div>
          <div class="churn-meta">
            <span>Next churn</span>
            <strong class="churn-countdown" aria-live="off">{churnCountdown}</strong>
            <small>
              {#if churnStatus.nextChurnHeight > 0}
                block {number.format(churnStatus.nextChurnHeight)}
                {#if churnStatus.nextChurnSource === 'computed'} · estimated{/if}
              {:else}
                target unavailable
              {/if}
            </small>
            {#if churnStatus.isInProgress}
              <a class="churn-link" href="https://churn.thorchain.org/" target="_blank" rel="noopener noreferrer">
                Track churn <span>↗</span>
              </a>
            {/if}
          </div>
        </div>
        <small class="churn-last">
          last {formatElapsed(churnStatus.lastChurnTimestampMs)} ago · block {number.format(churnStatus.lastChurnHeight)}
          {#if churnStatus.estimated || churnError} · estimated{/if}
        </small>
      </section>
    </div>

    <section class="metric-grid" aria-label="Network summary">
      <div class="metric">
        <span class="metric-index">01</span>
        <span class="metric-label">THORChain Block</span>
        <strong>{number.format(thorchainHeight)}</strong>
        {#if consensusStalled}
          <small>no new block for {formatDurationSeconds(networkConsensus.block_age_seconds)}</small>
        {:else if networkConsensus.last_block_at}
          <small>last block {formatAge(networkConsensus.last_block_at)}</small>
        {:else}
          <small>live height</small>
        {/if}
      </div>
      <div class="metric">
        <span class="metric-index">02</span>
        <span class="metric-label">Active Nodes</span>
        <strong>{number.format(activeNodeCount)}</strong>
        <small>version {networkVersion}</small>
      </div>
      <div class="metric">
        <span class="metric-index">03</span>
        <span class="metric-label">Trading</span>
        <strong>{networkSummary.tradingEnabled}/{networkSummary.total}</strong>
        <small>chains available</small>
      </div>
      <div class="metric">
        <span class="metric-index">04</span>
        <span class="metric-label">LP Actions</span>
        <strong>{networkSummary.lpEnabled}/{networkSummary.total}</strong>
        <small>chains available</small>
      </div>
    </section>

    <section class="block chain-block">
      <div class="block-title">
        <h2><span>▌</span> Chain Availability</h2>
        <a href="https://thorchain.net/network" target="_blank" rel="noopener noreferrer">[DETAILS ↗]</a>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Chain</th>
              <th>Trading</th>
              <th>LP Actions</th>
              <th>Outbound Signing</th>
              <th>Last Observed</th>
              <th title="Mean Bifrost scanner lag across active validators for each chain">Avg Blocks Behind Tip</th>
            </tr>
          </thead>
          <tbody>
            {#each chainStatuses as chain}
              <tr class:degraded={chain.degraded}>
                <td class="chain-cell"><span>{chain.chain.slice(0, 2)}</span><strong>{chain.chain}</strong></td>
                <td><span class="state {chain.trading}"><i></i>{stateLabel(chain.trading)}</span></td>
                <td><span class="state {chain.lpActions}"><i></i>{stateLabel(chain.lpActions)}</span></td>
                <td><span class="state {chain.signing}"><i></i>{stateLabel(chain.signing)}</span></td>
                <td class="height">{number.format(chain.lastObservedIn)}</td>
                <td class="lag" title={blockLagTitle(chain)}>{formatAverageBlockLag(chain)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <BlockProductionChart history={currentDashboard?.block_production} />

    <section class="block stuck-block" class:has-stuck={hasStuckTransactions} aria-labelledby="stuck-transactions-title">
      <div class="block-title">
        <h2 id="stuck-transactions-title"><span>▌</span> Stuck Transactions</h2>
        {#if stuckDashboard}
          <span class="stuck-count">{stuckDashboard.count || 0} ACTIVE</span>
        {/if}
      </div>
      <p class="stuck-criteria">
        Finalized user payments past their protocol window with no matching outbound.
        Expected limit, streaming, security-delay, and halt waits are excluded.
      </p>
      {#if stuckError && !stuckDashboard}
        <div class="inline-alert"><span>WRN</span>{stuckError}</div>
      {:else}
        {#if stuckError || stuckDashboard?.warning || stuckDashboard?.partial}
          <div class="inline-alert">
            <span>WRN</span>
            {stuckError || stuckDashboard?.warning || `${stuckDashboard?.failed_lookups || 0} transaction lookups failed; this scan may be incomplete.`}
          </div>
        {/if}
        {#if stuckTransactionGroups.length === 0}
          <div class="empty-state clean-state"><span>✓</span>No currently detected stuck transactions.</div>
        {:else}
          <div class="stuck-bundles">
            {#each stuckTransactionGroups as bundle (bundle.chain)}
              <details class="stuck-bundle">
                <summary>
                  <span class="stuck-bundle-chain">
                    <i>{bundle.chain.slice(0, 2)}</i>
                    <span><strong>{bundle.chain}</strong><small>chain</small></span>
                  </span>
                  <span class="stuck-bundle-metric">
                    <strong>{number.format(bundle.count)} STUCK</strong>
                    <small>transaction{bundle.count === 1 ? '' : 's'}</small>
                  </span>
                  <span class="stuck-bundle-metric stuck-bundle-stages" title={bundle.stageLabels.join(', ')}>
                    <strong>{formatBundleStages(bundle)}</strong>
                    <small>affected stages</small>
                  </span>
                  <span class="stuck-bundle-metric">
                    <strong>{formatBlockDuration(bundle.maxOverdueBlocks)}</strong>
                    <small>{number.format(bundle.maxOverdueBlocks)} blocks max</small>
                  </span>
                  <span class="stuck-bundle-action">
                    <span class="when-closed">Open {number.format(bundle.count)} transaction{bundle.count === 1 ? '' : 's'}</span>
                    <span class="when-open">Hide transaction{bundle.count === 1 ? '' : 's'}</span>
                    <i aria-hidden="true"></i>
                  </span>
                </summary>
                <div class="table-wrap stuck-bundle-details">
                  <table class="stuck-table">
                    <thead>
                      <tr>
                        <th>Transaction</th>
                        <th>State</th>
                        <th>Outstanding</th>
                        <th>Destination</th>
                        <th>Overdue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each bundle.transactions as transaction (transaction.tx_id)}
                        <tr class="stuck-row">
                          <td>
                            <a class="tx-id" href={txUrl(transaction.tx_id)} target="_blank" rel="noopener noreferrer" title={transaction.tx_id}>
                              {shortValue(transaction.tx_id)} <span>↗</span>
                            </a>
                            {#if transaction.completed_outbounds > 0}
                              <small>{transaction.completed_outbounds} sibling outbound{transaction.completed_outbounds === 1 ? '' : 's'} completed</small>
                            {/if}
                          </td>
                          <td>
                            <span class="stuck-state"><i></i>STUCK</span>
                            <small>{transaction.stage_label}</small>
                          </td>
                          <td>
                            <strong class="outstanding-amount">{formatOutstanding(transaction)}</strong>
                            <small>{transaction.chain}</small>
                          </td>
                          <td>
                            <span class="destination" title={transaction.destination}>{shortValue(transaction.destination, 7, 6)}</span>
                          </td>
                          <td>
                            <strong class="overdue-time">{formatBlockDuration(transaction.overdue_blocks)}</strong>
                            <small>{number.format(transaction.overdue_blocks)} blocks</small>
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              </details>
            {/each}
          </div>
        {/if}
      {/if}
    </section>

    <div class="lower-grid">
      <section class="block updates-block">
        <div class="block-title">
          <h2><span>▌</span> Latest Network Changes</h2>
          <a href="/vote-tracker" target="_blank" rel="noopener noreferrer">[ALL VOTES ↗]</a>
        </div>
        {#if votesError}
          <div class="inline-alert"><span>WRN</span>{votesError}</div>
        {:else if statusUpdates.length === 0}
          <div class="empty-state">No effective Mimir changes in this window.</div>
        {:else}
          <ol class="timeline">
            {#each statusUpdates as update, index}
              <li>
                <span class="timeline-index">{String(index + 1).padStart(2, '0')}</span>
                <span class="timeline-node {update.tone}"></span>
                <div class="timeline-content">
                  <div>
                    <strong>{update.description}</strong>
                    <span class="update-key" title={`${update.key}=${update.value}`}>{update.key}={update.value}</span>
                  </div>
                  <small title={formatDateTime(update.blockTime)}>
                    {formatAge(update.blockTime)} · block {number.format(update.height)}
                    {#if update.txId}
                      · <a href={txUrl(update.txId)} target="_blank" rel="noopener noreferrer">tx ↗</a>
                    {/if}
                  </small>
                </div>
              </li>
            {/each}
          </ol>
        {/if}
      </section>

      <section class="block votes-block">
        <div class="block-title">
          <h2><span>▌</span> Latest Governance Votes</h2>
          <a href="/vote-tracker" target="_blank" rel="noopener noreferrer">[EXPLORE ↗]</a>
        </div>
        {#if votesError}
          <div class="inline-alert"><span>WRN</span>{votesError}</div>
        {:else if governanceVotes.length === 0}
          <div class="empty-state">No recent economic Mimir votes.</div>
        {:else}
          <div class="vote-list">
            {#each governanceVotes as vote}
              <div class="vote-row">
                <div class="vote-main">
                  <div>
                    <strong>{vote.key}</strong>
                    <small>leading value <span>{vote.value}</span></small>
                  </div>
                  <span class="vote-state" class:passed={vote.passed}>{vote.passed ? 'PASSED' : 'ACTIVE'}</span>
                </div>
                <div class="vote-progress">
                  <div><i style={`width: ${vote.progress}%`}></i></div>
                  <span>{vote.votes}/{vote.threshold} nodes</span>
                </div>
                <small class="vote-time">Last vote {formatAge(vote.latestVoteAt)} · block {number.format(vote.height)}</small>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    </div>

    <div class="source-line" class:stalled={consensusStalled}>
      <span><i></i> {consensusStalled ? 'NO NEW BLOCKS' : 'LIVE'}</span>
      THORNode live state 15s · block headers, stuck-tx scan, and node-vote history 60s
      {#if lastUpdated}<em>updated {formatDateTime(lastUpdated)}</em>{/if}
    </div>
  {/if}
</div>

<style>
  :global(body) {
    background: #080808;
  }

  .status-dashboard {
    width: min(1080px, calc(100% - 32px));
    margin: 0 auto;
    padding: 24px 0 56px;
    color: var(--term-text-body, #e8e8e8);
  }

  .terminal-header {
    margin-bottom: 18px;
    border-bottom: 1px solid #1a1a1a;
  }

  .command-line,
  .title-row,
  .block-title,
  .network-callout,
  .network-state,
  .churn-card,
  .churn-head,
  .vote-main,
  .vote-progress,
  .source-line {
    display: flex;
    align-items: center;
  }

  .command-line {
    min-height: 30px;
    gap: 8px;
    color: var(--term-text-3);
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    border-bottom: 1px solid #111;
  }

  .prompt { color: #00cc66; }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    padding: 2px 7px;
    border: 1px solid #1a1a1a;
    border-radius: 999px;
    color: var(--term-text-2);
    font: 700 11px/1.4 'JetBrains Mono', monospace;
    letter-spacing: .1em;
    text-transform: uppercase;
  }

  .dot,
  .state-dot,
  .state i,
  .source-line i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #00cc66;
  }

  .status-pill.ok .dot,
  .network-callout.ok .state-dot { animation: pulse-dot 2s infinite; box-shadow: 0 0 6px rgba(0, 204, 102, .4); }
  .status-pill.warn .dot,
  .network-callout.warn .state-dot { background: #d4a017; }
  .status-pill.err .dot,
  .network-callout.err .state-dot { background: #dc3545; }

  .title-row {
    justify-content: space-between;
    gap: 24px;
    padding: 20px 0 18px;
  }

  h1 {
    margin: 0 0 7px;
    color: var(--term-text, #f5f5f5);
    font: 800 30px/1.1 'JetBrains Mono', monospace;
    letter-spacing: .06em;
  }

  .cursor {
    color: #00cc66;
    animation: cursor-blink 1s steps(1) infinite;
  }

  .title-row p {
    margin: 0;
    color: var(--term-text-3);
    font-size: 13px;
  }

  .bracket-button {
    flex: 0 0 auto;
    padding: 6px 11px;
    border: 1px solid #1a1a1a;
    border-radius: 0;
    background: transparent;
    color: var(--term-text-2);
    font: 600 11px/1.4 'JetBrains Mono', monospace;
    text-transform: lowercase;
    cursor: pointer;
  }

  .bracket-button span { color: #00cc66; }
  .bracket-button:hover:not(:disabled) { border-color: #00cc66; color: #00cc66; }
  .bracket-button:disabled { cursor: wait; opacity: .5; }

  .alert,
  .inline-alert,
  .loading-panel {
    border: 1px solid #1a1a1a;
    background: #0a0a0a;
    font: 11px/1.5 'JetBrains Mono', monospace;
  }

  .alert,
  .loading-panel { margin-bottom: 16px; padding: 12px 14px; }
  .alert span,
  .inline-alert span { margin-right: 10px; color: var(--term-error); font-weight: 800; }
  .loading-panel span { margin-right: 10px; color: #00cc66; animation: loader 1.2s steps(5) infinite; }

  .stall-alert {
    display: flex;
    align-items: flex-start;
    border-color: rgba(220, 53, 69, .42);
    border-left: 2px solid var(--term-error);
    background: rgba(220, 53, 69, .055);
  }
  .stall-alert > span { flex: 0 0 auto; }
  .stall-alert strong { display: block; color: #f3c3c8; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; }
  .stall-alert p { margin: 4px 0 0; color: var(--term-text-2); }

  .network-callout {
    min-height: 78px;
    padding: 14px 16px;
    border: 1px solid #1a1a1a;
    border-left: 2px solid #00cc66;
    background: rgba(0, 204, 102, .035);
  }

  .network-callout.warn { border-left-color: #d4a017; background: rgba(212, 160, 23, .035); }
  .network-callout.err { border-left-color: var(--term-error); background: rgba(220, 53, 69, .035); }
  .overview-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
    gap: 16px;
    margin-bottom: 16px;
  }
  .network-state { min-width: 168px; gap: 12px; }
  .network-state small { display: block; margin-bottom: 3px; color: var(--term-text-4); font: 700 11px/1.4 'JetBrains Mono', monospace; letter-spacing: .14em; }
  .network-state strong { color: var(--term-text, #f5f5f5); font: 800 16px/1.2 'JetBrains Mono', monospace; text-transform: uppercase; }

  .network-notes {
    flex: 1;
    padding: 0 24px;
    border-left: 1px solid #1a1a1a;
  }

  .network-notes p { margin: 2px 0; color: var(--term-text-2); font-size: 13px; line-height: 1.5; }
  .network-notes strong { color: var(--term-text-body); font-family: 'JetBrains Mono', monospace; }
  .network-notes span { color: #d4a017; font-family: 'JetBrains Mono', monospace; }
  .text-link,
  .block-title a {
    color: var(--term-text-3);
    font: 600 11px/1.4 'JetBrains Mono', monospace;
    text-decoration: none;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .text-link:hover,
  .block-title a:hover { color: #00cc66; }

  .churn-card {
    position: relative;
    flex-direction: column;
    align-items: stretch;
    overflow: hidden;
    min-height: 94px;
    gap: 8px;
    padding: 14px 16px;
    border: 1px solid #1a1a1a;
    border-left: 2px solid #00cc66;
    background: rgba(0, 204, 102, .035);
  }
  .churn-card.paused { border-left-color: #d4a017; background: rgba(212, 160, 23, .035); }
  .churn-card.stalled { border-left-color: var(--term-error); background: rgba(220, 53, 69, .035); }
  .churn-main { display: flex; min-width: 0; align-items: center; gap: 14px; }
  .churn-head { min-width: 118px; gap: 10px; }
  .churn-dot { width: 6px; height: 6px; border-radius: 50%; background: #00cc66; box-shadow: 0 0 6px rgba(0, 204, 102, .4); animation: pulse-dot 2s infinite; }
  .churn-card.paused .churn-dot { background: #d4a017; box-shadow: none; animation: none; }
  .churn-card.stalled .churn-dot { background: var(--term-error); box-shadow: none; animation: none; }
  .churn-head small,
  .churn-meta > span { display: block; color: var(--term-text-4); font: 700 11px/1.4 'JetBrains Mono', monospace; letter-spacing: .12em; }
  .churn-head strong { color: var(--term-text, #f5f5f5); font: 800 14px/1.2 'JetBrains Mono', monospace; }
  .churn-meta { flex: 1; min-width: 0; padding-left: 14px; border-left: 1px solid #1a1a1a; }
  .churn-meta strong { display: block; margin: 3px 0 2px; color: var(--term-text-body); font: 700 11px/1.4 'JetBrains Mono', monospace; white-space: nowrap; }
  .churn-meta .churn-countdown { color: var(--term-text-strong, #fff); font-size: 14px; letter-spacing: .02em; }
  .churn-meta small { color: var(--term-text-4); font: 11px/1.4 'JetBrains Mono', monospace; white-space: nowrap; }
  .churn-last { display: block; width: 100%; padding-top: 7px; border-top: 1px solid #1a1a1a; color: var(--term-text-5); font: 10px/1.4 'JetBrains Mono', monospace; white-space: normal; overflow-wrap: anywhere; }
  .churn-link { display: inline-block; margin-top: 4px; color: var(--term-text-3); font: 700 10px/1.4 'JetBrains Mono', monospace; letter-spacing: .06em; text-decoration: none; text-transform: uppercase; white-space: nowrap; }
  .churn-link span,
  .churn-link:hover { color: #00cc66; }
  .churn-mimir { display: block; margin-top: 4px; color: var(--term-text-6); font: 9px/1.3 'JetBrains Mono', monospace; white-space: nowrap; }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    margin-bottom: 16px;
    border: 1px solid #1a1a1a;
    background: #0a0a0a;
  }

  .metric {
    position: relative;
    min-height: 110px;
    padding: 16px 18px;
    border-right: 1px solid #1a1a1a;
  }
  .metric:last-child { border-right: 0; }
  .metric-index { position: absolute; top: 13px; right: 14px; color: #00cc66; font: 600 10px/1.3 'JetBrains Mono', monospace; }
  .metric-label { display: block; color: var(--term-text-3); font: 700 11px/1.4 'JetBrains Mono', monospace; letter-spacing: .12em; text-transform: uppercase; }
  .metric strong { display: block; margin: 20px 0 4px; color: var(--term-text, #f5f5f5); font: 800 23px/1 'JetBrains Mono', monospace; }
  .metric small { color: var(--term-text-4); font: 11px/1.4 'JetBrains Mono', monospace; }

  .block {
    border: 1px solid #1a1a1a;
    background: #0a0a0a;
  }

  .chain-block { margin-bottom: 16px; }
  .stuck-block { margin-bottom: 16px; border-color: rgba(0, 204, 102, .18); }
  .stuck-block.has-stuck { border-color: #241518; }
  .stuck-block.has-stuck .block-title h2 span { color: var(--term-error); }
  .stuck-count {
    padding: 3px 7px;
    border: 1px solid rgba(0, 204, 102, .28);
    color: #00cc66;
    font: 700 11px/1.3 'JetBrains Mono', monospace;
    letter-spacing: .1em;
  }
  .stuck-block.has-stuck .stuck-count {
    border-color: rgba(220, 53, 69, .28);
    color: var(--term-error);
  }
  .stuck-criteria {
    margin: 0;
    padding: 10px 16px;
    border-bottom: 1px solid #151112;
    color: var(--term-text-4);
    font: 13px/1.55 'JetBrains Mono', monospace;
  }
  .block-title { justify-content: space-between; min-height: 44px; padding: 0 16px; border-bottom: 1px solid #1a1a1a; }
  .block-title h2 { margin: 0; color: var(--term-text-3); font: 700 12px/1.4 'JetBrains Mono', monospace; letter-spacing: .08em; text-transform: uppercase; }
  .block-title h2 span { color: #00cc66; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-family: 'JetBrains Mono', monospace; }
  .chain-block table { min-width: 820px; }
  th { padding: 10px 14px; color: var(--term-text-4); font-size: 11px; line-height: 1.4; letter-spacing: .12em; text-align: left; text-transform: uppercase; background: #080808; }
  td { padding: 10px 14px; border-top: 1px solid #111; color: var(--term-text-2); font-size: 11px; line-height: 1.4; }
  tbody tr:hover { background: #0d0d0d; }
  tbody tr.degraded .chain-cell strong { color: #d4a017; }
  .chain-cell { display: flex; align-items: center; gap: 10px; }
  .chain-cell > span { display: grid; place-items: center; width: 24px; height: 24px; border: 1px solid #222; color: var(--term-text-3); font-size: 10px; }
  .chain-cell strong { color: var(--term-text-body); font-size: 11px; }
  .state { display: inline-flex; align-items: center; gap: 6px; color: #00cc66; font-size: 11px; font-weight: 700; }
  .state i { width: 5px; height: 5px; }
  .state.paused { color: #d4a017; }
  .state.paused i { background: #d4a017; }
  .state.partial { color: var(--term-text-2); }
  .state.partial i { background: var(--term-text-2); }
  .height { color: var(--term-text-3); }
  .lag { color: var(--term-text-strong, #fff); font-weight: 700; white-space: nowrap; }

  .stuck-bundles { background: #080808; }
  .stuck-bundle { border-top: 1px solid #181112; background: rgba(220, 53, 69, .018); }
  .stuck-bundle:first-child { border-top: 0; }
  .stuck-bundle[open] { background: rgba(220, 53, 69, .03); }
  .stuck-bundle summary {
    display: grid;
    grid-template-columns: minmax(145px, .85fr) 120px minmax(180px, 1.2fr) 125px minmax(185px, auto);
    align-items: center;
    gap: 16px;
    min-height: 64px;
    padding: 10px 14px;
    color: var(--term-text-2);
    cursor: pointer;
    list-style: none;
  }
  .stuck-bundle summary::-webkit-details-marker { display: none; }
  .stuck-bundle summary:hover { background: rgba(220, 53, 69, .045); }
  .stuck-bundle summary:focus-visible { outline: 1px solid var(--term-error); outline-offset: -2px; }
  .stuck-bundle-chain { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .stuck-bundle-chain > i {
    display: grid;
    flex: 0 0 28px;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 1px solid #2a1a1d;
    color: #e0b4b9;
    font: normal 700 10px/1 'JetBrains Mono', monospace;
  }
  .stuck-bundle-chain strong,
  .stuck-bundle-metric strong { display: block; overflow: hidden; color: var(--term-text-body); font: 700 11px/1.4 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
  .stuck-bundle-chain small,
  .stuck-bundle-metric small { display: block; margin-top: 3px; color: var(--term-text-5); font: 11px/1.35 'JetBrains Mono', monospace; }
  .stuck-bundle-metric { min-width: 0; }
  .stuck-bundle-metric:nth-child(2) strong,
  .stuck-bundle-metric:nth-child(4) strong { color: #e0b4b9; }
  .stuck-bundle-action { display: flex; align-items: center; justify-content: flex-end; gap: 9px; color: var(--term-text-3); font: 700 11px/1.4 'JetBrains Mono', monospace; white-space: nowrap; }
  .stuck-bundle-action i::before { color: var(--term-error); font-style: normal; content: '[+]'; }
  .stuck-bundle .when-open { display: none; }
  .stuck-bundle[open] .when-closed { display: none; }
  .stuck-bundle[open] .when-open { display: inline; }
  .stuck-bundle[open] .stuck-bundle-action i::before { content: '[-]'; }
  .stuck-bundle-details { border-top: 1px solid #211416; background: #080808; }
  .stuck-table { min-width: 840px; }
  .stuck-row { background: rgba(220, 53, 69, .018); }
  .stuck-row:hover { background: rgba(220, 53, 69, .045); }
  .stuck-row td { border-top-color: #181112; vertical-align: middle; }
  .stuck-row small { display: block; margin-top: 4px; color: var(--term-text-5); font: 11px/1.4 'JetBrains Mono', monospace; }
  .tx-id { color: var(--term-text-body); font: 600 11px/1.4 'JetBrains Mono', monospace; text-decoration: none; }
  .tx-id span { color: var(--term-error); }
  .tx-id:hover { color: #fff; }
  .stuck-state { display: inline-flex; align-items: center; gap: 6px; color: var(--term-error); font: 800 11px/1.3 'JetBrains Mono', monospace; letter-spacing: .08em; }
  .stuck-state i { width: 5px; height: 5px; border-radius: 50%; background: var(--term-error); box-shadow: 0 0 7px rgba(220, 53, 69, .35); }
  .outstanding-amount,
  .overdue-time { color: #e0b4b9; font: 700 11px/1.4 'JetBrains Mono', monospace; white-space: nowrap; }
  .destination { color: var(--term-text-3); font: 11px/1.4 'JetBrains Mono', monospace; }
  .clean-state span { margin-right: 8px; color: #00cc66; }

  .lower-grid {
    display: grid;
    grid-template-columns: 1.08fr .92fr;
    gap: 16px;
  }

  .timeline { margin: 0; padding: 7px 16px 8px; list-style: none; }
  .timeline li { position: relative; display: grid; grid-template-columns: 24px 14px 1fr; min-height: 67px; padding-top: 11px; }
  .timeline li:not(:last-child)::after { content: ''; position: absolute; top: 27px; bottom: -2px; left: 31px; border-left: 1px dashed #222; }
  .timeline-index { color: var(--term-text-5); font: 10px/1.4 'JetBrains Mono', monospace; }
  .timeline-node { z-index: 1; width: 7px; height: 7px; margin-top: 2px; background: #00cc66; }
  .timeline-node.warn { background: #d4a017; }
  .timeline-content { min-width: 0; }
  .timeline-content > div { display: flex; min-width: 0; justify-content: space-between; gap: 8px; }
  .timeline-content strong { min-width: 0; color: var(--term-text-body); font: 600 11px/1.4 'JetBrains Mono', monospace; overflow-wrap: anywhere; }
  .update-key { display: block; flex: 0 1 50%; max-width: 50%; overflow: hidden; color: var(--term-text-5); font: 11px/1.4 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
  .timeline-content small,
  .vote-time { display: block; margin-top: 5px; color: var(--term-text-4); font: 11px/1.4 'JetBrains Mono', monospace; }
  .timeline-content a { color: var(--term-text-3); text-decoration: none; }
  .timeline-content a:hover { color: #00cc66; }

  .vote-list { padding: 0 16px; }
  .vote-row { padding: 13px 0 12px; border-bottom: 1px solid #111; }
  .vote-row:last-child { border-bottom: 0; }
  .vote-main { justify-content: space-between; gap: 12px; }
  .vote-main strong { display: block; max-width: 300px; overflow: hidden; color: var(--term-text-body); font: 600 11px/1.4 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
  .vote-main small { color: var(--term-text-4); font: 11px/1.4 'JetBrains Mono', monospace; }
  .vote-main small span { color: var(--term-text-2); }
  .vote-state { color: #d4a017; font: 700 11px/1.3 'JetBrains Mono', monospace; letter-spacing: .12em; }
  .vote-state.passed { color: #00cc66; }
  .vote-progress { gap: 10px; margin-top: 9px; }
  .vote-progress > div { flex: 1; height: 3px; background: #181818; }
  .vote-progress i { display: block; height: 100%; background: #00cc66; }
  .vote-progress > span { min-width: 72px; color: var(--term-text-3); font: 11px/1.3 'JetBrains Mono', monospace; text-align: right; }

  .inline-alert,
  .empty-state { margin: 14px 16px; padding: 11px 12px; color: var(--term-text-3); font: 11px/1.5 'JetBrains Mono', monospace; }
  .inline-alert span { color: #d4a017; }

  .source-line {
    gap: 8px;
    margin-top: 14px;
    color: var(--term-text-5);
    font: 11px/1.4 'JetBrains Mono', monospace;
  }
  .source-line > span { color: #00cc66; }
  .source-line i { display: inline-block; width: 5px; height: 5px; margin-right: 4px; animation: pulse-dot 2s infinite; }
  .source-line.stalled > span { color: var(--term-error); }
  .source-line.stalled i { background: var(--term-error); animation: none; }
  .source-line em { margin-left: auto; color: var(--term-text-4); font-style: normal; }

  @keyframes pulse-dot { 50% { opacity: .45; } }
  @keyframes cursor-blink { 50% { opacity: 0; } }
  @keyframes loader { 50% { opacity: .35; } }

  @media (max-width: 820px) {
    .overview-grid { grid-template-columns: 1fr; }
    .metric-grid { grid-template-columns: repeat(2, 1fr); }
    .metric:nth-child(2) { border-right: 0; }
    .metric:nth-child(-n + 2) { border-bottom: 1px solid #1a1a1a; }
    .lower-grid { grid-template-columns: 1fr; }
    .network-callout { align-items: flex-start; flex-wrap: wrap; gap: 12px; }
    .network-notes { order: 3; width: 100%; padding: 12px 0 0; border-top: 1px solid #1a1a1a; border-left: 0; }
    .text-link { margin-left: auto; }
    .churn-card { justify-content: flex-start; }
    .stuck-bundle summary { grid-template-columns: minmax(140px, 1fr) 110px 125px minmax(155px, auto); }
    .stuck-bundle-stages { display: none; }
  }

  @media (max-width: 560px) {
    .status-dashboard { width: min(100% - 20px, 1080px); padding-top: 14px; }
    .title-row { align-items: flex-start; }
    h1 { font-size: 23px; }
    .title-row p { max-width: 280px; font-size: 13px; }
    .command-line > span:nth-child(2) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .metric { min-height: 100px; padding: 14px; }
    .metric strong { font-size: 19px; }
    th, td { min-width: 112px; padding: 9px 11px; }
    th:first-child, td:first-child { position: sticky; left: 0; z-index: 1; min-width: 88px; background: #0a0a0a; }
    th:first-child { background: #080808; }
    .source-line { align-items: flex-start; flex-wrap: wrap; }
    .source-line em { width: 100%; margin-left: 0; }
    .timeline-content > div { display: block; }
    .update-key { max-width: 100%; margin-top: 3px; }
    .stuck-bundle summary { grid-template-columns: 1fr auto; gap: 10px 14px; padding: 11px; }
    .stuck-bundle-metric:nth-child(4),
    .stuck-bundle-action { justify-self: end; }
    .stuck-bundle-action { grid-column: 1 / -1; width: 100%; padding-top: 8px; border-top: 1px solid #181112; }
  }
</style>
