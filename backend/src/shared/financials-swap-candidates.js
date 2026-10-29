import { midgardActionTimestampSeconds } from '../../../shared/dynamic-fees/affiliate-volume.js';

export const FINANCIAL_SWAP_CANDIDATE_RANK = 25;
const VERIFY_BACKOFF_MS = [10 * 60_000, 30 * 60_000, 3600_000, 6 * 3600_000, 24 * 3600_000];
const RUNE = 'THOR.RUNE';
const positive = value => value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
const integer = value => /^\d+$/.test(String(value ?? ''));

// Finalized events may carry legacy base64 attribute keys and values.
export function decodedEventText(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9+/]+=*$/.test(text) && text.length > 1) {
    const candidate = Buffer.from(text, 'base64').toString('utf8');
    if (candidate && /^[\x20-\x7e]+$/.test(candidate)) return candidate;
  }
  return text;
}

function coin(value) {
  const match = /^(\d{1,39}) (\S+)$/.exec(String(value ?? '').trim());
  return match ? { amount: BigInt(match[1]), asset: match[2].toUpperCase() } : null;
}

/** Swap records in one finalized block, valued at that block's RUNE rate for
 * the input asset. A stream is recorded at its first sub-swap (that leg times
 * quantity) and at its completion (the actual deposit); sub-swaps in between
 * are ignored. Malformed events are skipped, never thrown. */
export function parseFinancialSwapCandidates(events) {
  const txs = new Map(), rates = new Map([[RUNE, [1n, 1n]]]);
  const tx = txId => txs.get(txId) || txs.set(txId, { legs: [] }).get(txId);
  for (const event of Array.isArray(events) ? events : []) {
    const type = decodedEventText(event?.type).toLowerCase();
    if (type !== 'swap' && type !== 'streaming_swap') continue;
    const values = new Map((Array.isArray(event.attributes) ? event.attributes : [])
      .map(item => [decodedEventText(item?.key), decodedEventText(item?.value)]));
    if (type === 'streaming_swap') {
      const txId = values.get('tx_id')?.trim().toUpperCase(), deposit = coin(values.get('deposit'));
      if (txId && deposit) tx(txId).completion = { deposit, outputAsset: coin(values.get('out'))?.asset || '' };
      continue;
    }
    const txId = values.get('id')?.trim().toUpperCase(), input = coin(values.get('coin'));
    const emit = coin(values.get('emit_asset')), fee = values.get('liquidity_fee_in_rune');
    // Every X -> RUNE leg in the block, from any transaction, prices asset X.
    if (input && input.asset !== RUNE && emit?.asset === RUNE && integer(fee)) {
      const [num, den] = rates.get(input.asset) || [0n, 0n];
      rates.set(input.asset, [num + emit.amount + BigInt(fee), den + input.amount]);
    }
    if (txId && input) tx(txId).legs.push({ input, emit, quantity: values.get('streaming_swap_quantity')?.trim() || '0',
      count: values.get('streaming_swap_count')?.trim() });
  }
  const candidates = [];
  for (const [txId, { legs, completion }] of txs) {
    const start = legs.find(leg => leg.count === '1');
    const quantity = /^\d{1,9}$/.test(legs[0]?.quantity) ? Number(legs[0].quantity) : null;
    const outputAsset = legs.at(-1)?.emit?.asset || '';
    let record;
    if (completion) {
      record = { inputAsset: completion.deposit.asset, inputE8: completion.deposit.amount,
        outputAsset: completion.outputAsset, streaming: true, started: Boolean(start), complete: true };
    } else if (quantity !== null && quantity <= 1) {
      const inputAsset = legs[0].input.asset;
      record = { inputAsset, inputE8: legs.filter(leg => leg.input.asset === inputAsset).reduce((sum, leg) => sum + leg.input.amount, 0n),
        outputAsset, streaming: false, started: true, complete: true };
    } else if (quantity !== null && start) {
      record = { inputAsset: start.input.asset, inputE8: start.input.amount * BigInt(quantity),
        outputAsset, streaming: true, started: true, complete: false };
    } else continue;
    const [num, den] = rates.get(record.inputAsset) || [0n, 0n];
    if (!den) continue;
    candidates.push({ txId, ...record, inputE8: String(record.inputE8), runeValueE8: String(record.inputE8 * num / den) });
  }
  return candidates;
}

