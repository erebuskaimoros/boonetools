#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIDGARD_BASES = process.env.MIDGARD_BASES
  ? process.env.MIDGARD_BASES.split(",").map((base) => base.trim()).filter(Boolean)
  : ["https://gateway.liquify.com/chain/thorchain_midgard"];
const THORNODE_BASES = process.env.THORNODE_BASES
  ? process.env.THORNODE_BASES.split(",").map((base) => base.trim()).filter(Boolean)
  : ["https://gateway.liquify.com/chain/thorchain_api"];
const RPC_BASES = process.env.RPC_BASES
  ? process.env.RPC_BASES.split(",").map((base) => base.trim()).filter(Boolean)
  : ["https://gateway.liquify.com/chain/thorchain_rpc"];

const BASE_LAYER_REVENUE_COLLECTOR =
  "thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr";
const RUJI_SWAP_REVENUE_COLLECTOR =
  "thor1mcy9jtp4kzl8q2lvdgfgsl8jvqrf504uphkf0pz2p9wud8tsntesjvccew";
const RUJIRA_THORCHAIN_SWAP_CONTRACT =
  "thor1n5a08r0zvmqca39ka2tgwlkjy9ugalutk7fjpzptfppqcccnat2ska5t4g";

const WEBSITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(WEBSITE_ROOT, "docs/rujira-base-layer-fees");
const WEBSITE_OUTPUT_DIR = path.join(WEBSITE_ROOT, "public/data/rujira-base-layer-fees");

const CLIENT_HEADERS = {
  accept: "application/json",
  "user-agent": "boonetools-rujira-app-layer-swap-fees/1.0",
  "x-client-id": "RuneTools",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, { headers: CLIENT_HEADERS });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 180)}`);
      }
      return text;
    } catch (err) {
      lastError = err;
      await sleep(350 * attempt);
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastError?.message || lastError}`);
}

