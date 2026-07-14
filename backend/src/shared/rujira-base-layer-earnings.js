import { readFile } from 'node:fs/promises';

import { withAdvisoryLock } from '../db/lock.js';
import { query } from '../db/pool.js';
import { fetchNodeVotesBlockTime } from './node-votes.js';
import { extractThorHeight, fetchThorchain } from './thornode.js';

const LOCK_KEY = 'boonetools:rujira-base-layer-earnings';
const BASE_LAYER_COLLECTOR =
  'thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr';
const ROUTE_COLLECTORS = Object.freeze([
  {
    key: 'trade',
    name: 'RUJI Trade',
    address: 'thor1gm8q2gr25nzzsxzdp2mpja4hyvyhjlr4s6krcsgv2y953uu0js3qhwpus7'
  },
  {
    key: 'core',
    name: 'Other Core Apps',
    address: 'thor1jduxxzpyyvrgzx7zcnl7e5cdj34tnq5jxy00a4wp86szye25dndq575c0y'
  },
  {
    key: 'base',
    name: 'Base Layer Collector',
    address: BASE_LAYER_COLLECTOR
  }
]);
const SEED_URL = new URL('../../data/rujira-base-layer-inflows.json', import.meta.url);
const CANONICAL_RESERVE_PAYMENT_EVENTS_CTE = `
with canonical_events as (
  select *
  from (
    select event.*,
           row_number() over (
             partition by height, tx_id, amount_base, sender, recipient, memo
             order by
               case when source = 'dune' then 0 else 1 end,
               block_time desc,
               updated_at desc,
               event_key desc
           ) as canonical_rank
    from rujira_reserve_payment_events event
  ) ranked
  where canonical_rank = 1
)`;

