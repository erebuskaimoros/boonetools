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
  return `$${amount.toFixed(amount < 10 ? 2 : 0)}`;
}

function label(value, grainSeconds) {
  const date = new Date(value);
  return date.toLocaleString('en-US', grainSeconds >= 24 * 60 * 60
    ? {
        month: 'short',
        day: 'numeric',
        year: '2-digit',
        timeZone: 'UTC'
      }
    : {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'UTC'
      });
}

function milestoneLabel(row) {
  if (row?.changeKind?.includes('spread')) return `SPREAD ${row.spreadBps} BPS`;
  if (row?.changeKind?.includes('mimir')) return `MIMIR ${row.mimirValue} BPS`;
  return 'REGIME CHANGE';
}

function milestonePlugin(milestones, rows) {
  return {
    id: 'wasmArbMilestones',
    afterDatasetsDraw(chart) {
      if (!milestones?.length || !rows.length) return;
      const { ctx, chartArea } = chart;
      for (const milestone of milestones.slice(0, 6)) {
        const timestamp = Date.parse(milestone.activationTime || '');
        if (!Number.isFinite(timestamp)) continue;
        const index = rows.findIndex((row) => Date.parse(row.bucketStart) >= timestamp);
        if (index < 0) continue;
        const x = chart.scales.x.getPixelForValue(index);
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
        ctx.font = "10px 'JetBrains Mono'";
        ctx.fillText(
          milestoneLabel(milestone),
          Math.min(x + 5, chartArea.right - 94),
          chartArea.top + 12
        );
        ctx.restore();
      }
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
          font: terminalChartFont(11),
          boxWidth: 9,
          boxHeight: 9,
          padding: 16
        }
      },
      tooltip: {
        backgroundColor: TERMINAL_CHART_PALETTE.surface,
        borderColor: TERMINAL_CHART_PALETTE.border,
        borderWidth: 1,
        titleColor: TERMINAL_CHART_PALETTE.accent,
        bodyColor: TERMINAL_CHART_PALETTE.text,
        titleFont: terminalChartFont(12),
        bodyFont: terminalChartFont(12),
        padding: 10
      }
    },
    scales: {
      x: {
        grid: { color: TERMINAL_CHART_PALETTE.grid },
        border: { color: TERMINAL_CHART_PALETTE.border },
        ticks: {
          color: TERMINAL_CHART_PALETTE.muted,
          font: terminalChartFont(11),
          maxTicksLimit: 9,
          maxRotation: 0
        }
      },
      y: {
        beginAtZero: true,
        grid: { color: TERMINAL_CHART_PALETTE.grid },
        border: { color: TERMINAL_CHART_PALETTE.border },
        ticks: {
          color: TERMINAL_CHART_PALETTE.muted,
          font: terminalChartFont(11)
        }
      }
    }
  };
}

function chartRows(rows, grainSeconds) {
  return aggregateWasmArbEconomicsBuckets(rows, grainSeconds);
}

function partialBucketLine(row, grainSeconds) {
  if (!row?.partial) return [];
  const observedMinutes = Math.round((row.observedSeconds || 0) / 60);
  const grainMinutes = Math.round(grainSeconds / 60);
  return [`LIVE PARTIAL: ${observedMinutes}m of ${grainMinutes}m observed`];
}

export function renderWasmArbValueChart(
  canvas,
  previous,
  rows,
  grainSeconds,
  milestones = []
) {
  previous?.destroy();
  if (!canvas) return null;
  const series = chartRows(rows, grainSeconds);
  const options = baseOptions();
  options.scales.x.stacked = true;
  options.scales.y.stacked = true;
  options.scales.y.ticks.callback = compactUsd;
  options.plugins.tooltip.callbacks = {
    label(context) {
      return `${context.dataset.label}: ${usd.format(Number(context.raw) || 0)}`;
    },
    afterBody(items) {
      const row = series[items[0]?.dataIndex];
      return row
        ? [
            `Accrued TC value: ${usd.format(row.tcLinkedValueUsd)}`,
            ...partialBucketLine(row, grainSeconds)
          ]
        : [];
    }
  };

  return new Chart(canvas.getContext('2d'), /** @type {any} */ ({
    type: 'bar',
    data: {
      labels: series.map((row) => label(row.bucketStart, grainSeconds)),
      datasets: [
        {
          label: 'THOR pool fees',
          data: series.map((row) => row.wasmLiquidityFeeUsd),
          backgroundColor: series.map((row) => row.partial
            ? 'rgba(0, 204, 102, 0.2)'
            : 'rgba(0, 204, 102, 0.48)'),
          borderColor: TERMINAL_CHART_PALETTE.accent,
          borderWidth: 1,
          borderRadius: 0,
          maxBarThickness: 28,
          stack: 'tc-value'
        },
        {
          label: 'TC share of linked app fees',
          data: series.map((row) => row.linkedTcReserveUsd),
          backgroundColor: series.map((row) => row.partial
            ? 'rgba(212, 160, 23, 0.2)'
            : 'rgba(212, 160, 23, 0.46)'),
          borderColor: TERMINAL_CHART_PALETTE.amber,
          borderWidth: 1,
          borderRadius: 0,
          maxBarThickness: 28,
          stack: 'tc-value'
        }
      ]
    },
    options,
    plugins: [milestonePlugin(milestones, series)]
  }));
}

