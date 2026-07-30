import { fromBaseUnit } from '../utils/blockchain.js';

const number2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const number4 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const usd2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2
});

export const EMPTY_INVENTORY_BUCKET = Object.freeze({
  rows: [],
  count: 0,
  pricedUsd: 0,
  unpricedCount: 0
});

export const EMPTY_INVENTORY = Object.freeze({
  available: false,
  actionsAvailable: false,
  eligible: EMPTY_INVENTORY_BUCKET,
  conversion: EMPTY_INVENTORY_BUCKET,
  blocked: EMPTY_INVENTORY_BUCKET,
  unresolved: EMPTY_INVENTORY_BUCKET,
  pricedUsd: 0
});

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const headers = lines.shift()?.split(',') || [];
  const numericFields = new Set([
    'payments',
    'payment_rune',
    'rune_price_usd',
    'payment_usd',
    'cumulative_rune',
    'cumulative_usd'
  ]);
  return lines.map((line) => {
    const values = line.split(',');
    return Object.fromEntries(
      headers.map((header, index) => [
        header,
        numericFields.has(header) ? Number(values[index]) : values[index]
      ])
    );
  });
}

export function startOfUtcWeek(date) {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = value.getUTCDay();
  value.setUTCDate(value.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return value;
}

export function normalizeBuckets(rows, grain) {
  const startKey = grain === 'weekly' ? 'week_start' : 'day_start';
  return rows.map((row) => ({ ...row, bucket_start: row[startKey] }));
}

export function pickAggRows(source, grain) {
  const daily = source?.daily || [];
  const weekly = source?.weekly || [];
  if (grain === 'daily' && daily.length) return { rows: normalizeBuckets(daily, 'daily'), grain: 'daily' };
  if (grain === 'weekly' && weekly.length) return { rows: normalizeBuckets(weekly, 'weekly'), grain: 'weekly' };
  if (daily.length) return { rows: normalizeBuckets(daily, 'daily'), grain: 'daily' };
  return { rows: normalizeBuckets(weekly, 'weekly'), grain: 'weekly' };
}

export function pickAccruedValueRows(inflows, generatedFees, grain) {
  const availableFor = (source, candidate) => source?.[candidate]?.length;
  let selectedGrain = grain;

  if (!availableFor(inflows, selectedGrain) || !availableFor(generatedFees, selectedGrain)) {
    selectedGrain = availableFor(inflows, 'daily') && availableFor(generatedFees, 'daily')
      ? 'daily'
      : 'weekly';
  }

  if (!availableFor(inflows, selectedGrain) || !availableFor(generatedFees, selectedGrain)) {
    return { rows: [], grain: selectedGrain };
  }

  const inflowRows = normalizeBuckets(inflows[selectedGrain], selectedGrain);
  const generatedFeeRows = normalizeBuckets(generatedFees[selectedGrain], selectedGrain);
  const inflowsByBucket = new Map(inflowRows.map((row) => [row.bucket_start, row]));
  const generatedFeesByBucket = new Map(generatedFeeRows.map((row) => [row.bucket_start, row]));
  const bucketStarts = [...new Set([
    ...inflowsByBucket.keys(),
    ...generatedFeesByBucket.keys()
  ])].sort();
  let inflowCumulativeUsd = 0;
  let generatedFeeCumulativeUsd = 0;

  const rows = bucketStarts.map((bucketStart) => {
    const inflow = inflowsByBucket.get(bucketStart);
    const generatedFee = generatedFeesByBucket.get(bucketStart);
    const inflowUsd = Number(inflow?.inflow_usd) || 0;
    const generatedFeeUsd = Number(generatedFee?.liquidity_fee_usd) || 0;
    const nextInflowCumulativeUsd = Number(inflow?.cumulative_usd);
    const nextGeneratedFeeCumulativeUsd = Number(generatedFee?.cumulative_usd);

    if (Number.isFinite(nextInflowCumulativeUsd)) inflowCumulativeUsd = nextInflowCumulativeUsd;
    if (Number.isFinite(nextGeneratedFeeCumulativeUsd)) {
      generatedFeeCumulativeUsd = nextGeneratedFeeCumulativeUsd;
    }

    return {
      bucket_start: bucketStart,
      accrued_value_usd: inflowUsd + generatedFeeUsd,
      cumulative_usd: inflowCumulativeUsd + generatedFeeCumulativeUsd,
      inflow_usd: inflowUsd,
      liquidity_fee_usd: generatedFeeUsd
    };
  });

  return { rows, grain: selectedGrain };
}

export function bucketReserveEvents(events, grain) {
  const startOf = grain === 'weekly'
    ? (date) => startOfUtcWeek(date)
    : (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const buckets = new Map();
  for (const event of events) {
    const date = new Date(event.date);
    if (!Number.isFinite(date.getTime())) continue;
    const key = startOf(date).toISOString().slice(0, 10);
    const row = buckets.get(key) || {
      bucket_start: key,
      payments: 0,
      payment_rune: 0,
      payment_usd: 0,
      priceNum: 0,
      priceDen: 0
    };
    const amountRune = Number(event.amountRune) || 0;
    row.payments += 1;
    row.payment_rune += amountRune;
    row.payment_usd += Number(event.amountUsd) || 0;
    row.priceNum += (Number(event.runePriceUsd) || 0) * amountRune;
    row.priceDen += amountRune;
    buckets.set(key, row);
  }

  let cumulativeUsd = 0;
  let cumulativeRune = 0;
  return [...buckets.values()]
    .sort((left, right) => left.bucket_start.localeCompare(right.bucket_start))
    .map((row) => {
      cumulativeUsd += row.payment_usd;
      cumulativeRune += row.payment_rune;
      return {
        bucket_start: row.bucket_start,
        payments: row.payments,
        payment_rune: row.payment_rune,
        payment_usd: row.payment_usd,
        rune_price_usd: row.priceDen > 0 ? row.priceNum / row.priceDen : 0,
        cumulative_usd: cumulativeUsd,
        cumulative_rune: cumulativeRune
      };
    });
}

export function pickPaidRows(events, weeklyFallback, grain, dailyFallback = []) {
  if (grain === 'daily' && dailyFallback?.length) {
    return { rows: normalizeBuckets(dailyFallback, 'daily'), grain: 'daily' };
  }
  if (grain === 'weekly' && weeklyFallback?.length) {
    return { rows: normalizeBuckets(weeklyFallback, 'weekly'), grain: 'weekly' };
  }
  if (dailyFallback?.length) {
    return { rows: normalizeBuckets(dailyFallback, 'daily'), grain: 'daily' };
  }
  if (weeklyFallback?.length) {
    return { rows: normalizeBuckets(weeklyFallback, 'weekly'), grain: 'weekly' };
  }
  if (events?.length) return { rows: bucketReserveEvents(events, grain), grain };
  return { rows: [], grain };
}

export function fillBucketGaps(rows, valueField, cumulativeField, stepDays) {
  if (rows.length < 2) return rows;
  const stepMs = stepDays * 86400 * 1000;
  const output = [];
  let previous = null;
  let guard = 0;
  for (const row of rows) {
    if (previous) {
      let cursor = new Date(`${previous.bucket_start}T00:00:00Z`);
      for (;;) {
        cursor = new Date(cursor.getTime() + stepMs);
        const key = cursor.toISOString().slice(0, 10);
        if (key >= row.bucket_start || (guard += 1) > 1000) break;
        output.push({
          bucket_start: key,
          [valueField]: 0,
          [cumulativeField]: previous[cumulativeField] || 0
        });
      }
    }
    output.push(row);
    previous = row;
  }
  return output;
}

export function amountFromBase(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? fromBaseUnit(numeric) : 0;
}

export function reservePriceForDate(value, rows = []) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 0;
  const match = (rows || []).find((row) => {
    const start = new Date(`${row.week_start}T00:00:00Z`);
    const end = new Date(`${row.week_end}T00:00:00Z`);
    return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && date >= start && date < end;
  });
  return Number(match?.rune_price_usd || 0);
}

export function normalizeReserveEvent(event, priceRows = []) {
  const amountRune = Number(event.amountRune ?? event.amount_rune ?? amountFromBase(event.amountBase));
  const runePriceUsd = Number(
    event.runePriceUsd ?? event.rune_price_usd ?? reservePriceForDate(event.date, priceRows)
  );
  const amountUsd = Number(event.amountUsd ?? event.amount_usd ?? amountRune * runePriceUsd);
  return { ...event, amountRune, runePriceUsd, amountUsd };
}

export function getWeeklyPriceRange(rows) {
  const prices = (rows || []).map((row) => Number(row.rune_price_usd || 0)).filter((price) => price > 0);
  if (!prices.length) return '';
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  if (Math.abs(low - high) < 0.000001) return `$${number4.format(low)}`;
  return `$${number4.format(low)}–$${number4.format(high)}`;
}

export function buildPoolPrices(pools) {
  if (!Array.isArray(pools)) return {};
  return Object.fromEntries(
    pools
      .filter((pool) => pool.asset && pool.asset_tor_price)
      .map((pool) => [pool.asset.toUpperCase(), amountFromBase(pool.asset_tor_price)])
  );
}

export function denomToPoolAsset(denom) {
  if (!denom) return '';
  if (denom === 'rune') return 'THOR.RUNE';
  if (denom.startsWith('x/ghost-vault/')) return denomToPoolAsset(denom.slice('x/ghost-vault/'.length));
  if (denom.startsWith('x/')) return `THOR.${denom.slice(2).toUpperCase()}`;
  if (denom.startsWith('thor.')) return denom.toUpperCase();
  if (!denom.includes('-')) return `THOR.${denom.toUpperCase()}`;
  const splitAt = denom.indexOf('-');
  return `${denom.slice(0, splitAt).toUpperCase()}.${denom.slice(splitAt + 1).toUpperCase()}`;
}

export function denomLabel(denom) {
  if (!denom) return '';
  if (denom === 'rune') return 'RUNE';
  if (denom.startsWith('x/')) return denom.slice(2).toUpperCase();
  const pool = denomToPoolAsset(denom);
  const dashAt = pool.indexOf('-');
  return dashAt === -1 ? pool : pool.slice(0, dashAt);
}

export function isStableDenom(denom) {
  return /(?:usdc|usdt|dai|gusd|usdp)/i.test(denom || '');
}

export function assetUsdPrice(denom, { runePriceUsd = 0, poolPrices = {} } = {}) {
  if (denom === 'rune') return runePriceUsd;
  const poolPrice = poolPrices[denomToPoolAsset(denom)];
  if (poolPrice) return poolPrice;
  return isStableDenom(denom) ? 1 : 0;
}

export function estimateUsd(balance, pricing) {
  return amountFromBase(balance.amount) * assetUsdPrice(balance.denom, pricing);
}

export function normalizeDenom(denom) {
  return String(denom || '').trim().toLowerCase();
}

export function summarizeInventoryBucket(rows) {
  const pricedUsd = rows.reduce((sum, row) => sum + (Number(row.usdValue) || 0), 0);
  return {
    rows,
    count: rows.length,
    pricedUsd,
    unpricedCount: rows.filter((row) => row.amount > 0 && !row.usdValue).length
  };
}

export function summarizeCollectorInventory(config, balanceRows, actionRows, pricing) {
  if (!Array.isArray(config?.target_denoms) || !Array.isArray(balanceRows)) return EMPTY_INVENTORY;
  const targetDenoms = new Set(config.target_denoms.map(([denom]) => normalizeDenom(denom)));
  const actionsAvailable = Array.isArray(actionRows);
  const actionDenoms = new Set((actionRows || []).map((action) => normalizeDenom(action?.denom)));
  const buckets = { eligible: [], conversion: [], blocked: [], unresolved: [] };

  for (const balance of balanceRows) {
    const amount = amountFromBase(balance.amount);
    if (!(amount > 0)) continue;
    const row = { ...balance, amount, usdValue: estimateUsd(balance, pricing) };
    const denom = normalizeDenom(balance.denom);
    if (targetDenoms.has(denom)) buckets.eligible.push(row);
    else if (!actionsAvailable) buckets.unresolved.push(row);
    else if (actionDenoms.has(denom)) buckets.conversion.push(row);
    else buckets.blocked.push(row);
  }

  const eligible = summarizeInventoryBucket(buckets.eligible);
  const conversion = summarizeInventoryBucket(buckets.conversion);
  const blocked = summarizeInventoryBucket(buckets.blocked);
  const unresolved = summarizeInventoryBucket(buckets.unresolved);
  return {
    available: true,
    actionsAvailable,
    eligible,
    conversion,
    blocked,
    unresolved,
    pricedUsd: eligible.pricedUsd + conversion.pricedUsd + blocked.pricedUsd + unresolved.pricedUsd
  };
}

export function inventoryDisplay(bucket) {
  if (!bucket?.count) return '—';
  if (bucket.pricedUsd > 0) return usd2.format(bucket.pricedUsd);
  return `${number2.format(bucket.count)} denom${bucket.count === 1 ? '' : 's'}`;
}

export function targetRatePerSecond(config, denom) {
  const target = (config?.target_denoms || [])
    .find(([targetDenom]) => normalizeDenom(targetDenom) === normalizeDenom(denom));
  return target ? amountFromBase(target[1]) : 0;
}

export function formatDataSource(source) {
  const value = String(source || '').trim();
  if (!value) return 'fallback artifact';
  if (value.includes('mixed')) return 'Dune + RPC/Midgard Postgres';
  if (value.includes('dune')) return 'Dune-backed Postgres';
  if (value.includes('postgres')) return 'RPC/Midgard-backed Postgres';
  if (value.includes('backend-chain-state')) return 'two-minute backend chain snapshots';
  if (value.includes('static')) return 'static artifact';
  return value.replaceAll('-', ' ');
}

export function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });
}

