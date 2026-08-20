import { query } from '../db/pool.js';
import { json, parseIntegerParam } from '../lib/http.js';
import { toIsoString } from '../lib/utils.js';
import {
  fetchCurrentUpgradeProposals,
  NODE_VOTES_SYNC_KEY
} from '../shared/node-votes.js';
import { ANALYTICS_READ_MODEL_KEYS } from '../shared/analytics-read-model-keys.js';
import { getReadModel } from '../shared/read-models.js';
import {
  getThorNodeCoreSnapshot,
  isThorNodeCoreSnapshotStale
} from '../shared/thornode-core-snapshot.js';

export const NODE_VOTES_READ_MODEL_KEY = ANALYTICS_READ_MODEL_KEYS.nodeVotes;

const DEFAULT_DAYS = 183;
const MAX_ROWS = 10000;
const DEFAULT_OPERATIONAL_VOTES_MIN = 3;
const LISTENER_STALE_SECONDS = 180;

const OPERATIONAL_EXACT_KEYS = new Set([
  'MINTSYNTHS',
  'TRADEACCOUNTSENABLED',
  'RUNEPOOLENABLED',
  'EVMDISABLECONTRACTWHITELIST',
  'MAXOUTBOUNDATTEMPTS',
  'ADVSWAPQUEUERAPIDSWAPMAX',
  'ENABLEADVSWAPQUEUE',
  'STREAMINGLIMITSWAPMAXAGE',
  'OVERSOLVENCYCHECKINTERVAL',
  'OVERSOLVENCYTOTREASURYBPS',
  'SCHEDULEDMIGRATION',
  'MAXRETIREDVAULTRECOVERYATTEMPTS',
  'P2PGATEDISABLED',
  'ENABLEMEMOLESSOUTBOUND'
]);

const ECONOMIC_EXACT_KEYS = new Set([
  'NODEPAUSECHAINBLOCKS',
  'PAUSEONSLASHTHRESHOLD'
]);

const OPERATIONAL_PARTIAL_KEYS = [
  'HALT',
  'PAUSE',
  'STOPSOLVENCYCHECK',
  'MIMIRUPGRADECONTRACT',
  'EVMALLOWANCECHECK',
  'POLRESERVEBLACKLIST',
  'DYNAMICFEE-WHITELIST',
  'REVSHARE',
  'EVMDIRECTERC20INBOUND'
];

const OPERATIONAL_PREFIX_KEYS = [
  'COMPROMISEDVAULT-',
  'L1DYNAMICFEE'
];

const ASSET_SLIP_MIN_BPS_PREFIXES = [
  'L1SLIPMINBPS-',
  'SYNTHSLIPMINBPS-',
  'TRADEACCOUNTSSLIPMINBPS-',
  'DERIVEDSLIPMINBPS-',
  'SECUREDASSETSLIPMINBPS-',
  'STABLESLIPMINBPS-'
];

function subtractMonths(reference, months) {
  const date = new Date(reference.getTime());
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
}

function consensusThreshold(activeCount) {
  return activeCount > 0 ? Math.ceil((2 / 3) * activeCount) : 0;
}

function normalizeMimirKey(key) {
  return String(key || '').trim().toUpperCase();
}

function voteKindForKey(key) {
  return normalizeMimirKey(key).startsWith('UPGRADE-') ? 'upgrade' : 'mimir';
}

function isAssetSlipMinBpsMimirKey(normalized) {
  return ASSET_SLIP_MIN_BPS_PREFIXES.some((prefix) => (
    normalized.startsWith(prefix) && normalized.length > prefix.length
  ));
}

export function classifyMimirKey(key) {
  const normalized = normalizeMimirKey(key);
  if (voteKindForKey(normalized) === 'upgrade') return 'upgrade';
  if (OPERATIONAL_EXACT_KEYS.has(normalized)) return 'operational';
  if (ECONOMIC_EXACT_KEYS.has(normalized)) return 'economic';
  if (OPERATIONAL_PREFIX_KEYS.some((prefix) => normalized.startsWith(prefix))) return 'operational';
  if (OPERATIONAL_PARTIAL_KEYS.some((match) => normalized.includes(match))) return 'operational';
  if (normalized.endsWith('SLIPMINBPS') || isAssetSlipMinBpsMimirKey(normalized)) return 'operational';
  return 'economic';
}

export function normalizeUpgradeProposalState(proposals, nodeMetadataByAddress = new Map()) {
  const votesByKey = {};
  const proposalsByKey = {};

  for (const proposal of Array.isArray(proposals) ? proposals : []) {
    const name = String(proposal?.name || '').trim();
    if (!name) continue;
    const voteKey = normalizeMimirKey(`UPGRADE-${name}`);
    const byNode = new Map();
    for (const [field, voteValue] of [['approvers', 'approve'], ['rejecters', 'reject']]) {
      for (const value of Array.isArray(proposal?.[field]) ? proposal[field] : []) {
        const nodeAddress = String(value || '').trim();
        if (!nodeAddress) continue;
        const metadata = nodeMetadataByAddress.get(nodeAddress) || {};
        byNode.set(nodeAddress, {
          mimir_key: voteKey,
          vote_kind: 'upgrade',
          mimir_category: 'upgrade',
          vote_category: 'upgrade',
          node_address: nodeAddress,
          operator_address: metadata.operator_address || nodeAddress,
          node_operator_address: metadata.operator_address || nodeAddress,
          node_status: metadata.node_status || '',
          is_active: Boolean(metadata.is_active),
          vote_value: voteValue
        });
      }
    }
    const proposalVotes = [...byNode.values()];
    const approvers = proposalVotes.filter((row) => row.vote_value === 'approve');
    const rejecters = proposalVotes.filter((row) => row.vote_value === 'reject');
    votesByKey[voteKey] = proposalVotes;
    proposalsByKey[voteKey] = {
      name,
      height: Number(proposal?.height || 0) || 0,
      info: String(proposal?.info || ''),
      approved: Boolean(proposal?.approved),
      approved_percent: Number(proposal?.approved_percent || 0) || 0,
      validators_to_quorum: Number(proposal?.validators_to_quorum || 0) || 0,
      approvers: approvers.map((row) => row.node_address),
      rejecters: rejecters.map((row) => row.node_address),
      active_approvers: approvers.filter((row) => row.is_active).map((row) => row.node_address),
      active_rejecters: rejecters.filter((row) => row.is_active).map((row) => row.node_address),
      active_approval_count: approvers.filter((row) => row.is_active).length,
      active_rejection_count: rejecters.filter((row) => row.is_active).length
    };
  }

  return { votesByKey, proposalsByKey };
}

function normalizeMimirValues(values) {
  const normalized = {};
  for (const [key, value] of Object.entries(values || {})) {
    normalized[normalizeMimirKey(key)] = value;
  }
  return normalized;
}

function nodeAddressFromNode(node) {
  return String(node?.node_address || node?.address || '').trim();
}

