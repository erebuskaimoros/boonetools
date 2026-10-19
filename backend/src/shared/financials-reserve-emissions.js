import { BinaryReader } from 'cosmjs-types/binary.js';
import { QueryBalanceRequest, QueryBalanceResponse } from 'cosmjs-types/cosmos/bank/v1beta1/query.js';

export const FINANCIAL_RESERVE_ADDRESS = 'thor1dheycdevq39qlkxs2a6wuuzyn4aqxhve4qxtxt';
const METHOD = 'historical-reserve-formula-v1';
const SUPPORTED_VERSION = '3.20.3';
const BLOCKS_PER_YEAR = '5256000';
const PRECISION = 10n ** 18n;
const INT64_MAX = (1n << 63n) - 1n;
const FIXED_REWARDS = new Set(['bond_reward', 'dev_fund_reward', 'income_burn',
  'tcy_stake_reward', 'marketing_fund_reward', 'pol_reserve_reward']);
const RELEVANT_MIMIRS = new Set(['EMISSIONCURVE', 'RESERVEMAXCAP']);

// Pinned source: THORNode v3.20.3 (b08d81f79275093b0fcb753e0d68ff1c16c51cb8),
// manager_network_current.go UpdateNetwork/calcBlockRewards/payPoolRewards and
// constants_v1.go. All positive rewards attributes are Reserve transfers made
// before the rewards event. Saver yield mints synths; it does not debit Reserve.
// SDK math v1.5.3 uses 18-decimal Quo and RoundInt64 with half-to-even rounding.
// Unknown protocol versions/config transitions intentionally require review.
function integer(value, label, { signed = false } = {}) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`Invalid ${label}`);
  const text = String(value ?? '');
  if (!(signed ? /^-?\d+$/ : /^\d+$/).test(text)) throw new Error(`Invalid ${label}`);
  return BigInt(text);
}

function checkedHeight(value) {
  const height = Number(value);
  if (!Number.isSafeInteger(height) || height < 1) throw new Error('Invalid Reserve block height');
  return height;
}

function decoded(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9+/]+=*$/.test(text) && text.length > 1) {
    const candidate = Buffer.from(text, 'base64').toString('utf8');
    if (candidate && /^[\x20-\x7e]+$/.test(candidate)) return candidate;
  }
  return text;
}

function attributes(event) {
  if (!Array.isArray(event.attributes)) throw new Error('Missing Reserve event attributes');
  const result = new Map();
  for (const item of event.attributes) {
    const key = decoded(item.key);
    if (result.has(key)) throw new Error(`Duplicate Reserve event attribute ${key}`);
    result.set(key, decoded(item.value));
  }
  return result;
}

function runeCoins(value) {
  if (typeof value !== 'string' || !value) throw new Error('Invalid Reserve coin amount');
  let result = 0n;
  const denoms = new Set();
  for (const coin of value.split(',')) {
    const match = /^(\d+)([A-Za-z][A-Za-z0-9/:._-]*)$/.exec(coin);
    if (!match || denoms.has(match[2])) throw new Error('Invalid Reserve coin amount');
    denoms.add(match[2]);
    if (match[2] === 'rune') result += BigInt(match[1]);
  }
  return result;
}

function reserveMovement(type, attrs) {
  if (type === 'coin_spent' && attrs.get('spender') === FINANCIAL_RESERVE_ADDRESS) return -runeCoins(attrs.get('amount'));
  if (type === 'coin_received' && attrs.get('receiver') === FINANCIAL_RESERVE_ADDRESS) return runeCoins(attrs.get('amount'));
  return 0n;
}

function configurationChange(type, attrs) {
  if (type === 'version') {
    const version = attrs.get('version');
    if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Invalid Reserve version event');
    return { type: 'version', version };
  }
  if (type === 'set_mimir') {
    const key = (attrs.get('key') || '').toUpperCase();
    if (RELEVANT_MIMIRS.has(key)) return { type: 'mimir', key, value: integer(attrs.get('value'), 'Reserve Mimir value', { signed: true }).toString() };
  }
  return null;
}

