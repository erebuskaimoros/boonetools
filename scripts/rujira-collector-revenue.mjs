#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const THORNODE_BASE = process.env.THORNODE_BASE || "https://gateway.liquify.com/chain/thorchain_api";
const RPC_BASE = process.env.RPC_BASE || "https://gateway.liquify.com/chain/thorchain_rpc";
const OUTPUT_DIR = path.resolve(
  existsSync("website") ? "website/public/data/rujira-base-layer-fees" : "public/data/rujira-base-layer-fees",
);
const START_HEIGHT = Number(process.env.START_HEIGHT || 25_900_000);
const PER_PAGE = 100;

const COLLECTORS = [
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
    key: "swap",
    name: "RUJI Swap",
    address: "thor1mcy9jtp4kzl8q2lvdgfgsl8jvqrf504uphkf0pz2p9wud8tsntesjvccew",
  },
  {
    key: "index",
    name: "RUJI Index",
    address: "thor132u9qpm9gfdqtgwxwl8ty409s6zmewfrum2k6wvtvtyphdn5urzsej764l",
  },
];

const CLIENT_HEADERS = {
  accept: "application/json",
  "user-agent": "boonetools-rujira-collector-revenue/1.0",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: CLIENT_HEADERS,
        signal: AbortSignal.timeout(45_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 180)}`);
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      await sleep(500 * attempt);
    }
  }
  throw lastError;
}

function txSearchUrl(query, page = 1) {
  const params = new URLSearchParams({
    query: JSON.stringify(query),
    per_page: String(PER_PAGE),
    page: String(page),
    order_by: JSON.stringify("asc"),
  });
  return `${RPC_BASE}/tx_search?${params}`;
}

function attrValues(event, key) {
  return event.attributes?.filter((attr) => attr.key === key).map((attr) => attr.value) || [];
}

function parseCoins(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((coin) => coin.match(/^(\d+)(.+)$/))
    .filter(Boolean)
    .map(([, amount, denom]) => ({ amount: Number(amount), denom }));
}

function transferEvents(tx, predicate) {
  const transfers = [];
  for (const event of tx.tx_result?.events || []) {
    if (event.type !== "transfer") continue;
    const recipients = attrValues(event, "recipient");
    const senders = attrValues(event, "sender");
    const amounts = attrValues(event, "amount");
    const count = Math.max(recipients.length, senders.length, amounts.length);

    for (let index = 0; index < count; index += 1) {
      const transfer = {
        recipient: recipients[index] || "",
        sender: senders[index] || "",
        amount: amounts[index] || "",
      };
      if (!predicate(transfer)) continue;
      for (const coin of parseCoins(amounts[index])) {
        transfers.push({
          sender: transfer.sender,
          recipient: transfer.recipient,
          denom: coin.denom,
          amountBase: coin.amount,
        });
      }
    }
  }
  return transfers;
}

function amountFromBase(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric / 1e8 : 0;
}

function denomToPoolAsset(denom) {
  if (!denom) return "";
  if (denom === "rune") return "THOR.RUNE";
  if (denom.startsWith("x/ghost-vault/")) {
    return denomToPoolAsset(denom.slice("x/ghost-vault/".length));
  }
  if (denom.startsWith("x/")) return `THOR.${denom.slice(2).toUpperCase()}`;
  if (denom.startsWith("thor.")) return denom.toUpperCase();
  if (!denom.includes("-")) return `THOR.${denom.toUpperCase()}`;
  const splitAt = denom.indexOf("-");
  return `${denom.slice(0, splitAt).toUpperCase()}.${denom.slice(splitAt + 1).toUpperCase()}`;
}

function isStableDenom(denom) {
  return /(?:usdc|usdt|dai|gusd|usdp)/i.test(denom || "");
}

async function fetchPrices() {
  const [network, pools] = await Promise.all([
    fetchJson(`${THORNODE_BASE}/thorchain/network`),
    fetchJson(`${THORNODE_BASE}/thorchain/pools`),
  ]);
  const runePriceUsd = amountFromBase(network.rune_price_in_tor);
  const poolPrices = Object.fromEntries(
    pools
      .filter((pool) => pool.asset && pool.asset_tor_price)
      .map((pool) => [pool.asset.toUpperCase(), amountFromBase(pool.asset_tor_price)]),
  );
  return { runePriceUsd, poolPrices };
}

function assetUsdPrice(denom, prices) {
  if (denom === "rune") return prices.runePriceUsd;
  const poolPrice = prices.poolPrices[denomToPoolAsset(denom)];
  if (poolPrice) return poolPrice;
  if (isStableDenom(denom)) return 1;
  return 0;
}

async function fetchStatusHeight() {
  const payload = await fetchJson(`${RPC_BASE}/status`);
  return Number(payload.result?.sync_info?.latest_block_height || 0);
}

async function fetchBalances(address) {
  const payload = await fetchJson(`${THORNODE_BASE}/cosmos/bank/v1beta1/balances/${address}`);
  return payload.balances || [];
}

function mergeTotals(target, source) {
  for (const [denom, value] of source) {
    const existing = target.get(denom) || {
      denom,
      amountBase: 0,
      transferCount: 0,
    };
    existing.amountBase += value.amountBase;
    existing.transferCount += value.transferCount;
    target.set(denom, existing);
  }
}

function addTotal(totals, denom, amountBase) {
  const existing = totals.get(denom) || {
    denom,
    amountBase: 0,
    transferCount: 0,
  };
  existing.amountBase += amountBase;
  existing.transferCount += 1;
  totals.set(denom, existing);
}

function summarizeTotals(totals, prices, amountParts = {}) {
  let pricedUsd = 0;
  const assets = [...totals.values()]
    .map((asset) => {
      const isSplitSummary = amountParts.distributed || amountParts.current;
      const distributedAmount = amountFromBase(
        isSplitSummary
          ? amountParts.distributed?.get(asset.denom)?.amountBase || 0
          : asset.amountBase || 0,
      );
      const currentAmount = amountFromBase(amountParts.current?.get(asset.denom)?.amountBase || 0);
      const amount = isSplitSummary
        ? distributedAmount + currentAmount
        : amountFromBase(asset.amountBase);
      const priceUsd = assetUsdPrice(asset.denom, prices);
      const usd = amount * priceUsd;
      if (priceUsd > 0) pricedUsd += usd;
      return {
        denom: asset.denom,
        amount,
        distributedAmount,
        currentAmount,
        priceUsd,
        usd,
        transferCount: asset.transferCount,
      };
    })
    .sort((a, b) => b.usd - a.usd || b.amount - a.amount);

  return {
    pricedUsd,
    pricedAssetCount: assets.filter((asset) => asset.priceUsd > 0).length,
    unpricedAssetCount: assets.filter((asset) => asset.priceUsd === 0).length,
    assets,
  };
}

async function fetchDistributionTxs(collector) {
  const query = `tx.height > ${START_HEIGHT} AND transfer.sender='${collector.address}'`;
  const first = await fetchJson(txSearchUrl(query, 1));
  const result = first.result || {};
  const total = Number(result.total_count || 0);
  if (!total) return [];

  const pages = Math.ceil(total / PER_PAGE);
  const txs = [];
  process.stderr.write(`${collector.key}: ${total} distribution txs\n`);

  for (let page = 1; page <= pages; page += 1) {
    const pageResult = page === 1 ? result : (await fetchJson(txSearchUrl(query, page))).result || {};
    txs.push(...(pageResult.txs || []));
    await sleep(35);
  }

  return txs;
}

async function scanCollector(collector, latestHeight, prices) {
  const distributedTotals = new Map();
  const distributedByRecipient = new Map();
  const currentTotals = new Map();
  const distributionTxs = await fetchDistributionTxs(collector);
  let distributionTransferCount = 0;

  for (const tx of distributionTxs) {
    for (const transfer of transferEvents(tx, (event) => event.sender === collector.address)) {
      distributionTransferCount += 1;
      addTotal(distributedTotals, transfer.denom, transfer.amountBase);

      const recipientTotals = distributedByRecipient.get(transfer.recipient) || new Map();
      addTotal(recipientTotals, transfer.denom, transfer.amountBase);
      distributedByRecipient.set(transfer.recipient, recipientTotals);
    }
  }

  for (const balance of await fetchBalances(collector.address)) {
    const amountBase = Number(balance.amount || 0);
    if (amountBase <= 0) continue;
    currentTotals.set(balance.denom, {
      denom: balance.denom,
      amountBase,
      transferCount: 0,
    });
  }

  const totals = new Map(distributedTotals);
  mergeTotals(totals, currentTotals);
  const summary = summarizeTotals(totals, prices, {
    distributed: distributedTotals,
    current: currentTotals,
  });
  const distributionRoutes = [...distributedByRecipient.entries()]
    .map(([recipient, routeTotals]) => {
      const routeSummary = summarizeTotals(routeTotals, prices);
      return {
        recipient,
        transferCount: [...routeTotals.values()].reduce((sum, asset) => sum + asset.transferCount, 0),
        ...routeSummary,
      };
    })
    .sort((a, b) => b.pricedUsd - a.pricedUsd || b.transferCount - a.transferCount);

  return {
    ...collector,
    latestHeight,
    distributionTxCount: distributionTxs.length,
    distributionTransferCount,
    distributionRoutes,
    ...summary,
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const [latestHeight, prices] = await Promise.all([fetchStatusHeight(), fetchPrices()]);
  const collectors = [];
  for (const collector of COLLECTORS) {
    collectors.push(await scanCollector(collector, latestHeight, prices));
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    startHeight: START_HEIGHT,
    latestHeight,
    basis: "all-time net collected: collector distributions plus current residual balances",
    pricing: "current THORNode pool asset_tor_price; stable denoms at $1; unpriced denoms excluded from pricedUsd",
    runePriceUsd: prices.runePriceUsd,
    collectors,
  };

  await writeFile(
    path.join(OUTPUT_DIR, "rujira-collector-revenue.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  process.stdout.write(
    collectors
      .map((collector) => `${collector.name}: $${collector.pricedUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`)
      .join("\n") + "\n",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