export function renderWasmArbActivityChart(
  canvas,
  previous,
  rows,
  grainSeconds,
  milestones = []
) {
  previous?.destroy();
  if (!canvas) return null;
  const series = chartRows(rows, grainSeconds);
  const options = baseOptions();
  options.scales.y.ticks.callback = compactUsd;
  options.scales.y.title = {
    display: true,
    text: 'WASM EXECUTED-LEG VOLUME',
    color: TERMINAL_CHART_PALETTE.accent,
    font: terminalChartFont(11)
  };
  options.scales.share = {
    position: 'right',
    beginAtZero: true,
    grid: { drawOnChartArea: false },
    border: { color: TERMINAL_CHART_PALETTE.border },
    title: {
      display: true,
      text: 'NETWORK SHARE',
      color: TERMINAL_CHART_PALETTE.info,
      font: terminalChartFont(11)
    },
    ticks: {
      color: TERMINAL_CHART_PALETTE.info,
      font: terminalChartFont(11),
      callback: (value) => `${Number(value).toFixed(2)}%`
    }
  };
  options.plugins.tooltip.callbacks = {
    label(context) {
      return context.dataset.yAxisID === 'share'
        ? `${context.dataset.label}: ${Number(context.raw).toFixed(3)}%`
        : `${context.dataset.label}: ${usd.format(Number(context.raw) || 0)}`;
    },
    afterBody(items) {
      return partialBucketLine(series[items[0]?.dataIndex], grainSeconds);
    }
  };

  return new Chart(canvas.getContext('2d'), /** @type {any} */ ({
    type: 'bar',
    data: {
      labels: series.map((row) => label(row.bucketStart, grainSeconds)),
      datasets: [
        {
          type: 'bar',
          label: 'Wasm volume',
          data: series.map((row) => row.wasmLegVolumeUsd),
          backgroundColor: series.map((row) => row.partial
            ? 'rgba(0, 204, 102, 0.16)'
            : 'rgba(0, 204, 102, 0.34)'),
          borderColor: TERMINAL_CHART_PALETTE.accent,
          borderWidth: 1,
          borderRadius: 0,
          maxBarThickness: 28,
          yAxisID: 'y'
        },
        {
          type: 'line',
          label: 'Wasm share of network volume',
          data: series.map((row) => (row.wasmNetworkVolumeShare || 0) * 100),
          borderColor: TERMINAL_CHART_PALETTE.info,
          pointRadius: 0,
          borderWidth: 2,
          borderDash: [5, 4],
          tension: 0.12,
          fill: false,
          yAxisID: 'share'
        }
      ]
    },
    options,
    plugins: [milestonePlugin(milestones, series)]
  }));
}

export function renderWasmArbEfficiencyChart(
  canvas,
  previous,
  rows,
  grainSeconds,
  milestones = []
) {
  previous?.destroy();
  if (!canvas) return null;
  const series = chartRows(rows, grainSeconds);
  const options = baseOptions();
  options.scales.y.ticks.callback = compactUsd;
  options.scales.y.title = {
    display: true,
    text: 'TC VALUE / $1M WASM',
    color: TERMINAL_CHART_PALETTE.amber,
    font: terminalChartFont(11)
  };
  options.scales.network = {
    position: 'right',
    beginAtZero: true,
    grid: { drawOnChartArea: false },
    border: { color: TERMINAL_CHART_PALETTE.border },
    title: {
      display: true,
      text: 'TC VALUE / $1M NETWORK',
      color: TERMINAL_CHART_PALETTE.accent,
      font: terminalChartFont(11)
    },
    ticks: {
      color: TERMINAL_CHART_PALETTE.accent,
      font: terminalChartFont(11),
      callback: compactUsd
    }
  };
  options.plugins.tooltip.callbacks = {
    label(context) {
      return `${context.dataset.label}: ${usd.format(Number(context.raw) || 0)}`;
    }
  };

  return new Chart(canvas.getContext('2d'), /** @type {any} */ ({
    type: 'line',
    data: {
      labels: series.map((row) => label(row.bucketStart, grainSeconds)),
      datasets: [
        {
          label: 'TC / $1m Wasm volume',
          data: series.map((row) => row.tcPerMillionWasmVolumeUsd),
          borderColor: TERMINAL_CHART_PALETTE.amber,
          backgroundColor: 'rgba(212, 160, 23, 0.06)',
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.12,
          fill: false,
          yAxisID: 'y'
        },
        {
          label: 'TC / $1m network volume',
          data: series.map((row) => row.tcPerMillionNetworkVolumeUsd),
          borderColor: TERMINAL_CHART_PALETTE.accent,
          backgroundColor: 'rgba(0, 204, 102, 0.06)',
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.12,
          fill: false,
          yAxisID: 'network'
        }
      ]
    },
    options,
    plugins: [milestonePlugin(milestones, series)]
  }));
}