function buildNodeMetadataByAddress(nodes) {
  const metadata = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const nodeAddress = nodeAddressFromNode(node);
    if (!nodeAddress) {
      continue;
    }

    const nodeStatus = String(node?.status || '');
    const operator = String(node?.node_operator_address || '').trim();
    metadata.set(nodeAddress, {
      operator_address: operator || nodeAddress,
      node_status: nodeStatus,
      is_active: nodeStatus === 'Active'
    });
  }

  return metadata;
}

export function buildActiveNodeOperators(nodes) {
  const activeNodesByAddress = new Map();

  for (const node of Array.isArray(nodes) ? nodes : []) {
    const nodeAddress = nodeAddressFromNode(node);
    if (!nodeAddress || node?.status !== 'Active') {
      continue;
    }

    const operatorAddress = String(node?.node_operator_address || '').trim();
    activeNodesByAddress.set(nodeAddress, {
      node_address: nodeAddress,
      operator_address: operatorAddress || nodeAddress
    });
  }

  return [...activeNodesByAddress.values()].sort((left, right) => (
    left.operator_address.localeCompare(right.operator_address) ||
    left.node_address.localeCompare(right.node_address)
  ));
}

function normalizeNodeMimirValues(payload, nodeMetadataByAddress = new Map()) {
  const byKeyAndNode = new Map();
  const rows = Array.isArray(payload?.mimirs)
    ? payload.mimirs
    : (Array.isArray(payload) ? payload : []);

  for (const row of rows) {
    const mimirKey = normalizeMimirKey(row?.key);
    const nodeAddress = String(row?.signer || row?.address || '').trim();
    if (!mimirKey || !nodeAddress) {
      continue;
    }

    if (!byKeyAndNode.has(mimirKey)) {
      byKeyAndNode.set(mimirKey, new Map());
    }
    const metadata = nodeMetadataByAddress.get(nodeAddress) || {};
    byKeyAndNode.get(mimirKey).set(nodeAddress, {
      mimir_key: mimirKey,
      node_address: nodeAddress,
      operator_address: metadata.operator_address || nodeAddress,
      node_operator_address: metadata.operator_address || nodeAddress,
      node_status: metadata.node_status || '',
      is_active: Boolean(metadata.is_active),
      vote_value: String(row?.value ?? 0)
    });
  }

  return Object.fromEntries(
    [...byKeyAndNode.entries()].map(([mimirKey, rowsByNode]) => (
      [mimirKey, [...rowsByNode.values()]]
    ))
  );
}

function parseOperationalVotesMin(currentMimirValues) {
  const parsed = Number(currentMimirValues.OPERATIONALVOTESMIN);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.ceil(parsed)
    : DEFAULT_OPERATIONAL_VOTES_MIN;
}

