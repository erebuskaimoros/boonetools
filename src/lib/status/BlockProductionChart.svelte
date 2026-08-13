<script>
  import { onDestroy, onMount } from 'svelte';
  import { subscribeChainHeads } from '../api/chain-stream.js';
  import { fetchBlockIntervals } from './api.js';
  import {
    buildBlockProductionChartScale,
    chainHeadToBlockIntervalPoint,
    decodeBlockIntervalPayload,
    findNearestBlockProductionPointIndex,
    mergeBlockIntervalPoints,
    projectBlockProductionChartY
  } from './block-production-chart.js';

  /** @type {{
   *   points?: Array<{time?: string, height?: number, seconds_per_block?: number, block_count?: number}>,
   *   live_interval_minutes?: number,
   *   warning?: string
   * } | null} */
  export let history = null;

  const WIDTH = 1000;
  const HEIGHT = 220;
  const LEFT = 52;
  const RIGHT = 18;
  const TOP = 16;
  const BOTTOM = 184;
  const TARGET_SECONDS = 6;
  const Y_TICK_INTERVALS = 4;
  const TOOLTIP_WIDTH = 290;
  const TOOLTIP_HEIGHT = 72;
  const RECONCILE_INTERVAL_MS = 15_000;

  /** @type {number | null} */
  let activePointIndex = null;
  /** @type {number | null} */
  let zoomStart = null;
  /** @type {number | null} */
  let zoomEnd = null;
  /** @type {number | null} */
  let selectionStartX = null;
  /** @type {number | null} */
  let selectionEndX = null;
  let selecting = false;
  let chartElement;
  let rawPoints = [];
  let rawWarning = '';
  let rawHasGaps = false;
  let rawRequestActive = false;
  let chainStreamConnected = false;
  let chainSubscription = null;
  let reconcileTimer = null;
  let requestController = null;

  $: displayHistory = rawPoints.length > 1
    ? {
        points: rawPoints,
        live_interval_minutes: 0,
        warning: rawWarning,
        source: 'liquify-thorchain-block-headers'
      }
    : {
        ...(history || {}),
        warning: rawWarning || history?.warning || ''
      };
  $: historyPoints = displayHistory?.points || [];
  $: allPoints = historyPoints
    .map((point) => ({
      ...point,
      timestamp: Date.parse(point?.time || ''),
      seconds: Number(point?.seconds_per_block),
      blocks: Math.max(0, Number(point?.block_count) || 0)
    }))
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.seconds) && point.seconds > 0)
    .sort((left, right) => left.timestamp - right.timestamp);
  $: points = zoomStart === null || zoomEnd === null
    ? allPoints
    : allPoints.filter((point) => point.timestamp >= zoomStart && point.timestamp <= zoomEnd);
  $: startTime = points[0]?.timestamp || 0;
  $: endTime = points.at(-1)?.timestamp || startTime;
  $: totalBlocks = points.reduce((sum, point) => sum + point.blocks, 0);
  $: weightedAverage = totalBlocks > 0
    ? points.reduce((sum, point) => sum + (point.seconds * point.blocks), 0) / totalBlocks
    : 0;
  $: latestSeconds = points.at(-1)?.seconds || 0;
  $: maxSeconds = points.length ? Math.max(...points.map((point) => point.seconds)) : 0;
  $: yScale = buildBlockProductionChartScale(points, {
    targetSeconds: TARGET_SECONDS,
    tickIntervals: Y_TICK_INTERVALS
  });
  $: yTicks = yScale.ticks;
  $: targetY = chartY(TARGET_SECONDS, yScale);
  $: xTicks = buildHourlyTicks(startTime, endTime);
  $: linePath = points.map((point, index) => (
    `${index === 0 ? 'M' : 'L'} ${chartX(point, index).toFixed(2)} ${chartY(point.seconds, yScale).toFixed(2)}`
  )).join(' ');
  $: areaPath = points.length > 1
    ? `${linePath} L ${chartX(points.at(-1), points.length - 1).toFixed(2)} ${BOTTOM} L ${chartX(points[0], 0).toFixed(2)} ${BOTTOM} Z`
    : '';
  $: activePoint = activePointIndex === null ? null : points[activePointIndex] || null;
  $: activePointX = activePoint && activePointIndex !== null
    ? chartX(activePoint, activePointIndex)
    : 0;
  $: activePointY = activePoint ? chartY(activePoint.seconds, yScale) : 0;
  $: tooltipX = Math.max(
    LEFT,
    Math.min(WIDTH - RIGHT - TOOLTIP_WIDTH, activePointX - (TOOLTIP_WIDTH / 2))
  );
  $: tooltipY = activePointY - TOOLTIP_HEIGHT - 12 < TOP
    ? activePointY + 12
    : activePointY - TOOLTIP_HEIGHT - 12;
  $: selectionLeft = selectionStartX === null || selectionEndX === null
    ? 0
    : Math.min(selectionStartX, selectionEndX);
  $: selectionWidth = selectionStartX === null || selectionEndX === null
    ? 0
    : Math.abs(selectionEndX - selectionStartX);

  onMount(() => {
    requestController = new AbortController();
    loadRawIntervals({ full: true });
    chainSubscription = subscribeChainHeads({
      onOpen: () => { chainStreamConnected = true; },
      onError: () => { chainStreamConnected = false; },
      onHead: (head) => {
        chainStreamConnected = true;
        const point = chainHeadToBlockIntervalPoint(head);
        if (!point) return;
        rawPoints = mergeBlockIntervalPoints(rawPoints, [point]);
      }
    });
    reconcileTimer = setInterval(() => loadRawIntervals({ full: rawHasGaps }), RECONCILE_INTERVAL_MS);
  });

  onDestroy(() => {
    requestController?.abort();
    chainSubscription?.close();
    clearInterval(reconcileTimer);
  });

  async function loadRawIntervals({ full = false } = {}) {
    if (rawRequestActive) return;
    rawRequestActive = true;
    const afterHeight = full ? 0 : Number(rawPoints.at(-1)?.height || 0);
    try {
      const payload = await fetchBlockIntervals({
        hours: 24,
        afterHeight,
        signal: requestController?.signal
      });
      const incoming = decodeBlockIntervalPayload(payload);
      // Preserve a head received over SSE while a full replay request is in flight.
      rawPoints = mergeBlockIntervalPoints(rawPoints, incoming);
      rawHasGaps = Array.isArray(payload?.gaps) && payload.gaps.length > 0;
      rawWarning = rawHasGaps
        ? `Header repair is filling ${payload.gaps.length} gap${payload.gaps.length === 1 ? '' : 's'} in this window`
        : '';
    } catch (error) {
      if (error?.name !== 'AbortError') {
        rawWarning = rawPoints.length
          ? 'Live replay is reconnecting; showing the last received headers'
          : 'Per-block history is warming up; showing five-minute fallback samples';
      }
    } finally {
      rawRequestActive = false;
    }
  }

  function chartX(point, index) {
    const plotWidth = WIDTH - LEFT - RIGHT;
    if (endTime <= startTime) return LEFT + (plotWidth * (index / Math.max(1, points.length - 1)));
    return LEFT + (((point.timestamp - startTime) / (endTime - startTime)) * plotWidth);
  }

  function chartY(seconds, scale = yScale) {
    return projectBlockProductionChartY(seconds, {
      min: scale.min,
      max: scale.max,
      top: TOP,
      bottom: BOTTOM
    });
  }

  function formatSeconds(value) {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '-';
    return `${Number(value).toFixed(Number(value) < 10 ? 2 : 1)}s`;
  }

  function buildHourlyTicks(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    const firstHour = new Date(start);
    firstHour.setMinutes(0, 0, 0);
    if (firstHour.getTime() < start) firstHour.setHours(firstHour.getHours() + 1);

    const ticks = [];
    for (let time = firstHour.getTime(); time <= end && ticks.length < 72; time += 60 * 60 * 1000) {
      ticks.push({
        time,
        x: LEFT + (((time - start) / (end - start)) * (WIDTH - LEFT - RIGHT))
      });
    }
    return ticks;
  }

  function formatChartHour(value) {
    const date = new Date(value || 0);
    if (!Number.isFinite(date.getTime())) return '-';
    return date.toLocaleTimeString('en-US', { hour: 'numeric' }).replace(' ', '');
  }

  function formatAxisSeconds(value) {
    if (!Number.isFinite(Number(value))) return '-';
    if (Number(value) === 0) return '0s';
    return `${Number(value).toFixed(1)}s`;
  }

  function formatTooltip(point) {
    const date = new Date(point.timestamp);
    return `${date.toLocaleString('en-US')} · ${formatSeconds(point.seconds)} interval · block ${Number(point.height || 0).toLocaleString('en-US')}`;
  }

  function formatTooltipTime(point) {
    return new Date(point.timestamp).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function pointerChartX(event) {
    const svg = event.currentTarget.ownerSVGElement || event.currentTarget;
    try {
      const screenTransform = svg.getScreenCTM();
      if (screenTransform) {
        const pointer = svg.createSVGPoint();
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        const chartPointer = pointer.matrixTransform(screenTransform.inverse());
        if (Number.isFinite(chartPointer.x)) {
          return Math.max(LEFT, Math.min(WIDTH - RIGHT, chartPointer.x));
        }
      }
    } catch {
      // Fall back to bounding-box projection when the SVG transform is unavailable.
    }

    const bounds = svg.getBoundingClientRect();
    if (!bounds.width) return LEFT;
    const x = ((event.clientX - bounds.left) / bounds.width) * WIDTH;
    return Math.max(LEFT, Math.min(WIDTH - RIGHT, x));
  }

  function updateChartTooltip(event) {
    if (selecting) return;
    const nearestIndex = findNearestBlockProductionPointIndex(
      points,
      timestampAtX(pointerChartX(event))
    );
    activePointIndex = nearestIndex;
  }

  function hideChartTooltip() {
    if (!selecting) activePointIndex = null;
  }

  function handleWindowMouseMove(event) {
    if (activePointIndex === null || selecting || chartElement?.contains(event.target)) return;
    hideChartTooltip();
  }

  function timestampAtX(x) {
    const plotWidth = WIDTH - LEFT - RIGHT;
    return startTime + (((x - LEFT) / plotWidth) * (endTime - startTime));
  }

  function startZoomSelection(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    activePointIndex = null;
    selecting = true;
    selectionStartX = pointerChartX(event);
    selectionEndX = selectionStartX;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Selection still works when pointer capture is unavailable (for example, synthetic input).
    }
  }

  function updateZoomSelection(event) {
    if (!selecting) return;
    selectionEndX = pointerChartX(event);
  }

  function finishZoomSelection(event) {
    if (!selecting) return;
    selectionEndX = pointerChartX(event);
    selecting = false;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }

    const left = Math.min(selectionStartX ?? 0, selectionEndX ?? 0);
    const right = Math.max(selectionStartX ?? 0, selectionEndX ?? 0);
    const selectedPoints = right - left >= 18
      ? points.filter((point) => point.timestamp >= timestampAtX(left) && point.timestamp <= timestampAtX(right))
      : [];

    selectionStartX = null;
    selectionEndX = null;
    if (selectedPoints.length < 2) return;

    zoomStart = selectedPoints[0].timestamp;
    zoomEnd = selectedPoints.at(-1).timestamp;
    activePointIndex = null;
  }

  function cancelZoomSelection(event) {
    selecting = false;
    selectionStartX = null;
    selectionEndX = null;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
  }

  function resetZoom() {
    zoomStart = null;
    zoomEnd = null;
    activePointIndex = null;
    selectionStartX = null;
    selectionEndX = null;
  }

  function formatWindowDuration() {
    const durationMinutes = Math.max(1, Math.round((endTime - startTime) / 60000));
    if (durationMinutes < 60) return `${durationMinutes}M`;
    const hours = Math.floor(durationMinutes / 60);
    const minutes = durationMinutes % 60;
    return minutes ? `${hours}H ${minutes}M` : `${hours}H`;
  }