export function renderWasmArbFeeBehaviorChart(
  canvas,
  previous,
  rows,
  grainSeconds,
  milestones = []
) {
  previous?.destroy();
  if (!canvas) return null;
  const series = chartRows(rows, grainSeconds);
  const options = baseOptions();
  options.scales.y.title = {
    display: true,
    text: 'BASIS POINTS',
    color: TERMINAL_CHART_PALETTE.muted,
    font: terminalChartFont(11)
  };
  options.scales.y.ticks.callback = (value) => `${Number(value).toFixed(1)}`;
  options.plugins.tooltip.callbacks = {
    label(context) {
      return `${context.dataset.label}: ${Number(context.raw).toFixed(2)} bps`;
    }
  };

  return new Chart(canvas.getContext('2d'), /** @type {any} */ ({
    type: 'line',
    data: {
      labels: series.map((row) => label(row.bucketStart, grainSeconds)),
      datasets: [
        {
          label: 'THOR fee / Wasm leg volume',
          data: series.map((row) => row.wasmLegFeeBps),
          borderColor: TERMINAL_CHART_PALETTE.accent,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.12
        },
        {
          label: 'Median action slip',
          data: series.map((row) => row.medianSlipBps),
          borderColor: TERMINAL_CHART_PALETTE.info,
          pointRadius: 0,
          borderWidth: 1.5,
          borderDash: [4, 3],
          tension: 0.12
        },
        {
          label: 'P90 action slip',
          data: series.map((row) => row.p90SlipBps),
          borderColor: TERMINAL_CHART_PALETTE.amber,
          pointRadius: 0,
          borderWidth: 1.5,
          borderDash: [7, 3],
          tension: 0.12
        }
      ]
    },
    options,
    plugins: [milestonePlugin(milestones, series)]
  }));
}

export function renderWasmArbOracleChart(
  canvas,
  previous,
  rows,
  grainSeconds,
  milestones = []
) {
  previous?.destroy();
  if (!canvas) return null;
  const series = chartRows(rows, grainSeconds);
  const options = baseOptions();
  options.scales.y.title = {
    display: true,
    text: 'DEPTH-WEIGHTED ABS DEVIATION',
    color: TERMINAL_CHART_PALETTE.amber,
    font: terminalChartFont(11)
  };
  options.scales.y.ticks.callback = (value) => `${Number(value).toFixed(1)} bps`;
  options.scales.share = {
    position: 'right',
    min: 0,
    max: 100,
    grid: { drawOnChartArea: false },
    border: { color: TERMINAL_CHART_PALETTE.border },
    title: {
      display: true,
      text: 'WITHIN 10 BPS',
      color: TERMINAL_CHART_PALETTE.info,
      font: terminalChartFont(11)
    },
    ticks: {
      color: TERMINAL_CHART_PALETTE.info,
      font: terminalChartFont(11),
      callback: (value) => `${Number(value).toFixed(0)}%`
    }
  };
  options.plugins.tooltip.callbacks = {
    label(context) {
      return context.dataset.yAxisID === 'share'
        ? `${context.dataset.label}: ${Number(context.raw).toFixed(1)}%`
        : `${context.dataset.label}: ${Number(context.raw).toFixed(2)} bps`;
    }
  };

  return new Chart(canvas.getContext('2d'), /** @type {any} */ ({
    type: 'line',
    data: {
      labels: series.map((row) => label(row.bucketStart, grainSeconds)),
      datasets: [
        {
          label: 'All comparable pools',
          data: series.map((row) => row.priceTracking.depthWeightedAbsoluteDeviationBps),
          borderColor: TERMINAL_CHART_PALETTE.amber,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.12,
          yAxisID: 'y'
        },
        {
          label: 'Excluding LTC',
          data: series.map(
            (row) => row.priceTrackingExcludingLtc.depthWeightedAbsoluteDeviationBps
          ),
          borderColor: TERMINAL_CHART_PALETTE.accent,
          pointRadius: 0,
          borderWidth: 1.5,
          borderDash: [5, 4],
          tension: 0.12,
          yAxisID: 'y'
        },
        {
          label: 'Samples within 10 bps',
          data: series.map((row) => (row.priceTracking.within10Share || 0) * 100),
          borderColor: TERMINAL_CHART_PALETTE.info,
          pointRadius: 0,
          borderWidth: 1.5,
          tension: 0.12,
          yAxisID: 'share'
        }
      ]
    },
    options,
    plugins: [milestonePlugin(milestones, series)]
  }));
}
