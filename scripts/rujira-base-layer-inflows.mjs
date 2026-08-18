#!/usr/bin/env node
// Measures app-layer earnings allocated to THORChain's Base Layer with
// balance-delta accounting. The accounting boundary contains 100% of
// routable Base Layer Collector inventory plus the configured Base Layer
// share of routable Trade/Core collector inventory. For each UTC day:
//
// earned = weighted routable inventory delta + that day's Reserve payouts.
//
// The payout term is only an accounting add-back: it cancels the inventory
// decrease when previously earned value leaves for the Reserve. Transfers
// between an upstream collector and the Base Layer Collector likewise cancel
// inside the boundary. Daily/weekly rows are the primary earnings metric; a
// cumulative series is derived from those period rows for optional display.
//
// By-denom rows are net value flow per asset: conversions show up as value
// migrating into the RUNE line, so the denom table reflects where value
// flowed, not which asset the fee originally arrived as.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIDGARD_BASE =
  process.env.MIDGARD_BASE ||
  "https://gateway.liquify.com/chain/thorchain_midgard";
const THORNODE_BASE =
  process.env.THORNODE_BASE || "https://gateway.liquify.com/chain/thorchain_api";
const THORNODE_BASES = process.env.THORNODE_BASES
  ? process.env.THORNODE_BASES.split(",").map((base) => base.trim()).filter(Boolean)
  : [
      THORNODE_BASE,
      "https://thornode-archive.ninerealms.com",
    ];
const RPC_BASES = process.env.RPC_BASES
  ? process.env.RPC_BASES.split(",").map((base) => base.trim()).filter(Boolean)
  : ["https://gateway.liquify.com/chain/thorchain_rpc"];

const BASE_LAYER_REVENUE_COLLECTOR =
  "thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr";

const ROUTE_COLLECTORS = [
  {
    key: "trade",
    name: "RUJI Trade",
    address: "thor1gm8q2gr25nzzsxzdp2mpja4hyvyhjlr4s6krcsgv2y953uu0js3qhwpus7",
  },
  {
    key: "core",
    name: "Other Core Apps",
    address: "thor1jduxxzpyyvrgzx7zcnl7e5cdj34tnq5jxy00a4wp86szye25dndq575c0y",
  },
  {
    key: "base",
    name: "Base Layer Collector",
    address: BASE_LAYER_REVENUE_COLLECTOR,
  },
];

const WEBSITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(WEBSITE_ROOT, "docs/rujira-base-layer-fees");
const WEBSITE_OUTPUT_DIR = path.join(WEBSITE_ROOT, "public/data/rujira-base-layer-fees");
const BACKEND_DATA_DIR = path.join(WEBSITE_ROOT, "backend/data");

const CLIENT_HEADERS = {
  accept: "application/json",
  "user-agent": "boonetools-rujira-base-layer-inflows/2.0",
  "x-client-id": "RuneTools",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, { attempts = 4, headers = {} } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { ...CLIENT_HEADERS, ...headers } });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 160)}`);
      }
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
      await sleep(500 * attempt);
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastError?.message || lastError}`);
}

