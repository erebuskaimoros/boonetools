import { dayTime, nextDay } from '../../../shared/protocol-fee-comparison/model.js';

export const CHAINFLIP_RPC = 'https://mainnet-archive.chainflip.io';
const TIMESTAMP_KEY = '0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb';
// Reviewed historical emissions + delegation paths; source references and
// boundary-block reconciliation are in knowledge/protocol-fee-comparison.md.
// Untagged 2.2.10 is separately pinned to its reviewed deployed WASM.
// Delegated runtimes refresh every 150 blocks before authorship; all cuts,
// including the operator's rounding remainder, sum exactly to the mint budget.
// Legacy runtimes use the separately guarded one-block-delayed rate below.
// Unknown runtimes fail closed, especially the future FLIP 2.1 fee-funded path.
export const LEGACY_CHAINFLIP_RUNTIMES = new Set([11003, 11005, 11006]);
export const AUDITED_CHAINFLIP_RUNTIMES = new Set([
  11100, 11101, 11102, 11103, 11104, 11105, 11106, 11107, 11108, 11109, 11110, 11111, 11112,
  11200, 11201, 11202, 11203, 11204, 11205, 11206, 11207,
  20000, 20002, 20003, 20004, 20005, 20006, 20007, 20008, 20009, 20010, 20011, 20012, 20013,
  20100, 20101, 20102, 20103, 20104, 20105, 20106, 20107, 20108, 20109, 20110, 20111,
  20112, 20113, 20114, 20115, 20116, 20117, 20118, 20119, 20120,
  20200, 20201, 20202, 20203, 20204, 20205, 20206, 20207, 20208, 20209, 20210, 20211, 20212, 20213, 20214
]);
export const CHAINFLIP_20210_CODE_HASH = '0xc4a17f29d03d3d0bb084e48d356b049cd22a3f55cbe99578e565eb5e83254cbc';
export const COMPOUNDING_BLOCKS = 150;

function runtimeReview(message) {
  return Object.assign(new Error(`${message}; no subsidy estimate substituted`), { code: 'CHAINFLIP_RUNTIME_REVIEW' });
}

export function decodeLittleEndian(hex) {
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(hex || '')) throw new Error('Invalid Chainflip storage value');
  return BigInt(`0x${hex.slice(2).match(/../g).reverse().join('')}`);
}

export function sumIssuanceSegments(startHeight, endHeight, checkpoints) {
  if (!Number.isSafeInteger(startHeight) || endHeight <= startHeight || checkpoints[0]?.height !== startHeight) {
    throw new Error('Incomplete Chainflip issuance range');
  }
  let total = 0n;
  checkpoints.forEach((point, index) => {
    const end = checkpoints[index + 1]?.height ?? endHeight;
    if (end <= point.height || end > endHeight || BigInt(point.amount) < 0n) throw new Error('Invalid issuance checkpoint');
    total += BigInt(point.amount) * BigInt(end - point.height);
  });
  return total.toString();
}

