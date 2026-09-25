<script>
  import { buildSummaryCards, formatSummaryValue, selectSummaryRows } from './summary.js';

  export let rows = [];
  export let metrics = [];
  export let window = null;
  export let bucket = 'day';
  export let loading = false;
  export let note = '';
  /** Feature-owned reductions, e.g. block-weighted intervals. */
  export let cards = null;
  $: selected = selectSummaryRows(rows, window);
  $: items = cards || buildSummaryCards(selected, metrics, bucket);
  $: partial = selected.filter(row => row.partial || row.provisional || row.priceProvisional).length;
  $: first = selected[0]?.day || selected[0]?.month;
  $: last = selected.at(-1)?.day || selected.at(-1)?.month;
  const display = (item, exact = false) => !Number.isFinite(item.value) ? '—'
    : item.format ? item.format(item.value) : formatSummaryValue(item.value, item.unit, exact);
</script>

<section class="range-summary" aria-label="Selected range summary" aria-busy={loading}>
  <dl class:two-cards={items.length === 2}>
    {#each items as item}
      <div class="summary-card">
        <dt>{item.label}</dt>
        <dd title={display(item, true)}>{loading ? '…' : display(item)}</dd>
        {#if item.secondary}
          <small title={display(item.secondary, true)}>{item.secondary.label}: {loading ? '…' : display(item.secondary)}</small>
        {/if}
        <small>{item.detail || 'Selected range'}</small>
      </div>
    {/each}
  </dl>
  <p>Selected range{first && last ? ` · ${first} → ${last}` : ''} · {selected.length} {bucket} observations{partial ? ` · ${partial} partial/provisional` : ''}. {note || 'Available observations only; partial buckets are not extrapolated.'}</p>
</section>

<style>
  .range-summary { min-width: 0; margin: 10px 0 14px; container-type: inline-size; }
  dl { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; border-top: 1px solid var(--term-border); border-left: 1px solid var(--term-border); }
  dl.two-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .summary-card { min-width: 0; padding: 12px; border-right: 1px solid var(--term-border); border-bottom: 1px solid var(--term-border); background: var(--term-surface); }
  dt { font: 11px var(--term-font-mono); text-transform: uppercase; letter-spacing: .04em; color: var(--term-text-3); overflow-wrap: anywhere; }
  dd { margin: 8px 0 6px; font: 600 22px var(--term-font-mono); color: var(--term-text); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  small, p { font: 11px/1.5 var(--term-font-mono); color: var(--term-text-3); overflow-wrap: anywhere; }
  small { display: block; }
  p { margin: 7px 0 0; }
  @container (max-width: 700px) { dl { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @container (max-width: 280px) { dl, dl.two-cards { grid-template-columns: minmax(0, 1fr); } }
</style>
