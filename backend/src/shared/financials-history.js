import { BinaryReader } from 'cosmjs-types/binary.js';
import { DAY_SECONDS, integerAmount } from '../../../shared/financials/model.js';

export const FINANCIALS_MIDGARD = 'https://gateway.liquify.com/chain/thorchain_midgard/v2';
export const FINANCIALS_RPC = 'https://gateway.liquify.com/chain/thorchain_rpc';

// Decode only stable fields from types.QueryNodesResponse. The historical
// total_bond field was named bond; its protobuf field number remained 9.
// Source: ThorNode proto/thorchain/v1/types/query_node.proto.
export function decodeActiveBond(base64, requestedHeight) {
  const reader = new BinaryReader(Buffer.from(base64, 'base64'));
  let activeBond = 0n;
  let activeNodes = 0;
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if (tag !== 10) { reader.skipType(tag & 7); continue; }
    const node = new BinaryReader(reader.bytes());
    let nodeStatus = '';
    let bond = null;
    let statusSince = 0;
    while (node.pos < node.len) {
      const field = node.uint32();
      if (field === 18) nodeStatus = node.string();
      else if (field === 74) bond = integerAmount(node.string());
      else if (field === 56) statusSince = Number(node.int64());
      else node.skipType(field & 7);
    }
    if (statusSince > requestedHeight) throw new Error('Validator state is newer than the requested historical block');
    if (nodeStatus === 'Active') {
      if (bond === null) throw new Error('Active validator bond is missing');
      activeBond += BigInt(bond);
      activeNodes++;
    }
  }
  if (!activeNodes || activeBond <= 0n) throw new Error('Historical active bond is unavailable');
  return { activeBondE8: activeBond.toString(), activeNodes };
}

export async function fetchFinancialHistory(kind, { from, to, getJson, pageSize = 400, onPage = () => {} }) {
  if (!['swaps', 'earnings'].includes(kind)) throw new Error('Unknown Financials history source');
  const rows = new Map();
  for (let cursor = from; cursor < to;) {
    const count = Math.min(400, Math.max(1, Math.floor(pageSize)), Math.ceil((to - cursor) / DAY_SECONDS));
    // Midgard accepts at most two of count/from/to; never send all three.
    const params = new URLSearchParams({ interval: 'day', from: String(cursor), count: String(count) });
    const payload = await getJson(`${FINANCIALS_MIDGARD}/history/${kind}?${params}`);
    if (!Array.isArray(payload?.intervals)) throw new Error(`Invalid ${kind} history response`);
    const chunkEnd = cursor + count * DAY_SECONDS;
    const intervals = payload.intervals.filter((row) => Number(row.startTime) >= cursor && Number(row.startTime) < chunkEnd);
    // Reject ignored pagination instead of caching current data as old history.
    if (payload.intervals.length && !intervals.length) throw new Error(`${kind} history returned the wrong date range`);
    const compactRows = intervals.map(({ pools, ...row }) => row);
    for (const row of compactRows) rows.set(Number(row.startTime), row);
    await onPage(compactRows);
    cursor = chunkEnd;
  }
  return [...rows.values()].sort((a, b) => Number(a.startTime) - Number(b.startTime));
}

export async function findFinancialClosingBlock(to, anchor, { getJson, head }) {
  const watermark = head || (await getJson(`${FINANCIALS_MIDGARD}/health`))?.lastAggregated;
  let low = { height: Number(anchor.height), timestamp: Number(anchor.timestamp) };
  let high = { height: Number(watermark?.height), timestamp: Number(watermark?.timestamp) };
  if (!(low.height > 0 && high.height > low.height && low.timestamp < to && high.timestamp >= to)) {
    throw new Error('No verified closing-day block is available');
  }
  // Interpolate by observed block times, then prove the boundary with adjacent
  // headers. A bounded binary fallback also handles long chain halts.
  for (let attempt = 0; attempt < 32; attempt++) {
    const fraction = (to - low.timestamp) / (high.timestamp - low.timestamp);
    const guess = Math.max(low.height, Math.min(high.height - 1,
      attempt < 8 ? Math.floor(low.height + fraction * (high.height - low.height))
        : Math.floor((low.height + high.height) / 2)));
    const params = new URLSearchParams({ minHeight: String(guess), maxHeight: String(guess + 1) });
    const payload = await getJson(`${FINANCIALS_RPC}/blockchain?${params}`);
    const headers = (payload?.result?.block_metas || []).map((item) => ({
      height: Number(item.header?.height), timestamp: Date.parse(item.header?.time) / 1000
    })).sort((a, b) => a.height - b.height);
    const [before, after] = headers;
    if (headers.length !== 2 || before.height !== guess || after.height !== guess + 1
      || !Number.isFinite(before.timestamp) || !Number.isFinite(after.timestamp)
      || before.timestamp > after.timestamp) throw new Error('Invalid historical block-time response');
    if (before.timestamp < to && after.timestamp >= to) return before;
    if (after.timestamp < to) low = after;
    else high = before;
    if (low.height >= high.height) break;
  }
  throw new Error('Closing-day block-time search did not converge');
}

