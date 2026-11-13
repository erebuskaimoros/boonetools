const DAY_MS = 24 * 60 * 60 * 1000;
const E8 = 100_000_000;

// Same symbols as isStablecoin in shared/blockchain.js. That helper only splits
// layer-1 `CHAIN.SYMBOL` notation case-sensitively, so trade (`CHAIN~SYMBOL`)
// and secured (`CHAIN-SYMBOL`) assets are classified here instead.
export const STABLE_SWAP_SYMBOLS = Object.freeze(['USDC', 'USDT', 'DAI', 'GUSD', 'LUSD', 'USDP', 'BUSD']);

// CHAIN, then `.` (layer 1), `~` (trade) or `-` (secured), then the symbol,
// followed by a contract suffix or the end. Written in the shared subset of
// JavaScript and PostgreSQL regular expressions so the SQL prefilter and this
// module classify identically; match it case-insensitively.
export const STABLE_SWAP_ASSET_PATTERN = `^[A-Z0-9]+[.~-](${STABLE_SWAP_SYMBOLS.join('|')})(-|$)`;
const STABLE_SWAP_ASSET = new RegExp(STABLE_SWAP_ASSET_PATTERN, 'i');

export function stableSwapSymbol(asset) {
  const match = STABLE_SWAP_ASSET.exec(String(asset ?? '').trim());
  return match ? match[1].toUpperCase() : '';
}

export function isStableSwapRoute(inputAsset, outputAsset) {
  return Boolean(stableSwapSymbol(inputAsset) && stableSwapSymbol(outputAsset));
}

function e8(value) {
  if (value == null || value === '') return 0n;
  try { return BigInt(String(value).split('.')[0]); } catch { return 0n; }
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayMs(day) {
  return Date.parse(`${String(day).slice(0, 10)}T00:00:00Z`);
}

/**
 * Builds one entry per UTC day from fromDay to toDay inclusive. Rows are
 * grouped by day and route; days without rows are zero-filled because rolling
 * averages downstream must see the empty days.
 */
export function buildStableSwapDays(rows = [], { fromDay, toDay, currentDay = '' } = {}) {
  const from = dayMs(fromDay);
  const to = dayMs(toDay);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return [];

  const totals = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isStableSwapRoute(row?.input_asset, row?.output_asset)) continue;
    const day = row.day instanceof Date ? dayKey(row.day.getTime()) : String(row.day ?? '').slice(0, 10);
    const total = totals.get(day) || { swaps: 0n, inputE8: 0n, feeRuneE8: 0n, feeUsdE8: 0n, priced: false };
    total.swaps += e8(row.swaps);
    total.inputE8 += e8(row.input_e8);
    total.feeRuneE8 += e8(row.fee_rune_e8);
    if (row.fee_usd_e8 != null && row.fee_usd_e8 !== '') {
      total.feeUsdE8 += e8(row.fee_usd_e8);
      total.priced = true;
    }
    totals.set(day, total);
  }

  const days = [];
  for (let ms = from; ms <= to; ms += DAY_MS) {
    const day = dayKey(ms);
    const total = totals.get(day);
    const swaps = total ? Number(total.swaps) : 0;
    days.push({
      day,
      swaps,
      // Both sides are stablecoins, so one input unit is treated as one USD.
      volume_usd: total ? Number(total.inputE8) / E8 : 0,
      fees_rune: total ? Number(total.feeRuneE8) / E8 : 0,
      // Null only when the day has swaps and none of them could be priced.
      fees_usd: total && swaps > 0 && !total.priced ? null : (total ? Number(total.feeUsdE8) / E8 : 0),
      partial: day === currentDay
    });
  }
  return days;
}
