const STATUS_STATE_KEY = /^(HALT|PAUSELP|SOLVENCYHALT|NODEPAUSE)/i;
export const MAX_STATUS_STUCK_TRANSACTIONS = 20;
export const MAX_BLOCK_PRODUCTION_POINTS = 150;
// Slow blocks can legitimately take 10-20 seconds. Flag delay after 30 seconds,
// but require 90 seconds without a committed block before declaring a stall.
export const STATUS_CONSENSUS_DELAY_THRESHOLD_MS = 30_000;
export const STATUS_CONSENSUS_STALL_THRESHOLD_MS = 90_000;

function numberValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function timestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function warningValues(...values) {
  return [...new Set(values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

export function isHeightMimirActive(value, blockHeight) {
  const numeric = numberValue(value);
  const height = numberValue(blockHeight);
  return numeric > 0 && height > 0 && numeric <= height;
}

function chainDepositState(chain, inbound, mimir, chainHalted) {
  if (inbound.chain_lp_actions_paused || chainHalted) return 'paused';
  const prefix = `PAUSELPDEPOSIT-${chain}-`;
  const hasPausedPool = Object.entries(mimir || {}).some(([key, value]) => (
    key.toUpperCase().startsWith(prefix) && numberValue(value) > 0
  ));
  return hasPausedPool ? 'partial' : 'enabled';
}

function combineLpState(deposits, withdrawals) {
  if (deposits === 'enabled' && withdrawals === 'enabled') return 'enabled';
  if (deposits === 'paused' && withdrawals === 'paused') return 'paused';
  return 'partial';
}

function validNonNegativeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function buildChainScannerStats(nodes = [], scannerNodes = []) {
  const activeNodeAddresses = new Set(nodes
    .filter((node) => node?.status === 'Active')
    .map((node) => String(node?.node_address || '').trim())
    .filter(Boolean));
  const reportsByChain = new Map();

  for (const scannerNode of scannerNodes) {
    const nodeAddress = String(scannerNode?.node_address || '').trim();
    if (!activeNodeAddresses.has(nodeAddress)) continue;
    const scanner = scannerNode?.scanner;
    if (!scanner || typeof scanner !== 'object' || Array.isArray(scanner)) continue;

    for (const [key, record] of Object.entries(scanner)) {
      const chain = String(record?.chain || key || '').trim().toUpperCase();
      const lag = validNonNegativeNumber(record?.scanner_height_diff);
      if (!chain || lag === null) continue;
      if (!reportsByChain.has(chain)) reportsByChain.set(chain, new Map());
      // A validator contributes at most one report per chain, even if a provider
      // accidentally includes the node twice.
      if (!reportsByChain.get(chain).has(nodeAddress)) {
        reportsByChain.get(chain).set(nodeAddress, {
          lag,
          chainHeight: validNonNegativeNumber(record?.chain_height)
        });
      }
    }
  }

  return new Map([...reportsByChain].map(([chain, reportsByAddress]) => {
    const reports = [...reportsByAddress.values()];
    const heights = reports.map((report) => report.chainHeight).filter((height) => height !== null);
    const averageLag = reports.reduce((sum, report) => sum + report.lag, 0) / reports.length;
    return [chain, {
      tipHeight: heights.length > 0 ? Math.max(...heights) : 0,
      avgBlocksBehindTip: Math.round(averageLag * 10) / 10,
      reportingValidators: reports.length
    }];
  }));
}

export function buildChainStatuses(
  inboundAddresses = [],
  mimir = {},
  lastBlocks = [],
  nodes = [],
  scannerNodes = []
) {
  const blockByChain = new Map(lastBlocks.map((row) => [row.chain, row]));
  const scannerStatsByChain = buildChainScannerStats(nodes, scannerNodes);
  const mimirByKey = new Map(
    Object.entries(mimir || {}).map(([key, value]) => [key.toUpperCase(), value])
  );
  const thorchainHeight = Math.max(0, ...lastBlocks.map((row) => numberValue(row.thorchain)));
  const globalChainHalt = isHeightMimirActive(mimirByKey.get('HALTCHAINGLOBAL'), thorchainHeight);
  const nodePauseUntil = numberValue(mimirByKey.get('NODEPAUSECHAINGLOBAL'));
  const nodePauseActive = thorchainHeight > 0 && nodePauseUntil >= thorchainHeight;
  const globalSigningHalt = isHeightMimirActive(mimirByKey.get('HALTSIGNING'), thorchainHeight);

  return [...inboundAddresses]
    .map((inbound) => {
      const chain = String(inbound.chain || '').toUpperCase();
      const lastBlock = blockByChain.get(chain) || {};
      const scannerStats = scannerStatsByChain.get(chain);
      const tradingPaused = Boolean(
        inbound.halted || inbound.global_trading_paused || inbound.chain_trading_paused
      );
      const lpPaused = Boolean(inbound.chain_lp_actions_paused);
      const chainHalted = Boolean(
        globalChainHalt ||
        nodePauseActive ||
        isHeightMimirActive(mimirByKey.get(`HALT${chain}CHAIN`), thorchainHeight) ||
        isHeightMimirActive(mimirByKey.get(`SOLVENCYHALT${chain}CHAIN`), thorchainHeight)
      );
      const deposits = chainDepositState(chain, inbound, mimir, chainHalted);
      const withdrawals = lpPaused || chainHalted ? 'paused' : 'enabled';
      const lpActions = combineLpState(deposits, withdrawals);
      const signingPaused = Boolean(
        chainHalted ||
        globalSigningHalt ||
        isHeightMimirActive(mimirByKey.get(`HALTSIGNING${chain}`), thorchainHeight)
      );

      return {
        chain,
        trading: tradingPaused ? 'paused' : 'enabled',
        deposits,
        withdrawals,
        lpActions,
        signing: signingPaused ? 'paused' : 'enabled',
        lastObservedIn: numberValue(lastBlock.last_observed_in),
        lastSignedOut: numberValue(lastBlock.last_signed_out),
        thorchainHeight: numberValue(lastBlock.thorchain),
        tipHeight: scannerStats?.tipHeight ?? 0,
        avgBlocksBehindTip: scannerStats?.avgBlocksBehindTip ?? null,
        reportingValidators: scannerStats?.reportingValidators ?? 0,
        degraded: tradingPaused || lpActions !== 'enabled' || signingPaused
      };
    })
    .filter((row) => row.chain)
    .sort((left, right) => left.chain.localeCompare(right.chain));
}

export function summarizeNetwork(chains = []) {
  const total = chains.length;
  const tradingEnabled = chains.filter((chain) => chain.trading === 'enabled').length;
  const depositsEnabled = chains.filter((chain) => chain.deposits === 'enabled').length;
  const withdrawalsEnabled = chains.filter((chain) => chain.withdrawals === 'enabled').length;
  const lpEnabled = chains.filter((chain) => chain.lpActions === 'enabled').length;
  const lpPartial = chains.filter((chain) => chain.lpActions === 'partial').length;
  const signingEnabled = chains.filter((chain) => chain.signing === 'enabled').length;
  const degradedChains = chains.filter((chain) => chain.degraded).map((chain) => chain.chain);
  let tone = 'ok';
  let label = 'Operational';
  if (total === 0 || tradingEnabled === 0) {
    tone = 'err';
    label = 'Disrupted';
  } else if (degradedChains.length > 0) {
    tone = 'warn';
    label = 'Degraded';
  }
  return {
    total,
    tradingEnabled,
    depositsEnabled,
    withdrawalsEnabled,
    lpEnabled,
    lpPartial,
    signingEnabled,
    degradedChains,
    tone,
    label
  };
}

function buildConsensusStatus(latestBlock, nowMs, currentHeight, stallThresholdMs, lastBlockReliable) {
  const lastBlockAt = timestamp(latestBlock?.time ?? latestBlock?.blockTime);
  const latestBlockHeight = numberValue(latestBlock?.height);
  if (
    !lastBlockReliable ||
    !lastBlockAt ||
    latestBlockHeight <= 0 ||
    latestBlockHeight < currentHeight
  ) {
    return {
      state: 'unknown',
      signing_blocks: null,
      last_block_at: null,
      block_age_seconds: null
    };
  }

  const lastBlockMs = Date.parse(lastBlockAt);
  const blockAgeMs = Math.max(0, nowMs - lastBlockMs);
  const stalled = blockAgeMs >= stallThresholdMs;
  const delayed = !stalled && blockAgeMs >= Math.min(
    STATUS_CONSENSUS_DELAY_THRESHOLD_MS,
    stallThresholdMs
  );
  return {
    state: stalled ? 'stalled' : delayed ? 'delayed' : 'signing',
    signing_blocks: !stalled && !delayed,
    last_block_at: lastBlockAt,
    block_age_seconds: Math.floor(blockAgeMs / 1_000)
  };
}

export function buildChurnStatus(
  mimir = {},
  currentHeight = 0,
  churns = [],
  activeNodes = [],
  nowMs = Date.now(),
  network = {},
  midgardNetwork = {},
  nodes = []
) {
  const mimirByKey = new Map(
    Object.entries(mimir || {}).map(([key, value]) => [key.toUpperCase(), value])
  );
  const height = numberValue(currentHeight);
  const isPaused = isHeightMimirActive(mimirByKey.get('HALTCHURNING'), height);
  const latestChurn = [...(Array.isArray(churns) ? churns : [])]
    .filter((row) => numberValue(row?.height) > 0)
    .sort((left, right) => numberValue(right.height) - numberValue(left.height))[0];
  let lastChurnHeight = numberValue(latestChurn?.height);
  let lastChurnTimestampMs = numberValue(latestChurn?.date) / 1_000_000;
  let estimated = false;
  if (!lastChurnHeight) {
    lastChurnHeight = Math.max(0, ...activeNodes.map((node) => numberValue(node?.status_since)));
    estimated = lastChurnHeight > 0;
  }
  if (!Number.isFinite(lastChurnTimestampMs) || lastChurnTimestampMs <= 0) {
    const blocksSince = Math.max(0, height - lastChurnHeight);
    lastChurnTimestampMs = lastChurnHeight > 0
      ? Math.max(0, nowMs - (blocksSince * 6_000))
      : 0;
    estimated = lastChurnHeight > 0;
  }
  const midgardNextChurnHeight = numberValue(
    midgardNetwork?.nextChurnHeight ?? midgardNetwork?.next_churn_height
  );
  const churnIntervalBlocks = numberValue(mimirByKey.get('CHURNINTERVAL'));
  const computedNextChurnHeight = lastChurnHeight > 0 && churnIntervalBlocks > 0
    ? lastChurnHeight + churnIntervalBlocks
    : 0;
  const nextChurnHeight = midgardNextChurnHeight > 0 && midgardNextChurnHeight >= height
    ? midgardNextChurnHeight
    : computedNextChurnHeight > 0 && computedNextChurnHeight >= height
      ? computedNextChurnHeight
      : 0;
  const nextChurnSource = nextChurnHeight > 0 && nextChurnHeight === midgardNextChurnHeight
    ? 'midgard'
    : nextChurnHeight > 0 && nextChurnHeight === computedNextChurnHeight
      ? 'computed'
      : 'unavailable';
  const blocksRemaining = nextChurnHeight > 0
    ? Math.max(0, nextChurnHeight - height)
    : 0;
  const nextChurnTimestampMs = nextChurnHeight > 0
    ? nowMs + (blocksRemaining * 6_000)
    : 0;
  const readyKeygenInProgress = lastChurnHeight > 0 && (Array.isArray(nodes) ? nodes : [])
    .some((node) => (
      node?.status === 'Ready' &&
      numberValue(node?.status_since) > lastChurnHeight &&
      numberValue(node?.status_since) <= height
    ));
  return {
    isPaused,
    isInProgress: network?.vaults_migrating === true || readyKeygenInProgress,
    mimirValue: numberValue(mimirByKey.get('HALTCHURNING')),
    lastChurnHeight,
    lastChurnTimestampMs,
    blocksSince: lastChurnHeight > 0 ? Math.max(0, height - lastChurnHeight) : 0,
    churnIntervalBlocks,
    nextChurnHeight,
    nextChurnTimestampMs,
    nextChurnSource,
    blocksRemaining,
    estimated
  };
}

function updateDescription(key, value) {
  const normalized = String(key || '').toUpperCase();
  const enabled = numberValue(value) <= 0;
  if (normalized === 'HALTTRADING') return enabled ? 'Global trading resumed' : 'Global trading halted';
  if (normalized === 'HALTSIGNING') return enabled ? 'Global outbound signing resumed' : 'Global outbound signing halted';
  if (normalized === 'HALTCHAINGLOBAL') return enabled ? 'All chains resumed' : 'All chains halted';
  if (normalized === 'HALTCHURNING') return enabled ? 'Validator churning resumed' : 'Validator churning paused';
  if (normalized === 'PAUSELP') return enabled ? 'LP deposits and withdrawals resumed' : 'LP deposits and withdrawals paused';
  let match = normalized.match(/^HALT(.+)TRADING$/);
  if (match) return `${match[1]} trading ${enabled ? 'resumed' : 'halted'}`;
  match = normalized.match(/^HALTSIGNING(.+)$/);
  if (match) return `${match[1]} outbound signing ${enabled ? 'resumed' : 'halted'}`;
  match = normalized.match(/^HALT(.+)CHAIN$/);
  if (match) return `${match[1]} chain ${enabled ? 'resumed' : 'halted'}`;
  match = normalized.match(/^SOLVENCYHALT(.+)CHAIN$/);
  if (match) return `${match[1]} solvency halt ${enabled ? 'cleared' : 'enabled'}`;
  match = normalized.match(/^PAUSELPDEPOSIT-(.+)$/);
  if (match) return `${match[1]} LP deposits ${enabled ? 'resumed' : 'paused'}`;
  match = normalized.match(/^PAUSELP(.+)$/);
  if (match) return `${match[1]} LP deposits and withdrawals ${enabled ? 'resumed' : 'paused'}`;
  return `${normalized} set to ${value}`;
}

export function getRecentStatusUpdates(voteRows = [], limit = 5) {
  const seen = new Set();
  return voteRows
    .flatMap((row) => (row.effective_history || []).map((change) => ({
      key: row.mimir_key,
      value: change.effective_value,
      description: updateDescription(row.mimir_key, change.effective_value),
      blockTime: timestamp(change.block_time),
      height: numberValue(change.height),
      txId: change.tx_id || '',
      tone: STATUS_STATE_KEY.test(row.mimir_key || '') && numberValue(change.effective_value) > 0
        ? 'warn'
        : 'ok'
    })))
    .sort((left, right) => Date.parse(right.blockTime || '') - Date.parse(left.blockTime || ''))
    .filter((update) => {
      const stateKey = `${update.key}:${update.value}`;
      if (seen.has(stateKey)) return false;
      seen.add(stateKey);
      return true;
    })
    .slice(0, limit);
}

export function getGovernanceVotes(voteRows = [], limit = 4) {
  return voteRows
    .filter((row) => (
      row.mimir_category === 'economic' &&
      numberValue(row.leader_count) > 0 &&
      row.leader_value != null &&
      String(row.leader_value) !== ''
    ))
    .sort((left, right) => Date.parse(right.latest_vote_at || '') - Date.parse(left.latest_vote_at || ''))
    .slice(0, limit)
    .map((row) => {
      const threshold = numberValue(row.consensus_threshold);
      const votes = numberValue(row.leader_count);
      return {
        key: row.mimir_key,
        value: row.leader_value ?? row.current_value ?? '-',
        votes,
        threshold,
        progress: threshold > 0 ? Math.min(100, (votes / threshold) * 100) : 0,
        passed: Boolean(row.consensus_ready),
        latestVoteAt: timestamp(row.latest_vote_at),
        height: numberValue(row.latest_height)
      };
    });
}

function majorityVersion(nodes) {
  const counts = new Map();
  for (const node of nodes) {
    const version = String(node?.version || '');
    if (node?.status !== 'Active' || !version) continue;
    counts.set(version, (counts.get(version) || 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || '';
}

export function buildStatusNetworkReadModel(input = {}) {
  const networkSnapshot = input.networkSnapshot;
  if (!networkSnapshot || !Array.isArray(networkSnapshot.inbound_addresses)) {
    throw new Error('A usable network snapshot is required');
  }
  const generatedAt = timestamp(input.generatedAt) || new Date().toISOString();
  const nowMs = Date.parse(generatedAt);
  const nodes = Array.isArray(networkSnapshot.nodes) ? networkSnapshot.nodes : [];
  const activeNodes = nodes.filter((node) => node?.status === 'Active');
  const lastBlocks = Array.isArray(networkSnapshot.lastblock) ? networkSnapshot.lastblock : [];
  const mimir = networkSnapshot.mimir && typeof networkSnapshot.mimir === 'object'
    ? networkSnapshot.mimir
    : {};
  const scanners = Array.isArray(networkSnapshot.bifrost_scanners)
    ? networkSnapshot.bifrost_scanners
    : [];
  const chains = buildChainStatuses(
    networkSnapshot.inbound_addresses,
    mimir,
    lastBlocks,
    nodes,
    scanners
  );
  const thorchainHeight = Math.max(0, ...lastBlocks.map((row) => numberValue(row?.thorchain)));
  const configuredStallThresholdMs = Number(input.stallThresholdMs);
  const stallThresholdMs = Number.isFinite(configuredStallThresholdMs) && configuredStallThresholdMs >= 1_000
    ? configuredStallThresholdMs
    : STATUS_CONSENSUS_STALL_THRESHOLD_MS;
  const lastBlockFieldStatus = String(networkSnapshot?.field_meta?.lastblock?.status || '');
  const lastBlockReliable = lastBlockFieldStatus !== 'reused' && lastBlockFieldStatus !== 'error';
  const consensus = buildConsensusStatus(
    input.latestBlock,
    Number.isFinite(nowMs) ? nowMs : Date.now(),
    thorchainHeight,
    stallThresholdMs,
    lastBlockReliable
  );
  const summary = summarizeNetwork(chains);
  if (consensus.state === 'stalled') {
    summary.tone = 'err';
    summary.label = 'Stalled';
  } else if (consensus.state === 'delayed' && summary.tone === 'ok') {
    summary.tone = 'warn';
    summary.label = 'Delayed';
  }
  const warnings = warningValues(
    networkSnapshot.warnings,
    Object.values(networkSnapshot.errors || {}),
    networkSnapshot.warning
  );

  return {
    schema_version: 2,
    as_of: generatedAt,
    network: {
      height: thorchainHeight,
      active_node_count: activeNodes.length,
      majority_version: majorityVersion(nodes),
      summary,
      consensus
    },
    chains,
    churn: buildChurnStatus(
      mimir,
      thorchainHeight,
      networkSnapshot.churns,
      activeNodes,
      Number.isFinite(nowMs) ? nowMs : Date.now(),
      networkSnapshot.network,
      networkSnapshot.midgard_network,
      nodes
    ),
    source: {
      provider: networkSnapshot.source || {},
      as_of: timestamp(networkSnapshot.as_of)
    },
    partial: Boolean(networkSnapshot.partial || warnings.length > 0),
    stale: Boolean(networkSnapshot.stale),
    warnings
  };
}

function compactStuckTransaction(row) {
  return {
    tx_id: String(row?.tx_id || ''),
    stage: String(row?.stage || ''),
    stage_label: String(row?.stage_label || ''),
    chain: String(row?.chain || ''),
    asset: String(row?.asset || ''),
    asset_ticker: String(row?.asset_ticker || ''),
    amount: String(row?.amount || '0'),
    destination: String(row?.destination || ''),
    scheduled_height: numberValue(row?.scheduled_height),
    overdue_blocks: numberValue(row?.overdue_blocks),
    completed_outbounds: numberValue(row?.completed_outbounds)
  };
}

function compactBlockProduction(input = {}) {
  const normalized = (Array.isArray(input.points) ? input.points : [])
    .map((row) => ({
      time: timestamp(row?.time),
      height: Math.trunc(numberValue(row?.height)),
      seconds_per_block: Math.round(numberValue(row?.seconds_per_block) * 1000) / 1000,
      block_count: Math.trunc(numberValue(row?.block_count))
    }))
    .filter((row) => (
      row.time && row.height > 0 && row.seconds_per_block > 0 && row.block_count > 0
    ))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  const stride = Math.max(1, Math.ceil(normalized.length / MAX_BLOCK_PRODUCTION_POINTS));
  const points = normalized.filter((_, index) => (
    index % stride === 0 || index === normalized.length - 1
  )).slice(-MAX_BLOCK_PRODUCTION_POINTS);
  return {
    window_hours: 24,
    live_interval_minutes: Math.max(1, Math.trunc(numberValue(input.live_interval_minutes) || 5)),
    points,
    as_of: timestamp(input.as_of) || points.at(-1)?.time || null,
    source: String(input.source || 'thorchain-rpc-block-headers'),
    warning: String(input.warning || '')
  };
}

export function buildStatusDashboardReadModel(input = {}) {
  const networkSnapshot = input.networkSnapshot;
  const voteDashboard = input.voteDashboard || {};
  const stuckDashboard = input.stuckDashboard || {};
  const blockProduction = compactBlockProduction(input.blockProduction || {});
  const generatedAt = timestamp(input.generatedAt) || new Date().toISOString();
  const liveNetwork = input.liveNetwork || buildStatusNetworkReadModel({ networkSnapshot, generatedAt });
  const sourceWarnings = warningValues(
    liveNetwork.warnings,
    stuckDashboard.warning,
    voteDashboard?.read_model?.stale
      ? 'Node-vote read model is stale'
      : '',
    voteDashboard?.backend?.backfill?.status === 'error'
      ? voteDashboard.backend.backfill.error || 'Node-vote backfill is degraded'
      : '',
    voteDashboard?.backend?.ws_listener?.status === 'error'
      ? voteDashboard.backend.ws_listener.error || 'Node-vote listener is degraded'
      : ''
  );
  const transactions = (Array.isArray(stuckDashboard.transactions) ? stuckDashboard.transactions : [])
    .slice(0, MAX_STATUS_STUCK_TRANSACTIONS)
    .map(compactStuckTransaction);
  const sourceTimestamps = {
    votes: timestamp(voteDashboard.as_of),
    stuck: timestamp(stuckDashboard.scanned_at)
  };

  return {
    schema_version: 3,
    as_of: generatedAt,
    network: liveNetwork.network,
    chains: liveNetwork.chains,
    block_production: blockProduction,
    churn: liveNetwork.churn,
    votes: {
      governance: getGovernanceVotes(voteDashboard.by_vote || []),
      status_updates: getRecentStatusUpdates(voteDashboard.by_vote || []),
      latest_vote_at: timestamp(voteDashboard?.stats?.latest_vote_at),
      source_status: {
        backfill: voteDashboard?.backend?.backfill?.status || 'unknown',
        listener: voteDashboard?.backend?.ws_listener?.status || 'unknown',
        stale: Boolean(voteDashboard?.read_model?.stale)
      }
    },
    stuck_transactions: {
      count: numberValue(stuckDashboard.count),
      transactions,
      truncated: numberValue(stuckDashboard.count) > transactions.length,
      partial: Boolean(stuckDashboard.partial),
      failed_lookups: numberValue(stuckDashboard.failed_lookups),
      scanned_height: numberValue(stuckDashboard.height)
    },
    sources: {
      network: liveNetwork.source,
      votes: {
        provider: 'boonetools-node-votes',
        as_of: sourceTimestamps.votes,
        stale: Boolean(voteDashboard?.read_model?.stale),
        fresh_until: timestamp(voteDashboard?.read_model?.fresh_until)
      },
      stuck: { provider: 'boonetools-stuck-scan', as_of: sourceTimestamps.stuck },
      block_production: {
        provider: blockProduction.source,
        as_of: blockProduction.as_of
      }
    },
    partial: Boolean(
      liveNetwork.partial ||
      stuckDashboard.partial ||
      voteDashboard?.read_model?.stale ||
      sourceWarnings.length > 0
    ),
    stale: Boolean(
      liveNetwork.stale ||
      stuckDashboard.stale ||
      voteDashboard?.read_model?.stale
    ),
    warnings: sourceWarnings
  };
}