// Compact enough to retain for every block. Missing transaction results cannot
// prove a complete bank delta: keep REVSHARE independently, but return null here
// until a full block_results response is available. Never sum transfer events as
// well as coin_spent/coin_received; those would count the same bank move twice.
export function parseFinancialReserveObservation(payload = {}, expectedHeight) {
  if (payload.error) throw new Error(payload.error.message || 'Reserve RPC response failed');
  const result = payload.result ?? payload;
  const finalize = result.result_finalize_block ?? result.result_end_block ?? result;
  const height = checkedHeight(result.height ?? result.block?.header?.height);
  if (expectedHeight !== undefined && height !== checkedHeight(expectedHeight)) throw new Error('Reserve response has the wrong block height');
  let events;
  if (Object.hasOwn(finalize, 'events')) events = finalize.events;
  else if (Object.hasOwn(finalize, 'finalize_block_events')) events = finalize.finalize_block_events;
  else if (Object.hasOwn(finalize, 'begin_block_events') && Object.hasOwn(finalize, 'end_block_events')) {
    events = [...(finalize.begin_block_events || []), ...(finalize.end_block_events || [])];
  } else return null;
  let transactions;
  if (Object.hasOwn(finalize, 'tx_results')) transactions = finalize.tx_results;
  else if (Object.hasOwn(result, 'txs_results')) transactions = result.txs_results;
  else return null;
  if (events !== null && !Array.isArray(events) || transactions !== null && !Array.isArray(transactions)) throw new Error('Invalid Reserve block events');
  let reserveDelta = 0n;
  let afterRewardsDelta = 0n;
  let rewardTransfers = 0n;
  let rewardEventCount = 0;
  const configChanges = [];
  const movements = [];
  const relevant = new Set(['coin_spent', 'coin_received', 'rewards', 'set_mimir', 'version']);
  for (const transaction of transactions || []) {
    const code = Number(transaction.code ?? 0);
    if (!Number.isInteger(code) || code < 0 || code > 0xffffffff) throw new Error('Invalid Reserve transaction result code');
    if (transaction.events !== null && !Array.isArray(transaction.events)) throw new Error('Missing Reserve transaction events');
    for (const entry of transaction.events || []) {
      const type = decoded(entry.type).toLowerCase();
      if (!relevant.has(type)) continue;
      const attrs = attributes(entry);
      const delta = reserveMovement(type, attrs);
      // THORNode v3.20.3 pins Cosmos SDK v0.53.0: BaseApp.runTx writes the
      // successful ante cache before executing messages in a separate cache.
      // BaseApp.deliverTx returns only anteEvents on failure (baseapp.go
      // lines 785–795, 915–955, 973–1025). A failed ante returns no events;
      // failed message effects/events are discarded. Therefore finalized
      // tx-result bank events remain committed even when code is nonzero.
      // Do not infer them from logs or count speculative message events.
      reserveDelta += delta;
      const change = configurationChange(type, attrs);
      if (change) configChanges.push(change);
      if (type === 'rewards') throw new Error('Unexpected transaction rewards event');
    }
  }
  for (const entry of events || []) {
    const type = decoded(entry.type).toLowerCase();
    if (!relevant.has(type)) continue;
    const attrs = attributes(entry);
    const delta = reserveMovement(type, attrs);
    reserveDelta += delta;
    if (delta !== 0n) movements.push(delta);
    if (rewardEventCount) afterRewardsDelta += delta;
    const change = configurationChange(type, attrs);
    if (change) configChanges.push(change);
    if (type !== 'rewards') continue;
    if (attrs.has('mode') && attrs.get('mode') !== 'EndBlock') throw new Error('Unexpected Reserve rewards event mode');
    let amount = 0n;
    let positive = 0;
    for (const [key, value] of attrs) {
      if (key === 'mode') continue;
      if (!FIXED_REWARDS.has(key) && !/^[A-Z0-9_]+\.[A-Z0-9._/-]+$/.test(key)) throw new Error(`Unknown Reserve reward attribute ${key}`);
      const reward = integer(value, 'Reserve rewards amount');
      amount += reward;
      if (reward > 0n) positive++;
    }
    if ([...FIXED_REWARDS].some(key => !attrs.has(key))) throw new Error('Incomplete Reserve rewards event');
    const payouts = positive ? movements.slice(-positive) : [];
    if (payouts.length !== positive || payouts.some(value => value >= 0n)
      || -payouts.reduce((sum, value) => sum + value, 0n) !== amount) throw new Error('Reserve rewards do not reconcile with bank transfers');
    rewardTransfers += amount;
    rewardEventCount++;
  }
  return { schemaVersion: 1, height, reserveDeltaE8: reserveDelta.toString(),
    afterRewardsDeltaE8: afterRewardsDelta.toString(), rewardTransfersE8: rewardTransfers.toString(),
    rewardEventCount, configChanges };
}

