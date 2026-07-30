import Chart from 'chart.js/auto';
import { formatNumber, formatUSD } from '../utils/formatting.js';
import { TERMINAL_CHART_PALETTE } from '../charts/terminal.js';
import {
  formatTcFeeBps,
  formatTcFeeUsdCompact,
  tcFeePointColor
} from './presentation.js';

const chartWithTooltip = /** @type {any} */ (Chart);
const tooltipPlugin = Chart?.registry?.plugins?.get?.('tooltip') || chartWithTooltip.Tooltip;
if (tooltipPlugin?.positioners) {
  tooltipPlugin.positioners.cursor = function (elements, eventPosition) {
    if (eventPosition && Number.isFinite(eventPosition.x) && Number.isFinite(eventPosition.y)) {
      return { x: eventPosition.x, y: eventPosition.y };
    }
    if (elements?.length) return { x: elements[0].element.x, y: elements[0].element.y };
    return false;
  };
}

const activePointPlugin = {
  id: 'tcFeeActivePoint',
  afterDraw(chart) {
    const activeElements = chart.tooltip?.getActiveElements?.() || [];
    if (!activeElements.length) return;

    const { ctx, chartArea } = chart;
    ctx.save();
    for (const active of activeElements) {
      if (!chart.isDatasetVisible(active.datasetIndex)) continue;
      const meta = chart.getDatasetMeta(active.datasetIndex);
      const element = meta?.data?.[active.index];
      if (!element || element.skip) continue;
      const point = typeof element.getProps === 'function'
        ? element.getProps(['x', 'y'], true)
        : element;
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      if (
        point.x < chartArea.left ||
        point.x > chartArea.right ||
        point.y < chartArea.top ||
        point.y > chartArea.bottom
      ) continue;

      const dataset = chart.data.datasets[active.datasetIndex] || {};
      const pointBackground = dataset.pointBackgroundColor;
      const accentColor = Array.isArray(pointBackground)
        ? pointBackground[active.index] || dataset.borderColor || TERMINAL_CHART_PALETTE.accent
        : pointBackground || dataset.borderColor || TERMINAL_CHART_PALETTE.accent;
      const radius = active.datasetIndex === 0 ? 7 : 5.5;

      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(8, 8, 8, 0.96)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = accentColor;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(2.5, radius - 4), 0, Math.PI * 2);
      ctx.fillStyle = accentColor;
      ctx.fill();
    }
    ctx.restore();
  }
};

const haltBandPlugin = {
  id: 'tcFeeHaltBand',
  beforeDatasetsDraw(chart, _args, options) {
    const bands = Array.isArray(options?.bands) ? options.bands : [];
    if (!bands.length) return;
    const { ctx, chartArea, scales } = chart;
    const xScale = scales.x;
    const labels = chart.data.labels || [];
    if (!xScale || !labels.length) return;

    ctx.save();
    ctx.font = '600 11px JetBrains Mono, monospace';
    ctx.textBaseline = 'top';
    for (const band of bands) {
      const startIndex = Math.max(0, Math.min(Number(band.startIndex) || 0, labels.length - 1));
      const endIndex = Math.max(startIndex, Math.min(Number(band.endIndex) || startIndex, labels.length - 1));
      const startCenter = xScale.getPixelForValue(startIndex);
      const endCenter = xScale.getPixelForValue(endIndex);
      const previousCenter = startIndex > 0
        ? xScale.getPixelForValue(startIndex - 1)
        : startCenter - Math.max(12, xScale.width / Math.max(1, labels.length));
      const nextCenter = endIndex < labels.length - 1
        ? xScale.getPixelForValue(endIndex + 1)
        : endCenter + Math.max(12, xScale.width / Math.max(1, labels.length));
      const left = Math.max(
        chartArea.left,
        startIndex === 0 ? chartArea.left : (previousCenter + startCenter) / 2
      );
      const right = Math.min(
        chartArea.right,
        endIndex === labels.length - 1 ? chartArea.right : (endCenter + nextCenter) / 2
      );
      const width = Math.max(0, right - left);
      if (width <= 0) continue;

      ctx.fillStyle = 'rgba(212, 160, 23, 0.09)';
      ctx.fillRect(left, chartArea.top, width, chartArea.bottom - chartArea.top);
      ctx.strokeStyle = 'rgba(212, 160, 23, 0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, chartArea.top);
      ctx.lineTo(left, chartArea.bottom);
      ctx.moveTo(right, chartArea.top);
      ctx.lineTo(right, chartArea.bottom);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(212, 160, 23, 0.14)';
      for (let x = left - (chartArea.bottom - chartArea.top); x < right; x += 10) {
        ctx.beginPath();
        ctx.moveTo(x, chartArea.bottom);
        ctx.lineTo(x + chartArea.bottom - chartArea.top, chartArea.top);
        ctx.stroke();
      }

      if (width >= 58) {
        ctx.fillStyle = '#d4a017';
        ctx.fillText(String(band.label || 'CHAIN HALT').toUpperCase(), left + 6, chartArea.top + 6);
      }
    }
    ctx.restore();
  }
};

