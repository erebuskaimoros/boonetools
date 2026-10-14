<script>
  import { onMount, onDestroy } from 'svelte';
  import TerminalAlert from '../components/terminal/TerminalAlert.svelte';
  import { booneToolsApi } from '../api/boonetools.js';
  import { PROTOCOLS, COMPARISON_METHODOLOGY, THORCHAIN_CORRECTED_FROM_DAY, NEAR_NET_SUPPLY_METHOD, comparisonStartDay, formatComparisonMonth, formatComparisonUsd } from '../../../shared/protocol-fee-comparison/model.js';
  import { comparisonDisplayMonths } from './time-series.js';
  let payload, Chart, error = '', loading = true, hidden = [], timer, request, destroyed = false, generation = 0;
  $: displayMonths = comparisonDisplayMonths(payload?.daily || [], payload?.months || [], {
    fromDay: payload?.fromDay, throughDay: payload?.throughDay
  });
  $: incomplete = displayMonths.some(month => PROTOCOLS.some(({ id }) => !month.protocols[id].complete));
  $: hasLegacy = displayMonths.some(month => month.protocols?.thorchain?.legacyDays > 0);
  $: nearOnchain = payload?.nearIssuanceMethod === 'onchain-epoch-mints-v1';
  $: nearNetSupply = payload?.nearIssuanceMethod === NEAR_NET_SUPPLY_METHOD;
  $: thorchainRewardAccounting = payload?.methodology === COMPARISON_METHODOLOGY;
  $: includesFrontend = [COMPARISON_METHODOLOGY, 'swap-income-less-network-subsidy-near-net-v3', 'swap-income-less-gross-network-subsidy-v2'].includes(payload?.methodology);
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
  <p class="lede">Swap-service income after network token costs, on one USD scale. Full history retains clearly labelled legacy THORChain accounting; Latest verified shows only the shared corrected period.</p>
  <div class="toolbar">
    <button class="refresh" on:click={load}>[R] refresh</button>
  </div>
  {#if error}<TerminalAlert tone="warn" tag="DATA">{error}</TerminalAlert>{/if}
  {#if payload && !thorchainRewardAccounting}<TerminalAlert tone="warn" tag="TC">This older snapshot uses Midgard’s signed earnings residual, not Reserve emissions, and does not separately deduct REVSHARE. Latest verified requires a corrected snapshot.</TerminalAlert>{/if}
  {#if thorchainRewardAccounting && payload.thorchainRewardAccounting?.complete === false}<TerminalAlert tone="warn" tag="TC">Exact reward accounting verified for {payload.thorchainRewardAccounting.observedDays}/{payload.thorchainRewardAccounting.expectedDays} THORChain fee-history days. {hasLegacy ? `Full history includes labelled cached legacy values before ${THORCHAIN_CORRECTED_FROM_DAY}; those residuals are not verified Reserve emissions.` : 'Historical days without verified Reserve emissions and REVSHARE remain unavailable.'}</TerminalAlert>{/if}
  {#if incomplete}<TerminalAlert tone="warn" tag="GAPS">Full history includes coverage gaps. Missing bars mean unavailable data, not zero; see monthly coverage below.</TerminalAlert>{/if}
  {#if Chart && (displayMonths.length || payload?.daily?.length)}<svelte:component this={Chart} months={displayMonths} daily={payload.daily || []} bind:hidden {nearNetSupply} {thorchainRewardAccounting} />
  {:else}<div class="empty" role="status">{loading ? 'Loading comparison…' : 'No verified source coverage is available. No estimates are substituted for missing data.'}</div>{/if}
  <div class="footer"><span>FULL SOURCE HISTORY · {payload?.fromDay || comparisonStartDay()} → {payload?.throughDay || 'pending'} · UTC</span><span>{payload?.stale ? 'SOURCE DELAYED' : 'REFRESHES EVERY 6 HOURS'} · * partial month</span></div>
  <p class="qualification"><strong>100% network-subsidy scenario, not operating profit.</strong> NEAR Intents uses provisional retained wallet receipts{includesFrontend ? ', including its own frontend,' : ', excluding its frontend in this older snapshot,'} and deducts {nearNetSupply ? 'exact net supply change (emissions minus all protocol burns, not just gas fees)' : nearOnchain ? 'gross on-chain issuance in this older snapshot' : 'modeled gross issuance in this older snapshot'} for the entire NEAR chain, which also secures other applications. Corrected THORChain days deduct affiliate REVSHARE and independently verified Reserve emissions; legacy days use the uncorrected Midgard earnings residual. Chainflip uses historical on-chain issuance before burns.</p>
  <details><summary>METHODOLOGY &amp; MONTHLY DATA</summary>
    <p>THORChain: {thorchainRewardAccounting ? 'corrected days use gross Midgard liquidity fees minus affiliate REVSHARE, then subtract independently verified Reserve emissions once. All flows use the same historical daily RUNE price.' : 'this older snapshot subtracts Midgard’s signed earnings residual from gross liquidity fees. That residual is not an audited Reserve-release ledger and can overstate after-subsidy income.'}</p>
    {#if hasLegacy}<p>Legacy history before {THORCHAIN_CORRECTED_FROM_DAY} restores cached gross fees minus Midgard’s signed earnings residual. REVSHARE is not separately deducted in those legacy values, and the residual must not be read as verified Reserve emissions. Mixed buckets sum legacy gross-fee/residual results with corrected retained-fee/emission results; their totals are not a fully corrected historical series. Latest verified excludes legacy days.</p>{/if}
    <p>Chainflip: AMM Network Fee income only, minus historical FLIP emissions reconstructed from finalized blocks and their on-chain emission amounts. LP, broker, gas and lending income are excluded. Unverified runtime upgrades leave a data gap, never an assumed emission rate.</p>
    <p>NEAR: {includesFrontend ? 'total retained Intents revenue across its proprietary frontend, 1Click fund and buyback wallets. The included frontend share is allocated using each day’s NEAR/wNEAR receipt split ' : 'this older snapshot excludes the proprietary frontend share from retained Intents revenue'}. Third-party payouts, internal transfers and contract-call deposits are excluded. Deducts {nearNetSupply ? 'the change in total NEAR supply between archive-verified UTC day boundaries, including gas-fee burns, slashing and any other protocol destruction. This is whole-chain net issuance, not gross gas fees paid or Intents-only costs. Negative issuance is retained, not floored to zero' : nearOnchain ? 'gross whole-chain issuance measured from epoch-boundary supply changes plus included chunk burns' : 'the official dashboard’s daily whole-chain issuance model'}. The receipt proxy does not reconcile with the dashboard’s other revenue streams. No verifier fee or frontend income is added a second time.</p>
    <p>Subsidies use historical daily USD prices before summing months. All series share the same cutoff, using completed UTC days. Latest verified uses the latest continuous period covered by all three protocols. Full history retains the twelve complete calendar months plus the current partial month; missing days make that protocol’s month unavailable. Historical coverage gaps do not by themselves mean current source data is delayed.</p>
    {#if payload?.errors?.length}<p class="diagnostic">{payload.errors.join(' · ')}</p>{/if}
    {#if displayMonths.length}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll the table.) -->
      <div class="table-scroll" role="region" tabindex="0" aria-label="Monthly comparison data">
        <table><thead><tr><th>MONTH · UTC</th><th>PROTOCOL / ACCOUNTING</th><th>SWAP INCOME BASIS</th><th>DEDUCTION</th><th>NET COMPARISON</th><th>DISPLAY COVERAGE</th></tr></thead><tbody>
          {#each [...displayMonths].reverse() as month}{#each PROTOCOLS as protocol}
            {@const point = month.protocols[protocol.id]}
            {@const accounting = thorchainRewardAccounting ? point.accounting || 'corrected' : 'legacy'}
            <tr><th scope="row">{formatComparisonMonth(month.month)}{month.partial ? ' *' : ''}</th>
              <td>{protocol.label}{#if protocol.id === 'thorchain'}<small>{accounting.toUpperCase()}</small>{/if}</td>
              <td>{formatComparisonUsd(point.incomeUsd)}{#if protocol.id === 'thorchain'}<small>{accounting === 'legacy' ? 'Legacy gross fees' : accounting === 'mixed' ? 'Legacy gross + corrected retained' : 'Corrected retained fees'}</small>{/if}</td>
              <td>{formatComparisonUsd(point.subsidyUsd)}{#if protocol.id === 'thorchain'}<small>{accounting === 'legacy' ? 'Legacy earnings residual' : accounting === 'mixed' ? 'Legacy residual + Reserve emissions' : 'Reserve emissions'}</small>{/if}</td>
              <td style={`color:${protocol.color}`}>{formatComparisonUsd(point.netUsd)}</td>
              <td>{point.observedDays}/{point.expectedDays} days{#if protocol.id === 'thorchain' && thorchainRewardAccounting && point.legacyDays}<small>{point.legacyDays} legacy / {point.correctedDays} corrected</small>{/if}</td>
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
  .lede { margin: 10px 0 16px; }
  button { border-radius: 0; cursor: pointer; background: transparent; color: var(--term-text-2); font-size: 11px; }
  .refresh { border: 1px solid var(--term-border); padding: 6px 10px; }
  button:hover, a:hover { color: var(--term-accent); }
  button:focus-visible, summary:focus-visible, .table-scroll:focus-visible { outline: 2px solid var(--term-accent); outline-offset: 3px; }
  .empty { min-height: 180px; display: grid; place-items: center; font-size: 12px; color: var(--term-text-3); text-align: center; }
  .footer { border-top: 1px solid var(--term-border); padding-top: 14px; }
  .qualification { margin: 16px 0; }
  strong { color: var(--term-text-2); }
  details { border-top: 1px solid var(--term-border); }
  summary { cursor: pointer; padding: 14px 0; font-size: 11px; letter-spacing: .04em; }
  .diagnostic { color: var(--term-amber); }
  .sources { margin-top: 14px; }
  a { color: var(--term-text-2); text-underline-offset: 3px; }
  .table-scroll { overflow: auto; max-height: 400px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; white-space: nowrap; }
  td, th { text-align: right; padding: 12px; border-bottom: 1px solid var(--term-border); font-weight: 400; }
  td small { display: block; margin-top: 4px; color: var(--term-text-3); font-size: 11px; }
  td:nth-child(2), th:first-child { text-align: left; }
  thead th { font-size: 11px; position: sticky; top: 0; background: var(--term-surface); color: var(--term-text-3); }
  @media (max-width: 700px) { .comparison { padding: 16px 10px; } .refresh { margin-left: auto; } }
</style>