function queryUrl(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function fetchRpcJson(pathname, params = {}) {
  let lastError;
  for (const rpcBase of RPC_BASES) {
    try {
      return await fetchJson(queryUrl(`${rpcBase}${pathname}`, params));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
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

function denomToPoolAsset(denom) {
  if (!denom || denom === "rune") return "THOR.RUNE";
  let d = denom;
  if (d.startsWith("x/ghost-vault/")) d = d.slice("x/ghost-vault/".length);
  if (d === "rune") return "THOR.RUNE";
  if (d.startsWith("x/")) return `THOR.${d.slice(2).toUpperCase()}`;
  if (d.startsWith("thor.")) return d.toUpperCase();
  if (!d.includes("-")) return `THOR.${d.toUpperCase()}`;
  const splitAt = d.indexOf("-");
  return `${d.slice(0, splitAt).toUpperCase()}.${d.slice(splitAt + 1).toUpperCase()}`;
}

function isStableDenom(denom) {
  return /(?:usdc|usdt|dai|gusd|usdp)/i.test(denom || "");
}

function normalizeDenom(denom) {
  return String(denom || "").trim().toLowerCase();
}

function smartQuery(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

async function fetchRouteScopes() {
  return Promise.all(
    ROUTE_COLLECTORS.map(async (collector) => {
      const [configPayload, actionsPayload] = await Promise.all([
        fetchJson(
          `${THORNODE_BASE}/cosmwasm/wasm/v1/contract/${collector.address}/smart/${smartQuery({ config: {} })}`,
        ),
        fetchJson(
          `${THORNODE_BASE}/cosmwasm/wasm/v1/contract/${collector.address}/smart/${smartQuery({ actions: {} })}`,
        ),
      ]);
      const config = configPayload?.data || {};
      const targetAddresses = Array.isArray(config.target_addresses) ? config.target_addresses : [];
      const totalWeight = targetAddresses.reduce((sum, [, weight]) => sum + Number(weight || 0), 0);
      const baseWeight = targetAddresses.reduce(
        (sum, [address, weight]) =>
          address === BASE_LAYER_REVENUE_COLLECTOR ? sum + Number(weight || 0) : sum,
        0,
      );
      const baseLayerShare = collector.key === "base" ? 1 : baseWeight / totalWeight;
      const targetDenoms = (config.target_denoms || []).map(([denom]) => normalizeDenom(denom));
      const actionDenoms = (actionsPayload?.data?.actions || []).map((action) =>
        normalizeDenom(action?.denom),
      );

      if (!(baseLayerShare > 0)) {
        throw new Error(`${collector.key}: current config has no Base Layer allocation`);
      }

      return {
        ...collector,
        baseLayerShare,
        targetDenoms,
        actionDenoms,
        routableDenoms: new Set([...targetDenoms, ...actionDenoms]),
      };
    }),
  );
}

async function loadWebsiteEnv() {
  try {
    const text = await readFile(path.join(WEBSITE_ROOT, ".env"), "utf8");
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const eq = line.indexOf("=");
          return [line.slice(0, eq), line.slice(eq + 1)];
        }),
    );
  } catch {
    return {};
  }
}

// Base Layer settlement events (Reserve plus post-cutover POL) give both the
// payout series and dense (height, time) anchors for the day→height mapping.
// Prefer the live API; the static artifact is a Reserve-only fallback.
async function fetchReserveEvents() {
  const env = await loadWebsiteEnv();
  const apiBase = (
    process.env.APP_LAYER_API_BASE ||
    env.VITE_APP_LAYER_API_BASE ||
    env.VITE_NODEOP_API_BASE ||
    ""
  ).replace(/\/$/, "");
  const apiKey =
    process.env.APP_LAYER_API_KEY || env.VITE_APP_LAYER_API_KEY || env.VITE_NODEOP_API_KEY || "";

  if (apiBase) {
    try {
      const payload = await fetchJson(`${apiBase}/app-layer-reserve-payments`, {
        headers: apiKey ? { apikey: apiKey, Authorization: `Bearer ${apiKey}` } : {},
      });
      const events = (payload.events || [])
        .map((event) => ({
          height: Number(event.height),
          timeMs: Date.parse(event.date),
          amountRune: Number(event.amountRune) || 0,
          amountUsd: Number(event.amountUsd) || 0,
        }))
        .filter((event) => event.height > 0 && Number.isFinite(event.timeMs));
      if (events.length) {
        process.stderr.write(`settlement events: ${events.length} from API\n`);
        return events.sort((a, b) => a.height - b.height);
      }
    } catch (err) {
      process.stderr.write(`reserve-payment API unavailable (${err.message}); using static artifact\n`);
    }
  }

  const eventsPath = path.join(WEBSITE_OUTPUT_DIR, "rujira-base-layer-fees-events.json");
  const raw = JSON.parse(await readFile(eventsPath, "utf8"));
  return raw
    .map((event) => ({
      height: Number(event.height),
      timeMs: Date.parse(event.date),
      amountRune: Number(event.amountRune ?? (Number(event.amountBase) || 0) / 1e8) || 0,
      amountUsd: Number(event.amountUsd) || 0,
    }))
    .filter((event) => event.height > 0 && Number.isFinite(event.timeMs))
    .sort((a, b) => a.height - b.height);
}

async function fetchLatestHeightAndTime() {
  const payload = await fetchRpcJson("/status");
  return {
    height: Number(payload.result?.sync_info?.latest_block_height || 0),
    timeMs: Date.parse(payload.result?.sync_info?.latest_block_time || ""),
  };
}

async function fetchBlockTimeMs(height) {
  const payload = await fetchRpcJson("/block", { height });
  const time = payload.result?.block?.header?.time;
  if (!time) throw new Error(`Could not read block time for height ${height}`);
  return Date.parse(time);
}

// Interpolate a height for a target time from anchor points, then refine
// with real block-time lookups (block time ≈ 6s but drifts across halts).
async function heightAtTime(targetMs, anchors) {
  let lo = anchors[0];
  let hi = anchors[anchors.length - 1];
  if (targetMs <= lo.timeMs) return lo.height;
  if (targetMs >= hi.timeMs) return hi.height;
  for (const anchor of anchors) {
    if (anchor.timeMs <= targetMs) lo = anchor;
    else {
      hi = anchor;
      break;
    }
  }
  let guess = Math.round(
    lo.height + ((targetMs - lo.timeMs) / (hi.timeMs - lo.timeMs)) * (hi.height - lo.height),
  );
  guess = Math.max(lo.height, Math.min(hi.height, guess));
  for (let i = 0; i < 4; i += 1) {
    const actualMs = await fetchBlockTimeMs(guess);
    const offBlocks = Math.round((targetMs - actualMs) / 6000);
    if (Math.abs(offBlocks) < 5) return guess;
    guess = Math.max(lo.height, Math.min(hi.height, guess + offBlocks));
  }
  return guess;
}

// The gateway balances across archival and pruned nodes, so a height can
// 500 intermittently. Retry, then nudge the height slightly — a few hundred
// blocks (~minutes) does not matter for daily buckets.
async function fetchBalancesAt(address, height) {
  let lastError;
  for (const base of THORNODE_BASES) {
    const url = `${base}/cosmos/bank/v1beta1/balances/${address}?pagination.limit=200`;
    for (const nudge of [0, 1, -1, 51, -51, 301, -301, 901]) {
      try {
        const payload = await fetchJson(url, {
          attempts: 2,
          headers: { "x-cosmos-block-height": String(height + nudge) },
        });
        const balances = {};
        for (const row of payload.balances || []) {
          const amount = Number(row.amount) / 1e8;
          if (amount > 0) balances[String(row.denom).toLowerCase()] = amount;
        }
        return balances;
      } catch (err) {
        lastError = err;
        await sleep(250);
      }
    }
  }
  throw lastError;
}

async function fetchScopedBalancesAt(height, routeScopes) {
  const snapshots = await Promise.all(
    routeScopes.map(async (scope) => ({
      scope,
      balances: await fetchBalancesAt(scope.address, height),
    })),
  );
  const scopedBalances = {};

  for (const { scope, balances } of snapshots) {
    for (const [denom, amount] of Object.entries(balances)) {
      if (!scope.routableDenoms.has(denom)) continue;
      scopedBalances[denom] = (scopedBalances[denom] || 0) + amount * scope.baseLayerShare;
    }
  }

  return scopedBalances;
}

async function fetchDailyPrices(pool, fromTs, count) {
  const url =
    pool === "THOR.RUNE"
      ? queryUrl(`${MIDGARD_BASE}/v2/history/rune`, { interval: "day", count, from: fromTs })
      : queryUrl(`${MIDGARD_BASE}/v2/history/depths/${pool}`, {
          interval: "day",
          count,
          from: fromTs,
        });
  const payload = await fetchJson(url);
  if (!Array.isArray(payload.intervals)) {
    throw new Error(`Unexpected price response from ${url}`);
  }
  const byDay = new Map();
  for (const row of payload.intervals) {
    const price = Number(pool === "THOR.RUNE" ? row.runePriceUSD : row.assetPriceUSD);
    byDay.set(formatDate(new Date(Number(row.startTime) * 1000)), price);
  }
  return byDay;
}

function toCsv(rows, headers) {
  return [
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((header) => {
          const value = row[header];
          return typeof value === "number"
            ? value.toFixed(8).replace(/\.?0+$/, "")
            : String(value ?? "");
        })
        .join(","),
    ),
  ].join("\n");
}

async function main() {
  await Promise.all(
    [OUTPUT_DIR, WEBSITE_OUTPUT_DIR, BACKEND_DATA_DIR]
      .map((dir) => mkdir(dir, { recursive: true })),
  );

  const [events, routeScopes] = await Promise.all([fetchReserveEvents(), fetchRouteScopes()]);
  if (!events.length) throw new Error("No reserve events available");
  const tip = await fetchLatestHeightAndTime();
  const anchors = [...events.map((e) => ({ height: e.height, timeMs: e.timeMs })), tip];
  let existingArtifact = null;
  try {
    existingArtifact = JSON.parse(
      await readFile(path.join(WEBSITE_OUTPUT_DIR, "rujira-base-layer-inflows.json"), "utf8"),
    );
  } catch {
    // A first-time generation has no prior bootstrap to reuse.
  }

  // Daily paid buckets (backend prices each event at its daily RUNE/USD).
  const paidByDay = new Map();
  for (const event of events) {
    const day = formatDate(new Date(event.timeMs));
    const row = paidByDay.get(day) || { rune: 0, usd: 0 };
    row.rune += event.amountRune;
    row.usd += event.amountUsd;
    paidByDay.set(day, row);
  }

  // Day boundaries: baseline is the day before the first deposit; each
  // day's snapshot is taken at (start of next UTC day) − 1 second.
  const firstDay = new Date(Date.UTC(
    new Date(events[0].timeMs).getUTCFullYear(),
    new Date(events[0].timeMs).getUTCMonth(),
    new Date(events[0].timeMs).getUTCDate(),
  ));
  const days = [];
  for (let d = new Date(firstDay); d.getTime() <= tip.timeMs; d = addDays(d, 1)) {
    days.push(formatDate(d));
  }
  const routeShareSignature = routeScopes
    .map(
      (scope) =>
        `${scope.key}:${scope.baseLayerShare}:${scope.targetDenoms.length}:${scope.actionDenoms.length}`,
    )
    .join("|");
  const existingRouteShareSignature = (existingArtifact?.meta?.routeScopes || [])
    .map(
      (scope) =>
        `${scope.key}:${scope.baseLayerShare}:${scope.targetDenomCount}:${scope.actionDenomCount}`,
    )
    .join("|");
  const canReuseHistory =
    process.env.RUJIRA_INFLOW_FULL_REBUILD !== "1" &&
    existingArtifact?.meta?.method === "weighted-routable-balance-delta" &&
    existingArtifact?.meta?.firstDay === days[0] &&
    existingRouteShareSignature === routeShareSignature &&
    Array.isArray(existingArtifact?.daily);
  const refreshDayCount = Math.max(
    2,
    Number.parseInt(process.env.RUJIRA_INFLOW_REFRESH_DAYS || "3", 10) || 3,
  );
  const refreshFloor = formatDate(
    addDays(new Date(`${days.at(-1)}T00:00:00Z`), -(refreshDayCount - 1)),
  );
  const rebuildStartDay = canReuseHistory && refreshFloor > days[0] ? refreshFloor : days[0];
  const measurementDays = days.filter((day) => day >= rebuildStartDay);
  const retainedDailyRows = canReuseHistory
    ? existingArtifact.daily.filter((row) => row.day_start < rebuildStartDay)
    : [];
  process.stderr.write(
    `measuring ${measurementDays.length}/${days.length} days from ${rebuildStartDay} to ${days.at(-1)}` +
      `${retainedDailyRows.length ? `; retaining ${retainedDailyRows.length} prior rows` : ""}\n`,
  );

  // Snapshot heights: opening inventory immediately before the rebuild window
  // plus each refreshed day end. Reusing older verified rows keeps routine
  // refreshes independent of archival-node retention; set
  // RUJIRA_INFLOW_FULL_REBUILD=1 when a full archive is available.
  const snapshotHeights = new Map();
  if (rebuildStartDay === days[0]) {
    snapshotHeights.set("opening", events[0].height - 1);
  } else {
    const openingMs = new Date(`${rebuildStartDay}T00:00:00Z`).getTime() - 1000;
    snapshotHeights.set("opening", await heightAtTime(openingMs, anchors));
  }
  for (const day of measurementDays) {
    const endMs = addDays(new Date(`${day}T00:00:00Z`), 1).getTime() - 1000;
    if (endMs >= tip.timeMs) {
      snapshotHeights.set(day, tip.height);
    } else {
      snapshotHeights.set(day, await heightAtTime(endMs, anchors));
      await sleep(30);
    }
  }

  process.stderr.write(
    `scope: ${routeScopes.map((scope) => `${scope.key} ${(scope.baseLayerShare * 100).toFixed(0)}%`).join(", ")}\n`,
  );

  // Weighted routable balances at each snapshot. Upstream Trade/Core value
  // enters at its configured Base Layer share before it reaches the Base
  // Layer Collector; internal route transfers cancel within this boundary.
  const balancesByDay = new Map();
  let done = 0;
  for (const [day, height] of snapshotHeights) {
    balancesByDay.set(day, await fetchScopedBalancesAt(height, routeScopes));
    done += 1;
    if (done % 15 === 0) process.stderr.write(`balances: ${done}/${snapshotHeights.size}\n`);
    await sleep(60);
  }

  // Daily prices per denom seen in any snapshot.
  const denoms = [...new Set([...balancesByDay.values()].flatMap((b) => Object.keys(b)))];
  const fromTs = Math.floor(new Date(`${rebuildStartDay}T00:00:00Z`).getTime() / 1000) - 86400;
  const priceCount = measurementDays.length + 3;
  const priceTables = new Map();
  const unpricedDenoms = [];
  for (const denom of denoms) {
    const pool = denomToPoolAsset(denom);
    try {
      priceTables.set(denom, await fetchDailyPrices(pool, fromTs, priceCount));
    } catch {
      priceTables.set(denom, null);
      if (!isStableDenom(denom)) unpricedDenoms.push(denom);
      process.stderr.write(`no price history for ${denom} (${pool})\n`);
    }
    await sleep(120);
  }
  function priceFor(denom, day) {
    const price = priceTables.get(denom)?.get(day);
    if (price > 0) return price;
    if (isStableDenom(denom)) return 1;
    return 0;
  }

  // Opening base-layer-bound inventory already inside the scoped collectors
  // when the measurement window starts.
  const baselineUsd = retainedDailyRows.length
    ? Number(existingArtifact.meta.baselineInventoryUsd || 0)
    : Object.entries(balancesByDay.get("opening")).reduce(
        (sum, [denom, qty]) => sum + qty * priceFor(denom, days[0]),
        0,
      );

  // Daily rows: earned = Σ weighted routable Δqty × price(day) +
  // Reserve payouts. The payout is an add-back for value leaving the scope,
  // not a second earnings event.
  const dailyRows = retainedDailyRows.map(({ cumulative_usd, ...row }) => ({ ...row }));
  let previous = balancesByDay.get("opening");
  for (const day of measurementDays) {
    const current = balancesByDay.get(day);
    const paid = paidByDay.get(day) || { rune: 0, usd: 0 };
    const byDenom = {};
    let collected = 0;
    for (const denom of new Set([...Object.keys(previous), ...Object.keys(current)])) {
      let qtyDelta = (current[denom] || 0) - (previous[denom] || 0);
      let usd = qtyDelta * priceFor(denom, day);
      if (denom === "rune") {
        qtyDelta += paid.rune;
        usd += paid.usd;
      }
      if (Math.abs(usd) < 0.005 && Math.abs(qtyDelta) < 1e-8) continue;
      byDenom[denom] = { amount: qtyDelta, usd };
      collected += usd;
    }
    dailyRows.push({
      day_start: day,
      day_end: formatDate(addDays(new Date(`${day}T00:00:00Z`), 1)),
      transfers: Object.keys(byDenom).length,
      inflow_usd: collected,
      by_denom: byDenom,
    });
    previous = current;
  }

  // Rebuild cumulative and denom totals across retained plus refreshed rows.
  const priorDenomMeta = new Map(
    (existingArtifact?.denomTotals || []).map((row) => [row.denom, row]),
  );
  const unpricedDenomSet = new Set([
    ...(canReuseHistory ? existingArtifact?.meta?.unpricedDenoms || [] : []),
    ...unpricedDenoms,
  ]);
  const denomTotals = new Map();
  let cumulativeUsd = baselineUsd;
  dailyRows.sort((a, b) => a.day_start.localeCompare(b.day_start));
  for (const row of dailyRows) {
    cumulativeUsd += Number(row.inflow_usd || 0);
    row.cumulative_usd = cumulativeUsd;
    for (const [denom, entry] of Object.entries(row.by_denom || {})) {
      const prior = priorDenomMeta.get(denom);
      const total = denomTotals.get(denom) || {
        denom,
        pool: denomToPoolAsset(denom),
        amount: 0,
        usd: 0,
        priced:
          priceTables.has(denom)
            ? priceTables.get(denom) !== null || isStableDenom(denom)
            : prior?.priced ?? !unpricedDenomSet.has(denom),
      };
      total.amount += Number(entry.amount || 0);
      total.usd += Number(entry.usd || 0);
      denomTotals.set(denom, total);
    }
  }

  // Weekly rollup of the same dailies.
  const weekly = new Map();
  for (const row of dailyRows) {
    const weekStart = formatDate(startOfUtcWeek(new Date(`${row.day_start}T00:00:00Z`)));
    const weekRow =
      weekly.get(weekStart) ||
      {
        week_start: weekStart,
        week_end: formatDate(addDays(new Date(`${weekStart}T00:00:00Z`), 7)),
        transfers: 0,
        inflow_usd: 0,
        by_denom: {},
      };
    weekRow.transfers += row.transfers;
    weekRow.inflow_usd += row.inflow_usd;
    for (const [denom, entry] of Object.entries(row.by_denom)) {
      const agg = weekRow.by_denom[denom] || { amount: 0, usd: 0 };
      agg.amount += entry.amount;
      agg.usd += entry.usd;
      weekRow.by_denom[denom] = agg;
    }
    weekly.set(weekStart, weekRow);
  }
  let weekCum = baselineUsd;
  const weeklyRows = [...weekly.values()]
    .sort((a, b) => a.week_start.localeCompare(b.week_start))
    .map((row) => {
      weekCum += row.inflow_usd;
      return { ...row, cumulative_usd: weekCum };
    });

  // Reconciliation: cumulative allocated earnings should approximate final
  // Reserve payouts plus current base-layer-bound inventory.
  const totalPaidUsd = events.reduce((sum, event) => sum + event.amountUsd, 0);
  const lastDay = days.at(-1);
  const inventoryNowUsd = Object.entries(balancesByDay.get(lastDay)).reduce(
    (sum, [denom, qty]) => sum + qty * priceFor(denom, lastDay),
    0,
  );
  const meta = {
    generatedAt: new Date().toISOString(),
    source: "static-artifact",
    method: "weighted-routable-balance-delta",
    collector: BASE_LAYER_REVENUE_COLLECTOR,
    routeScopes: routeScopes.map((scope) => ({
      key: scope.key,
      name: scope.name,
      address: scope.address,
      baseLayerShare: scope.baseLayerShare,
      targetDenomCount: scope.targetDenoms.length,
      actionDenomCount: scope.actionDenoms.length,
    })),
    routeConfigBasis:
      "Current on-chain target weights, target denoms, and conversion actions at generation time are applied to the full measurement window.",
    firstDay: days[0],
    lastDay,
    dayCount: days.length,
    baselineHeight: events[0].height - 1,
    baselineInventoryUsd: baselineUsd,
    tipHeight: tip.height,
    denomCount: denomTotals.size,
    unpricedDenoms: [...unpricedDenomSet].sort(),
    totalInflowUsd: cumulativeUsd,
    netNewInflowUsd: cumulativeUsd - baselineUsd,
    totalPaidUsd,
    inventoryNowUsd,
    priceBasis:
      "per-denom daily change in weighted routable inventory × Midgard daily USD price (RUNE history, pool depth assetPriceUSD, stables at $1), with Reserve payouts added back at deposit-day price solely to cancel value leaving the accounting boundary",
    scope:
      "App-layer earnings allocated to the Base Layer: 100% of routable Base Layer Collector inventory plus the configured Base Layer share of routable RUJI Trade and Other Core Apps inventory. Daily and weekly rows record newly earned value for the period; transfers between scoped collectors and final Reserve payouts do not create new earnings. Swap and Index are excluded because their configured targets do not route to the Base Layer.",
    caveat:
      "01 is an accrual series and overlaps 02: cumulative app-layer earnings ≈ cumulative Base Layer settlement (Reserve plus post-cutover POL) + current base-layer-bound inventory, up to intraday price movement. Do not add 01 to 02.",
  };

  const artifact = {
    meta,
    weekly: weeklyRows,
    daily: dailyRows,
    denomTotals: [...denomTotals.values()].sort((a, b) => b.usd - a.usd),
  };

  const csv = toCsv(weeklyRows, [
    "week_start",
    "week_end",
    "transfers",
    "inflow_usd",
    "cumulative_usd",
  ]);

  const files = [
    ["rujira-base-layer-inflows.json", `${JSON.stringify(artifact, null, 2)}\n`],
    ["rujira-base-layer-inflows.csv", `${csv}\n`],
  ];
  await Promise.all(
    [OUTPUT_DIR, WEBSITE_OUTPUT_DIR].flatMap((dir) =>
      files.map(([fileName, contents]) => writeFile(path.join(dir, fileName), contents)),
    ),
  );
  await writeFile(
    path.join(BACKEND_DATA_DIR, "rujira-base-layer-inflows.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );

  process.stderr.write(
    [
      `wrote ${WEBSITE_OUTPUT_DIR}/rujira-base-layer-inflows.json`,
      `days: ${days.length}, weeks: ${weeklyRows.length}`,
      `collected: opening ${baselineUsd.toFixed(2)} + net new ${(cumulativeUsd - baselineUsd).toFixed(2)} = ${cumulativeUsd.toFixed(2)}`,
      `reconciliation: paid ${totalPaidUsd.toFixed(2)} + bound inventory ${inventoryNowUsd.toFixed(2)} = ${(totalPaidUsd + inventoryNowUsd).toFixed(2)}`,
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