function drawNavigatorHandle(context, x, height, direction) {
  context.strokeStyle = '#00cc66';
  context.fillStyle = '#00cc66';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(x, 0);
  context.lineTo(x, height);
  context.stroke();
  const tick = 5;
  context.beginPath();
  context.moveTo(x, 0.5);
  context.lineTo(x + tick * direction, 0.5);
  context.moveTo(x, height - 0.5);
  context.lineTo(x + tick * direction, height - 0.5);
  context.stroke();
  const gripY = height / 2;
  for (let offset = -3; offset <= 3; offset += 3) {
    context.fillRect(x - 1, gripY + offset, 2, 1);
  }
}

export function drawTcFeeNavigator(canvas, rows, startIndex, endIndex) {
  if (!canvas || typeof window === 'undefined') return;
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  if (!cssWidth || !cssHeight) return;
  if (canvas.width !== cssWidth * ratio || canvas.height !== cssHeight * ratio) {
    canvas.width = cssWidth * ratio;
    canvas.height = cssHeight * ratio;
  }

  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);
  const count = rows.length;
  if (!count) return;

  const padY = 4;
  const innerHeight = cssHeight - padY * 2;
  const values = rows.map((row) => Number(row.feesPerBillionUsd) || 0);
  const maxValue = Math.max(1, ...values);
  const xAt = (index) => count === 1 ? cssWidth / 2 : (index / (count - 1)) * cssWidth;
  const yAt = (value) => padY + innerHeight - (value / maxValue) * innerHeight;

  context.beginPath();
  context.moveTo(0, cssHeight);
  for (let index = 0; index < count; index += 1) context.lineTo(xAt(index), yAt(values[index]));
  context.lineTo(cssWidth, cssHeight);
  context.closePath();
  context.fillStyle = 'rgba(0, 204, 102, 0.04)';
  context.fill();

  context.beginPath();
  for (let index = 0; index < count; index += 1) {
    const x = xAt(index);
    const y = yAt(values[index]);
    index === 0 ? context.moveTo(x, y) : context.lineTo(x, y);
  }
  context.strokeStyle = '#1f4f37';
  context.lineWidth = 1;
  context.stroke();

  const startX = xAt(startIndex);
  const endX = xAt(endIndex);
  context.fillStyle = 'rgba(8, 8, 8, 0.55)';
  context.fillRect(0, 0, startX, cssHeight);
  context.fillRect(endX, 0, cssWidth - endX, cssHeight);

  context.save();
  context.beginPath();
  context.rect(startX, 0, Math.max(0, endX - startX), cssHeight);
  context.clip();
  context.beginPath();
  context.moveTo(0, cssHeight);
  for (let index = 0; index < count; index += 1) context.lineTo(xAt(index), yAt(values[index]));
  context.lineTo(cssWidth, cssHeight);
  context.closePath();
  context.fillStyle = 'rgba(0, 204, 102, 0.18)';
  context.fill();
  context.beginPath();
  for (let index = 0; index < count; index += 1) {
    const x = xAt(index);
    const y = yAt(values[index]);
    index === 0 ? context.moveTo(x, y) : context.lineTo(x, y);
  }
  context.strokeStyle = '#00cc66';
  context.lineWidth = 1.4;
  context.stroke();
  context.restore();

  drawNavigatorHandle(context, startX, cssHeight, 1);
  drawNavigatorHandle(context, endX, cssHeight, -1);
}

export function tcFeeNavigatorIndexFromPixel(pixel, width, rowCount) {
  if (rowCount <= 1) return 0;
  const ratio = Math.max(0, Math.min(1, pixel / width));
  return Math.round(ratio * (rowCount - 1));
}

