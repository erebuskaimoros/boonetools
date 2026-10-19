import { calendarDays, COMPARISON_METHODOLOGY, comparisonStartDay, contribution, DAY_MS, dayOf, dayTime, finite, monthlyComparison, nextDay, THORCHAIN_CORRECTED_FROM_DAY, THORCHAIN_LEGACY_METHOD } from '../../../shared/protocol-fee-comparison/model.js';
import { createChainflipReader } from './chainflip.js';
import { nearWalletDays } from './near.js';
import { collectNearNetSupply, NEAR_NET_SUPPLY_METHOD } from './near-net-supply.js';
import { LLAMA_API, LLAMA_COINS } from '../../../shared/external-providers.js';

export const WALLET_QUERY_ID = '8767542';
// Leave time for final persistence/publication before the service's 30m limit.
export const COMPARISON_MAX_RUN_MS = 20 * 60_000;
export function emptyComparisonCache() { return { version: 1, days: {}, boundaries: {} }; }

export function parseNearEmissions(html) {
  // Next's public server-rendered data. Decode JSON strings; never execute scripts.
  const chunks = [...html.matchAll(/self\.__next_f\.push\((\[1,"(?:[^"\\]|\\.)*"\])\)/g)]
    .map((match) => JSON.parse(match[1])[1]).join('');
  const texts = [html, chunks];
  for (const text of texts) {
    const match = text.match(/"emissionsDaily"\s*:\s*(\[[^\]]*\])/);
    if (match) {
      const rows = JSON.parse(match[1]);
      if (rows.length && rows.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && finite(row.value) !== null && row.value >= 0)) {
        const byDay = new Map(rows.map(row => [row.date, row]));
        // The same official dashboard publishes a cumulative year-to-date
        // series. Difference consecutive days only when its Jan 1 baseline
        // is present; never difference across a missing day or year reset.
        const cumulative = text.match(/"absoluteRevEmissions"\s*:\s*(\[[^\]]*\])/);
        if (cumulative) {
          const history = JSON.parse(cumulative[1]);
          let previous = 0, expected = history[0]?.date;
          if (expected?.endsWith('-01-01')) for (const point of history) {
            const value = finite(point.emissionsNear);
            if (point.date !== expected || value === null || value < previous) break;
            if (!byDay.has(point.date)) byDay.set(point.date, { date: point.date, value: value - previous });
            previous = value; expected = nextDay(point.date);
          }
        }
        return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
      }
    }
  }
  throw new Error('NEAR dashboard daily issuance model unavailable');
}

export function priceDays(payload) {
  const result = {};
  for (const [coin, series] of Object.entries(payload?.coins || {})) {
    result[coin] = {};
    for (const point of series.prices || []) {
      const midnight = Math.round(Number(point.timestamp) / 86400) * 86400;
      if (Math.abs(Number(point.timestamp) - midnight) > 4 * 3600 || !(finite(point.price) > 0)) continue;
      const day = dayOf(midnight * 1000);
      if (result[coin][day] !== undefined) throw new Error(`Duplicate historical price for ${coin} ${day}`);
      result[coin][day] = Number(point.price);
    }
  }
  return result;
}

