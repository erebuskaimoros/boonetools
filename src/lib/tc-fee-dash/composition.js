import { TC_FEE_BUCKETS } from '../../../shared/tc-fee-composition.js';
import { buildTimeSeriesOption, timeSeriesTooltip } from '../charts/time-series.js';

const DAY = 86400000;
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
export const formatFeeShare = value => value == null ? '—' : `${value.toFixed(1)}%`;
export const FEE_SHARE_SERIES = [
  { id: 'btc', label: 'BTC', color: '#d4a017', areaFill: 'rgba(212,160,23,0.7)' },
  { id: 'eth', label: 'ETH', color: '#5588cc', areaFill: 'rgba(85,136,204,0.7)' },
  { id: 'stablecoins', label: 'STABLECOINS', color: '#00cc66', areaFill: 'rgba(0,204,102,0.6)' },
  { id: 'other', label: 'OTHER', color: '#b2b2b2', areaFill: 'rgba(178,178,178,0.6)' }
];

export function normalizeFeeComposition(rows = []) {
  const indexed = new Map();
  for (const row of rows) {
    if (!row || !/^20\d{2}-\d{2}-\d{2}$/.test(row.day) || !Number.isFinite(Date.parse(row.day))
      || new Date(row.day).toISOString().slice(0, 10) !== row.day) continue;
    const fees = row.fees;
    const complete = row.complete === true && Number.isFinite(row.totalFeesUsd) && row.totalFeesUsd >= 0
      && TC_FEE_BUCKETS.every(id => Number.isFinite(fees?.[id]) && fees[id] >= 0)
      && Math.abs(TC_FEE_BUCKETS.reduce((sum, id) => sum + fees[id], 0) - row.totalFeesUsd) <= Math.max(1e-8, row.totalFeesUsd * 1e-10);
    indexed.set(row.day, { ...row, complete, fees: complete ? fees : null });
  }
  const days = [...indexed.keys()].sort();
  if (!days.length) return [];
  const result = [];
  for (let time = Date.parse(days[0]); time <= Date.parse(days.at(-1)); time += DAY) {
    const day = new Date(time).toISOString().slice(0, 10);
    result.push(indexed.get(day) || { day, totalFeesUsd: null, fees: null, complete: false, source: 'unavailable' });
  }
  return result;
}

/** @param {any[]} rows @param {number | 'all'} days */
export function selectFeeCompositionRange(rows, days = 90) {
  if (!rows.length || days === 'all') return rows;
  const cutoff = Date.parse(rows.at(-1).day) - (Number(days) - 1) * DAY;
  return rows.filter(row => Date.parse(row.day) >= cutoff);
}

export function feeShare(rows, id) {
  if (!rows.length || rows.some(row => !row.complete)) return null;
  const total = rows.reduce((sum, row) => sum + row.totalFeesUsd, 0);
  return total > 0 ? rows.reduce((sum, row) => sum + row.fees[id], 0) / total * 100 : null;
}

export function feeShareSummary(rows) {
  const verified = rows.filter(row => row.complete);
  return {
    verifiedDays: verified.length, missingDays: rows.length - verified.length,
    cards: FEE_SHARE_SERIES.map(item => ({ label: `${item.label} fee share`,
      value: feeShare(verified, item.id), format: formatFeeShare,
      detail: `${usd.format(verified.reduce((sum, row) => sum + row.fees[item.id], 0))} verified fees` }))
  };
}

function tooltip(rows, label) {
  const complete = rows.length && rows.every(row => row.complete);
  const total = rows.reduce((sum, row) => sum + (row.totalFeesUsd || 0), 0);
  return timeSeriesTooltip([
    label,
    ...(complete ? FEE_SHARE_SERIES.map(item => ({ ...item,
      text: `${item.label}: ${formatFeeShare(feeShare(rows, item.id))} · ${usd.format(rows.reduce((sum, row) => sum + row.fees[item.id], 0))}`
    })) : ['POOL FEE ATTRIBUTION INCOMPLETE — no estimated shares']),
    ...(complete && !total ? ['NO LIQUIDITY FEES — percentage shares are undefined'] : []),
    ...(complete ? [`TC LIQUIDITY FEES: ${usd.format(total)}`] : []),
    'Shares always use all four buckets.'
  ]);
}

/** @param {any[]} rows @param {any} options */
export function buildFeeShareOption(rows, { smoothingDays = 0, feeHistory = rows, ...options } = {}) {
  const days = [7, 30].includes(smoothingDays) ? smoothingDays : 0;
  // Visible observations take priority over cached lookback. Build from all
  // available history before range/zoom selection, never shorten a window.
  const history = days ? [...new Map([...feeHistory, ...rows].map(row => [row.day, row])).values()]
    .sort((a, b) => a.day.localeCompare(b.day)) : [];
  const windows = new Map(history.map((row, index) => {
    const sample = history.slice(Math.max(0, index - days + 1), index + 1);
    const consecutive = sample.length === days && sample.every((point, offset) =>
      Date.parse(point.day) === Date.parse(row.day) - (days - offset - 1) * DAY);
    return [row.day, consecutive ? sample : []];
  }));
  const sampleFor = row => days ? windows.get(row.day) || [] : [row];
  const groupedSample = sample => days ? sampleFor(sample.at(-1)) : sample;
  const trailingLabel = row => `${days}D TRAILING · ${new Date(Date.parse(row.day) - (days - 1) * DAY).toISOString().slice(0, 10)} → ${row.day} · UTC${sampleFor(row).some(point => point.partial) ? ' · PARTIAL DAY' : ''}`;
  const option = buildTimeSeriesOption(rows, {
    ...options, hidden: [],
    // Composition replaces the primary stack as a whole. Never append generic
    // single-series overlays or honor stale hidden-series selections here.
    analysis: options.analysis ? { grain: options.analysis.grain, hidden: [], rolling: [] } : null,
    axes: [{ id: 'share', label: 'SHARE OF TC FEES · %', position: 'left', color: '#b2b2b2', min: 0, max: 100,
      format: value => `${value.toFixed(0)}%`, tooltipFormat: formatFeeShare }],
    series: FEE_SHARE_SERIES.map(item => ({ ...item, axis: 'share', mark: 'line', stack: 'fee-share', lineWidth: 1,
      data: rows.map(row => feeShare(sampleFor(row), item.id)),
      aggregateData: rows.map(row => row.fees?.[item.id] ?? null),
      rolling: false,
      aggregate: sample => feeShare(groupedSample(sample), item.id)
    })),
    tooltip: row => tooltip(sampleFor(row), days ? trailingLabel(row) : `${row.day} · UTC${row.partial ? ' · PARTIAL DAY' : ''}`),
    groupedTooltip: (row, context) => tooltip(groupedSample(context.rows),
      `${row.fromDay} → ${row.throughDay} · UTC ${context.grain.toUpperCase()}${row.partial ? ' · PARTIAL BUCKET' : ''}${days ? ` · ${trailingLabel(context.rows.at(-1))}` : ''}`)
  });
  // Calendar analysis clears source-specific axis bounds; percentage composition
  // retains its universal 0–100% scale at every grain and smoothing window.
  option.yAxis[0].min = 0;
  option.yAxis[0].max = 100;
  return option;
}