/** A successful Midgard swap action as a ranked day row, or why it cannot rank. */
export function financialSwapRow(action) {
  const seconds = midgardActionTimestampSeconds(action.date);
  const txId = action.in?.find(leg => leg.txID)?.txID;
  const exclude = kind => ({ exclusion: { txId: txId ? String(txId).toUpperCase() : null, kind } });
  if (action.status !== 'success') return exclude('pending');
  const inputs = (action.in || []).flatMap(leg => leg.coins || []);
  const asset = inputs[0]?.asset;
  const price = action.metadata?.swap?.inPriceUSD;
  // One source asset per route. Never turn an unpriced swap into a zero.
  if (!txId || !inputs.length || !positive(price) || inputs.some(coin => coin.asset !== asset || !integer(coin.amount))) {
    return exclude('unpriced');
  }
  const inputAmount = Number(inputs.reduce((sum, coin) => sum + BigInt(coin.amount), 0n)) / 1e8;
  const volumeUsd = inputAmount * Number(price);
  if (!Number.isFinite(volumeUsd)) return exclude('unpriced');
  const outputs = (action.out || []).filter(leg => !leg.affiliate).flatMap(leg => leg.coins || []);
  const fee = action.metadata?.swap?.liquidityFee;
  return { row: { txId: String(txId).toUpperCase(), timestamp: new Date(seconds * 1000).toISOString(),
    inputAsset: asset, inputAmount, outputAsset: outputs[0]?.asset || action.metadata?.swap?.streamingSwapMeta?.outCoin?.asset || '',
    volumeUsd, feeRune: integer(fee) ? Number(BigInt(fee)) / 1e8 : null, streaming: Boolean(action.metadata?.swap?.isStreamingSwap) } };
}

/** A txid search can include related actions. Only a successful action with
 * this exact inbound ID settles it; a refund counts only without a swap. */
export function financialSwapSettlement(actions, txId) {
  const related = actions.filter(action =>
    ['swap', 'refund'].includes(action?.type)
    && Array.isArray(action.in) && String(action.in.find(leg => leg?.txID)?.txID || '').trim().toUpperCase() === txId);
  const matches = related.filter(action => action.status === 'success');
  const action = matches.find(candidate => {
    const seconds = midgardActionTimestampSeconds(candidate.date);
    return candidate.type === 'swap' && seconds > 0 && Number.isFinite(seconds)
      && Number.isFinite(new Date(seconds * 1000).getTime());
  }) || (!related.some(candidate => candidate.type === 'swap')
    && matches.find(candidate => candidate.type === 'refund'));
  return { related, action: action || null };
}

/** Each day's top completed candidates are verified once by transaction ID;
 * Midgard supplies the exact USD row and action day. Unfinished streams cost
 * no request. A budget deferral or provider skip ends the pass; other errors
 * retry only that row. */
export async function verifyFinancialSwapCandidates(client, { getJson, now = Date.now, maxRequests = 5, signal } = {}) {
  if (signal?.aborted) return 0;
  const { rows } = await client.query(`select tx_id, status, checks from (
      select tx_id, day, status, checks, next_check_at, complete, completed_at,
        row_number() over (partition by day order by rune_value_e8 desc, tx_id) as rank
      from financials_swap_candidates where status <> 'excluded'
        -- Recent days only: lower-ranked rows stay observed forever.
        and day >= ($1::timestamptz at time zone 'UTC')::date - 3
    ) ranked where status in ('observed', 'pending') and rank <= ${FINANCIAL_SWAP_CANDIDATE_RANK}
      and complete and completed_at <= $1::timestamptz - interval '2 minutes'
      and coalesce(next_check_at, '-infinity') <= $1::timestamptz
    order by day desc, rank limit $2`, [new Date(now()).toISOString(), Math.max(1, Math.trunc(maxRequests) || 1)]);
  let checked = 0;
  for (const row of rows) {
    if (signal?.aborted) break;
    let actions;
    try {
      actions = (await getJson(`/actions?${new URLSearchParams({ txid: row.tx_id, limit: '50' })}`))?.actions;
      if (!Array.isArray(actions)) throw new Error('Invalid swap candidate lookup');
    } catch (error) {
      if (signal?.aborted || error.code === 'MIDGARD_BUDGET_DEFERRED' || error.skipProvider) break;
      await client.query(`update financials_swap_candidates set last_error = $2, next_check_at = $3::timestamptz
        where tx_id = $1`, [row.tx_id, error.message, new Date(now() + 60_000).toISOString()]);
      continue;
    }
    const at = now();
    const { related, action } = financialSwapSettlement(actions, row.tx_id);
    const ranked = action?.type === 'swap' ? financialSwapRow(action).row : null;
    await client.query(`update financials_swap_candidates set status = $2, verified_row = $3::jsonb,
        day = coalesce($4::date, day), checks = checks + 1, next_check_at = $5::timestamptz, last_error = $6,
        updated_at = $7::timestamptz where tx_id = $1`,
    [row.tx_id, ranked ? 'verified' : action ? 'excluded' : related.length ? 'pending' : row.status,
      ranked ? JSON.stringify(ranked) : null, ranked?.timestamp.slice(0, 10) ?? null,
      action ? null : new Date(at + VERIFY_BACKOFF_MS[Math.min(row.checks, VERIFY_BACKOFF_MS.length - 1)]).toISOString(),
      ranked || !action ? '' : action.type === 'swap' ? 'unpriced' : 'refunded', new Date(at).toISOString()]);
    checked++;
  }
  return checked;
}