export function deriveComparisonDay(day, raw = {}) {
  const earnings = raw.earnings;
  const runePrice = finite(earnings?.runePriceUSD);
  const feesRune = finite(earnings?.liquidityFees);
  const validRunePrice = runePrice > 0;
  const accounting = raw.rewardAccounting;
  const exact = accounting?.complete === true
    && accounting?.from === dayTime(day) / 1000 && accounting?.through === dayTime(nextDay(day)) / 1000
    && ['finalized-revshare-payouts', 'before-first-finalized-revshare-payout'].includes(accounting?.method);
  const unsignedAtomic = value => typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null;
  const feesAtomic = unsignedAtomic(String(earnings?.liquidityFees));
  const revshareAtomic = exact ? unsignedAtomic(accounting.revshareE8) : null;
  // Reserve emissions require their own explicit observation. Even after
  // adding back REVSHARE, Midgard's signed residual still contains accounting
  // differences: it is not a gross Reserve-emissions ledger.
  const emissionsAtomic = exact && accounting.emissionsComplete === true
    && accounting.emissionsMethod === 'historical-reserve-formula-v1' ? unsignedAtomic(accounting.reserveEmissionsE8) : null;
  const retainedAtomic = feesAtomic !== null && revshareAtomic !== null && feesAtomic >= revshareAtomic
    ? feesAtomic - revshareAtomic : null;
  const usd = atomic => validRunePrice && atomic !== null ? Number(atomic) / 1e8 * runePrice : null;
  // Preserve the old cached series as explicitly legacy display metadata only.
  // It must never fill canonical emissions or extend beyond the correction date.
  const reportedReward = String(earnings?.blockRewards);
  const reportedAtomic = /^-?\d+$/.test(reportedReward) ? BigInt(reportedReward) : null;
  const legacyIncome = usd(feesAtomic), legacyReward = usd(reportedAtomic);
  const legacyNet = feesAtomic !== null && reportedAtomic !== null ? usd(feesAtomic - reportedAtomic) : null;
  const legacy = day < THORCHAIN_CORRECTED_FROM_DAY && finite(legacyIncome) !== null
    && finite(legacyReward) !== null && finite(legacyNet) !== null
    ? { method: THORCHAIN_LEGACY_METHOD, incomeUsd: legacyIncome, reportedRewardUsd: legacyReward, netUsd: legacyNet } : null;
  const wallets = raw.wallets;
  const front = finite(wallets?.frontend_near), other = finite(wallets?.other_near);
  const nearRevenue = finite(raw.nearRevenue), nearPrice = finite(raw.nearPrice);
  // Exact supply change already includes all protocol burns. Do not subtract
  // a burn feed again, clamp deflation, or fall back to the old gross model.
  const nearIssuance = raw.nearNetIssuanceMethod === NEAR_NET_SUPPLY_METHOD
    && typeof raw.nearNetIssuanceAtomic === 'string' && /^-?\d+$/.test(raw.nearNetIssuanceAtomic)
    ? finite(Number(BigInt(raw.nearNetIssuanceAtomic)) / 1e24) : null;
  // dailyRevenue already includes the proprietary frontend, not third-party
  // distribution fees. Keep the full retained amount; split it for disclosure,
  // never add frontend receipts to that total a second time.
  const validWallets = front !== null && other !== null && front >= 0 && other >= 0;
  const nearIncome = nearRevenue !== null && nearRevenue >= 0 && validWallets
    && (front + other > 0 || nearRevenue === 0) ? nearRevenue : null;
  const frontendIncomeUsd = nearIncome === null ? null : front + other > 0 ? nearIncome * front / (front + other) : 0;
  const flipPrice = finite(raw.flipPrice);
  const flipTokens = raw.flipIssuance?.atomic !== undefined ? Number(BigInt(raw.flipIssuance.atomic)) / 1e18 : null;
  return { day,
    thorchain: { ...contribution(usd(retainedAtomic), usd(emissionsAtomic)),
      grossIncomeUsd: validRunePrice && feesRune !== null && feesRune >= 0 ? feesRune / 1e8 * runePrice : null,
      revshareUsd: retainedAtomic !== null ? usd(revshareAtomic) : null,
      ...(legacy ? { legacy } : {}) },
    near: { ...contribution(nearIncome, nearPrice > 0 && nearIssuance !== null ? nearPrice * nearIssuance : null),
      frontendIncomeUsd, otherIncomeUsd: nearIncome === null ? null : nearIncome - frontendIncomeUsd },
    chainflip: contribution(raw.chainflipRevenue, flipPrice > 0 && flipTokens !== null ? flipTokens * flipPrice : null)
  };
}

export function buildComparisonPayload(cache, { now = Date.now(), startDay = comparisonStartDay(now), errors = [], rewardAccounting = {} } = {}) {
  const endDay = dayOf(now);
  const daily = calendarDays(startDay, endDay).map(day => deriveComparisonDay(day,
    rewardAccounting[day] ? { ...cache.days[day], rewardAccounting: rewardAccounting[day] } : cache.days[day]));
  // Keep the existing common source-day endpoint while exact THORChain reward
  // accounting backfills. Missing canonical deductions stay null, not zero;
  // the separate legacy display history cannot change verified coverage.
  const throughDay = daily.findLast(row => row.thorchain.grossIncomeUsd !== null
    && row.near.netUsd !== null && row.chainflip.netUsd !== null)?.day;
  const months = throughDay ? monthlyComparison(daily, { startDay, endDay: nextDay(throughDay), now }) : [];
  const thorchainDays = daily.filter(row => throughDay && row.day <= throughDay && row.thorchain.grossIncomeUsd !== null);
  const observedDays = thorchainDays.filter(row => row.thorchain.netUsd !== null).length;
  const thorchainRewardAccounting = { complete: thorchainDays.length > 0 && observedDays === thorchainDays.length,
    observedDays, expectedDays: thorchainDays.length };
  return { schemaVersion: 1, asOf: new Date(now).toISOString(), fromDay: startDay,
    throughDay: throughDay || null, currency: 'USD', interval: 'month',
    // Missing historical accounting is coverage, not a delayed current source.
    // Retain the explicit monthly coverage flags and reward-accounting counts.
    stale: errors.length > 0 || !throughDay || nextDay(throughDay) < endDay,
    errors, months, daily: daily.filter(row => throughDay && row.day <= throughDay), methodology: COMPARISON_METHODOLOGY,
    chainflipIssuance: 'Historical on-chain emission amounts × finalized block counts; not net supply or a reported monthly pace.',
    nearAllocation: '100% of whole-chain NEAR net supply change (emissions minus all protocol burns, not just gas); retained Intents wallet-receipt income including its own frontend, excluding third-party payouts.',
    nearIssuanceMethod: NEAR_NET_SUPPLY_METHOD, thorchainRewardAccounting,
    nearWalletMethod: daysSourceMethod(cache, startDay, endDay, 'source', 'wallets', 'dune'),
    nearWalletSource: 'https://docs.fastnear.com/transfers/query' };
}

