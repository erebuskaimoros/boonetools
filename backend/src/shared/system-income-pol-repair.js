import { config } from '../lib/config.js';
import { fetchThorchainRpc } from './rpc.js';
import { parseChainHeaderRange, upsertChainHeaders } from './chain-headers.js';
import { parseSystemIncomePolRpcBlock } from './system-income-pol-blocks.js';
import {
  saveSystemIncomePolBlocks,
  updateSystemIncomePolState
} from './system-income-pol-store.js';

const BLOCKCHAIN_PAGE_SIZE = 20;

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, limit)) }, run));
  return results;
}

function rpcHead(payload = {}) {
  const height = Math.trunc(Number(payload?.result?.sync_info?.latest_block_height)) || 0;
  if (height <= 0) throw new Error('SIPOL repair could not resolve the RPC head');
  return height;
}

async function ensureHeaderRange(client, startHeight, endHeight, options = {}) {
  const existing = await client.query(
    `select height, block_hash, block_time, has_swap_events, source,
            system_income_burn_e8, system_income_pol_observed,
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
  const fetched = await mapWithConcurrency(
    ranges,
    options.concurrency || config.systemIncomePolRepairConcurrency,
    async (range) => parseChainHeaderRange(await fetchRpc('/blockchain', range), 'liquify-rpc-sipol-repair')
  );
  const headers = fetched.flat();
  if (headers.length) await upsertChainHeaders(client, headers);
  const resolved = await client.query(
    `select height, block_hash, block_time, has_swap_events, source,
            system_income_burn_e8, system_income_pol_observed,
            system_income_pol_reward_e8, system_income_pol_deployments,
            system_income_pol_pool_fees
     from chain_block_headers where height between $1 and $2 order by height`,
    [startHeight, endHeight]
  );
  return new Map(resolved.rows.map((row) => [Number(row.height), row]));
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
  const stateResult = await client.query(
    `select last_event_height::text
     from system_income_pol_state where state_key = 'system-income-pol:v1'`,
    []
  );
  const durableCursor = Math.max(
    activationHeight - 1,
    Math.trunc(Number(stateResult.rows[0]?.last_event_height)) || activationHeight - 1
  );
  const repairStartHeight = Math.min(headHeight, Math.max(activationHeight, durableCursor + 1));
  const limit = Math.max(
    1,
    Math.trunc(Number(options.limit)) || config.systemIncomePolRepairBlocksPerRun
  );
  const missing = await client.query(
    `select candidate.height::bigint
     from generate_series($1::bigint, $2::bigint) candidate(height)
     left join system_income_pol_blocks blocks on blocks.height = candidate.height
     where blocks.height is null
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
  const blocks = await mapWithConcurrency(
    heights,
    options.concurrency || config.systemIncomePolRepairConcurrency,
    async (height) => {
      const header = headers.get(height);
      if (!header?.block_time) throw new Error(`SIPOL repair is missing block time for ${height}`);
      const parsed = parseSystemIncomePolRpcBlock(await fetchRpc('/block_results', { height }));
      return {
        height,
        blockTime: header.block_time,
        rewardE8: parsed.rewardE8,
        deployments: parsed.deployments,
        poolFees: parsed.poolFees,
        source: 'liquify-rpc-repair',
        header,
        parsed
      };
    }
  );
  await saveSystemIncomePolBlocks(client, blocks);
  await upsertChainHeaders(client, blocks.map((block) => ({
    height: block.height,
    blockHash: block.header.block_hash,
    blockTime: block.blockTime,
    hasSwapEvents: block.header.has_swap_events,
    source: block.header.source,
    incomeBurnE8: block.header.system_income_burn_e8,
    systemIncomePolObserved: true,
    systemIncomePolRewardE8: block.parsed.rewardE8,
    systemIncomePolDeployments: block.parsed.deployments,
    systemIncomePolPoolFees: block.parsed.poolFees
  })));
  const remaining = await client.query(
    `select exists (
       select 1 from generate_series($1::bigint, $2::bigint) candidate(height)
       left join system_income_pol_blocks blocks on blocks.height = candidate.height
       where blocks.height is null
     ) as missing`,
    [repairStartHeight, headHeight]
  );
  const complete = !remaining.rows[0]?.missing;
  if (complete) {
    await updateSystemIncomePolState(client, {
      activationHeight,
      lastEventHeight: headHeight,
      stats: {
        repaired_blocks: blocks.length,
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
    repaired: blocks.length,
    complete
  };
}
