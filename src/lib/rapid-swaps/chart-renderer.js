import Chart from 'chart.js/auto';
import { SankeyController, Flow } from 'chartjs-chart-sankey';
import { formatNumber, formatUSDCompact } from '../utils/formatting.js';
import { TERMINAL_CHART_PALETTE } from '../charts/terminal.js';
import { affiliateUrl, formatTimeSaved } from './presentation.js';

Chart.register(SankeyController, Flow);

export const RAPID_SWAP_CHART_COLORS = Object.freeze({
  green: TERMINAL_CHART_PALETTE.accent,
  greenAlpha: 'rgba(0, 204, 102, 0.3)',
  amber: TERMINAL_CHART_PALETTE.amber,
  amberAlpha: 'rgba(212, 160, 23, 0.3)',
  blue: TERMINAL_CHART_PALETTE.info,
  blueAlpha: 'rgba(85, 136, 204, 0.3)',
  red: '#cc4444',
  redAlpha: 'rgba(204, 68, 68, 0.3)',
  yellow: '#cccc33',
  yellowAlpha: 'rgba(204, 204, 51, 0.3)',
  grid: TERMINAL_CHART_PALETTE.border,
  text: TERMINAL_CHART_PALETTE.muted,
  bg: TERMINAL_CHART_PALETTE.surfaceHover
});

export const rapidSwapBaseChartOptions = Object.freeze({
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 300 },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: '#1a1a1a',
      titleColor: '#ccc',
      bodyColor: '#aaa',
      borderColor: '#333',
      borderWidth: 1,
      titleFont: { family: 'JetBrains Mono', size: 11 },
      bodyFont: { family: 'JetBrains Mono', size: 11 },
      padding: 8
    }
  },
  scales: {
    x: {
      grid: { color: RAPID_SWAP_CHART_COLORS.grid },
      ticks: {
        color: RAPID_SWAP_CHART_COLORS.text,
        font: { family: 'JetBrains Mono', size: 10 }
      }
    },
    y: {
      grid: { color: RAPID_SWAP_CHART_COLORS.grid },
      ticks: {
        color: RAPID_SWAP_CHART_COLORS.text,
        font: { family: 'JetBrains Mono', size: 10 }
      }
    }
  }
});

const affiliateLabelHoverPlugin = {
  id: 'affLabelHover',
  afterDraw(chart) {
    const hoveredIndex = chart._affHoveredIdx;
    if (hoveredIndex == null) return;
    const yScale = chart.scales.y;
    const label = chart.data.labels[hoveredIndex];
    if (!yScale || !label) return;

    const yPosition = yScale.getPixelForValue(hoveredIndex);
    const context = chart.ctx;
    context.save();
    context.font = '11px JetBrains Mono';
    const textWidth = context.measureText(label).width;
    const xEnd = yScale.right - 8;
    context.strokeStyle = '#5588cc';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(xEnd - textWidth, yPosition + 5);
    context.lineTo(xEnd, yPosition + 5);
    context.stroke();
    context.restore();
  }
};

