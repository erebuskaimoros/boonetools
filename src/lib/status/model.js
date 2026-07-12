const STATUS_UPDATE_KEY = /^(HALT|PAUSELP|SOLVENCYHALT|NODEPAUSE)/i;

function numberValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
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
  const globalChainHalt = isHeightMimirActive(
    mimirByKey.get('HALTCHAINGLOBAL'),
    thorchainHeight
  );
  const nodePauseUntil = numberValue(mimirByKey.get('NODEPAUSECHAINGLOBAL'));
  const nodePauseActive = thorchainHeight > 0 && nodePauseUntil >= thorchainHeight;
  const globalSigningHalt = isHeightMimirActive(
    mimirByKey.get('HALTSIGNING'),
    thorchainHeight
  );

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

export function buildChurnStatus(
  mimir = {},
  currentHeight = 0,
  churns = [],
  activeNodes = [],
  nowMs = Date.now()
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
    lastChurnHeight = Math.max(
      0,
      ...activeNodes.map((node) => numberValue(node?.status_since))
    );
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

  if (normalized === 'HALTTRADING') {
    return enabled ? 'Global trading resumed' : 'Global trading halted';
  }
  if (normalized === 'HALTSIGNING') {
    return enabled ? 'Global outbound signing resumed' : 'Global outbound signing halted';
  }
  if (normalized === 'HALTCHAINGLOBAL') {
    return enabled ? 'All chains resumed' : 'All chains halted';
  }
  if (normalized === 'HALTCHURNING') {
    return enabled ? 'Validator churning resumed' : 'Validator churning paused';
  }
  if (normalized === 'PAUSELP') {
    return enabled ? 'LP deposits and withdrawals resumed' : 'LP deposits and withdrawals paused';
  }

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
      blockTime: change.block_time,
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
    .sort((left, right) => (
      Date.parse(right.latest_vote_at || '') - Date.parse(left.latest_vote_at || '')
    ))
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
        latestVoteAt: row.latest_vote_at,
        height: numberValue(row.latest_height)
      };
    });
}