async function fetchJson(url, attempts = 3) {
  const text = await fetchText(url, attempts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${String(text).slice(0, 180)}`);
  }
}

function queryUrl(base, params = {}) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function fetchJsonFromBases(bases, pathname, params = {}) {
  let lastError;
  for (const base of bases) {
    const url = queryUrl(`${base}${pathname}`, params);
    try {
      return await fetchJson(url);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`Failed to fetch ${pathname}`);
}

async function fetchMidgardJson(pathname, params = {}) {
  return fetchJsonFromBases(MIDGARD_BASES, pathname, params);
}

async function fetchRpcJson(pathname, params = {}) {
  return fetchJsonFromBases(RPC_BASES, pathname, params);
}

async function fetchSmart(contract, query) {
  const encoded = Buffer.from(JSON.stringify(query)).toString("base64");
  const payload = await fetchJsonFromBases(
    THORNODE_BASES,
    `/cosmwasm/wasm/v1/contract/${contract}/smart/${encoded}`,
  );
  return payload.data;
}

function getAttr(event, key) {
  return event.attributes?.find((attr) => attr.key === key)?.value;
}

function parseDateNs(ns) {
  return new Date(Number(BigInt(ns) / 1_000_000n));
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function startOfUtcWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + mondayOffset);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function baseRuneToNumber(value) {
  return Number(BigInt(value)) / 1e8;
}

function numberToCsv(value) {
  return Number(value).toFixed(8).replace(/\.?0+$/, "");
}

function roundNumber(value, decimals = 8) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv(rows, headers) {
  return [
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((header) => {
          const value = row[header];
          return typeof value === "number" ? numberToCsv(value) : csvEscape(value);
        })
        .join(","),
    ),
  ].join("\n");
}

async function fetchCollectorActionConfig() {
  const payload = await fetchSmart(BASE_LAYER_REVENUE_COLLECTOR, { actions: {} });
  const actions = Array.isArray(payload?.actions) ? payload.actions : [];
  const byDenom = new Map();
  for (const action of actions) {
    byDenom.set(action.denom, {
      denom: action.denom,
      contract: action.contract,
      min: action.min,
      max: action.max,
      msg: action.msg,
    });
  }
  return { actions, byDenom };
}

async function fetchRevenueRunActions() {
  const actions = [];
  let nextPageToken = "";
  for (;;) {
    const payload = await fetchMidgardJson("/v2/actions", {
      address: BASE_LAYER_REVENUE_COLLECTOR,
      limit: 50,
      nextPageToken,
    });
    if (!Array.isArray(payload.actions)) {
      throw new Error("Unexpected Midgard actions response");
    }
    actions.push(...payload.actions);
    nextPageToken = payload.meta?.nextPageToken || "";
    if (!nextPageToken) break;
    await sleep(120);
  }

  return actions
    .filter((action) => action.type === "contract")
    .filter(
      (action) =>
        action.metadata?.contract?.contractType === "wasm-rujira-revenue/run",
    )
    .map((action) => ({
      height: Number(action.height),
      date: parseDateNs(action.date),
      denom: action.metadata?.contract?.attributes?.denom || "",
      midgardType: action.type,
      status: action.status || "",
    }))
    .filter((action) => Number.isFinite(action.height) && action.height > 0)
    .sort((a, b) => a.height - b.height);
}

function collectRevenueRuns(events, collector) {
  return events
    .filter((event) => event.type === "wasm-rujira-revenue/run")
    .filter((event) => getAttr(event, "_contract_address") === collector)
    .map((event) => ({
      denom: getAttr(event, "denom") || "",
      mode: getAttr(event, "mode") || "",
      msgIndex: getAttr(event, "msg_index") || "",
    }));
}

function collectThorchainSwapMemos(events) {
  return events
    .filter((event) => event.type === "wasm-rujira-thorchain-swap/swap")
    .filter((event) => getAttr(event, "_contract_address") === RUJIRA_THORCHAIN_SWAP_CONTRACT)
    .map((event) => ({
      memo: getAttr(event, "memo") || "",
      amount: getAttr(event, "amount") || "",
      ammFee: getAttr(event, "amm_fee") || "",
      reserveFee: getAttr(event, "reserve_fee") || "",
      mode: getAttr(event, "mode") || "",
      msgIndex: getAttr(event, "msg_index") || "",
    }))
    .filter((event) => event.memo);
}

function inferContext(events, actionHint, actionConfigByDenom) {
  const baseRuns = collectRevenueRuns(events, BASE_LAYER_REVENUE_COLLECTOR);
  const excludedRuns = collectRevenueRuns(events, RUJI_SWAP_REVENUE_COLLECTOR);
  const memos = collectThorchainSwapMemos(events);
  const denoms = baseRuns.map((run) => run.denom).filter(Boolean);
  const sourceDenom = denoms[0] || actionHint?.denom || "";
  const sourceConfig = actionConfigByDenom.get(sourceDenom);

  return {
    hasBaseRun: baseRuns.length > 0,
    hasExcludedRun: excludedRuns.length > 0,
    baseRuns,
    excludedRuns,
    memos,
    sourceDenom,
    sourceContract: sourceConfig?.contract || "",
    sourceLabel: sourceConfig?.contract
      ? `${sourceDenom} via ${sourceConfig.contract.slice(0, 12)}...`
      : sourceDenom,
  };
}

async function fetchSwapFeeEventsForHeight(height, actionHint, actionConfigByDenom) {
  const payload = await fetchRpcJson("/block_results", { height });
  const txsResults = payload.result?.txs_results || [];
  const finalizeEvents = payload.result?.finalize_block_events || [];
  const contexts = [];

  const finalizeContext = inferContext(finalizeEvents, actionHint, actionConfigByDenom);
  if (finalizeContext.hasBaseRun) {
    contexts.push({ origin: "finalize_block", ...finalizeContext });
  }

  for (const [txIndex, tx] of txsResults.entries()) {
    const txContext = inferContext(tx.events || [], actionHint, actionConfigByDenom);
    if (txContext.hasBaseRun) {
      contexts.push({ origin: `tx_${txIndex}`, ...txContext });
    }
  }

  const includedMemos = new Map();
  const excludedMemos = new Set();
  const warnings = [];

  for (const context of contexts) {
    if (context.hasExcludedRun) {
      for (const memo of context.memos) excludedMemos.add(memo.memo);
      warnings.push({
        height,
        type: "mixed_excluded_collector_context",
        origin: context.origin,
        excludedRuns: context.excludedRuns,
      });
      continue;
    }

    for (const memo of context.memos) {
      if (!includedMemos.has(memo.memo)) {
        includedMemos.set(memo.memo, context);
      }
    }
  }

  if (!includedMemos.size) {
    return { events: [], warnings };
  }

  const date = actionHint?.date || null;
  const events = [];
  const seen = new Set();

  for (const event of finalizeEvents.filter((item) => item.type === "swap")) {
    const from = getAttr(event, "from") || "";
    const memo = getAttr(event, "memo") || "";
    if (from !== RUJIRA_THORCHAIN_SWAP_CONTRACT) continue;
    if (!includedMemos.has(memo)) continue;
    if (excludedMemos.has(memo)) continue;

    const id = getAttr(event, "id") || "";
    const pool = getAttr(event, "pool") || "";
    const coin = getAttr(event, "coin") || "";
    const feeBase = getAttr(event, "liquidity_fee_in_rune") || "0";
    const key = `${height}|${id}|${pool}|${coin}|${feeBase}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const context = includedMemos.get(memo);
    events.push({
      height,
      date,
      id,
      pool,
      chain: getAttr(event, "chain") || "",
      from,
      to: getAttr(event, "to") || "",
      coin,
      memo,
      source_denom: context.sourceDenom,
      source_contract: context.sourceContract,
      source_label: context.sourceLabel,
      context_origin: context.origin,
      liquidity_fee_base: feeBase,
      liquidity_fee_rune: baseRuneToNumber(feeBase),
      liquidity_fee: getAttr(event, "liquidity_fee") || "",
      swap_slip: getAttr(event, "swap_slip") || "",
      pool_slip: getAttr(event, "pool_slip") || "",
      streaming_swap_quantity: getAttr(event, "streaming_swap_quantity") || "",
      streaming_swap_count: getAttr(event, "streaming_swap_count") || "",
    });
  }

  return { events, warnings };
}

