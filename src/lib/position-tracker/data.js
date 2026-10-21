/**
 * Network loaders for the Position Tracker. Each loader tolerates per-address
 * failures so one bad lookup never blanks the whole portfolio.
 */

import { booneToolsApi, midgard, thornode } from '../api/index.js';
import { getChurnState, getLeaveStatus, getNodes } from '../utils/nodes.js';
import { fromBaseUnit } from '../utils/blockchain.js';
import { isThorAddress } from './addresses.js';
import {
  buildBondRows,
  buildLpRows,
  buildPriceMap,
  buildTcyClaimRows,
  buildTcyRows
} from './model.js';
import { buildChurnHistory } from './bond-history.js';

const MIDGARD_MEMBER_BATCH = 10;
const LOOKUP_CONCURRENCY = 6;

async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function isNotFound(error) {
  const status = Number(error?.status ?? error?.cause?.status);
  const message = String(error?.message || '');
  return status === 404 || status === 400 || /\b(404|400)\b|doesn't exist|not found/i.test(message);
}

async function loadNodes() {
  try {
    const snapshot = await booneToolsApi.get('/network-snapshot', { query: { field: 'nodes', include_meta: 'true' } });
    if (Array.isArray(snapshot?.value) && snapshot.value.length) return snapshot.value;
  } catch {
    // fall through to THORNode
  }
  return getNodes({ cache: false });
}

/** Shared market context: prices, pools, churn timing. */
export async function loadMarket() {
  const [network, pools, churnState] = await Promise.all([
    thornode.getNetwork({ cache: false }),
    thornode.getPools({ cache: false }),
    getChurnState().catch(() => null)
  ]);
  const runePriceUsd = fromBaseUnit(network?.rune_price_in_tor);
  const prices = buildPriceMap(pools, runePriceUsd);
  return {
    runePriceUsd,
    tcyPriceUsd: prices['THOR.TCY'] || 0,
    prices,
    pools: (Array.isArray(pools) ? pools : []).filter((pool) => pool.status === 'Available'),
    churnState
  };
}

export async function loadBonds(addresses, market) {
  const thorAddresses = addresses.filter(isThorAddress);
  if (thorAddresses.length === 0) return { rows: [], nodes: [] };
  const nodes = await loadNodes();
  return {
    nodes,
    rows: buildBondRows({
      nodes,
      addresses: thorAddresses,
      runePriceUsd: market.runePriceUsd,
      churnState: market.churnState,
      getLeave: getLeaveStatus
    })
  };
}

export async function loadLiquidity(addresses, market) {
  const batches = [];
  for (let i = 0; i < addresses.length; i += MIDGARD_MEMBER_BATCH) {
    batches.push(addresses.slice(i, i + MIDGARD_MEMBER_BATCH));
  }

  const errors = [];
  const memberPools = (await Promise.all(batches.map(async (batch) => {
    try {
      const member = await midgard.getMember(batch.join(','), { cache: false });
      return member?.pools || [];
    } catch (error) {
      if (!isNotFound(error)) errors.push(error.message);
      return [];
    }
  }))).flat();

  const active = memberPools.filter((pool) => Number(pool.liquidityUnits) > 0);
  const providers = {};
  await mapLimited(active, LOOKUP_CONCURRENCY, async (pool) => {
    const lookup = pool.runeAddress || pool.assetAddress;
    try {
      providers[`${pool.pool}|${lookup}`] = await thornode.getLiquidityProvider(pool.pool, lookup, { cache: false });
    } catch {
      // Keep Midgard deposit totals when the live redeem lookup fails.
    }
  });

  return {
    rows: buildLpRows({ memberPools, providers, addresses, prices: market.prices }),
    errors
  };
}

