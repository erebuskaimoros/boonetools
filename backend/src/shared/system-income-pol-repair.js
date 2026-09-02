import { config } from '../lib/config.js';
import { fetchThorchainRpc } from './rpc.js';
import { parseChainHeaderRange, upsertChainHeaders } from './chain-headers.js';
import { parseSystemIncomePolRpcBlock } from './system-income-pol-blocks.js';
import {
  saveSystemIncomePolBlocks,
  updateSystemIncomePolState
} from './system-income-pol-store.js';

const BLOCKCHAIN_PAGE_SIZE = 20;
const REPAIR_PERSIST_BATCH_SIZE = 100;

async function persistConcurrentBatches(items, limit, worker, persist) {
  let persisted = 0;
  for (let offset = 0; offset < items.length; offset += REPAIR_PERSIST_BATCH_SIZE) {
    const batch = items.slice(offset, offset + REPAIR_PERSIST_BATCH_SIZE);
    const results = new Array(batch.length);
    let cursor = 0;
    let failure = null;
    async function run() {
      while (!failure && cursor < batch.length) {
        const index = cursor++;
        try {
          results[index] = await worker(batch[index]);
        } catch (error) {
          failure ||= error;
        }
      }
    }
    // Workers stop taking new items after a failure, but all already-started
    // requests finish before persistence or the advisory-lock client is released.
    await Promise.all(Array.from({ length: Math.min(batch.length, Math.max(1, limit)) }, run));
    const successful = results.filter((result) => result !== undefined);
    if (successful.length) {
      await persist(successful);
      persisted += successful.length;
    }
    if (failure) throw failure;
  }
  return persisted;
}

function rpcHead(payload = {}) {
  const height = Math.trunc(Number(payload?.result?.sync_info?.latest_block_height)) || 0;
  if (height <= 0) throw new Error('SIPOL repair could not resolve the RPC head');
  return height;
}

async function ensureHeaderRange(client, startHeight, endHeight, options = {}) {
  const existing = await client.query(
    `select height, block_hash, block_time, has_swap_events, source,
            system_income_burn_e8, system_income_total_e8, system_income_pol_observed,
            system_income_pol_reward_e8, system_income_pol_deployments,
            system_income_pol_pool_fees
     from chain_block_headers where height between $1 and $2`,
    [startHeight, endHeight]
  );
  const byHeight = new Map(existing.rows.map((row) => [Number(row.height), row]));
  const ranges = [];
  for (let cursor = startHeight; cursor <= endHeight; cursor += BLOCKCHAIN_PAGE_SIZE) {
    const maxHeight = Math.min(endHeight, cursor + BLOCKCHAIN_PAGE_SIZE - 1);
    if (Array.from({ length: maxHeight - cursor + 1 }, (_, index) => cursor + index)
      .some((height) => !byHeight.has(height))) {
      ranges.push({ minHeight: cursor, maxHeight });
    }
  }
  const fetchRpc = options.fetchRpc || fetchThorchainRpc;
  await persistConcurrentBatches(
    ranges,
    options.concurrency || config.systemIncomePolRepairConcurrency,
    async (range) => parseChainHeaderRange(await fetchRpc('/blockchain', range), 'liquify-rpc-sipol-repair'),
    (pages) => upsertChainHeaders(client, pages.flat())
  );
  const resolved = await client.query(
    `select height, block_hash, block_time, has_swap_events, source,
            system_income_burn_e8, system_income_total_e8, system_income_pol_observed,
            system_income_pol_reward_e8, system_income_pol_deployments,
            system_income_pol_pool_fees
     from chain_block_headers where height between $1 and $2 order by height`,
    [startHeight, endHeight]
  );
  return new Map(resolved.rows.map((row) => [Number(row.height), row]));
}

function completeHeaderEvents(header) {
  if (header.system_income_pol_observed !== true
    || header.system_income_total_e8 == null
    || header.system_income_pol_reward_e8 == null
    || !Array.isArray(header.system_income_pol_deployments)
    || !Array.isArray(header.system_income_pol_pool_fees)) return null;
  return {
    rewardE8: header.system_income_pol_reward_e8,
    systemIncomeE8: header.system_income_total_e8,
    deployments: header.system_income_pol_deployments,
    poolFees: header.system_income_pol_pool_fees
  };
}

