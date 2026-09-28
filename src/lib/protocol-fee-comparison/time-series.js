import { PROTOCOLS, formatComparisonUsd } from '../../../shared/protocol-fee-comparison/model.js';
import { buildTimeSeriesOption, timeSeriesTooltip } from '../charts/time-series.js';
import { comparisonTooltip } from './options.js';

export function buildComparisonTimeSeries(rows, { sourceGrain = 'day', hidden = [], nearNetSupply = false, ...viewport } = {}) {
  return buildTimeSeriesOption(rows, { ...viewport, hidden, sourceGrain,
    axes: [{ id: 'net', label: 'NET INCOME · USD', color: '#c8c8c8', position: 'left', baseline: 'signed', format: value => formatComparisonUsd(value, true) }],
    series: PROTOCOLS.map(item => ({ ...item, aggregate: 'sum', axis: 'net', mark: 'bar',
      data: rows.map(row => sourceGrain === 'month' ? row.protocols?.[item.id]?.netUsd : row[item.id]?.netUsd) })),
    tooltip: row => sourceGrain === 'month' ? comparisonTooltip(row, hidden, nearNetSupply) : timeSeriesTooltip([
      `${row.day} · UTC`,
      ...PROTOCOLS.filter(item => !hidden.includes(item.id)).flatMap(item => [
        { ...item, text: `${item.label}: ${formatComparisonUsd(row[item.id]?.netUsd)}` },
        `Swap income: ${formatComparisonUsd(row[item.id]?.incomeUsd)} · ${item.id === 'near' && nearNetSupply ? 'Net issuance' : 'Token subsidy'}: ${formatComparisonUsd(row[item.id]?.subsidyUsd)}`
      ]), nearNetSupply ? 'NEAR: whole-chain net supply change, including all protocol burns. Not operating profit.' : 'NEAR: provisional income; 100% of chain issuance. Not operating profit.'
    ])
  });
}
