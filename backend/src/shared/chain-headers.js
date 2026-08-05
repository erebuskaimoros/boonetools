import { fetchThorchainRpc } from './rpc.js';

export const CHAIN_HEAD_NOTIFY_CHANNEL = 'boonetools_chain_head';
export const CHAIN_HEADER_RETENTION_MS = 48 * 60 * 60 * 1000;
export const CHAIN_HEADER_BOOTSTRAP_BLOCKS = 15_000;
export const CHAIN_HEADER_REPAIR_MAX_BLOCKS = 30_000;
export const CHAIN_HEADER_API_MAX_POINTS = 20_000;

const RPC_BLOCKCHAIN_PAGE_SIZE = 20;
const RPC_REPAIR_CONCURRENCY = 4;
const RPC_REPAIR_BATCH_DELAY_MS = 25;
const UPSERT_CHUNK_SIZE = 500;

function finiteInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function isoTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function uniqueHeaders(headers) {
  const byHeight = new Map();
  for (const input of Array.isArray(headers) ? headers : []) {
    const header = normalizeChainHeader(input);
    if (header) byHeight.set(header.height, header);
  }
  return [...byHeight.values()].sort((left, right) => left.height - right.height);
}

export function normalizeChainHeader(input = {}) {
  const height = finiteInteger(input.height ?? input.blockHeight);
  const blockTime = isoTimestamp(input.blockTime ?? input.block_time ?? input.time);
  if (height <= 0 || !blockTime) return null;

  return {
    height,
    blockHash: String(input.blockHash ?? input.block_hash ?? input.hash ?? '').toUpperCase(),
    blockTime,
    hasSwapEvents: Boolean(input.hasSwapEvents ?? input.has_swap_events),
    source: String(input.source || 'liquify-ws')
  };
}

export function parseChainHeaderFromNewBlock(data = {}) {
  const events = data?.result_finalize_block?.events
    || data?.result_end_block?.events
    || [];
  return normalizeChainHeader({
    height: data?.block?.header?.height,
    blockHash: data?.block_id?.hash,
    blockTime: data?.block?.header?.time,
    hasSwapEvents: events.some((event) => (
      event?.type === 'swap' || event?.type === 'streaming_swap'
    )),
    source: 'liquify-ws'
  });
}

export function parseChainHeaderRange(payload = {}, source = 'liquify-rpc-repair') {
  return uniqueHeaders(
    (Array.isArray(payload?.result?.block_metas) ? payload.result.block_metas : [])
      .map((row) => ({
        height: row?.header?.height,
        blockHash: row?.block_id?.hash,
        blockTime: row?.header?.time,
        source
      }))
  );
}