function bankersRound(numerator, denominator) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * 2n;
  return quotient + (twice > denominator || twice === denominator && quotient % 2n === 1n ? 1n : 0n);
}

export function calculateFinancialReserveEmissionE8(reserveBeforeRewardsE8, parameters) {
  if (parameters?.version !== SUPPORTED_VERSION) throw new Error(`Unsupported Reserve emissions version ${parameters?.version}`);
  if (String(parameters.blocksPerYear) !== BLOCKS_PER_YEAR) throw new Error('Unsupported Reserve blocks-per-year configuration');
  const reserve = integer(reserveBeforeRewardsE8, 'Reserve balance');
  if (reserve > INT64_MAX) throw new Error('Reserve balance exceeds protocol int64 range');
  const cap = integer(parameters.reserveMaxCapE8, 'Reserve cap');
  let curve = integer(parameters.emissionCurve, 'Reserve emission curve');
  if (cap > 0n && reserve > cap) curve = 6n;
  if (curve <= 0n || curve > INT64_MAX || cap > INT64_MAX) throw new Error('Invalid Reserve emission configuration');
  let decimal = reserve * PRECISION;
  // Replicate LegacyDec.Quo exactly: integer division at squared precision,
  // then bankers rounding to its fixed 18 fractional decimal places.
  decimal = bankersRound(decimal * PRECISION / curve, PRECISION);
  decimal = bankersRound(decimal * PRECISION / BigInt(BLOCKS_PER_YEAR), PRECISION);
  return bankersRound(decimal, PRECISION).toString();
}

// No extrapolation or implicit sorting: anchor is the post-block bank balance,
// and every complete observation must descend exactly one block from it.
export function replayFinancialReserveEmissions(observations, anchor) {
  let height = checkedHeight(anchor?.height);
  let balance = integer(anchor?.reserveBalanceE8, 'Reserve balance anchor');
  // Validate pinned parameters even for an empty range.
  calculateFinancialReserveEmissionE8(balance.toString(), anchor);
  if (!Array.isArray(observations)) throw new Error('Invalid Reserve observations');
  const blocks = [];
  for (const observation of observations) {
    if (observation?.schemaVersion !== 1 || checkedHeight(observation.height) !== height) throw new Error('Reserve observations must be contiguous descending heights');
    if (!Array.isArray(observation.configChanges) || observation.configChanges.length) throw new Error('Reserve configuration changed; a verified configuration boundary is required');
    if (observation.rewardEventCount !== 1) throw new Error('Exactly one verified rewards event is required');
    const delta = integer(observation.reserveDeltaE8, 'Reserve block delta', { signed: true });
    const after = integer(observation.afterRewardsDeltaE8, 'Reserve post-rewards delta', { signed: true });
    const rewards = integer(observation.rewardTransfersE8, 'Reserve rewards transfers');
    const atRewards = balance - after;
    const beforeRewards = atRewards + rewards;
    const previous = balance - delta;
    if (atRewards < 0n || previous < 0n) throw new Error('Reconstructed Reserve balance is negative');
    blocks.push({ height, reserveEmissionsE8: calculateFinancialReserveEmissionE8(beforeRewards.toString(), anchor),
      reserveBeforeRewardsE8: beforeRewards.toString() });
    balance = previous;
    height--;
  }
  return { blocks, previousHeight: height, previousReserveBalanceE8: balance.toString(), method: METHOD };
}

