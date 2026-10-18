import { requestFromProviders } from '../lib/provider-client.js';
import { concurrentBatchWindows } from '../lib/concurrent-batches.js';
import { hasThorchainProviderPair } from '../../../shared/thorchain-provider-pool.js';
import { config } from '../lib/config.js';
import { providerLifecycleHooks } from './provider-cooldown.js';
import { parseFinancialReserveObservation } from './financials-reserve-emissions.js';

// First positive finalized payout, verified with Liquify's ascending indexed
// `rev_share.payout > 0` block search on 2026-10-13. Earlier intervals have no
// REVSHARE deduction; this says nothing about Midgard's other reconciliation
// differences, and does not make its signed residual a direct emission source.
export const FINANCIAL_REVSHARE_FIRST_HEIGHT = 28146078;
export const FINANCIAL_REVSHARE_FIRST_TIME = '2026-10-07T20:29:31.355014883Z';
const FIRST_PAYOUT_SECONDS = Date.parse(FINANCIAL_REVSHARE_FIRST_TIME) / 1000;
const RPC_MAX_BATCH_SIZE = 10;

function rpcError(details, fallback = 'REVSHARE RPC response failed') {
  const detail = typeof details.data === 'string' ? details.data
    : details.data == null ? '' : JSON.stringify(details.data);
  const error = new Error([details.message || fallback, detail].filter(Boolean).join(': '));
  error.archiveUnavailable = /height.*not available|lowest height|no archive/i.test(error.message);
  return error;
}

// REVSHARE is paid in EndBlock, before the rewards allocations observed by
// Midgard. Transaction-result events are intentionally not a second source.
function decoded(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9+/]+=*$/.test(text) && text.length > 1) {
    const candidate = Buffer.from(text, 'base64').toString('utf8');
    if (candidate && /^[\x20-\x7e]+$/.test(candidate)) return candidate;
  }
  return text;
}

export function parseFinancialRevshareBlock(payload = {}, expectedHeight) {
  if (payload.error) throw rpcError(payload.error);
  const result = payload.result ?? payload;
  const finalize = result.result_finalize_block ?? result.result_end_block ?? result;
  const height = Number(result.height ?? result.block?.header?.height);
  if (!Number.isSafeInteger(height) || height < 1
    || (expectedHeight !== undefined && height !== Number(expectedHeight))) {
    throw new Error('REVSHARE response has the wrong block height');
  }
  let events;
  if (Object.hasOwn(finalize, 'events')) events = finalize.events;
  else if (Object.hasOwn(finalize, 'finalize_block_events')) events = finalize.finalize_block_events;
  else if (Object.hasOwn(finalize, 'end_block_events')) events = finalize.end_block_events;
  else throw new Error('REVSHARE finalized events are unavailable');
  if (events !== null && !Array.isArray(events)) throw new Error('Invalid REVSHARE finalized events');
  let total = 0n;
  for (const event of events || []) {
    if (decoded(event.type).toLowerCase() !== 'rev_share') continue;
    const attributes = new Map((event.attributes || []).map(({ key, value }) => [decoded(key), decoded(value)]));
    const payout = attributes.get('payout');
    if (!/^\d+$/.test(payout ?? '')) throw new Error(`Invalid REVSHARE payout at block ${height}`);
    total += BigInt(payout);
  }
  let reserveObservation = null;
  let reserveObservationError = '';
  try { reserveObservation = parseFinancialReserveObservation(payload, height); }
  catch (error) { reserveObservationError = error.message; }
  return { height, revshareE8: total.toString(), reserveObservation,
    ...(reserveObservationError ? { reserveObservationError } : {}) };
}

