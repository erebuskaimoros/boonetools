import { priceFinancialSwapRows, priceFinancialSwapRowsAtPrices } from './financials-swap-pricing.js';
export { priceFinancialSwapRows, priceFinancialSwapRowsAtPrices } from './financials-swap-pricing.js';
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
 * quantity) and at its completion (the actual deposit). Every intermediate
 * block contributes fees; input notional never gates fee eligibility. */
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
      count: values.get('streaming_swap_count')?.trim(), fee: integer(fee) ? BigInt(fee) : null });
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
    } else if (quantity !== null && legs.length) {
      const first = start || legs[0];
      record = { inputAsset: first.input.asset, inputE8: first.input.amount * BigInt(quantity),
        outputAsset, streaming: true, started: Boolean(start), complete: false };
    } else continue;
    const [num, den] = rates.get(record.inputAsset) || [0n, 0n];
    const feeRuneE8 = legs.some(leg => leg.fee === null) ? null : String(legs.reduce((sum, leg) => sum + leg.fee, 0n));
    candidates.push({ txId, ...record, inputE8: String(record.inputE8),
      runeValueE8: den ? String(record.inputE8 * num / den) : '0', feeRuneE8 });
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
  if (!txId || !inputs.length || inputs.some(coin => coin.asset !== asset || !integer(coin.amount))) {
    return exclude('unpriced');
  }
  const inputAmount = Number(inputs.reduce((sum, coin) => sum + BigInt(coin.amount), 0n)) / 1e8;
  if (!Number.isFinite(inputAmount)) return exclude('unpriced');
  const volumeUsd = positive(price) && Number.isFinite(inputAmount * Number(price)) ? inputAmount * Number(price) : null;
  const outputs = (action.out || []).filter(leg => !leg.affiliate).flatMap(leg => leg.coins || []);
  const fee = action.metadata?.swap?.liquidityFee;
  const runePriceUsd = asset === RUNE && positive(price) ? Number(price)
    : outputs[0]?.asset === RUNE && positive(action.metadata?.swap?.outPriceUSD) ? Number(action.metadata.swap.outPriceUSD) : null;
  const row = { txId: String(txId).toUpperCase(), timestamp: new Date(seconds * 1000).toISOString(),
    inputAsset: asset, inputAmount, outputAsset: outputs[0]?.asset || action.metadata?.swap?.streamingSwapMeta?.outCoin?.asset || '',
    volumeUsd, feeRune: integer(fee) ? Number(BigInt(fee)) / 1e8 : null, runePriceUsd, streaming: Boolean(action.metadata?.swap?.isStreamingSwap) };
  return { row: priceFinancialSwapRowsAtPrices([row])[0] };
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

/** Price all retained candidates before choosing a bounded verification batch.
 * Local windows are independent rankings: filtering the UTC top 25 would lose
 * a small high-fee swap when another part of that UTC day is busier. */
