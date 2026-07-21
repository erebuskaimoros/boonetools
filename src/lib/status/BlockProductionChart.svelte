<script>
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
  const TOOLTIP_WIDTH = 260;
  const TOOLTIP_HEIGHT = 64;

  /** @type {number | null} */
  let activePointIndex = null;

  $: historyPoints = history?.points || [];
  $: points = historyPoints
    .map((point) => ({
      ...point,
      timestamp: Date.parse(point?.time || ''),
      seconds: Number(point?.seconds_per_block),
      blocks: Math.max(0, Number(point?.block_count) || 0)
    }))
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.seconds) && point.seconds > 0)
    .sort((left, right) => left.timestamp - right.timestamp);
  $: startTime = points[0]?.timestamp || 0;
  $: endTime = points.at(-1)?.timestamp || startTime;
  $: totalBlocks = points.reduce((sum, point) => sum + point.blocks, 0);
  $: weightedAverage = totalBlocks > 0
    ? points.reduce((sum, point) => sum + (point.seconds * point.blocks), 0) / totalBlocks
    : 0;
  $: latestSeconds = points.at(-1)?.seconds || 0;
  $: maxSeconds = points.length ? Math.max(...points.map((point) => point.seconds)) : 0;
  $: yMax = Math.max(10, Math.ceil((maxSeconds * 1.12) / 2) * 2);
  $: yTicks = [yMax, yMax / 2, 0];
  $: linePath = points.map((point, index) => (
    `${index === 0 ? 'M' : 'L'} ${chartX(point, index).toFixed(2)} ${chartY(point.seconds).toFixed(2)}`
  )).join(' ');
  $: areaPath = points.length > 1
    ? `${linePath} L ${chartX(points.at(-1), points.length - 1).toFixed(2)} ${BOTTOM} L ${chartX(points[0], 0).toFixed(2)} ${BOTTOM} Z`
    : '';
  $: activePoint = activePointIndex === null ? null : points[activePointIndex] || null;
  $: activePointX = activePoint && activePointIndex !== null
    ? chartX(activePoint, activePointIndex)
    : 0;
  $: activePointY = activePoint ? chartY(activePoint.seconds) : 0;
  $: tooltipX = Math.max(
    LEFT,
    Math.min(WIDTH - RIGHT - TOOLTIP_WIDTH, activePointX - (TOOLTIP_WIDTH / 2))
  );
  $: tooltipY = activePointY - TOOLTIP_HEIGHT - 12 < TOP
    ? activePointY + 12
    : activePointY - TOOLTIP_HEIGHT - 12;

  function chartX(point, index) {
    const plotWidth = WIDTH - LEFT - RIGHT;
    if (endTime <= startTime) return LEFT + (plotWidth * (index / Math.max(1, points.length - 1)));
    return LEFT + (((point.timestamp - startTime) / (endTime - startTime)) * plotWidth);
  }

  function chartY(seconds) {
    return TOP + ((1 - Math.min(yMax, Math.max(0, seconds)) / yMax) * (BOTTOM - TOP));
  }

  function formatSeconds(value) {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '-';
    return `${Number(value).toFixed(Number(value) < 10 ? 2 : 1)}s`;
  }

  function formatChartTime(value) {
    const date = new Date(value || 0);
    if (!Number.isFinite(date.getTime())) return '-';
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function formatTooltip(point) {
    const date = new Date(point.timestamp);
    return `${date.toLocaleString('en-US')} · ${formatSeconds(point.seconds)} per block · ${point.blocks} blocks · height ${Number(point.height || 0).toLocaleString('en-US')}`;
  }

  function formatTooltipTime(point) {
    return new Date(point.timestamp).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function showTooltip(index) {
    activePointIndex = index;
  }

  function hideTooltip(index) {
    if (activePointIndex === index) activePointIndex = null;
  }

  function handleTooltipKeydown(event, index) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      showTooltip(index);
    } else if (event.key === 'Escape') {
      hideTooltip(index);
    }
  }
</script>

