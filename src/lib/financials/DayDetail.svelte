<script>
  import { onMount, onDestroy } from 'svelte';
  import { fetchFinancialDay } from './api.js';
  import { financialDayPollDelay } from './day-poll.js';
  import { financialDayStatus } from './day-status.js';
  import { formatFinancialAmount } from '../../../shared/financials/model.js';
  import { formatLocalDateTime } from '../utils/datetime.js';
  export let day;
  export let onClose = () => {};
  let detail = null, error = '', loading = true, request, timer, destroyed = false, sequence = 0;
  $: dayStatus = financialDayStatus(detail);
  const usd = value => formatFinancialAmount(value, 'usd', false);
  const assetLabel = value => String(value || '—').split('-')[0];
  const time = value => formatLocalDateTime(value, { year: undefined });
  const bps = value => Number.isFinite(value) ? `${(value * 10000).toFixed(2)} bps` : '—';
  async function load() {
    const id = ++sequence;
    clearTimeout(timer);
    request?.abort(); request = new AbortController();
    try {
      const result = await fetchFinancialDay(day, { signal: request.signal });
      if (destroyed || id !== sequence) return;
      detail = result; error = '';
    } catch (failure) { if (!destroyed && id === sequence && failure.name !== 'AbortError') error = failure.message; }
    finally {
      if (!destroyed && id === sequence) {
        loading = false;
        const nextPoll = financialDayPollDelay(detail, error);
        if (nextPoll !== null) timer = setTimeout(refreshWhenVisible, nextPoll);
      }
    }
  }
  function refreshWhenVisible() {
    if (destroyed) return;
    if (document.visibilityState === 'visible') load();
    else timer = setTimeout(refreshWhenVisible, 5000);
  }
  onMount(() => { load(); });
  onDestroy(() => { destroyed = true; sequence++; request?.abort(); clearTimeout(timer); });
</script>

