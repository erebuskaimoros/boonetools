<script>
  import { createEventDispatcher } from 'svelte';
  import {
    planAddLiquidityAsset,
    planAddLiquidityRune,
    planBond,
    planClaimTcy,
    planStakeTcy,
    planUnbond,
    planUnstakeTcy,
    planWithdrawLiquidity
  } from './memos.js';
  import { pickSigner } from './actions-signer.js';
  import { fmtAmount, poolTicker, shortAddr, txUrl } from './format.js';

  export let spec;
  export let accounts = [];
  export let market = { pools: [], prices: {} };
  export let gates = {};
  export let nodes = [];
  export let thorAddresses = [];

  const dispatch = createEventDispatcher();

  const TITLES = {
    bond: 'bond rune',
    unbond: 'unbond rune',
    'lp-add': 'add liquidity',
    'lp-withdraw': 'withdraw liquidity',
    'tcy-stake': 'stake tcy',
    'tcy-unstake': 'unstake tcy',
    'tcy-claim': 'claim tcy'
  };
  const ROUTE_NOTE = {
    'thor-deposit': 'THORChain MsgDeposit signed by your THOR wallet',
    inbound: 'L1 send to the current Asgard inbound vault (router for EVM chains)',
    'inbound-dust': 'minimum L1 send to the inbound vault carrying the memo'
  };
  // Shown while the form can't produce a transaction yet, so a disabled sign button has a reason.
  const NEXT_STEP = {
    bond: 'Enter a node address and an amount to review the transaction.',
    unbond: 'Enter an amount to review the transaction.',
    'lp-add': 'Choose a pool and enter the amounts to review the transactions.',
    'tcy-stake': 'Enter an amount to review the transaction.'
  };

  /** Focus the first field still waiting for input when the form opens. */
  function focusFirstField(node) {
    const fields = [...node.querySelectorAll('input:not([readonly]):not([disabled]), select:not([disabled])')];
    /** @type {HTMLInputElement | HTMLSelectElement | undefined} */
    const field = fields.find((item) => !item.value) || fields[0];
    field?.focus();
  }

  const kind = spec.kind;
  const row = spec.row || null;

  // ---------- form state ----------
  let nodeAddress = spec.nodeAddress || '';
  let amount = '';
  let assetAmount = '';
  let percent = kind === 'tcy-unstake' || kind === 'lp-withdraw' ? 100 : 50;
  let pool = spec.pool || '';
  let lpMode = row ? row.type : 'sym';
  let withdrawTarget = '';
  let claimDestination = thorAddresses[0] || '';
  let signerKeys = {};

  let phase = 'form'; // form | signing | done
  let results = [];
  let signError = '';

  $: poolInfo = (market.pools || []).find((item) => item.asset === pool) || null;
  $: assetChain = pool ? pool.split('.')[0] : '';
  $: depthRatio = poolInfo && Number(poolInfo.balance_rune) > 0 ? Number(poolInfo.balance_asset) / Number(poolInfo.balance_rune) : 0;

  function owners() {
    if (row) return { THOR: row.runeAddress, [assetChain]: row.assetAddress };
    if (kind === 'tcy-claim') return { [spec.claim.chain]: spec.claim.address };
    return { THOR: spec.owner || '' };
  }

  // ---------- plan building ----------
  let plans = [];
  let formError = '';
  $: {
    try {
      formError = '';
      plans = buildPlans(kind, { nodeAddress, amount, assetAmount, percent, pool, lpMode, withdrawTarget, claimDestination, signerKeys, accounts });
    } catch (error) {
      plans = [];
      formError = error.message;
    }
  }

  function signerFor(plan, keys, list) {
    const key = keys[plan.chain];
    const chosen = key ? list.find((account) => `${account.provider}:${account.address}` === key) : null;
    return chosen || pickSigner(list, plan, owners()[plan.chain]);
  }

  function buildPlans(currentKind, form) {
    switch (currentKind) {
      case 'bond':
        if (!form.amount) return [];
        return [planBond({ nodeAddress: form.nodeAddress, amount: form.amount })];
      case 'unbond':
        if (!form.amount) return [];
        return [planUnbond({ nodeAddress: form.nodeAddress, amount: form.amount })];
      case 'lp-add': {
        if (!form.pool) return [];
        const thorSigner = signerFor({ chain: 'THOR' }, form.signerKeys, form.accounts);
        const assetSigner = signerFor({ chain: form.pool.split('.')[0] }, form.signerKeys, form.accounts);
        const runePaired = row?.assetAddress || assetSigner?.address || '';
        const thorPaired = row?.runeAddress || thorSigner?.address || '';
        if (form.lpMode === 'rune') {
          return form.amount ? [planAddLiquidityRune({ pool: form.pool, amount: form.amount })] : [];
        }
        if (form.lpMode === 'asset') {
          return form.assetAmount ? [planAddLiquidityAsset({ pool: form.pool, amount: form.assetAmount })] : [];
        }
        if (!form.amount || !form.assetAmount) return [];
        if (!runePaired) throw new Error(`Connect a ${form.pool.split('.')[0]} account to pair the asset side`);
        if (!thorPaired) throw new Error('Connect a THOR account to pair the RUNE side');
        return [
          planAddLiquidityRune({ pool: form.pool, amount: form.amount, pairedAddress: runePaired }),
          planAddLiquidityAsset({ pool: form.pool, amount: form.assetAmount, pairedThorAddress: thorPaired })
        ];
      }
      case 'lp-withdraw':
        return [planWithdrawLiquidity({ pool: form.pool, percent: form.percent, side: row?.type === 'asset' ? 'asset' : 'rune', target: form.withdrawTarget })];
      case 'tcy-stake':
        return form.amount ? [planStakeTcy({ amount: form.amount })] : [];
      case 'tcy-unstake':
        return [planUnstakeTcy({ percent: form.percent })];
      case 'tcy-claim':
        if (!form.claimDestination) throw new Error('Track or connect a thor1 address to receive the TCY');
        return [planClaimTcy({ chain: spec.claim.chain, thorAddress: form.claimDestination })];
      default:
        return [];
    }
  }

  // ---------- review checks ----------
  $: reviews = plans.map((plan) => {
    const signer = signerFor(plan, signerKeys, accounts);
    const options = accounts.filter((account) => account.network === plan.chain);
    const owner = owners()[plan.chain];
    const warnings = [];
    let blocked = '';
    if (!signer) blocked = `Connect a wallet with a ${plan.chain} account to sign this.`;
    const mustOwn = ['unbond', 'lp-withdraw', 'tcy-unstake', 'tcy-claim'].includes(plan.action);
    if (signer && owner && signer.address.toLowerCase() !== owner.toLowerCase()) {
      if (mustOwn) blocked = `This position belongs to …${owner.slice(-4)}, but the connected ${plan.chain} account is …${signer.address.slice(-4)}.`;
      else warnings.push(`Signing from …${signer.address.slice(-4)}, not the tracked …${owner.slice(-4)}.`);
    }
    if (plan.action === 'bond' && signer) {
      const node = nodes.find((item) => item.node_address === plan.memo.split(':')[1]);
      const listed = node?.bond_providers?.providers?.some((provider) => provider.bond_address === signer.address);
      if (!node) warnings.push('This node is not in the current node list; double-check the address.');
      else if (!listed && node.node_operator_address !== signer.address) {
        warnings.push('This address is not a whitelisted bond provider on the node. THORChain will refund the bond unless the operator adds it first.');
      }
    }
    if (plan.action === 'unbond' && spec.nodeStatus === 'Active') {
      warnings.push('The node is Active. THORChain only releases bond from Standby nodes, so this will likely be refunded until the node churns out.');
    }
    if (gates.globalHalt) blocked = 'THORChain is halted by mimir right now.';
    if (plan.action.startsWith('lp-') && gates.lpPaused) blocked = 'Liquidity actions are paused by mimir.';
    if (plan.route !== 'thor-deposit') warnings.push('Your wallet will add the network fee for this chain.');
    return { plan, signer, options, warnings, blocked };
  });
  $: canSign = phase === 'form' && reviews.length > 0 && reviews.every((review) => !review.blocked);

  function selectSigner(chain, value) {
    signerKeys = { ...signerKeys, [chain]: value };
  }

  function matchRatio() {
    if (!depthRatio) return;
    const rune = Number(amount);
    if (rune > 0) assetAmount = String(Number((rune * depthRatio).toFixed(8)));
  }

  function setMax() {
    if (spec.max) amount = String(Number(Number(spec.max).toFixed(8)));
  }

  async function sign() {
    phase = 'signing';
    signError = '';
    results = reviews.map((review) => ({ title: review.plan.title, status: 'queued', hash: '', note: '' }));
    let actions;
    try {
      actions = await import('./actions.js');
    } catch (error) {
      signError = `Wallet support failed to load: ${error.message}`;
      phase = 'form';
      return;
    }
    for (let index = 0; index < reviews.length; index += 1) {
      const { plan, signer } = reviews[index];
      results[index] = { ...results[index], status: 'signing', note: 'Preparing transaction…' };
      try {
        const hash = await actions.executePlan(plan, signer, {
          onStatus: (note) => { results[index] = { ...results[index], note }; }
        });
        results[index] = { ...results[index], status: 'sent', hash: String(hash || ''), note: '' };
      } catch (error) {
        results[index] = { ...results[index], status: 'failed', note: error?.message || String(error) };
        signError = 'Stopped. Nothing after the failed step was sent.';
        phase = 'done';
        dispatch('submitted');
        return;
      }
    }
    phase = 'done';
    dispatch('submitted');
  }

  function close() {
    if (phase === 'signing') return;
    dispatch('close');
  }

  function onKeydown(event) {
    if (event.key === 'Escape') close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="ptrack-modal-backdrop" on:click|self={close}>
  <div class="ptrack-modal wide" role="dialog" aria-modal="true" aria-label={TITLES[kind]}>
    <div class="modal-head">
      <span><span class="prompt">$</span> {TITLES[kind]}{pool ? ` --pool ${poolTicker(pool)}` : ''}</span>
      <button class="chip-x" aria-label="Close" on:click={close} disabled={phase === 'signing'}>×</button>
    </div>

    {#if phase === 'form'}
      <div class="modal-section form-grid" use:focusFirstField>
        {#if kind === 'bond' || kind === 'unbond'}
          <label class="field">
            <span class="modal-label">node address</span>
            <input class="field-input" bind:value={nodeAddress} placeholder="thor1… node address" spellcheck="false" readonly={kind === 'unbond'} />
          </label>
          <label class="field">
            <span class="modal-label">amount (rune){#if spec.max} · bonded {fmtAmount(spec.max, 2)}{/if}</span>
            <div class="field-row">
              <input class="field-input" bind:value={amount} inputmode="decimal" placeholder="0.0" />
              {#if spec.max}<button class="row-btn" type="button" on:click={setMax}>max</button>{/if}
            </div>
          </label>
        {/if}

        {#if kind === 'lp-add'}
          <label class="field">
            <span class="modal-label">pool</span>
            <select class="field-input" bind:value={pool} disabled={!!row}>
              <option value="">select a pool</option>
              {#each market.pools as item (item.asset)}
                <option value={item.asset}>{poolTicker(item.asset)} · {item.asset}</option>
              {/each}
            </select>
          </label>
          <div class="field">
            <span class="modal-label">deposit type{row ? ' (matches the existing position)' : ''}</span>
            <div class="seg">
              {#each [['sym', 'symmetric'], ['rune', 'rune only'], ['asset', 'asset only']] as [value, label]}
                <button type="button" class="seg-btn" class:active={lpMode === value} disabled={!!row && row.type !== value} on:click={() => (lpMode = value)}>{label}</button>
              {/each}
            </div>
          </div>
          {#if lpMode !== 'asset'}
            <label class="field">
              <span class="modal-label">rune amount</span>
              <input class="field-input" bind:value={amount} inputmode="decimal" placeholder="0.0" on:input={() => lpMode === 'sym' && matchRatio()} />
            </label>
          {/if}
          {#if lpMode !== 'rune'}
            <label class="field">
              <span class="modal-label">{pool ? poolTicker(pool) : 'asset'} amount{#if lpMode === 'sym' && depthRatio} · pool ratio filled in{/if}</span>
              <input class="field-input" bind:value={assetAmount} inputmode="decimal" placeholder="0.0" />
            </label>
          {/if}
          {#if lpMode === 'sym'}
            <p class="hint">Symmetric adds send two transactions: RUNE from your THOR wallet, then the asset from its chain. THORChain holds the first side as pending until the second arrives.</p>
          {/if}
        {/if}

        {#if kind === 'lp-withdraw'}
          <div class="field">
            <span class="modal-label">withdraw {percent}% of {poolTicker(pool)}</span>
            <input class="range" type="range" min="1" max="100" step="1" bind:value={percent} />
            <div class="seg">
              {#each [25, 50, 75, 100] as value}
                <button type="button" class="seg-btn" class:active={Number(percent) === value} on:click={() => (percent = value)}>{value}%</button>
              {/each}
            </div>
            {#if row}
              <p class="hint">≈ {fmtAmount(row.runeRedeem * percent / 100, 2)} RUNE + {fmtAmount(row.assetRedeem * percent / 100, 6)} {poolTicker(pool)} at current depth, before outbound fees.</p>
            {/if}
          </div>
          {#if row?.type === 'sym'}
            <div class="field">
              <span class="modal-label">receive as</span>
              <div class="seg">
                {#each [['', 'both sides'], ['rune', 'all rune'], ['asset', `all ${poolTicker(pool)}`]] as [value, label]}
                  <button type="button" class="seg-btn" class:active={withdrawTarget === value} on:click={() => (withdrawTarget = value)}>{label}</button>
                {/each}
              </div>
            </div>
          {/if}
        {/if}

        {#if kind === 'tcy-stake'}
          <label class="field">
            <span class="modal-label">amount (tcy){#if spec.max} · in wallet {fmtAmount(spec.max, 2)}{/if}</span>
            <div class="field-row">
              <input class="field-input" bind:value={amount} inputmode="decimal" placeholder="0.0" />
              {#if spec.max}<button class="row-btn" type="button" on:click={setMax}>max</button>{/if}
            </div>
          </label>
        {/if}

        {#if kind === 'tcy-unstake'}
          <div class="field">
            <span class="modal-label">unstake {percent}% · ≈ {fmtAmount((spec.max || 0) * percent / 100, 2)} TCY</span>
            <input class="range" type="range" min="1" max="100" step="1" bind:value={percent} />
          </div>
        {/if}

        {#if kind === 'tcy-claim'}
          <p class="hint">Claiming {fmtAmount(spec.claim.amount, 2)} TCY owed to {shortAddr(spec.claim.address)} ({spec.claim.asset}).</p>
          <label class="field">
            <span class="modal-label">send tcy to</span>
            <select class="field-input" bind:value={claimDestination}>
              {#each thorAddresses as address}
                <option value={address}>{shortAddr(address, 10, 6)}</option>
              {/each}
            </select>
          </label>
        {/if}
      </div>

      {#if formError}<p class="hint err-text pad">{formError}</p>
      {:else if !reviews.length && NEXT_STEP[kind]}<p class="hint pad">{NEXT_STEP[kind]}</p>{/if}

      {#if reviews.length}
        <div class="modal-section">
          <h3 class="modal-label">review</h3>
          {#each reviews as review, index (index)}
            <div class="review">
              <div class="review-title">{reviews.length > 1 ? `${index + 1}/${reviews.length} · ` : ''}{review.plan.title}</div>
              <dl class="review-grid">
                <dt>signer</dt>
                <dd>
                  {#if review.options.length > 1}
                    <select class="field-input slim" value={review.signer ? `${review.signer.provider}:${review.signer.address}` : ''} on:change={(event) => selectSigner(review.plan.chain, event.currentTarget.value)}>
                      {#each review.options as option}
                        <option value={`${option.provider}:${option.address}`}>{option.provider.toLowerCase()} · {shortAddr(option.address, 10, 6)}</option>
                      {/each}
                    </select>
                  {:else if review.signer}
                    {review.signer.provider.toLowerCase()} · <span title={review.signer.address}>{shortAddr(review.signer.address, 10, 6)}</span>
                  {:else}
                    <span class="err-text">no {review.plan.chain} account connected</span>
                  {/if}
                </dd>
                <dt>sends</dt>
                <dd>{review.plan.route === 'inbound-dust' ? 'dust amount' : `${review.plan.amount} ${review.plan.asset}`}</dd>
                <dt>memo</dt>
                <dd><code class="inline-code">{review.plan.memo}</code></dd>
                <dt>route</dt>
                <dd>{ROUTE_NOTE[review.plan.route]}</dd>
              </dl>
              {#each review.warnings as warning}<p class="hint warn-text">⚠ {warning}</p>{/each}
              {#if review.blocked}<p class="hint err-text">✕ {review.blocked}</p>{/if}
            </div>
          {/each}
        </div>
      {/if}

      <div class="modal-actions">
        {#if !accounts.length || reviews.some((review) => !review.signer)}
          <button class="bracket-btn" on:click={() => dispatch('connect')}>
            <span class="bracket">[</span><span class="key">W</span><span class="bracket">]</span> connect wallet
          </button>
        {/if}
        <button class="bracket-btn primary" disabled={!canSign} on:click={sign}>
          <span class="bracket">[</span><span class="key">S</span><span class="bracket">]</span>
          sign {reviews.length > 1 ? `${reviews.length} transactions` : 'in wallet'}
        </button>
      </div>
    {:else}
      <div class="modal-section">
        {#each results as result, index (index)}
          <div class="review">
            <div class="review-title">
              <span class="pill" class:ok={result.status === 'sent'} class:warn={result.status === 'signing' || result.status === 'queued'} class:err={result.status === 'failed'}>{result.status}</span>
              {result.title}
            </div>
            {#if result.note}<p class="hint" class:err-text={result.status === 'failed'}>{result.note}</p>{/if}
            {#if result.hash}
              <p class="hint">tx <a href={txUrl(result.hash)} target="_blank" rel="noopener noreferrer">{shortAddr(result.hash, 10, 8)}</a> · positions refresh shortly after THORChain observes it</p>
            {/if}
          </div>
        {/each}
        {#if signError}<p class="hint err-text">{signError}</p>{/if}
      </div>
      <div class="modal-actions">
        <button class="bracket-btn" disabled={phase === 'signing'} on:click={close}>
          <span class="bracket">[</span><span class="key">esc</span><span class="bracket">]</span> close
        </button>
      </div>
    {/if}
  </div>
</div>
