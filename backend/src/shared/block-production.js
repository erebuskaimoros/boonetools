import { fetchThorchainRpc } from './rpc.js';
import { pruneChainHeaders } from './chain-headers.js';

export const BLOCK_PRODUCTION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const BLOCK_PRODUCTION_SAMPLE_MS = 5 * 60 * 1000;
export const BLOCK_PRODUCTION_RETENTION_MS = 48 * 60 * 60 * 1000;
export const BLOCK_PRODUCTION_MAX_POINTS = 400;

const BOOTSTRAP_MIN_POINTS = 12;
const BOOTSTRAP_HOURS = 24;
const BOOTSTRAP_BLOCKS_PER_HOUR = 600;
const BOOTSTRAP_RANGE_SIZE = 20;
const BOOTSTRAP_CONCURRENCY = 4;
const RPC_BLOCKCHAIN_PAGE_SIZE = 20;

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function isoTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function parseBlockProductionHead(payload) {
  const syncInfo = payload?.result?.sync_info || {};
  const height = Math.trunc(finiteNumber(syncInfo.latest_block_height));
  const blockTime = isoTimestamp(syncInfo.latest_block_time);
  if (height <= 0 || !blockTime) {
    throw new Error('RPC status did not include a usable latest block header');
  }
  return { height, blockTime };
}

export function summarizeBlockRange(payload, source = 'rpc-hourly-bootstrap') {
  const rows = parseBlockRangeHeaders(payload);
  const first = rows[0];
  const last = rows.at(-1);
  const blockCount = (last?.height || 0) - (first?.height || 0);
  const elapsedMs = Date.parse(last?.blockTime || '') - Date.parse(first?.blockTime || '');
  if (!first || !last || blockCount <= 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return null;
  }
  return {
    sampleTime: last.blockTime,
    startHeight: first.height,
    endHeight: last.height,
    startBlockTime: first.blockTime,
    endBlockTime: last.blockTime,
    blockCount,
    secondsPerBlock: elapsedMs / blockCount / 1000,
    source
  };
}

export function parseBlockRangeHeaders(payload) {
  return (Array.isArray(payload?.result?.block_metas) ? payload.result.block_metas : [])
    .map((row) => ({
      height: Math.trunc(finiteNumber(row?.header?.height)),
      blockTime: isoTimestamp(row?.header?.time)
    }))
    .filter((row) => row.height > 0 && row.blockTime)
    .sort((left, right) => left.height - right.height);
}

export function buildBlockProductionBuckets(headers, options = {}) {
  const bucketMs = Math.max(60_000, Math.trunc(finiteNumber(options.bucketMs) || BLOCK_PRODUCTION_SAMPLE_MS));
  const source = String(options.source || 'rpc-5m-backfill');
  const buckets = new Map();

  for (const header of headers || []) {
    const timestamp = Date.parse(header?.blockTime || '');
    const height = Math.trunc(finiteNumber(header?.height));
    if (!Number.isFinite(timestamp) || height <= 0) continue;
    const bucketStart = Math.floor(timestamp / bucketMs) * bucketMs;
    const rows = buckets.get(bucketStart) || [];
    rows.push({ height, blockTime: new Date(timestamp).toISOString() });
    buckets.set(bucketStart, rows);
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, rows]) => {
      rows.sort((left, right) => left.height - right.height);
      const first = rows[0];
      const last = rows.at(-1);
      const blockCount = last.height - first.height;
      const elapsedMs = Date.parse(last.blockTime) - Date.parse(first.blockTime);
      if (blockCount <= 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
      return {
        sampleTime: last.blockTime,
        startHeight: first.height,
        endHeight: last.height,
        startBlockTime: first.blockTime,
        endBlockTime: last.blockTime,
        blockCount,
        secondsPerBlock: elapsedMs / blockCount / 1000,
        source
      };
    })
    .filter(Boolean);
}

async function fetchBlockProductionHead(options = {}) {
  const fetchRpc = options.fetchRpc || fetchThorchainRpc;
  return parseBlockProductionHead(await fetchRpc('/status', {}, options.rpcOptions));
}

async function fetchBlockRangeSample(targetHeight, options = {}) {
  const fetchRpc = options.fetchRpc || fetchThorchainRpc;
  const maxHeight = Math.max(2, Math.trunc(targetHeight));
  const minHeight = Math.max(1, maxHeight - BOOTSTRAP_RANGE_SIZE + 1);
  const payload = await fetchRpc('/blockchain', { minHeight, maxHeight }, options.rpcOptions);
  return summarizeBlockRange(payload);
}

