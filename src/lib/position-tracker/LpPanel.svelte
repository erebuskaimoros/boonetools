<script>
  import { createEventDispatcher } from 'svelte';
  import { fmtAmount, fmtDate, fmtPct, poolTicker, shortAddr } from './format.js';

  export let rows = [];
  export let labels = {};
  export let money = (value) => String(value);
  export let loading = false;
  export let loadedOnce = false;
  export let lpPaused = false;

  const dispatch = createEventDispatcher();
  const TYPE_LABEL = { sym: 'sym', rune: 'rune-only', asset: 'asset-only' };
</script>

<section class="block">
  <div class="block-head">
    <div class="block-title"><span class="title-marker">▌</span><h2>liquidity positions</h2></div>
    <div class="block-actions">
      {#if lpPaused}<span class="block-meta warn-text">[lp paused]</span>{/if}
      <button class="bracket-btn" on:click={() => dispatch('action', { kind: 'lp-add' })}>
        <span class="bracket">[</span><span class="key">+</span><span class="bracket">]</span> add liquidity
      </button>
    </div>
  </div>

  {#if !loadedOnce && loading}
    <p class="loader">▓░░░░ loading positions</p>
  {:else if rows.length === 0}
    <p class="hint">No open liquidity positions for the tracked addresses.</p>
  {:else}
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>pool</th>
            <th>owner</th>
            <th>type</th>
            <th class="right">redeem ᚱ</th>
            <th class="right">redeem asset</th>
            <th class="right">value</th>
            <th class="right">vs deposit</th>
            <th class="right">luvi growth</th>
            <th>since</th>
            <th class="right">manage</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.key)}
            <tr>
              <td class="strong" title={row.pool}>{poolTicker(row.pool)}</td>
              <td title={row.owner}>{labels[row.owner] || shortAddr(row.owner)}</td>
              <td><span class="pill">{TYPE_LABEL[row.type]}</span>{#if row.runePending > 0 || row.assetPending > 0}<span class="pill warn">pending</span>{/if}</td>
              <td class="right">{row.hasLiveValue ? fmtAmount(row.runeRedeem, 2) : '--'}</td>
              <td class="right">{row.hasLiveValue ? fmtAmount(row.assetRedeem, 4) : '--'}</td>
              <td class="right accent">{row.hasLiveValue ? money(row.valueUsd) : '--'}</td>
              <td class="right" class:pos={row.gainUsd > 0} class:neg={row.gainUsd < 0}>
                {row.hasLiveValue ? `${row.gainUsd >= 0 ? '+' : ''}${money(row.gainUsd)}` : '--'}
              </td>
              <td class="right" class:pos={row.luviGrowthPct > 0} class:neg={row.luviGrowthPct < 0}>
                {row.hasLiveValue ? fmtPct(row.luviGrowthPct, 1) : '--'}
              </td>
              <td class="nowrap">{fmtDate(row.firstAdded)}</td>
              <td class="right nowrap">
                <button class="row-btn" aria-label="Add liquidity to {poolTicker(row.pool)}" on:click={() => dispatch('action', { kind: 'lp-add', pool: row.pool, row })}>+add</button>
                <button class="row-btn" aria-label="Withdraw liquidity from {poolTicker(row.pool)}" on:click={() => dispatch('action', { kind: 'lp-withdraw', pool: row.pool, row })}>−withdraw</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="hint">Redeem values come from THORNode at current pool depth. "vs deposit" compares today's value with the deposited amounts priced today.</p>
  {/if}
</section>