async function fetchSwapFeeEvents(actions, actionConfigByDenom) {
  const actionByHeight = new Map();
  for (const action of actions) {
    if (!actionByHeight.has(action.height)) actionByHeight.set(action.height, action);
  }

  const heights = [...actionByHeight.keys()].sort((a, b) => a - b);
  const events = [];
  const warnings = [];
  const concurrency = 8;
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= heights.length) return;
      const height = heights[index];
      const action = actionByHeight.get(height);
      const result = await fetchSwapFeeEventsForHeight(height, action, actionConfigByDenom);
      events.push(...result.events);
      warnings.push(...result.warnings);
      if (index % 40 === 0) {
        process.stderr.write(`processed ${index + 1}/${heights.length} heights\n`);
      }
      await sleep(60);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return {
    events: events.sort((a, b) => a.height - b.height || a.pool.localeCompare(b.pool)),
    warnings,
  };
}

async function fetchRunePriceWeeks(fromTs, count) {
  const payload = await fetchMidgardJson("/v2/history/rune", {
    interval: "week",
    count,
    from: fromTs,
  });
  if (!Array.isArray(payload.intervals)) {
    throw new Error("Unexpected rune price history response");
  }
  return payload.intervals.map((row) => ({
    startTime: Number(row.startTime),
    endTime: Number(row.endTime),
    price: Number(row.runePriceUSD),
  }));
}

function priceEvents(events, priceWeeks) {
  const priceByWeek = new Map();
  for (const week of priceWeeks) {
    priceByWeek.set(formatDate(new Date(week.startTime * 1000)), week.price);
  }

  return events.map((event) => {
    const weekStart = startOfUtcWeek(event.date);
    const weekKey = formatDate(weekStart);
    const runePriceUsd = priceByWeek.get(weekKey) || 0;
    const feeUsd = event.liquidity_fee_rune * runePriceUsd;
    return {
      ...event,
      week_start: weekKey,
      rune_price_usd: runePriceUsd,
      liquidity_fee_usd: feeUsd,
    };
  });
}

function aggregateWeekly(events) {
  const grouped = new Map();
  for (const event of events) {
    const weekStart = startOfUtcWeek(event.date);
    const key = formatDate(weekStart);
    const existing =
      grouped.get(key) ||
      {
        week_start: key,
        week_end: formatDate(addDays(weekStart, 7)),
        swap_events: 0,
        unique_heights: new Set(),
        liquidity_fee_rune: 0,
        liquidity_fee_usd: 0,
        rune_price_usd: event.rune_price_usd,
      };
    existing.swap_events += 1;
    existing.unique_heights.add(event.height);
    existing.liquidity_fee_rune += event.liquidity_fee_rune;
    existing.liquidity_fee_usd += event.liquidity_fee_usd;
    grouped.set(key, existing);
  }

  let cumulativeRune = 0;
  let cumulativeUsd = 0;
  return [...grouped.values()]
    .sort((a, b) => a.week_start.localeCompare(b.week_start))
    .map((row) => {
      cumulativeRune += row.liquidity_fee_rune;
      cumulativeUsd += row.liquidity_fee_usd;
      return {
        week_start: row.week_start,
        week_end: row.week_end,
        swap_events: row.swap_events,
        active_heights: row.unique_heights.size,
        liquidity_fee_rune: row.liquidity_fee_rune,
        rune_price_usd: row.rune_price_usd,
        liquidity_fee_usd: row.liquidity_fee_usd,
        cumulative_rune: cumulativeRune,
        cumulative_usd: cumulativeUsd,
      };
    });
}

