<script>
  import { onMount, onDestroy } from 'svelte';
  import TerminalAlert from '../components/terminal/TerminalAlert.svelte';
  import { booneToolsApi } from '../api/boonetools.js';
  import { PROTOCOLS, COMPARISON_METHODOLOGY, NEAR_NET_SUPPLY_METHOD, comparisonStartDay, formatComparisonMonth, formatComparisonUsd } from '../../../shared/protocol-fee-comparison/model.js';
  import { comparisonDisplayMonths } from './time-series.js';
  let payload, Chart, error = '', loading = true, hidden = [], timer, request, destroyed = false, generation = 0;
  $: displayMonths = comparisonDisplayMonths(payload?.daily || [], payload?.months || [], {
    fromDay: payload?.fromDay, throughDay: payload?.throughDay
  });
  $: incomplete = displayMonths.some(month => PROTOCOLS.some(({ id }) => !month.protocols[id].complete));
  $: nearNetSupply = payload?.nearIssuanceMethod === NEAR_NET_SUPPLY_METHOD;
  $: thorchainRewardAccounting = payload?.methodology === COMPARISON_METHODOLOGY;
  async function load() {
    const current = ++generation;
    request?.abort(); request = new AbortController(); clearTimeout(timer);
    try {
      let result;
      if (import.meta.env.DEV) {
        const response = await fetch('/__protocol-fee-comparison', { signal: request.signal });
        result = await response.json(); if (!response.ok) throw new Error(result.error);
      } else result = await booneToolsApi.get('/protocol-fee-comparison', { signal: request.signal });
      if (destroyed || current !== generation) return;
      payload = result; error = '';
      if (!Chart) {
        const component = (await import('./Chart.svelte')).default;
        if (!destroyed && current === generation) Chart = component;
      }
    } catch (failure) { if (!destroyed && current === generation && failure.name !== 'AbortError') error = failure.message || 'Monthly comparison unavailable'; }
    finally { if (!destroyed && current === generation) { loading = false; timer = setTimeout(load, 60_000); } }
  }
  onMount(() => { void load(); });
  onDestroy(() => { destroyed = true; clearTimeout(timer); request?.abort(); });
</script>

<section class="comparison" aria-labelledby="comparison-title" aria-busy={loading}>
  <div class="heading"><h2 id="comparison-title"><span>▌</span> Cross-chain Competitors</h2><span class="meta">[USD · SHARED DATES]</span></div>
  <div class="toolbar">
    <button class="refresh" on:click={load}>[R] refresh</button>
  </div>
  {#if error}<TerminalAlert tone="warn" tag="DATA">{error}</TerminalAlert>{/if}
  {#if incomplete}<TerminalAlert tone="warn" tag="GAPS">Some source data is unavailable.</TerminalAlert>{/if}
  {#if Chart && (displayMonths.length || payload?.daily?.length)}<svelte:component this={Chart} months={displayMonths} daily={payload.daily || []} bind:hidden {nearNetSupply} {thorchainRewardAccounting} />
  {:else}<div class="empty" role="status">{loading ? 'Loading comparison…' : 'No comparison data available.'}</div>{/if}
  <div class="footer"><span>FULL SOURCE HISTORY · {payload?.fromDay || comparisonStartDay()} → {payload?.throughDay || 'pending'} · UTC</span><span>{payload?.stale ? 'SOURCE DELAYED' : 'REFRESHES EVERY 6 HOURS'} · * partial month</span></div>
  <details><summary>MONTHLY DATA</summary>
    {#if payload?.errors?.length}<p class="diagnostic">{payload.errors.join(' · ')}</p>{/if}
    {#if displayMonths.length}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll the table.) -->
      <div class="table-scroll" role="region" tabindex="0" aria-label="Monthly comparison data">
        <table><thead><tr><th>MONTH · UTC</th><th>PROTOCOL</th><th>INCOME</th><th>DEDUCTION</th><th>NET</th><th>COVERAGE</th></tr></thead><tbody>
          {#each [...displayMonths].reverse() as month}{#each PROTOCOLS as protocol}
            {@const point = month.protocols[protocol.id]}
            <tr><th scope="row">{formatComparisonMonth(month.month)}{month.partial ? ' *' : ''}</th>
              <td>{protocol.label}</td>
              <td>{formatComparisonUsd(point.incomeUsd)}</td>
              <td>{formatComparisonUsd(point.subsidyUsd)}</td>
              <td style={`color:${protocol.color}`}>{formatComparisonUsd(point.netUsd)}</td>
              <td>{point.observedDays}/{point.expectedDays} days</td>
            </tr>
          {/each}{/each}
        </tbody></table>
      </div>
    {/if}
  </details>
  <div class="sources">SOURCES <a href="https://gateway.liquify.com/chain/thorchain_midgard/v2/doc" target="_blank" rel="noreferrer">Midgard</a> · <a href="https://defillama.com/protocol/chainflip" target="_blank" rel="noreferrer">DeFiLlama</a> · <a href="https://docs.fastnear.com/" target="_blank" rel="noreferrer">FastNear</a> · <a href="https://scan.chainflip.io/" target="_blank" rel="noreferrer">Chainflip</a>{#if payload?.nearWalletMethod !== 'fastnear-transfers-v1'} · Powered by <a href="https://dune.com/queries/8767542" target="_blank" rel="noreferrer">Dune</a>{/if}</div>
</section>

<style>
  .comparison { margin-top: 24px; border: 1px solid var(--term-border); background: var(--term-surface); padding: 20px; font-family: var(--term-font-mono); }
  .comparison :global(*) { font-family: inherit; }
  .heading, .toolbar, .footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  h2 { margin: 0; font-size: 13px; letter-spacing: .08em; line-height: 1.5; }
  h2 > span { color: var(--term-accent); }
  .meta, .footer, .sources { font-size: 11px; color: var(--term-text-3); line-height: 1.7; }
  p { font-family: var(--term-font-body) !important; font-size: 13px; line-height: 1.65; color: var(--term-text-3); }
  .toolbar { margin: 10px 0; }
  button { border-radius: 0; cursor: pointer; background: transparent; color: var(--term-text-2); font-size: 11px; }
  .refresh { border: 1px solid var(--term-border); padding: 6px 10px; }
  button:hover, a:hover { color: var(--term-accent); }
  button:focus-visible, summary:focus-visible, .table-scroll:focus-visible { outline: 2px solid var(--term-accent); outline-offset: 3px; }
  .empty { min-height: 180px; display: grid; place-items: center; font-size: 12px; color: var(--term-text-3); text-align: center; }
  .footer { border-top: 1px solid var(--term-border); padding-top: 14px; }
  details { border-top: 1px solid var(--term-border); }
  summary { cursor: pointer; padding: 14px 0; font-size: 11px; letter-spacing: .04em; }
  .diagnostic { color: var(--term-amber); }
  .sources { margin-top: 14px; }
  a { color: var(--term-text-2); text-underline-offset: 3px; }
  .table-scroll { overflow: auto; max-height: 400px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; white-space: nowrap; }
  td, th { text-align: right; padding: 12px; border-bottom: 1px solid var(--term-border); font-weight: 400; }
  td:nth-child(2), th:first-child { text-align: left; }
  thead th { font-size: 11px; position: sticky; top: 0; background: var(--term-surface); color: var(--term-text-3); }
  @media (max-width: 700px) { .comparison { padding: 16px 10px; } .refresh { margin-left: auto; } }
</style>