export async function fetchFinancialBondDay(dayStart, { getJson, head, to = dayStart + DAY_SECONDS }) {
  if (!(to > dayStart && to <= dayStart + DAY_SECONDS)) throw new Error('Invalid bond snapshot cutoff');
  const params = new URLSearchParams({ limit: '1', timestamp: String(to) });
  const actions = await getJson(`${FINANCIALS_MIDGARD}/actions?${params}`);
  const action = actions?.actions?.[0];
  let height = Number(action?.height);
  let timestamp = /^\d+$/.test(String(action?.date ?? '')) ? Number(BigInt(action.date) / 1_000_000_000n) : NaN;
  if (!Number.isSafeInteger(height) || height <= 0 || !Number.isFinite(timestamp)
    || timestamp >= to) {
    throw new Error('No verified closing-day block is available');
  }
  let blockTimeVerified = false;
  if (timestamp < dayStart) {
    ({ height, timestamp } = await findFinancialClosingBlock(to, { height, timestamp }, { getJson, head }));
    blockTimeVerified = true;
  }
  const query = new URLSearchParams({ path: '"/types.Query/Nodes"', data: '0x', height: String(height) });
  const payload = await getJson(`${FINANCIALS_RPC}/abci_query?${query}`);
  const response = payload?.result?.response;
  if (Number(response?.code) !== 0 || !response?.value) {
    const error = new Error(response?.log || payload?.error?.message || 'Historical validator state is unavailable');
    error.archiveUnavailable = /unknown (?:query|service)|no archive|version does not exist|height.*not available/i.test(error.message);
    throw error;
  }
  if (Number(response.height) !== height) throw new Error('RPC did not return the requested historical block');
  return {
    ...decodeActiveBond(response.value, height), height, timestamp, blockTimeVerified,
    source: 'liquify-rpc:types.Query/Nodes', fetchedAt: new Date().toISOString()
  };
}

// Unfinished Midgard day/hour/5min buckets can be zero-filled placeholders.
// Only sum complete five-minute intervals behind the indexed watermark.
export async function fetchFinancialLiveTotals(from, through, { getJson }) {
  const count = (through - from) / 300;
  if (!Number.isInteger(count) || count < 1 || count > 288) throw new Error('Invalid live interval window');
  const result = {};
  for (const [kind, fields] of Object.entries({
    swaps: ['totalVolume', 'totalVolumeUSD'],
    earnings: ['earnings', 'liquidityFees', 'blockRewards', 'bondingEarnings']
  })) {
    const params = new URLSearchParams({ interval: '5min', from: String(from), count: String(count) });
    const payload = await getJson(`${FINANCIALS_MIDGARD}/history/${kind}?${params}`);
    if (!Array.isArray(payload?.intervals)) throw new Error(`Invalid live ${kind} response`);
    const rows = new Map(payload.intervals.map((row) => [Number(row.startTime), row]));
    const totals = Object.fromEntries(fields.map((field) => [field, 0n]));
    let last;
    for (let start = from; start < through; start += 300) {
      const row = rows.get(start);
      if (!row || Number(row.endTime) !== start + 300) throw new Error(`Incomplete live ${kind} coverage`);
      for (const field of fields) {
        const value = integerAmount(row[field]);
        if (value === null) throw new Error(`Invalid live ${kind} ${field}`);
        totals[field] += BigInt(value);
      }
      last = row;
    }
    result[kind] = { ...Object.fromEntries(fields.map((field) => [field, totals[field].toString()])),
      runePriceUSD: last.runePriceUSD };
  }
  return result;
}