function aggregateDaily(events) {
  const grouped = new Map();
  for (const event of events) {
    const key = formatDate(event.date);
    const existing =
      grouped.get(key) ||
      {
        day_start: key,
        day_end: formatDate(addDays(new Date(`${key}T00:00:00Z`), 1)),
        swap_events: 0,
        unique_heights: new Set(),
        liquidity_fee_rune: 0,
        liquidity_fee_usd: 0,
        rune_price_usd: event.rune_price_usd,
      };
    existing.swap_events += 1;
    existing.unique_heights.add(event.height);
    existing.liquidity_fee_rune += event.liquidity_fee_rune;
    existing.liquidity_fee_usd += event.liquidity_fee_usd;
    grouped.set(key, existing);
  }

  let cumulativeRune = 0;
  let cumulativeUsd = 0;
  return [...grouped.values()]
    .sort((a, b) => a.day_start.localeCompare(b.day_start))
    .map((row) => {
      cumulativeRune += row.liquidity_fee_rune;
      cumulativeUsd += row.liquidity_fee_usd;
      return {
        day_start: row.day_start,
        day_end: row.day_end,
        swap_events: row.swap_events,
        active_heights: row.unique_heights.size,
        liquidity_fee_rune: row.liquidity_fee_rune,
        rune_price_usd: row.rune_price_usd,
        liquidity_fee_usd: row.liquidity_fee_usd,
        cumulative_rune: cumulativeRune,
        cumulative_usd: cumulativeUsd,
      };
    });
}

function aggregateByKey(events, key, labelKey = key) {
  const grouped = new Map();
  for (const event of events) {
    const groupKey = event[key] || "unknown";
    const existing =
      grouped.get(groupKey) ||
      {
        [labelKey]: groupKey,
        swap_events: 0,
        active_heights: new Set(),
        liquidity_fee_rune: 0,
        liquidity_fee_usd: 0,
      };
    existing.swap_events += 1;
    existing.active_heights.add(event.height);
    existing.liquidity_fee_rune += event.liquidity_fee_rune;
    existing.liquidity_fee_usd += event.liquidity_fee_usd;
    grouped.set(groupKey, existing);
  }

  return [...grouped.values()]
    .map((row) => ({
      ...row,
      active_heights: row.active_heights.size,
    }))
    .sort((a, b) => b.liquidity_fee_usd - a.liquidity_fee_usd);
}

function aggregateRoutes(events) {
  const grouped = new Map();
  for (const event of events) {
    const key = event.source_denom || "unknown";
    const existing =
      grouped.get(key) ||
      {
        source_denom: key,
        source_contract: event.source_contract || "",
        source_label: event.source_label || key,
        swap_events: 0,
        active_heights: new Set(),
        liquidity_fee_rune: 0,
        liquidity_fee_usd: 0,
      };
    existing.swap_events += 1;
    existing.active_heights.add(event.height);
    existing.liquidity_fee_rune += event.liquidity_fee_rune;
    existing.liquidity_fee_usd += event.liquidity_fee_usd;
    grouped.set(key, existing);
  }

  return [...grouped.values()]
    .map((row) => ({
      ...row,
      active_heights: row.active_heights.size,
    }))
    .sort((a, b) => b.liquidity_fee_usd - a.liquidity_fee_usd);
}

