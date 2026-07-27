<script>
  import { onDestroy, onMount } from 'svelte';

  import { fetchStatusDashboard, fetchStatusLive } from './status/api.js';
  import BlockProductionChart from './status/BlockProductionChart.svelte';

  const DASHBOARD_REFRESH_INTERVAL_MS = 60_000;
  const LIVE_REFRESH_INTERVAL_MS = 15_000;
  const number = new Intl.NumberFormat('en-US');

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
  $: activeNodeCount = Number(currentDashboard?.network?.active_node_count || 0);
  $: networkVersion = currentDashboard?.network?.majority_version || '-';
  $: thorchainHeight = Number(currentDashboard?.network?.height || 0);
  $: churnStatus = currentDashboard?.churn || {
    isPaused: false,
    mimirValue: 0,
    lastChurnHeight: 0,
    lastChurnTimestampMs: 0,
    blocksSince: 0,
    estimated: true
  };
  $: governanceVotes = currentDashboard?.votes?.governance || [];
  $: statusUpdates = currentDashboard?.votes?.status_updates || [];
  $: stuckDashboard = currentDashboard?.stuck_transactions || null;
  $: stuckTransactions = stuckDashboard?.transactions || [];
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

  function stateLabel(state) {
    if (state === 'enabled') return 'ENABLED';
    if (state === 'partial') return 'PARTIAL';
    return 'PAUSED';
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
      <span class="status-pill {networkSummary.tone}">
        <span class="dot"></span>{networkSummary.label}
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

  {#if statusError}
    <div class="alert err"><span>ERR</span>{statusError}</div>
  {/if}

  {#if loading}
    <div class="loading-panel"><span>▓░░░░</span> Reading live network state...</div>
  {:else if chainStatuses.length > 0}
    <div class="overview-grid">
      <section class="network-callout {networkSummary.tone}">
        <div class="network-state">
          <span class="state-dot"></span>
          <div>
            <small>NETWORK STATE</small>
            <strong>{networkSummary.label}</strong>
          </div>
        </div>
        <div class="network-notes">
          <p>
            Trading is available on <strong>{networkSummary.tradingEnabled} of {networkSummary.total}</strong> connected chains.
            {#if haltedChains.length}Paused: <span>{haltedChains.join(', ')}</span>.{/if}
          </p>
          <p>
            LP actions are available on <strong>{networkSummary.lpEnabled} of {networkSummary.total}</strong> chains;
            signing on <strong>{networkSummary.signingEnabled} of {networkSummary.total}</strong>.
            {#if networkSummary.lpPartial}Partial LP availability: <span>{networkSummary.lpPartial}</span>.{/if}
          </p>
        </div>
        <a class="text-link" href="https://thorchain.net/network" target="_blank" rel="noopener noreferrer">
          Full network <span>↗</span>
        </a>
      </section>

      <section class="churn-card" class:paused={churnStatus.isPaused} aria-label="Validator churn status">
        <div class="churn-head">
          <span class="churn-dot"></span>
          <div>
            <small>VALIDATOR CHURN</small>
            <strong>{churnStatus.isPaused ? 'PAUSED' : 'ACTIVE'}</strong>
          </div>
        </div>
        <div class="churn-meta">
          <span>Last churn</span>
          <strong>{formatElapsed(churnStatus.lastChurnTimestampMs)} ago</strong>
          <small>
            block {number.format(churnStatus.lastChurnHeight)}
            {#if churnStatus.estimated || churnError} · estimated{/if}
          </small>
        </div>
        <span class="churn-mimir">[HALTCHURNING={churnStatus.mimirValue}]</span>
      </section>
    </div>

    <section class="metric-grid" aria-label="Network summary">
      <div class="metric">
        <span class="metric-index">01</span>
        <span class="metric-label">THORChain Block</span>
        <strong>{number.format(thorchainHeight)}</strong>
        <small>live height</small>
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
              <th>Signing</th>
              <th>Last Observed</th>
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
        {#if stuckTransactions.length === 0}
          <div class="empty-state clean-state"><span>✓</span>No currently detected stuck transactions.</div>
        {:else}
          <div class="table-wrap">
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
                {#each stuckTransactions as transaction}
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
                    <span class="update-key">{update.key}={update.value}</span>
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

    <div class="source-line">
      <span><i></i> LIVE</span>
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
    color: #c8c8c8;
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
    color: #666;
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
    color: #888;
    font: 700 9px/1.2 'JetBrains Mono', monospace;
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
    color: #e8e8e8;
    font: 800 30px/1.1 'JetBrains Mono', monospace;
    letter-spacing: .06em;
  }

  .cursor {
    color: #00cc66;
    animation: cursor-blink 1s steps(1) infinite;
  }

  .title-row p {
    margin: 0;
    color: #666;
    font-size: 13px;
  }

  .bracket-button {
    flex: 0 0 auto;
    padding: 6px 11px;
    border: 1px solid #1a1a1a;
    border-radius: 0;
    background: transparent;
    color: #888;
    font: 600 10px/1 'JetBrains Mono', monospace;
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
  .inline-alert span { margin-right: 10px; color: #dc3545; font-weight: 800; }
  .loading-panel span { margin-right: 10px; color: #00cc66; animation: loader 1.2s steps(5) infinite; }

  .network-callout {
    min-height: 78px;
    padding: 14px 16px;
    border: 1px solid #1a1a1a;
    border-left: 2px solid #00cc66;
    background: rgba(0, 204, 102, .035);
  }

  .network-callout.warn { border-left-color: #d4a017; background: rgba(212, 160, 23, .035); }
  .network-callout.err { border-left-color: #dc3545; background: rgba(220, 53, 69, .035); }
  .overview-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    gap: 16px;
    margin-bottom: 16px;
  }
  .network-state { min-width: 168px; gap: 12px; }
  .network-state small { display: block; margin-bottom: 3px; color: #555; font: 700 9px/1.2 'JetBrains Mono', monospace; letter-spacing: .14em; }
  .network-state strong { color: #e8e8e8; font: 800 16px/1.2 'JetBrains Mono', monospace; text-transform: uppercase; }

  .network-notes {
    flex: 1;
    padding: 0 24px;
    border-left: 1px solid #1a1a1a;
  }

  .network-notes p { margin: 2px 0; color: #888; font-size: 12px; }
  .network-notes strong { color: #c8c8c8; font-family: 'JetBrains Mono', monospace; }
  .network-notes span { color: #d4a017; font-family: 'JetBrains Mono', monospace; }
  .text-link,
  .block-title a {
    color: #666;
    font: 600 9px/1.2 'JetBrains Mono', monospace;
    text-decoration: none;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .text-link:hover,
  .block-title a:hover { color: #00cc66; }

  .churn-card {
    position: relative;
    min-height: 78px;
    gap: 14px;
    padding: 14px 16px;
    border: 1px solid #1a1a1a;
    border-left: 2px solid #00cc66;
    background: rgba(0, 204, 102, .035);
  }
  .churn-card.paused { border-left-color: #d4a017; background: rgba(212, 160, 23, .035); }
  .churn-head { min-width: 94px; gap: 10px; }
  .churn-dot { width: 6px; height: 6px; border-radius: 50%; background: #00cc66; box-shadow: 0 0 6px rgba(0, 204, 102, .4); animation: pulse-dot 2s infinite; }
  .churn-card.paused .churn-dot { background: #d4a017; box-shadow: none; animation: none; }
  .churn-head small,
  .churn-meta span { display: block; color: #555; font: 700 8px/1.2 'JetBrains Mono', monospace; letter-spacing: .12em; }
  .churn-head strong { color: #e8e8e8; font: 800 14px/1.2 'JetBrains Mono', monospace; }
  .churn-meta { min-width: 0; padding-left: 14px; border-left: 1px solid #1a1a1a; }
  .churn-meta strong { display: block; margin: 3px 0 2px; color: #c8c8c8; font: 700 11px/1.2 'JetBrains Mono', monospace; white-space: nowrap; }
  .churn-meta small { color: #555; font: 8px/1.2 'JetBrains Mono', monospace; white-space: nowrap; }
  .churn-mimir { position: absolute; top: 7px; right: 9px; color: #333; font: 7px/1 'JetBrains Mono', monospace; }

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
  .metric-index { position: absolute; top: 13px; right: 14px; color: #00cc66; font: 600 9px/1 'JetBrains Mono', monospace; }
  .metric-label { display: block; color: #666; font: 700 9px/1.2 'JetBrains Mono', monospace; letter-spacing: .12em; text-transform: uppercase; }
  .metric strong { display: block; margin: 20px 0 4px; color: #e8e8e8; font: 800 23px/1 'JetBrains Mono', monospace; }
  .metric small { color: #555; font: 10px/1.2 'JetBrains Mono', monospace; }

  .block {
    border: 1px solid #1a1a1a;
    background: #0a0a0a;
  }

  .chain-block { margin-bottom: 16px; }
  .stuck-block { margin-bottom: 16px; border-color: rgba(0, 204, 102, .18); }
  .stuck-block.has-stuck { border-color: #241518; }
  .stuck-block.has-stuck .block-title h2 span { color: #dc3545; }
  .stuck-count {
    padding: 3px 7px;
    border: 1px solid rgba(0, 204, 102, .28);
    color: #00cc66;
    font: 700 8px/1 'JetBrains Mono', monospace;
    letter-spacing: .1em;
  }
  .stuck-block.has-stuck .stuck-count {
    border-color: rgba(220, 53, 69, .28);
    color: #dc3545;
  }
  .stuck-criteria {
    margin: 0;
    padding: 10px 16px;
    border-bottom: 1px solid #151112;
    color: #555;
    font: 9px/1.5 'JetBrains Mono', monospace;
  }
  .block-title { justify-content: space-between; min-height: 44px; padding: 0 16px; border-bottom: 1px solid #1a1a1a; }
  .block-title h2 { margin: 0; color: #aaa; font: 700 11px/1.2 'JetBrains Mono', monospace; letter-spacing: .08em; text-transform: uppercase; }
  .block-title h2 span { color: #00cc66; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-family: 'JetBrains Mono', monospace; }
  th { padding: 10px 14px; color: #555; font-size: 9px; letter-spacing: .12em; text-align: left; text-transform: uppercase; background: #080808; }
  td { padding: 10px 14px; border-top: 1px solid #111; color: #888; font-size: 11px; }
  tbody tr:hover { background: #0d0d0d; }
  tbody tr.degraded .chain-cell strong { color: #d4a017; }
  .chain-cell { display: flex; align-items: center; gap: 10px; }
  .chain-cell > span { display: grid; place-items: center; width: 24px; height: 24px; border: 1px solid #222; color: #666; font-size: 8px; }
  .chain-cell strong { color: #c8c8c8; font-size: 11px; }
  .state { display: inline-flex; align-items: center; gap: 6px; color: #00cc66; font-size: 9px; font-weight: 700; }
  .state i { width: 5px; height: 5px; }
  .state.paused { color: #d4a017; }
  .state.paused i { background: #d4a017; }
  .state.partial { color: #888; }
  .state.partial i { background: #888; }
  .height { color: #666; }

  .stuck-table { min-width: 840px; }
  .stuck-row { background: rgba(220, 53, 69, .018); }
  .stuck-row:hover { background: rgba(220, 53, 69, .045); }
  .stuck-row td { border-top-color: #181112; vertical-align: middle; }
  .stuck-row small { display: block; margin-top: 4px; color: #4d4d4d; font: 8px/1.25 'JetBrains Mono', monospace; }
  .tx-id { color: #c8c8c8; font: 600 10px/1.2 'JetBrains Mono', monospace; text-decoration: none; }
  .tx-id span { color: #dc3545; }
  .tx-id:hover { color: #fff; }
  .stuck-state { display: inline-flex; align-items: center; gap: 6px; color: #dc3545; font: 800 9px/1 'JetBrains Mono', monospace; letter-spacing: .08em; }
  .stuck-state i { width: 5px; height: 5px; border-radius: 50%; background: #dc3545; box-shadow: 0 0 7px rgba(220, 53, 69, .35); }
  .outstanding-amount,
  .overdue-time { color: #e0b4b9; font: 700 10px/1.2 'JetBrains Mono', monospace; white-space: nowrap; }
  .destination { color: #777; font: 10px/1.2 'JetBrains Mono', monospace; }
  .clean-state span { margin-right: 8px; color: #00cc66; }

  .lower-grid {
    display: grid;
    grid-template-columns: 1.08fr .92fr;
    gap: 16px;
  }

  .timeline { margin: 0; padding: 7px 16px 8px; list-style: none; }
  .timeline li { position: relative; display: grid; grid-template-columns: 24px 14px 1fr; min-height: 67px; padding-top: 11px; }
  .timeline li:not(:last-child)::after { content: ''; position: absolute; top: 27px; bottom: -2px; left: 31px; border-left: 1px dashed #222; }
  .timeline-index { color: #444; font: 9px/1.3 'JetBrains Mono', monospace; }
  .timeline-node { z-index: 1; width: 7px; height: 7px; margin-top: 2px; background: #00cc66; }
  .timeline-node.warn { background: #d4a017; }
  .timeline-content { min-width: 0; }
  .timeline-content > div { display: flex; justify-content: space-between; gap: 8px; }
  .timeline-content strong { color: #c8c8c8; font: 600 11px/1.3 'JetBrains Mono', monospace; }
  .update-key { color: #444; font: 9px/1.3 'JetBrains Mono', monospace; white-space: nowrap; }
  .timeline-content small,
  .vote-time { display: block; margin-top: 5px; color: #555; font: 9px/1.3 'JetBrains Mono', monospace; }
  .timeline-content a { color: #666; text-decoration: none; }
  .timeline-content a:hover { color: #00cc66; }

  .vote-list { padding: 0 16px; }
  .vote-row { padding: 13px 0 12px; border-bottom: 1px solid #111; }
  .vote-row:last-child { border-bottom: 0; }
  .vote-main { justify-content: space-between; gap: 12px; }
  .vote-main strong { display: block; max-width: 300px; overflow: hidden; color: #c8c8c8; font: 600 11px/1.3 'JetBrains Mono', monospace; text-overflow: ellipsis; white-space: nowrap; }
  .vote-main small { color: #555; font: 9px/1.3 'JetBrains Mono', monospace; }
  .vote-main small span { color: #888; }
  .vote-state { color: #d4a017; font: 700 8px/1 'JetBrains Mono', monospace; letter-spacing: .12em; }
  .vote-state.passed { color: #00cc66; }
  .vote-progress { gap: 10px; margin-top: 9px; }
  .vote-progress > div { flex: 1; height: 3px; background: #181818; }
  .vote-progress i { display: block; height: 100%; background: #00cc66; }
  .vote-progress > span { min-width: 72px; color: #666; font: 9px/1 'JetBrains Mono', monospace; text-align: right; }

  .inline-alert,
  .empty-state { margin: 14px 16px; padding: 11px 12px; color: #666; font: 10px/1.5 'JetBrains Mono', monospace; }
  .inline-alert span { color: #d4a017; }

  .source-line {
    gap: 8px;
    margin-top: 14px;
    color: #444;
    font: 9px/1.3 'JetBrains Mono', monospace;
  }
  .source-line > span { color: #00cc66; }
  .source-line i { display: inline-block; width: 5px; height: 5px; margin-right: 4px; animation: pulse-dot 2s infinite; }
  .source-line em { margin-left: auto; color: #555; font-style: normal; }

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
  }

  @media (max-width: 560px) {
    .status-dashboard { width: min(100% - 20px, 1080px); padding-top: 14px; }
    .title-row { align-items: flex-start; }
    h1 { font-size: 23px; }
    .title-row p { max-width: 280px; font-size: 12px; }
    .command-line > span:nth-child(2) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .metric { min-height: 100px; padding: 14px; }
    .metric strong { font-size: 19px; }
    th, td { min-width: 112px; padding: 9px 11px; }
    th:first-child, td:first-child { position: sticky; left: 0; z-index: 1; min-width: 88px; background: #0a0a0a; }
    th:first-child { background: #080808; }
    .source-line { align-items: flex-start; flex-wrap: wrap; }
    .source-line em { width: 100%; margin-left: 0; }
    .timeline-content > div { display: block; }
    .update-key { display: block; margin-top: 3px; }
  }
</style>
