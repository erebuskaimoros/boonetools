import { calendarDays, dayTime, nextDay, NEAR_NET_SUPPLY_METHOD } from '../../../shared/protocol-fee-comparison/model.js';
import { NEAR_RPC } from './near.js';

export { NEAR_NET_SUPPLY_METHOD };
const INDEX = 'https://api.nearblocks.io/v3/blocks';
const atomic = value => typeof value === 'string' && /^\d+$/.test(value);
const nanoseconds = day => BigInt(dayTime(day)) * 1_000_000n;

function header(block) {
  const h = block?.header;
  if (!h || !Number.isSafeInteger(h.height) || !h.hash || !atomic(h.total_supply)
    || !atomic(h.timestamp_nanosec)) throw new Error('Malformed NEAR supply header');
  return { height: h.height, hash: h.hash, prev_height: h.prev_height, prev_hash: h.prev_hash,
    total_supply: h.total_supply, timestamp_nanosec: h.timestamp_nanosec };
}

/** Supply immediately BEFORE midnight: a block at midnight belongs to the new day. */
export function verifyNearSupplyBoundary(day, before, after) {
  const target = nanoseconds(day);
  if (!atomic(before?.total_supply) || !atomic(after?.total_supply)
    || !atomic(before?.timestamp_nanosec) || !atomic(after?.timestamp_nanosec)
    || !Number.isSafeInteger(before.height) || !Number.isSafeInteger(after.height)
    || !before.hash || !after.hash || after.prev_hash !== before.hash
    || after.prev_height !== before.height || after.height <= before.height
    || BigInt(before.timestamp_nanosec) >= target || BigInt(after.timestamp_nanosec) < target) {
    throw new Error(`Unverified NEAR UTC supply boundary ${day}`);
  }
  return { method: NEAR_NET_SUPPLY_METHOD, before, after };
}

export function nearNetSupplyDays(boundaries, startDay, endDay) {
  return calendarDays(startDay, endDay).map(day => {
    const start = boundaries[day], end = boundaries[nextDay(day)];
    for (const [date, point] of [[day, start], [nextDay(day), end]]) {
      if (point?.method !== NEAR_NET_SUPPLY_METHOD) throw new Error(`Missing NEAR supply boundary ${date}`);
      verifyNearSupplyBoundary(date, point.before, point.after);
    }
    // Subtract as integers BEFORE converting to the display/pricing unit.
    const delta = BigInt(end.before.total_supply) - BigInt(start.before.total_supply);
    return { day, nearNetIssuanceAtomic: delta.toString(), nearNetIssuanceMethod: NEAR_NET_SUPPLY_METHOD };
  });
}

/** Indexer provides height hints only. Canonical archive headers prove the accounting boundaries. */
export async function collectNearNetSupply({ request, boundaries = {}, startDay, endDay, save = async () => {}, log = () => {} }) {
  let sequence = 0;
  async function block(params) {
    const response = await request(NEAR_RPC, { method: 'POST', body: { jsonrpc: '2.0', id: ++sequence, method: 'block', params } });
    if (response?.error || !response?.result) throw new Error(`NEAR supply archive: ${response?.error?.cause?.name || 'missing block'}`);
    return header(response.result);
  }
  const head = await block({ finality: 'final' });
  if (BigInt(head.timestamp_nanosec) < nanoseconds(endDay)) throw new Error('NEAR archive is behind the completed-day cutoff');
  const dates = [...calendarDays(startDay, endDay), endDay].reverse();
  for (const day of dates) {
    const cached = boundaries[day];
    if (cached?.method === NEAR_NET_SUPPLY_METHOD) {
      verifyNearSupplyBoundary(day, cached.before, cached.after);
      if (cached.after.height > head.height) throw new Error('NEAR cached supply boundary is ahead of finalized head');
      continue;
    }
    // Nearblocks' public cursor is base64(JSON({timestamp})); prev uses >.
    const cursor = Buffer.from(JSON.stringify({ timestamp: (nanoseconds(day) - 1n).toString() })).toString('base64');
    const hint = await request(`${INDEX}?limit=1&prev=${encodeURIComponent(cursor)}`);
    const candidate = hint?.data?.[0], height = Number(candidate?.block_height);
    if (hint?.data?.length !== 1 || !Number.isSafeInteger(height) || height <= 0 || height > head.height) {
      throw new Error(`NEAR supply boundary hint unavailable or unfinalized ${day}`);
    }
    const after = await block({ block_id: height });
    if (after.height !== height || after.hash !== candidate.block_hash) throw new Error(`NEAR supply index/archive mismatch ${day}`);
    const before = await block({ block_id: after.prev_hash });
    const proof = verifyNearSupplyBoundary(day, before, after);
    // Only durable, fully verified boundaries are reused after interruption.
    boundaries[day] = proof;
    await save();
    log(`NEAR net-supply boundary verified ${day} (${before.height} → ${after.height})`);
  }
  // Initial migration is all-or-nothing for derived days; checkpoints retain
  // boundary work without replacing a complete gross-method chart with gaps.
  return nearNetSupplyDays(boundaries, startDay, endDay);
}
