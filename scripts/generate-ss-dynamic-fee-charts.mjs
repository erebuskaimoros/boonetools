#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const ANALYSIS_SCRIPT = join(SCRIPT_DIR, 'analyze-ss-dynamic-fee.mjs');
const OUTPUT_DIR = join(REPO_ROOT, 'docs', 'ss-dynamic-fee-charts');
const PUBLIC_OUTPUT_DIR = join(
  REPO_ROOT,
  'public',
  'assets',
  'briefings',
  'ss-dynamic-fee-impact'
);
const OUTPUT_DIRS = [OUTPUT_DIR, PUBLIC_OUTPUT_DIR];

// Match the mixed Chart.js Affiliate Trend chart in DynamicFeeDashboard.svelte.
const CHART = Object.freeze({
  page: '#080808',
  frame: '#111111',
  grid: '#1a1a1a',
  text: '#c8c8c8',
  textStrong: '#f5f5f5',
  volume: '#00cc66',
  fees: '#d4a017',
  rate: '#5588cc',
  rolling30: '#4fb3bf',
  rolling90: '#b08adf'
});

const LEGACY_CHARTS = [
  'raw-monthly-performance.svg',
  'curated-monthly-performance.svg',
  'rolling-90d-volume.svg',
  'equal-window-impact.svg'
];

