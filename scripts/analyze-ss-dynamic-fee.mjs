#!/usr/bin/env node

import {
  getAffiliateActionLegCount,
  getAffiliateActionRouteVolumeUsd,
  midgardActionTimestampSeconds
} from '../shared/dynamic-fees/affiliate-volume.js';

const DAY_SECONDS = 24 * 60 * 60;
const MIDGARD_BASE = 'https://gateway.liquify.com/chain/thorchain_midgard/v2';
const AFFILIATE = 'ss';
const ANALYSIS_START = Date.parse('2026-01-27T00:00:00.000Z') / 1000;
const ANALYSIS_END = Date.parse('2026-07-27T00:00:00.000Z') / 1000;
const WARMUP_START = ANALYSIS_START - 90 * DAY_SECONDS;
const DYNAMIC_FEE_ACTIVE = Date.parse('2026-07-03T01:43:29.409Z') / 1000;
const HALT_START = Date.parse('2026-05-16T00:00:00.000Z') / 1000;
const HALT_END = Date.parse('2026-06-22T00:00:00.000Z') / 1000;
const HACKED_FUNDS_ADDRESS = '0xa6d623b871d8f5e17f1a774b19d4faffa348bdaa';
const EXCLUDED_THOR_ADDRESS = 'thor1wqg9cs2epr43aqy5e455hyyxk6qlpr6faxs780';
const PARTIAL_HALT_BOUNDARY_DAYS = new Set(['2026-05-15', '2026-06-22']);

