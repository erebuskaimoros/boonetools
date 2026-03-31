import { normalizeAsset } from '../utils/blockchain.js';

export function toChartDateKey(value) {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    return '';
  }

  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function getComparableVolumeUsd(row) {
  const inputUsd = Number(row?.input_estimated_usd) || 0;
  const outputUsd = Number(row?.output_estimated_usd) || 0;
  const sourceAsset = normalizeAsset(row?.source_asset || '');
  const targetAsset = normalizeAsset(row?.target_asset || '');

  if (sourceAsset === 'THOR.RUNE' || targetAsset === 'THOR.RUNE') {
    return inputUsd || outputUsd;
  }

  if (inputUsd > 0 && outputUsd > 0) {
    return inputUsd + outputUsd;
  }

  return inputUsd || outputUsd;
}

export function computeDailyData(swaps, midgardHistory) {
  if (!swaps.length) {
    return { labels: [], volume: [], cumVolume: [], count: [], cumCount: [], efficiency: [], pctFaster: [], volumePct: [], countPct: [] };
  }

  const byDay = {};
  for (const row of swaps) {
    const date = new Date(row.action_date);
    if (!Number.isFinite(date.getTime())) continue;
    const key = toChartDateKey(date);
    if (!byDay[key]) byDay[key] = [];
    byDay[key].push(row);
  }

  const mgByDay = {};
  if (midgardHistory?.intervals?.length) {
    for (const interval of midgardHistory.intervals) {
      const key = toChartDateKey(new Date((Number(interval.startTime) + 43200) * 1000));
      mgByDay[key] = {
        volume: (Number(interval.totalVolumeUSD) || 0) / 1e2,
        count: Number(interval.totalCount) || 0
      };
    }
  }

  const sortedKeys = Object.keys(byDay).sort();
  const labels = sortedKeys.map((key) => {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 12)).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC'
    });
  });

  const volume = [];
  const cumVolume = [];
  const count = [];
  const cumCount = [];
  const efficiency = [];
  const pctFaster = [];
  const volumePct = [];
  const countPct = [];
  let cumulativeVolume = 0;
  let cumulativeCount = 0;

  for (const key of sortedKeys) {
    const rows = byDay[key];
    const dayVolume = rows.reduce((sum, row) => sum + (Number(row.input_estimated_usd) || 0), 0);
    cumulativeVolume += dayVolume;
    volume.push(dayVolume);
    cumVolume.push(cumulativeVolume);
    count.push(rows.length);
    cumulativeCount += rows.length;
    cumCount.push(cumulativeCount);

    let totalSubs = 0;
    let totalBlocks = 0;
    for (const row of rows) {
      const subs = Number(row.streaming_count) || 0;
      const blocks = Number(row.blocks_used) || 0;
      totalSubs += subs;
      totalBlocks += blocks;
    }
    efficiency.push(totalBlocks > 0 ? +(totalSubs / totalBlocks).toFixed(2) : 1);
    pctFaster.push(totalSubs > 0 ? +((1 - totalBlocks / totalSubs) * 100).toFixed(1) : 0);

    const comparableVolume = rows.reduce((sum, row) => sum + getComparableVolumeUsd(row), 0);
    const midgard = mgByDay[key];
    volumePct.push(midgard && midgard.volume > 0 ? +((comparableVolume / midgard.volume) * 100).toFixed(2) : null);
    countPct.push(midgard && midgard.count > 0 ? +((rows.length / midgard.count) * 100).toFixed(2) : null);
  }

  return { labels, volume, cumVolume, count, cumCount, efficiency, pctFaster, volumePct, countPct };
}
