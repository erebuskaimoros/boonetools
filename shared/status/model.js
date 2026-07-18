const STATUS_UPDATE_KEY = /^(HALT|PAUSELP|SOLVENCYHALT|NODEPAUSE)/i;
export const MAX_STATUS_STUCK_TRANSACTIONS = 20;

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

export function buildChainStatuses(inboundAddresses = [], mimir = {}, lastBlocks = []) {
  const blockByChain = new Map(lastBlocks.map((row) => [row.chain, row]));
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

export function buildChurnStatus(mimir = {}, currentHeight = 0, churns = [], activeNodes = [], nowMs = Date.now()) {
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
  return {
    isPaused,
    mimirValue: numberValue(mimirByKey.get('HALTCHURNING')),
    lastChurnHeight,
    lastChurnTimestampMs,
    blocksSince: lastChurnHeight > 0 ? Math.max(0, height - lastChurnHeight) : 0,
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
    .filter((row) => STATUS_UPDATE_KEY.test(row.mimir_key || ''))
    .flatMap((row) => (row.effective_history || []).map((change) => ({
      key: row.mimir_key,
      value: change.effective_value,
      description: updateDescription(row.mimir_key, change.effective_value),
      blockTime: timestamp(change.block_time),
      height: numberValue(change.height),
      txId: change.tx_id || '',
      tone: numberValue(change.effective_value) > 0 ? 'warn' : 'ok'
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

export function buildStatusDashboardReadModel(input = {}) {
  const networkSnapshot = input.networkSnapshot;
  if (!networkSnapshot || !Array.isArray(networkSnapshot.inbound_addresses)) {
    throw new Error('A usable network snapshot is required');
  }
  const voteDashboard = input.voteDashboard || {};
  const stuckDashboard = input.stuckDashboard || {};
  const generatedAt = timestamp(input.generatedAt) || new Date().toISOString();
  const nowMs = Date.parse(generatedAt);
  const nodes = Array.isArray(networkSnapshot.nodes) ? networkSnapshot.nodes : [];
  const activeNodes = nodes.filter((node) => node?.status === 'Active');
  const lastBlocks = Array.isArray(networkSnapshot.lastblock) ? networkSnapshot.lastblock : [];
  const mimir = networkSnapshot.mimir && typeof networkSnapshot.mimir === 'object'
    ? networkSnapshot.mimir
    : {};
  const chains = buildChainStatuses(networkSnapshot.inbound_addresses, mimir, lastBlocks);
  const thorchainHeight = Math.max(0, ...lastBlocks.map((row) => numberValue(row?.thorchain)));
  const networkWarnings = warningValues(
    networkSnapshot.warnings,
    Object.values(networkSnapshot.errors || {}),
    networkSnapshot.warning
  );
  const sourceWarnings = warningValues(
    networkWarnings,
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
    network: timestamp(networkSnapshot.as_of),
    votes: timestamp(voteDashboard.as_of),
    stuck: timestamp(stuckDashboard.scanned_at)
  };

  return {
    schema_version: 1,
    as_of: generatedAt,
    network: {
      height: thorchainHeight,
      active_node_count: activeNodes.length,
      majority_version: majorityVersion(nodes),
      summary: summarizeNetwork(chains)
    },
    chains,
    churn: buildChurnStatus(
      mimir,
      thorchainHeight,
      networkSnapshot.churns,
      activeNodes,
      Number.isFinite(nowMs) ? nowMs : Date.now()
    ),
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
      network: { provider: networkSnapshot.source || {}, as_of: sourceTimestamps.network },
      votes: {
        provider: 'boonetools-node-votes',
        as_of: sourceTimestamps.votes,
        stale: Boolean(voteDashboard?.read_model?.stale),
        fresh_until: timestamp(voteDashboard?.read_model?.fresh_until)
      },
      stuck: { provider: 'boonetools-stuck-scan', as_of: sourceTimestamps.stuck }
    },
    partial: Boolean(
      networkSnapshot.partial ||
      stuckDashboard.partial ||
      voteDashboard?.read_model?.stale ||
      sourceWarnings.length > 0
    ),
    stale: Boolean(
      networkSnapshot.stale ||
      stuckDashboard.stale ||
      voteDashboard?.read_model?.stale
    ),
    warnings: sourceWarnings
  };
}