function isoDay(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function ratioBps(feesUsd, volumeUsd) {
  return volumeUsd > 0 ? feesUsd / volumeUsd * 10_000 : null;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function fetchJson(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'x-client-id': 'BooneTools-analysis'
        }
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  throw lastError;
}

async function fetchAffiliateActions() {
  const actions = [];
  const seen = new Set();
  const seenTokens = new Set();
  let pageToken = '';
  let paginationComplete = false;

  for (let page = 0; page < 1_000; page += 1) {
    const params = new URLSearchParams({
      type: 'swap',
      affiliate: AFFILIATE,
      limit: '50'
    });
    if (pageToken) {
      params.set('prevPageToken', pageToken);
    } else {
      params.set('fromTimestamp', String(WARMUP_START));
      params.set('timestamp', String(ANALYSIS_END));
    }

    const payload = await fetchJson(`${MIDGARD_BASE}/actions?${params}`);
    const pageActions = Array.isArray(payload?.actions) ? payload.actions : [];
    let reachedUpperBound = false;
    for (const action of pageActions) {
      const timestamp = midgardActionTimestampSeconds(action?.date);
      if (timestamp >= ANALYSIS_END) reachedUpperBound = true;
      if (timestamp < WARMUP_START || timestamp >= ANALYSIS_END) continue;
      if (String(action?.status || '').toLowerCase() !== 'success') continue;
      const txId = String(action?.in?.[0]?.txID || action?.txID || '').toUpperCase();
      const identity = txId || `${action?.date || ''}:${action?.height || ''}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      actions.push(action);
    }

    const nextToken = String(payload?.meta?.prevPageToken || '');
    if (reachedUpperBound || !nextToken || pageActions.length === 0) {
      paginationComplete = true;
      break;
    }
    if (seenTokens.has(nextToken)) throw new Error('Midgard repeated a page token');
    seenTokens.add(nextToken);
    pageToken = nextToken;
  }

  if (!paginationComplete) throw new Error('Midgard actions pagination exceeded 1,000 pages');

  return actions.sort((left, right) => (
    midgardActionTimestampSeconds(left?.date) - midgardActionTimestampSeconds(right?.date)
  ));
}

async function fetchRunePrices() {
  const params = new URLSearchParams({
    interval: 'day',
    from: String(WARMUP_START),
    to: String(ANALYSIS_END)
  });
  const payload = await fetchJson(`${MIDGARD_BASE}/history/rune?${params}`);
  return new Map((payload?.intervals || []).map((row) => [
    String(row.startTime),
    safeNumber(row.runePriceUSD, null)
  ]));
}

async function fetchAffiliateEarnings() {
  const params = new URLSearchParams({
    thorname: AFFILIATE,
    interval: 'day',
    from: String(WARMUP_START),
    to: String(ANALYSIS_END)
  });
  const payload = await fetchJson(`${MIDGARD_BASE}/history/affiliate/earnings?${params}`);
  return Array.isArray(payload) ? payload : payload?.intervals || [];
}

function isHaltDay(timestamp) {
  return timestamp >= HALT_START && timestamp < HALT_END;
}

function normalizeSender(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeAsset(value) {
  return String(value || '').trim().toUpperCase();
}

function inboundCoin(action) {
  return action?.in?.[0]?.coins?.[0] || null;
}

function outboundCoin(action) {
  const streamingOut = action?.metadata?.swap?.streamingSwapMeta?.outCoin;
  if (streamingOut?.asset) return streamingOut;

  const sourceAsset = normalizeAsset(inboundCoin(action)?.asset);
  const candidates = (Array.isArray(action?.out) ? action.out : [])
    .filter((leg) => !leg?.affiliate)
    .flatMap((leg) => Array.isArray(leg?.coins) ? leg.coins : [])
    .filter((coin) => coin?.asset);
  return candidates.find((coin) => normalizeAsset(coin.asset) !== sourceAsset) ||
    candidates[0] ||
    null;
}

function dominantAffiliate(action) {
  const swap = action?.metadata?.swap || {};
  const affiliates = String(swap.affiliateAddress || '')
    .split('/')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const fees = String(swap.affiliateFee || '')
    .split('/')
    .map((value) => safeNumber(value));
  if (!affiliates.length) return '';

  let dominantIndex = 0;
  for (let index = 1; index < affiliates.length; index += 1) {
    if ((fees[index] || 0) > (fees[dominantIndex] || 0)) dominantIndex = index;
  }
  return affiliates[dominantIndex];
}

function isL1Endpoint(asset) {
  const raw = normalizeAsset(asset);
  return raw.includes('.') && !raw.includes('/') && !raw.includes('~');
}

function isDynamicFeeEligibleAction(action, inputAsset, outputAsset) {
  return dominantAffiliate(action) === AFFILIATE &&
    isL1Endpoint(inputAsset) &&
    isL1Endpoint(outputAsset);
}

function actionExclusions(action, timestamp) {
  const sender = normalizeSender(action?.in?.[0]?.address);
  return [
    ...(isHaltDay(Math.floor(timestamp / DAY_SECONDS) * DAY_SECONDS) ? ['chain-halt'] : []),
    ...(sender === HACKED_FUNDS_ADDRESS ? ['hacked-funds-address'] : []),
    ...(sender === EXCLUDED_THOR_ADDRESS ? ['excluded-thor-address'] : [])
  ];
}

function normalizeActions(actions, runePriceByDay) {
  return actions.map((action) => {
    const timestamp = midgardActionTimestampSeconds(action?.date);
    const dayStart = Math.floor(timestamp / DAY_SECONDS) * DAY_SECONDS;
    const runePriceUsd = runePriceByDay.get(String(dayStart));
    if (!(runePriceUsd > 0)) {
      throw new Error(`Missing RUNE/USD price for ${isoDay(dayStart)}`);
    }
    const routeVolumeUsd = getAffiliateActionRouteVolumeUsd(action);
    const executedLegCount = getAffiliateActionLegCount(action);
    const feeRune = safeNumber(action?.metadata?.swap?.liquidityFee) / 1e8;
    const sender = String(action?.in?.[0]?.address || '');
    const txId = String(action?.in?.[0]?.txID || action?.txID || '');
    const exclusions = actionExclusions(action, timestamp);
    const inputAsset = String(inboundCoin(action)?.asset || '');
    const outputAsset = String(outboundCoin(action)?.asset || '');
    const routeKey = [inputAsset, outputAsset].sort().join(' | ');

    return {
      timestamp,
      time: new Date(timestamp * 1000).toISOString(),
      dayStart,
      day: isoDay(dayStart),
      txId,
      height: safeNumber(action?.height),
      sender,
      status: String(action?.status || '').toLowerCase(),
      inputAsset,
      outputAsset,
      routeKey,
      dynamicFeeEligible: isDynamicFeeEligibleAction(action, inputAsset, outputAsset),
      routeVolumeUsd,
      executedLegCount,
      volumeUsd: routeVolumeUsd * executedLegCount,
      feeRune,
      runePriceUsd,
      feeUsd: feeRune * runePriceUsd,
      exclusions
    };
  });
}

function createDailyRows(actionRows) {
  const rows = [];
  const byDay = new Map();

  for (let timestamp = WARMUP_START; timestamp < ANALYSIS_END; timestamp += DAY_SECONDS) {
    const row = {
      timestamp,
      day: isoDay(timestamp),
      halt: isHaltDay(timestamp),
      raw: { routes: 0, legs: 0, volumeUsd: 0, feesUsd: 0, feesRune: 0 },
      curated: { routes: 0, legs: 0, volumeUsd: 0, feesUsd: 0, feesRune: 0 },
      exclusions: { routes: 0, volumeUsd: 0, feesUsd: 0 }
    };
    rows.push(row);
    byDay.set(timestamp, row);
  }

  for (const action of actionRows) {
    const day = byDay.get(action.dayStart);
    if (!day) continue;
    day.raw.routes += 1;
    day.raw.legs += action.executedLegCount;
    day.raw.volumeUsd += action.volumeUsd;
    day.raw.feesUsd += action.feeUsd;
    day.raw.feesRune += action.feeRune;
    if (action.exclusions.length === 0) {
      day.curated.routes += 1;
      day.curated.legs += action.executedLegCount;
      day.curated.volumeUsd += action.volumeUsd;
      day.curated.feesUsd += action.feeUsd;
      day.curated.feesRune += action.feeRune;
    } else {
      day.exclusions.routes += 1;
      day.exclusions.volumeUsd += action.volumeUsd;
      day.exclusions.feesUsd += action.feeUsd;
    }
  }

  for (let index = 0; index < rows.length; index += 1) {
    rows[index].raw.rateBps = ratioBps(rows[index].raw.feesUsd, rows[index].raw.volumeUsd);
    rows[index].curated.rateBps = ratioBps(
      rows[index].curated.feesUsd,
      rows[index].curated.volumeUsd
    );

    for (const windowDays of [30, 90]) {
      const window = rows.slice(Math.max(0, index - windowDays + 1), index + 1);
      const curatedWindow = window.filter((row) => !row.halt);
      const windowComplete = window.length === windowDays;
      rows[index].raw[`rolling${windowDays}dVolumeUsd`] = windowComplete
        ? window.reduce((sum, row) => sum + row.raw.volumeUsd, 0) / windowDays
        : null;
      rows[index].curated[`rolling${windowDays}dVolumeUsd`] = windowComplete && !rows[index].halt
        ? curatedWindow.reduce((sum, row) => sum + row.curated.volumeUsd, 0) /
          curatedWindow.length
        : null;
      rows[index].curated[`rolling${windowDays}dEligibleDays`] = curatedWindow.length;
    }
  }

  return rows;
}

function aggregateActions(rows, predicate = () => true) {
  const selected = rows.filter(predicate);
  const volumeUsd = selected.reduce((sum, row) => sum + row.volumeUsd, 0);
  const feesUsd = selected.reduce((sum, row) => sum + row.feeUsd, 0);
  const feesRune = selected.reduce((sum, row) => sum + row.feeRune, 0);
  return {
    routes: selected.length,
    legs: selected.reduce((sum, row) => sum + row.executedLegCount, 0),
    volumeUsd,
    feesUsd,
    feesRune,
    rateBps: ratioBps(feesUsd, volumeUsd)
  };
}

function aggregateDays(rows, mode, predicate = () => true) {
  const selected = rows.filter(predicate);
  const eligible = mode === 'curated' ? selected.filter((row) => !row.halt) : selected;
  const volumeUsd = eligible.reduce((sum, row) => sum + row[mode].volumeUsd, 0);
  const feesUsd = eligible.reduce((sum, row) => sum + row[mode].feesUsd, 0);
  const feesRune = eligible.reduce((sum, row) => sum + row[mode].feesRune, 0);
  return {
    calendarDays: selected.length,
    eligibleDays: eligible.length,
    activeDays: eligible.filter((row) => row[mode].routes > 0).length,
    routes: eligible.reduce((sum, row) => sum + row[mode].routes, 0),
    legs: eligible.reduce((sum, row) => sum + row[mode].legs, 0),
    volumeUsd,
    feesUsd,
    feesRune,
    rateBps: ratioBps(feesUsd, volumeUsd),
    avgDailyVolumeUsd: eligible.length ? volumeUsd / eligible.length : 0,
    avgDailyFeesUsd: eligible.length ? feesUsd / eligible.length : 0,
    medianDailyVolumeUsd: median(eligible.map((row) => row[mode].volumeUsd))
  };
}

function summarizePeriod(dailyRows, start, end) {
  const predicate = (row) => row.timestamp >= start && row.timestamp < end;
  return {
    start: new Date(start * 1000).toISOString(),
    end: new Date(end * 1000).toISOString(),
    raw: aggregateDays(dailyRows, 'raw', predicate),
    curated: aggregateDays(dailyRows, 'curated', predicate)
  };
}

function monthlySummary(dailyRows) {
  const months = new Map();
  for (const row of dailyRows.filter((item) => item.timestamp >= ANALYSIS_START)) {
    const month = row.day.slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(row);
  }
  return [...months.entries()].map(([month, rows]) => ({
    month,
    raw: aggregateDays(rows, 'raw'),
    curated: aggregateDays(rows, 'curated')
  }));
}

function equalWindowSummary(dailyRows, { excludePartialHaltBoundaries = false } = {}) {
  const postStart = Date.parse('2026-07-04T00:00:00.000Z') / 1000;
  const postEnd = ANALYSIS_END;
  const postRows = dailyRows.filter((row) => row.timestamp >= postStart && row.timestamp < postEnd);
  const eligiblePreRows = dailyRows.filter((row) => (
    row.timestamp >= ANALYSIS_START &&
    row.timestamp < Date.parse('2026-07-03T00:00:00.000Z') / 1000 &&
    !row.halt &&
    (!excludePartialHaltBoundaries || !PARTIAL_HALT_BOUNDARY_DAYS.has(row.day))
  ));
  const preRows = eligiblePreRows.slice(-postRows.length);
  const preStart = preRows[0]?.timestamp || 0;
  const preEnd = (preRows.at(-1)?.timestamp || 0) + DAY_SECONDS;
  return {
    eligibleDayCount: postRows.length,
    excludedPartialHaltBoundaries: excludePartialHaltBoundaries
      ? [...PARTIAL_HALT_BOUNDARY_DAYS]
      : [],
    pre: {
      firstEligibleDay: preRows[0]?.day || null,
      lastEligibleDay: preRows.at(-1)?.day || null,
      calendarSpanStart: new Date(preStart * 1000).toISOString(),
      calendarSpanEnd: new Date(preEnd * 1000).toISOString(),
      raw: aggregateDays(preRows, 'raw'),
      curated: aggregateDays(preRows, 'curated')
    },
    post: {
      firstEligibleDay: postRows[0]?.day || null,
      lastEligibleDay: postRows.at(-1)?.day || null,
      calendarSpanStart: new Date(postStart * 1000).toISOString(),
      calendarSpanEnd: new Date(postEnd * 1000).toISOString(),
      raw: aggregateDays(postRows, 'raw'),
      curated: aggregateDays(postRows, 'curated')
    }
  };
}

function pairComparison(actionRows) {
  const preEligibleDays = new Set();
  const allDays = [];
  for (let timestamp = ANALYSIS_START; timestamp < Date.parse('2026-07-03T00:00:00.000Z') / 1000; timestamp += DAY_SECONDS) {
    if (!isHaltDay(timestamp)) allDays.push(timestamp);
  }
  for (const timestamp of allDays.slice(-23)) preEligibleDays.add(timestamp);
  const postStart = Date.parse('2026-07-04T00:00:00.000Z') / 1000;
  const grouped = new Map();

  for (const row of actionRows) {
    if (row.exclusions.length > 0 || row.timestamp < ANALYSIS_START || row.timestamp >= ANALYSIS_END) continue;
    const period = preEligibleDays.has(row.dayStart)
      ? 'pre'
      : row.timestamp >= postStart
        ? 'post'
        : null;
    if (!period) continue;
    if (!grouped.has(row.routeKey)) grouped.set(row.routeKey, { routeKey: row.routeKey, pre: [], post: [] });
    grouped.get(row.routeKey)[period].push(row);
  }

  return [...grouped.values()]
    .map((group) => ({
      routeKey: group.routeKey,
      pre: aggregateActions(group.pre),
      post: aggregateActions(group.post)
    }))
    .map((group) => ({
      ...group,
      changes: {
        volumePct: pctChange(group.post.volumeUsd, group.pre.volumeUsd),
        feesPct: pctChange(group.post.feesUsd, group.pre.feesUsd),
        rateBpsChange: group.post.rateBps !== null && group.pre.rateBps !== null
          ? group.post.rateBps - group.pre.rateBps
          : null
      }
    }))
    .sort((left, right) => right.post.volumeUsd - left.post.volumeUsd || right.pre.volumeUsd - left.pre.volumeUsd);
}

function matchedPairCounterfactual(pairRows, postTotalVolumeUsd) {
  const matched = pairRows.filter((row) => row.pre.volumeUsd > 0 && row.post.volumeUsd > 0);
  const postVolumeUsd = matched.reduce((sum, row) => sum + row.post.volumeUsd, 0);
  const observedPostFeesUsd = matched.reduce((sum, row) => sum + row.post.feesUsd, 0);
  const counterfactualPostFeesAtPrePairRatesUsd = matched.reduce((sum, row) => (
    sum + row.post.volumeUsd * row.pre.rateBps / 10_000
  ), 0);
  return {
    matchedPairCount: matched.length,
    postVolumeUsd,
    postVolumeCoveragePct: postTotalVolumeUsd
      ? postVolumeUsd / postTotalVolumeUsd * 100
      : null,
    observedPostFeesUsd,
    observedPostRateBps: ratioBps(observedPostFeesUsd, postVolumeUsd),
    counterfactualPostFeesAtPrePairRatesUsd,
    counterfactualPostRateBps: ratioBps(counterfactualPostFeesAtPrePairRatesUsd, postVolumeUsd),
    observedVsCounterfactualFeesPct: counterfactualPostFeesAtPrePairRatesUsd
      ? (observedPostFeesUsd / counterfactualPostFeesAtPrePairRatesUsd - 1) * 100
      : null
  };
}

function pctChange(after, before) {
  return before ? (after / before - 1) * 100 : null;
}

function comparisonChanges(comparison) {
  const result = {};
  for (const mode of ['raw', 'curated']) {
    const before = comparison.pre[mode];
    const after = comparison.post[mode];
    result[mode] = {
      totalVolumePct: pctChange(after.volumeUsd, before.volumeUsd),
      avgDailyVolumePct: pctChange(after.avgDailyVolumeUsd, before.avgDailyVolumeUsd),
      totalFeesPct: pctChange(after.feesUsd, before.feesUsd),
      avgDailyFeesPct: pctChange(after.avgDailyFeesUsd, before.avgDailyFeesUsd),
      feeRatePct: pctChange(after.rateBps, before.rateBps),
      feeRateBpsChange: after.rateBps - before.rateBps,
      routeCountPct: pctChange(after.routes, before.routes)
    };
  }
  return result;
}

function earningsReconciliation(actionRows, earningsRows, runePriceByDay) {
  const scopedActions = actionRows.filter((row) => (
    row.timestamp >= ANALYSIS_START && row.timestamp < ANALYSIS_END
  ));
  const actionFeesRune = scopedActions.reduce((sum, row) => sum + row.feeRune, 0);
  let earningsFeesRune = 0;
  let earningsFeesUsdHistorical = 0;
  let earningsRoutes = 0;
  for (const row of earningsRows) {
    const startTime = safeNumber(row?.startTime);
    if (startTime < ANALYSIS_START || startTime >= ANALYSIS_END) continue;
    const affiliate = (row?.affiliates || []).find((entry) => (
      String(entry?.affiliate || '').toLowerCase() === AFFILIATE
    ));
    if (!affiliate) continue;
    const feeRune = safeNumber(affiliate.earningsRUNE) / 1e8;
    earningsFeesRune += feeRune;
    earningsRoutes += safeNumber(affiliate.count);
    earningsFeesUsdHistorical += feeRune * safeNumber(runePriceByDay.get(String(startTime)));
  }
  return {
    actionRoutes: scopedActions.length,
    earningsRoutes,
    actionFeesRune,
    earningsFeesRune,
    feesRuneDifference: actionFeesRune - earningsFeesRune,
    feesRuneRelativeDifferencePct: earningsFeesRune
      ? (actionFeesRune / earningsFeesRune - 1) * 100
      : null,
    actionFeesUsdHistorical: scopedActions.reduce((sum, row) => sum + row.feeUsd, 0),
    earningsFeesUsdHistorical
  };
}

function exclusionSummary(actionRows) {
  const scoped = actionRows.filter((row) => (
    row.timestamp >= ANALYSIS_START && row.timestamp < ANALYSIS_END
  ));
  const reasons = ['chain-halt', 'hacked-funds-address', 'excluded-thor-address'];
  const byReason = Object.fromEntries(reasons.map((reason) => [
    reason,
    aggregateActions(scoped, (row) => row.exclusions.includes(reason))
  ]));
  const excludedUnion = aggregateActions(scoped, (row) => row.exclusions.length > 0);
  const addressTransactions = scoped
    .filter((row) => row.exclusions.some((reason) => reason.endsWith('address')))
    .map((row) => ({
      time: row.time,
      txId: row.txId,
      height: row.height,
      sender: row.sender,
      inputAsset: row.inputAsset,
      outputAsset: row.outputAsset,
      executedLegCount: row.executedLegCount,
      volumeUsd: row.volumeUsd,
      feesUsd: row.feeUsd,
      feesRune: row.feeRune,
      exclusions: row.exclusions
    }));
  return { byReason, excludedUnion, addressTransactions };
}

function markdownNumber(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function printDailyMarkdown(rows) {
  console.log('| Date (UTC) | Raw volume | Raw fees | Raw fee/volume | Raw 30d avg volume | Raw 90d avg volume | Curated volume | Curated fees | Curated fee/volume | Curated 30d avg volume | Curated 90d avg volume | Exclusion |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const row of rows.filter((item) => item.timestamp >= ANALYSIS_START)) {
    const exclusion = row.halt
      ? 'chain halt'
      : row.exclusions.routes > 0
        ? `${row.exclusions.routes} excluded route${row.exclusions.routes === 1 ? '' : 's'}`
        : '';
    console.log([
      `| ${row.day}`,
      `$${markdownNumber(row.raw.volumeUsd)}`,
      `$${markdownNumber(row.raw.feesUsd)}`,
      row.raw.rateBps === null ? '—' : `${markdownNumber(row.raw.rateBps, 3)} bps`,
      `$${markdownNumber(row.raw.rolling30dVolumeUsd)}`,
      `$${markdownNumber(row.raw.rolling90dVolumeUsd)}`,
      row.halt ? 'excluded' : `$${markdownNumber(row.curated.volumeUsd)}`,
      row.halt ? 'excluded' : `$${markdownNumber(row.curated.feesUsd)}`,
      row.halt ? 'excluded' : row.curated.rateBps === null ? '—' : `${markdownNumber(row.curated.rateBps, 3)} bps`,
      row.halt ? '—' : `$${markdownNumber(row.curated.rolling30dVolumeUsd)}`,
      row.halt ? '—' : `$${markdownNumber(row.curated.rolling90dVolumeUsd)}`,
      `${exclusion} |`
    ].join(' | '));
  }
}

async function main() {
  const [actions, runePriceByDay, earningsRows] = await Promise.all([
    fetchAffiliateActions(),
    fetchRunePrices(),
    fetchAffiliateEarnings()
  ]);
  const actionRows = normalizeActions(actions, runePriceByDay);
  const dailyRows = createDailyRows(actionRows);
  if (process.argv.includes('--daily-markdown')) {
    printDailyMarkdown(dailyRows);
    return;
  }
  if (process.argv.includes('--daily-json')) {
    console.log(JSON.stringify(
      dailyRows
        .filter((row) => row.timestamp >= ANALYSIS_START)
        .map((row) => ({
          day: row.day,
          halt: row.halt,
          rawVolumeUsd: row.raw.volumeUsd,
          rawFeesUsd: row.raw.feesUsd,
          rawRateBps: row.raw.rateBps,
          rawRolling30dVolumeUsd: row.raw.rolling30dVolumeUsd,
          rawRolling90dVolumeUsd: row.raw.rolling90dVolumeUsd,
          curatedVolumeUsd: row.curated.volumeUsd,
          curatedFeesUsd: row.curated.feesUsd,
          curatedRateBps: row.curated.rateBps,
          curatedRolling30dVolumeUsd: row.curated.rolling30dVolumeUsd,
          curatedRolling30dEligibleDays: row.curated.rolling30dEligibleDays,
          curatedRolling90dVolumeUsd: row.curated.rolling90dVolumeUsd,
          curatedRolling90dEligibleDays: row.curated.rolling90dEligibleDays,
          excludedRoutes: row.exclusions.routes
        })),
      null,
      2
    ));
    return;
  }

  const analysisRows = dailyRows.filter((row) => row.timestamp >= ANALYSIS_START);
  const exactPre = aggregateActions(actionRows, (row) => (
    row.timestamp >= ANALYSIS_START && row.timestamp < DYNAMIC_FEE_ACTIVE
  ));
  const exactPost = aggregateActions(actionRows, (row) => (
    row.timestamp >= DYNAMIC_FEE_ACTIVE && row.timestamp < ANALYSIS_END
  ));
  const exactPreCurated = aggregateActions(actionRows, (row) => (
    row.timestamp >= ANALYSIS_START &&
    row.timestamp < DYNAMIC_FEE_ACTIVE &&
    row.exclusions.length === 0
  ));
  const exactPostCurated = aggregateActions(actionRows, (row) => (
    row.timestamp >= DYNAMIC_FEE_ACTIVE &&
    row.timestamp < ANALYSIS_END &&
    row.exclusions.length === 0
  ));
  const equalWindow = equalWindowSummary(dailyRows);
  equalWindow.changes = comparisonChanges(equalWindow);
  const fullExposureSensitivity = equalWindowSummary(dailyRows, {
    excludePartialHaltBoundaries: true
  });
  fullExposureSensitivity.changes = comparisonChanges(fullExposureSensitivity);
  const pairRows = pairComparison(actionRows);

  const output = {
    generatedAt: new Date().toISOString(),
    scope: {
      affiliate: AFFILIATE,
      analysisStart: new Date(ANALYSIS_START * 1000).toISOString(),
      analysisEndExclusive: new Date(ANALYSIS_END * 1000).toISOString(),
      warmupStart: new Date(WARMUP_START * 1000).toISOString(),
      dynamicFeeActive: new Date(DYNAMIC_FEE_ACTIVE * 1000).toISOString(),
      haltStart: new Date(HALT_START * 1000).toISOString(),
      haltEndExclusive: new Date(HALT_END * 1000).toISOString(),
      excludedAddresses: [HACKED_FUNDS_ADDRESS, EXCLUDED_THOR_ADDRESS],
      volumeBasis: 'executed-leg-usd',
      feeBasis: 'Midgard whole-route liquidityFee in RUNE x daily historical RUNE/USD'
    },
    reconciliation: earningsReconciliation(actionRows, earningsRows, runePriceByDay),
    sixMonth: {
      raw: aggregateDays(analysisRows, 'raw'),
      curated: aggregateDays(analysisRows, 'curated')
    },
    exclusions: exclusionSummary(actionRows),
    exactActivationSplit: {
      pre: { raw: exactPre, curated: exactPreCurated },
      post: { raw: exactPost, curated: exactPostCurated }
    },
    dynamicFeeEligibility: {
      definition: 'dominant affiliate is ss and both route endpoints use L1 asset notation',
      postActivation: {
        raw: aggregateActions(actionRows, (row) => (
          row.timestamp >= DYNAMIC_FEE_ACTIVE &&
          row.timestamp < ANALYSIS_END &&
          row.dynamicFeeEligible
        )),
        curated: aggregateActions(actionRows, (row) => (
          row.timestamp >= DYNAMIC_FEE_ACTIVE &&
          row.timestamp < ANALYSIS_END &&
          row.dynamicFeeEligible &&
          row.exclusions.length === 0
        ))
      },
      postFullUtcDays: {
        raw: aggregateActions(actionRows, (row) => (
          row.timestamp >= Date.parse('2026-07-04T00:00:00.000Z') / 1000 &&
          row.timestamp < ANALYSIS_END &&
          row.dynamicFeeEligible
        )),
        curated: aggregateActions(actionRows, (row) => (
          row.timestamp >= Date.parse('2026-07-04T00:00:00.000Z') / 1000 &&
          row.timestamp < ANALYSIS_END &&
          row.dynamicFeeEligible &&
          row.exclusions.length === 0
        ))
      }
    },
    fullUtcDayPeriods: {
      pre: summarizePeriod(
        dailyRows,
        ANALYSIS_START,
        Date.parse('2026-07-03T00:00:00.000Z') / 1000
      ),
      transitionDay: summarizePeriod(
        dailyRows,
        Date.parse('2026-07-03T00:00:00.000Z') / 1000,
        Date.parse('2026-07-04T00:00:00.000Z') / 1000
      ),
      post: summarizePeriod(
        dailyRows,
        Date.parse('2026-07-04T00:00:00.000Z') / 1000,
        ANALYSIS_END
      )
    },
    equalEligibleDayComparison: equalWindow,
    equalFullExposureDaySensitivity: fullExposureSensitivity,
    equalEligibleDayPairComparisonCurated: pairRows,
    matchedPairCounterfactualCurated: matchedPairCounterfactual(
      pairRows,
      equalWindow.post.curated.volumeUsd
    ),
    monthly: monthlySummary(dailyRows),
    rollingSnapshots: analysisRows
      .filter((row) => [
        '2026-01-27',
        '2026-01-31',
        '2026-02-28',
        '2026-03-31',
        '2026-04-24',
        '2026-04-30',
        '2026-05-15',
        '2026-06-22',
        '2026-06-30',
        '2026-07-02',
        '2026-07-03',
        '2026-07-04',
        '2026-07-22',
        '2026-07-23',
        '2026-07-26'
      ].includes(row.day))
      .map((row) => ({
        day: row.day,
        halt: row.halt,
        rawVolumeUsd: row.raw.volumeUsd,
        rawFeesUsd: row.raw.feesUsd,
        rawRateBps: row.raw.rateBps,
        rawRolling30dVolumeUsd: row.raw.rolling30dVolumeUsd,
        rawRolling90dVolumeUsd: row.raw.rolling90dVolumeUsd,
        curatedVolumeUsd: row.curated.volumeUsd,
        curatedFeesUsd: row.curated.feesUsd,
        curatedRateBps: row.curated.rateBps,
        curatedRolling30dVolumeUsd: row.curated.rolling30dVolumeUsd,
        curatedRolling30dEligibleDays: row.curated.rolling30dEligibleDays,
        curatedRolling90dVolumeUsd: row.curated.rolling90dVolumeUsd,
        curatedRolling90dEligibleDays: row.curated.rolling90dEligibleDays,
        excludedRoutes: row.exclusions.routes
      }))
  };

  console.log(JSON.stringify(output, null, 2));
}

await main();
