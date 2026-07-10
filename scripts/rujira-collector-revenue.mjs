#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THORNODE_BASE = process.env.THORNODE_BASE || "https://gateway.liquify.com/chain/thorchain_api";
const RPC_BASE = process.env.RPC_BASE || "https://gateway.liquify.com/chain/thorchain_rpc";
const RUJIRA_API_URL = process.env.RUJIRA_API_URL || "https://api.rujira.network/api";
const WEBSITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(WEBSITE_ROOT, "public/data/rujira-base-layer-fees");
const START_HEIGHT = Number(process.env.START_HEIGHT || 25_900_000);
const SCHEDULE_START_HEIGHT = Number(process.env.SCHEDULE_START_HEIGHT || 25_980_001);
const SCHEDULE_BLOCKS = Number(process.env.SCHEDULE_BLOCKS || 101);
const SCHEDULE_SCAN_CONCURRENCY = Number(process.env.SCHEDULE_SCAN_CONCURRENCY || 10);
const PER_PAGE = 100;
const RUJIRA_DECIMALS = 1e12;
const BASE_LAYER_COLLECTOR = "thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr";
const RUJI_SWAP_REVENUE_COLLECTOR = "thor1mcy9jtp4kzl8q2lvdgfgsl8jvqrf504uphkf0pz2p9wud8tsntesjvccew";

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
    address: RUJI_SWAP_REVENUE_COLLECTOR,
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