function rowTimeMs(row) {
  const parsed = Date.parse(toIsoString(row.block_time) || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeVoteRow(row) {
  const operator = String(row.node_operator_address || '').trim();
  const mimirKey = normalizeMimirKey(row.mimir_key);
  const voteKind = voteKindForKey(mimirKey);
  const voteCategory = classifyMimirKey(mimirKey);
  return {
    event_key: String(row.event_key || ''),
    tx_id: String(row.tx_id || ''),
    height: Number(row.height) || 0,
    block_time: toIsoString(row.block_time),
    event_index: Number(row.event_index) || 0,
    node_address: String(row.node_address || ''),
    node_operator_address: operator,
    operator_address: operator || String(row.node_address || ''),
    node_status: String(row.node_status || ''),
    mimir_key: mimirKey,
    vote_key: mimirKey,
    vote_kind: voteKind,
    upgrade_name: voteKind === 'upgrade' ? mimirKey.slice('UPGRADE-'.length) : '',
    mimir_category: voteCategory,
    vote_category: voteCategory,
    vote_value: String(row.vote_value ?? ''),
    vote_value_numeric: row.vote_value_numeric == null ? null : Number(row.vote_value_numeric),
    source: String(row.source || ''),
    observed_at: toIsoString(row.observed_at)
  };
}

function uniqueCount(rows, key) {
  return new Set(rows.map((row) => row[key]).filter(Boolean)).size;
}

function latestVoteStances(rows) {
  const latest = new Map();

  for (const row of sortRowsAsc(rows)) {
    const key = `${row.mimir_key}:${row.node_address}`;
    if (isVoteRemoval(row)) {
      latest.delete(key);
    } else {
      latest.set(key, row);
    }
  }

  return [...latest.values()];
}

function countValueChanges(rows) {
  const latestValueByNode = new Map();
  let changes = 0;

  for (const row of sortRowsAsc(rows)) {
    const previousValue = latestValueByNode.get(row.node_address);
    const nextValue = String(row.vote_value ?? '');
    if (previousValue !== undefined && previousValue !== nextValue) {
      changes += 1;
    }
    latestValueByNode.set(row.node_address, nextValue);
  }

  return changes;
}

function compareRowsAsc(left, right) {
  const timeDiff = rowTimeMs(left) - rowTimeMs(right);
  if (timeDiff !== 0) return timeDiff;
  const heightDiff = (left.height || 0) - (right.height || 0);
  if (heightDiff !== 0) return heightDiff;
  return (left.event_index || 0) - (right.event_index || 0);
}

function compareRowsDesc(left, right) {
  return compareRowsAsc(right, left);
}

function sortRowsAsc(rows) {
  return [...rows].sort(compareRowsAsc);
}

function numericVote(row) {
  const parsed = Number(row?.vote_value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isVoteRemoval(row) {
  const parsed = numericVote(row);
  return parsed !== null && parsed < 0;
}

function increment(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

export function buildValueBreakdown(rows, currentValue, activeNodeCount, threshold) {
  const byValue = new Map();
  for (const row of rows) {
    if (isVoteRemoval(row)) {
      continue;
    }
    const value = row.vote_value || '0';
    if (!byValue.has(value)) {
      byValue.set(value, []);
    }
    byValue.get(value).push(row);
  }

  return [...byValue.entries()]
    .map(([value, valueRows]) => {
      const count = valueRows.length;
      const percent = activeNodeCount > 0 ? (count / activeNodeCount) * 100 : 0;
      return {
        value,
        count,
        percent,
        is_active: currentValue !== undefined && String(currentValue) === String(value),
        votes_to_consensus: Math.max(0, threshold - count),
        nodes: [...new Set(valueRows.map((row) => row.node_address))],
        operators: [...new Set(valueRows.map((row) => row.operator_address))]
      };
    })
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      if (left.is_active !== right.is_active) return left.is_active ? -1 : 1;
      return String(left.value).localeCompare(String(right.value));
    });
}

function currentNodeVoteRows(historicalRows) {
  const latestByNode = new Map();
  const eventCounts = new Map();

  for (const row of sortRowsAsc(historicalRows)) {
    increment(eventCounts, row.node_address);
    latestByNode.set(row.node_address, row);
  }

  return [...latestByNode.values()]
    .sort((left, right) => compareRowsDesc(left, right))
    .map((row) => ({
      node_address: row.node_address,
      operator_address: row.operator_address,
      node_status: row.node_status,
      vote_value: isVoteRemoval(row) ? null : row.vote_value,
      latest_action_value: row.vote_value,
      vote_removed: isVoteRemoval(row),
      event_count: eventCounts.get(row.node_address) || 0,
      block_time: toIsoString(row.block_time),
      height: row.height,
      tx_id: row.tx_id
    }));
}

function voteEventHistoryRows(historicalRows) {
  return [...historicalRows]
    .sort((left, right) => compareRowsDesc(left, right))
    .map((row) => ({
      mimir_key: row.mimir_key,
      vote_key: row.mimir_key,
      vote_kind: row.vote_kind || voteKindForKey(row.mimir_key),
      upgrade_name: voteKindForKey(row.mimir_key) === 'upgrade'
        ? normalizeMimirKey(row.mimir_key).slice('UPGRADE-'.length)
        : '',
      mimir_category: row.mimir_category || classifyMimirKey(row.mimir_key),
      vote_category: row.vote_category || row.mimir_category || classifyMimirKey(row.mimir_key),
      node_address: row.node_address,
      operator_address: row.operator_address,
      node_status: row.node_status,
      vote_value: row.vote_value,
      vote_removed: isVoteRemoval(row),
      block_time: toIsoString(row.block_time),
      height: row.height,
      tx_id: row.tx_id,
      source: row.source
    }));
}

function effectiveValueFromVotes(votes, currentValue, activeNodeCount, threshold, targetValue = null) {
  const breakdown = buildValueBreakdown(votes, currentValue, activeNodeCount, threshold);
  const leader = targetValue == null
    ? (breakdown[0] || null)
    : (breakdown.find((row) => row.value === targetValue) || null);
  const leaderTied = Boolean(
    leader &&
    targetValue == null && breakdown[1] &&
    breakdown[1].count === leader.count
  );

  return {
    value: leader && !leaderTied && threshold > 0 && leader.count >= threshold ? leader.value : null,
    leader,
    leader_tied: leaderTied,
    breakdown
  };
}

export function buildEffectiveValueHistory(historicalRows, options = {}) {
  const category = options.category || classifyMimirKey(historicalRows[0]?.mimir_key);
  const threshold = Number(options.threshold || 0);
  const activeNodeCount = Number(options.activeNodeCount || 0);
  const currentValue = options.currentValue;
  const targetValue = category === 'upgrade' ? 'approve' : null;
  const activeVotes = new Map();
  const changes = [];
  let lastEffectiveValue = null;

  for (const row of sortRowsAsc(historicalRows)) {
    if (isVoteRemoval(row)) {
      activeVotes.delete(row.node_address);
    } else {
      activeVotes.set(row.node_address, row);
    }

    const effective = effectiveValueFromVotes(
      [...activeVotes.values()],
      currentValue,
      activeNodeCount,
      threshold,
      targetValue
    );

    if (effective.value === null || String(effective.value) === String(lastEffectiveValue)) {
      continue;
    }

    lastEffectiveValue = String(effective.value);
    changes.push({
      effective_value: effective.value,
      mimir_category: category,
      vote_kind: category === 'upgrade' ? 'upgrade' : 'mimir',
      vote_category: category,
      consensus_model: category === 'operational'
        ? 'operational-min'
        : (category === 'upgrade' ? 'upgrade-supermajority' : 'economic-supermajority'),
      threshold,
      leader_count: effective.leader?.count || 0,
      active_vote_count: [...activeVotes.values()].length,
      active_node_count: activeNodeCount,
      triggered_by_node: row.node_address,
      triggered_by_operator: row.operator_address,
      trigger_vote_value: row.vote_value,
      block_time: toIsoString(row.block_time),
      height: row.height,
      tx_id: row.tx_id
    });
  }

  return changes.reverse();
}

function firstVoteTime(historicalRows) {
  return toIsoString(sortRowsAsc(historicalRows)[0]?.block_time);
}

function firstPassedTime(effectiveHistory) {
  return toIsoString(effectiveHistory.at(-1)?.block_time);
}

function latestCurrentValueVoteRows(historicalRows, currentNodeMimirs, currentValue) {
  const currentValueText = String(currentValue ?? '');
  if (!currentValueText || !Array.isArray(currentNodeMimirs) || currentNodeMimirs.length === 0) {
    return [];
  }

  const currentValueNodes = new Set(
    currentNodeMimirs
      .filter((row) => String(row.vote_value) === currentValueText)
      .map((row) => row.node_address)
      .filter(Boolean)
  );
  const latestByNode = new Map();

  for (const row of sortRowsAsc(historicalRows)) {
    if (!currentValueNodes.has(row.node_address)) {
      continue;
    }

    if (isVoteRemoval(row) || String(row.vote_value) !== currentValueText) {
      latestByNode.delete(row.node_address);
      continue;
    }

    latestByNode.set(row.node_address, row);
  }

  return [...latestByNode.values()].sort(compareRowsAsc);
}

function buildCurrentValueChange(historicalRows, options = {}) {
  const category = options.category || classifyMimirKey(historicalRows[0]?.mimir_key);
  if (category !== 'operational') {
    return null;
  }

  const threshold = Number(options.threshold || 0);
  const activeNodeCount = Number(options.activeNodeCount || 0);
  const currentValue = options.currentValue;
  const currentVoteRows = latestCurrentValueVoteRows(
    historicalRows,
    options.currentNodeMimirs || [],
    currentValue
  );

  if (threshold <= 0 || currentVoteRows.length < threshold) {
    return null;
  }

  const trigger = currentVoteRows[threshold - 1];
  return {
    effective_value: String(currentValue),
    mimir_category: category,
    consensus_model: 'operational-min',
    threshold,
    leader_count: currentVoteRows.length,
    active_vote_count: currentVoteRows.length,
    active_node_count: activeNodeCount,
    triggered_by_node: trigger.node_address,
    triggered_by_operator: trigger.operator_address,
    trigger_vote_value: trigger.vote_value,
    block_time: toIsoString(trigger.block_time),
    height: trigger.height,
    tx_id: trigger.tx_id,
    inferred_from_current_node_mimirs: true
  };
}

function mergeEffectiveHistory(effectiveHistory, currentValueChange) {
  if (!currentValueChange) {
    return effectiveHistory;
  }

  const alreadyRecorded = effectiveHistory.some((change) => (
    String(change.effective_value) === String(currentValueChange.effective_value) &&
    Number(change.height || 0) === Number(currentValueChange.height || 0)
  ));

  if (alreadyRecorded) {
    return effectiveHistory;
  }

  return [currentValueChange, ...effectiveHistory].sort(compareRowsDesc);
}

function liveActiveNodeMimirRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.is_active && !isVoteRemoval(row));
}

function activeRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => row?.is_active && !isVoteRemoval(row));
}

function currentConsensusRows({
  voteKind,
  historicalStances,
  currentNodeMimirs,
  currentNodeMimirsAvailable,
  currentUpgradeVotes,
  currentUpgradeStateAvailable,
  currentUpgradeProposalAvailable,
  activeNodeAddresses
}) {
  if (voteKind === 'upgrade') {
    if (currentUpgradeProposalAvailable) return activeRows(currentUpgradeVotes);
    if (currentUpgradeStateAvailable) return [];
    if (activeNodeAddresses.size > 0) {
      return historicalStances.filter((row) => activeNodeAddresses.has(row.node_address));
    }
    return historicalStances;
  }
  if (!currentNodeMimirsAvailable) {
    return historicalStances;
  }

  return liveActiveNodeMimirRows(currentNodeMimirs);
}