/** Day rows stored before ranked rows carried feeRune get one lookup each by
 * transaction ID; a null fee records the check. Stored payloads are never
 * edited. Errors stop or skip exactly as in verification. */
export async function fillFinancialSwapFees(client, { getJson, now = Date.now, maxRequests = 5, signal } = {}) {
  if (signal?.aborted) return 0;
  const { rows } = await client.query(`select swap->>'txId' as tx_id from financials_day_details,
      jsonb_array_elements(case when jsonb_typeof(payload_json->'swaps') = 'array' then payload_json->'swaps' else '[]'::jsonb end) swap
    where jsonb_typeof(swap->'txId') = 'string' and not (swap ? 'feeRune')
      and not exists (select 1 from financials_swap_fees fee where fee.tx_id = swap->>'txId')
    group by 1 order by max(day) desc, 1 limit $1`, [Math.max(1, Math.trunc(maxRequests) || 1)]);
  let filled = 0;
  for (const { tx_id: txId } of rows) {
    if (signal?.aborted) break;
    let actions;
    try {
      actions = (await getJson(`/actions?${new URLSearchParams({ txid: txId, limit: '50' })}`))?.actions;
      if (!Array.isArray(actions)) throw new Error('Invalid swap fee lookup');
    } catch (error) {
      if (signal?.aborted || error.code === 'MIDGARD_BUDGET_DEFERRED' || error.skipProvider) break;
      continue;
    }
    const { action } = financialSwapSettlement(actions, txId);
    const fee = action?.type === 'swap' ? action.metadata?.swap?.liquidityFee : null;
    await client.query(`insert into financials_swap_fees (tx_id, fee_rune_e8, checked_at) values ($1, $2::numeric, $3::timestamptz)
      on conflict (tx_id) do nothing`, [txId, integer(fee) ? String(fee) : null, new Date(now()).toISOString()]);
    filled++;
  }
  return filled;
}

export async function readFinancialSwapLedgerStart(client) {
  const { rows = [] } = await client.query('select started_at from financials_swap_ledger');
  const started = rows[0]?.started_at ? new Date(rows[0].started_at).getTime() : NaN;
  return Number.isFinite(started) ? started : null;
}

/** Every block from a covered UTC day's midnight passed through the ledger. */
export const financialSwapLedgerCovers = (startedAt, day) =>
  startedAt !== null && Date.parse(`${day}T00:00:00Z`) >= startedAt;

/** Verified rows, unverified top-ranked IDs and unpriced exclusions for one day. */
export async function readFinancialSwapLedgerDay(client, day, now = Date.now()) {
  const { rows } = await client.query(`select tx_id, status, verified_row, last_error, checks, updated_at,
      coalesce(next_check_at, completed_at + interval '2 minutes') as due_at,
      row_number() over (partition by status = 'excluded' order by rune_value_e8 desc, tx_id) as rank
    from financials_swap_candidates where day = $1::date order by rune_value_e8 desc, tx_id`, [day]);
  const pending = rows.filter(row => ['observed', 'pending'].includes(row.status) && Number(row.rank) <= FINANCIAL_SWAP_CANDIDATE_RANK);
  const checked = rows.filter(row => row.status !== 'observed' || row.checks > 0).map(row => new Date(row.updated_at).getTime());
  // Unfinished streams have no scheduled check until their completion arrives.
  const due = pending.filter(row => row.due_at).map(row => new Date(row.due_at).getTime());
  return { swaps: rows.filter(row => row.status === 'verified' && row.verified_row).map(row => row.verified_row),
    pending: pending.map(row => row.tx_id),
    unpriced: rows.filter(row => row.status === 'excluded' && row.last_error === 'unpriced').map(row => row.tx_id),
    checkedAt: checked.length ? new Date(Math.max(...checked)).toISOString() : null,
    nextCheckAt: due.length ? new Date(Math.max(now, Math.min(...due))).toISOString() : null };
}
