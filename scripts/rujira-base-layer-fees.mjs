#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const MIDGARD_BASE =
  process.env.MIDGARD_BASE ||
  "https://gateway.liquify.com/chain/thorchain_midgard";
const THORNODE_BASE =
  process.env.THORNODE_BASE || "https://thornode.thorchain.network";
const RPC_BASES = process.env.RPC_BASES
  ? process.env.RPC_BASES.split(",").map((base) => base.trim()).filter(Boolean)
  : [
      "https://gateway.liquify.com/chain/thorchain_rpc",
      "https://rpc.thorchain.network",
    ];

const BASE_LAYER_REVENUE_COLLECTOR =
  "thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr";
const OUTPUT_DIR = path.resolve("docs/rujira-base-layer-fees");
const WEBSITE_OUTPUT_DIR = path.resolve("website/public/data/rujira-base-layer-fees");

const CLIENT_HEADERS = {
  accept: "application/json",
  "user-agent": "boonetools-rujira-base-layer-fees/1.0",
  "x-client-id": "RuneTools",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, { headers: CLIENT_HEADERS });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 160)}`);
      }
      return text;
    } catch (err) {
      lastError = err;
      await sleep(400 * attempt);
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastError?.message || lastError}`);
}

async function fetchJson(url, attempts = 4) {
  const text = await fetchText(url, attempts);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON from ${url}: ${String(text).slice(0, 160)}`);
  }
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

function amountRuneFromBase(baseAmount) {
  return Number(baseAmount) / 1e8;
}

function money(value) {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function rune(value) {
  return `${Math.round(value).toLocaleString("en-US")} RUNE`;
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv(rows) {
  const headers = [
    "week_start",
    "week_end",
    "payments",
    "payment_rune",
    "rune_price_usd",
    "payment_usd",
    "cumulative_rune",
    "cumulative_usd",
  ];
  return [
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((header) => {
          const value = row[header];
          return typeof value === "number" ? value.toFixed(8).replace(/\.?0+$/, "") : csvEscape(value);
        })
        .join(","),
    ),
  ].join("\n");
}

async function fetchRevenueConfig() {
  const query = Buffer.from(JSON.stringify({ config: {} })).toString("base64");
  const url = `${THORNODE_BASE}/cosmwasm/wasm/v1/contract/${BASE_LAYER_REVENUE_COLLECTOR}/smart/${query}`;
  const payload = await fetchJson(url);
  if (!payload?.data?.target_addresses?.length) {
    throw new Error("Could not read revenue collector config target addresses");
  }
  const reserveTarget = payload.data.target_addresses[0]?.[0];
  return {
    owner: payload.data.owner,
    executor: payload.data.executor,
    reserveTarget,
    targetDenoms: payload.data.target_denoms,
    targetAddresses: payload.data.target_addresses,
    lastExecuted: payload.data.last_executed,
  };
}

async function fetchActions() {
  const actions = [];
  let nextPageToken = "";
  for (;;) {
    const url = queryUrl(`${MIDGARD_BASE}/v2/actions`, {
      address: BASE_LAYER_REVENUE_COLLECTOR,
      limit: 50,
      nextPageToken,
    });
    const payload = await fetchJson(url);
    if (!Array.isArray(payload.actions)) {
      throw new Error(`Unexpected Midgard actions response from ${url}`);
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
    }))
    .filter((action) => Number.isFinite(action.height) && action.height > 0)
    .sort((a, b) => a.height - b.height);
}

async function fetchReserveEventsForHeight(height, dateHint, reserveTarget) {
  let payload;
  let lastError;
  for (const rpcBase of RPC_BASES) {
    const url = queryUrl(`${rpcBase}/block_results`, { height });
    try {
      payload = await fetchJson(url);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!payload) {
    throw lastError || new Error(`Failed to fetch block results for height ${height}`);
  }
  const events = payload.result?.finalize_block_events || [];
  return events
    .filter((event) => event.type === "reserve")
    .filter((event) => getAttr(event, "from") === BASE_LAYER_REVENUE_COLLECTOR)
    .filter((event) => getAttr(event, "to") === reserveTarget)
    .filter((event) => getAttr(event, "memo") === "RESERVE")
    .map((event) => ({
      height,
      date: dateHint,
      amountBase: Number(getAttr(event, "amount") || 0),
      coin: getAttr(event, "coin") || "",
      id: getAttr(event, "id") || "",
    }))
    .filter((event) => event.amountBase > 0);
}

async function fetchReserveEvents(actions, reserveTarget) {
  const byHeight = new Map();
  for (const action of actions) {
    if (!byHeight.has(action.height)) byHeight.set(action.height, action);
  }

  const heights = [...byHeight.keys()].sort((a, b) => a - b);
  const events = [];
  const concurrency = 8;
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= heights.length) return;
      const height = heights[index];
      const action = byHeight.get(height);
      const found = await fetchReserveEventsForHeight(height, action.date, reserveTarget);
      events.push(...found);
      if (index % 40 === 0) {
        process.stderr.write(`processed ${index + 1}/${heights.length} heights\n`);
      }
      await sleep(60);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return events.sort((a, b) => a.height - b.height);
}

async function fetchRunePriceWeeks(fromTs, count) {
  const url = queryUrl(`${MIDGARD_BASE}/v2/history/rune`, {
    interval: "week",
    count,
    from: fromTs,
  });
  const payload = await fetchJson(url);
  if (!Array.isArray(payload.intervals)) {
    throw new Error(`Unexpected rune price response from ${url}`);
  }
  return payload.intervals.map((row) => ({
    startTime: Number(row.startTime),
    endTime: Number(row.endTime),
    price: Number(row.runePriceUSD),
  }));
}

function aggregateWeekly(events, priceWeeks) {
  const priceByWeek = new Map();
  for (const week of priceWeeks) {
    priceByWeek.set(formatDate(new Date(week.startTime * 1000)), week.price);
  }

  const grouped = new Map();
  for (const event of events) {
    const weekStart = startOfUtcWeek(event.date);
    const key = formatDate(weekStart);
    const existing =
      grouped.get(key) ||
      {
        week_start: key,
        week_end: formatDate(addDays(weekStart, 7)),
        payments: 0,
        payment_rune: 0,
      };
    existing.payments += 1;
    existing.payment_rune += amountRuneFromBase(event.amountBase);
    grouped.set(key, existing);
  }

  let cumulativeRune = 0;
  let cumulativeUsd = 0;
  return [...grouped.values()]
    .sort((a, b) => a.week_start.localeCompare(b.week_start))
    .map((row) => {
      const runePrice = priceByWeek.get(row.week_start) || 0;
      const paymentUsd = row.payment_rune * runePrice;
      cumulativeRune += row.payment_rune;
      cumulativeUsd += paymentUsd;
      return {
        ...row,
        rune_price_usd: runePrice,
        payment_usd: paymentUsd,
        cumulative_rune: cumulativeRune,
        cumulative_usd: cumulativeUsd,
      };
    });
}

function niceMax(value) {
  if (value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / pow) * pow;
}

function makeSvg(rows, meta) {
  const width = 1400;
  const height = 820;
  const margin = { top: 180, right: 116, bottom: 110, left: 118 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const maxWeekly = niceMax(Math.max(...rows.map((row) => row.payment_usd), 0));
  const maxCumulative = niceMax(Math.max(...rows.map((row) => row.cumulative_usd), 0));
  const barGap = 3;
  const barW = Math.max(4, plotW / Math.max(rows.length, 1) - barGap);
  const x = (index) => margin.left + index * (plotW / Math.max(rows.length, 1));
  const yWeekly = (value) => margin.top + plotH - (value / maxWeekly) * plotH;
  const yCumulative = (value) => margin.top + plotH - (value / maxCumulative) * plotH;
  const points = rows
    .map((row, index) => `${x(index) + barW / 2},${yCumulative(row.cumulative_usd)}`)
    .join(" ");
  const ticks = 5;
  const yGrid = Array.from({ length: ticks + 1 }, (_, i) => {
    const value = (maxWeekly / ticks) * i;
    const y = yWeekly(value);
    return `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" class="grid"/><text x="${margin.left - 16}" y="${y + 5}" class="axis-label" text-anchor="end">${money(value)}</text>`;
  }).join("\n");
  const rightTicks = Array.from({ length: ticks + 1 }, (_, i) => {
    const value = (maxCumulative / ticks) * i;
    const y = yCumulative(value);
    return `<text x="${width - margin.right + 16}" y="${y + 5}" class="axis-label" text-anchor="start">${money(value)}</text>`;
  }).join("\n");
  const xTicks = rows
    .filter((_, index) => index === 0 || index === rows.length - 1 || index % Math.ceil(rows.length / 8) === 0)
    .map((row, index, selected) => {
      const realIndex = rows.indexOf(row);
      const tx = x(realIndex) + barW / 2;
      return `<text x="${tx}" y="${height - margin.bottom + 42}" class="axis-label" text-anchor="middle">${row.week_start.slice(5)}</text>`;
    })
    .join("\n");
  const bars = rows
    .map((row, index) => {
      const bx = x(index);
      const by = yWeekly(row.payment_usd);
      const bh = margin.top + plotH - by;
      return `<rect x="${bx}" y="${by}" width="${barW}" height="${bh}" rx="2" class="bar"><title>${row.week_start} to ${row.week_end}: ${money(row.payment_usd)} (${rune(row.payment_rune)})</title></rect>`;
    })
    .join("\n");

  const last = rows.at(-1);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Observed Rujira Base Layer collector reserve deposits</title>
  <desc id="desc">Weekly USD bars and cumulative USD line for observed Rujira Base Layer revenue collector reserve payments.</desc>
  <style>
    :root { color-scheme: light; }
    svg { background: #f7f4ed; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .title { fill: #111827; font-size: 34px; font-weight: 760; letter-spacing: 0; }
    .subtitle { fill: #4b5563; font-size: 15px; }
    .metric-label { fill: #6b7280; font-size: 13px; text-transform: uppercase; letter-spacing: .08em; }
    .metric-value { fill: #111827; font-size: 23px; font-weight: 740; }
    .axis-label { fill: #6b7280; font-size: 12px; }
    .axis-title { fill: #374151; font-size: 13px; font-weight: 680; }
    .grid { stroke: #ded8cc; stroke-width: 1; }
    .axis { stroke: #9ca3af; stroke-width: 1.2; }
    .bar { fill: #18a999; }
    .line { fill: none; stroke: #253858; stroke-width: 4; stroke-linejoin: round; stroke-linecap: round; }
    .dot { fill: #253858; }
    .note { fill: #6b7280; font-size: 12px; }
    .legend { fill: #111827; font-size: 13px; font-weight: 650; }
  </style>
  <text x="${margin.left}" y="48" class="title">Observed Rujira Base Layer collector reserve deposits</text>
  <text x="${margin.left}" y="76" class="subtitle">Actual final reserve deposits from the Base Layer collector (${BASE_LAYER_REVENUE_COLLECTOR.slice(0, 12)}...) grouped by UTC week and priced with Midgard weekly RUNE/USD.</text>

  <text x="${margin.left}" y="106" class="metric-label">Cumulative paid</text>
  <text x="${margin.left}" y="135" class="metric-value">${money(last?.cumulative_usd || 0)}</text>
  <text x="${margin.left + 230}" y="106" class="metric-label">Cumulative RUNE</text>
  <text x="${margin.left + 230}" y="135" class="metric-value">${rune(last?.cumulative_rune || 0)}</text>
  <text x="${margin.left + 460}" y="106" class="metric-label">Reserve deposits</text>
  <text x="${margin.left + 460}" y="135" class="metric-value">${meta.eventCount.toLocaleString("en-US")}</text>
  <text x="${margin.left + 690}" y="106" class="metric-label">Range</text>
  <text x="${margin.left + 690}" y="135" class="metric-value">${rows[0]?.week_start || ""} to ${last?.week_end || ""}</text>

  <g>
    ${yGrid}
    <line x1="${margin.left}" y1="${margin.top + plotH}" x2="${width - margin.right}" y2="${margin.top + plotH}" class="axis"/>
    <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" class="axis"/>
    <line x1="${width - margin.right}" y1="${margin.top}" x2="${width - margin.right}" y2="${margin.top + plotH}" class="axis"/>
    ${rightTicks}
    ${bars}
    <polyline points="${points}" class="line"/>
    ${rows.map((row, index) => {
      if (index !== rows.length - 1 && index % Math.ceil(rows.length / 6) !== 0) return "";
      return `<circle cx="${x(index) + barW / 2}" cy="${yCumulative(row.cumulative_usd)}" r="4.5" class="dot"><title>${row.week_start}: cumulative ${money(row.cumulative_usd)}</title></circle>`;
    }).join("\n")}
    ${xTicks}
    <text x="${margin.left}" y="${margin.top - 18}" class="axis-title">Weekly payment, USD</text>
    <text x="${width - margin.right}" y="${margin.top - 18}" class="axis-title" text-anchor="end">Cumulative payment, USD</text>
    <rect x="${margin.left}" y="${height - margin.bottom + 72}" width="14" height="14" class="bar"/>
    <text x="${margin.left + 22}" y="${height - margin.bottom + 84}" class="legend">Weekly paid</text>
    <line x1="${margin.left + 130}" y1="${height - margin.bottom + 78}" x2="${margin.left + 168}" y2="${height - margin.bottom + 78}" class="line"/>
    <text x="${margin.left + 178}" y="${height - margin.bottom + 84}" class="legend">Cumulative paid</text>
    <text x="${margin.left + 360}" y="${height - margin.bottom + 84}" class="note">Generated ${meta.generatedAt}; reserve target ${meta.reserveTarget.slice(0, 12)}...</text>
  </g>
</svg>
`;
}

function makeHtml(rows, meta, svg) {
  const dataJson = JSON.stringify(rows);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Rujira App Layer Base Layer Payments</title>
  <style>
    body {
      margin: 0;
      background: #f7f4ed;
      color: #111827;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1440px, calc(100vw - 32px));
      margin: 24px auto;
    }
    .chart {
      overflow-x: auto;
      border: 1px solid #ded8cc;
      background: #f7f4ed;
    }
    svg {
      display: block;
      max-width: none;
    }
    table {
      width: 100%;
      margin-top: 18px;
      border-collapse: collapse;
      font-size: 13px;
      background: #fffdf8;
    }
    th, td {
      padding: 8px 10px;
      border-bottom: 1px solid #e5dfd4;
      text-align: right;
      white-space: nowrap;
    }
    th:first-child, td:first-child {
      text-align: left;
    }
    th {
      color: #374151;
      font-weight: 720;
    }
    caption {
      text-align: left;
      color: #4b5563;
      padding: 0 0 8px;
      font-weight: 650;
    }
  </style>
</head>
<body>
  <main>
    <div class="chart">${svg.replace(/^<\?xml[^>]+>\n/, "")}</div>
    <table>
      <caption>Weekly source data</caption>
      <thead>
        <tr>
          <th>Week</th>
          <th>Payments</th>
          <th>Paid RUNE</th>
          <th>RUNE/USD</th>
          <th>Paid USD</th>
          <th>Cumulative USD</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </main>
  <script>
    const rows = ${dataJson};
    const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
    const fmtRune = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
    const fmtPrice = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });
    document.getElementById("rows").innerHTML = rows.map((row) => \`
      <tr>
        <td>\${row.week_start} to \${row.week_end}</td>
        <td>\${row.payments}</td>
        <td>\${fmtRune.format(row.payment_rune)}</td>
        <td>\${fmtPrice.format(row.rune_price_usd)}</td>
        <td>\${fmtUsd.format(row.payment_usd)}</td>
        <td>\${fmtUsd.format(row.cumulative_usd)}</td>
      </tr>\`).join("");
  </script>
</body>
</html>
`;
}

async function main() {
  await Promise.all([OUTPUT_DIR, WEBSITE_OUTPUT_DIR].map((dir) => mkdir(dir, { recursive: true })));
  const generatedAt = new Date().toISOString();
  const config = await fetchRevenueConfig();
  process.stderr.write(`reserve target ${config.reserveTarget}\n`);

  const actions = await fetchActions();
  process.stderr.write(`fetched ${actions.length} revenue run actions\n`);

  const events = await fetchReserveEvents(actions, config.reserveTarget);
  if (!events.length) {
    throw new Error("No reserve events found for the base-layer revenue collector");
  }
  process.stderr.write(`found ${events.length} reserve deposits\n`);

  const firstWeek = startOfUtcWeek(events[0].date);
  const lastWeek = startOfUtcWeek(events.at(-1).date);
  const weekCount =
    Math.ceil((lastWeek.getTime() - firstWeek.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 2;
  const priceWeeks = await fetchRunePriceWeeks(Math.floor(firstWeek.getTime() / 1000), weekCount);
  const rows = aggregateWeekly(events, priceWeeks);
  const meta = {
    generatedAt,
    eventCount: events.length,
    actionCount: actions.length,
    reserveCollector: BASE_LAYER_REVENUE_COLLECTOR,
    reserveTarget: config.reserveTarget,
    targetDenoms: config.targetDenoms,
    targetAddresses: config.targetAddresses,
    sourceMidgard: MIDGARD_BASE,
    sourceThornode: THORNODE_BASE,
    sourceRpc: RPC_BASES,
  };

  const svg = makeSvg(rows, meta);
  const html = makeHtml(rows, meta, svg);
  const files = [
    ["rujira-base-layer-fees.csv", `${toCsv(rows)}\n`],
    ["rujira-base-layer-fees-events.json", `${JSON.stringify(events, null, 2)}\n`],
    ["rujira-base-layer-fees-meta.json", `${JSON.stringify(meta, null, 2)}\n`],
    ["rujira-base-layer-fees.svg", svg],
    ["rujira-base-layer-fees.html", html],
  ];
  await Promise.all(
    [OUTPUT_DIR, WEBSITE_OUTPUT_DIR].flatMap((dir) =>
      files.map(([fileName, contents]) => writeFile(path.join(dir, fileName), contents)),
    ),
  );

  const last = rows.at(-1);
  process.stdout.write(
    [
      `wrote ${OUTPUT_DIR}`,
      `weeks: ${rows.length}`,
      `reserve deposits: ${events.length}`,
      `cumulative: ${money(last.cumulative_usd)} / ${rune(last.cumulative_rune)}`,
    ].join("\n") + "\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