/** Safe historical getters only. No archive event scan, net-supply proxy, or extrapolation. */
export function createChainflipReader({ request, boundaries = {} }) {
  let sequence = 0;
  const blocks = new Map();
  const versions = new Map();
  const rates = new Map();
  async function batch(calls) {
    const results = [];
    for (let i = 0; i < calls.length; i += 40) {
      const messages = calls.slice(i, i + 40).map(([method, params]) => ({ jsonrpc: '2.0', id: ++sequence, method, params }));
      const payload = await request(CHAINFLIP_RPC, { method: 'POST', body: messages });
      if (!Array.isArray(payload)) throw new Error('Chainflip RPC batch unavailable');
      const indexed = new Map(payload.map((row) => [row.id, row]));
      for (const message of messages) {
        const row = indexed.get(message.id);
        if (!row || row.error || row.result === undefined || row.result === null) {
          throw new Error(`Chainflip ${message.method}: ${row?.error?.message || 'missing historical state'}`);
        }
        results.push(row.result);
      }
    }
    return results;
  }
  const rpc = async (method, params = []) => (await batch([[method, params]]))[0];
  async function hashes(heights) {
    const missing = [...new Set(heights)].filter((height) => !blocks.has(height));
    const values = await batch(missing.map((height) => ['chain_getBlockHash', [height]]));
    missing.forEach((height, i) => blocks.set(height, { height, hash: values[i] }));
    return heights.map((height) => blocks.get(height));
  }
  async function block(height) {
    const [result] = await hashes([height]);
    if (result.timestamp === undefined) result.timestamp = Number(decodeLittleEndian(await rpc('state_getStorage', [TIMESTAMP_KEY, result.hash])));
    return result;
  }
  async function runtime(height) {
    if (!versions.has(height)) {
      const [entry] = await hashes([height]);
      const version = await rpc('state_getRuntimeVersion', [entry.hash]);
      if (version.specName !== 'chainflip-node' || (!AUDITED_CHAINFLIP_RUNTIMES.has(version.specVersion) && !LEGACY_CHAINFLIP_RUNTIMES.has(version.specVersion))) {
        throw runtimeReview(`Chainflip runtime ${version.specVersion} needs issuance review`);
      }
      if (version.specVersion === 20210 && await rpc('state_getStorageHash', ['0x3a636f6465', entry.hash]) !== CHAINFLIP_20210_CODE_HASH) {
        throw runtimeReview('Chainflip runtime 20210 code hash needs issuance review');
      }
      versions.set(height, version.specVersion);
    }
    return versions.get(height);
  }
  let finalized;
  async function head() {
    if (!finalized) {
      const hash = await rpc('chain_getFinalizedHead');
      const header = await rpc('chain_getHeader', [hash]);
      finalized = await block(Number(BigInt(header.number)));
    }
    return finalized;
  }
  async function boundary(day) {
    if (boundaries[day]) {
      const cached = boundaries[day];
      if (cached.source === 'chainflip-explorer-boundary') {
        const current = await block(cached.height), previous = await block(cached.height - 1);
        if (current.hash !== cached.hash || !(previous.timestamp < dayTime(day) && current.timestamp >= dayTime(day))) {
          throw new Error(`Unverified Chainflip day boundary ${day}`);
        }
        boundaries[day] = current;
      }
      return boundaries[day];
    }
    const latest = await head();
    const target = dayTime(day);
    if (target > latest.timestamp) throw new Error(`Chainflip has not finalized ${day}`);
    let low = 1, high = latest.height;
    // Reuse verified daily boundaries during sequential backfills.
    for (const [knownDay, entry] of Object.entries(boundaries)) {
      if (knownDay < day) low = Math.max(low, entry.height);
      if (knownDay > day) high = Math.min(high, entry.height);
    }
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((await block(middle)).timestamp < target) low = middle + 1;
      else high = middle;
    }
    const result = await block(low);
    const previous = await block(low - 1);
    if (!(previous.timestamp < target && result.timestamp >= target)) throw new Error(`Unverified Chainflip day boundary ${day}`);
    boundaries[day] = result;
    return result;
  }
  async function upgrades(start, end, leftVersion, rightVersion) {
    if (leftVersion === rightVersion) return [];
    if (end - start === 1) return [end];
    const middle = Math.floor((start + end) / 2);
    const version = await runtime(middle);
    return [...await upgrades(start, middle, leftVersion, version), ...await upgrades(middle, end, version, rightVersion)];
  }
  async function issuance(day) {
    const start = await boundary(day), end = await boundary(nextDay(day));
    const firstVersion = await runtime(start.height - 1), lastVersion = await runtime(end.height - 1);
    const changes = await upgrades(start.height - 1, end.height - 1, firstVersion, lastVersion);
    const heights = new Set([start.height]);
    const hasLegacy = LEGACY_CHAINFLIP_RUNTIMES.has(firstVersion);
    for (let height = Math.ceil(start.height / COMPOUNDING_BLOCKS) * COMPOUNDING_BLOCKS; height < end.height; height += COMPOUNDING_BLOCKS) {
      heights.add(height);
      // Before delegation, Emissions minted before Reputation compounded.
      if (hasLegacy && height + 1 < end.height) heights.add(height + 1);
    }
    for (const height of changes) {
      if (height >= start.height) heights.add(height);
      if (height + 1 < end.height) heights.add(height + 1);
    }
    const sorted = [...heights].sort((a, b) => a - b);
    const versionAtExecution = (height) => {
      const change = changes.findLast(point => point < height);
      return change === undefined ? firstVersion : versions.get(change);
    };
    const rateHeights = sorted.map(height => LEGACY_CHAINFLIP_RUNTIMES.has(versionAtExecution(height)) ? height - 1 : height);
    const missing = [...new Set(rateHeights)].filter((height) => !rates.has(height));
    const entries = await hashes(missing);
    const values = await batch(entries.map(({ hash }) => ['cf_authority_emission_per_block', [hash]]));
    missing.forEach((height, i) => rates.set(height, BigInt(values[i]).toString()));
    if (hasLegacy) {
      const backupHeights = [...new Set([...rateHeights, end.height - 1])].filter(height => LEGACY_CHAINFLIP_RUNTIMES.has(versionAtExecution(height + 1)));
      const backupBlocks = await hashes(backupHeights);
      const backupRates = await batch(backupBlocks.map(({ hash }) => ['cf_backup_emission_per_block', [hash]]));
      if (backupRates.some(amount => BigInt(amount) !== 0n)) throw runtimeReview('Nonzero legacy Chainflip backup rewards need event-level accounting');
    }
    const checkpoints = sorted.map((height, index) => ({ height, amount: rates.get(rateHeights[index]) }));
    return { day, atomic: sumIssuanceSegments(start.height, end.height, checkpoints), start, end,
      runtimes: [...new Set([firstVersion, lastVersion, ...changes.map((height) => versions.get(height))])],
      checkpoints, method: hasLegacy ? 'historical-onchain-legacy-emission-segments-v1' : 'historical-onchain-emission-segments-v1' };
  }
  return { issuance, boundary, boundaries, head };
}
