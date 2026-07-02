export const MAX_DYNAMIC_FEE_HISTORY = 30;

export const DYNAMIC_FEE_DEFAULTS = Object.freeze({
  ADR26: 0,
  L1DynamicFeeEnabled: 0,
  L1DynamicFeeEpochBlocks: 14400,
  L1DynamicFeeFloorBPS: 1,
  L1DynamicFeeCeilingBPS: 20,
  L1DynamicFeeStepBPS: 1,
  L1DynamicFeeDeadbandBPS: 1000,
  L1DynamicFeeWindowEpochs: 3,
  L1SlipMinBps: 0
});

const WHITELIST_PREFIX = 'DYNAMICFEE-WHITELIST-';

export function parseNumeric(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function torToUsd(value) {
  return parseNumeric(value) / 1e8;
}

function getMimirRaw(mimir, key) {
  if (!mimir || typeof mimir !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(mimir, key)) return mimir[key];

  const target = key.toUpperCase();
  const found = Object.keys(mimir).find((candidate) => candidate.toUpperCase() === target);
  return found ? mimir[found] : undefined;
}

export function getMimirNumber(mimir, key, fallback = 0) {
  const raw = getMimirRaw(mimir, key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  return parseNumeric(raw, fallback);
}

export function getBlockHeight(lastblock) {
  if (Array.isArray(lastblock)) {
    const thor = lastblock.find((entry) => entry?.thorchain !== undefined);
    if (thor) return parseNumeric(thor.thorchain);
    const firstHeight = lastblock.find((entry) => entry?.last_observed_in !== undefined);
    return parseNumeric(firstHeight?.last_observed_in);
  }

  return parseNumeric(
    lastblock?.thorchain ??
      lastblock?.height ??
      lastblock?.block_height ??
      lastblock?.result?.block?.header?.height
  );
}

export function whitelistStateLabel(state) {
  if (state === 1) return 'active';
  if (state === 2) return 'monitor';
  if (state === 0) return 'off';
  if (state < 0) return 'absent';
  return `state ${state}`;
}

export function whitelistStateKind(state) {
  if (state === 1) return 'active';
  if (state === 2) return 'monitor';
  return 'inactive';
}

export function formatAssetDisplayName(asset) {
  return String(asset || '').replace(/-(?:0x[a-f0-9]{40}|[a-z0-9]{24,})$/i, '');
}

export function formatPairDisplayName(pair) {
  return String(pair || '')
    .split('|')
    .map((asset) => formatAssetDisplayName(asset))
    .join(' / ');
}

export function computeEpochTiming({
  epochBlocks = DYNAMIC_FEE_DEFAULTS.L1DynamicFeeEpochBlocks,
  blockHeight = 0,
  currentEpoch = null
} = {}) {
  const normalizedEpochBlocks = parseNumeric(
    epochBlocks,
    DYNAMIC_FEE_DEFAULTS.L1DynamicFeeEpochBlocks
  );
  const normalizedBlockHeight = parseNumeric(blockHeight, 0);
  const derivedEpoch = normalizedEpochBlocks > 0 && normalizedBlockHeight > 0
    ? Math.floor(normalizedBlockHeight / normalizedEpochBlocks)
    : 0;
  const mod = normalizedEpochBlocks > 0 && normalizedBlockHeight > 0
    ? normalizedBlockHeight % normalizedEpochBlocks
    : 0;

  return {
    blockHeight: normalizedBlockHeight,
    currentEpoch: parseNumeric(currentEpoch, derivedEpoch),
    blocksUntilSeal: normalizedEpochBlocks > 0 && normalizedBlockHeight > 0
      ? (mod === 0 ? 0 : normalizedEpochBlocks - mod)
      : null,
    epochProgress: normalizedEpochBlocks > 0 && normalizedBlockHeight > 0
      ? (mod === 0 ? 1 : mod / normalizedEpochBlocks)
      : 0
  };
}

export function extractDynamicConfig({ mimir = {}, currentResponse = {}, lastblock = [] } = {}) {
  const epochBlocks = getMimirNumber(
    mimir,
    'L1DynamicFeeEpochBlocks',
    DYNAMIC_FEE_DEFAULTS.L1DynamicFeeEpochBlocks
  );
  const blockHeight = getBlockHeight(lastblock);
  const epochTiming = computeEpochTiming({
    epochBlocks,
    blockHeight,
    currentEpoch: currentResponse?.epoch
  });

  const whitelists = Object.entries(mimir || {})
    .filter(([key]) => key.toUpperCase().startsWith(WHITELIST_PREFIX))
    .map(([key, rawValue]) => {
      const thorname = key.slice(WHITELIST_PREFIX.length);
      const state = parseNumeric(rawValue, 0);
      return {
        key,
        thorname,
        state,
        label: whitelistStateLabel(state),
        kind: whitelistStateKind(state)
      };
    })
    .sort((a, b) => {
      const stateRank = { active: 0, monitor: 1, inactive: 2 };
      return stateRank[a.kind] - stateRank[b.kind] || a.thorname.localeCompare(b.thorname);
    });

  return {
    adr26: getMimirNumber(mimir, 'ADR26', DYNAMIC_FEE_DEFAULTS.ADR26),
    enabled: getMimirNumber(
      mimir,
      'L1DynamicFeeEnabled',
      DYNAMIC_FEE_DEFAULTS.L1DynamicFeeEnabled
    ),
    epochBlocks,
    floorBps: getMimirNumber(mimir, 'L1DynamicFeeFloorBPS', DYNAMIC_FEE_DEFAULTS.L1DynamicFeeFloorBPS),
    ceilingBps: getMimirNumber(
      mimir,
      'L1DynamicFeeCeilingBPS',
      DYNAMIC_FEE_DEFAULTS.L1DynamicFeeCeilingBPS
    ),
    stepBps: getMimirNumber(mimir, 'L1DynamicFeeStepBPS', DYNAMIC_FEE_DEFAULTS.L1DynamicFeeStepBPS),
    deadbandBps: getMimirNumber(
      mimir,
      'L1DynamicFeeDeadbandBPS',
      DYNAMIC_FEE_DEFAULTS.L1DynamicFeeDeadbandBPS
    ),
    windowEpochs: clampWindowEpochs(
      getMimirNumber(mimir, 'L1DynamicFeeWindowEpochs', DYNAMIC_FEE_DEFAULTS.L1DynamicFeeWindowEpochs)
    ),
    l1SlipMinBps: getMimirNumber(mimir, 'L1SlipMinBps', DYNAMIC_FEE_DEFAULTS.L1SlipMinBps),
    ...epochTiming,
    whitelists,
    activeWhitelistCount: whitelists.filter((entry) => entry.state === 1).length,
    monitorWhitelistCount: whitelists.filter((entry) => entry.state === 2).length
  };
}

export function normalizeHistory(history = []) {
  return history.map((entry) => ({
    epoch: parseNumeric(entry.epoch),
    volumeTor: String(entry.volume_tor ?? entry.volumeTor ?? '0'),
    feesTor: String(entry.fees_tor ?? entry.feesTor ?? '0'),
    volumeUsd: torToUsd(entry.volume_tor ?? entry.volumeTor),
    feesUsd: torToUsd(entry.fees_tor ?? entry.feesTor),
    bpsAtClose: parseNumeric(entry.bps_at_close ?? entry.bpsAtClose)
  }));
}

export function inferDynamicFeeDecision(history = [], currentDynamicBps = 0, config = {}) {
  const normalized = normalizeHistory(history);
  if (normalized.length === 0) {
    return {
      reason: 'no_history',
      oldBps: currentDynamicBps,
      newBps: currentDynamicBps,
      expectedNewBps: currentDynamicBps,
      movement: 0,
      feesBefore: 0,
      feesAfter: 0,
      deltaPctBps: 0
    };
  }

  const latest = normalized[normalized.length - 1];
  const oldBps = latest.bpsAtClose;
  const decision = decideNextBps(normalized, oldBps, config);
  const movement = currentDynamicBps - oldBps;

  return {
    ...decision,
    oldBps,
    newBps: currentDynamicBps,
    movement,
    movementLabel: movement > 0 ? 'up' : movement < 0 ? 'down' : 'hold',
    matchesExpected: decision.expectedNewBps === currentDynamicBps
  };
}

export function buildEpochChartSeries(record = {}, currentEpoch = 0) {
  const history = Array.isArray(record.history) ? record.history : [];
  const liveEpoch = parseNumeric(currentEpoch);
  const hasLive = (Number(record.currentFeesUsd) || 0) > 0 || (Number(record.currentVolumeUsd) || 0) > 0;
  const displayHistory = hasLive && liveEpoch
    ? history.filter((row) => parseNumeric(row.epoch) !== liveEpoch)
    : history;

  const labels = displayHistory.map((row) => `E${row.epoch}`);
  const fees = displayHistory.map((row) => row.feesUsd);
  const bps = displayHistory.map((row) => row.bpsAtClose);

  if (hasLive) {
    labels.push(liveEpoch ? `E${liveEpoch} live` : 'live');
    fees.push(Number(record.currentFeesUsd) || 0);
    bps.push(Number(record.dynamicBps) || 0);
  }

  return {
    labels,
    fees,
    bps,
    mergedLiveEpoch: hasLive && displayHistory.length !== history.length
  };
}

export function buildAffiliateChartSeries(config = {}, records = [], currentOnlyEntries = []) {
  const currentEpoch = parseNumeric(config.currentEpoch);
  const epochMap = new Map();

  function addPoint(epoch, volumeUsd, feesUsd, live = false) {
    const normalizedEpoch = parseNumeric(epoch);
    const key = normalizedEpoch || (live ? 'live' : 'unknown');
    if (!epochMap.has(key)) {
      epochMap.set(key, {
        epoch: normalizedEpoch,
        label: normalizedEpoch ? `E${normalizedEpoch}` : 'live',
        volumeUsd: 0,
        feesUsd: 0,
        live: false
      });
    }

    const point = epochMap.get(key);
    point.volumeUsd += Number(volumeUsd) || 0;
    point.feesUsd += Number(feesUsd) || 0;
    point.live = point.live || live;
  }

  records.forEach((record) => {
    const liveVolumeUsd = Number(record.currentVolumeUsd) || 0;
    const liveFeesUsd = Number(record.currentFeesUsd) || 0;
    const hasLive = liveVolumeUsd > 0 || liveFeesUsd > 0;
    const history = Array.isArray(record.history) ? record.history : [];
    const displayHistory = hasLive && currentEpoch
      ? history.filter((row) => parseNumeric(row.epoch) !== currentEpoch)
      : history;

    displayHistory.forEach((row) => {
      addPoint(row.epoch, row.volumeUsd, row.feesUsd);
    });

    if (hasLive) {
      addPoint(currentEpoch, liveVolumeUsd, liveFeesUsd, true);
    }
  });

  currentOnlyEntries.forEach((entry) => {
    addPoint(entry.epoch || currentEpoch, entry.volumeUsd, entry.feesUsd, true);
  });

  const points = Array.from(epochMap.values())
    .map((point) => ({
      ...point,
      label: point.live && point.epoch ? `E${point.epoch} live` : point.label,
      rateBps: point.volumeUsd > 0 ? (point.feesUsd / point.volumeUsd) * 10000 : null
    }))
    .sort((a, b) => {
      if (!a.epoch && !b.epoch) return a.label.localeCompare(b.label);
      if (!a.epoch) return 1;
      if (!b.epoch) return -1;
      return a.epoch - b.epoch;
    });

  return {
    labels: points.map((point) => point.label),
    volume: points.map((point) => point.volumeUsd),
    fees: points.map((point) => point.feesUsd),
    rateBps: points.map((point) => point.rateBps),
    points,
    hasLive: points.some((point) => point.live)
  };
}

export function midgardUsdCentsToUsd(value) {
  return parseNumeric(value) / 100;
}

function findAffiliateIntervalItem(row, thorname) {
  const target = String(thorname || '').toLowerCase();
  if (!target || !Array.isArray(row?.affiliates)) return null;
  return row.affiliates.find((entry) => String(entry?.affiliate || '').toLowerCase() === target) || null;
}

function formatUnixDayLabel(startTime) {
  const timestamp = parseNumeric(startTime);
  if (!timestamp) return '--';
  return new Date(timestamp * 1000).toISOString().slice(5, 10);
}

export function buildAffiliateMidgardSeries(statsRows = [], earningsRows = [], thorname = '') {
  const rows = new Map();

  function ensureRow(row) {
    const startTime = String(row?.startTime ?? '');
    const endTime = String(row?.endTime ?? '');
    const key = startTime || endTime;
    if (!key) return null;

    if (!rows.has(key)) {
      rows.set(key, {
        key,
        startTime,
        endTime,
        label: formatUnixDayLabel(startTime),
        volumeUsd: 0,
        feesUsd: 0,
        count: 0
      });
    }

    return rows.get(key);
  }

  for (const row of Array.isArray(statsRows) ? statsRows : []) {
    const point = ensureRow(row);
    if (!point) continue;
    const affiliateItem = findAffiliateIntervalItem(row, thorname);
    point.volumeUsd = midgardUsdCentsToUsd(affiliateItem?.volumeUSD ?? row.totalVolumeUSD ?? row.volumeUSD);
    point.count = parseNumeric(affiliateItem?.count ?? row.count);
  }

  for (const row of Array.isArray(earningsRows) ? earningsRows : []) {
    const point = ensureRow(row);
    if (!point) continue;
    const affiliateItem = findAffiliateIntervalItem(row, thorname);
    point.feesUsd = midgardUsdCentsToUsd(
      affiliateItem?.earningsUSD ?? row.totalEarningsUSD ?? row.earningsUSD
    );
    point.count = Math.max(point.count, parseNumeric(affiliateItem?.count ?? row.count));
  }

  const points = Array.from(rows.values())
    .map((point) => ({
      ...point,
      rateBps: point.volumeUsd > 0 ? (point.feesUsd / point.volumeUsd) * 10000 : null
    }))
    .sort((a, b) => parseNumeric(a.startTime) - parseNumeric(b.startTime));

  const totalVolumeUsd = points.reduce((sum, point) => sum + point.volumeUsd, 0);
  const totalFeesUsd = points.reduce((sum, point) => sum + point.feesUsd, 0);
  const totalCount = points.reduce((sum, point) => sum + point.count, 0);

  return {
    labels: points.map((point) => point.label),
    volume: points.map((point) => point.volumeUsd),
    fees: points.map((point) => point.feesUsd),
    rateBps: points.map((point) => point.rateBps),
    points,
    totalVolumeUsd,
    totalFeesUsd,
    totalRateBps: totalVolumeUsd > 0 ? (totalFeesUsd / totalVolumeUsd) * 10000 : null,
    totalCount
  };
}

export function buildAffiliateRollups(config = {}, records = [], currentEntries = []) {
  const currentEpoch = parseNumeric(config.currentEpoch);
  const recordIds = new Set(records.map((record) => record.id));
  const recordsByThorname = records.reduce((map, record) => {
    const key = String(record.thorname || '').toLowerCase();
    if (!key) return map;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(record);
    return map;
  }, new Map());
  const currentOnlyByThorname = currentEntries.reduce((map, entry) => {
    if (recordIds.has(entry.id)) return map;
    const key = String(entry.thorname || '').toLowerCase();
    if (!key) return map;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
    return map;
  }, new Map());

  const whitelistRows = Array.isArray(config.whitelists) ? config.whitelists : [];
  return whitelistRows.map((whitelist) => {
    const thorname = String(whitelist.thorname || '').trim();
    const affiliateRecords = recordsByThorname.get(thorname.toLowerCase()) || [];
    const currentOnlyEntries = currentOnlyByThorname.get(thorname.toLowerCase()) || [];
    const totals = affiliateRecords.reduce(
      (acc, record) => {
        const liveVolumeUsd = Number(record.currentVolumeUsd) || 0;
        const liveFeesUsd = Number(record.currentFeesUsd) || 0;
        const hasLive = liveVolumeUsd > 0 || liveFeesUsd > 0;
        const history = Array.isArray(record.history) ? record.history : [];
        const dedupedHistory = hasLive && currentEpoch
          ? history.filter((row) => parseNumeric(row.epoch) !== currentEpoch)
          : history;
        const historyVolumeUsd = dedupedHistory.reduce((sum, row) => sum + (Number(row.volumeUsd) || 0), 0);
        const historyFeesUsd = dedupedHistory.reduce((sum, row) => sum + (Number(row.feesUsd) || 0), 0);

        acc.liveVolumeUsd += liveVolumeUsd;
        acc.liveFeesUsd += liveFeesUsd;
        acc.historyVolumeUsd += historyVolumeUsd;
        acc.historyFeesUsd += historyFeesUsd;
        acc.totalVolumeUsd += historyVolumeUsd + liveVolumeUsd;
        acc.totalFeesUsd += historyFeesUsd + liveFeesUsd;
        acc.pairCount += 1;
        if (record.isActive) acc.activePairCount += 1;
        if (record.isMonitor) acc.monitorPairCount += 1;
        if (hasLive) acc.livePairCount += 1;
        if (hasLive && history.length !== dedupedHistory.length) acc.mergedPairCount += 1;
        return acc;
      },
      {
        liveVolumeUsd: 0,
        liveFeesUsd: 0,
        historyVolumeUsd: 0,
        historyFeesUsd: 0,
        totalVolumeUsd: 0,
        totalFeesUsd: 0,
        pairCount: 0,
        activePairCount: 0,
        monitorPairCount: 0,
        livePairCount: 0,
        mergedPairCount: 0
      }
    );
    currentOnlyEntries.forEach((entry) => {
      const liveVolumeUsd = Number(entry.volumeUsd) || 0;
      const liveFeesUsd = Number(entry.feesUsd) || 0;
      totals.liveVolumeUsd += liveVolumeUsd;
      totals.liveFeesUsd += liveFeesUsd;
      totals.totalVolumeUsd += liveVolumeUsd;
      totals.totalFeesUsd += liveFeesUsd;
      totals.pairCount += 1;
      totals.livePairCount += 1;
    });

    return {
      id: thorname.toLowerCase(),
      thorname,
      whitelistState: whitelist.state,
      stateLabel: whitelist.label,
      stateKind: whitelist.kind,
      records: affiliateRecords,
      currentOnlyEntries,
      series: buildAffiliateChartSeries(config, affiliateRecords, currentOnlyEntries),
      ...totals,
      liveRateBps: totals.liveVolumeUsd > 0 ? (totals.liveFeesUsd / totals.liveVolumeUsd) * 10000 : null,
      totalRateBps: totals.totalVolumeUsd > 0 ? (totals.totalFeesUsd / totals.totalVolumeUsd) * 10000 : null
    };
  }).sort((a, b) => (
    b.liveFeesUsd - a.liveFeesUsd ||
    b.totalFeesUsd - a.totalFeesUsd ||
    b.liveVolumeUsd - a.liveVolumeUsd ||
    a.thorname.localeCompare(b.thorname)
  ));
}

export function buildDynamicFeeModel({
  mimir = {},
  recordsResponse = {},
  currentResponse = {},
  detailsByThorname = {},
  lastblock = []
} = {}) {
  const config = extractDynamicConfig({ mimir, currentResponse, lastblock });
  const currentEntriesRaw = Array.isArray(currentResponse?.entries) ? currentResponse.entries : [];
  const currentMap = new Map();

  for (const entry of currentEntriesRaw) {
    const thorname = String(entry.thorname ?? '').trim();
    const pair = String(entry.pair ?? '').trim();
    if (!thorname || !pair) continue;

    const id = recordId(thorname, pair);
    const volumeUsd = torToUsd(entry.volume_tor ?? entry.volumeTor);
    const feesUsd = torToUsd(entry.fees_tor ?? entry.feesTor);
    currentMap.set(id, {
      id,
      thorname,
      pair,
      pairLabel: formatPairDisplayName(pair),
      epoch: parseNumeric(entry.epoch, config.currentEpoch),
      volumeTor: String(entry.volume_tor ?? entry.volumeTor ?? '0'),
      feesTor: String(entry.fees_tor ?? entry.feesTor ?? '0'),
      volumeUsd,
      feesUsd,
      rateBps: volumeUsd > 0 ? (feesUsd / volumeUsd) * 10000 : null
    });
  }

  const recordsRaw = Array.isArray(recordsResponse?.entries) ? recordsResponse.entries : [];
  const records = recordsRaw.map((entry) => {
    const thorname = String(entry.thorname ?? '').trim();
    const pair = String(entry.pair ?? '').trim();
    const id = recordId(thorname, pair);
    const current = currentMap.get(id);
    const detail = getPairDetail(detailsByThorname, thorname, pair);
    const dynamicBps = parseNumeric(entry.dynamic_bps ?? entry.dynamicBps ?? detail?.dynamic_bps);
    const whitelistState = parseNumeric(entry.whitelist_state ?? entry.whitelistState, 0);
    const history = normalizeHistory(detail?.history || []);
    const historyTotals = history.reduce(
      (acc, row) => ({
        volumeUsd: acc.volumeUsd + row.volumeUsd,
        feesUsd: acc.feesUsd + row.feesUsd
      }),
      { volumeUsd: 0, feesUsd: 0 }
    );
    const latestHistory = history[history.length - 1] || null;
    const lastActiveEpoch = parseNumeric(
      entry.last_active_epoch ?? entry.lastActiveEpoch ?? detail?.last_active_epoch
    );
    const staleEpochs = config.currentEpoch && lastActiveEpoch
      ? Math.max(0, config.currentEpoch - lastActiveEpoch)
      : 0;

    return {
      id,
      thorname,
      pair,
      pairLabel: formatPairDisplayName(pair),
      dynamicBps,
      whitelistState,
      stateLabel: whitelistStateLabel(whitelistState),
      stateKind: whitelistStateKind(whitelistState),
      lastActiveEpoch,
      staleEpochs,
      latestFeesTor: String(entry.latest_fees_tor ?? entry.latestFeesTor ?? latestHistory?.feesTor ?? '0'),
      latestFeesUsd: torToUsd(entry.latest_fees_tor ?? entry.latestFeesTor ?? latestHistory?.feesTor),
      currentVolumeUsd: current?.volumeUsd || 0,
      currentFeesUsd: current?.feesUsd || 0,
      currentRateBps: current?.rateBps ?? null,
      history,
      historyVolumeUsd: historyTotals.volumeUsd,
      historyFeesUsd: historyTotals.feesUsd,
      historyRateBps: historyTotals.volumeUsd > 0
        ? (historyTotals.feesUsd / historyTotals.volumeUsd) * 10000
        : null,
      isActive: whitelistState === 1,
      isMonitor: whitelistState === 2,
      isBinding: whitelistState === 1 && dynamicBps > config.l1SlipMinBps,
      atFloor: dynamicBps <= config.floorBps,
      atCeiling: dynamicBps >= config.ceilingBps,
      decision: inferDynamicFeeDecision(history, dynamicBps, config)
    };
  });

  const recordMap = new Map(records.map((record) => [record.id, record]));
  const currentEntries = Array.from(currentMap.values())
    .map((entry) => ({
      ...entry,
      record: recordMap.get(entry.id) || null,
      stateLabel: recordMap.get(entry.id)?.stateLabel || 'new',
      dynamicBps: recordMap.get(entry.id)?.dynamicBps || 0
    }))
    .sort((a, b) => b.feesUsd - a.feesUsd || b.volumeUsd - a.volumeUsd);

  records.sort((a, b) => {
    const stateRank = { active: 0, monitor: 1, inactive: 2 };
    return (
      stateRank[a.stateKind] - stateRank[b.stateKind] ||
      b.currentFeesUsd - a.currentFeesUsd ||
      b.latestFeesUsd - a.latestFeesUsd ||
      b.dynamicBps - a.dynamicBps ||
      a.thorname.localeCompare(b.thorname)
    );
  });

  const affiliates = buildAffiliateRollups(config, records, currentEntries);
  const summary = buildSummary(config, records, currentEntries, affiliates);

  return {
    config,
    records,
    currentEntries,
    affiliates,
    summary
  };
}

function buildSummary(config, records, currentEntries, affiliates = []) {
  const currentVolumeUsd = currentEntries.reduce((sum, entry) => sum + entry.volumeUsd, 0);
  const currentFeesUsd = currentEntries.reduce((sum, entry) => sum + entry.feesUsd, 0);
  const affiliateLiveVolumeUsd = affiliates.reduce((sum, entry) => sum + entry.liveVolumeUsd, 0);
  const affiliateLiveFeesUsd = affiliates.reduce((sum, entry) => sum + entry.liveFeesUsd, 0);
  const totalAffiliateVolumeUsd = affiliates.reduce((sum, entry) => sum + entry.totalVolumeUsd, 0);
  const totalAffiliateFeesUsd = affiliates.reduce((sum, entry) => sum + entry.totalFeesUsd, 0);
  const dynamicValues = records.map((entry) => entry.dynamicBps).filter((value) => value > 0);

  let statusKind = 'inactive';
  let statusLabel = 'inactive';
  if (config.adr26 === 1 && config.enabled !== 1) {
    statusKind = 'warn';
    statusLabel = 'approved';
  }
  if (config.adr26 === 1 && config.enabled === 1) {
    statusKind = records.length || currentEntries.length ? 'ok' : 'warn';
    statusLabel = records.length || currentEntries.length ? 'live' : 'waiting';
  }

  return {
    statusKind,
    statusLabel,
    recordCount: records.length,
    activeRecords: records.filter((entry) => entry.isActive).length,
    monitorRecords: records.filter((entry) => entry.isMonitor).length,
    bindingRecords: records.filter((entry) => entry.isBinding).length,
    atFloorRecords: records.filter((entry) => entry.atFloor).length,
    atCeilingRecords: records.filter((entry) => entry.atCeiling).length,
    maxDynamicBps: dynamicValues.length ? Math.max(...dynamicValues) : 0,
    avgDynamicBps: dynamicValues.length
      ? dynamicValues.reduce((sum, value) => sum + value, 0) / dynamicValues.length
      : 0,
    currentVolumeUsd,
    currentFeesUsd,
    currentRateBps: currentVolumeUsd > 0 ? (currentFeesUsd / currentVolumeUsd) * 10000 : null,
    affiliateLiveVolumeUsd,
    affiliateLiveFeesUsd,
    affiliateLiveRateBps: affiliateLiveVolumeUsd > 0
      ? (affiliateLiveFeesUsd / affiliateLiveVolumeUsd) * 10000
      : null,
    totalAffiliateVolumeUsd,
    totalAffiliateFeesUsd,
    totalAffiliateRateBps: totalAffiliateVolumeUsd > 0 ? (totalAffiliateFeesUsd / totalAffiliateVolumeUsd) * 10000 : null,
    affiliateCount: affiliates.length,
    activeWhitelistCount: config.activeWhitelistCount,
    monitorWhitelistCount: config.monitorWhitelistCount
  };
}

function getPairDetail(detailsByThorname, thorname, pair) {
  const detail =
    detailsByThorname[thorname] ||
    detailsByThorname[thorname?.toLowerCase?.()] ||
    detailsByThorname[thorname?.toUpperCase?.()];
  if (!detail?.pairs) return null;
  return detail.pairs.find((candidate) => String(candidate.pair ?? '') === pair) || null;
}

function recordId(thorname, pair) {
  return `${String(thorname).toLowerCase()}::${pair}`;
}

function decideNextBps(history, oldBps, config) {
  const floorBps = parseNumeric(config.floorBps, DYNAMIC_FEE_DEFAULTS.L1DynamicFeeFloorBPS);
  const ceilingBps = parseNumeric(config.ceilingBps, DYNAMIC_FEE_DEFAULTS.L1DynamicFeeCeilingBPS);
  const stepBps = parseNumeric(config.stepBps, DYNAMIC_FEE_DEFAULTS.L1DynamicFeeStepBPS);
  const deadbandBps = parseNumeric(config.deadbandBps, DYNAMIC_FEE_DEFAULTS.L1DynamicFeeDeadbandBPS);
  const windowEpochs = clampWindowEpochs(
    parseNumeric(config.windowEpochs, DYNAMIC_FEE_DEFAULTS.L1DynamicFeeWindowEpochs)
  );
  const changeIdx = lastBpsChangeBefore(history, history.length - 1);

  if (changeIdx < 0) {
    return {
      reason: 'cold_start_probe',
      expectedNewBps: clampBps(oldBps + stepBps, floorBps, ceilingBps),
      feesBefore: 0,
      feesAfter: 0,
      deltaPctBps: 0
    };
  }

  const directionUp = history[changeIdx].bpsAtClose > history[changeIdx - 1].bpsAtClose;
  const feesBefore = windowMeanFees(history, changeIdx - windowEpochs, changeIdx);
  const feesAfter = windowMeanFees(history, Math.max(changeIdx, history.length - windowEpochs), history.length);

  if (feesBefore <= 0) {
    return {
      reason: 'hold',
      expectedNewBps: oldBps,
      feesBefore,
      feesAfter,
      deltaPctBps: 0
    };
  }

  const deltaPctBps = Math.abs(feesAfter - feesBefore) / feesBefore * 10000;
  if (deltaPctBps < deadbandBps) {
    return {
      reason: 'hold',
      expectedNewBps: oldBps,
      feesBefore,
      feesAfter,
      deltaPctBps
    };
  }

  const feesIncreased = feesAfter > feesBefore;
  if (directionUp && feesIncreased) {
    return {
      reason: 'continue_up',
      expectedNewBps: clampBps(oldBps + stepBps, floorBps, ceilingBps),
      feesBefore,
      feesAfter,
      deltaPctBps
    };
  }

  if (directionUp && !feesIncreased) {
    return {
      reason: 'reverse_down',
      expectedNewBps: clampBpsDown(oldBps, stepBps, floorBps),
      feesBefore,
      feesAfter,
      deltaPctBps
    };
  }

  if (!directionUp && feesIncreased) {
    return {
      reason: 'continue_down',
      expectedNewBps: clampBpsDown(oldBps, stepBps, floorBps),
      feesBefore,
      feesAfter,
      deltaPctBps
    };
  }

  return {
    reason: 'reverse_up',
    expectedNewBps: clampBps(oldBps + stepBps, floorBps, ceilingBps),
    feesBefore,
    feesAfter,
    deltaPctBps
  };
}

function lastBpsChangeBefore(history, upToExclusive) {
  if (upToExclusive < 1) return -1;
  for (let i = upToExclusive - 1; i >= 1; i -= 1) {
    if (history[i].bpsAtClose !== history[i - 1].bpsAtClose) {
      return i;
    }
  }
  return -1;
}

function windowMeanFees(history, lo, hi) {
  const start = Math.max(0, lo);
  const end = Math.min(history.length, hi);
  if (end - start <= 0) return 0;

  let sum = 0;
  for (let i = start; i < end; i += 1) {
    sum += parseNumeric(history[i].feesTor);
  }
  return sum / (end - start);
}

function clampBps(candidate, floorBps, ceilingBps) {
  if (candidate > ceilingBps) return ceilingBps;
  if (candidate < floorBps) return floorBps;
  return candidate;
}

function clampBpsDown(oldBps, stepBps, floorBps) {
  if (oldBps > stepBps && oldBps - stepBps >= floorBps) {
    return oldBps - stepBps;
  }
  return floorBps;
}

function clampWindowEpochs(raw) {
  if (raw < 1) return 1;
  if (raw > MAX_DYNAMIC_FEE_HISTORY) return MAX_DYNAMIC_FEE_HISTORY;
  return Math.trunc(raw);
}
