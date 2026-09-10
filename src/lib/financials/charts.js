import Chart from 'chart.js/auto';
import zoomPlugin from 'chartjs-plugin-zoom';
import { TERMINAL_CHART_PALETTE as palette, terminalChartFont } from '../charts/terminal.js';
import { formatFinancialAmount, formatFinancialDay, formatFinancialPercent } from '../../../shared/financials/model.js';

Chart.register(zoomPlugin);

export const FINANCIALS_SERIES = Object.freeze([
  { id: 'volume', label: 'DAILY VOLUME', color: palette.info },
  { id: 'income', label: 'SYSTEM INCOME', color: palette.amber },
  { id: 'bondingApr', label: 'BONDING APR', color: palette.accent }
]);

export function renderFinancialsChart(canvas, rows, { currency = 'usd', hidden = [], onZoom = (_window) => {} } = {}) {
  const suffix = currency === 'rune' ? 'Rune' : 'Usd';
  const unit = currency === 'rune' ? 'RUNE' : 'USD';
  const money = (value) => formatFinancialAmount(value, currency);
  const axis = (id, position, color, label, formatter) => ({
    type: /** @type {const} */ ('linear'), position, beginAtZero: true, grace: '5%',
    display: !hidden.includes(id),
    grid: position === 'left' ? { color: palette.grid } : { drawOnChartArea: false },
    border: { color },
    title: { display: true, text: label, color, font: terminalChartFont(11) },
    ticks: { color, font: terminalChartFont(11), maxTicksLimit: 6, callback: formatter }
  });
  const chart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: rows.map((row) => row.day),
      datasets: [
        {
          label: 'DAILY VOLUME', data: rows.map((row) => row[`volume${suffix}`]),
          yAxisID: 'volume', hidden: hidden.includes('volume'), order: 2,
          backgroundColor: 'rgba(85, 136, 204, 0.30)', borderColor: palette.info,
          borderWidth: 1, borderRadius: 0, maxBarThickness: 20
        },
        {
          label: 'SYSTEM INCOME', data: rows.map((row) => row[`income${suffix}`]),
          yAxisID: 'income', hidden: hidden.includes('income'), order: 1,
          backgroundColor: 'rgba(212, 160, 23, 0.35)', borderColor: palette.amber,
          borderWidth: 1, borderRadius: 0, maxBarThickness: 20
        },
        {
          type: 'line', label: 'BONDING APR', data: rows.map((row) => row.bondingApr),
          yAxisID: 'bondingApr', hidden: hidden.includes('bondingApr'), order: 0,
          borderColor: palette.accent, backgroundColor: palette.accent,
          borderWidth: 2, pointRadius: rows.map((row) => row.partial ? 4 : 0), pointHoverRadius: 4,
          segment: { borderDash: (context) => rows[context.p1DataIndex]?.partial ? [4, 4] : [] },
          tension: 0.1, spanGaps: false
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      onResize(chartInstance, size) {
        for (const id of ['volume', 'income', 'bondingApr']) {
          const scale = chartInstance.options.scales[id];
          if ('title' in scale) scale.title.display = size.width >= 600;
        }
        chartInstance.options.scales.x.ticks.maxTicksLimit = size.width >= 600 ? 9 : 4;
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: palette.surface, borderColor: palette.borderStrong, borderWidth: 1,
          titleColor: palette.text, bodyColor: palette.text,
          titleFont: terminalChartFont(12), bodyFont: terminalChartFont(12), padding: 12,
          callbacks: {
            title(items) {
              const row = rows[items[0]?.dataIndex];
              return `${formatFinancialDay(row?.day)} · UTC${row?.partial ? ' · IN PROGRESS' : ''}`;
            },
            label(item) {
              return `${item.dataset.label}: ${item.dataset.yAxisID === 'bondingApr'
                ? formatFinancialPercent(item.raw) : formatFinancialAmount(item.raw, currency, false)}`;
            },
            afterBody(items) {
              const row = rows[items[0]?.dataIndex];
              if (!row) return [];
              return [
                '',
                `Liquidity fees: ${formatFinancialAmount(row.feesRune, 'rune', false)}`,
                `Block rewards: ${formatFinancialAmount(row.blockRewardsRune, 'rune', false)}`,
                `Node rewards: ${formatFinancialAmount(row.bondingEarningsRune, 'rune', false)}`,
                `Active bond: ${formatFinancialAmount(row.activeBondRune, 'rune')}`,
                ...(row.partial ? [`Through ${new Date(row.through * 1000).toLocaleTimeString('en-US', { timeZone: 'UTC', hour12: false })} UTC`, 'APR: elapsed-time annualized estimate'] : []),
                ...(row.bondingApr === null ? ['Bonding APR: bond snapshot unavailable'] : []),
                ...(row.incomeUsd === null || row.volumeUsd === null ? ['Some source data is unavailable'] : [])
              ];
            }
          }
        },
        zoom: {
          limits: { x: { min: 'original', max: 'original', minRange: 2 } },
          zoom: {
            mode: 'x', wheel: { enabled: false }, pinch: { enabled: true },
            drag: { enabled: true, backgroundColor: 'rgba(85, 136, 204, 0.12)', borderColor: palette.info, borderWidth: 1 },
            onZoomComplete({ chart: zoomed }) {
              const start = Math.max(0, Math.ceil(Number(zoomed.scales.x.min)));
              const end = Math.min(rows.length - 1, Math.floor(Number(zoomed.scales.x.max)));
              onZoom?.(start > 0 || end < rows.length - 1 ? { startDay: rows[start]?.day, endDay: rows[end]?.day } : null);
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false }, border: { color: palette.border },
          ticks: {
            color: palette.muted, font: terminalChartFont(11), maxTicksLimit: 9, maxRotation: 0,
            callback(value) {
              const day = rows[Number(value)]?.day;
              if (rows[Number(value)]?.partial) return 'Today*';
              return day ? new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
                month: 'short', ...(rows.length <= 365 ? { day: 'numeric' } : { year: '2-digit' }), timeZone: 'UTC'
              }) : '';
            }
          }
        },
        volume: axis('volume', 'left', palette.info, `VOLUME · ${unit}`, money),
        income: axis('income', 'right', palette.amber, `INCOME · ${unit}`, money),
        bondingApr: axis('bondingApr', 'right', palette.accent, 'BONDING APR · %', formatFinancialPercent)
      }
    }
  });
  return {
    resetZoom() { chart.resetZoom('none'); onZoom?.(null); },
    setVisible(id, visible) {
      chart.setDatasetVisibility(FINANCIALS_SERIES.findIndex((series) => series.id === id), visible);
      chart.options.scales[id].display = visible;
      chart.update('none');
    },
    updatePoints(points) {
      rows = points;
      chart.data.labels = rows.map((row) => row.day);
      chart.data.datasets[0].data = rows.map((row) => row[`volume${suffix}`]);
      chart.data.datasets[1].data = rows.map((row) => row[`income${suffix}`]);
      chart.data.datasets[2].data = rows.map((row) => row.bondingApr);
      const aprDataset = chart.data.datasets[2];
      if (aprDataset.type === 'line') aprDataset.pointRadius = rows.map((row) => row.partial ? 4 : 0);
      chart.update('none');
    },
    destroy() { chart.destroy(); }
  };
}