<section class="day-detail" aria-label={`Top swaps and pools for ${day}`} aria-busy={loading || detail?.loading}>
  <header><h3><span aria-hidden="true">▌</span> {day} <span class="muted">· UTC{detail?.partial ? ' · IN PROGRESS' : ''}</span></h3>
    <button on:click={onClose} aria-label="Close day details">[×] close</button></header>
  <p class="progress" role="status">
    {#if !error && detail?.deferred}
      {dayStatus.pauseLabel}{detail.retryAt ? ` until ${formatLocalDateTime(detail.retryAt)}` : ''} · saved progress is preserved.
      <span class="deferred-reason">{detail.error}</span>
    {:else if error || detail?.error}{error || detail.error} <button on:click={load}>[R] retry</button>
    {:else if loading || detail?.loading}Loading the full day’s rankings{detail?.progress?.pages ? ` · ${detail.progress.pages} swap pages checked` : ''}…
    {:else}Through {detail?.through ? formatLocalDateTime(detail.through) : `${day} UTC`}{detail?.refreshing ? ' · refreshing' : ''}{/if}
  </p>
  {#if dayStatus.warning}<p class="warning">{dayStatus.warning}</p>{/if}
  {#if dayStatus.settlement}<p class="basis">{dayStatus.settlement}</p>{/if}
  <div class="rankings">
    <section aria-labelledby="top-swaps-title"><h4 id="top-swaps-title">TOP 10 SWAPS <span>INPUT VALUE · USD</span></h4>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll the table.) -->
      <div class="table-scroll" tabindex="0" role="region" aria-label="Top ten swaps">
        <table><thead><tr><th scope="col">#</th><th scope="col">SWAP</th><th scope="col" class="amount">VALUE</th><th scope="col" class="amount">FEES</th><th scope="col" class="amount">RATE</th></tr></thead>
          <tbody>{#each detail?.swaps || [] as row, index (row.txId)}<tr><td>{String(index + 1).padStart(2, '0')}</td>
            <th scope="row" title={`${row.inputAsset} → ${row.outputAsset}`}><a href={`https://thorchain.net/tx/${encodeURIComponent(row.txId)}`} target="_blank" rel="noreferrer" title={`${row.txId} · ${time(row.timestamp)}`}>{assetLabel(row.inputAsset)} <span class="muted">→</span> {assetLabel(row.outputAsset)}</a>{#if row.streaming}<small>STREAMING</small>{/if}</th>
            <td class="amount">{usd(row.volumeUsd)}</td><td class="amount fee">{usd(row.feeUsd)}</td><td class="amount fee">{bps(row.feeRate)}</td>
          </tr>{/each}
          {#if !detail?.swaps?.length}<tr><td colspan="5" class="empty">{loading || detail?.loading ? 'Waiting for complete swap coverage…' : error || detail?.error ? 'Swap ranking unavailable.' : 'No completed, priced swaps in this window.'}</td></tr>{/if}</tbody>
        </table>
      </div>
    </section>
    <section aria-labelledby="top-pools-title"><h4 id="top-pools-title">TOP 10 POOLS <span>EXECUTED VOLUME · USD</span></h4>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll the table.) -->
      <div class="table-scroll" tabindex="0" role="region" aria-label="Top ten pools by volume">
        <table><thead><tr><th scope="col">#</th><th scope="col">POOL</th><th scope="col" class="amount">VOLUME</th></tr></thead>
          <tbody>{#each detail?.pools || [] as row, index (row.asset)}<tr><td>{String(index + 1).padStart(2, '0')}</td><th scope="row" title={row.asset}>{assetLabel(row.asset)}</th><td class="amount">{usd(row.volumeUsd)}</td></tr>{/each}
          {#if !detail?.pools?.length}<tr><td colspan="3" class="empty">{loading || detail?.loading ? 'Waiting for complete pool coverage…' : error || detail?.error ? 'Pool ranking unavailable.' : 'No pool volume in this window.'}</td></tr>{/if}</tbody>
        </table>
      </div>
    </section>
  </div>
  <p class="basis">Swaps use input value once per route and Midgard’s action date. Pool volume counts each executed leg; cross-asset swaps touch two pools. All rankings are in USD. Fees are THORChain liquidity fees from Midgard, valued at RUNE’s USD price for the swap’s 15-minute window; rate is fees ÷ input value.</p>
  <p class="basis">Today’s roster adds newly indexed activity in the background and stays cached after the full UTC day is covered. Older, untracked days may need a one-time build while this panel is open.</p>
</section>

<style>
  .day-detail { border-top: 1px solid var(--term-border); margin-top: 18px; padding-top: 18px; }
  header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  h3 { margin: 0; font: 12px var(--term-font-mono); } h3 > span:first-child { color: var(--term-accent); }
  .muted, small { color: var(--term-text-3); }
  button { color: var(--term-text-2); font: 11px var(--term-font-mono); border: 1px solid var(--term-border); border-radius: 0; background: transparent; padding: 6px 8px; cursor: pointer; }
  button:hover, a:hover { color: var(--term-accent); }
  button:focus-visible, a:focus-visible, .table-scroll:focus-visible { outline: 2px solid var(--term-accent); outline-offset: 2px; }
  .progress, .basis, .warning { font: 11px/1.7 var(--term-font-mono); color: var(--term-text-3); margin: 10px 0; }
  .deferred-reason { display: block; color: var(--term-amber); overflow-wrap: anywhere; }
  .warning { color: var(--term-amber); }
  .rankings { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr); gap: 24px; }
  h4 { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; font: 12px var(--term-font-mono); color: var(--term-text); margin: 16px 0 12px; }
  h4 span { font-size: 11px; color: var(--term-text-3); }
  .table-scroll { overflow: auto; }
  table { border-collapse: collapse; width: 100%; font: 12px var(--term-font-mono); white-space: nowrap; }
  th, td { padding: 11px 8px; text-align: left; border-bottom: 1px solid var(--term-border); font-weight: 400; }
  thead th { font-size: 11px; color: var(--term-text-3); background: var(--term-surface); }
  td:first-child { color: var(--term-text-3); }
  .amount { text-align: right; }
  td.amount { color: var(--term-accent); } td.fee { color: var(--term-text-2); }
  tr:hover { background: var(--term-surface-hover); }
  a { color: inherit; text-underline-offset: 3px; } small { display: block; font-size: 11px; margin-top: 4px; }
  .empty { white-space: normal; color: var(--term-text-3); padding: 20px 8px; }
  @media (max-width: 1100px) { .rankings { grid-template-columns: minmax(0, 1fr); gap: 10px; } }
</style>