export function createTcFeeChart(canvas, { series, rollingSeries }) {
  if (!canvas || !series.rows.length) return null;
  const isNarrowChart = canvas.clientWidth < 520;
  const isDenseChart = series.rows.length > 90;

  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    plugins: [haltBandPlugin, activePointPlugin],
    data: {
      labels: series.labels,
      datasets: [
        {
          label: 'TC fees per $1B volume',
          data: series.feesPerBillionUsd,
          borderColor: TERMINAL_CHART_PALETTE.accent,
          backgroundColor: 'rgba(0, 204, 102, 0.08)',
          pointBackgroundColor: series.rows.map(tcFeePointColor),
          pointBorderColor: '#080808',
          pointBorderWidth: isDenseChart ? 0 : 2,
          pointRadius: series.rows.map((row) => (
            row.hasHaltDays ? (isDenseChart ? 0 : 3.5) : row.feeBps < 5 ? 0 : isDenseChart ? 0 : 5
          )),
          pointHoverRadius: series.rows.map((row) => (
            row.hasHaltDays ? 6 : row.feeBps < 5 ? 0 : isDenseChart ? 5 : 7
          )),
          pointStyle: series.rows.map((row) => row.hasHaltDays ? 'rectRot' : 'circle'),
          borderWidth: isDenseChart ? 1.5 : 2,
          tension: isDenseChart ? 0.08 : 0.25,
          fill: true
        },
        ...rollingSeries.map((option) => ({
          label: `${option.label} rolling avg`,
          data: option.data,
          borderColor: option.color,
          backgroundColor: 'transparent',
          borderDash: option.dash,
          borderWidth: isDenseChart ? 1.6 : 1.9,
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: isDenseChart ? 0.08 : 0.18,
          rollingDays: option.days
        }))
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: /** @type {any} */ ({
        legend: { display: false },
        tooltip: {
          backgroundColor: '#080808',
          borderColor: '#1a1a1a',
          borderWidth: 1,
          titleColor: '#ffffff',
          bodyColor: '#f5f5f5',
          titleFont: { family: 'JetBrains Mono', size: 12, weight: 700 },
          bodyFont: { family: 'JetBrains Mono', size: 12, weight: 500 },
          displayColors: false,
          position: /** @type {any} */ ('cursor'),
          caretSize: 0,
          caretPadding: 14,
          xAlign: 'left',
          yAlign: 'bottom',
          callbacks: {
            title(items) {
              return items[0]?.label || '';
            },
            label(context) {
              const dataset = /** @type {any} */ (context.dataset);
              if (dataset.rollingDays) {
                if (context.parsed.y == null) return '';
                return `${dataset.rollingDays}d rolling avg: ${formatUSD(context.parsed.y)} · halt days excluded`;
              }

              const row = series.rows[context.dataIndex];
              if (!row) return '';
              const lines = [
                `fees / $1B: ${formatUSD(row.feesPerBillionUsd)}`,
                `TC fees: ${formatUSD(row.tcFeesUsd)}`,
                `CMC + Dune volume: ${formatTcFeeUsdCompact(row.globalExchangeVolumeUsd)}`
              ];
              if (row.feeBps > 0) {
                lines.splice(1, 0, `fee setting: ${formatNumber(row.feeBps, { maximumFractionDigits: 0 })} bps`);
              }
              if (row.cmcVolume24hUsd > 0) lines.push(`CMC volume: ${formatTcFeeUsdCompact(row.cmcVolume24hUsd)}`);
              if (row.defillamaDexVolumeUsd > 0) lines.push(`Dune DEX volume: ${formatTcFeeUsdCompact(row.defillamaDexVolumeUsd)}`);
              if (row.hasHaltDays) lines.push(`${row.haltLabel || 'chain halt'}: excluded from rolling averages`);
              return lines;
            }
          }
        },
        tcFeeHaltBand: { bands: series.haltBands || [] }
      }),
      scales: {
        x: {
          grid: { color: '#111111' },
          ticks: {
            color: '#c8c8c8',
            maxTicksLimit: isNarrowChart ? 5 : 7,
            maxRotation: 0,
            autoSkip: !isNarrowChart,
            font: { family: 'JetBrains Mono', size: 11 },
            callback(value, index) {
              const label = series.labels[index] || this.getLabelForValue(Number(value));
              if (!isNarrowChart) return label;
              if (index % 4 !== 0) return '';
              return label.split('-')[0]?.trim() || label;
            }
          }
        },
        y: {
          beginAtZero: false,
          grid: { color: '#111111' },
          ticks: {
            color: '#c8c8c8',
            font: { family: 'JetBrains Mono', size: 11 },
            callback(value) {
              return `$${formatNumber(Number(value), { maximumFractionDigits: 0 })}`;
            }
          }
        }
      }
    }
  });
}