function buildHeaderUpsert(headers) {
  const values = [];
  const tuples = headers.map((header) => {
    const offset = values.length;
    values.push(
      header.height,
      header.blockHash,
      header.blockTime,
      header.hasSwapEvents,
      header.source
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, now(), now())`;
  });

  return {
    text: `insert into chain_block_headers
      (height, block_hash, block_time, has_swap_events, source, received_at, updated_at)
     values ${tuples.join(', ')}
     on conflict (height) do update set
       block_hash = case
         when excluded.block_hash <> '' then excluded.block_hash
         else chain_block_headers.block_hash
       end,
       block_time = excluded.block_time,
       has_swap_events = chain_block_headers.has_swap_events or excluded.has_swap_events,
       source = case
         when excluded.source = 'liquify-ws' then excluded.source
         else chain_block_headers.source
       end,
       updated_at = now()`,
    values
  };
}

async function recomputeIntervals(client, minHeight, maxHeight) {
  await client.query(
    `update chain_block_headers current
     set interval_ms = case
       when extract(epoch from (current.block_time - previous.block_time)) >= 0
        and extract(epoch from (current.block_time - previous.block_time)) * 1000 <= 2147483647
         then round(extract(epoch from (current.block_time - previous.block_time)) * 1000)::integer
       else null
     end,
     updated_at = now()
     from chain_block_headers previous
     where previous.height = current.height - 1
       and current.height between $1 and $2`,
    [Math.max(1, minHeight), maxHeight + 1]
  );
}

export async function upsertChainHeaders(client, inputs = []) {
  const headers = uniqueHeaders(inputs);
  if (!headers.length) return [];

  for (let index = 0; index < headers.length; index += UPSERT_CHUNK_SIZE) {
    const statement = buildHeaderUpsert(headers.slice(index, index + UPSERT_CHUNK_SIZE));
    await client.query(statement.text, statement.values);
  }

  await recomputeIntervals(client, headers[0].height, headers.at(-1).height);
  const stored = await client.query(
    `select height, block_hash, block_time, interval_ms, has_swap_events, source
     from chain_block_headers
     where height = any($1::bigint[])
     order by height asc`,
    [headers.map((header) => header.height)]
  );
  return stored.rows.map(normalizeStoredHeader).filter(Boolean);
}

export async function upsertChainHeader(client, input) {
  return (await upsertChainHeaders(client, [input]))[0] || null;
}

function normalizeStoredHeader(row = {}) {
  const normalized = normalizeChainHeader(row);
  if (!normalized) return null;
  const intervalMs = Number(row.intervalMs ?? row.interval_ms);
  return {
    ...normalized,
    intervalMs: Number.isFinite(intervalMs) && intervalMs >= 0 ? Math.trunc(intervalMs) : null
  };
}

export async function saveChainStreamState(client, input = {}) {
  await client.query(
    `insert into chain_stream_state
      (stream_key, last_seen_height, last_seen_block_time, last_repair_height,
       last_repair_at, stats_json, updated_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, now())
     on conflict (stream_key) do update set
       last_seen_height = greatest(chain_stream_state.last_seen_height, excluded.last_seen_height),
       last_seen_block_time = case
         when excluded.last_seen_height >= chain_stream_state.last_seen_height
           then coalesce(excluded.last_seen_block_time, chain_stream_state.last_seen_block_time)
         else chain_stream_state.last_seen_block_time
       end,
       last_repair_height = greatest(chain_stream_state.last_repair_height, excluded.last_repair_height),
       last_repair_at = coalesce(excluded.last_repair_at, chain_stream_state.last_repair_at),
       stats_json = chain_stream_state.stats_json || excluded.stats_json,
       updated_at = now()`,
    [
      String(input.streamKey || 'thorchain-mainnet'),
      Math.max(0, finiteInteger(input.lastSeenHeight)),
      isoTimestamp(input.lastSeenBlockTime),
      Math.max(0, finiteInteger(input.lastRepairHeight)),
      isoTimestamp(input.lastRepairAt),
      JSON.stringify(input.stats || {})
    ]
  );
}

export function serializeChainHead(header = {}) {
  const normalized = normalizeStoredHeader(header);
  if (!normalized) return null;
  return {
    height: normalized.height,
    time: normalized.blockTime,
    time_ms: Date.parse(normalized.blockTime),
    interval_ms: normalized.intervalMs,
    block_hash: normalized.blockHash,
    has_swap_events: normalized.hasSwapEvents,
    source: normalized.source
  };
}

export async function notifyChainHead(client, header) {
  const payload = serializeChainHead(header);
  if (!payload) return null;
  await client.query('select pg_notify($1, $2)', [CHAIN_HEAD_NOTIFY_CHANNEL, JSON.stringify(payload)]);
  return payload;
}

export async function loadLatestChainHead(client) {
  const result = await client.query(
    `select height, block_hash, block_time, interval_ms, has_swap_events, source
     from chain_block_headers
     order by height desc
     limit 1`
  );
  return result.rows[0] ? serializeChainHead(result.rows[0]) : null;
}

export async function loadBlockIntervalSeries(client, options = {}) {
  const hours = Math.min(24, Math.max(1, finiteInteger(options.hours) || 24));
  const afterHeight = Math.max(0, finiteInteger(options.afterHeight));
  const limit = Math.min(
    CHAIN_HEADER_API_MAX_POINTS,
    Math.max(1, finiteInteger(options.limit) || CHAIN_HEADER_API_MAX_POINTS)
  );
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const cutoff = new Date(nowMs - (hours * 60 * 60 * 1000)).toISOString();
  const result = await client.query(
    `select height, block_hash, block_time, interval_ms, has_swap_events, source
     from chain_block_headers
     where block_time >= $1
       and interval_ms is not null
       and interval_ms >= 0
       and ($2::bigint = 0 or height > $2)
     order by height asc
     limit $3`,
    [cutoff, afterHeight, limit + 1]
  );
  const complete = result.rows.length <= limit;
  const rows = result.rows.slice(0, limit).map(normalizeStoredHeader).filter(Boolean);
  const gaps = [];
  for (let index = 1; index < rows.length && gaps.length < 100; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (current.height > previous.height + 1) {
      gaps.push([previous.height + 1, current.height - 1]);
    }
  }

  return {
    schema_version: 1,
    window_hours: hours,
    interval: 'block',
    columns: ['height', 'time_ms', 'interval_ms', 'has_swap_events'],
    points: rows.map((row) => [
      row.height,
      Date.parse(row.blockTime),
      row.intervalMs,
      row.hasSwapEvents ? 1 : 0
    ]),
    as_of_height: rows.at(-1)?.height || afterHeight || null,
    as_of: rows.at(-1)?.blockTime || null,
    complete,
    gaps,
    source: 'liquify-thorchain-block-headers'
  };
}

export function listMissingHeaderRanges(existingHeights, startHeight, endHeight, pageSize = RPC_BLOCKCHAIN_PAGE_SIZE) {
  const existing = new Set(
    (Array.isArray(existingHeights) ? existingHeights : [])
      .map(finiteInteger)
      .filter((height) => height > 0)
  );
  const ranges = [];
  let cursor = Math.max(1, finiteInteger(startHeight));
  const end = Math.max(cursor, finiteInteger(endHeight));
  const boundedPageSize = Math.max(1, finiteInteger(pageSize) || RPC_BLOCKCHAIN_PAGE_SIZE);

  while (cursor <= end) {
    if (existing.has(cursor)) {
      cursor += 1;
      continue;
    }
    const minHeight = cursor;
    let maxHeight = cursor;
    while (
      maxHeight + 1 <= end
      && maxHeight - minHeight + 1 < boundedPageSize
      && !existing.has(maxHeight + 1)
    ) {
      maxHeight += 1;
    }
    ranges.push({ minHeight, maxHeight });
    cursor = maxHeight + 1;
  }
  return ranges;
}

async function wait(milliseconds) {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchMissingRanges(ranges, options = {}) {
  const fetchRpc = options.fetchRpc || fetchThorchainRpc;
  const concurrency = Math.max(1, finiteInteger(options.concurrency) || RPC_REPAIR_CONCURRENCY);
  const delayMs = Math.max(0, finiteInteger(options.batchDelayMs ?? RPC_REPAIR_BATCH_DELAY_MS));
  const headers = [];
  const failedRanges = [];

  for (let index = 0; index < ranges.length; index += concurrency) {
    const chunk = ranges.slice(index, index + concurrency);
    const settled = await Promise.allSettled(chunk.map(async ({ minHeight, maxHeight }) => (
      parseChainHeaderRange(await fetchRpc('/blockchain', { minHeight, maxHeight }, options.rpcOptions))
    )));
    settled.forEach((result, resultIndex) => {
      if (result.status === 'fulfilled') headers.push(...result.value);
      else failedRanges.push(chunk[resultIndex]);
    });
    if (index + concurrency < ranges.length) await wait(delayMs);
  }

  return { headers: uniqueHeaders(headers), failedRanges };
}

export async function pruneChainHeaders(client, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const retentionMs = Math.max(60 * 60 * 1000, Number(options.retentionMs) || CHAIN_HEADER_RETENTION_MS);
  const result = await client.query(
    'delete from chain_block_headers where block_time < $1',
    [new Date(nowMs - retentionMs).toISOString()]
  );
  return result.rowCount || 0;
}

function parseRpcHead(payload = {}) {
  const height = finiteInteger(payload?.result?.sync_info?.latest_block_height);
  const blockTime = isoTimestamp(payload?.result?.sync_info?.latest_block_time);
  if (height <= 0 || !blockTime) {
    throw new Error('RPC status did not include a usable latest block header');
  }
  return { height, blockTime };
}

export async function repairChainHeaderGaps(client, options = {}) {
  const fetchRpc = options.fetchRpc || fetchThorchainRpc;
  const head = options.head || parseRpcHead(await fetchRpc('/status', {}, options.rpcOptions));
  const cutoff = new Date(
    Date.parse(head.blockTime) - (Number(options.retentionMs) || CHAIN_HEADER_RETENTION_MS)
  ).toISOString();
  const coverage = await client.query(
    `select min(height)::bigint as min_height
     from chain_block_headers
     where block_time >= $1`,
    [cutoff]
  );
  const retainedMin = finiteInteger(coverage.rows[0]?.min_height);
  const bootstrapBlocks = Math.max(1, finiteInteger(options.bootstrapBlocks) || CHAIN_HEADER_BOOTSTRAP_BLOCKS);
  const maxBlocks = Math.max(bootstrapBlocks, finiteInteger(options.maxBlocks) || CHAIN_HEADER_REPAIR_MAX_BLOCKS);
  const bootstrapStart = Math.max(1, head.height - bootstrapBlocks + 1);
  const retainedStart = retainedMin > 0
    ? Math.min(retainedMin, bootstrapStart)
    : bootstrapStart;
  const startHeight = Math.max(
    1,
    head.height - maxBlocks + 1,
    retainedStart
  );
  const existingResult = await client.query(
    `select height
     from chain_block_headers
     where height between $1 and $2
     order by height asc`,
    [startHeight, head.height]
  );
  const existingHeights = existingResult.rows.map((row) => finiteInteger(row.height));
  const ranges = listMissingHeaderRanges(existingHeights, startHeight, head.height);
  const fetched = await fetchMissingRanges(ranges, { ...options, fetchRpc });
  if (fetched.headers.length) await upsertChainHeaders(client, fetched.headers);
  const pruned = await pruneChainHeaders(client, {
    nowMs: Date.parse(head.blockTime),
    retentionMs: options.retentionMs
  });
  await saveChainStreamState(client, {
    lastSeenHeight: head.height,
    lastSeenBlockTime: head.blockTime,
    lastRepairHeight: head.height,
    lastRepairAt: new Date().toISOString(),
    stats: {
      repair_start_height: startHeight,
      repair_ranges: ranges.length,
      repair_headers: fetched.headers.length,
      repair_failed_ranges: fetched.failedRanges.length,
      headers_pruned: pruned
    }
  });

  return {
    headHeight: head.height,
    startHeight,
    existingHeaders: existingHeights.length,
    requestedRanges: ranges.length,
    repairedHeaders: fetched.headers.length,
    failedRanges: fetched.failedRanges,
    pruned
  };
}
