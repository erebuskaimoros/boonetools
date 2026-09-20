import { PROTOCOLS, formatComparisonMonth, formatComparisonUsd } from '../../../shared/protocol-fee-comparison/model.js';
import { TERMINAL_CHART_PALETTE as palette } from '../charts/terminal.js';

const mono = "'JetBrains Mono', monospace";
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export function comparisonTooltip(month, hidden = []) {
  if (!month) return '';
  return `<div style="line-height:16px"><strong>${escape(formatComparisonMonth(month.month))}${month.partial ? ' · PARTIAL' : ''}</strong><br>${escape(month.fromDay)} → ${escape(month.throughDay)} UTC`
    + PROTOCOLS.filter(({ id }) => !hidden.includes(id)).map(({ id, label, color }) => {
      const point = month.protocols[id];
      const heading = `<div style="margin-top:8px"><span aria-hidden="true" data-series="${id}" style="display:inline-block;width:10px;height:10px;background:${color};border:1px solid ${color};border-radius:0"></span> <strong>${label}</strong>`;
      return heading + (point.complete
        ? `<br>Swap income: ${formatComparisonUsd(point.incomeUsd)}<br>Token subsidy: ${formatComparisonUsd(point.subsidyUsd)}<br><strong>After subsidy: ${formatComparisonUsd(point.netUsd)}</strong>`
        : `<br>Unavailable · ${point.observedDays}/${point.expectedDays} days covered`) + '</div>';
    }).join('') + '<div style="margin-top:8px">NEAR: provisional income; 100% of chain issuance.<br>Not operating profit.</div></div>';
}

export function comparisonOption(months, hidden = [], width = 1000) {
  const mobile = width < 600;
  return { animation: false, backgroundColor: 'transparent', textStyle: { fontFamily: mono, fontSize: 11, color: palette.text },
    grid: { left: mobile ? 65 : 85, right: 15, top: 25, bottom: 45 },
    tooltip: { trigger: 'axis', renderMode: 'html', confine: true, backgroundColor: palette.surface,
      borderColor: palette.borderStrong, borderWidth: 1, padding: 12,
      textStyle: { color: palette.text, fontFamily: mono, fontSize: 12 },
      extraCssText: 'border-radius:0;box-shadow:none;max-width:calc(100vw - 48px);white-space:normal;',
      axisPointer: { type: 'shadow' }, formatter: (params) => comparisonTooltip(months[params?.[0]?.dataIndex], hidden) },
    xAxis: { type: 'category', data: months.map((row) => `${formatComparisonMonth(row.month)}${row.partial ? ' *' : ''}`),
      axisLine: { lineStyle: { color: palette.borderStrong }, onZero: false }, axisTick: { show: false },
      axisLabel: { color: palette.muted, fontSize: 11, fontFamily: mono } },
    yAxis: { type: 'value', scale: false, name: mobile ? '' : 'USD / MONTH',
      nameTextStyle: { color: palette.muted, fontFamily: mono, fontSize: 11 },
      axisLine: { show: false }, axisLabel: { formatter: (value) => formatComparisonUsd(value, true), color: palette.muted, fontFamily: mono, fontSize: 11 },
      splitLine: { lineStyle: { color: palette.border } } },
    series: PROTOCOLS.filter(({ id }) => !hidden.includes(id)).map(({ id, label, color }) => ({
      id, name: label, type: 'bar', barMaxWidth: mobile ? 38 : 64, barGap: '15%',
      itemStyle: { color, borderRadius: 0 },
      data: months.map((month) => ({ value: month.protocols[id].netUsd,
        itemStyle: { opacity: month.partial ? 0.65 : 1, ...(month.partial ? { borderWidth: 1, borderColor: color, borderType: 'dashed' } : {}) } })),
      markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: palette.muted, width: 1, type: 'solid' }, data: [{ yAxis: 0 }] }
    })) };
}
