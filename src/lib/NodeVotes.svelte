<script>
  import { onDestroy, onMount } from 'svelte';
  import {
    fetchNodeVoteDetails,
    fetchNodeVoteNodeDetails,
    fetchNodeVotesDashboard
  } from './node-votes/api.js';
  import { mergeNodeVotesDashboard } from './node-votes/dashboard-state.js';
  import { findMissingVoters } from './node-votes/missing-voters.js';
  import { formatNumber } from '$lib/utils/formatting';

  const REFRESH_INTERVAL_MS = 60000;

  let dashboard = null;
  let loading = true;
  let refreshing = false;
  let error = '';
  let activeTab = 'vote';
  let categoryFilter = 'all';
  let expandedVoteKey = '';
  let missingVotersKey = '';
  let expandedNodeAddress = '';
  let voteSortMode = 'last-vote';
  let nodeSortMode = 'last-vote';
  let searchTerm = '';
  let refreshTimer = null;
  let voteDetailLoading = {};
  let voteDetailErrors = {};
  let nodeDetailLoading = {};
  let nodeDetailErrors = {};
  let dashboardRequestId = 0;

  $: stats = dashboard?.stats || {};
  $: categoryStats = stats.categories || {};
  $: backend = dashboard?.backend || {};
  $: voteRows = dashboard?.by_vote || [];
  $: activeNodes = dashboard?.active_nodes || [];
  $: nodeRows = dashboard?.by_node || [];
  $: latestEvents = dashboard?.latest_events || [];
  $: filteredVoteRows = sortVoteRows(filterVoteRows(voteRows, searchTerm, categoryFilter), voteSortMode);
  $: filteredNodeRows = sortNodeRows(filterNodeRows(nodeRows, searchTerm, categoryFilter), nodeSortMode);
  $: avgResponseSortLabel = nodeSortMode === 'avg-response-asc'
    ? 'FASTEST'
    : nodeSortMode === 'avg-response-desc'
      ? 'SLOWEST'
      : 'SORT';
  $: percentVotedSortLabel = nodeSortMode === 'percent-voted-desc'
    ? 'HIGH FIRST'
    : nodeSortMode === 'percent-voted-asc'
      ? 'LOW FIRST'
      : 'SORT';
  $: wsStatus = backend?.ws_listener?.stats?.stream_status || backend?.ws_listener?.status || 'unknown';
  $: backfillStatus = backend?.backfill?.status || 'unknown';
  $: ingestionSource = dashboardIngestionSource(backend);

  onMount(() => {
    loadDashboard();
    refreshTimer = setInterval(() => loadDashboard({ silent: true }), REFRESH_INTERVAL_MS);
  });

  onDestroy(() => {
    dashboardRequestId += 1;
    clearInterval(refreshTimer);
  });

  async function loadDashboard(options = {}) {
    const requestId = ++dashboardRequestId;
    if (!options.silent) {
      loading = !dashboard;
      refreshing = Boolean(dashboard);
    }
    error = '';

    try {
      const refreshedDashboard = await fetchNodeVotesDashboard({ forceRefresh: !options.silent });
      if (requestId !== dashboardRequestId) return;
      dashboard = mergeNodeVotesDashboard(dashboard, refreshedDashboard);
    } catch (loadError) {
      if (requestId !== dashboardRequestId) return;
      error = loadError.message || String(loadError);
    } finally {
      if (requestId === dashboardRequestId) {
        loading = false;
        refreshing = false;
      }
    }
  }

  function matchesCategory(row, category) {
    if (category === 'all') return true;
    return row?.mimir_category === category;
  }

  function nodeMatchesCategory(row, category) {
    if (category === 'all') return true;
    return (row?.category_counts?.[category] || 0) > 0;
  }

  function filterVoteRows(rows, term, category) {
    const q = term.trim().toLowerCase();
    return rows.filter((row) => {
      if (!matchesCategory(row, category)) return false;
      if (!q) return true;
      return (
        row.mimir_key.toLowerCase().includes(q) ||
        row.mimir_category.toLowerCase().includes(q) ||
        row.consensus_model.toLowerCase().includes(q) ||
        row.leader_value.toLowerCase().includes(q) ||
        row.values.some((value) => (
          String(value.value).toLowerCase().includes(q) ||
          value.nodes.some((node) => node.toLowerCase().includes(q)) ||
          value.operators.some((operator) => operator.toLowerCase().includes(q))
        ))
      );
    });
  }

  function voteRowTime(row) {
    const parsed = Date.parse(row?.latest_vote_at || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function sortVoteRowsByLastVote(rows) {
    return [...rows].sort((left, right) => {
      const timeDiff = voteRowTime(right) - voteRowTime(left);
      if (timeDiff !== 0) return timeDiff;
      const heightDiff = (right.latest_height || 0) - (left.latest_height || 0);
      if (heightDiff !== 0) return heightDiff;
      return left.mimir_key.localeCompare(right.mimir_key);
    });
  }

  function sortVoteRows(rows, mode) {
    if (mode !== 'consensus-passed' && mode !== 'consensus-progress') {
      return sortVoteRowsByLastVote(rows);
    }

    return sortVoteRowsByLastVote(rows).sort((left, right) => {
      const leftPassed = left?.consensus_ready ? 1 : 0;
      const rightPassed = right?.consensus_ready ? 1 : 0;
      const statusDiff = mode === 'consensus-passed'
        ? rightPassed - leftPassed
        : leftPassed - rightPassed;

      return statusDiff;
    });
  }

  function filterNodeRows(rows, term, category) {
    const q = term.trim().toLowerCase();
    return rows.filter((row) => {
      if (!nodeMatchesCategory(row, category)) return false;
      if (!q) return true;
      return (
        row.node_address.toLowerCase().includes(q) ||
        row.operator_address.toLowerCase().includes(q) ||
        row.node_status.toLowerCase().includes(q)
      );
    });
  }

  function sortNodeRowsByLastVote(rows) {
    return [...rows].sort((left, right) => {
      const timeDiff = voteRowTime(right) - voteRowTime(left);
      if (timeDiff !== 0) return timeDiff;
      const heightDiff = (right.latest_height || 0) - (left.latest_height || 0);
      if (heightDiff !== 0) return heightDiff;
      return left.node_address.localeCompare(right.node_address);
    });
  }

  function compareNullableNumbers(leftValue, rightValue, direction) {
    const left = Number(leftValue);
    const right = Number(rightValue);
    const leftValid = Number.isFinite(left);
    const rightValid = Number.isFinite(right);
    if (leftValid !== rightValid) return leftValid ? -1 : 1;
    if (!leftValid && !rightValid) return 0;
    return direction === 'asc' ? left - right : right - left;
  }

  function sortNodeRows(rows, mode) {
    const baseRows = sortNodeRowsByLastVote(rows);
    if (mode === 'avg-response-asc' || mode === 'avg-response-desc') {
      const direction = mode === 'avg-response-asc' ? 'asc' : 'desc';
      return baseRows.sort((left, right) => (
        compareNullableNumbers(left.avg_response_time_ms, right.avg_response_time_ms, direction)
      ));
    }
    if (mode === 'percent-voted-desc' || mode === 'percent-voted-asc') {
      const direction = mode === 'percent-voted-asc' ? 'asc' : 'desc';
      return baseRows.sort((left, right) => (
        compareNullableNumbers(left.economic_voted_percent, right.economic_voted_percent, direction)
      ));
    }
    return baseRows;
  }

  function shortAddress(address) {
    if (!address) return '-';
    return address.slice(-4);
  }

  function formatDateTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '-';
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function timestampMs(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatDuration(ms) {
    const totalMinutes = Math.max(0, Math.floor(ms / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    if (days >= 1) {
      return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    }
    if (hours >= 1) {
      return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
    return `${Math.max(1, minutes)}m`;
  }

  function durationBetween(start, end) {
    const startMs = timestampMs(start);
    const endMs = end ? timestampMs(end) : Date.now();
    if (!startMs || !endMs || endMs < startMs) return '';
    return formatDuration(endMs - startMs);
  }

  function oldestVoteTime(row) {
    return row?.first_vote_at || row?.vote_history?.at(-1)?.block_time || row?.latest_vote_at || '';
  }

  function oldestEffectiveChangeTime(row) {
    return row?.passed_at || row?.effective_history?.at(-1)?.block_time || '';
  }

  function latestEffectiveChangeTime(row) {
    return row?.current_value_changed_at || row?.effective_history?.[0]?.block_time || '';
  }

  function consensusTimingLabel(row) {
    if (row?.mimir_category === 'operational') {
      const latestChange = latestEffectiveChangeTime(row);
      return latestChange
        ? `value changed ${durationBetween(latestChange)} ago`
        : 'no value change in window';
    }

    const firstVote = oldestVoteTime(row);
    if (!firstVote) return '-';
    if (row?.consensus_ready) {
      const firstPassed = oldestEffectiveChangeTime(row);
      return firstPassed
        ? `passed in ${durationBetween(firstVote, firstPassed)}`
        : `first vote ${durationBetween(firstVote)} ago`;
    }
    return `first vote ${durationBetween(firstVote)} ago`;
  }

  function statusTone(status) {
    const value = String(status || '').toLowerCase();
    if (['running', 'success', 'active'].includes(value)) return 'ok';
    if (['starting', 'unknown'].includes(value)) return 'warn';
    return 'err';
  }

  function dashboardIngestionSource(state) {
    const source = state?.backfill?.stats?.source || 'unknown';
    const streamStatus = state?.ws_listener?.stats?.stream_status || state?.ws_listener?.status || '';
    return streamStatus === 'running' ? `${source}+ws` : source;
  }

  function categoryLabel(category) {
    return category === 'operational' ? 'OPERATIONAL' : 'ECONOMIC';
  }

  function categoryThreshold(category) {
    return category === 'operational'
      ? stats.operational_votes_min
      : stats.consensus_threshold;
  }

  function categoryTooltip(category) {
    const threshold = formatNumber(categoryThreshold(category) || 0);
    if (category === 'operational') {
      return `Operational Mimir: runtime safety/control keys that pass at the OperationalVotesMin threshold. Current threshold: ${threshold} matching node votes.`;
    }
    return `Economic Mimir: economic parameter keys that require active-validator supermajority. Current threshold: ${threshold} matching node votes.`;
  }

  function formatPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '-';
    return `${numeric.toFixed(numeric >= 10 ? 0 : 1)}%`;
  }

  function consensusProgressPercent(row, value) {
    const count = Number(value?.count || 0);
    const threshold = Number(row?.consensus_threshold || 0);
    if (!Number.isFinite(count) || !Number.isFinite(threshold) || threshold <= 0) return 0;
    return Math.min(100, (count / threshold) * 100);
  }

  function formatResponseTime(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return '-';
    if (numeric === 0) return '0m';
    return formatDuration(numeric);
  }

  function updateVoteRow(key, values) {
    dashboard = {
      ...dashboard,
      by_vote: (dashboard?.by_vote || []).map((row) => (
        row.mimir_key === key ? { ...row, ...values } : row
      ))
    };
  }

  function updateNodeRow(address, values) {
    dashboard = {
      ...dashboard,
      by_node: (dashboard?.by_node || []).map((row) => (
        row.node_address === address ? { ...row, ...values } : row
      ))
    };
  }

  async function loadVoteDetails(key, append = false) {
    const row = dashboard?.by_vote?.find((candidate) => candidate.mimir_key === key);
    if (!row || voteDetailLoading[key]) return;
    voteDetailLoading = { ...voteDetailLoading, [key]: true };
    voteDetailErrors = { ...voteDetailErrors, [key]: '' };
    try {
      const payload = await fetchNodeVoteDetails(key, {
        cursor: append ? row.detail_pagination?.next_cursor : '',
        limit: 200
      });
      updateVoteRow(key, {
        node_votes: payload.node_votes || [],
        vote_history: append
          ? [...(row.vote_history || []), ...(payload.vote_history || [])]
          : payload.vote_history || [],
        effective_history: payload.effective_history?.length
          ? payload.effective_history
          : row.effective_history || [],
        detail_pagination: payload.pagination || null
      });
    } catch (detailError) {
      voteDetailErrors = {
        ...voteDetailErrors,
        [key]: detailError?.message || 'Unable to load vote details.'
      };
    } finally {
      voteDetailLoading = { ...voteDetailLoading, [key]: false };
    }
  }

  async function toggleVoteKey(key) {
    if (expandedVoteKey === key) {
      expandedVoteKey = '';
      return;
    }
    expandedVoteKey = key;
    const row = dashboard?.by_vote?.find((candidate) => candidate.mimir_key === key);
    if (!Array.isArray(row?.vote_history)) await loadVoteDetails(key);
  }

  function canInspectMissingVoters(row) {
    return row?.current_vote_source === 'thornode-active-node-mimir' && activeNodes.length > 0;
  }

  async function toggleMissingVoters(key) {
    if (missingVotersKey === key) {
      missingVotersKey = '';
      return;
    }
    missingVotersKey = key;
    const row = dashboard?.by_vote?.find((candidate) => candidate.mimir_key === key);
    if (!Array.isArray(row?.node_votes)) await loadVoteDetails(key);
  }

  async function loadNodeDetails(address, append = false) {
    const row = dashboard?.by_node?.find((candidate) => candidate.node_address === address);
    if (!row || nodeDetailLoading[address]) return;
    nodeDetailLoading = { ...nodeDetailLoading, [address]: true };
    nodeDetailErrors = { ...nodeDetailErrors, [address]: '' };
    try {
      const payload = await fetchNodeVoteNodeDetails(address, {
        cursor: append ? row.detail_pagination?.next_cursor : '',
        limit: 200
      });
      updateNodeRow(address, {
        vote_history: append
          ? [...(row.vote_history || []), ...(payload.vote_history || [])]
          : payload.vote_history || [],
        detail_pagination: payload.pagination || null
      });
    } catch (detailError) {
      nodeDetailErrors = {
        ...nodeDetailErrors,
        [address]: detailError?.message || 'Unable to load node details.'
      };
    } finally {
      nodeDetailLoading = { ...nodeDetailLoading, [address]: false };
    }
  }

  async function toggleNode(address) {
    if (expandedNodeAddress === address) {
      expandedNodeAddress = '';
      return;
    }
    expandedNodeAddress = address;
    const row = dashboard?.by_node?.find((candidate) => candidate.node_address === address);
    if (!Array.isArray(row?.vote_history)) await loadNodeDetails(address);
  }

  function toggleConsensusSort() {
    voteSortMode = voteSortMode === 'consensus-passed'
      ? 'consensus-progress'
      : 'consensus-passed';
  }

  function consensusSortLabel() {
    if (voteSortMode === 'consensus-passed') return 'PASSED FIRST';
    if (voteSortMode === 'consensus-progress') return 'IN PROGRESS FIRST';
    return 'SORT';
  }

  function toggleNodeSort(sortKey) {
    if (sortKey === 'avg-response') {
      nodeSortMode = nodeSortMode === 'avg-response-asc'
        ? 'avg-response-desc'
        : 'avg-response-asc';
      return;
    }

    nodeSortMode = nodeSortMode === 'percent-voted-desc'
      ? 'percent-voted-asc'
      : 'percent-voted-desc';
  }

  function displayNodeVote(vote) {
    return vote.vote_removed ? 'REMOVED' : (vote.vote_value ?? '-');
  }

  function rowTxLabel(txId) {
    if (!txId) return '-';
    return `${txId.slice(0, 8)}...${txId.slice(-6)}`;
  }

  function rowTxUrl(txId) {
    return txId ? `https://thorchain.net/tx/${encodeURIComponent(txId)}` : '';
  }
</script>

<div class="vote-tracker">
  <section class="terminal-header">
    <div class="command-line">
      <span class="prompt">$</span>
      <span>node-votes --window 6m --source {ingestionSource}</span>
      <div class="header-status">
        <span class="status-pill {statusTone(wsStatus)}"><span class="dot"></span> WS {wsStatus}</span>
        <span class="status-pill {statusTone(backfillStatus)}"><span class="dot"></span> BACKFILL {backfillStatus}</span>
      </div>
    </div>
    <div class="title-row">
      <div>
        <h1>NODE VOTE TRACKER<span class="cursor">_</span></h1>
        <p>Historical THORChain node Mimir votes from the last six months, grouped by vote key and node.</p>
      </div>
      <button class="bracket-button" on:click={() => loadDashboard()} disabled={refreshing}>
        <span>[</span>R<span>]</span> {refreshing ? 'refreshing' : 'refresh'}
      </button>
    </div>
  </section>

  {#if error}
    <div class="alert err"><span>ERR</span>{error}</div>
  {/if}

  {#if loading}
    <div class="loading-panel">Loading node vote dashboard...</div>
  {:else if dashboard}
    <section class="metric-grid" aria-label="Node vote metrics">
      <div class="metric">
        <span class="metric-index">01</span>
        <span class="metric-label">Vote Events</span>
        <strong>{formatNumber(stats.total_vote_events || 0)}</strong>
        <small>{formatNumber(stats.recent_7d_votes || 0)} in 7d</small>
      </div>
      <div class="metric">
        <span class="metric-index">02</span>
        <span class="metric-label">Vote Keys</span>
        <strong>{formatNumber(stats.unique_vote_keys || 0)}</strong>
        <small>{formatNumber(categoryStats.operational?.vote_keys || 0)} op | {formatNumber(categoryStats.economic?.vote_keys || 0)} econ</small>
      </div>
      <div class="metric">
        <span class="metric-index">03</span>
        <span class="metric-label">Nodes</span>
        <strong>{formatNumber(stats.unique_nodes || 0)}</strong>
        <small>{formatNumber(stats.unique_operators || 0)} operators</small>
      </div>
      <div class="metric">
        <span class="metric-index">04</span>
        <span class="metric-label">Thresholds</span>
        <strong>{formatNumber(stats.operational_votes_min || 0)} / {formatNumber(stats.consensus_threshold || 0)}</strong>
        <small>operational / economic</small>
      </div>
    </section>

    <section class="control-row">
      <div class="page-tabs" role="tablist" aria-label="Vote tracker pages">
        <button class:active={activeTab === 'vote'} on:click={() => activeTab = 'vote'}>By Vote</button>
        <button class:active={activeTab === 'node'} on:click={() => activeTab = 'node'}>By Node</button>
      </div>
      <label class="type-select">
        <span>Type</span>
        <select bind:value={categoryFilter} aria-label="Mimir vote type filter">
          <option value="all">All</option>
          <option value="operational">Operational</option>
          <option value="economic">Economic</option>
        </select>
      </label>
      <input bind:value={searchTerm} placeholder="filter key / operator / node / type" aria-label="Filter vote tracker rows" />
      <div class="window-meta">
        {formatDateTime(dashboard.window?.since)} -> now
      </div>
    </section>

    {#if activeTab === 'vote'}
      <section class="table-block">
        <div class="block-title"><span></span> Vote-Key Rollup <em>{filteredVoteRows.length} rows</em></div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Vote Key</th>
                <th>Leading Value</th>
                <th>Latest Stance</th>
                <th>Activity</th>
                <th>
                  <button
                    class="sort-header"
                    class:active={voteSortMode === 'consensus-passed' || voteSortMode === 'consensus-progress'}
                    on:click={toggleConsensusSort}
                    aria-label="Sort vote keys by consensus status"
                  >
                    <span>Consensus</span>
                    <em>{consensusSortLabel()}</em>
                  </button>
                </th>
                <th>Last Vote</th>
              </tr>
            </thead>
            <tbody>
              {#each filteredVoteRows as row}
                <tr class:expanded={expandedVoteKey === row.mimir_key}>
                  <td class="key-cell">
                    <button
                      class="key-button"
                      aria-expanded={expandedVoteKey === row.mimir_key}
                      on:click={() => toggleVoteKey(row.mimir_key)}
                    >
                      <span>{expandedVoteKey === row.mimir_key ? '-' : '+'}</span>
                      <strong>{row.mimir_key}</strong>
                    </button>
                    <span
                      class="type-pill {row.mimir_category}"
                      title={categoryTooltip(row.mimir_category)}
                      aria-label={categoryTooltip(row.mimir_category)}
                    >{categoryLabel(row.mimir_category)}</span>
                    <small>current {row.current_value ?? '-'}</small>
                  </td>
                  <td>
                    <span class="value-chip">{row.leader_value || '-'}</span>
                    <small>{formatNumber(row.leader_count || 0)} nodes</small>
                  </td>
                  <td class="breakdown-cell">
                    {#each row.values.slice(0, 4) as value}
                      <div class="value-bar" class:in-progress={!row.consensus_ready}>
                        <span>{value.value}</span>
                        <div><i style="width: {consensusProgressPercent(row, value)}%"></i></div>
                        <b>{value.count}</b>
                      </div>
                    {/each}
                  </td>
                  <td>
                    <strong>{formatNumber(row.historical_vote_events || 0)}</strong>
                    <small>{formatNumber(row.value_change_events ?? 0)} changes | {formatNumber(row.recent_7d_votes || 0)} in 7d</small>
                  </td>
                  <td>
                    {#if row.consensus_ready}
                      <strong class="ready">PASSED</strong>
                    {:else if canInspectMissingVoters(row)}
                      <button
                        class="shortfall-button"
                        class:active={missingVotersKey === row.mimir_key}
                        aria-expanded={missingVotersKey === row.mimir_key}
                        aria-controls="missing-voters-{row.mimir_key}"
                        on:click={() => toggleMissingVoters(row.mimir_key)}
                        title="List active node operators without a current vote"
                      >{formatNumber(row.votes_to_consensus || 0)} short</button>
                    {:else}
                      <strong>{formatNumber(row.votes_to_consensus || 0)} short</strong>
                    {/if}
                    <small>{consensusTimingLabel(row)}</small>
                  </td>
                  <td>
                    <strong>{formatDateTime(row.latest_vote_at)}</strong>
                    <small>height {formatNumber(row.latest_height || 0)}</small>
                  </td>
                </tr>
                {#if missingVotersKey === row.mimir_key}
                  <tr class="missing-voters-row" id="missing-voters-{row.mimir_key}">
                    <td colspan="6">
                      <div class="missing-voters-panel">
                        {#if voteDetailLoading[row.mimir_key] && !Array.isArray(row.node_votes)}
                          <div class="empty-detail">Loading complete current-voter details...</div>
                        {:else if voteDetailErrors[row.mimir_key] && !Array.isArray(row.node_votes)}
                          <div class="empty-detail err-detail">{voteDetailErrors[row.mimir_key]}</div>
                        {:else}
                          {@const missingVoters = findMissingVoters(activeNodes, row.values, row.node_votes)}
                        <div class="missing-voters-heading">
                          <strong>Operators without a current vote</strong>
                          <span>{formatNumber(missingVoters.length)} of {formatNumber(activeNodes.length)} active</span>
                        </div>
                        <p>
                          {formatNumber(row.votes_to_consensus || 0)} more matching <strong>{row.leader_value || 'leader'}</strong> votes are needed.
                          Operators currently voting another value are not listed.
                        </p>
                        {#if missingVoters.length}
                          <div class="missing-voter-list" aria-label="Node operators without a current vote for {row.mimir_key}">
                            {#each missingVoters as voter}
                              <span class="missing-voter" title="Operator {voter.operator_address} · Node {voter.node_address}">
                                <span>OP</span>
                                <a
                                  href="https://thorchain.net/address/{voter.operator_address}"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title="View operator {voter.operator_address} on thorchain.net"
                                >{shortAddress(voter.operator_address)}</a>
                                <i>·</i>
                                <span>NODE</span>
                                <a
                                  href="https://thorchain.net/node/{voter.node_address}"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title="View node {voter.node_address} on thorchain.net"
                                >{shortAddress(voter.node_address)}</a>
                              </span>
                            {/each}
                          </div>
                        {:else}
                          <div class="empty-detail">Every active node has a current vote; the shortfall is caused by split vote values.</div>
                        {/if}
                        {/if}
                      </div>
                    </td>
                  </tr>
                {/if}
                {#if expandedVoteKey === row.mimir_key}
                  <tr class="detail-row">
                    <td colspan="6">
                      <div class="detail-grid">
                        {#if voteDetailLoading[row.mimir_key] && !row.vote_history?.length}
                          <div class="empty-detail detail-status">Loading vote details...</div>
                        {:else if voteDetailErrors[row.mimir_key]}
                          <div class="empty-detail detail-status err-detail">{voteDetailErrors[row.mimir_key]}</div>
                        {/if}
                        <section class="detail-panel">
                          <div class="detail-title">
                            <span>Node Votes</span>
                            <em>{formatNumber(row.vote_history?.length || 0)} events</em>
                          </div>
                          {#if row.vote_history?.length}
                            <div class="mini-table-wrap">
                              <table class="mini-table vote-history-table">
                                <thead>
                                  <tr>
                                    <th>Node</th>
                                    <th>Operator</th>
                                    <th>Vote</th>
                                    <th>Status</th>
                                    <th>Time</th>
                                    <th>Tx</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {#each row.vote_history as vote}
                                    <tr class:removed={vote.vote_removed}>
                                      <td title={vote.node_address}>
                                        {#if vote.node_address}
                                          <a
                                            class="explorer-link"
                                            href="https://thorchain.net/node/{vote.node_address}"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            title="View node {vote.node_address} on thorchain.net"
                                          >{shortAddress(vote.node_address)}</a>
                                        {:else}
                                          -
                                        {/if}
                                      </td>
                                      <td title={vote.operator_address}>
                                        {#if vote.operator_address}
                                          <a
                                            class="explorer-link"
                                            href="https://thorchain.net/address/{vote.operator_address}"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            title="View operator {vote.operator_address} on thorchain.net"
                                          >{shortAddress(vote.operator_address)}</a>
                                        {:else}
                                          -
                                        {/if}
                                      </td>
                                      <td><strong>{displayNodeVote(vote)}</strong></td>
                                      <td>{vote.node_status || '-'}</td>
                                      <td>
                                        <strong>{formatDateTime(vote.block_time)}</strong>
                                        <small>height {formatNumber(vote.height || 0)}</small>
                                      </td>
                                      <td title={vote.tx_id}>
                                        {#if vote.tx_id}
                                          <a class="tx-link" href={rowTxUrl(vote.tx_id)} target="_blank" rel="noopener noreferrer">{rowTxLabel(vote.tx_id)}</a>
                                        {:else}
                                          -
                                        {/if}
                                      </td>
                                    </tr>
                                  {/each}
                                </tbody>
                              </table>
                            </div>
                          {:else}
                            <div class="empty-detail">No vote events in window.</div>
                          {/if}
                          {#if row.detail_pagination?.has_next}
                            <button
                              class="detail-load"
                              disabled={voteDetailLoading[row.mimir_key]}
                              on:click={() => loadVoteDetails(row.mimir_key, true)}
                            >{voteDetailLoading[row.mimir_key] ? 'Loading...' : 'Load older events'}</button>
                          {/if}
                        </section>

                        <section class="detail-panel">
                          <div class="detail-title">
                            <span>Effective Value History</span>
                            <em>{formatNumber(row.effective_history?.length || 0)} changes</em>
                          </div>
                          {#if row.effective_history?.length}
                            <div class="mini-table-wrap">
                              <table class="mini-table history-table">
                                <thead>
                                  <tr>
                                    <th>Value</th>
                                    <th>Votes</th>
                                    <th>Trigger</th>
                                    <th>Time</th>
                                    <th>Tx</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {#each row.effective_history as change}
                                    <tr>
                                      <td><span class="value-chip">{change.effective_value}</span></td>
                                      <td>
                                        <strong>{formatNumber(change.leader_count || 0)}</strong>
                                        <small>of {formatNumber(change.threshold || 0)} threshold</small>
                                      </td>
                                      <td title={change.triggered_by_node}>
                                        <strong>{shortAddress(change.triggered_by_operator)}</strong>
                                        <small>{shortAddress(change.triggered_by_node)} voted {change.trigger_vote_value}</small>
                                      </td>
                                      <td>
                                        <strong>{formatDateTime(change.block_time)}</strong>
                                        <small>height {formatNumber(change.height || 0)}</small>
                                      </td>
                                      <td title={change.tx_id}>
                                        {#if change.tx_id}
                                          <a class="tx-link" href={rowTxUrl(change.tx_id)} target="_blank" rel="noopener noreferrer">{rowTxLabel(change.tx_id)}</a>
                                        {:else}
                                          -
                                        {/if}
                                      </td>
                                    </tr>
                                  {/each}
                                </tbody>
                              </table>
                            </div>
                          {:else}
                            <div class="empty-detail">No effective value changes in window.</div>
                          {/if}
                        </section>

                      </div>
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {:else}
      <section class="table-block">
        <div class="block-title"><span></span> Node Rollup <em>{filteredNodeRows.length} rows</em></div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Node</th>
                <th>Operator</th>
                <th>Status</th>
                <th>
                  <button
                    class="sort-header"
                    class:active={nodeSortMode === 'avg-response-asc' || nodeSortMode === 'avg-response-desc'}
                    on:click={() => toggleNodeSort('avg-response')}
                    aria-label="Sort nodes by average response time"
                  >
                    <span>Avg Response Time</span>
                    <em>{avgResponseSortLabel}</em>
                  </button>
                </th>
                <th>
                  <button
                    class="sort-header"
                    class:active={nodeSortMode === 'percent-voted-desc' || nodeSortMode === 'percent-voted-asc'}
                    on:click={() => toggleNodeSort('percent-voted')}
                    aria-label="Sort nodes by percent voted"
                  >
                    <span>% Voted</span>
                    <em>{percentVotedSortLabel}</em>
                  </button>
                </th>
                <th>Last Vote</th>
              </tr>
            </thead>
            <tbody>
              {#each filteredNodeRows as row}
                <tr class:expanded={expandedNodeAddress === row.node_address}>
                  <td class="address-cell" title={row.node_address}>
                    <button
                      class="key-button node-button"
                      aria-expanded={expandedNodeAddress === row.node_address}
                      aria-label="Toggle vote history for node {row.node_address}"
                      on:click={() => toggleNode(row.node_address)}
                    >
                      <span>{expandedNodeAddress === row.node_address ? '-' : '+'}</span>
                      <strong>{shortAddress(row.node_address)}</strong>
                    </button>
                  </td>
                  <td class="address-cell" title={row.operator_address}>{shortAddress(row.operator_address)}</td>
                  <td>{row.node_status || '-'}</td>
                  <td>
                    <strong>{formatResponseTime(row.avg_response_time_ms)}</strong>
                    <small>{formatNumber(row.unique_keys || 0)} keys sampled</small>
                  </td>
                  <td>
                    <strong>{formatPercent(row.economic_voted_percent)}</strong>
                    <small>{formatNumber(row.economic_vote_key_count || 0)} of {formatNumber(row.economic_tracked_key_count || 0)} economic</small>
                  </td>
                  <td>
                    <strong>{formatDateTime(row.latest_vote_at)}</strong>
                    <small>height {formatNumber(row.latest_height || 0)}</small>
                  </td>
                </tr>
                {#if expandedNodeAddress === row.node_address}
                  <tr class="detail-row">
                    <td colspan="6">
                      <div class="node-detail">
                        <section class="detail-panel">
                          <div class="detail-title">
                            <span>Node Vote History</span>
                            <em>{formatNumber(row.vote_history?.length || 0)} events, newest first</em>
                          </div>
                          {#if row.vote_history?.length}
                            <div class="mini-table-wrap">
                              <table class="mini-table node-history-table">
                                <thead>
                                  <tr>
                                    <th>Vote Key</th>
                                    <th>Type</th>
                                    <th>Vote</th>
                                    <th>Time</th>
                                    <th>Tx</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {#each row.vote_history as vote}
                                    <tr class:removed={vote.vote_removed}>
                                      <td><strong>{vote.mimir_key}</strong></td>
                                      <td>
                                        <span
                                          class="type-pill {vote.mimir_category}"
                                          title={categoryTooltip(vote.mimir_category)}
                                          aria-label={categoryTooltip(vote.mimir_category)}
                                        >{categoryLabel(vote.mimir_category)}</span>
                                      </td>
                                      <td><strong>{displayNodeVote(vote)}</strong></td>
                                      <td>
                                        <strong>{formatDateTime(vote.block_time)}</strong>
                                        <small>height {formatNumber(vote.height || 0)}</small>
                                      </td>
                                      <td title={vote.tx_id}>
                                        {#if vote.tx_id}
                                          <a class="tx-link" href={rowTxUrl(vote.tx_id)} target="_blank" rel="noopener noreferrer">{rowTxLabel(vote.tx_id)}</a>
                                        {:else}
                                          -
                                        {/if}
                                      </td>
                                    </tr>
                                  {/each}
                                </tbody>
                              </table>
                            </div>
                          {:else}
                            <div class="empty-detail">
                              {nodeDetailLoading[row.node_address]
                                ? 'Loading node details...'
                                : nodeDetailErrors[row.node_address] || 'No vote events in window.'}
                            </div>
                          {/if}
                          {#if row.detail_pagination?.has_next}
                            <button
                              class="detail-load"
                              disabled={nodeDetailLoading[row.node_address]}
                              on:click={() => loadNodeDetails(row.node_address, true)}
                            >{nodeDetailLoading[row.node_address] ? 'Loading...' : 'Load older events'}</button>
                          {/if}
                        </section>
                      </div>
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}

    <section class="table-block recent">
      <div class="block-title"><span></span> Latest Vote Events <em>{latestEvents.length} shown</em></div>
      <div class="event-grid">
        {#each latestEvents.slice(0, 12) as event}
          <div class="event-row">
            <span>{formatDateTime(event.block_time)}</span>
            <strong>
              <i
                class="type-pill {event.mimir_category}"
                title={categoryTooltip(event.mimir_category)}
                aria-label={categoryTooltip(event.mimir_category)}
              >{categoryLabel(event.mimir_category)}</i>{event.mimir_key}={event.vote_value}
            </strong>
            <em>{shortAddress(event.operator_address)}</em>
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>

<style>
  .vote-tracker {
    --bg: #080808;
    --surface: #0a0a0a;
    --hover: #0d0d0d;
    --border: #1a1a1a;
    --faint: #111;
    --text: var(--term-text, #ededed);
    --body: var(--term-text-body, #d2d2d2);
    --muted: var(--term-text-2, #b8b8b8);
    --dim: var(--term-text-4, #949494);
    --accent: #00cc66;
    --amber: #d4a017;
    --err: #dc3545;
    max-width: 1480px;
    margin: 0 auto;
    padding: 28px 20px 56px;
    color: var(--body);
    background: var(--bg);
  }

  .terminal-header,
  .table-block,
  .loading-panel,
  .alert {
    background: var(--surface);
    border: 1px solid var(--border);
  }

  .terminal-header {
    padding: 18px 20px 22px;
    margin-bottom: 18px;
  }

  .command-line,
  .header-status,
  .title-row,
  .control-row,
  .page-tabs,
  .block-title,
  .value-bar,
  .event-row {
    display: flex;
    align-items: center;
  }

  .command-line {
    gap: 8px;
    color: var(--muted);
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    justify-content: space-between;
    flex-wrap: wrap;
    margin-bottom: 18px;
  }

  .prompt,
  .cursor,
  .metric-index,
  .ready {
    color: var(--accent);
  }

  .header-status {
    gap: 8px;
  }

  .status-pill {
    border: 1px solid var(--border);
    padding: 3px 8px;
    font: 700 11px/1.2 'JetBrains Mono', monospace;
    color: var(--muted);
    text-transform: uppercase;
  }

  .status-pill.ok { color: var(--accent); }
  .status-pill.warn { color: var(--amber); }
  .status-pill.err { color: var(--err); }

  .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 5px;
    background: currentColor;
    box-shadow: 0 0 6px currentColor;
  }

  .title-row {
    justify-content: space-between;
    gap: 20px;
  }

  h1 {
    margin: 0 0 8px;
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: clamp(24px, 3vw, 34px);
    line-height: 1.05;
    letter-spacing: 0.06em;
  }

  p {
    max-width: 760px;
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }

  .bracket-button,
  .page-tabs button {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    font: 700 11px/1 'JetBrains Mono', monospace;
    padding: 10px 12px;
    cursor: pointer;
  }

  .bracket-button:hover,
  .page-tabs button:hover,
  .page-tabs button.active {
    border-color: var(--accent);
    color: var(--accent);
  }

  .bracket-button:disabled {
    cursor: wait;
    opacity: 0.65;
  }

  .bracket-button span {
    color: var(--dim);
  }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border: 1px solid var(--border);
    margin-bottom: 18px;
  }

  .metric {
    min-height: 116px;
    padding: 16px 18px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: grid;
    gap: 8px;
    align-content: start;
  }

  .metric:last-child {
    border-right: 0;
  }

  .metric-label,
  th,
  .block-title,
  .window-meta {
    font-family: 'JetBrains Mono', monospace;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  .metric-label {
    color: var(--muted);
    font-size: 11px;
  }

  .metric strong {
    color: var(--text);
    font: 800 25px/1.05 'JetBrains Mono', monospace;
  }

  .metric small,
  td small {
    color: var(--dim);
    font: 600 11px/1.4 'JetBrains Mono', monospace;
    display: block;
    margin-top: 4px;
  }

  .control-row {
    gap: 12px;
    margin-bottom: 18px;
    flex-wrap: wrap;
  }

  .page-tabs {
    gap: 6px;
  }

  .type-select {
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--border);
    background: #060606;
    padding: 0 10px;
    color: var(--muted);
    font: 800 11px/1 'JetBrains Mono', monospace;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .type-select select {
    min-width: 118px;
    height: 34px;
    border: 0;
    background: transparent;
    color: var(--text);
    font: 800 11px/1 'JetBrains Mono', monospace;
    outline: none;
  }

  input {
    min-width: 280px;
    flex: 1;
    background: #060606;
    border: 1px solid var(--border);
    color: var(--text);
    padding: 10px 12px;
    font: 600 12px/1 'JetBrains Mono', monospace;
    outline: none;
  }

  input:focus {
    border-color: var(--accent);
  }

  .window-meta {
    color: var(--dim);
    font-size: 11px;
  }

  .table-block {
    margin-bottom: 18px;
  }

  .block-title {
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    font-size: 11px;
    font-weight: 800;
  }

  .block-title span {
    width: 8px;
    height: 14px;
    background: var(--accent);
    margin-right: 8px;
  }

  .block-title em {
    margin-left: auto;
    color: var(--dim);
    font-style: normal;
    font-size: 11px;
  }

  .table-wrap {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 1120px;
    font-family: 'JetBrains Mono', monospace;
  }

  th,
  td {
    border-bottom: 1px solid var(--faint);
    padding: 12px 14px;
    vertical-align: top;
    text-align: left;
  }

  th {
    position: sticky;
    top: 0;
    background: var(--surface);
    color: var(--muted);
    font-size: 11px;
    font-weight: 800;
    z-index: 1;
  }

  .sort-header {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    cursor: pointer;
  }

  .sort-header em {
    color: var(--dim);
    font-style: normal;
    font-size: 11px;
    letter-spacing: 0.08em;
  }

  .sort-header:hover,
  .sort-header.active {
    color: var(--accent);
  }

  .sort-header.active em {
    color: var(--amber);
  }

  .shortfall-button {
    padding: 0;
    border: 0;
    border-bottom: 1px dashed rgba(212, 160, 23, 0.7);
    background: transparent;
    color: var(--amber);
    font: 800 11px/1.4 'JetBrains Mono', monospace;
    cursor: pointer;
  }

  .shortfall-button:hover,
  .shortfall-button:focus-visible,
  .shortfall-button.active {
    border-bottom-color: var(--accent);
    color: var(--accent);
    outline: none;
  }

  td {
    color: var(--body);
    font-size: 11px;
  }

  tbody tr:hover {
    background: var(--hover);
  }

  tbody tr.expanded {
    background: #090f0c;
  }

  .key-cell strong,
  .address-cell,
  td strong {
    color: var(--text);
    font-weight: 800;
  }

  .key-button {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    max-width: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    cursor: pointer;
    text-align: left;
  }

  .key-button span {
    display: inline-grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border: 1px solid var(--border);
    color: var(--accent);
    font: 800 11px/1 'JetBrains Mono', monospace;
    flex: 0 0 auto;
  }

  .key-button:hover strong {
    color: var(--accent);
  }

  .node-button strong {
    min-width: 34px;
  }

  .value-chip {
    display: inline-block;
    min-width: 44px;
    border: 1px solid rgba(0, 204, 102, 0.4);
    color: var(--accent);
    padding: 4px 7px;
    font-weight: 800;
    text-align: center;
  }

  .type-pill {
    display: inline-flex;
    align-items: center;
    width: max-content;
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 3px 6px;
    margin: 6px 0 0;
    font: 800 11px/1 'JetBrains Mono', monospace;
    text-transform: uppercase;
    cursor: help;
  }

  .type-pill.operational {
    border-color: rgba(0, 204, 102, 0.45);
    color: var(--accent);
  }

  .type-pill.economic {
    border-color: rgba(212, 160, 23, 0.45);
    color: var(--amber);
  }

  .breakdown-cell {
    min-width: 250px;
  }

  .value-bar {
    gap: 8px;
    margin-bottom: 6px;
  }

  .value-bar span {
    width: 72px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .value-bar div {
    flex: 1;
    height: 7px;
    background: #050505;
    border: 1px solid var(--border);
  }

  .value-bar i {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .value-bar.in-progress i {
    background: var(--amber);
  }

  .value-bar b {
    width: 28px;
    color: var(--text);
    text-align: right;
  }

  .detail-row > td {
    padding: 0;
    background: #070707;
  }

  .missing-voters-row > td {
    padding: 0;
    background: #070907;
  }

  .missing-voters-panel {
    padding: 14px;
    border-top: 1px solid rgba(212, 160, 23, 0.35);
    border-bottom: 1px solid var(--border);
  }

  .missing-voters-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--text);
    font: 800 11px/1.3 'JetBrains Mono', monospace;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .missing-voters-heading span {
    color: var(--amber);
    white-space: nowrap;
  }

  .missing-voters-panel p {
    margin: 8px 0 12px;
    color: var(--dim);
    font: 600 13px/1.5 'JetBrains Mono', monospace;
  }

  .missing-voters-panel p strong {
    color: var(--amber);
  }

  .missing-voter-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .missing-voter {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 7px;
    border: 1px solid var(--border);
    background: #050505;
    font: 800 11px/1 'JetBrains Mono', monospace;
  }

  .missing-voter > span,
  .missing-voter > i {
    color: var(--dim);
    font-style: normal;
  }

  .missing-voter a {
    color: var(--body);
    text-decoration: none;
  }

  .missing-voter a:hover,
  .missing-voter a:focus-visible {
    color: var(--accent);
    text-decoration: underline;
  }

  .detail-grid {
    display: grid;
    grid-template-columns: minmax(500px, 0.78fr) minmax(520px, 1.22fr);
    gap: 0;
    border-top: 1px solid rgba(0, 204, 102, 0.28);
  }

  .detail-panel {
    min-width: 0;
    border-right: 1px solid var(--border);
  }

  .detail-panel:last-child {
    border-right: 0;
  }

  .node-detail {
    border-top: 1px solid rgba(0, 204, 102, 0.28);
  }

  .node-detail .detail-panel {
    border-right: 0;
  }

  .detail-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    font: 800 11px/1.2 'JetBrains Mono', monospace;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  .detail-title em {
    color: var(--dim);
    font-style: normal;
  }

  .mini-table-wrap {
    overflow-x: auto;
  }

  .mini-table {
    min-width: 620px;
    font-size: 11px;
  }

  .history-table {
    min-width: 620px;
  }

  .node-history-table {
    min-width: 760px;
  }

  .vote-history-table {
    min-width: 560px;
    table-layout: fixed;
  }

  .mini-table th,
  .mini-table td {
    padding: 9px 10px;
  }

  .vote-history-table th,
  .vote-history-table td {
    padding: 7px 8px;
    white-space: nowrap;
  }

  .vote-history-table th:nth-child(1),
  .vote-history-table td:nth-child(1) {
    width: 56px;
  }

  .vote-history-table th:nth-child(2),
  .vote-history-table td:nth-child(2) {
    width: 74px;
  }

  .vote-history-table th:nth-child(3),
  .vote-history-table td:nth-child(3) {
    width: 62px;
  }

  .vote-history-table th:nth-child(4),
  .vote-history-table td:nth-child(4) {
    width: 78px;
  }

  .vote-history-table th:nth-child(5),
  .vote-history-table td:nth-child(5) {
    width: 128px;
  }

  .vote-history-table th:nth-child(6),
  .vote-history-table td:nth-child(6) {
    width: 96px;
  }

  .mini-table tr.removed td {
    color: var(--dim);
  }

  .mini-table tr.removed td strong {
    color: var(--amber);
  }

  .tx-link {
    color: var(--amber);
    font-weight: 800;
    text-decoration: none;
  }

  .tx-link:hover {
    text-decoration: underline;
  }

  .explorer-link {
    color: var(--text);
    font-weight: 800;
    text-decoration: none;
  }

  .explorer-link:hover,
  .explorer-link:focus-visible {
    color: var(--accent);
    text-decoration: underline;
  }

  .empty-detail {
    padding: 16px 12px;
    color: var(--dim);
    font: 700 11px/1.4 'JetBrains Mono', monospace;
  }

  .detail-status {
    grid-column: 1 / -1;
    border-bottom: 1px solid var(--border);
  }

  .err-detail {
    color: var(--err);
  }

  .detail-load {
    margin: 10px 12px 12px;
    padding: 7px 10px;
    border: 1px solid var(--border);
    background: #050505;
    color: var(--accent);
    font: 800 11px/1 'JetBrains Mono', monospace;
    text-transform: uppercase;
    cursor: pointer;
  }

  .detail-load:disabled {
    color: var(--dim);
    cursor: wait;
  }

  .event-grid {
    display: grid;
  }

  .event-row {
    gap: 12px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--faint);
    font: 600 11px/1.3 'JetBrains Mono', monospace;
  }

  .event-row:last-child {
    border-bottom: 0;
  }

  .event-row span {
    width: 150px;
    color: var(--dim);
  }

  .event-row strong {
    color: var(--accent);
    flex: 1;
    overflow-wrap: anywhere;
  }

  .event-row .type-pill {
    margin: 0 8px 0 0;
    vertical-align: middle;
  }

  .event-row em {
    color: var(--muted);
    font-style: normal;
  }

  .loading-panel,
  .alert {
    padding: 18px;
    color: var(--muted);
    font: 700 13px/1.4 'JetBrains Mono', monospace;
  }

  .alert {
    margin-bottom: 18px;
  }

  .alert span {
    color: var(--err);
    margin-right: 10px;
  }

  @media (max-width: 900px) {
    .vote-tracker {
      padding: 18px 12px 40px;
    }

    .title-row,
    .control-row {
      align-items: stretch;
      flex-direction: column;
    }

    .metric-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .detail-grid {
      grid-template-columns: 1fr;
    }

    .detail-panel {
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }

    .metric:nth-child(2) {
      border-right: 0;
    }

    .metric:nth-child(1),
    .metric:nth-child(2) {
      border-bottom: 1px solid var(--border);
    }

    input {
      min-width: 0;
      width: 100%;
    }

    .event-row {
      align-items: flex-start;
      flex-direction: column;
      gap: 4px;
    }

    .event-row span {
      width: auto;
    }
  }
</style>