export async function saveFinancialRewardBlocks(client, observations = []) {
  if (!observations.length) return 0;
  const rows = observations.map((observation) => {
    const height = Number(observation.height);
    const timestamp = Date.parse(observation.blockTime ?? observation.block_time);
    const value = String(observation.revshareE8 ?? observation.revshare_e8 ?? '');
    const reserveObservation = observation.reserveObservation ?? observation.reserve_observation ?? null;
    const reserveEmissions = observation.reserveEmissionsE8 ?? observation.reserve_emissions_e8 ?? null;
    const emissionsMethod = observation.emissionsMethod ?? observation.emissions_method ?? null;
    if (!Number.isSafeInteger(height) || height < 1
      || !Number.isFinite(timestamp) || !/^\d+$/.test(value)
      || reserveObservation !== null && (reserveObservation.schemaVersion !== 1 || reserveObservation.height !== height)
      || reserveEmissions !== null && (!/^\d+$/.test(String(reserveEmissions))
        || emissionsMethod !== 'historical-reserve-formula-v1')) {
      throw new Error('Invalid finalized REVSHARE observation');
    }
    return { height, block_time: new Date(timestamp).toISOString(), revshare_e8: BigInt(value).toString(),
      reserve_observation: reserveObservation,
      reserve_emissions_e8: reserveEmissions === null ? null : BigInt(reserveEmissions).toString(),
      emissions_method: reserveEmissions === null ? null : emissionsMethod,
      source: String(observation.source || 'thorchain-rpc:rev_share.payout') };
  });
  const result = await client.query(
    `insert into financials_reward_blocks as current (
       height, block_time, revshare_e8, source, reserve_observation, reserve_emissions_e8, emissions_method
     )
     select height, block_time, revshare_e8, source, reserve_observation, reserve_emissions_e8, emissions_method
     from jsonb_to_recordset($1::jsonb) as incoming (
       height bigint, block_time timestamptz, revshare_e8 numeric, source text,
       reserve_observation jsonb, reserve_emissions_e8 numeric, emissions_method text
     )
     on conflict (height) do update set
       reserve_observation = coalesce(current.reserve_observation, excluded.reserve_observation),
       reserve_emissions_e8 = coalesce(current.reserve_emissions_e8, excluded.reserve_emissions_e8),
       emissions_method = case when current.reserve_emissions_e8 is null then excluded.emissions_method else current.emissions_method end
     where current.reserve_observation is null and excluded.reserve_observation is not null
        or current.reserve_emissions_e8 is null and excluded.reserve_emissions_e8 is not null`,
    [JSON.stringify(rows)]
  );
  return result.rowCount || 0;
}

function windowEvidence(from, through) {
  return { from, through, revshareE8: null, complete: false,
    reserveEmissionsE8: null, emissionsComplete: false, emissionsMethod: null,
    method: 'finalized-revshare-payouts', source: 'thorchain-rpc:rev_share.payout',
    firstHeight: null, lastHeight: null, observedBlocks: 0, expectedBlocks: null };
}