export function staticArtifactLabel(artifactMeta, label = 'static fallback artifact') {
  const generatedAt = artifactMeta?.generatedAt;
  return generatedAt ? `${label} generated ${formatDateTime(generatedAt)}` : label;
}

export function formatAssetAmount(balance) {
  const amount = amountFromBase(balance.amount);
  if (amount >= 1000) return number2.format(amount);
  if (amount >= 1) return number4.format(amount);
  return amount.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

export function formatWeekLabel(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function formatAddress(address) {
  return address ? `${address.slice(0, 10)}…${address.slice(-6)}` : '';
}

export function formatTxId(txId) {
  return txId ? `${txId.slice(0, 8)}…${txId.slice(-6)}` : '';
}

export function summarizeHistory(rows) {
  if (!rows.length) return 'history unavailable';
  return rows
    .map((row) => `${row.operation?.includes('INIT') ? 'init' : 'migrate'}:${row.code_id}`)
    .join(' → ');
}

export function targetSummary(targets) {
  return (targets || []).map((target) => `${target.percent.toFixed(0)}% → ${target.label}`).join('  ·  ');
}

export function getTargetsForConfig(collectorKey, config, { staticTargets, addressLabels }) {
  const targetRows = config?.target_addresses;
  if (!Array.isArray(targetRows) || !targetRows.length) {
    return (staticTargets[collectorKey] || []).map((target) => ({ ...target, isFallback: true }));
  }
  const totalWeight = targetRows.reduce((sum, [, weight]) => sum + Number(weight || 0), 0);
  return targetRows.map(([address, weight]) => ({
    address,
    label: addressLabels[address] || formatAddress(address),
    percent: totalWeight > 0 ? (Number(weight) / totalWeight) * 100 : 0,
    isFallback: false
  }));
}