export function createTcFeeIncomeVolumeChart(canvas, { series, rollingSeries }) {
  if (!canvas || !series.rows.length) return null;
  const isNarrowChart = canvas.clientWidth < 520;
  const isDenseChart = series.rows.length > 90;

  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    plugins: [haltBandPlugin, activePointPlugin],
    data: {
      labels: series.labels,
      datasets: [
        {
          label: 'Liquidity fee income / THORChain volume',
          data: series.incomeVolumeBps,
          borderColor: '#d4a017',
          backgroundColor: 'rgba(212, 160, 23, 0.08)',
          pointBackgroundColor: series.rows.map((row) => row.hasHaltDays ? '#d4a017' : '#00cc66'),
          pointBorderColor: '#080808',
          pointBorderWidth: isDenseChart ? 0 : 2,
          pointRadius: isDenseChart ? 0 : 4,
          pointHoverRadius: isDenseChart ? 5 : 7,
          borderWidth: isDenseChart ? 1.5 : 2,
          tension: isDenseChart ? 0.08 : 0.25,
          spanGaps: false,
          fill: true
        },
        ...rollingSeries.map((option) => ({
          label: `${option.label} rolling avg`,
          data: option.data,
          borderColor: option.color,
          backgroundColor: 'transparent',
          borderDash: option.dash,
          borderWidth: isDenseChart ? 1.6 : 1.9,
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: isDenseChart ? 0.08 : 0.18,
          rollingDays: option.days
        }))
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: /** @type {any} */ ({
        legend: { display: false },
        tooltip: {
          backgroundColor: '#080808',
          borderColor: '#1a1a1a',
          borderWidth: 1,
          titleColor: '#ffffff',
          bodyColor: '#f5f5f5',
          titleFont: { family: 'JetBrains Mono', size: 12, weight: 700 },
          bodyFont: { family: 'JetBrains Mono', size: 12, weight: 500 },
          displayColors: false,
          position: /** @type {any} */ ('cursor'),
          caretSize: 0,
          caretPadding: 14,
          xAlign: 'left',
          yAlign: 'bottom',
          callbacks: {
            title(items) {
              return items[0]?.label || '';
            },
            label(context) {
              const dataset = /** @type {any} */ (context.dataset);
              if (dataset.rollingDays) {
                if (context.parsed.y == null) return '';
                return `${dataset.rollingDays}d rolling avg: ${formatTcFeeBps(context.parsed.y)} · halt days excluded`;
              }
              const row = series.rows[context.dataIndex];
              if (!row || row.incomeVolumeBps == null) return 'income / volume: unavailable';
              return [
                `income / volume: ${formatTcFeeBps(row.incomeVolumeBps)}`,
                `liquidity fee income: ${formatUSD(row.tcFeesUsd)}`,
                `THORChain volume: ${formatTcFeeUsdCompact(row.thorchainVolumeUsd)}`
              ];
            }
          }
        },
        tcFeeHaltBand: { bands: series.haltBands || [] }
      }),
      scales: {
        x: {
          grid: { color: '#111111' },
          ticks: {
            color: '#c8c8c8',
            maxTicksLimit: isNarrowChart ? 5 : 7,
            maxRotation: 0,
            autoSkip: !isNarrowChart,
            font: { family: 'JetBrains Mono', size: 11 },
            callback(value, index) {
              const label = series.labels[index] || this.getLabelForValue(Number(value));
              if (!isNarrowChart) return label;
              if (index % 4 !== 0) return '';
              return label.split('-')[0]?.trim() || label;
            }
          }
        },
        y: {
          beginAtZero: true,
          grid: { color: '#111111' },
          ticks: {
            color: '#c8c8c8',
            font: { family: 'JetBrains Mono', size: 11 },
            callback(value) {
              return formatTcFeeBps(value);
            }
          }
        }
      }
    }
  });
}