export async function loadTcy(addresses, market) {
  const thorAddresses = addresses.filter(isThorAddress);
  const otherAddresses = addresses.filter((address) => !isThorAddress(address));
  const stakers = {};
  const balances = {};
  const distributions = {};
  const claims = [];

  await mapLimited(thorAddresses, LOOKUP_CONCURRENCY, async (address) => {
    const [staker, balance, distribution] = await Promise.all([
      thornode.fetch(`/thorchain/tcy_staker/${address}`, { cache: false }).catch(() => null),
      thornode.getBalance(address, { cache: false }).catch(() => null),
      midgard.getTCYDistribution(address, { cache: false }).catch(() => null)
    ]);
    if (staker) stakers[address] = staker;
    const tcy = (balance?.balances || []).find((coin) => coin.denom === 'tcy');
    if (tcy) balances[address] = tcy.amount;
    if (distribution) distributions[address] = distribution;
  });

  await mapLimited(otherAddresses, LOOKUP_CONCURRENCY, async (address) => {
    try {
      const data = await thornode.fetch(`/thorchain/tcy_claimer/${address}`, { cache: false });
      claims.push(...(data?.tcy_claimer || []));
    } catch {
      // No unclaimed TCY for this address.
    }
  });

  return {
    rows: buildTcyRows({
      addresses: thorAddresses,
      stakers,
      balances,
      distributions,
      tcyPriceUsd: market.tcyPriceUsd,
      runePriceUsd: market.runePriceUsd
    }),
    claimRows: buildTcyClaimRows(claims, market.tcyPriceUsd)
  };
}

// History only moves once a churn, so a short cache keeps tab and focus switches free.
const BOND_HISTORY_TTL_MS = 10 * 60 * 1000;
const BOND_HISTORY_POLLS = 19;
const BOND_HISTORY_POLL_MS = 5000;
const bondHistoryCache = new Map();

/**
 * Churn history for one bond address from the BooneTools backend. Cold
 * addresses are queued for the history worker, so poll the cache-only status
 * path until the first snapshot exists (the classic Bond Tracker's contract).
 */
export function loadBondHistory(address, { includeHistorical = false, fresh = false } = {}) {
  const key = `${address}|${includeHistorical ? 1 : 0}`;
  const cached = bondHistoryCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < BOND_HISTORY_TTL_MS) return cached.promise;

  const promise = (async () => {
    let data = null;
    for (let attempt = 0; attempt < BOND_HISTORY_POLLS; attempt += 1) {
      data = await booneToolsApi.get('/bond-history', {
        headers: attempt === 0 ? { Prefer: 'respond-async' } : {},
        query: {
          bond_address: address,
          include_historical: includeHistorical ? true : '',
          include_bond_txs: true,
          refresh: attempt === 0 ? '' : 'status'
        }
      });
      if (data.refresh_status !== 'queued' || (data.history || []).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, BOND_HISTORY_POLL_MS));
    }
    if (data?.refresh_status === 'queued' && !(data.history || []).length) {
      throw new Error('bond history is still being built; try again shortly');
    }
    return {
      history: buildChurnHistory(data.history || []),
      txMap: data.bond_tx_map || {},
      hasHistorical: !!data.has_historical
    };
  })();
  bondHistoryCache.set(key, { at: Date.now(), promise });
  promise.catch(() => bondHistoryCache.delete(key));
  return promise;
}

/** Halt flags that gate management actions. */
export async function loadActionGates() {
  const mimir = await thornode.getAllMimir({ cache: false }).catch(() => ({}));
  const flag = (key) => Number(mimir?.[key]) >= 1;
  return {
    globalHalt: flag('HALTCHAINGLOBAL') || flag('HALTTHORCHAIN'),
    lpPaused: flag('PAUSELP'),
    tcyStakingHalted: flag('TCYSTAKINGHALT'),
    tcyUnstakingHalted: flag('TCYUNSTAKINGHALT'),
    tcyClaimingHalted: flag('TCYCLAIMINGHALT'),
    churnHalted: flag('HALTCHURNING')
  };
}
