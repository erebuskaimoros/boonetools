<script>
  import { createEventDispatcher } from 'svelte';
  import { summarizeBondMetrics } from './bond-history.js';
  import { fmtAmount, fmtPct, nodeUrl, shortAddr, signed } from './format.js';

  export let rows = [];
  export let history = [];
  export let loading = false;
  export let loadedOnce = false;
  export let historyLoading = false;
  export let loaded = false;
  export let error = '';
  export let bondError = '';
  export let runePriceUsd = 0;
  export let money = (value) => String(value);
  export let nextChurnIn = '';
  export let churnHalted = false;
  export let churnProgress = null;
  export let nodesExpanded = false;
  export let compact = false;

  const dispatch = createEventDispatcher();
  $: summary = summarizeBondMetrics(rows, history);
  $: churnPct = Math.round((churnProgress ?? 0) * 100);
  $: currentAvailable = loadedOnce && (!bondError || rows.length > 0);
  $: historyAvailable = loaded && (!error || history.length > 0);
  $: historyNote = error
    ? history.length ? 'partial history' : 'history unavailable'
    : historyLoading ? 'loading history' : loaded && !history.length ? 'no churn history' : '';
</script>

<section class="bond-summary" class:compact aria-label="Bond summary" aria-busy={loading || historyLoading}>
  <div class="bond-metrics">
    <div class="bond-metric m-bond">
      <span class="bond-index">01</span>
      <span class="bond-label">bond ᚱ</span>
      <strong class="bond-value accent">{currentAvailable ? fmtAmount(summary.bondRune, 1) : '—'}</strong>
      <span class="bond-sub">{currentAvailable ? money(summary.bondRune * runePriceUsd) : loading ? 'loading bonds' : bondError ? 'bonds unavailable' : ''}</span>
    </div>
    <div class="bond-metric m-award">
      <span class="bond-index">02</span>
      <span class="bond-label">next award ᚱ</span>
      <strong class="bond-value">{currentAvailable ? fmtAmount(summary.pendingRewardRune, 1) : '—'}</strong>
      <span class="bond-sub">{currentAvailable ? money(summary.pendingRewardRune * runePriceUsd) : ''}</span>
    </div>
    <div class="bond-metric m-earned" title="Rewards earned across the displayed churn history, excluding bond and unbond transactions">
      <span class="bond-index">03</span>
      <span class="bond-label">total earned ᚱ</span>
      <strong class="bond-value amber" class:negative={summary.totalRewardsRune < 0}>{historyAvailable ? signed(fmtAmount(summary.totalRewardsRune, 1), summary.totalRewardsRune) : '—'}</strong>
      <span class="bond-sub" class:warning={!!error} title={error}>
        {#if historyAvailable}{money(summary.totalRewardsUsd)} · {fmtPct(summary.rewardPercent, 1)}{/if}
        {#if historyNote}<span>{historyNote}</span>{/if}
      </span>
    </div>
    <div class="bond-metric m-net">
      <span class="bond-index">04</span>
      <span class="bond-label">net bond/unbond</span>
      <strong class="bond-value" class:added={summary.netBondChangeRune > 0} class:negative={summary.netBondChangeRune < 0}>{historyAvailable ? signed(fmtAmount(summary.netBondChangeRune, 1), summary.netBondChangeRune) : '—'}</strong>
      <span class="bond-sub" class:warning={!!error} title={error}>
        {#if historyAvailable}{money(summary.netBondChangeRune * runePriceUsd)}{/if}
        {#if historyNote}<span>{historyNote}</span>{/if}
      </span>
    </div>
    <div class="bond-metric m-apy" title="APY projected from the combined rewards and bond across nodes, assuming all rewards are reinvested with daily compounding. Paid-out rewards do not compound in the bond.">
      <span class="bond-index">05</span>
      <span class="bond-label">apy</span>
      <strong class="bond-value accent">{currentAvailable ? fmtPct(summary.apy * 100, 2) : '—'}</strong>
      <span class="bond-sub">{currentAvailable ? `${money(summary.annualRewardRune * runePriceUsd)}/yr` : ''}</span>
    </div>
    <div class="bond-metric m-price">
      <span class="bond-index">06</span>
      <span class="bond-label">rune price</span>
      <strong class="bond-value">{runePriceUsd > 0 ? money(runePriceUsd) : '—'}</strong>
    </div>
    <div class="bond-metric m-churn">
      <span class="bond-index">07</span>
      <span class="bond-label">next churn</span>
      <strong class="bond-value amber">{nextChurnIn || '—'}</strong>
      {#if churnHalted}<span class="bond-sub warning">HALTED</span>{/if}
      <!-- The next award accrues across this cycle and pays out when it fills. -->
      {#if churnProgress != null}
        <span
          class="churn-track"
          class:halted={churnHalted}
          role="progressbar"
          aria-label="Churn cycle elapsed"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={churnPct}
          title="{churnPct}% of this churn cycle elapsed"
        ><span class="churn-fill" style="width: {churnPct}%"></span></span>
      {/if}
    </div>
    <div class="bond-metric m-nodes">
      <span class="bond-index">08</span>
      {#if summary.nodeCount === 1}
        <span class="bond-label">node fee</span>
        <strong class="bond-value">{currentAvailable ? fmtPct(summary.nodeFee * 100, 1) : '—'}</strong>
        <span class="bond-sub">
          <a href={nodeUrl(summary.nodeAddress)} target="_blank" rel="noopener noreferrer">{shortAddr(summary.nodeAddress, 4, 4)}</a>
          <button class="nodes-link" on:click={() => dispatch('showNodes')} aria-expanded={nodesExpanded} aria-controls="node-bonds-content">view node</button>
        </span>
      {:else}
        <span class="bond-label">nodes</span>
        <button class="bond-value nodes-value" disabled={!currentAvailable || !summary.nodeCount} on:click={() => dispatch('showNodes')} aria-label="Show {summary.nodeCount} bonded nodes" aria-expanded={nodesExpanded} aria-controls="node-bonds-content">{currentAvailable ? summary.nodeCount : '—'}</button>
        <span class="bond-sub">{currentAvailable && summary.nodeCount ? 'view node bonds' : ''}</span>
      {/if}
    </div>
  </div>
</section>

<style>
  .bond-summary { container: bond-summary / inline-size; margin-bottom: 16px; }
  .bond-metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border: 1px solid var(--term-border);
    background: var(--term-surface);
    font-family: var(--term-font-mono);
  }
  .bond-metric {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    min-width: 0;
    min-height: 116px;
    box-sizing: border-box;
    padding: 16px 18px;
    border-right: 1px solid var(--term-border);
    border-bottom: 1px solid var(--term-border);
  }
  .bond-metric:nth-child(4n) { border-right: 0; }
  .bond-metric:nth-last-child(-n+4) { border-bottom: 0; }
  .bond-metric:hover { background: var(--term-surface-hover); }
  .bond-index { position: absolute; right: 12px; top: 13px; font-size: 10px; color: var(--term-accent); }
  .bond-label { padding-right: 18px; font-size: 11px; line-height: 1.2; letter-spacing: 0.12em; font-weight: 600; text-transform: uppercase; color: var(--term-text-3); }
  .bond-value { font-family: inherit; font-size: 24px; line-height: 1.1; font-weight: 800; color: var(--term-text); white-space: nowrap; }
  .bond-sub { font-size: 11px; color: var(--term-text-4); line-height: 1.4; }
  .bond-sub > span { display: block; }
  .accent { color: var(--term-accent); }
  .amber, .warning { color: var(--term-amber); }
  .added { color: var(--term-info); }
  .negative { color: var(--term-error); }
  .nodes-value { background: transparent; border: 0; padding: 0; text-align: left; cursor: pointer; }
  .nodes-value:disabled { cursor: default; }
  .nodes-value:hover:not(:disabled), .nodes-link:hover { color: var(--term-accent); }
  .nodes-value:focus-visible, .nodes-link:focus-visible { outline: 1px solid var(--term-accent); outline-offset: 4px; }
  .nodes-link { font: inherit; background: transparent; border: 1px solid var(--term-border); padding: 1px 5px; margin-left: 6px; color: var(--term-text-3); cursor: pointer; }
  @container bond-summary (max-width: 850px) {
    .bond-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .bond-metric:nth-child(2n) { border-right: 0; }
    .bond-metric:nth-last-child(-n+4) { border-bottom: 1px solid var(--term-border); }
    .bond-metric:nth-last-child(-n+2) { border-bottom: 0; }
  }
  @container bond-summary (max-width: 460px) {
    .bond-metrics { grid-template-columns: minmax(0, 1fr); }
    .bond-metric { padding: 16px 18px; border-right: 0; }
    .bond-metric:nth-last-child(-n+2) { border-bottom: 1px solid var(--term-border); }
    .bond-metric:last-child { border-bottom: 0; }
  }
  .churn-track { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: var(--term-border); }
  .churn-fill { display: block; height: 100%; background: var(--term-amber); }
  .churn-track.halted .churn-fill { background: var(--term-text-4); }

  /* Phone board: the four numbers checked most fill the first two rows, the rest
     follow at a smaller size. Grid gaps draw the rules so reordering keeps them intact. */
  .compact { margin-bottom: 12px; }
  .compact .bond-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--term-border); }
  .compact .bond-metric { min-height: 0; padding: 10px 12px 12px; gap: 3px; border: 0; background: var(--term-surface); }
  .compact .bond-index { display: none; }
  .compact .bond-label { padding-right: 0; font-size: 10px; letter-spacing: 0.08em; }
  .compact .bond-value { font-size: clamp(18px, 6.4cqi, 26px); letter-spacing: -0.01em; }
  .compact .bond-sub { font-size: 11px; line-height: 1.3; }
  .compact .m-bond { order: 1; }
  .compact .m-award { order: 2; }
  .compact .m-apy { order: 3; }
  .compact .m-churn { order: 4; }
  .compact .m-earned { order: 5; }
  .compact .m-net { order: 6; }
  .compact .m-price { order: 7; }
  .compact .m-nodes { order: 8; }
  .compact .m-earned, .compact .m-net, .compact .m-price, .compact .m-nodes { padding: 8px 12px 9px; gap: 1px; background: var(--term-inset, #060606); }
  .compact .m-earned .bond-value, .compact .m-net .bond-value, .compact .m-price .bond-value, .compact .m-nodes .bond-value { font-size: 15px; font-weight: 700; }
  .compact .m-earned .bond-sub, .compact .m-net .bond-sub { font-size: 10px; }
  .compact .churn-track { height: 4px; }
</style>
