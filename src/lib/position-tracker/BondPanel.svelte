<script>
  import { createEventDispatcher } from 'svelte';
  import { fmtAmount, fmtPct, nodeUrl, shortAddr } from './format.js';

  export let rows = [];
  export let labels = {};
  export let money = (value) => String(value);
  export let loading = false;
  export let loadedOnce = false;
  export let hasThor = false;
  export let nextChurnIn = '';
  export let churnHalted = false;

  const dispatch = createEventDispatcher();

  const LEAVE_LABEL = { leaving: 'leaving', oldest: 'oldest', worst: 'slash pts', lowest: 'low bond' };

  function fmtApy(apy) {
    if (!apy) return '--';
    return apy > 9.99 ? '>999%' : fmtPct(apy * 100, 1);
  }

  function churnFlag(row) {
    if (row.forcedToLeave) return 'forced out';
    if (row.leave?.type) return LEAVE_LABEL[row.leave.type] || row.leave.type;
    return '';
  }
</script>

<section class="block">
  <div class="block-head">
    <div class="block-title"><span class="title-marker">▌</span><h2>node bonds</h2></div>
    <div class="block-actions">
      <span class="block-meta">
        {#if churnHalted}[churning halted]{:else if nextChurnIn}[next churn {nextChurnIn}]{/if}
      </span>
      <button class="bracket-btn" disabled={!hasThor} on:click={() => dispatch('action', { kind: 'bond' })}>
        <span class="bracket">[</span><span class="key">+</span><span class="bracket">]</span> bond to node
      </button>
    </div>
  </div>

  {#if !hasThor}
    <p class="hint">Add a thor1 address to see its bonds.</p>
  {:else if !loadedOnce && loading}
    <p class="loader">▓░░░░ loading bonds</p>
  {:else if rows.length === 0}
    <p class="hint">None of the tracked THOR addresses are bonded to a current node.</p>
  {:else}
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
              <td class="right">{fmtPct(row.operatorFee * 100, 0)}</td>
              <td class="right">{fmtAmount(row.pendingReward, 2)}</td>
              <td class="right" title={row.isOperator ? 'Includes the operator fee earned on other providers\' bond' : ''}>{fmtApy(row.apy)}</td>
              <td class="right nowrap">
                <button class="row-btn" aria-label="Bond more RUNE to node {shortAddr(row.nodeAddress, 4, 4)}" on:click={() => dispatch('action', { kind: 'bond', nodeAddress: row.nodeAddress, owner: row.address })}>+bond</button>
                <button class="row-btn" aria-label="Unbond RUNE from node {shortAddr(row.nodeAddress, 4, 4)}" on:click={() => dispatch('action', { kind: 'unbond', nodeAddress: row.nodeAddress, owner: row.address, max: row.bond, nodeStatus: row.status })}>−unbond</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