function daysSourceMethod(cache, startDay, endDay, key, field, fallback) {
  const methods = new Set(calendarDays(startDay, endDay).filter(day => cache.days[day]?.[field] != null)
    .map(day => (field === 'wallets' ? cache.days[day].wallets[key] : cache.days[day][key]) || fallback));
  return methods.size === 1 ? [...methods][0] : 'mixed';
}

/** Independent scheduler. Each source and finalized FLIP day is persisted before moving on. */
export async function collectComparison({ cache = emptyComparisonCache(), request, walletQuery, save = async () => {},
  now = Date.now(), startDay = comparisonStartDay(now), log = () => {}, chainflipReader, maxFlipDays = 400,
  nearNetSupplyReader = collectNearNetSupply, maxRunMs = COMPARISON_MAX_RUN_MS, clock = Date.now, rewardAccounting = {} } = {}) {
  if (cache.version !== 1) throw new Error('Unsupported protocol comparison cache');
  if (!(Number.isFinite(maxRunMs) && maxRunMs > 0)) throw new Error('Comparison runtime budget must be positive and finite');
  const endDay = dayOf(now), days = calendarDays(startDay, endDay);
  const errors = [];
  const controller = new AbortController(), deadline = clock() + maxRunMs;
  const budgetError = Object.assign(new Error('Collection runtime budget reached; remaining work is deferred to the next run.'),
    { code: 'COMPARISON_RUN_BUDGET', skipProvider: true });
  const timer = setTimeout(() => controller.abort(budgetError), maxRunMs);
  let deferred = false;
  function checkBudget() {
    if (clock() >= deadline && !controller.signal.aborted) controller.abort(budgetError);
    controller.signal.throwIfAborted();
  }
  const providerRequest = request;
  request = async (url, options = {}) => {
    checkBudget();
    // Await cancellation all the way through transport: do not race a promise
    // that could resume later and mutate a cache already returned/published.
    const result = await providerRequest(url, { ...options, signal: controller.signal });
    controller.signal.throwIfAborted();
    return result;
  };
  const checkpoint = () => save(cache, {
    ...buildComparisonPayload(cache, { now, startDay, rewardAccounting, errors: [...errors,
      'Source acquisition is in progress; displaying verified checkpoints.'] }),
    stale: true, acquisitionInProgress: true
  });
  const put = (day, fields) => { if (day >= startDay && day < endDay) cache.days[day] = { ...cache.days[day], ...fields }; };
  async function source(name, run) {
    try { checkBudget(); await run(); await checkpoint(); }
    catch (error) {
      if (error === budgetError || (controller.signal.aborted && error.name === 'AbortError')) { deferred = true; return; }
      errors.push(`${name}: ${error.message}`); log(errors.at(-1));
    }
  }
  const firstMissing = (field) => days.find((day) => cache.days[day]?.[field] == null)
    || [startDay, dayOf(now - 7 * DAY_MS)].sort().at(-1);
  try {
    await source('THORChain', async () => {
      const health = await request('/health', { service: 'midgard' });
      const watermark = Number(health?.lastAggregated?.timestamp);
      if (!(watermark > 0)) throw new Error('Missing aggregation watermark');
      for (let from = dayTime(firstMissing('earnings')); from < dayTime(endDay); from += 60 * DAY_MS) {
        const to = Math.min(from + 60 * DAY_MS, dayTime(endDay));
        const result = await request(`/history/earnings?interval=day&from=${from / 1000}&to=${to / 1000}`, { service: 'midgard' });
        if (!Array.isArray(result.intervals)) throw new Error('Missing daily earnings');
        for (const row of result.intervals) {
          if (Number(row.endTime) > watermark || Number(row.endTime) - Number(row.startTime) !== 86400) continue;
          put(dayOf(Number(row.startTime) * 1000), { earnings: { liquidityFees: row.liquidityFees, blockRewards: row.blockRewards, runePriceUSD: row.runePriceUSD } });
        }
        await checkpoint();
      }
    });
    for (const [slug, field] of [['chainflip-amm', 'chainflipRevenue'], ['near-intents', 'nearRevenue']]) {
      await source(slug, async () => {
        const result = await request(`${LLAMA_API}/summary/fees/${slug}?dataType=dailyRevenue`);
        if (!Array.isArray(result.totalDataChart) || !result.totalDataChart.length) throw new Error('Daily revenue unavailable');
        for (const [timestamp, value] of result.totalDataChart) if (finite(value) !== null && value >= 0) put(dayOf(timestamp * 1000), { [field]: Number(value) });
      });
    }
    await source('Historical prices', async () => {
      const fromDay = [firstMissing('nearPrice'), firstMissing('flipPrice')].sort()[0];
      for (let from = dayTime(fromDay); from < dayTime(endDay); from += 60 * DAY_MS) {
        const span = Math.min(60, (dayTime(endDay) - from) / DAY_MS);
        const result = priceDays(await request(`${LLAMA_COINS}/chart/coingecko:chainflip,coingecko:near?start=${from / 1000}&span=${span}&period=1d&searchWidth=4h`));
        for (const [coin, field] of [['coingecko:near', 'nearPrice'], ['coingecko:chainflip', 'flipPrice']]) {
          for (const [day, value] of Object.entries(result[coin] || {})) put(day, { [field]: value });
        }
        await checkpoint();
      }
    });
    await source('NEAR wallet attribution', async () => {
      // Retained as an injectable reconciliation source, not a production dependency.
      if (walletQuery) {
        const result = await walletQuery(WALLET_QUERY_ID, { start_date: firstMissing('wallets'), end_date: endDay });
        if (!Array.isArray(result.rows) || !result.rows.length) throw new Error('No wallet allocation rows returned');
        for (const row of result.rows) put(String(row.day).slice(0, 10), { wallets: { frontend_near: row.frontend_near, other_near: row.other_near, executionId: result.executionId } });
      } else {
        for (let from = firstMissing('wallets'); from < endDay;) {
          const to = [dayOf(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)), 1)), endDay].sort()[0];
          for (const { day, ...wallets } of await nearWalletDays(request, from, to)) put(day, { wallets });
          await checkpoint(); log(`NEAR fee wallets verified ${from}–${to}`); from = to;
        }
      }
    });
    await source('NEAR on-chain net supply', async () => {
      cache.nearSupplyBoundaries ||= {};
      const rows = await nearNetSupplyReader({ request, boundaries: cache.nearSupplyBoundaries, epochs: cache.nearEpochs || {}, startDay, endDay, log, save: checkpoint });
      for (const { day, ...row } of rows) put(day, row);
    });
    await source('Chainflip issuance', async () => {
      const reader = chainflipReader || createChainflipReader({ request, boundaries: cache.boundaries });
      // Keep current completed days fresh while the historical backfill catches up.
      const missing = days.filter((day) => !cache.days[day]?.flipIssuance).reverse();
      // Complete one finalized day at a time; failed/restarted backfills resume.
      for (const day of missing.slice(0, maxFlipDays)) {
        checkBudget();
        try {
          const issuance = await reader.issuance(day);
          put(day, { flipIssuance: issuance });
          cache.boundaries = reader.boundaries;
          await checkpoint();
          log(`Chainflip issuance verified ${day} (${issuance.start.height}–${issuance.end.height - 1})`);
        } catch (error) {
          if (error.code !== 'CHAINFLIP_RUNTIME_REVIEW') throw error;
          // An unreviewed older version must not starve later, reviewed days.
          const message = `Chainflip issuance: ${error.message}`;
          if (!errors.includes(message)) errors.push(message);
          log(`Chainflip issuance gap ${day}: ${error.message}`);
        }
      }
    });
    // A final unit may have completed at the deadline; retain it and stop cleanly.
    if (clock() >= deadline || controller.signal.aborted) deferred = true;
    const payload = { ...buildComparisonPayload(cache, { now, startDay, rewardAccounting,
      errors: deferred ? [...errors, budgetError.message] : errors }), acquisitionInProgress: false };
    await save(cache, payload);
    return { cache, payload, sourceErrors: errors, deferred };
  } finally { clearTimeout(timer); }
}
