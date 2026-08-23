import Chart from 'chart.js/auto';
import zoomPlugin from 'chartjs-plugin-zoom';
import {
  INTERACTIVE_CHART_LEGEND,
  TERMINAL_CHART_PALETTE,
  terminalChartFont
} from '../charts/terminal.js';

Chart.register(zoomPlugin);

const rune = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 4
});

function compact(value, prefix = '') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  const absolute = Math.abs(amount);
  if (absolute >= 1_000_000) return `${prefix}${(amount / 1_000_000).toFixed(2)}m`;
  if (absolute >= 1_000) {
    return `${prefix}${(amount / 1_000).toFixed(absolute < 10_000 ? 2 : 1)}k`;
  }
  return `${prefix}${amount.toFixed(absolute < 10 ? 2 : 0)}`;
}

function dateLabel(day) {
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' })
    : day;
}

function scaleIndex(value, labels, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const index = labels.indexOf(value);
  return index >= 0 ? index : fallback;
}

function zoomRange(chart, rows) {
  const scale = chart?.scales?.x;
  if (!scale || rows.length < 2) return null;
  const labels = chart.data.labels || [];
  const start = Math.max(0, Math.min(rows.length - 1, Math.floor(scaleIndex(scale.min, labels, 0))));
  const end = Math.max(start, Math.min(rows.length - 1, Math.ceil(scaleIndex(scale.max, labels, rows.length - 1))));
  if (start === 0 && end === rows.length - 1) return null;
  return { startDay: rows[start]?.day || '', endDay: rows[end]?.day || '' };
}

export function renderBurnTrackerChart(canvas, previous, rows = [], options = {}) {
  previous?.destroy();
  if (!canvas) return null;
  const showPrice = Boolean(options.showPrice);
  const labels = rows.map((row) => row.day);
  const chart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: 'DAILY BURN',
          data: rows.map((row) => row.burnedRune),
          backgroundColor: rows.map((row) => row.partial ? 'rgba(0, 204, 102, 0.16)' : 'rgba(0, 204, 102, 0.34)'),
          borderColor: TERMINAL_CHART_PALETTE.accent,
          borderWidth: 1,
          borderRadius: 0,
          maxBarThickness: 22,
          yAxisID: 'daily'
        },
        {
          type: 'line',
          label: 'CUMULATIVE BURN',
          data: rows.map((row) => row.cumulativeBurnedRune),
          borderColor: TERMINAL_CHART_PALETTE.amber,
          backgroundColor: 'rgba(212, 160, 23, 0.05)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.08,
          spanGaps: false,
          yAxisID: 'cumulative'
        },
        {
          type: 'line',
          label: 'RUNE / USD',
          data: rows.map((row) => row.runePriceUsd),
          borderColor: TERMINAL_CHART_PALETTE.info,
          borderWidth: 1.5,
          borderDash: [5, 4],
          pointRadius: 0,
          tension: 0.12,
          spanGaps: false,
          hidden: !showPrice,
          yAxisID: 'price'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          ...INTERACTIVE_CHART_LEGEND,
          position: 'top',
          align: 'end',
          labels: {
            color: TERMINAL_CHART_PALETTE.muted,
            font: terminalChartFont(11),
            boxWidth: 9,
            boxHeight: 9,
            padding: 14
          }
        },
        tooltip: {
          backgroundColor: TERMINAL_CHART_PALETTE.surface,
          borderColor: TERMINAL_CHART_PALETTE.borderStrong,
          borderWidth: 1,
          titleColor: TERMINAL_CHART_PALETTE.accent,
          bodyColor: TERMINAL_CHART_PALETTE.text,
          titleFont: terminalChartFont(12),
          bodyFont: terminalChartFont(12),
          padding: 10,
          callbacks: {
            title(items) {
              return dateLabel(rows[items[0]?.dataIndex]?.day || '');
            },
            label(context) {
              if (context.raw === null) return `${context.dataset.label}: unavailable`;
              return context.dataset.yAxisID === 'price'
                ? `${context.dataset.label}: ${usd.format(Number(context.raw))}`
                : `${context.dataset.label}: ${rune.format(Number(context.raw))} RUNE`;
            },
            afterBody(items) {
              return rows[items[0]?.dataIndex]?.partial ? ['LIVE PARTIAL UTC DAY'] : [];
            }
          }
        },
        zoom: {
          limits: { x: { min: 'original', max: 'original', minRange: 1 } },
          zoom: {
            mode: 'x',
            wheel: { enabled: false },
            pinch: { enabled: true },
            drag: {
              enabled: true,
              backgroundColor: 'rgba(0, 204, 102, 0.08)',
              borderColor: TERMINAL_CHART_PALETTE.accent,
              borderWidth: 1
            },
            onZoomComplete({ chart: zoomedChart }) {
              options.onZoom?.(zoomRange(zoomedChart, rows));
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: TERMINAL_CHART_PALETTE.grid },
          border: { color: TERMINAL_CHART_PALETTE.border },
          ticks: {
            color: TERMINAL_CHART_PALETTE.muted,
            font: terminalChartFont(11),
            callback(value) {
              const index = Number(value);
              return dateLabel(labels[index] || this.getLabelForValue(index));
            },
            maxTicksLimit: 8,
            maxRotation: 0
          }
        },
        daily: {
          beginAtZero: true,
          position: 'left',
          grid: { color: TERMINAL_CHART_PALETTE.grid },
          border: { color: TERMINAL_CHART_PALETTE.border },
          title: { display: true, text: 'DAILY RUNE', color: TERMINAL_CHART_PALETTE.accent, font: terminalChartFont(11) },
          ticks: { color: TERMINAL_CHART_PALETTE.accent, font: terminalChartFont(11), callback: (value) => compact(value) }
        },
        cumulative: {
          beginAtZero: false,
          position: 'right',
          grid: { drawOnChartArea: false },
          border: { color: TERMINAL_CHART_PALETTE.border },
          title: { display: true, text: 'CUMULATIVE RUNE', color: TERMINAL_CHART_PALETTE.amber, font: terminalChartFont(11) },
          ticks: { color: TERMINAL_CHART_PALETTE.amber, font: terminalChartFont(11), callback: (value) => compact(value) }
        },
        price: {
          display: showPrice,
          beginAtZero: false,
          position: 'right',
          offset: true,
          grid: { drawOnChartArea: false },
          border: { color: TERMINAL_CHART_PALETTE.border },
          title: { display: true, text: 'RUNE / USD', color: TERMINAL_CHART_PALETTE.info, font: terminalChartFont(11) },
          ticks: { color: TERMINAL_CHART_PALETTE.info, font: terminalChartFont(11), callback: (value) => compact(value, '$') }
        }
      }
    }
  });
  return chart;
}

export function setBurnTrackerPriceVisible(chart, visible) {
  if (!chart) return;
  chart.setDatasetVisibility(2, Boolean(visible));
  chart.options.scales.price.display = Boolean(visible);
  chart.update('none');
}