function economicHistoryRows({ category, historicalRows, currentRows, currentNodeMimirsAvailable }) {
  if (category !== 'economic' || !currentNodeMimirsAvailable) {
    return historicalRows;
  }

  const currentNodeAddresses = new Set(
    currentRows
      .map((row) => row.node_address)
      .filter(Boolean)
  );

  return historicalRows.filter((row) => currentNodeAddresses.has(row.node_address));
}

export function buildVoteGroups(
  rows,
  latestRows,
  currentMimirValues,
  activeNodeCount,
  operationalVotesMin = DEFAULT_OPERATIONAL_VOTES_MIN,
  currentNodeMimirsByKey = {},
  options = {}
) {
  const economicThreshold = consensusThreshold(activeNodeCount);
  const historicalByKey = new Map();
  const latestByKey = new Map();
  const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const currentNodeMimirsAvailable = Boolean(options.currentNodeMimirsAvailable);
  const currentUpgradeVotesAvailable = Boolean(options.currentUpgradeVotesAvailable);
  const currentUpgradeVotesByKey = options.currentUpgradeVotesByKey || {};
  const currentUpgradeProposalsByKey = options.currentUpgradeProposalsByKey || {};
  const activeNodeAddresses = new Set(options.activeNodeAddresses || []);

  for (const row of rows) {
    if (!historicalByKey.has(row.mimir_key)) {
      historicalByKey.set(row.mimir_key, []);
    }
    historicalByKey.get(row.mimir_key).push(row);
  }

  for (const row of latestRows) {
    if (!latestByKey.has(row.mimir_key)) {
      latestByKey.set(row.mimir_key, []);
    }
    latestByKey.get(row.mimir_key).push(row);
  }

  for (const mimirKey of Object.keys(currentUpgradeProposalsByKey)) {
    if (!historicalByKey.has(mimirKey)) historicalByKey.set(mimirKey, []);
  }

  return [...historicalByKey.entries()]
    .map(([mimirKey, historicalRows]) => {
      const category = classifyMimirKey(mimirKey);
      const voteKind = voteKindForKey(mimirKey);
      const threshold = category === 'operational' ? operationalVotesMin : economicThreshold;
      const stances = latestByKey.get(mimirKey) || [];
      const currentNodeMimirs = currentNodeMimirsByKey[mimirKey] || [];
      const currentUpgradeVotes = currentUpgradeVotesByKey[mimirKey] || [];
      const proposal = currentUpgradeProposalsByKey[mimirKey] || null;
      const consensusRows = currentConsensusRows({
        voteKind,
        historicalStances: stances,
        currentNodeMimirs,
        currentNodeMimirsAvailable,
        currentUpgradeVotes,
        currentUpgradeStateAvailable: currentUpgradeVotesAvailable,
        currentUpgradeProposalAvailable: currentUpgradeVotesAvailable && Boolean(proposal),
        activeNodeAddresses
      });
      const effectiveHistoryRows = economicHistoryRows({
        category: category === 'upgrade' ? 'economic' : category,
        historicalRows,
        currentRows: consensusRows,
        currentNodeMimirsAvailable: voteKind === 'upgrade'
          ? (currentUpgradeVotesAvailable && Boolean(proposal))
          : currentNodeMimirsAvailable
      });
      const currentValue = voteKind === 'upgrade'
        ? (proposal?.approved ? 'approve' : null)
        : currentMimirValues[mimirKey];
      const valueBreakdown = buildValueBreakdown(
        consensusRows,
        currentValue,
        activeNodeCount,
        threshold
      );
      const approval = voteKind === 'upgrade'
        ? (valueBreakdown.find((row) => row.value === 'approve') || null)
        : null;
      const rejection = voteKind === 'upgrade'
        ? (valueBreakdown.find((row) => row.value === 'reject') || null)
        : null;
      const leader = voteKind === 'upgrade' ? approval : (valueBreakdown[0] || null);
      const leaderTied = Boolean(
        voteKind !== 'upgrade' &&
        leader &&
        valueBreakdown[1] &&
        valueBreakdown[1].count === leader.count
      );
      const latestVote = historicalRows.reduce((best, row) => (
        rowTimeMs(row) > rowTimeMs(best || {}) ? row : best
      ), null);
      const recentVotes = historicalRows.filter((row) => rowTimeMs(row) >= recentCutoff).length;
      const uniqueNodeKeyPairs = new Set(historicalRows.map((row) => `${row.node_address}:${row.mimir_key}`)).size;
      const rawEffectiveHistory = buildEffectiveValueHistory(effectiveHistoryRows, {
        category,
        threshold,
        activeNodeCount,
        currentValue
      });
      const currentValueChange = buildCurrentValueChange(historicalRows, {
        category,
        threshold,
        activeNodeCount,
        currentValue: currentMimirValues[mimirKey],
        currentNodeMimirs
      });
      const effectiveHistory = mergeEffectiveHistory(rawEffectiveHistory, currentValueChange);
      const currentVoteSource = voteKind === 'upgrade'
        ? (currentUpgradeVotesAvailable && proposal
          ? 'thornode-upgrade-proposal'
          : (currentUpgradeVotesAvailable
            ? 'historical-expired'
            : (activeNodeAddresses.size > 0 ? 'stored-active-latest-stance' : 'stored-latest-stance')))
        : (currentNodeMimirsAvailable ? 'thornode-active-node-mimir' : 'stored-latest-stance');

      return {
        mimir_key: mimirKey,
        vote_key: mimirKey,
        vote_kind: voteKind,
        upgrade_name: voteKind === 'upgrade' ? mimirKey.slice('UPGRADE-'.length) : '',
        mimir_category: category,
        vote_category: category,
        consensus_model: category === 'operational'
          ? 'operational-min'
          : (voteKind === 'upgrade' ? 'upgrade-supermajority' : 'economic-supermajority'),
        consensus_threshold: threshold,
        current_value: currentValue ?? null,
        proposal,
        proposal_status: voteKind !== 'upgrade'
          ? ''
          : (proposal ? 'current' : (currentUpgradeVotesAvailable ? 'historical' : 'unknown')),
        historical_vote_events: historicalRows.length,
        latest_stance_count: consensusRows.length,
        stored_latest_stance_count: stances.length,
        current_vote_source: currentVoteSource,
        repeated_vote_events: Math.max(0, historicalRows.length - uniqueNodeKeyPairs),
        value_change_events: countValueChanges(historicalRows),
        recent_7d_votes: recentVotes,
        unique_nodes: uniqueCount(
          voteKind === 'upgrade' ? [...historicalRows, ...consensusRows] : historicalRows,
          'node_address'
        ),
        unique_operators: uniqueCount(
          voteKind === 'upgrade' ? [...historicalRows, ...consensusRows] : historicalRows,
          'operator_address'
        ),
        first_vote_at: firstVoteTime(historicalRows),
        passed_at: category === 'operational' ? null : firstPassedTime(effectiveHistory),
        current_value_changed_at: toIsoString(currentValueChange?.block_time),
        latest_vote_at: toIsoString(latestVote?.block_time),
        latest_height: latestVote?.height || 0,
        leader_value: leader?.value || '',
        leader_count: leader?.count || 0,
        leader_percent: leader?.percent || 0,
        leader_tied: leaderTied,
        votes_to_consensus: Math.max(0, threshold - (leader?.count || 0)),
        consensus_ready: Boolean(leader && !leaderTied && threshold > 0 && leader.count >= threshold),
        approval_count: approval?.count || 0,
        rejection_count: rejection?.count || 0,
        node_votes: voteKind === 'upgrade'
          ? currentNodeVoteRows(consensusRows)
          : currentNodeVoteRows(historicalRows),
        vote_history: voteEventHistoryRows(historicalRows),
        effective_history: effectiveHistory,
        values: valueBreakdown
      };
    })
    .sort((left, right) => {
      if (right.recent_7d_votes !== left.recent_7d_votes) return right.recent_7d_votes - left.recent_7d_votes;
      if (right.historical_vote_events !== left.historical_vote_events) return right.historical_vote_events - left.historical_vote_events;
      return left.mimir_key.localeCompare(right.mimir_key);
    });
}

