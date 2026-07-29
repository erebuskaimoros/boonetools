import Chart from 'chart.js/auto';

import { TERMINAL_CHART_PALETTE, terminalChartFont } from '../charts/terminal.js';
import { aggregateWasmArbEconomicsBuckets } from './model.js';

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2
});

function compactUsd(value) {
  const amount = Number(value) || 0;
  if (Math.abs(amount) >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}m`;
  if (Math.abs(amount) >= 1_000) return `$${(amount / 1_000).toFixed(1)}k`;
  return usd.format(amount);
}

function label(value) {
  const date = new Date(value);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC'
  });
}

function regimeMarker(changeTime, rows) {
  return {
    id: 'wasmArbRegimeMarker',
    afterDatasetsDraw(chart) {
      const timestamp = Date.parse(changeTime || '');
      if (!Number.isFinite(timestamp)) return;
      const index = rows.findIndex((row) => Date.parse(row.bucketStart) >= timestamp);
      if (index < 0) return;
      const x = chart.scales.x.getPixelForValue(index);
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.strokeStyle = TERMINAL_CHART_PALETTE.amber;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = TERMINAL_CHART_PALETTE.amber;
      ctx.font = "9px 'JetBrains Mono'";
      ctx.fillText('MIMIR', Math.min(x + 5, chartArea.right - 35), chartArea.top + 10);
      ctx.restore();
    }
  };
}

function baseOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    animation: false,
    plugins: {
      legend: {
        position: 'top',
        align: 'end',
        labels: {
          color: TERMINAL_CHART_PALETTE.muted,
          font: terminalChartFont(9),
          boxWidth: 8,
          boxHeight: 8,
          padding: 14
        }
      },
      tooltip: {
        backgroundColor: TERMINAL_CHART_PALETTE.surface,
        borderColor: TERMINAL_CHART_PALETTE.border,
        borderWidth: 1,
        titleColor: TERMINAL_CHART_PALETTE.accent,
        bodyColor: TERMINAL_CHART_PALETTE.text,
        titleFont: terminalChartFont(10),
        bodyFont: terminalChartFont(10)
      }
    },
    scales: {
      x: {
        stacked: true,
        grid: { color: TERMINAL_CHART_PALETTE.grid },
        border: { color: TERMINAL_CHART_PALETTE.border },
        ticks: {
          color: TERMINAL_CHART_PALETTE.muted,
          font: terminalChartFont(9),
          maxTicksLimit: 9,
          maxRotation: 0
        }
      },
      y: {
        stacked: true,
        beginAtZero: true,
        grid: { color: TERMINAL_CHART_PALETTE.grid },
        border: { color: TERMINAL_CHART_PALETTE.border },
        ticks: {
          color: TERMINAL_CHART_PALETTE.muted,
          font: terminalChartFont(9),
          callback: compactUsd
        }
      }
    }
  };
}

export function renderWasmArbValueChart(canvas, previous, rows, changeTime) {
  previous?.destroy();
  if (!canvas) return null;
  const hourly = aggregateWasmArbEconomicsBuckets(rows, 60 * 60);
  const chart = new Chart(canvas.getContext('2d'), /** @type {any} */ ({
    type: 'bar',
    data: {
      labels: hourly.map((row) => label(row.bucketStart)),
      datasets: [
        {
          label: 'THOR LP fees',
          data: hourly.map((row) => row.wasmLiquidityFeeUsd),
          backgroundColor: 'rgba(0, 204, 102, 0.45)',
          borderColor: TERMINAL_CHART_PALETTE.accent,
          borderWidth: 1,
          borderRadius: 0,
          stack: 'tc'
        },
        {
          label: 'TC share of linked Rujira',
          data: hourly.map((row) => row.linkedTcReserveUsd),
          backgroundColor: 'rgba(212, 160, 23, 0.42)',
          borderColor: TERMINAL_CHART_PALETTE.amber,
          borderWidth: 1,
          borderRadius: 0,
          stack: 'tc'
        }
      ]
    },
    options: {
      ...baseOptions(),
      plugins: {
        ...baseOptions().plugins,
        tooltip: {
          ...baseOptions().plugins.tooltip,
          callbacks: {
            label(context) {
              return `${context.dataset.label}: ${usd.format(Number(context.raw) || 0)}`;
            },
            afterBody(items) {
              const row = hourly[items[0]?.dataIndex];
              return row ? [`TC linked total: ${usd.format(row.tcLinkedValueUsd)}`] : [];
            }
          }
        }
      }
    },
    plugins: [regimeMarker(changeTime, hourly)]
  }));
  return chart;
}

export function renderWasmArbEfficiencyChart(canvas, previous, rows, changeTime) {
  previous?.destroy();
  if (!canvas) return null;
  const hourly = aggregateWasmArbEconomicsBuckets(rows, 60 * 60);
  const options = baseOptions();
  options.scales.x.stacked = false;
  options.scales.y.stacked = false;
  options.scales.y.title = {
    display: true,
    text: 'TC USD / $1M NETWORK',
    color: TERMINAL_CHART_PALETTE.accent,
    font: terminalChartFont(9)
  };
  options.scales.y.ticks.callback = (value) => `$${Number(value).toFixed(0)}`;
  options.scales.share = {
    position: 'right',
    beginAtZero: true,
    grid: { drawOnChartArea: false },
    border: { color: TERMINAL_CHART_PALETTE.border },
    title: {
      display: true,
      text: 'WASM SHARE %',
      color: TERMINAL_CHART_PALETTE.info,
      font: terminalChartFont(9)
    },
    ticks: {
      color: TERMINAL_CHART_PALETTE.info,
      font: terminalChartFont(9),
      callback: (value) => `${Number(value).toFixed(2)}%`
    }
  };
  options.plugins.tooltip.callbacks = {
    label(context) {
      return context.dataset.yAxisID === 'share'
        ? `${context.dataset.label}: ${Number(context.raw).toFixed(3)}%`
        : `${context.dataset.label}: ${usd.format(Number(context.raw) || 0)}`;
    }
  };

  const chart = new Chart(canvas.getContext('2d'), /** @type {any} */ ({
    type: 'line',
    data: {
      labels: hourly.map((row) => label(row.bucketStart)),
      datasets: [
        {
          label: 'TC / $1m network',
          data: hourly.map((row) => row.tcPerMillionNetworkVolumeUsd),
          borderColor: TERMINAL_CHART_PALETTE.accent,
          backgroundColor: 'rgba(0, 204, 102, 0.06)',
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.15,
          fill: true,
          yAxisID: 'y'
        },
        {
          label: 'Wasm network volume share',
          data: hourly.map((row) => (row.wasmNetworkVolumeShare || 0) * 100),
          borderColor: TERMINAL_CHART_PALETTE.info,
          pointRadius: 0,
          borderWidth: 1.5,
          borderDash: [5, 4],
          tension: 0.15,
          fill: false,
          yAxisID: 'share'
        }
      ]
    },
    options,
    plugins: [regimeMarker(changeTime, hourly)]
  }));
  return chart;
}