async function fetchGraphql(query, variables = {}, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(RUJIRA_API_URL, {
        method: "POST",
        headers: {
          ...CLIENT_HEADERS,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(45_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 180)}`);
      const payload = JSON.parse(text);
      if (payload.errors?.length) {
        throw new Error(payload.errors.map((error) => error.message).join("; "));
      }
      return payload.data;
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

function queryUrl(base, params = {}) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
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

function transferEventsFromEvents(events, predicate) {
  const transfers = [];
  for (const [eventIndex, event] of (events || []).entries()) {
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
          eventIndex,
          transferIndex: index,
        });
      }
    }
  }
  return transfers;
}

function transferEvents(tx, predicate) {
  return transferEventsFromEvents(tx.tx_result?.events || [], predicate);
}

function amountFromBase(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric / 1e8 : 0;
}

function amountFromRujiraDecimal(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric / RUJIRA_DECIMALS : 0;
}

function normalizeDenom(denom) {
  return String(denom || "").toLowerCase();
}

function denomToPoolAsset(denom) {
  if (!denom) return "";
  const normalized = normalizeDenom(denom);
  if (normalized === "rune") return "THOR.RUNE";
  if (normalized.startsWith("x/ghost-vault/")) {
    return denomToPoolAsset(normalized.slice("x/ghost-vault/".length));
  }
  if (normalized.startsWith("x/")) {
    const symbol = normalized.slice(2);
    return symbol.includes("/") ? "" : `THOR.${symbol.toUpperCase()}`;
  }
  if (normalized.startsWith("thor.")) return normalized.toUpperCase();
  if (!normalized.includes("-")) return `THOR.${normalized.toUpperCase()}`;
  const splitAt = normalized.indexOf("-");
  return `${normalized.slice(0, splitAt).toUpperCase()}.${normalized.slice(splitAt + 1).toUpperCase()}`;
}

function isStableDenom(denom) {
  return /(?:usdc|usdt|dai|gusd|usdp)/i.test(denom || "");
}

async function fetchThorchainPrices() {
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

function assetId(value) {
  return Buffer.from(`Asset:${value}`).toString("base64");
}

function denomAssetCandidates(denom) {
  const normalized = normalizeDenom(denom);
  if (!normalized) return [];
  const candidates = new Set();
  if (normalized.startsWith("x/") || normalized.startsWith("thor.")) {
    candidates.add(normalized);
  }
  const poolAsset = denomToPoolAsset(normalized);
  if (poolAsset) candidates.add(poolAsset);
  if (normalized === "rune") {
    candidates.add("THOR.RUNE");
  } else if (normalized.startsWith("thor.")) {
    const symbol = normalized.slice("thor.".length);
    candidates.add(`THOR.${symbol.toUpperCase()}`);
    candidates.add(`x/${symbol}`);
  } else if (normalized.startsWith("x/") && !normalized.slice(2).includes("/")) {
    candidates.add(`THOR.${normalized.slice(2).toUpperCase()}`);
  }
  return [...candidates];
}

function putRujiraPrice(priceMap, denom, priceUsd, source, details = {}) {
  const normalized = normalizeDenom(denom);
  if (!normalized || !(priceUsd > 0)) return;
  if (priceMap.has(normalized)) return;
  priceMap.set(normalized, {
    priceUsd,
    priceSource: source,
    ...details,
  });
}

function putAssetNodePrice(priceMap, asset, sourcePrefix = "rujira:asset") {
  const priceUsd = amountFromRujiraDecimal(asset?.price?.current);
  if (!(priceUsd > 0)) return;
  const source = `${sourcePrefix}:${String(asset.price.source || "unknown").toLowerCase()}`;
  putRujiraPrice(priceMap, asset.variants?.native?.denom, priceUsd, source, {
    rujiraAsset: asset.asset,
    timestamp: asset.price.timestamp,
  });
  putRujiraPrice(priceMap, asset.asset, priceUsd, source, {
    rujiraAsset: asset.asset,
    timestamp: asset.price.timestamp,
  });
}

async function fetchRujiraAssetNodePriceChunk(ids, query, priceMap) {
  try {
    const data = await fetchGraphql(query, { ids }, 1);
    for (const node of data.nodes || []) {
      if (node?.__typename === "Asset") putAssetNodePrice(priceMap, node);
    }
  } catch (error) {
    if (ids.length <= 1) {
      process.stderr.write(`Rujira asset price skipped for ${ids[0]}: ${error.message}\n`);
      return;
    }
    const midpoint = Math.ceil(ids.length / 2);
    await fetchRujiraAssetNodePriceChunk(ids.slice(0, midpoint), query, priceMap);
    await fetchRujiraAssetNodePriceChunk(ids.slice(midpoint), query, priceMap);
  }
}

async function fetchRujiraAssetNodePrices(denoms, priceMap) {
  const assetCandidates = [...new Set([...denoms].flatMap(denomAssetCandidates))].filter(
    (candidate) => !candidate.includes("/") || candidate.startsWith("x/"),
  );
  const ids = assetCandidates.map(assetId);
  const query = `
    query CollectorAssetPrices($ids: [ID!]!) {
      nodes(ids: $ids) {
        __typename
        ... on Asset {
          asset
          metadata {
            symbol
            decimals
          }
          price {
            current
            source
            timestamp
          }
          variants {
            native {
              denom
            }
          }
        }
      }
    }
  `;

  for (let index = 0; index < ids.length; index += 50) {
    await fetchRujiraAssetNodePriceChunk(ids.slice(index, index + 50), query, priceMap);
  }
}

async function fetchRujiraProductPrices(priceMap) {
  const query = `
    query CollectorProductPrices {
      staking {
        pools {
          bondAsset {
            asset
            price {
              current
              source
              timestamp
            }
            variants {
              native {
                denom
              }
            }
          }
          receiptAsset {
            asset
            variants {
              native {
                denom
              }
            }
          }
          status {
            liquidBondSize
            liquidBondShares
          }
        }
      }
      index {
        shareAsset {
          asset
          variants {
            native {
              denom
            }
          }
        }
        status {
          navPerShare
        }
      }
      strategies(first: 100, typenames: ["GhostVault"]) {
        edges {
          node {
            __typename
            ... on GhostVault {
              asset {
                asset
                price {
                  current
                  source
                  timestamp
                }
                variants {
                  native {
                    denom
                  }
                }
              }
              status {
                depositPool {
                  ratio
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = await fetchGraphql(query);

  for (const pool of data.staking?.pools || []) {
    const bondPriceUsd = amountFromRujiraDecimal(pool.bondAsset?.price?.current);
    if (!(bondPriceUsd > 0)) continue;
    const bondSource = String(pool.bondAsset.price.source || "unknown").toLowerCase();
    putRujiraPrice(priceMap, pool.bondAsset?.variants?.native?.denom, bondPriceUsd, `rujira:staking-bond:${bondSource}`, {
      rujiraAsset: pool.bondAsset?.asset,
      timestamp: pool.bondAsset?.price?.timestamp,
    });

    const liquidBondSize = Number(pool.status?.liquidBondSize || 0);
    const liquidBondShares = Number(pool.status?.liquidBondShares || 0);
    if (liquidBondSize > 0 && liquidBondShares > 0) {
      putRujiraPrice(
        priceMap,
        pool.receiptAsset?.variants?.native?.denom,
        bondPriceUsd * (liquidBondSize / liquidBondShares),
        `rujira:staking-nav:${bondSource}`,
        {
          rujiraAsset: pool.receiptAsset?.asset,
          underlyingAsset: pool.bondAsset?.asset,
        },
      );
    }
  }

  for (const indexVault of data.index || []) {
    const priceUsd = amountFromRujiraDecimal(indexVault.status?.navPerShare);
    putRujiraPrice(priceMap, indexVault.shareAsset?.variants?.native?.denom, priceUsd, "rujira:index-nav", {
      rujiraAsset: indexVault.shareAsset?.asset,
    });
  }

  for (const edge of data.strategies?.edges || []) {
    const vault = edge?.node;
    if (vault?.__typename !== "GhostVault") continue;
    const underlyingDenom = vault.asset?.variants?.native?.denom;
    const underlyingPriceUsd = amountFromRujiraDecimal(vault.asset?.price?.current);
    const ratio = amountFromRujiraDecimal(vault.status?.depositPool?.ratio);
    if (!underlyingDenom || !(underlyingPriceUsd > 0) || !(ratio > 0)) continue;
    putRujiraPrice(
      priceMap,
      `x/ghost-vault/${underlyingDenom}`,
      underlyingPriceUsd * ratio,
      `rujira:ghost-vault:${String(vault.asset.price.source || "unknown").toLowerCase()}`,
      {
        underlyingAsset: vault.asset?.asset,
        timestamp: vault.asset?.price?.timestamp,
      },
    );
  }
}

async function fetchRujiraPrices(denoms) {
  const priceMap = new Map();
  try {
    await fetchRujiraProductPrices(priceMap);
  } catch (error) {
    process.stderr.write(`Rujira product pricing unavailable: ${error.message}\n`);
  }
  try {
    await fetchRujiraAssetNodePrices(denoms, priceMap);
  } catch (error) {
    process.stderr.write(`Rujira asset pricing unavailable: ${error.message}\n`);
  }
  return priceMap;
}

function isRujiraProductDenom(denom) {
  const normalized = normalizeDenom(denom);
  return (
    normalized.startsWith("x/staking-") ||
    normalized.startsWith("x/nami-index-") ||
    normalized.startsWith("x/ghost-vault/")
  );
}

function resolveAssetPrice(denom, prices) {
  const normalized = normalizeDenom(denom);
  if (normalized === "rune") {
    return { priceUsd: prices.runePriceUsd, priceSource: "thornode:network-rune_price_in_tor" };
  }

  if (isRujiraProductDenom(normalized)) {
    const rujiraProductPrice = prices.rujiraPrices?.get(normalized);
    if (rujiraProductPrice) return rujiraProductPrice;
  }

  const poolAsset = denomToPoolAsset(normalized);
  const poolPrice = prices.poolPrices[poolAsset];
  if (poolPrice) return { priceUsd: poolPrice, priceSource: "thornode:pool-asset_tor_price" };

  const rujiraPrice = prices.rujiraPrices?.get(normalized);
  if (rujiraPrice) return rujiraPrice;

  if (isStableDenom(normalized)) return { priceUsd: 1, priceSource: "stable-fallback" };
  return { priceUsd: 0, priceSource: "" };
}

async function fetchStatusHeight() {
  const payload = await fetchJson(`${RPC_BASE}/status`);
  return Number(payload.result?.sync_info?.latest_block_height || 0);
}

async function fetchBalances(address) {
  const payload = await fetchJson(`${THORNODE_BASE}/cosmos/bank/v1beta1/balances/${address}`);
  return payload.balances || [];
}

async function fetchCollectorConfigs() {
  const query = Buffer.from(JSON.stringify({ config: {} })).toString("base64");
  const entries = await Promise.all(
    COLLECTORS.map(async (collector) => {
      const payload = await fetchJson(
        `${THORNODE_BASE}/cosmwasm/wasm/v1/contract/${collector.address}/smart/${query}`,
      );
      const config = payload?.data;
      if (!Array.isArray(config?.target_addresses) || !config.target_addresses.length) {
        throw new Error(`${collector.key}: missing live target_addresses config`);
      }
      return [collector.key, config];
    }),
  );
  return new Map(entries);
}

async function fetchBlockResults(height) {
  return fetchJson(queryUrl(`${RPC_BASE}/block_results`, { height }));
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
      const { priceUsd, priceSource } = resolveAssetPrice(asset.denom, prices);
      const usd = amount * priceUsd;
      if (priceUsd > 0) pricedUsd += usd;
      return {
        denom: asset.denom,
        amount,
        distributedAmount,
        currentAmount,
        priceUsd,
        priceSource,
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
  const query = `transfer.sender='${collector.address}'`;
  const txs = [];
  let offset = 0;
  let total = 0;

  for (;;) {
    const url = queryUrl(`${THORNODE_BASE}/cosmos/tx/v1beta1/txs`, {
      query,
      "pagination.limit": PER_PAGE,
      "pagination.offset": offset,
      "pagination.count_total": "true",
      order_by: "ORDER_BY_ASC",
    });
    const payload = await fetchJson(url);
    const pageTxs = payload.tx_responses || [];
    total = Number(payload.total || total || 0);
    txs.push(
      ...pageTxs
        .filter((tx) => Number(tx.height || 0) > START_HEIGHT)
        .map((tx) => ({
          height: Number(tx.height || 0),
          hash: tx.txhash || "",
          tx_result: {
            events: tx.events || [],
          },
        })),
    );
    if (pageTxs.length < PER_PAGE || (total > 0 && offset + pageTxs.length >= total)) break;
    offset += pageTxs.length;
    await sleep(35);
  }

  process.stderr.write(`${collector.key}: ${txs.length} indexed distribution txs\n`);
  return txs;
}

async function fetchScheduledDistributionTransfers(latestHeight, collectorConfigs) {
  const collectorByAddress = new Map(COLLECTORS.map((collector) => [collector.address, collector]));
  const targetRecipientsByCollector = new Map(
    COLLECTORS.map((collector) => [
      collector.key,
      new Set((collectorConfigs.get(collector.key)?.target_addresses || []).map(([address]) => address)),
    ]),
  );
  const transfersByCollector = new Map(COLLECTORS.map((collector) => [collector.key, []]));
  const stopHeight = Math.max(SCHEDULE_START_HEIGHT, latestHeight);
  const heights = [];
  for (let height = SCHEDULE_START_HEIGHT; height <= stopHeight; height += SCHEDULE_BLOCKS) {
    if (height > START_HEIGHT) heights.push(height);
  }

  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= heights.length) return;

      const height = heights[index];
      const payload = await fetchBlockResults(height);
      const events = payload.result?.finalize_block_events || [];
      const transfers = transferEventsFromEvents(events, (event) => collectorByAddress.has(event.sender));
      for (const transfer of transfers) {
        const collector = collectorByAddress.get(transfer.sender);
        if (!collector) continue;
        const targetRecipients = targetRecipientsByCollector.get(collector.key);
        if (!targetRecipients?.has(transfer.recipient)) continue;
        transfersByCollector.get(collector.key)?.push({
          ...transfer,
          height,
        });
      }
      if (index % 100 === 0) {
        process.stderr.write(`scheduled distribution scan ${index + 1}/${heights.length}\n`);
      }
      await sleep(20);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(SCHEDULE_SCAN_CONCURRENCY, heights.length)) },
      () => worker(),
    ),
  );

  return transfersByCollector;
}

async function collectCollector(
  collector,
  latestHeight,
  targetRecipients,
  scheduledDistributionTransfers = [],
) {
  const distributedTotals = new Map();
  const distributedByRecipient = new Map();
  const currentTotals = new Map();
  let distributionTxCount = 0;
  let distributionTransferCount = 0;
  const seenTransfers = new Set();

  function recordDistributionTransfer(transfer) {
    const key = [
      transfer.height || "",
      transfer.sender,
      transfer.recipient,
      transfer.denom,
      transfer.amountBase,
      transfer.txHash || "",
      transfer.eventIndex ?? "",
      transfer.transferIndex ?? "",
    ].join("|");
    if (seenTransfers.has(key)) return;
    seenTransfers.add(key);
    distributionTransferCount += 1;
    addTotal(distributedTotals, transfer.denom, transfer.amountBase);

    const recipientTotals = distributedByRecipient.get(transfer.recipient) || new Map();
    addTotal(recipientTotals, transfer.denom, transfer.amountBase);
    distributedByRecipient.set(transfer.recipient, recipientTotals);
  }

  for (const transfer of scheduledDistributionTransfers) {
    recordDistributionTransfer(transfer);
  }

  try {
    const distributionTxs = await fetchDistributionTxs(collector);
    distributionTxCount = distributionTxs.length;
    for (const tx of distributionTxs) {
      for (const transfer of transferEvents(
        tx,
        (event) => event.sender === collector.address && targetRecipients.has(event.recipient),
      )) {
        recordDistributionTransfer({
          ...transfer,
          height: tx.height,
          txHash: tx.hash,
        });
      }
    }
  } catch (error) {
    process.stderr.write(`${collector.key}: indexed tx distribution scan unavailable: ${error.message}\n`);
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
  return {
    ...collector,
    latestHeight,
    distributionTxCount,
    distributionHeightCount: new Set(scheduledDistributionTransfers.map((transfer) => transfer.height)).size,
    distributionTransferCount,
    distributedTotals,
    currentTotals,
    totals,
    distributedByRecipient,
  };
}

function summarizeCollector(collected, prices) {
  const observedDistributions = summarizeTotals(collected.distributedTotals, prices);
  const currentResidual = summarizeTotals(collected.currentTotals, prices);
  const distributionRoutes = [...collected.distributedByRecipient.entries()]
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
    key: collected.key,
    name: collected.name,
    address: collected.address,
    latestHeight: collected.latestHeight,
    distributionTxCount: collected.distributionTxCount,
    distributionHeightCount: collected.distributionHeightCount,
    distributionTransferCount: collected.distributionTransferCount,
    distributionRoutes,
    observedDistributionUsd: observedDistributions.pricedUsd,
    observedDistributionPricedAssetCount: observedDistributions.pricedAssetCount,
    observedDistributionUnpricedAssetCount: observedDistributions.unpricedAssetCount,
    observedDistributionAssets: observedDistributions.assets,
    currentResidualUsd: currentResidual.pricedUsd,
    currentResidualPricedAssetCount: currentResidual.pricedAssetCount,
    currentResidualUnpricedAssetCount: currentResidual.unpricedAssetCount,
    currentResidualAssets: currentResidual.assets,
  };
}

function collectObservedDenoms(collectedRows) {
  const denoms = new Set();
  for (const collector of collectedRows) {
    for (const asset of collector.totals.values()) {
      denoms.add(asset.denom);
    }
  }
  return denoms;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const [latestHeight, thornodePrices, collectorConfigs] = await Promise.all([
    fetchStatusHeight(),
    fetchThorchainPrices(),
    fetchCollectorConfigs(),
  ]);
  const scheduledDistributionTransfers = await fetchScheduledDistributionTransfers(
    latestHeight,
    collectorConfigs,
  );
  const collected = [];
  for (const collector of COLLECTORS) {
    const config = collectorConfigs.get(collector.key);
    collected.push(
      await collectCollector(
        collector,
        latestHeight,
        new Set((config?.target_addresses || []).map(([address]) => address)),
        scheduledDistributionTransfers.get(collector.key) || [],
      ),
    );
  }
  const rujiraPrices = await fetchRujiraPrices(collectObservedDenoms(collected));
  const prices = {
    ...thornodePrices,
    rujiraPrices,
  };
  const collectors = collected.map((collector) => summarizeCollector(collector, prices));

  const payload = {
    generatedAt: new Date().toISOString(),
    startHeight: START_HEIGHT,
    scheduleStartHeight: SCHEDULE_START_HEIGHT,
    scheduleBlocks: SCHEDULE_BLOCKS,
    latestHeight,
    coverage: {
      startHeight: START_HEIGHT,
      scheduleStartHeight: SCHEDULE_START_HEIGHT,
      latestHeight,
    },
    basis:
      "Observed direct distributions to each collector's current configured target addresses since startHeight, plus a separate point-in-time current-balance snapshot. These are non-additive operational observations, not all-time revenue or historical USD-at-receipt accounting.",
    pricing:
      "current THORNode pool asset_tor_price; Rujira GraphQL Asset.price and product NAV/value ratios for app-layer and receipt denoms; stable denoms at $1; unpriced denoms excluded from pricedUsd",
    runePriceUsd: prices.runePriceUsd,
    rujiraPriceCount: rujiraPrices.size,
    collectorConfigs: Object.fromEntries(
      COLLECTORS.map((collector) => [
        collector.key,
        {
          targetAddresses: collectorConfigs.get(collector.key)?.target_addresses || [],
          targetDenoms: collectorConfigs.get(collector.key)?.target_denoms || [],
        },
      ]),
    ),
    collectors,
  };

  await writeFile(
    path.join(OUTPUT_DIR, "rujira-collector-revenue.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  process.stdout.write(
    collectors
      .map((collector) => `${collector.name}: $${collector.observedDistributionUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })} observed direct distributions`)
      .join("\n") + "\n",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
