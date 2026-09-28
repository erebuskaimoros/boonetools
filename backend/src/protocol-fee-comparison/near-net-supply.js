import { calendarDays, dayTime, nextDay, NEAR_NET_SUPPLY_METHOD } from '../../../shared/protocol-fee-comparison/model.js';
import { NEAR_RPC, isUnknownBlockError } from './near.js';

export { NEAR_NET_SUPPLY_METHOD };
const INDEX = 'https://coins.llama.fi/block/near';
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
  async function producedAtOrAfter(height) {
    for (let skip = 0; skip < 100 && height + skip <= head.height; skip++) {
      try {
        const found = await block({ block_id: height + skip });
        if (found.height !== height + skip) throw new Error('NEAR archive returned the wrong height');
        return found;
      } catch (error) { if (!isUnknownBlockError(error)) throw error; }
    }
    throw new Error('NEAR supply boundary has too many missing or unfinalized heights');
  }
  const dates = [...calendarDays(startDay, endDay), endDay].reverse();
  for (const day of dates) {
    const cached = boundaries[day];
    if (cached?.method === NEAR_NET_SUPPLY_METHOD) {
      verifyNearSupplyBoundary(day, cached.before, cached.after);
      if (cached.after.height > head.height) throw new Error('NEAR cached supply boundary is ahead of finalized head');
      continue;
    }
    const hint = await request(`${INDEX}/${dayTime(day) / 1000}`);
    const height = Number(hint?.height), target = nanoseconds(day);
    if (!Number.isSafeInteger(height) || height <= 1 || height > head.height) {
      throw new Error(`NEAR supply boundary hint unavailable or unfinalized ${day}`);
    }
    // The public closest-block index has second precision, not an exact UTC
    // boundary. Start one height earlier and walk canonical linked headers in
    // either direction. Never take its timestamp or supply as accounting data.
    let current = await producedAtOrAfter(height - 1), proof;
    for (let step = 0; step < 100; step++) {
      const timestamp = BigInt(current.timestamp_nanosec);
      if (timestamp < target - 300_000_000_000n || timestamp > target + 300_000_000_000n) {
        throw new Error(`NEAR supply boundary hint too far from midnight ${day}`);
      }
      if (timestamp >= target) {
        const previous = await block({ block_id: current.prev_hash });
        if (BigInt(previous.timestamp_nanosec) < target) { proof = verifyNearSupplyBoundary(day, previous, current); break; }
        if (current.prev_hash !== previous.hash || current.prev_height !== previous.height || previous.height >= current.height) throw new Error('Unverified NEAR supply parent link');
        current = previous;
      } else {
        const following = await producedAtOrAfter(current.height + 1);
        if (BigInt(following.timestamp_nanosec) >= target) { proof = verifyNearSupplyBoundary(day, current, following); break; }
        if (following.prev_hash !== current.hash || following.prev_height !== current.height) throw new Error('Unverified NEAR supply forward link');
        current = following;
      }
    }
    if (!proof) throw new Error(`NEAR supply boundary search exhausted ${day}`);
    // Only durable, fully verified boundaries are reused after interruption.
    boundaries[day] = proof;
    await save();
    log(`NEAR net-supply boundary verified ${day} (${proof.before.height} → ${proof.after.height})`);
  }
  // Initial migration is all-or-nothing for derived days; checkpoints retain
  // boundary work without replacing a complete gross-method chart with gaps.
  return nearNetSupplyDays(boundaries, startDay, endDay);
}