export async function verifyFinancialSwapCandidates(client, { getJson, now = Date.now, maxRequests = 5, signal } = {}) {
  if (signal?.aborted) return 0;
  const atStart = now();
  const { rows: candidates } = await client.query(`with windows as (
      select start_at as window_from, start_at + interval '24 hours' as window_to
      from generate_series(date_trunc('day', $1::timestamptz at time zone 'UTC') at time zone 'UTC' - interval '3 days',
        date_trunc('day', $1::timestamptz at time zone 'UTC') at time zone 'UTC', interval '24 hours') start_at
      union
      select coalesce(window_start, day::timestamp at time zone time_zone),
        coalesce(window_end, (day + 1)::timestamp at time zone time_zone)
      from financials_day_rankings where (background and coalesce(window_end,
        (day + 1)::timestamp at time zone time_zone) >= $1::timestamptz - interval '3 days')
        or requested_at > $1::timestamptz - interval '2 minutes'
      union
      select remembered.window_from, remembered.window_to from financials_swap_verification_windows remembered
      join financials_swap_candidates waiting on waiting.tx_id = remembered.tx_id
      where waiting.status in ('observed','pending') and waiting.complete
        and coalesce(waiting.next_check_at, waiting.completed_at + interval '2 minutes') <= $1::timestamptz
    ) select candidate.tx_id, candidate.status, candidate.checks, candidate.next_check_at, candidate.complete,
      candidate.completed_at, candidate.first_seen_at, candidate.fee_rune_e8::text, candidate.verified_row,
      windows.window_from, windows.window_to
    from windows join financials_swap_candidates candidate on candidate.started
      and candidate.first_seen_at >= windows.window_from and candidate.first_seen_at < windows.window_to
    where candidate.status <> 'excluded'
      and windows.window_from >= (select fee_started_at from financials_swap_ledger)`, [new Date(atStart).toISOString()]);
  if (!candidates.length) return 0;
  const from = candidates.reduce((earliest, row) => Math.min(earliest, new Date(row.window_from).getTime()), Infinity) / 1000;
  const to = candidates.reduce((latest, row) => Math.max(latest, new Date(row.window_to).getTime()), -Infinity) / 1000;
  const unique = [...new Map(candidates.map(row => [row.tx_id, candidatePricingRow(row)])).values()];
  const priced = new Map((await priceFinancialSwapRows(client, unique, { from, to })).map(row => [row.txId, row]));
  const windows = new Map();
  for (const row of candidates) {
    const key = `${new Date(row.window_from).toISOString()}/${new Date(row.window_to).toISOString()}`;
    if (!windows.has(key)) windows.set(key, []);
    windows.get(key).push({ ...row, feeUsd: priced.get(row.tx_id)?.feeUsd ?? null });
  }
  const due = new Map(), remembered = [];
  for (const rows of windows.values()) {
    rows.sort(candidateOrder);
    // Missing source prices remain disclosed. Check their highest native-fee
    // candidates too: a native RUNE action can supply its exact USD price.
    const eligible = [...rows.filter(row => row.feeUsd !== null).slice(0, FINANCIAL_SWAP_CANDIDATE_RANK),
      ...rows.filter(row => row.feeUsd === null).slice(0, FINANCIAL_SWAP_CANDIDATE_RANK)];
    remembered.push({ from: new Date(rows[0].window_from).toISOString(), to: new Date(rows[0].window_to).toISOString(),
      ids: [...new Set([...eligible, ...rows.filter(row => !row.complete)]
        .filter(row => ['observed', 'pending'].includes(row.status)).map(row => row.tx_id))] });
    for (const row of eligible) {
      if (!['observed', 'pending'].includes(row.status) || !row.complete
        || new Date(row.completed_at).getTime() > atStart - 120_000
        || row.next_check_at && new Date(row.next_check_at).getTime() > atStart) continue;
      due.set(row.tx_id, row);
    }
  }
  // Checkpoint eligibility before any provider call, including budget deferral.
  await client.query(`with windows as (select * from jsonb_to_recordset($1::jsonb)
      as incoming("from" timestamptz, "to" timestamptz, ids jsonb)), inserted as (
      insert into financials_swap_verification_windows(window_from,window_to,tx_id)
      select windows."from", windows."to", id from windows cross join lateral jsonb_array_elements_text(windows.ids) id
      on conflict do nothing
    ) delete from financials_swap_verification_windows saved using windows
      where saved.window_from = windows."from" and saved.window_to = windows."to" and not (windows.ids ? saved.tx_id)`,
    [JSON.stringify(remembered)]);
  const rows = [...due.values()].sort(candidateOrder).slice(0, Math.max(1, Math.min(25, Math.trunc(maxRequests) || 1)));
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
    const valid = ranked && ranked.feeRune !== null;
    // The first finalized sub-swap owns the day even if Midgard's action date
    // changes later. SQL uses the latest stored start if repair races lookup.
    await client.query(`update financials_swap_candidates set status = $2,
        verified_row = case when $3::jsonb is null then null else jsonb_set($3::jsonb, '{timestamp}',
          to_jsonb(to_char(first_seen_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) end,
        checks = checks + 1, next_check_at = $4::timestamptz, last_error = $5,
        updated_at = $6::timestamptz where tx_id = $1`,
    [row.tx_id, valid ? 'verified' : action ? 'excluded' : related.length ? 'pending' : row.status,
      valid ? JSON.stringify(ranked) : null,
      action ? null : new Date(at + VERIFY_BACKOFF_MS[Math.min(row.checks, VERIFY_BACKOFF_MS.length - 1)]).toISOString(),
      valid || !action ? '' : action.type === 'swap' ? 'unpriced' : 'refunded', new Date(at).toISOString()]);
    if (action) await client.query('delete from financials_swap_verification_windows where tx_id = $1', [row.tx_id]);
    checked++;
  }
  return checked;
}