function categoryCountsForRows(rows) {
  const categoryCounts = { operational: 0, economic: 0, upgrade: 0 };
  const categoryKeys = { operational: new Set(), economic: new Set(), upgrade: new Set() };

  for (const row of rows) {
    const category = row.mimir_category || classifyMimirKey(row.mimir_key);
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    categoryKeys[category] ||= new Set();
    categoryKeys[category].add(row.mimir_key);
  }

  return {
    category_counts: categoryCounts,
    category_key_counts: {
      operational: categoryKeys.operational.size,
      economic: categoryKeys.economic.size,
      upgrade: categoryKeys.upgrade.size
    }
  };
}

function firstVoteTimesByKey(rows) {
  const times = new Map();
  for (const row of sortRowsAsc(rows)) {
    if (!times.has(row.mimir_key)) {
      times.set(row.mimir_key, rowTimeMs(row));
    }
  }
  return times;
}

function averageNodeResponseMs(historicalRows, firstByKey) {
  const firstByNodeKey = firstVoteTimesByKey(historicalRows);
  const delays = [];

  for (const [mimirKey, nodeFirstMs] of firstByNodeKey.entries()) {
    const keyFirstMs = firstByKey.get(mimirKey) || 0;
    if (nodeFirstMs > 0 && keyFirstMs > 0 && nodeFirstMs >= keyFirstMs) {
      delays.push(nodeFirstMs - keyFirstMs);
    }
  }

  if (delays.length === 0) {
    return null;
  }

  return Math.round(delays.reduce((total, value) => total + value, 0) / delays.length);
}