function responseBytes(payload, height) {
  const response = payload?.result?.response;
  if (Number(response?.code) !== 0 || typeof response?.value !== 'string') throw new Error(response?.log || payload?.error?.message || 'Historical Reserve state unavailable');
  if (Number(response.height) !== height) throw new Error('RPC did not return the requested Reserve state height');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.value)) throw new Error('Invalid historical Reserve state encoding');
  return Buffer.from(response.value, 'base64');
}

function readVersion(bytes) {
  const reader = new BinaryReader(bytes);
  let version;
  while (reader.pos < reader.len) {
    const field = reader.uint32();
    if (field === 10) version = reader.string();
    else reader.skipType(field & 7);
  }
  if (version !== SUPPORTED_VERSION) throw new Error(`Unsupported Reserve emissions version ${version}`);
  return version;
}

function readMimirs(bytes) {
  const reader = new BinaryReader(bytes);
  const values = new Map();
  while (reader.pos < reader.len) {
    const field = reader.uint32();
    if (field !== 10) { reader.skipType(field & 7); continue; }
    const item = new BinaryReader(reader.bytes());
    let key = '';
    let value = 0n; // proto3 omits int64 zero.
    while (item.pos < item.len) {
      const tag = item.uint32();
      if (tag === 10) key = item.string().toUpperCase();
      else if (tag === 16) value = item.int64();
      else item.skipType(tag & 7);
    }
    if (!key || values.has(key)) throw new Error('Invalid historical Reserve Mimir response');
    values.set(key, value);
  }
  return values;
}

export async function fetchFinancialReserveAnchor(requestedHeight, { getJson }) {
  const height = checkedHeight(requestedHeight);
  const query = async (route, data = new Uint8Array()) => {
    const params = new URLSearchParams({ path: JSON.stringify(route), data: `0x${Buffer.from(data).toString('hex')}`, height: String(height) });
    return responseBytes(await getJson(`/abci_query?${params}`, { service: 'rpc' }), height);
  };
  const [bankBytes, versionBytes, mimirBytes] = await Promise.all([
    query('/cosmos.bank.v1beta1.Query/Balance', QueryBalanceRequest.encode({ address: FINANCIAL_RESERVE_ADDRESS, denom: 'rune' }).finish()),
    query('/types.Query/Version'), query('/types.Query/MimirValues')
  ]);
  const balance = QueryBalanceResponse.decode(bankBytes).balance;
  if (balance?.denom !== 'rune') throw new Error('Historical Reserve RUNE balance unavailable');
  const version = readVersion(versionBytes);
  const mimirs = readMimirs(mimirBytes);
  const config = (key, fallback) => mimirs.has(key) && mimirs.get(key) >= 0n ? mimirs.get(key).toString() : fallback;
  const anchor = { height, reserveBalanceE8: integer(balance.amount, 'Reserve balance').toString(), version,
    emissionCurve: config('EMISSIONCURVE', '6'), reserveMaxCapE8: config('RESERVEMAXCAP', '0'), blocksPerYear: BLOCKS_PER_YEAR,
    method: METHOD, source: 'thorchain-rpc:height-verified-bank-version-mimirs' };
  calculateFinancialReserveEmissionE8(anchor.reserveBalanceE8, anchor);
  return anchor;
}