// Returns a UTC-day map for [from, through), with Unix-second boundaries. A
// partial final day uses exactly the caller's cutoff, not the latest live tip.
// Boundaries come from the already-acquired SIPOL ledger. An omitted boundary
// or even one missing payout block makes that interval unavailable.
export async function readFinancialRewardAccountingDays(client, { from, through }) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(through) || through <= from
    || through - from > 4096 * 86400) throw new Error('Invalid REVSHARE accounting window');
  const days = {};
  const windows = [];
  for (let cursor = from; cursor < through;) {
    const end = Math.min(through, (Math.floor(cursor / 86400) + 1) * 86400);
    const day = new Date(cursor * 1000).toISOString().slice(0, 10);
    days[day] = windowEvidence(cursor, end);
    if (end <= FIRST_PAYOUT_SECONDS) {
      Object.assign(days[day], { revshareE8: '0', complete: true, expectedBlocks: 0,
        method: 'before-first-finalized-revshare-payout' });
    }
    windows.push({ from: cursor, through: end });
    cursor = end;
  }
  if (!windows.length) return days;
  const { rows } = await client.query(
    `select windows.from, windows.through,
            previous.height::text as previous_height, following.height::text as next_height,
            observed.first_height::text, observed.last_height::text,
            observed.observed_blocks::text, observed.revshare_e8::text,
            observed.revshare_first_height::text, observed.revshare_last_height::text,
            observed.revshare_observed_blocks::text, observed.emissions_observed_blocks::text,
            observed.reserve_emissions_e8::text
     from jsonb_to_recordset($1::jsonb) as windows("from" bigint, through bigint)
     left join lateral (
       select height from system_income_pol_blocks
       where block_time < to_timestamp(windows.from)
       order by block_time desc, height desc limit 1
     ) previous on true
     left join lateral (
       select height from system_income_pol_blocks
       where block_time >= to_timestamp(windows.through)
       order by block_time, height limit 1
     ) following on true
     left join lateral (
       select min(height) as first_height, max(height) as last_height,
              count(*) as observed_blocks, coalesce(sum(revshare_e8), 0) as revshare_e8,
              min(height) filter (where height >= $2) as revshare_first_height,
              max(height) filter (where height >= $2) as revshare_last_height,
              count(*) filter (where height >= $2) as revshare_observed_blocks,
              count(*) filter (where reserve_emissions_e8 is not null
                and emissions_method = 'historical-reserve-formula-v1') as emissions_observed_blocks,
              coalesce(sum(reserve_emissions_e8) filter (
                where emissions_method = 'historical-reserve-formula-v1'), 0) as reserve_emissions_e8
       from financials_reward_blocks
       where block_time >= to_timestamp(windows.from)
         and block_time < to_timestamp(windows.through)
     ) observed on true`,
    [JSON.stringify(windows), FINANCIAL_REVSHARE_FIRST_HEIGHT]
  );
  for (const row of rows) {
    const start = Number(row.from);
    const end = Number(row.through);
    const day = new Date(start * 1000).toISOString().slice(0, 10);
    const evidence = days[day];
    if (!evidence || evidence.from !== start || evidence.through !== end) continue;
    const previous = row.previous_height == null ? null : Number(row.previous_height);
    const following = row.next_height == null ? null : Number(row.next_height);
    const first = row.first_height == null ? null : Number(row.first_height);
    const last = row.last_height == null ? null : Number(row.last_height);
    const observed = Number(row.observed_blocks);
    const revshareFirst = row.revshare_first_height == null ? first : Number(row.revshare_first_height);
    const revshareLast = row.revshare_last_height == null ? last : Number(row.revshare_last_height);
    const revshareObserved = Number(row.revshare_observed_blocks ?? row.observed_blocks);
    const expectedFirst = start <= FIRST_PAYOUT_SECONDS ? FINANCIAL_REVSHARE_FIRST_HEIGHT
      : previous === null ? null : previous + 1;
    const expectedLast = following === null ? null : following - 1;
    const expected = expectedFirst !== null && expectedLast !== null
      ? Math.max(0, expectedLast - expectedFirst + 1) : null;
    const complete = expected !== null && revshareObserved === expected
      && following !== null && (previous === null || following > previous)
      && (expected === 0 || revshareFirst === expectedFirst && revshareLast === expectedLast)
      && /^\d+$/.test(String(row.revshare_e8 ?? ''));
    Object.assign(evidence, { firstHeight: first, lastHeight: last,
      observedBlocks: observed, expectedBlocks: expected });
    if (end > FIRST_PAYOUT_SECONDS) Object.assign(evidence, { complete,
      revshareE8: complete ? BigInt(row.revshare_e8).toString() : null });
    const emissionsExpected = previous !== null && following !== null && following > previous
      ? following - previous - 1 : null;
    const emissionsComplete = emissionsExpected !== null && observed === emissionsExpected
      && Number(row.emissions_observed_blocks) === emissionsExpected
      && (emissionsExpected === 0 || first === previous + 1 && last === following - 1)
      && /^\d+$/.test(String(row.reserve_emissions_e8 ?? ''));
    Object.assign(evidence, { emissionsExpectedBlocks: emissionsExpected,
      emissionsObservedBlocks: Number(row.emissions_observed_blocks) || 0, emissionsComplete,
      reserveEmissionsE8: emissionsComplete ? BigInt(row.reserve_emissions_e8).toString() : null,
      emissionsMethod: emissionsComplete ? 'historical-reserve-formula-v1' : null });
  }
  return days;
}

export async function readFinancialRewardAccounting(client, window) {
  const days = await readFinancialRewardAccountingDays(client, window);
  const intervals = Object.values(days);
  if (intervals.length !== 1) throw new Error('Use daily REVSHARE accounting for a multi-day window');
  return intervals[0];
}