async function runInChunks(values, size, operation) {
  const results = [];
  for (let index = 0; index < values.length; index += size) {
    const chunk = values.slice(index, index + size);
    const settled = await Promise.allSettled(chunk.map(operation));
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) results.push(result.value);
    }
  }
  return results;
}

async function fetchBlockHeadersByHeightRange(startHeight, endHeight, options = {}) {
  const fetchRpc = options.fetchRpc || fetchThorchainRpc;
  const pages = [];
  for (let minHeight = startHeight; minHeight <= endHeight; minHeight += RPC_BLOCKCHAIN_PAGE_SIZE) {
    pages.push({
      minHeight,
      maxHeight: Math.min(endHeight, minHeight + RPC_BLOCKCHAIN_PAGE_SIZE - 1)
    });
  }
  const pageHeaders = await runInChunks(
    pages,
    options.concurrency || BOOTSTRAP_CONCURRENCY,
    async ({ minHeight, maxHeight }) => parseBlockRangeHeaders(await fetchRpc(
      '/blockchain',
      { minHeight, maxHeight },
      options.rpcOptions
    ))
  );
  const byHeight = new Map();
  for (const headers of pageHeaders) {
    for (const header of headers) byHeight.set(header.height, header);
  }
  return [...byHeight.values()].sort((left, right) => left.height - right.height);
}

async function insertSamples(client, samples) {
  for (const sample of samples) {
    await client.query(
      `insert into block_production_samples
        (sample_time, start_height, end_height, start_block_time, end_block_time,
         block_count, seconds_per_block, source, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())
       on conflict (sample_time) do update set
         start_height = excluded.start_height,
         end_height = excluded.end_height,
         start_block_time = excluded.start_block_time,
         end_block_time = excluded.end_block_time,
         block_count = excluded.block_count,
         seconds_per_block = excluded.seconds_per_block,
         source = excluded.source,
         updated_at = now()`,
      [
        sample.sampleTime,
        sample.startHeight,
        sample.endHeight,
        sample.startBlockTime,
        sample.endBlockTime,
        sample.blockCount,
        sample.secondsPerBlock,
        sample.source
      ]
    );
  }
}

export async function backfillBlockProductionRange(client, options = {}) {
  const startHeight = Math.trunc(finiteNumber(options.startHeight));
  const endHeight = Math.trunc(finiteNumber(options.endHeight));
  if (startHeight <= 0 || endHeight <= startHeight) {
    throw new Error('Block-production backfill requires a positive start height below the end height');
  }

  const headers = await fetchBlockHeadersByHeightRange(startHeight, endHeight, options);
  if (headers.length < 2) throw new Error('Block-production backfill did not receive enough RPC headers');
  const expectedHeaders = endHeight - startHeight + 1;
  if (headers.length !== expectedHeaders) {
    throw new Error(`Block-production backfill received ${headers.length} of ${expectedHeaders} expected headers`);
  }

  const samples = buildBlockProductionBuckets(headers, options);
  if (!samples.length) throw new Error('Block-production backfill did not produce any complete buckets');
  const coverageStart = samples[0].startBlockTime;
  const coverageEnd = samples.at(-1).endBlockTime;
  const removed = await client.query(
    `delete from block_production_samples
     where source = 'rpc-hourly-bootstrap'
       and sample_time >= $1
       and sample_time <= $2`,
    [coverageStart, coverageEnd]
  );
  await insertSamples(client, samples);
  return {
    startHeight,
    endHeight,
    headers: headers.length,
    samples: samples.length,
    removedHourlySamples: removed.rowCount || 0,
    coverageStart,
    coverageEnd
  };
}

async function bootstrapHistory(client, head, options = {}) {
  const cutoff = new Date(Date.parse(head.blockTime) - BLOCK_PRODUCTION_WINDOW_MS).toISOString();
  const existing = await client.query(
    `select count(*)::integer as count
     from block_production_samples
     where sample_time >= $1 and block_count > 0`,
    [cutoff]
  );
  if (finiteNumber(existing.rows[0]?.count) >= BOOTSTRAP_MIN_POINTS) return 0;

  const targetHeights = Array.from({ length: BOOTSTRAP_HOURS + 1 }, (_, offset) => (
    head.height - ((BOOTSTRAP_HOURS - offset) * BOOTSTRAP_BLOCKS_PER_HOUR)
  )).filter((height) => height > BOOTSTRAP_RANGE_SIZE);
  const samples = await runInChunks(
    targetHeights,
    options.bootstrapConcurrency || BOOTSTRAP_CONCURRENCY,
    (height) => fetchBlockRangeSample(height, options)
  );
  await insertSamples(client, samples);
  return samples.length;
}

