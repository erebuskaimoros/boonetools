import { utcDayIndices } from './viewport.js';

// Features supply periodic fields, not cumulative renderer values. No missing
// buckets are invented here and no nulls are coerced to zero.
export function selectSummaryRows(rows, window = null) {
  if (!window || !rows.length) return rows;
  const { start, end } = utcDayIndices(rows, window);
  return rows.slice(start, end + 1);
}

// Chart.js category zoom bounds may be fractional. Count only visible centers.
export function selectIndexSummaryRows(rows, range = null) {
  if (!range) return rows;
  const start = Math.max(0, Math.ceil(range.start));
  const end = Math.min(rows.length - 1, Math.floor(range.end));
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? rows.slice(start, end + 1) : [];
}

export function summarizeMetric(rows, metric) {
  const value = metric.value || ((row) => row[metric.field]);
  const values = rows.map(value).filter(Number.isFinite);
  const count = values.length;
  const total = count ? values.reduce((sum, item) => sum + item, 0) : null;
  const last = rows.length ? value(rows.at(-1)) : null;
  return {
    count, total, average: count ? total / count : null,
    minimum: count ? values.reduce((min, item) => Math.min(min, item), Infinity) : null,
    maximum: count ? values.reduce((max, item) => Math.max(max, item), -Infinity) : null,
    latest: Number.isFinite(last) ? last : null
  };
}

export function formatSummaryValue(value, unit = '', exact = false) {
  if (!Number.isFinite(value)) return '—';
  const number = new Intl.NumberFormat('en-US', {
    notation: exact ? 'standard' : 'compact',
    ...(exact ? { maximumSignificantDigits: 15 } : Math.abs(value) > 0 && Math.abs(value) < 1
      ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 2 })
  }).format(Math.abs(value));
  const sign = value < 0 ? '-' : '';
  return unit === 'usd' ? `${sign}$${number}`
    : `${sign}${number}${unit === '%' || unit === '×' ? unit : unit ? ` ${unit}` : ''}`;
}

/** Four cards by default for one to four explicitly chosen primary chart metrics.
 * Single-metric charts may choose a smaller set with metric.statistics.
 * Means are arithmetic means of available plotted buckets, never a weighted
 * period rate. Custom weighted accounting can supply cards to RangeSummary.
 */
export function buildSummaryCards(rows, metrics, bucket = 'bucket') {
  const prepared = metrics.map(metric => ({ ...metric, stats: summarizeMetric(rows, metric) }));
  const card = (metric, stat) => {
    const { label, unit = '', format } = metric;
    const averageRows = stat === 'average' && metric.averageFilter ? rows.filter(metric.averageFilter) : rows;
    const stats = averageRows === rows ? metric.stats : summarizeMetric(averageRows, metric);
    const observationBasis = stat === 'average' ? metric.averageBasis || bucket : bucket;
    const incomplete = stats.count < rows.length;
    const labels = {
      total: `${incomplete ? 'Observed ' : ''}${label.toLowerCase()} total`,
      average: `Avg ${label.toLowerCase()}${metric.kind === 'flow' ? ` / ${bucket}` : ''}`,
      minimum: `Min ${label.toLowerCase()}${metric.kind === 'flow' ? ` / ${bucket}` : ''}`,
      maximum: `Max ${label.toLowerCase()}${metric.kind === 'flow' ? ` / ${bucket}` : ''}`,
      latest: `Latest ${label.toLowerCase()}`
    };
    return { label: labels[stat], value: stats[stat], unit, format,
      detail: `${stats.count}/${averageRows.length} ${observationBasis} observations${stat === 'average' ? ' · arithmetic mean' : ''}` };
  };
  if (!prepared.length) return [];
  if (prepared.length === 1) {
    const metric = prepared[0];
    return (metric.statistics || (metric.kind === 'flow' ? ['total', 'average', 'minimum', 'maximum'] : ['average', 'minimum', 'maximum', 'latest']))
      .map(stat => card(metric, stat));
  }
  if (prepared.length === 2) {
    return prepared.flatMap(metric => (metric.kind === 'flow' ? ['total', 'average'] : ['average', 'latest'])
      .map(stat => card(metric, stat)));
  }
  const cards = prepared.map(metric => ({
    ...card(metric, metric.kind === 'flow' ? 'total' : 'average'),
    secondary: card(metric, metric.kind === 'flow' ? 'average' : 'latest')
  }));
  if (cards.length === 3) cards.push({ label: 'Selected buckets', value: rows.length, unit: '', detail: 'Selected range · partial buckets included', secondary: null });
  return cards;
}