let seedPromise;

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function serializeRujiraBaseLayerEarningsJson(value) {
  return JSON.stringify(value);
}

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function startOfUtcWeek(value) {
  const date = new Date(`${dateKey(value)}T00:00:00Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return date;
}

function normalizeDenom(value) {
  return String(value || '').trim().toLowerCase();
}

function amountFromBase(value) {
  return safeNumber(value) / 1e8;
}

function isStableDenom(denom) {
  return /(?:usdc|usdt|dai|gusd|usdp)/i.test(denom || '');
}

function denomToPoolAsset(value) {
  let denom = normalizeDenom(value);
  if (denom.startsWith('x/ghost-vault/')) denom = denom.slice('x/ghost-vault/'.length);
  if (denom === 'rune') return 'THOR.RUNE';
  if (denom.startsWith('x/')) return `THOR.${denom.slice(2).toUpperCase()}`;
  if (denom.startsWith('thor.')) return denom.toUpperCase();
  if (!denom.includes('-')) return `THOR.${denom.toUpperCase()}`;
  const splitAt = denom.indexOf('-');
  return `${denom.slice(0, splitAt).toUpperCase()}.${denom.slice(splitAt + 1).toUpperCase()}`;
}

function normalizeBalances(rows) {
  const balances = {};
  for (const row of rows || []) {
    const denom = normalizeDenom(row?.denom);
    if (!denom) continue;
    const amount = amountFromBase(row?.amount);
    if (amount > 0) balances[denom] = amount;
  }
  return balances;
}

function normalizeCollectorBalances(value) {
  return Object.fromEntries(
    ROUTE_COLLECTORS.map((collector) => [
      collector.key,
      Array.isArray(value?.[collector.key])
        ? normalizeBalances(value[collector.key])
        : Object.fromEntries(
            Object.entries(value?.[collector.key] || {}).map(([denom, amount]) => [
              normalizeDenom(denom),
              safeNumber(amount)
            ])
          )
    ])
  );
}

export function deriveRujiraBaseLayerRouteScopes(payload) {
  return ROUTE_COLLECTORS.map((collector) => {
    const config = payload?.configs?.[collector.key] || {};
    const targetAddresses = Array.isArray(config.target_addresses) ? config.target_addresses : [];
    const totalWeight = targetAddresses.reduce((sum, row) => sum + safeNumber(row?.[1]), 0);
    const baseWeight = targetAddresses.reduce(
      (sum, row) => row?.[0] === BASE_LAYER_COLLECTOR ? sum + safeNumber(row?.[1]) : sum,
      0
    );
    const baseLayerShare = collector.key === 'base'
      ? 1
      : totalWeight > 0 ? baseWeight / totalWeight : 0;
    const targetDenoms = (config.target_denoms || [])
      .map((row) => normalizeDenom(row?.[0]))
      .filter(Boolean);
    const actionDenoms = (payload?.actions?.[collector.key] || [])
      .map((action) => normalizeDenom(action?.denom))
      .filter(Boolean);

    return {
      ...collector,
      baseLayerShare,
      targetDenoms,
      actionDenoms,
      routableDenoms: [...new Set([...targetDenoms, ...actionDenoms])]
    };
  }).filter((scope) => scope.baseLayerShare > 0);
}

export function buildWeightedRoutableBalances(collectorBalances, routeScopes) {
  const normalized = normalizeCollectorBalances(collectorBalances);
  const weighted = {};

  for (const scope of routeScopes || []) {
    const routable = new Set(scope.routableDenoms || []);
    for (const [denom, amount] of Object.entries(normalized[scope.key] || {})) {
      if (!routable.has(denom)) continue;
      weighted[denom] = (weighted[denom] || 0) + amount * safeNumber(scope.baseLayerShare);
    }
  }

  return weighted;
}

function buildPrices(payload) {
  const prices = {
    'THOR.RUNE': amountFromBase(payload?.network?.rune_price_in_tor)
  };
  for (const pool of payload?.pools || []) {
    const asset = String(pool?.asset || '').toUpperCase();
    const price = amountFromBase(pool?.asset_tor_price);
    if (asset && price > 0) prices[asset] = price;
  }
  return prices;
}

function priceForDenom(denom, prices) {
  const price = safeNumber(prices[denomToPoolAsset(denom)]);
  if (price > 0) return price;
  return isStableDenom(denom) ? 1 : 0;
}

export function calculateRujiraBaseLayerEarningsDay({
  baselineBalances,
  currentBalances,
  routeScopes,
  prices,
  reservePayoutRune = 0,
  reservePayoutUsd = 0
}) {
  const baseline = buildWeightedRoutableBalances(baselineBalances, routeScopes);
  const current = buildWeightedRoutableBalances(currentBalances, routeScopes);
  const denoms = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const byDenom = {};
  const unpricedDenoms = [];
  let inventoryDeltaUsd = 0;

  for (const denom of denoms) {
    const amount = safeNumber(current[denom]) - safeNumber(baseline[denom]);
    const price = priceForDenom(denom, prices);
    const usd = amount * price;
    if (Math.abs(amount) < 1e-8 && Math.abs(usd) < 0.005) continue;
    if (price <= 0 && Math.abs(amount) >= 1e-8) unpricedDenoms.push(denom);
    byDenom[denom] = { amount, usd };
    inventoryDeltaUsd += usd;
  }

  if (reservePayoutRune || reservePayoutUsd) {
    const rune = byDenom.rune || { amount: 0, usd: 0 };
    rune.amount += safeNumber(reservePayoutRune);
    rune.usd += safeNumber(reservePayoutUsd);
    byDenom.rune = rune;
  }

  return {
    byDenom,
    unpricedDenoms,
    denomChangeCount: Object.keys(byDenom).length,
    inventoryDeltaUsd,
    reservePayoutRune: safeNumber(reservePayoutRune),
    reservePayoutUsd: safeNumber(reservePayoutUsd),
    inflowUsd: inventoryDeltaUsd + safeNumber(reservePayoutUsd)
  };
}

async function readSeed() {
  seedPromise ||= readFile(SEED_URL, 'utf8').then(JSON.parse);
  return seedPromise;
}

async function estimateHeightAt(client, targetTime) {
  const { rows } = await client.query(
    `select height, block_time
     from rujira_reserve_payment_events
     order by abs(extract(epoch from (block_time - $1::timestamptz))) asc
     limit 1`,
    [targetTime.toISOString()]
  );
  const anchor = rows[0];
  let estimate;
  if (anchor) {
    const anchorTime = new Date(anchor.block_time);
    const offsetBlocks = Math.round((targetTime.getTime() - anchorTime.getTime()) / 6000);
    estimate = Math.max(1, safeNumber(anchor.height) + offsetBlocks);
  } else {
    const lastblock = await fetchThorchain('/thorchain/lastblock');
    estimate = Math.max(1, extractThorHeight(lastblock));
  }

  // Six-second interpolation gets us close. Real RPC block times correct for
  // halts and variable cadence so each baseline lands within a few blocks of
  // UTC midnight instead of slowly drifting across the day boundary.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const blockTime = await fetchNodeVotesBlockTime(estimate);
    const blockTimeMs = Date.parse(blockTime || '');
    if (!Number.isFinite(blockTimeMs)) break;
    const offsetBlocks = Math.round((targetTime.getTime() - blockTimeMs) / 6000);
    if (Math.abs(offsetBlocks) <= 2) return estimate;
    estimate = Math.max(1, estimate + offsetBlocks);
  }

  return estimate;
}

async function fetchHistoricalCollectorBalances(height) {
  const rows = await Promise.all(
    ROUTE_COLLECTORS.map(async (collector) => {
      const payload = await fetchThorchain(
        `/cosmos/bank/v1beta1/balances/${collector.address}?pagination.limit=200`,
        {
          historical: true,
          headers: { 'x-cosmos-block-height': String(Math.trunc(height)) }
        }
      );
      return [collector.key, normalizeBalances(payload?.balances || [])];
    })
  );
  return Object.fromEntries(rows);
}

async function ensureDayBaseline(client, dayStart) {
  const day = dateKey(dayStart);
  const existing = await client.query(
    `select day_start, snapshot_height, snapshot_time, collector_balances, source
     from rujira_base_layer_earnings_day_baselines
     where day_start = $1`,
    [day]
  );
  if (existing.rows[0]) return existing.rows[0];

  const targetTime = new Date(`${day}T00:00:00Z`);
  const height = await estimateHeightAt(client, targetTime);
  const collectorBalances = await fetchHistoricalCollectorBalances(height);
  await client.query(
    `insert into rujira_base_layer_earnings_day_baselines
       (day_start, snapshot_height, snapshot_time, collector_balances, source, updated_at)
     values ($1, $2, $3, $4, 'thornode-archive', now())
     on conflict (day_start) do nothing`,
    [day, height, targetTime.toISOString(), collectorBalances]
  );

  const { rows } = await client.query(
    `select day_start, snapshot_height, snapshot_time, collector_balances, source
     from rujira_base_layer_earnings_day_baselines
     where day_start = $1`,
    [day]
  );
  return rows[0];
}

async function getReservePayouts(client, from, to) {
  const { rows } = await client.query(
    `${CANONICAL_RESERVE_PAYMENT_EVENTS_CTE}
     select coalesce(sum(amount_rune), 0) as amount_rune,
            coalesce(sum(amount_usd), 0) as amount_usd
     from canonical_events
     where block_time >= $1 and block_time <= $2`,
    [from, to]
  );
  return {
    amountRune: safeNumber(rows[0]?.amount_rune),
    amountUsd: safeNumber(rows[0]?.amount_usd)
  };
}

export async function refreshRujiraBaseLayerEarnings(livePayload) {
  return withAdvisoryLock(LOCK_KEY, async (client) => {
    // fetched_at is written after all balance/config requests complete, so it
    // is the safest upper bound for Reserve events paired with this snapshot.
    const observedAt = new Date(livePayload?.fetched_at || livePayload?.as_of || Date.now());
    if (!Number.isFinite(observedAt.getTime())) throw new Error('Invalid App Layer live-state timestamp');
    const requiredKeys = new Set(ROUTE_COLLECTORS.map((collector) => collector.key));
    const blockingFailures = (livePayload?.route_query_failures || []).filter(
      (failure) =>
        requiredKeys.has(failure?.key) &&
        ['balance', 'config', 'actions'].includes(failure?.type)
    );
    if (blockingFailures.length) {
      throw new Error(
        `Cannot refresh Base Layer earnings from incomplete live state: ` +
          `${blockingFailures[0].key} ${blockingFailures[0].type}`
      );
    }
    for (const key of requiredKeys) {
      if (
        !Object.hasOwn(livePayload?.collector_balances || {}, key) ||
        !Object.hasOwn(livePayload?.configs || {}, key) ||
        !Object.hasOwn(livePayload?.actions || {}, key)
      ) {
        throw new Error(`Cannot refresh Base Layer earnings without complete ${key} live state`);
      }
    }
    const dayStart = dateKey(observedAt);
    const dayEnd = dateKey(addDays(new Date(`${dayStart}T00:00:00Z`), 1));
    const routeScopes = deriveRujiraBaseLayerRouteScopes(livePayload);
    if (routeScopes.length !== ROUTE_COLLECTORS.length) {
      throw new Error('Current collector configuration does not expose the full Base Layer route');
    }

    const baseline = await ensureDayBaseline(client, dayStart);
    const reserve = await getReservePayouts(
      client,
      `${dayStart}T00:00:00Z`,
      observedAt.toISOString()
    );
    const result = calculateRujiraBaseLayerEarningsDay({
      baselineBalances: baseline.collector_balances,
      currentBalances: livePayload.collector_balances,
      routeScopes,
      prices: buildPrices(livePayload),
      reservePayoutRune: reserve.amountRune,
      reservePayoutUsd: reserve.amountUsd
    });

    const routeScopeMeta = routeScopes.map((scope) => ({
      key: scope.key,
      name: scope.name,
      address: scope.address,
      baseLayerShare: scope.baseLayerShare,
      targetDenomCount: scope.targetDenoms.length,
      actionDenomCount: scope.actionDenoms.length
    }));
    await client.query(
      `insert into rujira_base_layer_earnings_daily
         (day_start, day_end, snapshot_time, baseline_height, route_scopes, by_denom,
          unpriced_denoms, denom_change_count, inventory_delta_usd, reserve_payout_rune,
          reserve_payout_usd, inflow_usd, source, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'backend-chain-state', now())
       on conflict (day_start)
       do update set
         day_end = excluded.day_end,
         snapshot_time = excluded.snapshot_time,
         baseline_height = excluded.baseline_height,
         route_scopes = excluded.route_scopes,
         by_denom = excluded.by_denom,
         unpriced_denoms = excluded.unpriced_denoms,
         denom_change_count = excluded.denom_change_count,
         inventory_delta_usd = excluded.inventory_delta_usd,
         reserve_payout_rune = excluded.reserve_payout_rune,
         reserve_payout_usd = excluded.reserve_payout_usd,
         inflow_usd = excluded.inflow_usd,
         source = excluded.source,
         updated_at = now()`,
      [
        dayStart,
        dayEnd,
        observedAt.toISOString(),
        baseline.snapshot_height,
        serializeRujiraBaseLayerEarningsJson(routeScopeMeta),
        result.byDenom,
        serializeRujiraBaseLayerEarningsJson(result.unpricedDenoms),
        result.denomChangeCount,
        result.inventoryDeltaUsd,
        result.reservePayoutRune,
        result.reservePayoutUsd,
        result.inflowUsd
      ]
    );

    return {
      ok: true,
      refreshed: true,
      day_start: dayStart,
      snapshot_time: observedAt.toISOString(),
      baseline_height: safeNumber(baseline.snapshot_height),
      inflow_usd: result.inflowUsd,
      denom_change_count: result.denomChangeCount
    };
  });
}

function normalizeDatabaseRow(row) {
  return {
    day_start: dateKey(row.day_start),
    day_end: dateKey(row.day_end),
    transfers: safeNumber(row.denom_change_count),
    inflow_usd: safeNumber(row.inflow_usd),
    by_denom: row.by_denom || {},
    unpriced_denoms: Array.isArray(row.unpriced_denoms) ? row.unpriced_denoms : [],
    snapshot_time: row.snapshot_time ? new Date(row.snapshot_time).toISOString() : null,
    baseline_height: safeNumber(row.baseline_height),
    inventory_delta_usd: safeNumber(row.inventory_delta_usd),
    reserve_payout_rune: safeNumber(row.reserve_payout_rune),
    reserve_payout_usd: safeNumber(row.reserve_payout_usd),
    source: row.source || 'backend-chain-state'
  };
}

export function buildRujiraBaseLayerEarningsPayload(seed, databaseRows, now = new Date()) {
  const rowsByDay = new Map((seed?.daily || []).map((row) => [row.day_start, { ...row }]));
  const sortedDatabaseRows = [...(databaseRows || [])]
    .sort((left, right) => left.day_start.localeCompare(right.day_start));
  for (const row of sortedDatabaseRows) rowsByDay.set(row.day_start, { ...row });
  const daily = [...rowsByDay.values()].sort((left, right) => left.day_start.localeCompare(right.day_start));
  const baselineInventoryUsd = safeNumber(seed?.meta?.baselineInventoryUsd);
  const unpricedDenomSet = new Set([
    ...(seed?.meta?.unpricedDenoms || []),
    ...sortedDatabaseRows.flatMap((row) => row.unpriced_denoms || [])
  ]);
  let cumulativeUsd = baselineInventoryUsd;
  const denomTotals = new Map();

  for (const row of daily) {
    cumulativeUsd += safeNumber(row.inflow_usd);
    row.cumulative_usd = cumulativeUsd;
    for (const [denom, entry] of Object.entries(row.by_denom || {})) {
      const total = denomTotals.get(denom) || {
        denom,
        amount: 0,
        usd: 0,
        priced: !unpricedDenomSet.has(denom)
      };
      total.amount += safeNumber(entry?.amount);
      total.usd += safeNumber(entry?.usd);
      denomTotals.set(denom, total);
    }
  }

  const weeklyByStart = new Map();
  for (const row of daily) {
    const weekStart = dateKey(startOfUtcWeek(row.day_start));
    const week = weeklyByStart.get(weekStart) || {
      week_start: weekStart,
      week_end: dateKey(addDays(new Date(`${weekStart}T00:00:00Z`), 7)),
      transfers: 0,
      inflow_usd: 0,
      by_denom: {}
    };
    week.transfers += safeNumber(row.transfers);
    week.inflow_usd += safeNumber(row.inflow_usd);
    for (const [denom, entry] of Object.entries(row.by_denom || {})) {
      const total = week.by_denom[denom] || { amount: 0, usd: 0 };
      total.amount += safeNumber(entry?.amount);
      total.usd += safeNumber(entry?.usd);
      week.by_denom[denom] = total;
    }
    weeklyByStart.set(weekStart, week);
  }
  let weeklyCumulative = baselineInventoryUsd;
  const weekly = [...weeklyByStart.values()].map((row) => {
    weeklyCumulative += row.inflow_usd;
    return { ...row, cumulative_usd: weeklyCumulative };
  });

  const latestDatabaseRow = sortedDatabaseRows.at(-1) || null;
  const latestSnapshotMs = Date.parse(latestDatabaseRow?.snapshot_time || '');
  const stale = !Number.isFinite(latestSnapshotMs) || now.getTime() - latestSnapshotMs > 5 * 60 * 1000;
  const totalInflowUsd = daily.at(-1)?.cumulative_usd || baselineInventoryUsd;
  const unpricedDenoms = [...unpricedDenomSet].sort();

  return {
    meta: {
      ...(seed?.meta || {}),
      generatedAt: latestDatabaseRow?.snapshot_time || seed?.meta?.generatedAt || null,
      source: latestDatabaseRow ? 'backend-chain-state' : 'static-bootstrap',
      method: 'weighted-routable-balance-delta-live',
      live: Boolean(latestDatabaseRow),
      stale,
      refreshIntervalSeconds: 120,
      historicalSeedGeneratedAt: seed?.meta?.generatedAt || null,
      lastDay: daily.at(-1)?.day_start || null,
      dayCount: daily.length,
      unpricedDenoms,
      unpricedCoinCount: unpricedDenoms.length,
      totalInflowUsd,
      netNewInflowUsd: totalInflowUsd - baselineInventoryUsd,
      scope: seed?.meta?.scope || '',
      caveat: seed?.meta?.caveat || ''
    },
    daily,
    weekly,
    denomTotals: [...denomTotals.values()].sort(
      (left, right) => Math.abs(right.usd) - Math.abs(left.usd)
    )
  };
}

export async function getRujiraBaseLayerEarningsDashboardPayload(client = { query }) {
  const [seed, databaseResult] = await Promise.all([
    readSeed(),
    client.query(
      `select day_start, day_end, snapshot_time, baseline_height, by_denom,
              unpriced_denoms, denom_change_count, inventory_delta_usd, reserve_payout_rune,
              reserve_payout_usd, inflow_usd, source
       from rujira_base_layer_earnings_daily
       order by day_start asc`
    )
  ]);
  return buildRujiraBaseLayerEarningsPayload(
    seed,
    databaseResult.rows.map(normalizeDatabaseRow)
  );
}
