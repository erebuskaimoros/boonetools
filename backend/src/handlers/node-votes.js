import { query } from '../db/pool.js';
import { json, parseIntegerParam } from '../lib/http.js';
import { toIsoString } from '../lib/utils.js';
import { fetchNodes, fetchThorchain } from '../shared/thornode.js';
import { NODE_VOTES_SYNC_KEY } from '../shared/node-votes.js';

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

function isAssetSlipMinBpsMimirKey(normalized) {
  return ASSET_SLIP_MIN_BPS_PREFIXES.some((prefix) => (
    normalized.startsWith(prefix) && normalized.length > prefix.length
  ));
}

export function classifyMimirKey(key) {
  const normalized = normalizeMimirKey(key);
  if (OPERATIONAL_EXACT_KEYS.has(normalized)) return 'operational';
  if (ECONOMIC_EXACT_KEYS.has(normalized)) return 'economic';
  if (OPERATIONAL_PREFIX_KEYS.some((prefix) => normalized.startsWith(prefix))) return 'operational';
  if (OPERATIONAL_PARTIAL_KEYS.some((match) => normalized.includes(match))) return 'operational';
  if (normalized.endsWith('SLIPMINBPS') || isAssetSlipMinBpsMimirKey(normalized)) return 'operational';
  return 'economic';
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
    mimir_category: classifyMimirKey(mimirKey),
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
        nodes: [...new Set(valueRows.map((row) => row.node_address))].slice(0, 12),
        operators: [...new Set(valueRows.map((row) => row.operator_address))].slice(0, 12)
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
      mimir_category: row.mimir_category || classifyMimirKey(row.mimir_key),
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

function effectiveValueFromVotes(votes, currentValue, activeNodeCount, threshold) {
  const breakdown = buildValueBreakdown(votes, currentValue, activeNodeCount, threshold);
  const leader = breakdown[0] || null;
  const leaderTied = Boolean(
    leader &&
    breakdown[1] &&
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
      threshold
    );

    if (effective.value === null || String(effective.value) === String(lastEffectiveValue)) {
      continue;
    }

    lastEffectiveValue = String(effective.value);
    changes.push({
      effective_value: effective.value,
      mimir_category: category,
      consensus_model: category === 'operational' ? 'operational-min' : 'economic-supermajority',
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

function currentConsensusRows({ historicalStances, currentNodeMimirs, currentNodeMimirsAvailable }) {
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

  return [...historicalByKey.entries()]
    .map(([mimirKey, historicalRows]) => {
      const category = classifyMimirKey(mimirKey);
      const threshold = category === 'operational' ? operationalVotesMin : economicThreshold;
      const stances = latestByKey.get(mimirKey) || [];
      const currentNodeMimirs = currentNodeMimirsByKey[mimirKey] || [];
      const consensusRows = currentConsensusRows({
        historicalStances: stances,
        currentNodeMimirs,
        currentNodeMimirsAvailable
      });
      const effectiveHistoryRows = economicHistoryRows({
        category,
        historicalRows,
        currentRows: consensusRows,
        currentNodeMimirsAvailable
      });
      const valueBreakdown = buildValueBreakdown(
        consensusRows,
        currentMimirValues[mimirKey],
        activeNodeCount,
        threshold
      );
      const leader = valueBreakdown[0] || null;
      const leaderTied = Boolean(
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
        currentValue: currentMimirValues[mimirKey]
      });
      const currentValueChange = buildCurrentValueChange(historicalRows, {
        category,
        threshold,
        activeNodeCount,
        currentValue: currentMimirValues[mimirKey],
        currentNodeMimirs
      });
      const effectiveHistory = mergeEffectiveHistory(rawEffectiveHistory, currentValueChange);
      const currentVoteSource = currentNodeMimirsAvailable
        ? 'thornode-active-node-mimir'
        : 'stored-latest-stance';

      return {
        mimir_key: mimirKey,
        mimir_category: category,
        consensus_model: category === 'operational' ? 'operational-min' : 'economic-supermajority',
        consensus_threshold: threshold,
        current_value: currentMimirValues[mimirKey] ?? null,
        historical_vote_events: historicalRows.length,
        latest_stance_count: consensusRows.length,
        stored_latest_stance_count: stances.length,
        current_vote_source: currentVoteSource,
        repeated_vote_events: Math.max(0, historicalRows.length - uniqueNodeKeyPairs),
        value_change_events: countValueChanges(historicalRows),
        recent_7d_votes: recentVotes,
        unique_nodes: uniqueCount(historicalRows, 'node_address'),
        unique_operators: uniqueCount(historicalRows, 'operator_address'),
        first_vote_at: firstVoteTime(historicalRows),
        passed_at: category === 'economic' ? firstPassedTime(effectiveHistory) : null,
        current_value_changed_at: toIsoString(currentValueChange?.block_time),
        latest_vote_at: toIsoString(latestVote?.block_time),
        latest_height: latestVote?.height || 0,
        leader_value: leader?.value || '',
        leader_count: leader?.count || 0,
        leader_percent: leader?.percent || 0,
        leader_tied: leaderTied,
        votes_to_consensus: leader ? Math.max(0, threshold - leader.count) : threshold,
        consensus_ready: Boolean(leader && !leaderTied && threshold > 0 && leader.count >= threshold),
        node_votes: currentNodeVoteRows(historicalRows),
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
  const categoryCounts = { operational: 0, economic: 0 };
  const categoryKeys = { operational: new Set(), economic: new Set() };

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
      economic: categoryKeys.economic.size
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
    if (!latestByNode.has(row.node_address)) {
      latestByNode.set(row.node_address, []);
    }
    latestByNode.get(row.node_address).push(row);
  }

  return [...historicalByNode.entries()]
    .map(([nodeAddress, historicalRows]) => {
      const stances = latestByNode.get(nodeAddress) || [];
      const latestVote = historicalRows.reduce((best, row) => (
        rowTimeMs(row) > rowTimeMs(best || {}) ? row : best
      ), null);
      const uniqueNodeKeyPairs = new Set(historicalRows.map((row) => `${row.node_address}:${row.mimir_key}`)).size;
      const latestMetadata = latestVote || historicalRows[0] || {};
      const categories = categoryCountsForRows(historicalRows);
      const nodeEconomicKeys = new Set(
        historicalRows
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
        unique_keys: uniqueCount(historicalRows, 'mimir_key'),
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
    unique_vote_keys: uniqueCount(rows, 'mimir_key'),
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

async function loadCurrentChainState() {
  const [mimirResult, nodesResult, nodeMimirResult] = await Promise.allSettled([
    fetchThorchain('/thorchain/mimir'),
    fetchNodes(),
    fetchThorchain('/thorchain/mimir/nodes_all')
  ]);

  const currentMimirValues = mimirResult.status === 'fulfilled' && mimirResult.value
    ? normalizeMimirValues(mimirResult.value)
    : {};
  const nodes = nodesResult.status === 'fulfilled' && Array.isArray(nodesResult.value)
    ? nodesResult.value
    : [];
  const activeNodeCount = nodes.filter((node) => node?.status === 'Active').length;
  const nodeMetadataByAddress = buildNodeMetadataByAddress(nodes);
  const currentNodeMimirsAvailable = (
    nodeMimirResult.status === 'fulfilled' &&
    nodesResult.status === 'fulfilled'
  );

  return {
    currentMimirValues,
    currentNodeMimirsByKey: nodeMimirResult.status === 'fulfilled' && nodeMimirResult.value
      ? normalizeNodeMimirValues(nodeMimirResult.value, nodeMetadataByAddress)
      : {},
    currentNodeMimirsAvailable,
    activeNodeCount
  };
}

async function loadBackendState() {
  const [backfillResult, wsResult, syncResult] = await Promise.all([
    query(
      `select started_at, finished_at, status, error, stats_json
       from node_vote_job_runs
       where job_name = $1
       order by started_at desc
       limit 1`,
      ['node-votes-backfill']
    ),
    query(
      `select started_at, finished_at, status, error, stats_json
       from node_vote_job_runs
       where job_name = $1
       order by started_at desc
       limit 1`,
      ['node-votes-ws-listener']
    ),
    query(
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

export async function handleNodeVotes(_request, url) {
  const explicitDays = url.searchParams.has('days');
  const days = parseIntegerParam(url.searchParams.get('days'), DEFAULT_DAYS, {
    min: 1,
    max: 366
  });
  const backend = await loadBackendState();
  const since = explicitDays
    ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    : (
        backend.sync?.start_time ||
        subtractMonths(new Date(), 6).toISOString()
      );

  const [rowsResult, chainState] = await Promise.all([
    query(
      `select event_key, tx_id, height, block_time, event_index, node_address,
              node_operator_address, node_status, mimir_key, vote_value,
              vote_value_numeric, source, observed_at
       from node_votes
       where block_time is null or block_time >= $1
       order by block_time desc nulls last, height desc, tx_id desc, event_index desc
       limit $2`,
      [since, MAX_ROWS]
    ),
    loadCurrentChainState()
  ]);

  const rows = rowsResult.rows.map(normalizeVoteRow);
  const latestRows = latestVoteStances(rows);
  const operationalVotesMin = parseOperationalVotesMin(chainState.currentMimirValues);
  const byVote = buildVoteGroups(
    rows,
    latestRows,
    chainState.currentMimirValues,
    chainState.activeNodeCount,
    operationalVotesMin,
    chainState.currentNodeMimirsByKey,
    {
      currentNodeMimirsAvailable: chainState.currentNodeMimirsAvailable
    }
  );
  const byNode = buildNodeGroups(rows, latestRows);

  return json(
    {
      as_of: new Date().toISOString(),
      window: {
        days: explicitDays ? days : null,
        since,
        returned_rows: rows.length,
        truncated: rows.length >= MAX_ROWS
      },
      stats: buildStats(rows, latestRows, byVote, byNode, chainState.activeNodeCount, operationalVotesMin),
      by_vote: byVote,
      by_node: byNode,
      latest_events: rows.slice(0, 50),
      backend
    },
    200,
    {
      'Cache-Control': 'public, max-age=30'
    }
  );
}
