<script>
  import { createEventDispatcher } from 'svelte';
  import { fmtAmount, fmtPct, nodeUrl, shortAddr } from './format.js';
  import { BOND_YIELD_STATUSES } from './bond-yield.js';

  export let rows = [];
  export let labels = {};
  export let money = (value) => String(value);
  export let loading = false;
  export let loadedOnce = false;
  export let hasThor = false;
  export let nextChurnIn = '';
  export let churnHalted = false;
  export let expanded = false;
  export let gates = {};

  const dispatch = createEventDispatcher();

  const LEAVE_LABEL = { leaving: 'leaving', oldest: 'oldest', worst: 'slash pts', lowest: 'low bond' };

  function fmtApy(apy) {
    if (apy == null || apy === '' || !Number.isFinite(Number(apy))) return '--';
    return fmtPct(apy * 100, 1);
  }

  function churnFlag(row) {
    if (row.forcedToLeave) return 'forced out';
    if (row.leave?.type) return LEAVE_LABEL[row.leave.type] || row.leave.type;
    return '';
  }
</script>

<section class="block">
  <div class="block-head" class:collapsed={!expanded}>
    <div class="block-title">
      <span class="title-marker" aria-hidden="true">▌</span>
      <h2>
        <button class="panel-toggle" type="button" aria-expanded={expanded} aria-controls="node-bonds-content" on:click={() => expanded = !expanded}>
          node bonds <span class="toggle-state" aria-hidden="true">[{expanded ? '−' : '+'}]</span>
        </button>
      </h2>
      {#if loadedOnce}<span class="block-meta">[{rows.length}]</span>{/if}
    </div>
    <div class="block-actions">
      <span class="block-meta">
        {#if churnHalted}[churning halted]{:else if nextChurnIn}[next churn {nextChurnIn}]{/if}
      </span>
      <button class="bracket-btn" disabled={!hasThor} on:click={() => dispatch('action', { kind: 'bond' })}>
        <span class="bracket">[</span><span class="key">+</span><span class="bracket">]</span> bond to node
      </button>
    </div>
  </div>

  <div id="node-bonds-content">
    {#if expanded}
      {#if !hasThor}
        <p class="hint">Add a thor1 address to see its bonds.</p>
      {:else if !loadedOnce && loading}
        <p class="loader">▓░░░░ loading bonds</p>
      {:else if rows.length === 0}
        <p class="hint">None of the tracked THOR addresses are bonded to a current node.</p>
      {:else}
        {#if !gates.bondYieldEnabled}
          <p class="hint">Bond yield: {gates.bondYieldReason || 'checking network activation…'}</p>
        {/if}
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>provider</th>
                <th>node</th>
                <th>status</th>
                <th class="right">bond ᚱ</th>
                <th class="right">value</th>
                <th class="right">share</th>
                <th class="right">fee</th>
                <th class="right">pending ᚱ</th>
                <th class="right">apy</th>
                <th class="right">yield payout</th>
                <th class="right">manage</th>
              </tr>
            </thead>
            <tbody>
              {#each rows as row (row.key)}
                <tr>
                  <td title={row.address}>{labels[row.address] || shortAddr(row.address)}{#if row.isOperator}<span class="tag">op</span>{/if}</td>
                  <td><a href={nodeUrl(row.nodeAddress)} target="_blank" rel="noopener noreferrer">{shortAddr(row.nodeAddress, 4, 4)}</a></td>
                  <td>
                    <span class="pill" class:ok={row.status === 'Active'} class:warn={row.status !== 'Active'}>{row.status.toLowerCase()}</span>
                    {#if churnFlag(row)}<span class="pill err">{churnFlag(row)}</span>{/if}
                  </td>
                  <td class="right accent">{fmtAmount(row.bond, 0)}</td>
                  <td class="right">{money(row.bondUsd)}</td>
                  <td class="right">{fmtPct(row.share * 100, 1)}</td>
                  <td class="right">{fmtPct(row.operatorFee * 100, 1)}</td>
                  <td class="right">{fmtAmount(row.pendingReward, 2)}</td>
                  <td class="right" title={row.isOperator ? 'Includes the operator fee earned on other providers\' bond' : ''}>{fmtApy(row.apy)}</td>
                  <td class="right" title={row.bondYield?.target || 'Native RUNE to the bond provider'}>
                    {#if row.bondYield?.bps == null}—
                    {:else if row.bondYield.bps === 0}off
                    {:else}{fmtPct(row.bondYield.bps / 100, 2)}{#if !gates.bondYieldEnabled}<span class="tag">paused</span>{/if}{/if}
                  </td>
                  <td class="right nowrap">
                    <div class="manage-buttons">
                      <button class="row-btn manage-btn bond-btn" aria-label="Bond more RUNE to node {shortAddr(row.nodeAddress, 4, 4)}" on:click={() => dispatch('action', { kind: 'bond', nodeAddress: row.nodeAddress, owner: row.address })}>+bond</button>
                      <button class="row-btn manage-btn" aria-label="Unbond RUNE from node {shortAddr(row.nodeAddress, 4, 4)}" on:click={() => dispatch('action', { kind: 'unbond', nodeAddress: row.nodeAddress, owner: row.address, max: row.bond, nodeStatus: row.status })}>−unbond</button>
                      <!-- Greyed out until bond yield is live (THORChain 3.21 and network activation). -->
                      <button class="row-btn manage-btn" disabled={!gates.bondYieldEnabled || !BOND_YIELD_STATUSES.has(row.status)} title={gates.bondYieldEnabled ? null : gates.bondYieldReason || 'Checking whether bond yield is live…'} aria-label="Manage bond yield payouts for node {shortAddr(row.nodeAddress, 4, 4)}" on:click={() => dispatch('action', { kind: 'bond-yield', nodeAddress: row.nodeAddress, owner: row.address, nodeStatus: row.status, bondYield: row.bondYield })}>payout</button>
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}
  </div>
</section>

<style>
  .block-head.collapsed { margin-bottom: 0; }
  .panel-toggle {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 0;
    background: transparent;
    border: 0;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    cursor: pointer;
  }
  .panel-toggle:hover { color: var(--pt-accent); }
  .toggle-state { color: var(--pt-accent); font-size: 11px; }
  .manage-buttons { display: inline-flex; align-items: center; gap: 6px; }
  .manage-buttons .manage-btn {
    min-height: 28px;
    padding: 5px 9px;
    margin: 0;
    background: color-mix(in srgb, var(--pt-muted) 10%, var(--pt-surface));
    border-color: color-mix(in srgb, var(--pt-muted) 45%, var(--pt-border));
    color: var(--pt-text);
    font-weight: 600;
    line-height: 1.2;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }
  .manage-buttons .bond-btn {
    background: color-mix(in srgb, var(--pt-accent) 10%, var(--pt-surface));
    border-color: color-mix(in srgb, var(--pt-accent) 65%, var(--pt-border));
    color: var(--pt-accent);
  }
  .manage-buttons .manage-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--pt-accent) 18%, var(--pt-surface));
    border-color: var(--pt-accent);
    color: var(--pt-text);
  }
  .manage-buttons .manage-btn:disabled {
    background: var(--pt-surface);
    border-color: var(--pt-border);
    color: var(--pt-dim);
    opacity: 0.5;
    cursor: not-allowed;
  }
  .manage-buttons .manage-btn:active:not(:disabled) { background: color-mix(in srgb, var(--pt-accent) 28%, var(--pt-surface)); }
  .manage-buttons .manage-btn:focus-visible { outline: 2px solid var(--pt-accent); outline-offset: 2px; }
</style>
