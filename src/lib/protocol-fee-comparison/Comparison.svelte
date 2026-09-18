<script>
  import { onMount, onDestroy } from 'svelte';
  import TerminalAlert from '../components/terminal/TerminalAlert.svelte';
  import { booneToolsApi } from '../api/boonetools.js';
  import { PROTOCOLS, comparisonStartDay, formatComparisonMonth, formatComparisonUsd } from '../../../shared/protocol-fee-comparison/model.js';
  let payload, Chart, error = '', loading = true, hidden = [], timer, request, destroyed = false, generation = 0;
  $: incomplete = payload?.months?.some(month => PROTOCOLS.some(({ id }) => !month.protocols[id].complete));
  $: nearOnchain = payload?.nearIssuanceMethod === 'onchain-epoch-mints-v1';
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
  function toggle(id) {
    if (!hidden.includes(id) && hidden.length === PROTOCOLS.length - 1) return;
    hidden = hidden.includes(id) ? hidden.filter((item) => item !== id) : [...hidden, id];
  }
  onMount(() => { void load(); });
  onDestroy(() => { destroyed = true; clearTimeout(timer); request?.abort(); });
</script>

<section class="comparison" aria-labelledby="comparison-title" aria-busy={loading}>
  <div class="heading"><h2 id="comparison-title"><span>▌</span> SWAP INCOME LESS TOKEN SUBSIDY</h2><span class="meta">[1Y · MONTHLY · USD]</span></div>
  <p class="lede">Swap-service income after the market value of network token subsidies. Twelve complete calendar months plus the current partial month, on one USD scale.</p>
  <div class="toolbar">
    <div class="legend" aria-label="Comparison series">{#each PROTOCOLS as protocol}
      <button class:muted={hidden.includes(protocol.id)} aria-pressed={!hidden.includes(protocol.id)} on:click={() => toggle(protocol.id)}><i style={`background:${protocol.color}`}></i>{protocol.label}</button>
    {/each}</div>
    <button class="refresh" on:click={load}>[R] refresh</button>
  </div>
  {#if error}<TerminalAlert tone="warn" tag="DATA">{error}</TerminalAlert>{/if}
  {#if incomplete}<TerminalAlert tone="warn" tag="GAPS">Historical backfill is incomplete. Missing bars mean unavailable data, not zero; see monthly coverage below.</TerminalAlert>{/if}
  {#if Chart && payload?.months?.length}<svelte:component this={Chart} months={payload.months} {hidden} />
  {:else}<div class="empty" role="status">{loading ? 'Loading monthly comparison…' : 'Waiting for verified source coverage. No estimates are substituted for missing data.'}</div>{/if}
  <div class="footer"><span>{payload?.fromDay || comparisonStartDay()} → {payload?.throughDay || 'pending'} · UTC</span><span>{payload?.stale ? 'SOURCE DELAYED' : 'REFRESHES EVERY 6 HOURS'} · * partial month</span></div>
  <p class="qualification"><strong>100% network-subsidy scenario, not operating profit.</strong> NEAR Intents uses provisional non-frontend wallet receipts and deducts {nearOnchain ? 'on-chain' : 'modeled'} issuance for the entire NEAR chain, which also secures other applications. THORChain includes reported Reserve block rewards; Chainflip uses historical on-chain issuance before burns.</p>
  <details><summary>METHODOLOGY &amp; MONTHLY DATA</summary>
    <p>THORChain: Midgard liquidity fees minus reported block rewards, valued using each day’s RUNE price. The signed block-reward field can contain accounting residuals; it is not an audited gross Reserve-release ledger.</p>
    <p>Chainflip: AMM Network Fee income only, minus historical FLIP emissions reconstructed from finalized blocks and their on-chain emission amounts. LP, broker, gas and lending income are excluded. Unverified runtime upgrades leave a data gap, never an assumed emission rate.</p>
    <p>NEAR: published Intents revenue allocated by daily NEAR/wNEAR receipts to the 1Click fund and buyback wallets, excluding the frontend wallet, internal transfers and contract-call deposits; minus {nearOnchain ? 'gross whole-chain issuance measured from epoch-boundary supply changes plus included chunk burns' : 'the official dashboard’s daily whole-chain issuance model (retained until the archive backfill is verified)'}. The receipt proxy does not reconcile with the dashboard’s other revenue streams. No verifier fee is added again.</p>
    <p>Subsidies use historical daily USD prices before summing months. All series share the same cutoff, using completed UTC days. Missing days make that protocol’s month unavailable; the current month may be partial.</p>
    {#if payload?.errors?.length}<p class="diagnostic">{payload.errors.join(' · ')}</p>{/if}
    {#if payload?.months?.length}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll the table.) -->
      <div class="table-scroll" role="region" tabindex="0" aria-label="Monthly comparison data">
        <table><thead><tr><th>MONTH · UTC</th><th>PROTOCOL</th><th>SWAP INCOME</th><th>TOKEN SUBSIDY</th><th>AFTER SUBSIDY</th><th>COVERAGE</th></tr></thead><tbody>
          {#each [...payload.months].reverse() as month}{#each PROTOCOLS as protocol}
            {@const point = month.protocols[protocol.id]}
            <tr><th scope="row">{formatComparisonMonth(month.month)}{month.partial ? ' *' : ''}</th><td>{protocol.label}</td><td>{formatComparisonUsd(point.incomeUsd)}</td><td>{formatComparisonUsd(point.subsidyUsd)}</td><td style={`color:${protocol.color}`}>{formatComparisonUsd(point.netUsd)}</td><td>{point.observedDays}/{point.expectedDays} days</td></tr>
          {/each}{/each}
        </tbody></table>
      </div>
    {/if}
  </details>
  <div class="sources">SOURCES <a href="https://gateway.liquify.com/chain/thorchain_midgard/v2/doc" target="_blank" rel="noreferrer">Midgard</a> · <a href="https://defillama.com/protocol/chainflip" target="_blank" rel="noreferrer">DeFiLlama</a> · <a href="https://docs.fastnear.com/" target="_blank" rel="noreferrer">FastNear</a> · <a href="https://revenue.near.org/" target="_blank" rel="noreferrer">NEAR dashboard</a> · <a href="https://scan.chainflip.io/" target="_blank" rel="noreferrer">Chainflip</a>{#if payload?.nearWalletMethod !== 'fastnear-transfers-v1'} · Powered by <a href="https://dune.com/queries/8767542" target="_blank" rel="noreferrer">Dune</a>{/if}</div>
</section>

<style>
  .comparison { margin-top: 24px; border: 1px solid var(--term-border); background: var(--term-surface); padding: 20px; font-family: var(--term-font-mono); }
  .comparison :global(*) { font-family: inherit; }
  .heading, .toolbar, .legend, .footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  h2 { margin: 0; font-size: 13px; letter-spacing: .08em; line-height: 1.5; }
  h2 > span { color: var(--term-accent); }
  .meta, .footer, .sources { font-size: 11px; color: var(--term-text-3); line-height: 1.7; }
  p { font-family: var(--term-font-body) !important; font-size: 13px; line-height: 1.65; color: var(--term-text-3); }
  .lede { margin: 10px 0 16px; }
  .legend { justify-content: flex-start; gap: 20px; }
  button { border-radius: 0; cursor: pointer; background: transparent; color: var(--term-text-2); font-size: 11px; }
  .legend button { display: flex; align-items: center; gap: 8px; border: 0; padding: 8px 0; }
  i { display: inline-block; height: 11px; width: 11px; }
  .muted { text-decoration: line-through; opacity: .6; }
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
  td:nth-child(2), th:first-child { text-align: left; }
  thead th { font-size: 11px; position: sticky; top: 0; background: var(--term-surface); color: var(--term-text-3); }
  @media (max-width: 700px) { .comparison { padding: 16px 10px; } .legend { gap: 12px; } .refresh { margin-left: auto; } }
</style>