export function createRapidSwapChartRenderer() {
  const instances = {};
  const interactionCleanup = {};

  function destroyChart(id) {
    interactionCleanup[id]?.();
    delete interactionCleanup[id];
    instances[id]?.destroy();
    delete instances[id];
  }

  function createChart(canvasId, config) {
    destroyChart(canvasId);
    const canvas = document.getElementById(canvasId);
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    instances[canvasId] = new Chart(canvas, config);
    return instances[canvasId];
  }

  function attachAffiliateLabelInteraction(canvasId, codes) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    function getYAxisIndex(event) {
      const chart = instances[canvasId];
      if (!chart) return null;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const yScale = chart.scales.y;
      if (!yScale || x >= yScale.right || y < yScale.top || y > yScale.bottom) return null;
      return yScale.getValueForPixel(y);
    }

    const onClick = (event) => {
      const index = getYAxisIndex(event);
      if (index != null && codes[index]) window.open(affiliateUrl(codes[index]), '_blank');
    };
    const onMouseMove = (event) => {
      const chart = instances[canvasId];
      if (!chart) return;
      const index = getYAxisIndex(event);
      const previous = chart._affHoveredIdx;
      chart._affHoveredIdx = index;
      canvas.style.cursor = index != null ? 'pointer' : '';
      if (index !== previous) chart.draw();
    };
    const onMouseLeave = () => {
      const chart = instances[canvasId];
      if (!chart) return;
      chart._affHoveredIdx = null;
      canvas.style.cursor = '';
      chart.draw();
    };

    canvas.addEventListener('click', onClick);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);
    interactionCleanup[canvasId] = () => {
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseleave', onMouseLeave);
    };
  }

  function renderOverview({
    dailyData,
    cumulativeVolumeAxisBounds = {},
    cumulativeCountAxisBounds = {},
    hasAdoptionData = false
  }) {
    if (!dailyData.labels.length) return;
    const colors = RAPID_SWAP_CHART_COLORS;
    const base = rapidSwapBaseChartOptions;

    createChart('chart-daily-volume', {
      type: 'bar',
      data: {
        labels: dailyData.labels,
        datasets: [
          {
            label: 'Volume',
            data: dailyData.volume,
            backgroundColor: colors.greenAlpha,
            borderColor: colors.green,
            borderWidth: 1,
            yAxisID: 'y',
            order: 2
          },
          {
            label: 'Cumulative',
            data: dailyData.cumVolume,
            type: 'line',
            borderColor: colors.amber,
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: colors.amber,
            yAxisID: 'y1',
            order: 1
          }
        ]
      },
      options: {
        ...base,
        plugins: {
          ...base.plugins,
          legend: {
            display: true,
            labels: { color: colors.text, font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 12 }
          },
          tooltip: {
            ...base.plugins.tooltip,
            callbacks: { label: (context) => `${context.dataset.label}: ${formatUSDCompact(context.parsed.y)}` }
          }
        },
        scales: {
          x: base.scales.x,
          y: {
            ...base.scales.y,
            position: 'left',
            ticks: { ...base.scales.y.ticks, callback: (value) => formatUSDCompact(value) }
          },
          y1: {
            ...base.scales.y,
            position: 'right',
            grid: { drawOnChartArea: false, color: colors.grid },
            ticks: { ...base.scales.y.ticks, callback: (value) => formatUSDCompact(value) },
            ...cumulativeVolumeAxisBounds
          }
        }
      }
    });

    createChart('chart-daily-count', {
      type: 'bar',
      data: {
        labels: dailyData.labels,
        datasets: [
          {
            label: 'Count',
            data: dailyData.count,
            backgroundColor: colors.blueAlpha,
            borderColor: colors.blue,
            borderWidth: 1,
            yAxisID: 'y',
            order: 2
          },
          {
            label: 'Cumulative',
            data: dailyData.cumCount,
            type: 'line',
            borderColor: colors.amber,
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: colors.amber,
            yAxisID: 'y1',
            order: 1
          }
        ]
      },
      options: {
        ...base,
        plugins: {
          ...base.plugins,
          legend: {
            display: true,
            labels: { color: colors.text, font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 12 }
          },
          tooltip: {
            ...base.plugins.tooltip,
            callbacks: { label: (context) => `${context.dataset.label}: ${formatNumber(context.parsed.y)}` }
          }
        },
        scales: {
          x: base.scales.x,
          y: { ...base.scales.y, position: 'left', beginAtZero: true },
          y1: {
            ...base.scales.y,
            position: 'right',
            grid: { drawOnChartArea: false, color: colors.grid },
            ...cumulativeCountAxisBounds
          }
        }
      }
    });

    createChart('chart-efficiency', {
      type: 'line',
      data: {
        labels: dailyData.labels,
        datasets: [
          {
            label: 'Efficiency',
            data: dailyData.efficiency,
            borderColor: colors.green,
            backgroundColor: colors.greenAlpha,
            fill: true,
            borderWidth: 2,
            pointRadius: 4,
            pointBackgroundColor: colors.green,
            tension: 0.3
          }
        ]
      },
      options: {
        ...base,
        scales: { x: base.scales.x, y: { ...base.scales.y, beginAtZero: false } }
      }
    });

    createChart('chart-pct-faster', {
      type: 'line',
      data: {
        labels: dailyData.labels,
        datasets: [
          {
            label: '% Faster',
            data: dailyData.pctFaster,
            borderColor: colors.amber,
            backgroundColor: colors.amberAlpha,
            fill: true,
            borderWidth: 2,
            pointRadius: 4,
            pointBackgroundColor: colors.amber,
            tension: 0.3
          }
        ]
      },
      options: {
        ...base,
        scales: {
          x: base.scales.x,
          y: {
            ...base.scales.y,
            ticks: { ...base.scales.y.ticks, callback: (value) => `${value}%` }
          }
        }
      }
    });

    destroyChart('chart-market-share-volume');
    destroyChart('chart-market-share-count');
    if (!hasAdoptionData) return;

    const marketShareOptions = {
      ...base,
      scales: {
        x: base.scales.x,
        y: {
          ...base.scales.y,
          beginAtZero: true,
          ticks: { ...base.scales.y.ticks, callback: (value) => `${value}%` }
        }
      },
      plugins: {
        ...base.plugins,
        tooltip: {
          ...base.plugins.tooltip,
          callbacks: { label: (context) => `${context.dataset.label}: ${context.parsed.y}%` }
        }
      }
    };

    createChart('chart-market-share-volume', {
      type: 'bar',
      data: {
        labels: dailyData.labels,
        datasets: [
          {
            label: '% of TC Volume',
            data: dailyData.volumePct,
            backgroundColor: colors.yellowAlpha,
            borderColor: colors.yellow,
            borderWidth: 1
          }
        ]
      },
      options: marketShareOptions
    });
    createChart('chart-market-share-count', {
      type: 'bar',
      data: {
        labels: dailyData.labels,
        datasets: [
          {
            label: '% of TC Swaps',
            data: dailyData.countPct,
            backgroundColor: colors.redAlpha,
            borderColor: colors.red,
            borderWidth: 1
          }
        ]
      },
      options: marketShareOptions
    });
  }

  function renderDistributions(distributions) {
    if (!distributions.subLabels.length) return;
    const colors = RAPID_SWAP_CHART_COLORS;
    const base = rapidSwapBaseChartOptions;

    createChart('chart-subs-volume', {
      type: 'bar',
      data: {
        labels: distributions.subLabels,
        datasets: [{
          label: 'Volume',
          data: distributions.subsByVolume,
          backgroundColor: colors.greenAlpha,
          borderColor: colors.green,
          borderWidth: 1
        }]
      },
      options: {
        ...base,
        scales: {
          x: base.scales.x,
          y: { ...base.scales.y, ticks: { ...base.scales.y.ticks, callback: (value) => formatUSDCompact(value) } }
        }
      }
    });

    createChart('chart-subs-count', {
      type: 'bar',
      data: {
        labels: distributions.subLabels,
        datasets: [{
          label: 'TX Count',
          data: distributions.subsByCount,
          backgroundColor: colors.blueAlpha,
          borderColor: colors.blue,
          borderWidth: 1
        }]
      },
      options: {
        ...base,
        scales: { x: base.scales.x, y: { ...base.scales.y, beginAtZero: true } }
      }
    });

    createChart('chart-time-dist', {
      type: 'bar',
      data: {
        labels: distributions.timeLabels,
        datasets: [{
          label: 'TX Count',
          data: distributions.timeSavedDist,
          backgroundColor: colors.amberAlpha,
          borderColor: colors.amber,
          borderWidth: 1
        }]
      },
      options: {
        ...base,
        scales: { x: base.scales.x, y: { ...base.scales.y, beginAtZero: true } }
      }
    });

    if (!distributions.affCountLabels?.length) return;

    const affiliateYAxis = {
      ...base.scales.y,
      ticks: {
        ...base.scales.y.ticks,
        font: { family: 'JetBrains Mono', size: 11 },
        color: '#5588cc'
      }
    };

    createChart('chart-aff-count', {
      type: 'bar',
      plugins: [affiliateLabelHoverPlugin],
      data: {
        labels: distributions.affCountLabels,
        datasets: [{
          label: 'Swap Count',
          data: distributions.affCountValues,
          backgroundColor: colors.blueAlpha,
          borderColor: colors.blue,
          borderWidth: 1
        }]
      },
      options: {
        ...base,
        indexAxis: 'y',
        scales: { x: { ...base.scales.x, beginAtZero: true }, y: affiliateYAxis }
      }
    });
    attachAffiliateLabelInteraction('chart-aff-count', distributions.affCountCodes);

    createChart('chart-aff-volume', {
      type: 'bar',
      plugins: [affiliateLabelHoverPlugin],
      data: {
        labels: distributions.affVolumeLabels,
        datasets: [{
          label: 'Volume',
          data: distributions.affVolumeValues,
          backgroundColor: colors.greenAlpha,
          borderColor: colors.green,
          borderWidth: 1
        }]
      },
      options: {
        ...base,
        indexAxis: 'y',
        scales: {
          x: {
            ...base.scales.x,
            beginAtZero: true,
            ticks: { ...base.scales.x.ticks, callback: (value) => formatUSDCompact(value) }
          },
          y: affiliateYAxis
        }
      }
    });
    attachAffiliateLabelInteraction('chart-aff-volume', distributions.affVolumeCodes);
  }

  function renderPaths(swapPathData) {
    if (!swapPathData.volumeLabels.length) return;
    const colors = RAPID_SWAP_CHART_COLORS;
    const base = rapidSwapBaseChartOptions;

    createChart('chart-paths-volume', {
      type: 'bar',
      data: {
        labels: swapPathData.volumeLabels,
        datasets: [{
          label: 'Volume',
          data: swapPathData.volumeValues,
          backgroundColor: colors.greenAlpha,
          borderColor: colors.green,
          borderWidth: 1
        }]
      },
      options: {
        ...base,
        indexAxis: 'y',
        scales: {
          x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, callback: (value) => formatUSDCompact(value) } },
          y: { ...base.scales.y, ticks: { ...base.scales.y.ticks, font: { family: 'JetBrains Mono', size: 11 } } }
        }
      }
    });

    createChart('chart-paths-time', {
      type: 'bar',
      data: {
        labels: swapPathData.timeSavedLabels,
        datasets: [{
          label: 'Avg Time Saved',
          data: swapPathData.timeSavedValues,
          backgroundColor: colors.amberAlpha,
          borderColor: colors.amber,
          borderWidth: 1
        }]
      },
      options: {
        ...base,
        indexAxis: 'y',
        scales: {
          x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, callback: (value) => formatTimeSaved(value) } },
          y: { ...base.scales.y, ticks: { ...base.scales.y.ticks, font: { family: 'JetBrains Mono', size: 11 } } }
        }
      }
    });

    if (!swapPathData.sankeyFlows?.length) return;
    const flowColors = [
      '#00cc66', '#d4a017', '#5588cc', '#cc6644', '#88cc44',
      '#cc44aa', '#44ccaa', '#aa88cc', '#ccaa44', '#44aacc', '#888888'
    ];
    const sourceAssets = [...new Set(swapPathData.sankeyFlows.map((flow) => flow.from))];
    const colorMap = Object.fromEntries(
      sourceAssets.map((asset, index) => [asset, flowColors[index % flowColors.length]])
    );

    createChart('chart-sankey', {
      type: 'sankey',
      data: {
        datasets: [{
          data: swapPathData.sankeyFlows,
          colorFrom: (context) => colorMap[context.dataset.data[context.dataIndex]?.from] || '#555',
          colorTo: (context) => `${colorMap[context.dataset.data[context.dataIndex]?.from] || '#555'}88`,
          colorMode: 'gradient',
          labels: Object.fromEntries(
            [...new Set(swapPathData.sankeyFlows.flatMap((flow) => [flow.from, flow.to]))]
              .map((label) => [label, label])
          ),
          size: 'max'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1a1a1a',
            borderColor: '#333',
            borderWidth: 1,
            titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
            bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
            titleColor: '#888',
            bodyColor: '#ccc',
            padding: 10,
            callbacks: {
              label: (context) => {
                const item = context.dataset.data[context.dataIndex];
                return `${item.from} → ${item.to}: ${formatUSDCompact(item.flow)}`;
              }
            }
          }
        },
        layout: { padding: { top: 8, bottom: 8 } }
      }
    });
  }

  function destroyAll() {
    Object.keys(instances).forEach(destroyChart);
  }

  return { renderOverview, renderDistributions, renderPaths, destroyAll };
}