function candidatePricingRow(row) {
  return { ...(row.verified_row || {}), txId: row.tx_id,
    timestamp: new Date(row.first_seen_at).toISOString(),
    feeRune: typeof row.verified_row?.feeRune === 'number' ? row.verified_row.feeRune
      : row.fee_rune_e8 == null ? null : Number(row.fee_rune_e8) / 1e8 };
}

function candidateOrder(a, b) {
  return (b.feeUsd ?? -1) - (a.feeUsd ?? -1)
    || Number(b.fee_rune_e8 ?? 0) - Number(a.fee_rune_e8 ?? 0)
    || a.tx_id.localeCompare(b.tx_id);
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
  const { rows = [] } = await client.query('select fee_started_at as started_at from financials_swap_ledger');
  const started = rows[0]?.started_at ? new Date(rows[0].started_at).getTime() : NaN;
  return Number.isFinite(started) ? started : null;
}

/** Only windows starting after complete fee capture began can use the ledger. */
export const financialSwapLedgerCovers = (startedAt, dayOrBounds) =>
  startedAt !== null && (typeof dayOrBounds === 'string' ? Date.parse(`${dayOrBounds}T00:00:00Z`) : dayOrBounds.from * 1000) >= startedAt;

/** Select the whole exact start-time window, then price and rank it. */
export async function readFinancialSwapLedgerDay(client, dayOrBounds, now = Date.now()) {
  const from = typeof dayOrBounds === 'string' ? Date.parse(`${dayOrBounds}T00:00:00Z`) / 1000 : dayOrBounds.from;
  const to = typeof dayOrBounds === 'string' ? from + 86400 : dayOrBounds.to;
  const { rows } = await client.query(`select tx_id, status, verified_row, last_error, checks, updated_at,
      first_seen_at, complete, fee_rune_e8::text, coalesce(next_check_at, completed_at + interval '2 minutes') as due_at
    from financials_swap_candidates where started and first_seen_at >= $1::timestamptz
      and first_seen_at < $2::timestamptz`, [new Date(from * 1000).toISOString(), new Date(to * 1000).toISOString()]);
  const priced = new Map((await priceFinancialSwapRows(client, rows.map(candidatePricingRow), { from, to }))
    .map(row => [row.txId, row]));
  const ranked = rows.filter(row => row.status !== 'excluded').map(row => ({ ...row, feeUsd: priced.get(row.tx_id).feeUsd }))
    .sort(candidateOrder);
  const leaders = [...ranked.filter(row => row.feeUsd !== null).slice(0, FINANCIAL_SWAP_CANDIDATE_RANK),
    ...ranked.filter(row => row.feeUsd === null).slice(0, FINANCIAL_SWAP_CANDIDATE_RANK)];
  const pending = [...new Map([...leaders, ...ranked.filter(row => !row.complete)]
    .filter(row => ['observed', 'pending'].includes(row.status)).map(row => [row.tx_id, row])).values()];
  const checked = rows.filter(row => row.status !== 'observed' || row.checks > 0).map(row => new Date(row.updated_at).getTime());
  const due = pending.filter(row => row.due_at).map(row => new Date(row.due_at).getTime());
  const unpriced = rows.filter(row => row.status === 'excluded' && row.last_error === 'unpriced'
    || row.status === 'verified' && priced.get(row.tx_id).feeUsd === null).map(row => row.tx_id);
  return { swaps: ranked.filter(row => row.status === 'verified' && row.verified_row && row.feeUsd !== null)
      .map(row => priced.get(row.tx_id)),
    pending: pending.map(row => row.tx_id), unpriced,
    checkedAt: checked.length ? new Date(Math.max(...checked)).toISOString() : null,
    nextCheckAt: due.length ? new Date(Math.max(now, Math.min(...due))).toISOString() : null };
}