async function main() {
  await Promise.all([OUTPUT_DIR, WEBSITE_OUTPUT_DIR].map((dir) => mkdir(dir, { recursive: true })));
  const generatedAt = new Date().toISOString();

  const { actions: configuredActions, byDenom } = await fetchCollectorActionConfig();
  process.stderr.write(`configured base collector actions ${configuredActions.length}\n`);

  const revenueRunActions = await fetchRevenueRunActions();
  process.stderr.write(`fetched ${revenueRunActions.length} base collector run actions\n`);

  const { events: rawEvents, warnings } = await fetchSwapFeeEvents(revenueRunActions, byDenom);
  process.stderr.write(`matched ${rawEvents.length} THORNode swap fee events\n`);

  let events = rawEvents;
  let priceWeeks = [];
  if (events.length) {
    const firstWeek = startOfUtcWeek(events[0].date);
    const lastWeek = startOfUtcWeek(events.at(-1).date);
    const weekCount =
      Math.ceil((lastWeek.getTime() - firstWeek.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 2;
    priceWeeks = await fetchRunePriceWeeks(Math.floor(firstWeek.getTime() / 1000), weekCount);
    events = priceEvents(events, priceWeeks);
  }

  const weekly = aggregateWeekly(events);
  const daily = aggregateDaily(events);
  const routes = aggregateRoutes(events);
  const pools = aggregateByKey(events, "pool", "pool");
  const totalFeeRune = events.reduce((sum, event) => sum + event.liquidity_fee_rune, 0);
  const totalFeeUsd = events.reduce((sum, event) => sum + event.liquidity_fee_usd, 0);
  const activeHeights = new Set(events.map((event) => event.height));

  const meta = {
    generatedAt,
    scope:
      "Known non-RUJI-Swap app-layer THORChain swap fees from Base Layer collector conversion runs.",
    method:
      "Find Base Layer revenue collector wasm-rujira-revenue/run heights, match same-block rujira-thorchain-swap memos to THORNode swap events, and sum liquidity_fee_in_rune.",
    caveat:
      "This is a second analysis path for base-layer fees generated by app-layer contract activity, not explicit revenue-share payments. It is intentionally scoped to Base Layer collector conversion activity and excludes the RUJI Swap revenue collector.",
    baseLayerRevenueCollector: BASE_LAYER_REVENUE_COLLECTOR,
    excludedRujiSwapRevenueCollector: RUJI_SWAP_REVENUE_COLLECTOR,
    rujiraThorchainSwapContract: RUJIRA_THORCHAIN_SWAP_CONTRACT,
    configuredActionCount: configuredActions.length,
    revenueRunActionCount: revenueRunActions.length,
    matchedSwapFeeEventCount: events.length,
    activeHeightCount: activeHeights.size,
    totalLiquidityFeeRune: roundNumber(totalFeeRune, 8),
    totalLiquidityFeeUsd: roundNumber(totalFeeUsd, 8),
    warningCount: warnings.length,
    sourceMidgard: MIDGARD_BASES,
    sourceThornode: THORNODE_BASES,
    sourceRpc: RPC_BASES,
  };

  const payload = {
    meta,
    weekly,
    daily,
    routes,
    pools,
    events,
    warnings,
  };

  const weeklyCsv = toCsv(weekly, [
    "week_start",
    "week_end",
    "swap_events",
    "active_heights",
    "liquidity_fee_rune",
    "rune_price_usd",
    "liquidity_fee_usd",
    "cumulative_rune",
    "cumulative_usd",
  ]);

  const eventsCsv = toCsv(events, [
    "height",
    "week_start",
    "id",
    "pool",
    "source_denom",
    "source_contract",
    "coin",
    "liquidity_fee_base",
    "liquidity_fee_rune",
    "rune_price_usd",
    "liquidity_fee_usd",
    "memo",
  ]);

  const routeCsv = toCsv(routes, [
    "source_denom",
    "source_contract",
    "source_label",
    "swap_events",
    "active_heights",
    "liquidity_fee_rune",
    "liquidity_fee_usd",
  ]);

  const files = [
    ["rujira-app-layer-swap-fees.json", JSON.stringify(payload, null, 2)],
    ["rujira-app-layer-swap-fees-weekly.csv", weeklyCsv],
    ["rujira-app-layer-swap-fees-events.csv", eventsCsv],
    ["rujira-app-layer-swap-fees-routes.csv", routeCsv],
  ];

  await Promise.all(
    [OUTPUT_DIR, WEBSITE_OUTPUT_DIR].flatMap((dir) =>
      files.map(([name, contents]) => writeFile(path.join(dir, name), `${contents}\n`)),
    ),
  );

  process.stdout.write(JSON.stringify(meta, null, 2));
  process.stdout.write("\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