function runDailyAnalysis() {
  return JSON.parse(execFileSync(
    process.execPath,
    [ANALYSIS_SCRIPT, '--daily-json'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    }
  ));
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function compactUsd(value) {
  const amount = Number(value) || 0;
  if (Math.abs(amount) >= 1e9) return `$${(amount / 1e9).toFixed(1)}B`;
  if (Math.abs(amount) >= 1e6) return `$${(amount / 1e6).toFixed(amount >= 10e6 ? 0 : 1)}M`;
  if (Math.abs(amount) >= 1e3) return `$${(amount / 1e3).toFixed(amount >= 100e3 ? 0 : 1)}K`;
  return `$${amount.toFixed(0)}`;
}

function linearScale(domainMax, rangeMin, rangeMax) {
  return (value) => rangeMin + (Number(value) / domainMax) * (rangeMax - rangeMin);
}

function niceAxis(maxValue) {
  const maximum = Math.max(1, Number(maxValue) || 0);
  const exponent = Math.floor(Math.log10(maximum));
  const candidates = [];

  for (let power = exponent - 2; power <= exponent + 1; power += 1) {
    for (const multiplier of [1, 2, 2.5, 5]) {
      const step = multiplier * 10 ** power;
      const intervals = Math.ceil(maximum / step);
      if (intervals < 4 || intervals > 8) continue;
      const ceiling = intervals * step;
      const overhead = ceiling / maximum - 1;
      const score = overhead + Math.abs(intervals - 6) * 0.015;
      candidates.push({ step, intervals, ceiling, score });
    }
  }

  const selected = candidates.sort((left, right) => left.score - right.score)[0] || {
    step: maximum / 5,
    intervals: 5,
    ceiling: maximum,
    score: 0
  };
  return {
    maximum: selected.ceiling,
    ticks: Array.from(
      { length: selected.intervals + 1 },
      (_, index) => index * selected.step
    )
  };
}

function smoothPath(points, tension = 0.2) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;

  const commands = [`M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] || points[index];
    const current = points[index];
    const next = points[index + 1];
    const following = points[index + 2] || next;
    const control1 = [
      current[0] + (next[0] - previous[0]) * tension / 6,
      current[1] + (next[1] - previous[1]) * tension / 6
    ];
    const control2 = [
      next[0] - (following[0] - current[0]) * tension / 6,
      next[1] - (following[1] - current[1]) * tension / 6
    ];
    commands.push(
      `C ${control1[0].toFixed(2)} ${control1[1].toFixed(2)}, ` +
      `${control2[0].toFixed(2)} ${control2[1].toFixed(2)}, ` +
      `${next[0].toFixed(2)} ${next[1].toFixed(2)}`
    );
  }
  return commands.join(' ');
}

function lineSegments(rows, valueForRow, xForIndex, yForValue, spanGaps) {
  if (spanGaps) {
    const points = rows.flatMap((row, index) => {
      const value = valueForRow(row);
      return value === null || value === undefined || !Number.isFinite(Number(value))
        ? []
        : [[xForIndex(index), yForValue(value)]];
    });
    return points.length ? [points] : [];
  }

  const segments = [];
  let current = [];
  rows.forEach((row, index) => {
    const value = valueForRow(row);
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push([xForIndex(index), yForValue(value)]);
  });
  if (current.length) segments.push(current);
  return segments;
}

function svgDocument({ title, description, content }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="460" viewBox="0 0 1200 460" role="img" aria-labelledby="chart-title chart-desc">
  <title id="chart-title">${escapeXml(title)}</title>
  <desc id="chart-desc">${escapeXml(description)}</desc>
  <style>
    text { font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace; font-size: 14px; font-variant-numeric: tabular-nums; }
    .heading { fill: ${CHART.textStrong}; font-size: 16px; font-weight: 600; letter-spacing: 1.2px; }
    .meta { fill: ${CHART.text}; font-size: 13px; letter-spacing: 1px; }
    .tick { fill: ${CHART.text}; }
    .fee-tick { fill: ${CHART.fees}; }
    .rate-tick { fill: ${CHART.rate}; }
    .grid { stroke: ${CHART.grid}; stroke-width: 1; shape-rendering: crispEdges; }
    .axis { stroke: ${CHART.grid}; stroke-width: 1; shape-rendering: crispEdges; }
  </style>
  <rect width="1200" height="460" fill="${CHART.page}"/>
${content}
</svg>
`;
}

function legendItem({ x, label, color, kind = 'box', dashed = false }) {
  const mark = kind === 'box'
    ? `<rect x="${x}" y="45" width="12" height="8" fill="${color}" fill-opacity="0.18" stroke="${color}"/>`
    : `<line x1="${x}" y1="49" x2="${x + 14}" y2="49" stroke="${color}" stroke-width="2"${dashed ? ' stroke-dasharray="7 4"' : ''}/>`;
  return `  ${mark}\n  <text class="tick" x="${x + 20}" y="53">${escapeXml(label)}</text>`;
}

function affiliateTrendChart(rows, mode, { rangeLabel, periodName }) {
  const uncurated = mode === 'raw';
  const modeLabel = uncurated ? 'UNCURATED' : 'CURATED';
  const volumeKey = uncurated ? 'rawVolumeUsd' : 'curatedVolumeUsd';
  const feesKey = uncurated ? 'rawFeesUsd' : 'curatedFeesUsd';
  const rateKey = uncurated ? 'rawRateBps' : 'curatedRateBps';
  const rolling30Key = uncurated
    ? 'rawRolling30dVolumeUsd'
    : 'curatedRolling30dVolumeUsd';
  const rolling90Key = uncurated
    ? 'rawRolling90dVolumeUsd'
    : 'curatedRolling90dVolumeUsd';
  const firstDay = rows[0]?.day;
  const lastDay = rows.at(-1)?.day;

  const left = 76;
  const right = 998;
  const plotTop = 72;
  const plotBottom = 402;
  const categoryWidth = (right - left) / rows.length;
  const xForIndex = (index) => left + categoryWidth * (index + 0.5);
  const volumeAxis = niceAxis(Math.max(...rows.flatMap((row) => [
    Number(row[volumeKey]) || 0,
    Number(row[rolling30Key]) || 0,
    Number(row[rolling90Key]) || 0
  ])));
  const feesAxis = niceAxis(Math.max(...rows.map((row) => Number(row[feesKey]) || 0)));
  const rateAxis = niceAxis(Math.max(...rows.map((row) => Number(row[rateKey]) || 0)));
  const yVolume = linearScale(volumeAxis.maximum, plotBottom, plotTop);
  const yFees = linearScale(feesAxis.maximum, plotBottom, plotTop);
  const yRate = linearScale(rateAxis.maximum, plotBottom, plotTop);
  const barWidth = rows.length <= 45
    ? Math.min(11, categoryWidth * 0.38)
    : Math.max(1.2, Math.min(2.2, categoryWidth * 0.42));
  const output = [
    `  <text class="heading" x="24" y="25">AFFILIATE TREND // ${modeLabel}</text>`,
    `  <text class="meta" x="1176" y="25" text-anchor="end">[SS / ${rangeLabel} / DAY / 30D + 90D]</text>`,
    legendItem({ x: 76, label: 'volume', color: CHART.volume }),
    legendItem({ x: 188, label: 'fees', color: CHART.fees }),
    legendItem({ x: 282, label: 'fees / volume', color: CHART.rate, kind: 'line' }),
    legendItem({ x: 434, label: '30d volume avg', color: CHART.rolling30, kind: 'line' }),
    legendItem({ x: 570, label: '90d volume avg', color: CHART.rolling90, kind: 'line', dashed: true }),
    `  <rect x="24" y="62" width="1152" height="374" fill="${CHART.page}" stroke="${CHART.frame}"/>`
  ];

  for (const tick of volumeAxis.ticks) {
    const y = yVolume(tick);
    output.push(
      `  <line class="grid" x1="${left}" y1="${y.toFixed(2)}" x2="${right}" y2="${y.toFixed(2)}"/>`,
      `  <text class="tick" x="${left - 10}" y="${(y + 3).toFixed(2)}" text-anchor="end">${escapeXml(compactUsd(tick))}</text>`
    );
  }

  for (const tick of feesAxis.ticks) {
    const y = yFees(tick);
    output.push(
      `  <line class="axis" x1="${right}" y1="${y.toFixed(2)}" x2="${right + 5}" y2="${y.toFixed(2)}"/>`,
      `  <text class="fee-tick" x="${right + 10}" y="${(y + 3).toFixed(2)}">${escapeXml(compactUsd(tick))}</text>`
    );
  }

  const rateAxisX = 1094;
  output.push(`  <line class="axis" x1="${rateAxisX}" y1="${plotTop}" x2="${rateAxisX}" y2="${plotBottom}"/>`);
  for (const tick of rateAxis.ticks) {
    const y = yRate(tick);
    output.push(
      `  <line class="axis" x1="${rateAxisX}" y1="${y.toFixed(2)}" x2="${rateAxisX + 5}" y2="${y.toFixed(2)}"/>`,
      `  <text class="rate-tick" x="${rateAxisX + 10}" y="${(y + 3).toFixed(2)}">${Number(tick).toFixed(tick > 0 && tick < 10 ? 2 : 0)} bps</text>`
    );
  }

  const tickIndexes = rows.length <= 45
    ? [...new Set([
        ...Array.from({ length: Math.ceil(rows.length / 5) }, (_, index) => index * 5),
        rows.length - 1
      ])].filter((index) => index >= 0 && index < rows.length)
    : rows
        .map((row, index) => ({ day: row.day, index }))
        .filter(({ day, index }) => index > 0 && (day.endsWith('-01') || index === rows.length - 1))
        .map(({ index }) => index);
  for (const index of tickIndexes) {
    const label = rows[index].day.slice(5);
    const x = xForIndex(index);
    output.push(
      `  <line class="grid" x1="${x.toFixed(2)}" y1="${plotTop}" x2="${x.toFixed(2)}" y2="${plotBottom}"/>`,
      `  <text class="tick" x="${x.toFixed(2)}" y="423" text-anchor="middle">${label}</text>`
    );
  }

  rows.forEach((row, index) => {
    const x = xForIndex(index);
    const volume = Number(row[volumeKey]) || 0;
    const fees = Number(row[feesKey]) || 0;
    if (volume > 0) {
      const y = yVolume(volume);
      output.push(
        `  <rect x="${(x - barWidth - 0.2).toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${(plotBottom - y).toFixed(2)}" fill="${CHART.volume}" fill-opacity="0.18" stroke="${CHART.volume}" stroke-width="0.8"/>`
      );
    }
    if (fees > 0) {
      const y = yFees(fees);
      output.push(
        `  <rect x="${(x + 0.2).toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${(plotBottom - y).toFixed(2)}" fill="${CHART.fees}" fill-opacity="0.18" stroke="${CHART.fees}" stroke-width="0.8"/>`
      );
    }
  });

  const rateSegments = lineSegments(
    rows,
    (row) => row[rateKey],
    xForIndex,
    yRate,
    true
  );
  for (const segment of rateSegments) {
    output.push(
      `  <path d="${smoothPath(segment, 0.25)}" fill="none" stroke="${CHART.rate}" stroke-width="2"/>`
    );
    for (const [x, y] of segment) {
      output.push(
        `  <circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2" fill="${CHART.rate}"/>`
      );
    }
  }

  const rolling30Segments = lineSegments(
    rows,
    (row) => row[rolling30Key],
    xForIndex,
    yVolume,
    false
  );
  for (const segment of rolling30Segments) {
    output.push(
      `  <path d="${smoothPath(segment, 0.2)}" fill="none" stroke="${CHART.rolling30}" stroke-width="2"/>`
    );
  }

  const rolling90Segments = lineSegments(
    rows,
    (row) => row[rolling90Key],
    xForIndex,
    yVolume,
    false
  );
  for (const segment of rolling90Segments) {
    output.push(
      `  <path d="${smoothPath(segment, 0.2)}" fill="none" stroke="${CHART.rolling90}" stroke-width="2" stroke-dasharray="7 4"/>`
    );
  }

  output.push(
    `  <line class="axis" x1="${left}" y1="${plotBottom}" x2="${right}" y2="${plotBottom}"/>`,
    `  <text class="meta" x="24" y="452">COMPLETED UTC DAYS // ${firstDay}–${lastDay}</text>`
  );

  const rollingDescription = uncurated
    ? 'The rolling averages divide the trailing 30 and 90 calendar buckets by 30 and 90, respectively.'
    : 'Both rolling averages remove full halt days from numerator and denominator and are blank on those days.';
  return svgDocument({
    title: `SS ${periodName} affiliate trend, ${modeLabel.toLowerCase()}`,
    description: `${modeLabel} daily executed-leg volume bars, historical liquidity-fee bars, fees-per-volume line, and trailing 30- and 90-day average-volume lines from ${firstDay} through ${lastDay}. ${rollingDescription}`,
    content: output.join('\n')
  });
}

const dailyRows = runDailyAnalysis();
if (
  dailyRows.length !== 181 ||
  dailyRows[0]?.day !== '2026-01-27' ||
  dailyRows.at(-1)?.day !== '2026-07-26'
) {
  throw new Error('Expected 181 completed daily rows from 2026-01-27 through 2026-07-26');
}

for (const outputDir of OUTPUT_DIRS) {
  mkdirSync(outputDir, { recursive: true });
  for (const filename of LEGACY_CHARTS) {
    rmSync(join(outputDir, filename), { force: true });
  }
}

const sixMonthOptions = { rangeLabel: '6M', periodName: 'six-month' };
const oneMonthOptions = { rangeLabel: '1M', periodName: 'one-month' };
const oneMonthRows = dailyRows.slice(-30);
if (
  oneMonthRows.length !== 30 ||
  oneMonthRows[0]?.day !== '2026-06-27' ||
  oneMonthRows.at(-1)?.day !== '2026-07-26'
) {
  throw new Error('Expected 30 completed daily rows from 2026-06-27 through 2026-07-26');
}

const charts = {
  'affiliate-trend-uncurated-6m.svg': affiliateTrendChart(dailyRows, 'raw', sixMonthOptions),
  'affiliate-trend-curated-6m.svg': affiliateTrendChart(dailyRows, 'curated', sixMonthOptions),
  'affiliate-trend-uncurated-1m.svg': affiliateTrendChart(oneMonthRows, 'raw', oneMonthOptions),
  'affiliate-trend-curated-1m.svg': affiliateTrendChart(oneMonthRows, 'curated', oneMonthOptions)
};

for (const [filename, contents] of Object.entries(charts)) {
  for (const outputDir of OUTPUT_DIRS) {
    writeFileSync(join(outputDir, filename), contents, 'utf8');
  }
}

console.log(`Wrote ${Object.keys(charts).length} charts to ${OUTPUT_DIRS.join(' and ')}`);