async function appendLiveSample(client, head) {
  const latest = await client.query(
    `select end_height, end_block_time
     from block_production_samples
     order by end_block_time desc
     limit 1`
  );
  const previous = latest.rows[0];
  if (!previous) {
    await insertSamples(client, [{
      sampleTime: head.blockTime,
      startHeight: head.height,
      endHeight: head.height,
      startBlockTime: head.blockTime,
      endBlockTime: head.blockTime,
      blockCount: 0,
      secondsPerBlock: 0,
      source: 'status-anchor'
    }]);
    return false;
  }

  const previousTime = Date.parse(previous.end_block_time);
  const headTime = Date.parse(head.blockTime);
  const previousHeight = Math.trunc(finiteNumber(previous.end_height));
  const blockCount = head.height - previousHeight;
  const elapsedMs = headTime - previousTime;
  if (
    blockCount <= 0 ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < BLOCK_PRODUCTION_SAMPLE_MS
  ) {
    return false;
  }

  await insertSamples(client, [{
    sampleTime: head.blockTime,
    startHeight: previousHeight,
    endHeight: head.height,
    startBlockTime: new Date(previousTime).toISOString(),
    endBlockTime: head.blockTime,
    blockCount,
    secondsPerBlock: elapsedMs / blockCount / 1000,
    source: 'status-live'
  }]);
  return true;
}

export async function loadBlockProductionHistory(client, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const cutoff = new Date(nowMs - BLOCK_PRODUCTION_WINDOW_MS).toISOString();
  const headerResult = await client.query(
    `with buckets as (
       select floor(extract(epoch from block_time) / 300)::bigint as bucket,
              max(block_time) as sample_time,
              max(height) as end_height,
              count(*)::integer as block_count,
              avg(interval_ms)::double precision / 1000 as seconds_per_block
       from chain_block_headers
       where block_time >= $1
         and interval_ms is not null
         and interval_ms > 0
       group by floor(extract(epoch from block_time) / 300)::bigint
     )
     select sample_time, end_height, block_count, seconds_per_block,
            'liquify-header-5m-rollup'::text as source
     from buckets
     order by sample_time asc
     limit $2`,
    [cutoff, BLOCK_PRODUCTION_MAX_POINTS]
  );
  const result = headerResult.rows.length > 0
    ? headerResult
    : await client.query(
    `select sample_time, end_height, block_count, seconds_per_block, source
     from block_production_samples
     where sample_time >= $1 and block_count > 0 and seconds_per_block > 0
     order by sample_time asc
     limit $2`,
    [cutoff, BLOCK_PRODUCTION_MAX_POINTS]
  );
  const points = result.rows.map((row) => ({
    time: isoTimestamp(row.sample_time),
    height: Math.trunc(finiteNumber(row.end_height)),
    seconds_per_block: Math.round(finiteNumber(row.seconds_per_block) * 1000) / 1000,
    block_count: Math.trunc(finiteNumber(row.block_count)),
    source: String(row.source || '')
  })).filter((row) => row.time && row.height > 0 && row.seconds_per_block > 0);
  return {
    window_hours: 24,
    live_interval_minutes: BLOCK_PRODUCTION_SAMPLE_MS / 60_000,
    points,
    as_of: points.at(-1)?.time || null,
    source: headerResult.rows.length > 0
      ? 'liquify-thorchain-block-headers'
      : 'thorchain-rpc-block-headers'
  };
}

export async function refreshBlockProductionHistory(client, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const prunedHeaders = await pruneChainHeaders(client, { nowMs });
  await client.query(
    `delete from block_production_samples where sample_time < $1`,
    [new Date(nowMs - BLOCK_PRODUCTION_RETENTION_MS).toISOString()]
  );
  const history = await loadBlockProductionHistory(client, { nowMs });
  return { ...history, pruned_headers: prunedHeaders, bootstrapped: 0, appended: false };
}
