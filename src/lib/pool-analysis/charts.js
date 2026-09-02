import Chart from 'chart.js/auto';
import zoomPlugin from 'chartjs-plugin-zoom';
import { TERMINAL_CHART_PALETTE, terminalChartFont } from '../charts/terminal.js';
import { poolAnalysisFeeVolumeBps, poolAnalysisLineMetric } from './model.js';

Chart.register(zoomPlugin);

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 2
});
const rune = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });

function formatBps(value) {
  if (value === null) return 'unavailable';
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: Math.abs(value) < 10 && value !== 0 ? 2 : 0
  }).format(value)} BPS`;
}

function compact(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2
  }).format(amount);
}

function dateLabel(day) {
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' })
    : day;
}

function indexValue(value, labels, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const index = labels.indexOf(value);
  return index >= 0 ? index : fallback;
}

export function renderPoolAnalysisCharts(canvas, previous, rows = [], options = {}) {
  previous?.destroy?.();
  if (!canvas || !rows.length) return null;
  const labels = rows.map((row) => row.day);
  let lineMetric = poolAnalysisLineMetric(options.lineMetric);

  function visibleRange(chart) {
    const scale = chart?.scales?.x;
    if (!scale) return { start: 0, end: rows.length - 1 };
    return {
      start: Math.max(0, Math.floor(indexValue(scale.min, labels, 0))),
      end: Math.min(rows.length - 1, Math.ceil(indexValue(scale.max, labels, rows.length - 1)))
    };
  }

  function reportRange(start, end) {
    const zoomed = start > 0 || end < rows.length - 1;
    options.onZoom?.(zoomed ? {
      startDay: rows[start]?.day || '', endDay: rows[end]?.day || ''
    } : null);
  }

  function tooltipCallbacks() {
    return {
      title(items) { return dateLabel(rows[items[0]?.dataIndex]?.day || ''); },
      label() { return ''; },
      afterBody(items) {
        const row = rows[items[0]?.dataIndex] || {};
        const feeVolumeBps = poolAnalysisFeeVolumeBps(row.feesRuneBase, row.volumeRuneBase);
        return [
          `DAILY VOLUME: ${row.volumeUsd == null ? 'unavailable' : usd.format(row.volumeUsd)}`,
          `DAILY FEES: ${row.feesUsd == null ? 'unavailable' : usd.format(row.feesUsd)}`,
          `FEES / VOLUME: ${formatBps(feeVolumeBps)}`,
          `FEES IN RUNE: ${row.feesRune == null ? 'unavailable' : `${rune.format(row.feesRune)} ᚱ`}`,
          `${lineMetric.label}: ${row[lineMetric.field] == null ? 'unavailable' : usd.format(row[lineMetric.field])}`,
          ...(row.partial || lineMetric.id === 'depth' && row.depthPartial ? ['LIVE PARTIAL UTC DAY'] : []),
          ...(lineMetric.id === 'depth' && row.depthPartial && row.depthUpdatedAt
            ? [`DEPTH OBSERVED: ${row.depthUpdatedAt}`] : []),
          ...(row.source === 'missing' ? ['MISSING SOURCE DAY'] : [])
        ];
      }
    };
  }

  const chart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: 'DAILY VOLUME',
          data: rows.map((row) => row.volumeUsd),
          yAxisID: 'yVolume',
          backgroundColor: 'rgba(85, 136, 204, 0.30)',
          borderColor: TERMINAL_CHART_PALETTE.info,
          borderWidth: 1,
          borderRadius: 0
        },
        {
          type: 'bar',
          label: 'DAILY FEES',
          data: rows.map((row) => row.feesUsd),
          yAxisID: 'yFees',
          backgroundColor: 'rgba(212, 160, 23, 0.28)',
          borderColor: TERMINAL_CHART_PALETTE.amber,
          borderWidth: 1,
          borderRadius: 0
        },
        {
          type: 'line',
          label: lineMetric.label,
          data: rows.map((row) => row[lineMetric.field]),
          yAxisID: 'yLine',
          backgroundColor: 'rgba(0, 204, 102, 0.05)',
          borderColor: TERMINAL_CHART_PALETTE.accent,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0.08,
          spanGaps: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: TERMINAL_CHART_PALETTE.surface,
          borderColor: TERMINAL_CHART_PALETTE.borderStrong,
          borderWidth: 1,
          titleColor: TERMINAL_CHART_PALETTE.accent,
          bodyColor: TERMINAL_CHART_PALETTE.text,
          titleFont: terminalChartFont(12),
          bodyFont: terminalChartFont(12),
          padding: 10,
          callbacks: tooltipCallbacks()
        },
        zoom: {
          limits: { x: { min: 'original', max: 'original', minRange: 1 } },
          zoom: {
            mode: 'x',
            wheel: { enabled: false },
            pinch: { enabled: true },
            drag: {
              enabled: true,
              backgroundColor: 'rgba(85, 136, 204, 0.10)',
              borderColor: TERMINAL_CHART_PALETTE.info,
              borderWidth: 1
            },
            onZoomComplete({ chart: zoomedChart }) {
              const { start, end } = visibleRange(zoomedChart);
              reportRange(start, end);
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
            maxTicksLimit: 8,
            maxRotation: 0,
            callback(value) { return dateLabel(labels[Number(value)] || this.getLabelForValue(Number(value))); }
          }
        },
        yVolume: {
          type: 'linear',
          position: 'left',
          beginAtZero: true,
          grace: '5%',
          grid: { color: TERMINAL_CHART_PALETTE.grid },
          border: { color: TERMINAL_CHART_PALETTE.info },
          title: { display: true, text: 'DAILY VOLUME · USD', color: TERMINAL_CHART_PALETTE.info, font: terminalChartFont(11) },
          ticks: { color: TERMINAL_CHART_PALETTE.info, font: terminalChartFont(11), callback: compact }
        },
        yFees: {
          type: 'linear',
          position: 'right',
          beginAtZero: true,
          grace: '5%',
          grid: { drawOnChartArea: false },
          border: { color: TERMINAL_CHART_PALETTE.amber },
          title: { display: true, text: 'DAILY FEES · USD', color: TERMINAL_CHART_PALETTE.amber, font: terminalChartFont(11) },
          ticks: { color: TERMINAL_CHART_PALETTE.amber, font: terminalChartFont(11), callback: compact }
        },
        yLine: {
          type: 'linear',
          position: 'right',
          beginAtZero: false,
          grace: '3%',
          grid: { drawOnChartArea: false },
          border: { color: TERMINAL_CHART_PALETTE.accent },
          title: { display: true, text: `${lineMetric.label} · USD`, color: TERMINAL_CHART_PALETTE.accent, font: terminalChartFont(11) },
          ticks: { color: TERMINAL_CHART_PALETTE.accent, font: terminalChartFont(11), callback: compact }
        }
      }
    }
  });

  return {
    chart,
    setLineMetric(id) {
      lineMetric = poolAnalysisLineMetric(id);
      chart.data.datasets[2].label = lineMetric.label;
      chart.data.datasets[2].data = rows.map((row) => row[lineMetric.field]);
      chart.options.scales.yLine.title.text = `${lineMetric.label} · USD`;
      chart.update('none');
    },
    resetZoom() {
      chart.resetZoom?.('none');
      options.onZoom?.(null);
    },
    zoomBy(factor) {
      const current = visibleRange(chart);
      const center = (current.start + current.end) / 2;
      const span = Math.max(1, (current.end - current.start + 1) * factor);
      let start = Math.max(0, Math.floor(center - (span / 2)));
      let end = Math.min(rows.length - 1, Math.ceil(center + (span / 2)));
      if (start === 0) end = Math.min(rows.length - 1, Math.max(end, Math.ceil(span) - 1));
      if (end === rows.length - 1) start = Math.max(0, Math.min(start, end - Math.ceil(span) + 1));
      chart.options.scales.x.min = start;
      chart.options.scales.x.max = end;
      chart.update('none');
      reportRange(start, end);
    },
    destroy() { chart.destroy(); }
  };
}