</script>

<svelte:window on:mousemove={handleWindowMouseMove} />

<section class="block block-production" aria-labelledby="block-production-title">
  <div class="block-title">
    <h2 id="block-production-title"><span>▌</span> Block Interval</h2>
    <div class="window-actions">
      <span class="window-label">{zoomStart === null ? '[LAST 24H]' : `[ZOOMED ${formatWindowDuration()}]`}</span>
      {#if zoomStart !== null}
        <button class="reset-zoom" type="button" on:click={resetZoom}><span>[R]</span> reset zoom</button>
      {/if}
    </div>
  </div>

  <div class="chart-summary" aria-label="Block interval summary">
    <div><span>LATEST</span><strong>{formatSeconds(latestSeconds)}</strong></div>
    <div><span>WEIGHTED AVG</span><strong>{formatSeconds(weightedAverage)}</strong></div>
    <div><span>MAX</span><strong>{formatSeconds(maxSeconds)}</strong></div>
    <div><span>OBSERVED</span><strong>{totalBlocks.toLocaleString('en-US')}</strong><small>blocks</small></div>
  </div>

  {#if points.length > 1}
    <div class="chart-scroll">
      <svg
        bind:this={chartElement}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Every THORChain block interval in the last 24 hours. Hover anywhere for the nearest block or drag to zoom."
        on:mousemove={updateChartTooltip}
      >
        {#each yTicks as tick}
          <line class="grid-line" x1={LEFT} x2={WIDTH - RIGHT} y1={chartY(tick, yScale)} y2={chartY(tick, yScale)} />
          <text class="axis-label y-label" x={LEFT - 9} y={chartY(tick, yScale) + 3}>{formatAxisSeconds(tick)}</text>
        {/each}

        {#each xTicks as tick}
          <line class="grid-line vertical" x1={tick.x} x2={tick.x} y1={TOP} y2={BOTTOM} />
          <line class="hour-tick" x1={tick.x} x2={tick.x} y1={BOTTOM} y2={BOTTOM + 4} />
          <text class="axis-label x-label" x={tick.x} y={HEIGHT - 11}>{formatChartHour(tick.time)}</text>
        {/each}

        <line class="target-line" x1={LEFT} x2={WIDTH - RIGHT} y1={targetY} y2={targetY} />
        <text class="target-label" x={WIDTH - RIGHT - 4} y={targetY - 6}>6S TARGET</text>

        <path class="series-area" d={areaPath}></path>
        <path class="series-line" d={linePath}></path>

        <rect
          class="zoom-capture"
          x={LEFT}
          y={TOP}
          width={WIDTH - LEFT - RIGHT}
          height={BOTTOM - TOP}
          role="application"
          aria-label="Drag to zoom into a block interval range"
          on:pointerdown={startZoomSelection}
          on:pointermove={updateZoomSelection}
          on:pointerup={finishZoomSelection}
          on:pointercancel={cancelZoomSelection}
        ></rect>

        {#if selecting && selectionWidth > 0}
          <g class="zoom-selection" aria-hidden="true">
            <rect x={selectionLeft} y={TOP} width={selectionWidth} height={BOTTOM - TOP}></rect>
            <line x1={selectionLeft} x2={selectionLeft} y1={TOP} y2={BOTTOM}></line>
            <line x1={selectionLeft + selectionWidth} x2={selectionLeft + selectionWidth} y1={TOP} y2={BOTTOM}></line>
            {#if selectionWidth > 90}
              <text x={selectionLeft + (selectionWidth / 2)} y={TOP + 13}>RELEASE TO ZOOM</text>
            {/if}
          </g>
        {/if}

        {#if activePoint}
          <line class="tooltip-guide" x1={activePointX} x2={activePointX} y1={TOP} y2={BOTTOM}></line>
          <circle class="tooltip-anchor" cx={activePointX} cy={activePointY} r="4"></circle>
          <g class="chart-tooltip" transform={`translate(${tooltipX} ${tooltipY})`} aria-hidden="true">
            <rect width={TOOLTIP_WIDTH} height={TOOLTIP_HEIGHT}></rect>
            <text class="tooltip-time" x="10" y="18">{formatTooltipTime(activePoint)}</text>
            <line x1="10" x2={TOOLTIP_WIDTH - 10} y1="28" y2="28"></line>
            <text class="tooltip-key" x="10" y="44">INTERVAL</text>
            <text class="tooltip-value accent" x="10" y="63">{formatSeconds(activePoint.seconds)}</text>
            <text class="tooltip-key" x="108" y="44">BLOCK</text>
            <text class="tooltip-value" x="108" y="63">{Number(activePoint.height || 0).toLocaleString('en-US')}</text>
            <text class="tooltip-key" x="205" y="44">SOURCE</text>
            <text class="tooltip-value" x="205" y="63">header</text>
          </g>
        {/if}

      </svg>
    </div>
  {:else}
    <div class="empty-chart"><span>▓░░░░</span> Collecting block headers...</div>
  {/if}

  <div class="chart-source">
    <span>Liquify / THORChain block headers</span>
    <em>drag to highlight + zoom · {rawPoints.length > 1 ? 'every block' : `${history?.live_interval_minutes || 5}m fallback`} · {chainStreamConnected ? 'live' : 'reconnecting'}</em>
  </div>

  {#if displayHistory?.warning}
    <div class="chart-warning"><span>WRN</span>{displayHistory.warning}</div>
  {/if}
</section>

<style>
  .block {
    margin-bottom: 16px;
    border: 1px solid #1a1a1a;
    background: #0a0a0a;
  }

  .block-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 44px;
    padding: 0 16px;
    border-bottom: 1px solid #1a1a1a;
  }

  h2 {
    margin: 0;
    color: var(--term-text-body, #e8e8e8);
    font: 700 12px/1.3 'JetBrains Mono', monospace;
    letter-spacing: .08em;
    text-transform: uppercase;
  }

  h2 span { color: #00cc66; }

  .window-label {
    color: var(--term-text-3, #c8c8c8);
    font: 600 11px/1.3 'JetBrains Mono', monospace;
    letter-spacing: .08em;
  }

  .window-actions { display: flex; align-items: center; gap: 10px; }

  .reset-zoom {
    padding: 4px 7px;
    border: 1px solid #1a1a1a;
    background: transparent;
    color: var(--term-text-2, #d8d8d8);
    font: 600 11px/1.3 'JetBrains Mono', monospace;
    text-transform: uppercase;
    cursor: pointer;
  }

  .reset-zoom span { color: #00cc66; }
  .reset-zoom:hover, .reset-zoom:focus-visible { border-color: #00cc66; color: #00cc66; outline: none; }

  .chart-summary {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    border-bottom: 1px solid #1a1a1a;
  }

  .chart-summary > div {
    min-height: 62px;
    padding: 11px 14px;
    border-right: 1px solid #111;
  }

  .chart-summary > div:last-child { border-right: 0; }
  .chart-summary span { display: block; color: var(--term-text-3, #c8c8c8); font: 700 11px/1.3 'JetBrains Mono', monospace; letter-spacing: .08em; }
  .chart-summary strong { display: inline-block; margin-top: 7px; color: var(--term-text, #f5f5f5); font: 800 15px/1 'JetBrains Mono', monospace; }
  .chart-summary small { margin-left: 5px; color: var(--term-text-3, #c8c8c8); font: 11px/1.2 'JetBrains Mono', monospace; }

  .chart-scroll {
    overflow-x: auto;
    padding: 8px 12px 0;
  }

  svg {
    display: block;
    width: max(100%, 1000px);
    min-width: 1000px;
    height: 220px;
  }

  .grid-line { stroke: #181818; stroke-width: 1; vector-effect: non-scaling-stroke; }
  .grid-line.vertical { stroke: #121212; }
  .hour-tick { stroke: #333; stroke-width: 1; vector-effect: non-scaling-stroke; pointer-events: none; }
  .target-line { stroke: rgba(212, 160, 23, .6); stroke-width: 1; stroke-dasharray: 5 5; vector-effect: non-scaling-stroke; }
  .target-label { fill: #d4a017; font: 700 11px 'JetBrains Mono', monospace; text-anchor: end; }
  .series-area { fill: rgba(0, 204, 102, .045); }
  .series-line { fill: none; stroke: #00cc66; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .series-area, .series-line, .grid-line, .target-line, .target-label { pointer-events: none; }
  .zoom-capture { fill: transparent; touch-action: pan-y; }
  .zoom-selection { pointer-events: none; }
  .zoom-selection rect { fill: rgba(0, 204, 102, .1); stroke: rgba(0, 204, 102, .45); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .zoom-selection line { stroke: #00cc66; stroke-width: 1; vector-effect: non-scaling-stroke; }
  .zoom-selection text { fill: #00cc66; font: 700 11px 'JetBrains Mono', monospace; letter-spacing: .08em; text-anchor: middle; }
  .tooltip-guide { stroke: #333; stroke-width: 1; stroke-dasharray: 2 3; vector-effect: non-scaling-stroke; pointer-events: none; }
  .tooltip-anchor { fill: #00cc66; stroke: #f5f5f5; stroke-width: 1.25; vector-effect: non-scaling-stroke; pointer-events: none; }
  .chart-tooltip { pointer-events: none; }
  .chart-tooltip rect { fill: #060606; stroke: #2a2a2a; stroke-width: 1; vector-effect: non-scaling-stroke; }
  .chart-tooltip line { stroke: #1a1a1a; stroke-width: 1; vector-effect: non-scaling-stroke; }
  .tooltip-time { fill: #f5f5f5; font: 600 12px 'JetBrains Mono', monospace; }
  .tooltip-key { fill: #d8d8d8; font: 700 11px 'JetBrains Mono', monospace; letter-spacing: .04em; }
  .tooltip-value { fill: #ffffff; font: 700 12px 'JetBrains Mono', monospace; }
  .tooltip-value.accent { fill: #00cc66; }
  .axis-label { fill: #c8c8c8; font: 11px 'JetBrains Mono', monospace; }
  .y-label { text-anchor: end; }
  .x-label { font-size: 11px; text-anchor: middle; }

  .empty-chart {
    padding: 34px 16px;
    color: var(--term-text-3, #c8c8c8);
    font: 11px/1.5 'JetBrains Mono', monospace;
  }

  .empty-chart span { margin-right: 8px; color: #00cc66; animation: loader 1.2s steps(5) infinite; }

  .chart-source {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 16px 10px;
    border-top: 1px solid #111;
    color: var(--term-text-4, #bcbcbc);
    font: 11px/1.5 'JetBrains Mono', monospace;
  }

  .chart-source span { color: var(--term-text-2, #d8d8d8); }
  .chart-source em { font-style: normal; }

  .chart-warning {
    margin: 0 16px 12px;
    padding: 9px 10px;
    border: 1px solid #1a1a1a;
    color: var(--term-text-2, #d8d8d8);
    font: 11px/1.5 'JetBrains Mono', monospace;
  }

  .chart-warning span { margin-right: 8px; color: #d4a017; font-weight: 800; }

  @keyframes loader { 50% { opacity: .35; } }

  @media (max-width: 560px) {
    .chart-summary { grid-template-columns: repeat(2, 1fr); }
    .chart-summary > div:nth-child(2) { border-right: 0; }
    .chart-summary > div:nth-child(-n + 2) { border-bottom: 1px solid #111; }
    .chart-source { display: block; }
    .chart-source em { display: block; margin-top: 3px; }
  }
</style>
