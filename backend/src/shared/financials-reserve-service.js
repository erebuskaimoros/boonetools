import { fetchFinancialReserveAnchor, replayFinancialReserveEmissions } from './financials-reserve-emissions.js';

const METHOD = 'historical-reserve-formula-v1';

function checkedObservation(row) {
  const height = Number(row.height);
  const point = row.reserve_observation;
  if (!Number.isSafeInteger(height) || height < 1 || point?.schemaVersion !== 1 || point.height !== height) {
    throw new Error('Invalid compact Reserve observation height/schema');
  }
  if (!Array.isArray(point.configChanges) || point.configChanges.length) {
    throw new Error('Reserve configuration transition requires a separately verified boundary');
  }
  if (point.rewardEventCount !== 1) throw new Error('Exactly one verified Reserve rewards event is required');
  for (const key of ['reserveDeltaE8', 'afterRewardsDeltaE8']) {
    if (typeof point[key] !== 'string' || !/^-?\d+$/.test(point[key])) throw new Error(`Invalid compact Reserve ${key}`);
  }
  if (typeof point.rewardTransfersE8 !== 'string' || !/^\d+$/.test(point.rewardTransfersE8)) {
    throw new Error('Invalid compact Reserve reward transfers');
  }
  return point;
}

async function deferRows(client, rows, error, { now, retryMs }) {
  const timestamp = now();
  const evidence = { method: METHOD, error: String(error.message || error).slice(0, 500),
    failed_at: new Date(timestamp).toISOString(), retry_after: new Date(timestamp + retryMs).toISOString() };
  await client.query(
    `update financials_reward_blocks as blocks
     set emissions_evidence = incoming.emissions_evidence
     from jsonb_to_recordset($1::jsonb) as incoming (height bigint, emissions_evidence jsonb)
     where blocks.height = incoming.height
       and (blocks.reserve_emissions_e8 is null or blocks.emissions_method is distinct from $2)`,
    [JSON.stringify(rows.map((row) => ({ height: Number(row.height), emissions_evidence: evidence }))), METHOD]
  );
}

async function persistReplay(client, rows, replay, anchor, now) {
  const observations = new Map(rows.map((row) => [Number(row.height), row.reserve_observation]));
  const reconstructedAt = new Date(now()).toISOString();
  const values = replay.blocks.map((block) => ({ height: block.height,
    reserve_observation: observations.get(block.height), reserve_emissions_e8: block.reserveEmissionsE8,
    emissions_method: replay.method, emissions_evidence: { method: replay.method, anchor,
      reserve_before_rewards_e8: block.reserveBeforeRewardsE8, reconstructed_at: reconstructedAt } }));
  // Amount, reviewed method, immutable observation and height-verified anchor
  // move together in one statement. Concurrent enrichment cannot attach an
  // amount derived from an observation that has since changed.
  const result = await client.query(
    `update financials_reward_blocks as blocks
     set reserve_emissions_e8 = incoming.reserve_emissions_e8,
         emissions_method = incoming.emissions_method,
         emissions_evidence = incoming.emissions_evidence
     from jsonb_to_recordset($1::jsonb) as incoming (
       height bigint, reserve_observation jsonb, reserve_emissions_e8 numeric,
       emissions_method text, emissions_evidence jsonb
     )
     where blocks.height = incoming.height and blocks.reserve_observation = incoming.reserve_observation
       and (blocks.reserve_emissions_e8 is null or blocks.emissions_method is distinct from $2)`,
    [JSON.stringify(values), METHOD]
  );
  return result.rowCount || 0;
}

function invalidAnchor(error) {
  return /unsupported reserve|invalid (?:historical )?reserve|rpc did not return the requested reserve|historical reserve rune balance unavailable/i.test(error.message || '');
}