<section class="block block-production" aria-labelledby="block-production-title">
  <div class="block-title">
    <h2 id="block-production-title"><span>▌</span> Block Production Time</h2>
    <span class="window-label">[LAST 24H]</span>
  </div>

  <div class="chart-summary" aria-label="Block production summary">
    <div><span>LATEST</span><strong>{formatSeconds(latestSeconds)}</strong></div>
    <div><span>WEIGHTED AVG</span><strong>{formatSeconds(weightedAverage)}</strong></div>
    <div><span>MAX</span><strong>{formatSeconds(maxSeconds)}</strong></div>
    <div><span>OBSERVED</span><strong>{totalBlocks.toLocaleString('en-US')}</strong><small>blocks</small></div>
  </div>

  {#if points.length > 1}
    <div class="chart-scroll">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Average seconds per THORChain block over the last 24 hours">
        {#each yTicks as tick}
          <line class="grid-line" x1={LEFT} x2={WIDTH - RIGHT} y1={chartY(tick)} y2={chartY(tick)} />
          <text class="axis-label y-label" x={LEFT - 9} y={chartY(tick) + 3}>{formatSeconds(tick)}</text>
        {/each}

        <line class="target-line" x1={LEFT} x2={WIDTH - RIGHT} y1={chartY(TARGET_SECONDS)} y2={chartY(TARGET_SECONDS)} />
        <text class="target-label" x={WIDTH - RIGHT - 4} y={chartY(TARGET_SECONDS) - 6}>6S TARGET</text>

        <path class="series-area" d={areaPath}></path>
        <path class="series-line" d={linePath}></path>

        {#each points as point, index}
          <g
            class="point-target"
            class:active={activePointIndex === index}
            role="button"
            tabindex="0"
            aria-label={formatTooltip(point)}
            on:mouseenter={() => showTooltip(index)}
            on:mouseleave={() => hideTooltip(index)}
            on:focus={() => showTooltip(index)}
            on:blur={() => hideTooltip(index)}
            on:click={() => showTooltip(index)}
            on:keydown={(event) => handleTooltipKeydown(event, index)}
          >
            <circle class="point-hit" cx={chartX(point, index)} cy={chartY(point.seconds)} r="11"></circle>
            <circle class="series-point" cx={chartX(point, index)} cy={chartY(point.seconds)} r="2.4"></circle>
          </g>
        {/each}

        {#if activePoint}
          <line class="tooltip-guide" x1={activePointX} x2={activePointX} y1={TOP} y2={BOTTOM}></line>
          <circle class="tooltip-anchor" cx={activePointX} cy={activePointY} r="4"></circle>
          <g class="chart-tooltip" transform={`translate(${tooltipX} ${tooltipY})`} aria-hidden="true">
            <rect width={TOOLTIP_WIDTH} height={TOOLTIP_HEIGHT}></rect>
            <text class="tooltip-time" x="10" y="16">{formatTooltipTime(activePoint)}</text>
            <line x1="10" x2={TOOLTIP_WIDTH - 10} y1="24" y2="24"></line>
            <text class="tooltip-key" x="10" y="38">BLOCK TIME</text>
            <text class="tooltip-value accent" x="10" y="54">{formatSeconds(activePoint.seconds)}</text>
            <text class="tooltip-key" x="100" y="38">OBSERVED</text>
            <text class="tooltip-value" x="100" y="54">{activePoint.blocks.toLocaleString('en-US')} blocks</text>
            <text class="tooltip-key" x="180" y="38">HEIGHT</text>
            <text class="tooltip-value" x="180" y="54">{Number(activePoint.height || 0).toLocaleString('en-US')}</text>
          </g>
        {/if}

        <text class="axis-label x-label" x={LEFT} y={HEIGHT - 11}>{formatChartTime(startTime)}</text>
        <text class="axis-label x-label middle" x={WIDTH / 2} y={HEIGHT - 11}>{formatChartTime(startTime + ((endTime - startTime) / 2))}</text>
        <text class="axis-label x-label end" x={WIDTH - RIGHT} y={HEIGHT - 11}>{formatChartTime(endTime)}</text>
      </svg>
    </div>
  {:else}
    <div class="empty-chart"><span>▓░░░░</span> Collecting block-header samples...</div>
  {/if}

  <div class="chart-source">
    <span>THORChain RPC block headers</span>
    <em>{history?.live_interval_minutes || 5}m live averages · hourly bootstrap samples</em>
  </div>

  {#if history?.warning}
    <div class="chart-warning"><span>WRN</span>{history.warning}</div>
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
    color: #aaa;
    font: 700 11px/1.2 'JetBrains Mono', monospace;
    letter-spacing: .08em;
    text-transform: uppercase;
  }

  h2 span { color: #00cc66; }

  .window-label {
    color: #555;
    font: 600 9px/1.2 'JetBrains Mono', monospace;
    letter-spacing: .08em;
  }

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
  .chart-summary span { display: block; color: #555; font: 700 8px/1.2 'JetBrains Mono', monospace; letter-spacing: .11em; }
  .chart-summary strong { display: inline-block; margin-top: 7px; color: #e8e8e8; font: 800 15px/1 'JetBrains Mono', monospace; }
  .chart-summary small { margin-left: 5px; color: #444; font: 8px/1 'JetBrains Mono', monospace; }

  .chart-scroll {
    overflow-x: auto;
    padding: 8px 12px 0;
  }

  svg {
    display: block;
    width: 100%;
    min-width: 700px;
    height: 220px;
  }

  .grid-line { stroke: #181818; stroke-width: 1; vector-effect: non-scaling-stroke; }
  .target-line { stroke: rgba(212, 160, 23, .6); stroke-width: 1; stroke-dasharray: 5 5; vector-effect: non-scaling-stroke; }
  .target-label { fill: #8a6d16; font: 700 8px 'JetBrains Mono', monospace; text-anchor: end; }
  .series-area { fill: rgba(0, 204, 102, .045); }
  .series-line { fill: none; stroke: #00cc66; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .series-point { fill: #080808; stroke: #00cc66; stroke-width: 1.2; vector-effect: non-scaling-stroke; }
  .point-target { cursor: crosshair; outline: none; }
  .point-hit { fill: transparent; stroke: none; }
  .point-target:hover .series-point,
  .point-target:focus .series-point,
  .point-target.active .series-point { fill: #00cc66; stroke: #e8e8e8; stroke-width: 1.5; }
  .tooltip-guide { stroke: #333; stroke-width: 1; stroke-dasharray: 2 3; vector-effect: non-scaling-stroke; pointer-events: none; }
  .tooltip-anchor { fill: #00cc66; stroke: #e8e8e8; stroke-width: 1.25; vector-effect: non-scaling-stroke; pointer-events: none; }
  .chart-tooltip { pointer-events: none; }
  .chart-tooltip rect { fill: #060606; stroke: #2a2a2a; stroke-width: 1; vector-effect: non-scaling-stroke; }
  .chart-tooltip line { stroke: #1a1a1a; stroke-width: 1; vector-effect: non-scaling-stroke; }
  .tooltip-time { fill: #888; font: 600 8px 'JetBrains Mono', monospace; }
  .tooltip-key { fill: #555; font: 700 7px 'JetBrains Mono', monospace; letter-spacing: .08em; }
  .tooltip-value { fill: #e8e8e8; font: 700 9px 'JetBrains Mono', monospace; }
  .tooltip-value.accent { fill: #00cc66; }
  .axis-label { fill: #444; font: 8px 'JetBrains Mono', monospace; }
  .y-label { text-anchor: end; }
  .x-label.middle { text-anchor: middle; }
  .x-label.end { text-anchor: end; }

  .empty-chart {
    padding: 34px 16px;
    color: #555;
    font: 10px/1.4 'JetBrains Mono', monospace;
  }

  .empty-chart span { margin-right: 8px; color: #00cc66; animation: loader 1.2s steps(5) infinite; }

  .chart-source {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 16px 10px;
    border-top: 1px solid #111;
    color: #444;
    font: 8px/1.3 'JetBrains Mono', monospace;
  }

  .chart-source span { color: #666; }
  .chart-source em { font-style: normal; }

  .chart-warning {
    margin: 0 16px 12px;
    padding: 9px 10px;
    border: 1px solid #1a1a1a;
    color: #666;
    font: 9px/1.4 'JetBrains Mono', monospace;
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