function nodeGroupLatestTimeMs(row) {
  const parsed = Date.parse(row?.latest_vote_at || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildNodeGroups(rows, latestRows) {
  const historicalByNode = new Map();
  const latestByNode = new Map();
  const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const firstByKey = firstVoteTimesByKey(rows);
  const economicKeys = new Set(
    rows
      .filter((row) => (row.mimir_category || classifyMimirKey(row.mimir_key)) === 'economic')
      .map((row) => row.mimir_key)
  );

  for (const row of rows) {
    if (!historicalByNode.has(row.node_address)) {
      historicalByNode.set(row.node_address, []);
    }
    historicalByNode.get(row.node_address).push(row);
  }

  for (const row of latestRows) {
    if (!historicalByNode.has(row.node_address)) {
      historicalByNode.set(row.node_address, []);
    }
    if (!latestByNode.has(row.node_address)) {
      latestByNode.set(row.node_address, []);
    }
    latestByNode.get(row.node_address).push(row);
  }

  return [...historicalByNode.entries()]
    .map(([nodeAddress, historicalRows]) => {
      const stances = latestByNode.get(nodeAddress) || [];
      const participationRows = [...historicalRows];
      const historicalKeys = new Set(historicalRows.map((row) => row.mimir_key));
      for (const stance of stances) {
        if (!historicalKeys.has(stance.mimir_key)) participationRows.push(stance);
      }
      const latestVote = historicalRows.reduce((best, row) => (
        rowTimeMs(row) > rowTimeMs(best || {}) ? row : best
      ), null);
      const uniqueNodeKeyPairs = new Set(historicalRows.map((row) => `${row.node_address}:${row.mimir_key}`)).size;
      const latestMetadata = latestVote || stances[0] || historicalRows[0] || {};
      const categories = categoryCountsForRows(participationRows);
      const nodeEconomicKeys = new Set(
        participationRows
          .filter((row) => (row.mimir_category || classifyMimirKey(row.mimir_key)) === 'economic')
          .map((row) => row.mimir_key)
      );
      const economicVotedPercent = economicKeys.size > 0
        ? (nodeEconomicKeys.size / economicKeys.size) * 100
        : 0;

      return {
        node_address: nodeAddress,
        operator_address: latestMetadata.operator_address || '',
        node_status: latestMetadata.node_status || '',
        total_vote_events: historicalRows.length,
        latest_stance_count: stances.length,
        repeated_vote_events: Math.max(0, historicalRows.length - uniqueNodeKeyPairs),
        unique_keys: uniqueCount(participationRows, 'mimir_key'),
        category_counts: categories.category_counts,
        category_key_counts: categories.category_key_counts,
        avg_response_time_ms: averageNodeResponseMs(historicalRows, firstByKey),
        economic_vote_key_count: nodeEconomicKeys.size,
        economic_tracked_key_count: economicKeys.size,
        economic_voted_percent: economicVotedPercent,
        recent_7d_votes: historicalRows.filter((row) => rowTimeMs(row) >= recentCutoff).length,
        latest_vote_at: toIsoString(latestVote?.block_time),
        latest_height: latestVote?.height || 0,
        vote_history: voteEventHistoryRows(historicalRows)
      };
    })
    .sort((left, right) => {
      const timeDiff = nodeGroupLatestTimeMs(right) - nodeGroupLatestTimeMs(left);
      if (timeDiff !== 0) return timeDiff;
      const heightDiff = (right.latest_height || 0) - (left.latest_height || 0);
      if (heightDiff !== 0) return heightDiff;
      return left.node_address.localeCompare(right.node_address);
    });
}

function buildCategoryStats(rows, voteGroups) {
  const categories = {
    operational: {
      vote_events: 0,
      vote_keys: 0,
      passed_keys: 0
    },
    economic: {
      vote_events: 0,
      vote_keys: 0,
      passed_keys: 0
    },
    upgrade: {
      vote_events: 0,
      vote_keys: 0,
      passed_keys: 0
    }
  };

  for (const row of rows) {
    const category = row.mimir_category || classifyMimirKey(row.mimir_key);
    categories[category] ||= { vote_events: 0, vote_keys: 0, passed_keys: 0 };
    categories[category].vote_events += 1;
  }

  for (const group of voteGroups) {
    const category = group.mimir_category || classifyMimirKey(group.mimir_key);
    categories[category] ||= { vote_events: 0, vote_keys: 0, passed_keys: 0 };
    categories[category].vote_keys += 1;
    if (group.consensus_ready) {
      categories[category].passed_keys += 1;
    }
  }

  return categories;
}

function buildStats(rows, latestRows, voteGroups, nodeGroups, activeNodeCount, operationalVotesMin) {
  const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const hottestVote = voteGroups[0] || null;
  const mostActiveNode = nodeGroups[0] || null;
  const categories = buildCategoryStats(rows, voteGroups);

  return {
    total_vote_events: rows.length,
    latest_stances: latestRows.length,
    unique_vote_keys: voteGroups.length,
    unique_nodes: uniqueCount(rows, 'node_address'),
    unique_operators: uniqueCount(rows, 'operator_address'),
    active_node_count: activeNodeCount,
    consensus_threshold: consensusThreshold(activeNodeCount),
    operational_votes_min: operationalVotesMin,
    recent_7d_votes: rows.filter((row) => rowTimeMs(row) >= recentCutoff).length,
    consensus_ready_keys: voteGroups.filter((row) => row.consensus_ready).length,
    operational_vote_keys: categories.operational.vote_keys,
    operational_vote_events: categories.operational.vote_events,
    operational_passed_keys: categories.operational.passed_keys,
    economic_vote_keys: categories.economic.vote_keys,
    economic_vote_events: categories.economic.vote_events,
    economic_passed_keys: categories.economic.passed_keys,
    upgrade_vote_keys: categories.upgrade.vote_keys,
    upgrade_vote_events: categories.upgrade.vote_events,
    upgrade_passed_keys: categories.upgrade.passed_keys,
    categories,
    hottest_vote_key: hottestVote?.mimir_key || '',
    hottest_vote_events: hottestVote?.historical_vote_events || 0,
    most_active_node: mostActiveNode?.node_address || '',
    most_active_node_operator: mostActiveNode?.operator_address || '',
    most_active_node_votes: mostActiveNode?.total_vote_events || 0,
    latest_vote_at: rows[0]?.block_time || null,
    latest_height: rows[0]?.height || 0
  };
}

export async function loadCurrentNodeVoteChainState(options = {}) {
  const model = options.coreSnapshot || await (
    options.getThorNodeCoreSnapshot || getThorNodeCoreSnapshot
  )({ client: options.client, allowStale: true, cache: false });
  const core = model?.payload || model;
  const mimir = core?.mimir;
  const constants = core?.constants && typeof core.constants === 'object' && !Array.isArray(core.constants)
    ? core.constants
    : {};
  const nodes = Array.isArray(core?.nodes) ? core.nodes : [];
  const nodeMimirs = core?.node_mimirs;
  const currentMimirValues = mimir ? normalizeMimirValues(mimir) : {};
  const activeNodes = buildActiveNodeOperators(nodes);
  const activeNodeCount = activeNodes.length;
  const nodeMetadataByAddress = buildNodeMetadataByAddress(nodes);
  const upgradeProposals = options.upgradeProposals !== undefined
    ? options.upgradeProposals
    : await (options.fetchUpgradeProposals || fetchCurrentUpgradeProposals)();
  const upgradeState = normalizeUpgradeProposalState(upgradeProposals, nodeMetadataByAddress);
  const currentNodeMimirsAvailable = (
    Boolean(mimir) &&
    Boolean(nodeMimirs) &&
    nodes.length > 0 &&
    !isThorNodeCoreSnapshotStale(model, ['mimir', 'nodes', 'node_mimirs'])
  );
  const currentMimirValuesAvailable = (
    Boolean(mimir) && !isThorNodeCoreSnapshotStale(model, ['mimir'])
  );
  const currentConstantsAvailable = (
    Object.keys(constants).length > 0 && !isThorNodeCoreSnapshotStale(model, ['constants'])
  );

  return {
    currentMimirValues,
    currentMimirValuesAvailable,
    currentConstants: constants,
    currentConstantsAvailable,
    mimirUpdatedAt: core?.field_meta?.mimir?.fetched_at || null,
    constantsUpdatedAt: core?.field_meta?.constants?.fetched_at || null,
    currentNodeMimirsByKey: nodeMimirs
      ? normalizeNodeMimirValues(nodeMimirs, nodeMetadataByAddress)
      : {},
    currentNodeMimirsAvailable,
    currentUpgradeVotesByKey: upgradeState.votesByKey,
    currentUpgradeProposalsByKey: upgradeState.proposalsByKey,
    currentUpgradeVotesAvailable: true,
    upgradeProposals: Object.values(upgradeState.proposalsByKey),
    activeNodeCount,
    activeNodes,
    sourceUpdatedAt: core?.source_updated_at || model?.sourceUpdatedAt || null
  };
}

async function loadBackendState(client = { query }) {
  const [backfillResult, wsResult, syncResult] = await Promise.all([
    client.query(
      `select started_at, finished_at, status, error, stats_json
       from node_vote_job_runs
       where job_name = $1
       order by started_at desc
       limit 1`,
      ['node-votes-backfill']
    ),
    client.query(
      `select started_at, finished_at, status, error, stats_json
       from node_vote_job_runs
       where job_name = $1
       order by started_at desc
       limit 1`,
      ['node-votes-ws-listener']
    ),
    client.query(
      `select start_height, last_scanned_height, end_height, start_time, end_time, complete, updated_at, stats_json
       from node_vote_sync_state
       where sync_key = $1
       limit 1`,
      [NODE_VOTES_SYNC_KEY]
    )
  ]);

  const backfill = backfillResult.rows[0] || null;
  const ws = wsResult.rows[0] || null;
  const sync = syncResult.rows[0] || null;
  const wsAgeSeconds = ws?.finished_at
    ? Math.max(0, Math.floor((Date.now() - Date.parse(toIsoString(ws.finished_at))) / 1000))
    : -1;
  const wsStale = wsAgeSeconds > LISTENER_STALE_SECONDS;
  const wsStats = ws?.stats_json || {};

  return {
    backfill: backfill ? {
      started_at: toIsoString(backfill.started_at),
      finished_at: toIsoString(backfill.finished_at),
      status: backfill.status || 'unknown',
      error: backfill.error || '',
      stats: backfill.stats_json || {}
    } : null,
    ws_listener: ws ? {
      started_at: toIsoString(ws.started_at),
      last_heartbeat: toIsoString(ws.finished_at),
      status: wsStale ? 'stale' : (ws.status || 'unknown'),
      error: ws.error || '',
      stats: wsStale
        ? { ...wsStats, stream_status: 'stale' }
        : wsStats,
      age_seconds: wsAgeSeconds
    } : null,
    sync: sync ? {
      start_height: Number(sync.start_height) || 0,
      last_scanned_height: Number(sync.last_scanned_height) || 0,
      end_height: Number(sync.end_height) || 0,
      start_time: toIsoString(sync.start_time),
      end_time: toIsoString(sync.end_time),
      complete: Boolean(sync.complete),
      updated_at: toIsoString(sync.updated_at),
      stats: sync.stats_json || {}
    } : null
  };
}

function isEnabled(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function deriveChainStateFromRows(rows) {
  const latestByNode = new Map();
  for (const row of sortRowsAsc(rows)) latestByNode.set(row.node_address, row);
  const activeNodes = [...latestByNode.values()]
    .filter((row) => row.node_status === 'Active')
    .map((row) => ({
      node_address: row.node_address,
      operator_address: row.operator_address || row.node_address
    }))
    .sort((left, right) => left.operator_address.localeCompare(right.operator_address));
  return {
    currentMimirValues: {},
    currentMimirValuesAvailable: false,
    currentConstants: {},
    currentConstantsAvailable: false,
    mimirUpdatedAt: null,
    constantsUpdatedAt: null,
    currentNodeMimirsByKey: {},
    currentNodeMimirsAvailable: false,
    currentUpgradeVotesByKey: {},
    currentUpgradeProposalsByKey: {},
    currentUpgradeVotesAvailable: false,
    upgradeProposals: [],
    activeNodeCount: activeNodes.length,
    activeNodes,
    source: 'stored-node-vote-metadata'
  };
}

function compactVoteGroup(group) {
  const { node_votes, vote_history, effective_history, ...summary } = group;
  return {
    ...summary,
    effective_history: Array.isArray(effective_history) ? effective_history.slice(0, 20) : [],
    detail: {
      node_vote_count: Array.isArray(node_votes) ? node_votes.length : 0,
      event_count: Array.isArray(vote_history) ? vote_history.length : 0,
      effective_change_count: Array.isArray(effective_history) ? effective_history.length : 0
    }
  };
}

function compactNodeGroup(group) {
  const { vote_history, ...summary } = group;
  return {
    ...summary,
    detail: {
      event_count: Array.isArray(vote_history) ? vote_history.length : 0
    }
  };
}

async function loadNodeVoteRows(client, since) {
  const result = await client.query(
    `select event_key, tx_id, height, block_time, event_index, node_address,
            node_operator_address, node_status, mimir_key, vote_value,
            vote_value_numeric, source, observed_at
     from node_votes
     where block_time is null or block_time >= $1
     order by block_time desc nulls last, height desc, tx_id desc, event_index desc
     limit $2`,
    [since, MAX_ROWS]
  );
  return result.rows.map(normalizeVoteRow);
}

async function buildNodeVotesPayload(client, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const days = Math.min(366, Math.max(1, Number(options.days) || DEFAULT_DAYS));
  const backend = await loadBackendState(client);
  const since = options.since || backend.sync?.start_time || subtractMonths(now, 6).toISOString();
  const rows = await loadNodeVoteRows(client, since);
  let chainState = options.chainState || null;
  if (!chainState && options.allowProvider === true) {
    chainState = await loadCurrentNodeVoteChainState();
    chainState.source = 'thornode';
  }
  chainState ||= deriveChainStateFromRows(rows);

  const latestRows = latestVoteStances(rows);
  const operationalVotesMin = parseOperationalVotesMin(chainState.currentMimirValues);
  const byVote = buildVoteGroups(
    rows,
    latestRows,
    chainState.currentMimirValues || {},
    Number(chainState.activeNodeCount) || 0,
    operationalVotesMin,
    chainState.currentNodeMimirsByKey || {},
    {
      currentNodeMimirsAvailable: Boolean(chainState.currentNodeMimirsAvailable),
      currentUpgradeVotesAvailable: Boolean(chainState.currentUpgradeVotesAvailable),
      currentUpgradeVotesByKey: chainState.currentUpgradeVotesByKey || {},
      currentUpgradeProposalsByKey: chainState.currentUpgradeProposalsByKey || {},
      activeNodeAddresses: (chainState.activeNodes || []).map((node) => node.node_address)
    }
  );
  const currentUpgradeStances = chainState.currentUpgradeVotesAvailable
    ? Object.values(chainState.currentUpgradeVotesByKey || {}).flat().filter((row) => row.is_active)
    : latestRows.filter((row) => voteKindForKey(row.mimir_key) === 'upgrade');
  const byNodeLatestRows = [
    ...latestRows.filter((row) => voteKindForKey(row.mimir_key) !== 'upgrade'),
    ...currentUpgradeStances
  ];
  const byNode = buildNodeGroups(rows, byNodeLatestRows);
  return {
    payload: {
      schema_version: 3,
      as_of: now.toISOString(),
      window: {
        days,
        since,
        returned_rows: rows.length,
        truncated: rows.length >= MAX_ROWS
      },
      stats: buildStats(
        rows,
        latestRows,
        byVote,
        byNode,
        Number(chainState.activeNodeCount) || 0,
        operationalVotesMin
      ),
      active_nodes: chainState.activeNodes || [],
      upgrade_proposals: chainState.upgradeProposals
        || Object.values(chainState.currentUpgradeProposalsByKey || {}),
      network_values: {
        mimirs: chainState.currentMimirValues || {},
        constants: chainState.currentConstants || {},
        mimirs_complete: Boolean(chainState.currentMimirValuesAvailable),
        constants_complete: Boolean(chainState.currentConstantsAvailable),
        mimirs_updated_at: chainState.mimirUpdatedAt || null,
        constants_updated_at: chainState.constantsUpdatedAt || null
      },
      by_vote: options.compact === false ? byVote : byVote.map(compactVoteGroup),
      by_node: options.compact === false ? byNode : byNode.map(compactNodeGroup),
      latest_events: rows.slice(0, options.compact === false ? 50 : 20),
      backend,
      chain_state: {
        source: chainState.source || 'unknown',
        complete: Boolean(chainState.currentNodeMimirsAvailable),
        upgrade_proposals_complete: Boolean(chainState.currentUpgradeVotesAvailable),
        current_mimir_values: chainState.currentMimirValues || {},
        active_node_count: Number(chainState.activeNodeCount) || 0
      }
    },
    sourceUpdatedAt: rows[0]?.observed_at || rows[0]?.block_time || backend.sync?.updated_at || null,
    generatedAt: now.toISOString(),
    stats: {
      events: rows.length,
      vote_keys: byVote.length,
      nodes: byNode.length,
      chain_state_source: chainState.source || 'unknown'
    }
  };
}

export async function buildNodeVotesSummaryPayload(client = { query }, options = {}) {
  return buildNodeVotesPayload(client, { ...options, compact: true });
}

export async function buildNodeVotesLegacyPayload(client = { query }, options = {}) {
  return buildNodeVotesPayload(client, {
    ...options,
    compact: false,
    allowProvider: options.allowProvider !== false
  });
}

function encodeNodeVoteCursor(row) {
  if (!row?.event_key) return '';
  return Buffer.from(JSON.stringify({
    time: toIsoString(row.block_time) || '1970-01-01T00:00:00.000Z',
    height: Number(row.height) || 0,
    key: String(row.event_key)
  })).toString('base64url');
}

function decodeNodeVoteCursor(value) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const time = toIsoString(cursor?.time);
    const height = Number(cursor?.height);
    const key = String(cursor?.key || '');
    if (!time || !Number.isFinite(height) || !key) return null;
    return { time, height: Math.max(0, Math.trunc(height)), key };
  } catch {
    return null;
  }
}

async function loadNodeVoteDetailPage({ column, value, cursor, limit }) {
  const decoded = decodeNodeVoteCursor(cursor);
  if (cursor && !decoded) {
    const error = new Error('Invalid node-vote cursor');
    error.status = 400;
    throw error;
  }
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const params = [value];
  let cursorSql = '';
  if (decoded) {
    params.push(decoded.time, decoded.height, decoded.key);
    cursorSql = `and (coalesce(block_time, 'epoch'::timestamptz), height, event_key)
      < ($2::timestamptz, $3::bigint, $4::text)`;
  }
  params.push(safeLimit + 1);
  const result = await query(
    `select event_key, tx_id, height, block_time, event_index, node_address,
            node_operator_address, node_status, mimir_key, vote_value,
            vote_value_numeric, source, observed_at
     from node_votes
     where ${column} = $1
       ${cursorSql}
     order by coalesce(block_time, 'epoch'::timestamptz) desc, height desc, event_key desc
     limit $${params.length}`,
    params
  );
  const hasNext = result.rows.length > safeLimit;
  const pageRows = result.rows.slice(0, safeLimit);
  return {
    events: pageRows.map(normalizeVoteRow),
    pagination: {
      limit: safeLimit,
      returned: pageRows.length,
      has_next: hasNext,
      next_cursor: hasNext ? encodeNodeVoteCursor(pageRows.at(-1)) : ''
    }
  };
}

export async function handleNodeVoteDetails(_request, url) {
  const key = normalizeMimirKey(url.searchParams.get('key') || url.searchParams.get('mimir_key'));
  if (!key || key.length > 180) return json({ error: 'Valid Mimir key is required' }, 400);
  const cursor = url.searchParams.get('cursor') || '';
  if (cursor && !decodeNodeVoteCursor(cursor)) return json({ error: 'Invalid node-vote cursor' }, 400);
  const model = await getReadModel(NODE_VOTES_READ_MODEL_KEY);
  const [page, stancesResult] = await Promise.all([
    loadNodeVoteDetailPage({
      column: 'mimir_key',
      value: key,
      cursor,
      limit: parseIntegerParam(url.searchParams.get('limit'), 50, { min: 1, max: 200 })
    }),
    query(
      `with ranked as (
         select event_key, tx_id, height, block_time, event_index, node_address,
                node_operator_address, node_status, mimir_key, vote_value,
                vote_value_numeric, source, observed_at,
                count(*) over (partition by node_address) as event_count,
                row_number() over (
                  partition by node_address
                  order by coalesce(block_time, 'epoch'::timestamptz) desc, height desc, event_key desc
                ) as stance_rank
         from node_votes
         where mimir_key = $1
       )
       select * from ranked where stance_rank = 1
       order by coalesce(block_time, 'epoch'::timestamptz) desc, height desc
       limit 200`,
      [key]
    )
  ]);
  const summary = model?.payload?.by_vote?.find((row) => row.mimir_key === key) || null;
  const nodeVotes = stancesResult.rows.map((row) => {
    const normalized = normalizeVoteRow(row);
    return {
      node_address: normalized.node_address,
      operator_address: normalized.operator_address,
      node_status: normalized.node_status,
      vote_value: isVoteRemoval(normalized) ? null : normalized.vote_value,
      latest_action_value: normalized.vote_value,
      vote_removed: isVoteRemoval(normalized),
      event_count: Number(row.event_count) || 0,
      block_time: normalized.block_time,
      height: normalized.height,
      tx_id: normalized.tx_id
    };
  });
  return json({
    schema_version: 3,
    mimir_key: key,
    summary,
    ...page,
    node_votes: nodeVotes,
    vote_history: voteEventHistoryRows(page.events),
    effective_history: summary?.effective_history || []
  }, 200, { 'Cache-Control': 'public, max-age=30' });
}

export async function handleNodeVoteNodeDetails(_request, url) {
  const address = String(url.searchParams.get('address') || url.searchParams.get('node_address') || '').trim();
  if (!/^thor[a-z0-9]{20,80}$/i.test(address)) {
    return json({ error: 'Valid node address is required' }, 400);
  }
  const cursor = url.searchParams.get('cursor') || '';
  if (cursor && !decodeNodeVoteCursor(cursor)) return json({ error: 'Invalid node-vote cursor' }, 400);
  const model = await getReadModel(NODE_VOTES_READ_MODEL_KEY);
  const page = await loadNodeVoteDetailPage({
    column: 'node_address',
    value: address,
    cursor,
    limit: parseIntegerParam(url.searchParams.get('limit'), 50, { min: 1, max: 200 })
  });
  return json({
    schema_version: 3,
    node_address: address,
    summary: model?.payload?.by_node?.find((row) => row.node_address === address) || null,
    ...page,
    vote_history: voteEventHistoryRows(page.events)
  }, 200, { 'Cache-Control': 'public, max-age=30' });
}

export async function handleNodeVotesSummary(request, _url) {
  const model = await getReadModel(NODE_VOTES_READ_MODEL_KEY);
  if (!model) {
    return json({
      error: 'Node votes snapshot is warming',
      retryable: true,
      model_key: NODE_VOTES_READ_MODEL_KEY
    }, 503, { 'Cache-Control': 'no-store', 'Retry-After': '30' });
  }
  const headers = {
    'Cache-Control': 'public, max-age=30',
    ...(!model.stale ? { ETag: model.etag } : {}),
    'X-Boone-Cache': model.stale ? 'read-model-stale' : 'read-model',
    'X-Boone-Age': String(model.ageSeconds ?? 0)
  };
  if (!model.stale && String(request?.headers?.['if-none-match'] || '') === model.etag) {
    return json({}, 304, headers);
  }
  return json(model.stale ? {
    ...model.payload,
    stale: true,
    warning: model.payload?.warning || 'Serving the last successful node-votes snapshot'
  } : model.payload, 200, headers);
}

export async function handleNodeVotes(request, url) {
  const view = String(url.searchParams.get('view') || '').toLowerCase();
  if (view === 'vote') return handleNodeVoteDetails(request, url);
  if (view === 'node') return handleNodeVoteNodeDetails(request, url);
  if (isEnabled(url.searchParams.get('compact'))) {
    return handleNodeVotesSummary(request, url);
  }

  // Preserve the established endpoint for already-open hashed frontend
  // bundles while the new UI moves to the additive compact summary route.
  const days = parseIntegerParam(url.searchParams.get('days'), DEFAULT_DAYS, { min: 1, max: 366 });
  const chainStateModel = await getReadModel(ANALYTICS_READ_MODEL_KEYS.nodeVotesChainState);
  if (!chainStateModel) {
    return json({
      error: 'Node-vote compatibility snapshot is warming',
      retryable: true,
      model_key: ANALYTICS_READ_MODEL_KEYS.nodeVotesChainState
    }, 503, { 'Cache-Control': 'no-store', 'Retry-After': '30' });
  }
  const result = await buildNodeVotesLegacyPayload(undefined, {
    days,
    since: url.searchParams.has('days')
      ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
      : undefined,
    chainState: chainStateModel.payload,
    allowProvider: false
  });
  return json(result.payload, 200, { 'Cache-Control': 'private, no-store' });
}
