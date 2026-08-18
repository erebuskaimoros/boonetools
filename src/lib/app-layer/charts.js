import Chart from 'chart.js/auto';
import zoomPlugin from 'chartjs-plugin-zoom';
import { INTERACTIVE_CHART_LEGEND, TERMINAL_CHART_PALETTE } from '../charts/terminal.js';
import { denomLabel, fillBucketGaps, formatWeekLabel } from './model.js';

Chart.register(zoomPlugin);

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
});
const usd2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2
});
const signedUsd2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
  signDisplay: 'always'
});
const number2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const signedNumber4 = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 4,
  signDisplay: 'always'
});

export const APP_LAYER_SERIES = Object.freeze({
  accrued: {
    mark: '#00cc66',
    fill: 'rgba(0, 204, 102, 0.5)',
    faint: 'rgba(0, 204, 102, 0.09)',
    chrome: TERMINAL_CHART_PALETTE.accent
  },
  collected: {
    mark: '#b8860b',
    fill: 'rgba(184, 134, 11, 0.5)',
    faint: 'rgba(184, 134, 11, 0.09)',
    chrome: TERMINAL_CHART_PALETTE.amber
  },
  paid: {
    mark: '#00a755',
    fill: 'rgba(0, 167, 85, 0.5)',
    faint: 'rgba(0, 167, 85, 0.09)',
    chrome: TERMINAL_CHART_PALETTE.accent
  },
  pol: {
    mark: '#d4a017',
    fill: 'rgba(212, 160, 23, 0.5)',
    faint: 'rgba(212, 160, 23, 0.09)',
    chrome: TERMINAL_CHART_PALETTE.amber
  },
  generated: {
    mark: '#2f7fd6',
    fill: 'rgba(47, 127, 214, 0.5)',
    faint: 'rgba(47, 127, 214, 0.09)',
    chrome: '#44a0ff'
  }
});

export function collectedFlowTooltip(row, grain, limit = 4) {
  const entries = Object.entries(row.by_denom || {}).sort(
    (left, right) => Math.abs(right[1].usd || 0) - Math.abs(left[1].usd || 0)
  );
  const shown = entries.slice(0, limit);
  const remaining = entries.slice(limit);
  const lines = [
    `${number2.format(row.transfers || 0)} ${grain === 'weekly' ? 'denom-day' : 'denom'} balance changes`,
    ...shown.map(
      ([denom, entry]) =>
        `${denomLabel(denom)}: ${signedNumber4.format(entry.amount)} · ${signedUsd2.format(entry.usd)}`
    )
  ];
  if (remaining.length) {
    const remainingUsd = remaining.reduce((sum, [, entry]) => sum + (entry.usd || 0), 0);
    lines.push(`${number2.format(remaining.length)} other net: ${signedUsd2.format(remainingUsd)}`);
  }
  return lines;
}

export function renderAppLayerSeriesChart(canvas, previousChart, config) {
  previousChart?.destroy();
  const {
    grain,
    view,
    colors,
    valueField,
    cumulativeField,
    barLabel,
    barSeries,
    cumulativeLabel,
    afterBody,
    onZoomComplete
  } = config;
  const rows = fillBucketGaps(config.rows, valueField, cumulativeField, grain === 'weekly' ? 7 : 1);
  const cumulative = view === 'cumulative';
  const stackedBars = !cumulative && barSeries?.length > 1;
  const datasets = cumulative
    ? [{
        type: 'line',
        label: cumulativeLabel,
        data: rows.map((row) => row[cumulativeField] || 0),
        borderColor: colors.mark,
        backgroundColor: colors.faint,
        pointBackgroundColor: colors.mark,
        pointBorderColor: '#080808',
        pointRadius: rows.length > 45 ? 0 : 3,
        borderWidth: 2,
        tension: 0.2,
        fill: true
      }]
    : barSeries?.length
      ? barSeries.map((series) => ({
          type: 'bar',
          label: series.label,
          data: rows.map((row) => row[series.valueField] || 0),
          backgroundColor: series.colors.fill,
          borderColor: series.colors.mark,
          borderWidth: rows.length > 90 ? 0 : 1,
          borderRadius: 0,
          stack: 'combined'
        }))
      : [{
        type: 'bar',
        label: barLabel,
        data: rows.map((row) => row[valueField] || 0),
        backgroundColor: colors.fill,
        borderColor: colors.mark,
        borderWidth: rows.length > 90 ? 0 : 1,
        borderRadius: 0
      }];

  return new Chart(canvas.getContext('2d'), /** @type {any} */ ({
    type: 'bar',
    data: {
      labels: rows.map((row) => formatWeekLabel(row.bucket_start)),
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          ...INTERACTIVE_CHART_LEGEND,
          display: stackedBars,
          labels: {
            color: '#e8e8e8',
            boxWidth: 8,
            boxHeight: 8,
            padding: 14,
            font: { family: "'JetBrains Mono', monospace", size: 11, weight: 600 }
          }
        },
        tooltip: {
          backgroundColor: '#0a0a0a',
          borderColor: '#1a1a1a',
          borderWidth: 1,
          titleColor: '#ffffff',
          bodyColor: '#f5f5f5',
          titleFont: { family: "'JetBrains Mono', monospace", size: 12, weight: 700 },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 12, weight: 500 },
          callbacks: {
            afterBody(items) {
              return afterBody ? afterBody(rows[items[0].dataIndex]) : [];
            },
            label(context) {
              return `${context.dataset.label}: ${usd2.format(context.raw)}`;
            }
          }
        },
        zoom: {
          limits: { x: { minRange: 1 } },
          zoom: {
            mode: 'x',
            wheel: { enabled: false },
            pinch: { enabled: true },
            drag: {
              enabled: true,
              backgroundColor: colors.faint,
              borderColor: colors.mark,
              borderWidth: 1
            },
            onZoomComplete
          }
        }
      },
      scales: {
        x: {
          stacked: stackedBars,
          grid: { color: '#111', drawBorder: false },
          border: { color: '#1a1a1a' },
          ticks: { color: '#c8c8c8', font: { family: "'JetBrains Mono', monospace", size: 11 } }
        },
        y: {
          stacked: stackedBars,
          grid: { color: '#111', drawBorder: false },
          border: { color: '#1a1a1a' },
          ticks: {
            color: colors.chrome,
            font: { family: "'JetBrains Mono', monospace", size: 11 },
            callback: (value) => value >= 1000 ? usd0.format(value) : usd2.format(value)
          }
        }
      }
    }
  }));
}