export async function fetchFinancialRewardBlockBatch(client, heights, { signal, transport = requestFromProviders } = {}) {
  if (!heights.length || heights.length > RPC_MAX_BATCH_SIZE) {
    throw new Error(`Invalid REVSHARE RPC batch size (maximum ${RPC_MAX_BATCH_SIZE})`);
  }
  signal?.throwIfAborted();
  const hooks = providerLifecycleHooks({ client, scope: 'financials-revshare-archive' });
  const payload = await transport({
    bases: config.rpcRestUrls, path: '/', timeoutMs: 30_000,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-client-id': 'BooneTools-Financials' },
    request: { method: 'POST', signal, body: JSON.stringify(heights.map((height) => ({
      jsonrpc: '2.0', id: String(height), method: 'block_results', params: { height: String(height) }
    }))) },
    ...hooks,
    beforeRequest: async (context) => {
      signal?.throwIfAborted();
      await hooks.beforeRequest(context);
      signal?.throwIfAborted();
    },
    // An intentional collector shutdown is not a provider outage. Independent
    // request deadlines and real errors still retain their shared cooldowns.
    onProviderError: (error, context) => signal?.aborted && (error === signal.reason || error.name === 'AbortError')
      ? undefined : hooks.onProviderError(error, context)
  });
  // NativeSwap unwraps a single-item JSON-RPC batch. Match the requested ID
  // before normalizing; the existing parser still verifies the result height.
  return heights.length === 1 && payload && !Array.isArray(payload)
    && String(payload.id) === String(heights[0]) ? [payload] : payload;
}

// Reuses durable SIPOL timestamps, does not reread headers, and never runs in
// public request handlers. The listener supplies steady-state observations;
// this bounded background repair handles deployment history and missed blocks.
export async function repairFinancialRewardBlocks(client, options = {}) {
  const limit = Math.max(1, Math.min(5000, Math.trunc(options.limit ?? 300)));
  const batchSize = Math.max(1, Math.min(RPC_MAX_BATCH_SIZE, Math.trunc(options.batchSize ?? RPC_MAX_BATCH_SIZE)));
  const now = options.now || Date.now;
  const deadline = now() + Math.max(1, Number(options.budgetMs ?? 20_000));
  const minHeight = Math.max(1, Math.trunc(options.minHeight
    ?? (options.from == null ? FINANCIAL_REVSHARE_FIRST_HEIGHT : 1)));
  const from = options.from == null ? null : Number(options.from);
  if (!Number.isSafeInteger(minHeight) || from !== null && !Number.isSafeInteger(from)) {
    throw new Error('Invalid reward repair start boundary');
  }
  const { rows } = await client.query(
    `select blocks.height::text, blocks.block_time
     from system_income_pol_blocks blocks
     left join financials_reward_blocks rewards on rewards.height = blocks.height
     where blocks.height >= $1 and (rewards.height is null or rewards.reserve_observation is null)
       and ($3::bigint is null or blocks.block_time >= to_timestamp($3))
     order by blocks.height desc limit $2`,
    [minHeight, limit, from]
  );
  const fetchBatch = options.fetchBatch || ((heights) => fetchFinancialRewardBlockBatch(client, heights, options));
  const save = options.save || saveFinancialRewardBlocks;
  let repaired = 0;
  let reserveObserved = 0;
  const windows = concurrentBatchWindows(rows, (batch) => fetchBatch(batch.map((row) => Number(row.height))), {
    batchSize, concurrency: options.batchConcurrency ?? (config.thorchainProviderBalancingEnabled && hasThorchainProviderPair(config.rpcRestUrls) ? 2 : 1),
    delayMs: options.requestSpacingMs ?? 250, signal: options.signal, shouldContinue: () => now() < deadline
  });
  for await (const window of windows) {
    let failure;
    for (const outcome of window) {
      if (outcome.status === 'rejected') { failure ||= outcome.reason; continue; }
      const batch = outcome.items;
      const payload = outcome.value;
      if (!Array.isArray(payload)) {
        failure ||= payload?.error ? rpcError(payload.error, 'REVSHARE RPC batch failed')
          : new Error('Invalid REVSHARE RPC batch response');
        continue;
      }
      const byId = new Map(payload.map((entry) => [String(entry.id), entry]));
      const observations = [];
      for (const row of batch) {
        try {
          const result = byId.get(String(row.height));
          if (!result) throw new Error(`REVSHARE batch is missing block ${row.height}`);
          observations.push({ ...parseFinancialRevshareBlock(result, Number(row.height)),
            blockTime: row.block_time, source: 'thorchain-rpc:rev_share.payout' });
        } catch (error) { failure ||= error; }
      }
      if (observations.length) {
        await save(client, observations);
        repaired += observations.length;
        reserveObserved += observations.filter((observation) => observation.reserveObservation !== null).length;
      }
    }
    if (failure) throw failure;
  }
  return { requested: rows.length, repaired, reserveObserved,
    complete: rows.length < limit && repaired === rows.length && reserveObserved === repaired };
}