// Reconstruct each contiguous island against its own historical post-block
// anchor. Live observations and repaired history can arrive in any order; a
// gap is never crossed by carrying a balance or today's parameters backwards.
export async function repairFinancialReserveEmissions(client, options = {}) {
  const limit = Math.max(1, Math.min(5000, Math.trunc(options.limit ?? 5000)));
  const chunkSize = Math.max(1, Math.min(5000, Math.trunc(options.chunkSize ?? 5000)));
  const maxChunks = Math.max(1, Math.min(20, Math.trunc(options.maxChunks ?? 4)));
  const minHeight = Math.max(1, Math.trunc(options.minHeight ?? 1));
  const from = options.from == null ? null : Number(options.from);
  if (![limit, chunkSize, maxChunks, minHeight].every(Number.isSafeInteger)
    || from !== null && !Number.isSafeInteger(from)) throw new Error('Invalid Reserve repair bounds');
  const now = options.now || Date.now;
  const deadline = now() + Math.max(1, Number(options.budgetMs ?? 20_000));
  const retryMs = Math.max(60_000, Number(options.retryMs ?? 60 * 60_000));
  const result = { requested: 0, reconstructed: 0, deferred: 0, chunks: 0, complete: false, errors: [] };
  if (options.signal?.aborted) return result;
  const { rows } = await client.query(
    `select height::text, reserve_observation
     from financials_reward_blocks
     where height >= $1 and ($2::bigint is null or block_time >= to_timestamp($2))
       and reserve_observation is not null
       and (reserve_emissions_e8 is null or emissions_method is distinct from $3)
       and (emissions_evidence->>'retry_after' is null or emissions_evidence->>'retry_after' <= $4)
     order by height desc limit $5`,
    [minHeight, from, METHOD, new Date(now()).toISOString(), limit]
  );
  result.requested = rows.length;
  const chunks = [];
  const invalid = new Map();
  let current = [];
  for (const row of rows) {
    try { checkedObservation(row); }
    catch (error) {
      if (current.length) { chunks.push(current); current = []; }
      const group = invalid.get(error.message) || { rows: [], error };
      group.rows.push(row);
      invalid.set(error.message, group);
      continue;
    }
    if (current.length && (Number(current.at(-1).height) - 1 !== Number(row.height) || current.length >= chunkSize)) {
      chunks.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length) chunks.push(current);
  // Persist explicit invalid-observation deferrals once, rather than letting a
  // permanent transition occupy the front of every future candidate batch.
  for (const { rows: invalidRows, error } of invalid.values()) {
    if (options.signal?.aborted || now() >= deadline) break;
    await deferRows(client, invalidRows, error, { now, retryMs });
    result.deferred += invalidRows.length;
    if (result.errors.length < 4) result.errors.push(error.message);
  }
  const fetchAnchor = options.fetchAnchor || ((height) => {
    if (typeof options.getJson !== 'function') throw new Error('Reserve reconstruction requires an allowlisted historical source');
    return fetchFinancialReserveAnchor(height, { getJson: options.getJson });
  });
  for (const chunk of chunks) {
    if (options.signal?.aborted || now() >= deadline || result.chunks >= maxChunks) break;
    result.chunks++;
    let anchor;
    try { anchor = await fetchAnchor(Number(chunk[0].height)); }
    catch (error) {
      if (!invalidAnchor(error)) throw error;
      await deferRows(client, chunk, error, { now, retryMs });
      result.deferred += chunk.length;
      if (result.errors.length < 4) result.errors.push(error.message);
      continue;
    }
    let replay;
    try { replay = replayFinancialReserveEmissions(chunk.map((row) => row.reserve_observation), anchor); }
    catch (error) {
      await deferRows(client, chunk, error, { now, retryMs });
      result.deferred += chunk.length;
      if (result.errors.length < 4) result.errors.push(error.message);
      continue;
    }
    result.reconstructed += await persistReplay(client, chunk, replay, anchor, now);
  }
  result.complete = rows.length < limit && result.reconstructed === rows.length && result.deferred === 0;
  return result;
}