async function persistRepairedBlocks(client, blocks) {
  // Save complete event headers first. If the ledger write fails, the next run
  // can rebuild it from these headers without requesting the block results again.
  await upsertChainHeaders(client, blocks.map((block) => ({
    height: block.height,
    blockHash: block.header.block_hash,
    blockTime: block.blockTime,
    hasSwapEvents: block.header.has_swap_events,
    source: block.header.source,
    incomeBurnE8: block.header.system_income_burn_e8,
    systemIncomeTotalE8: block.parsed.systemIncomeE8,
    systemIncomePolObserved: true,
    systemIncomePolRewardE8: block.parsed.rewardE8,
    systemIncomePolDeployments: block.parsed.deployments,
    systemIncomePolPoolFees: block.parsed.poolFees
  })));
  await saveSystemIncomePolBlocks(client, blocks);
}

export async function repairSystemIncomePolBlocks(client, options = {}) {
  const fetchRpcSource = options.fetchRpc || fetchThorchainRpc;
  const fetchRpc = (path, params = {}) => fetchRpcSource(path, params, {
    cooldownClient: client,
    cooldownScope: 'system-income-pol-repair'
  });
  const activationHeight = Math.max(
    1,
    Math.trunc(Number(options.activationHeight)) || config.systemIncomePolActivationHeight
  );
  const headHeight = Math.trunc(Number(options.headHeight)) || rpcHead(await fetchRpc('/status'));
  if (headHeight < activationHeight) {
    return { activationHeight, headHeight, requested: 0, repaired: 0, complete: true };
  }
  // Revisit the full activation range so schema upgrades can enrich durable
  // legacy rows without discarding the already-captured funding ledger.
  const repairStartHeight = activationHeight;
  const limit = Math.max(
    1,
    Math.trunc(Number(options.limit)) || config.systemIncomePolRepairBlocksPerRun
  );
  const missing = await client.query(
    `select candidate.height::bigint
     from generate_series($1::bigint, $2::bigint) candidate(height)
     left join system_income_pol_blocks blocks on blocks.height = candidate.height
     where blocks.height is null or blocks.system_income_e8 is null
     order by candidate.height
     limit $3`,
    [repairStartHeight, headHeight, limit]
  );
  const heights = missing.rows.map((row) => Number(row.height)).filter((height) => height > 0);
  if (!heights.length) {
    return {
      activationHeight,
      headHeight,
      repairStartHeight,
      requested: 0,
      repaired: 0,
      complete: true
    };
  }
  const headers = await ensureHeaderRange(client, heights[0], heights.at(-1), {
    ...options,
    fetchRpc
  });
  const repaired = await persistConcurrentBatches(
    heights,
    options.concurrency || config.systemIncomePolRepairConcurrency,
    async (height) => {
      const header = headers.get(height);
      if (!header?.block_time) throw new Error(`SIPOL repair is missing block time for ${height}`);
      const storedEvents = completeHeaderEvents(header);
      const parsed = storedEvents || parseSystemIncomePolRpcBlock(await fetchRpc('/block_results', { height }));
      return {
        height,
        blockTime: header.block_time,
        rewardE8: parsed.rewardE8,
        systemIncomeE8: parsed.systemIncomeE8,
        deployments: parsed.deployments,
        poolFees: parsed.poolFees,
        source: storedEvents ? header.source : 'liquify-rpc-repair',
        header,
        parsed
      };
    },
    (blocks) => persistRepairedBlocks(client, blocks)
  );
  const remaining = await client.query(
    `select exists (
       select 1 from generate_series($1::bigint, $2::bigint) candidate(height)
       left join system_income_pol_blocks blocks on blocks.height = candidate.height
       where blocks.height is null or blocks.system_income_e8 is null
     ) as missing`,
    [repairStartHeight, headHeight]
  );
  const complete = !remaining.rows[0]?.missing;
  if (complete) {
    await updateSystemIncomePolState(client, {
      activationHeight,
      lastEventHeight: headHeight,
      stats: {
        repaired_blocks: repaired,
        repair_head_height: headHeight,
        repair_complete: true
      }
    });
  }
  return {
    activationHeight,
    headHeight,
    repairStartHeight,
    requested: heights.length,
    repaired,
    complete
  };
}
