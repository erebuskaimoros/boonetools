function tryDecode(value) {
  const raw = String(value ?? '');
  if (!raw) return '';
  try {
    if (/^[A-Za-z0-9+/]+=*$/.test(raw) && raw.length > 1) {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      if (/^[\x20-\x7E]*$/.test(decoded) && decoded.length > 0) return decoded;
    }
  } catch {
    // CometBFT websocket payloads can already contain decoded attributes.
  }
  return raw;
}

function integerString(value) {
  const normalized = String(value ?? '').trim();
  return /^\d+$/.test(normalized) ? BigInt(normalized).toString() : null;
}

function decodedEvent(event = {}) {
  const attributes = {};
  for (const attribute of Array.isArray(event.attributes) ? event.attributes : []) {
    const key = tryDecode(attribute?.key).toLowerCase();
    if (key) attributes[key] = tryDecode(attribute?.value);
  }
  return { type: tryDecode(event.type).toLowerCase(), attributes };
}

function eventFingerprint(event) {
  return JSON.stringify([
    event.type,
    Object.entries(event.attributes || {}).sort(([left], [right]) => left.localeCompare(right))
  ]);
}

function feeCounts(events = []) {
  const counts = new Map();
  for (const current of (Array.isArray(events) ? events : []).map(decodedEvent)) {
    if (current.type !== 'swap') continue;
    const asset = current.attributes.pool || '';
    const feeE8 = integerString(current.attributes.liquidity_fee_in_rune);
    if (!asset || feeE8 === null) continue;
    const fingerprint = eventFingerprint(current);
    const entry = counts.get(fingerprint) || { asset, feeE8, count: 0 };
    entry.count += 1;
    counts.set(fingerprint, entry);
  }
  return counts;
}

const SYSTEM_INCOME_REWARD_KEYS = new Set([
  'bond_reward',
  'dev_fund_reward',
  'income_burn',
  'tcy_stake_reward',
  'marketing_fund_reward',
  'pol_reserve_reward'
]);

function systemIncomeFromRewards(attributes = {}) {
  let observed = false;
  let total = 0n;
  for (const [key, value] of Object.entries(attributes)) {
    if (!SYSTEM_INCOME_REWARD_KEYS.has(key) && !key.includes('.')) continue;
    const amount = integerString(value);
    if (amount === null) continue;
    observed = true;
    total += BigInt(amount);
  }
  return observed ? total : null;
}

export function collectSystemIncomePolEvents(data = {}) {
  const finalize = data?.result_finalize_block || data?.result_end_block || data?.result || data;
  const finalizeEvents = Array.isArray(finalize?.events)
    ? finalize.events
    : Array.isArray(finalize?.finalize_block_events)
      ? finalize.finalize_block_events
      : [];
  const txResults = Array.isArray(finalize?.tx_results)
    ? finalize.tx_results
    : Array.isArray(finalize?.txs_results)
      ? finalize.txs_results
      : [];
  const txEvents = txResults.flatMap((result) => Array.isArray(result?.events) ? result.events : []);
  return { finalizeEvents, txEvents };
}

export function parseSystemIncomePolEvents(events = [], options = {}) {
  const decoded = (Array.isArray(events) ? events : []).map(decodedEvent);
  let reward = null;
  let systemIncome = null;
  const adds = [];
  const deployments = [];

  for (let index = 0; index < decoded.length; index += 1) {
    const current = decoded[index];
    if (current.type === 'rewards') {
      const amount = integerString(current.attributes.pol_reserve_reward);
      if (amount !== null) reward = (BigInt(reward || '0') + BigInt(amount)).toString();
      const eventSystemIncome = systemIncomeFromRewards(current.attributes);
      if (eventSystemIncome !== null) {
        systemIncome = (BigInt(systemIncome || '0') + eventSystemIncome).toString();
      }
    } else if (current.type === 'add_liquidity') {
      const runeE8 = integerString(current.attributes.rune_amount);
      const assetE8 = integerString(current.attributes.asset_amount);
      const unitsE8 = integerString(current.attributes.liquidity_provider_units);
      const hasExternalTx = Object.entries(current.attributes).some(([key, value]) => (
        key.endsWith('_txid') && !/^0+$/.test(String(value || ''))
      ));
      if (current.attributes.pool && runeE8 !== null && assetE8 === '0' && !hasExternalTx) {
        adds.push({
          index,
          asset: current.attributes.pool,
          runeE8,
          unitsE8,
          runeAddress: current.attributes.rune_address || '',
          matched: false
        });
      }
    } else if (current.type === 'pol_reserve_deploy') {
      const runeE8 = integerString(current.attributes.rune_amount);
      if (current.attributes.pool && runeE8 !== null) {
        const match = [...adds].reverse().find((candidate) => (
          !candidate.matched
          && candidate.index < index
          && candidate.asset === current.attributes.pool
          && candidate.runeE8 === runeE8
        ));
        if (match) match.matched = true;
        deployments.push({
          asset: current.attributes.pool,
          runeE8,
          unitsE8: match?.unitsE8 ?? null,
          runeAddress: match?.runeAddress || ''
        });
      }
    }
  }

  const feeGroups = Array.isArray(options.feeEventGroups)
    ? options.feeEventGroups
    : [Array.isArray(options.feeEvents) ? options.feeEvents : events];
  // Finalize-block and transaction-result lanes can expose the same ABCI event.
  // Taking the maximum multiplicity across lanes removes those copies while
  // retaining genuinely repeated, otherwise-identical swaps within one lane.
  const countsByFingerprint = new Map();
  for (const group of feeGroups) {
    for (const [fingerprint, entry] of feeCounts(group)) {
      const previous = countsByFingerprint.get(fingerprint);
      if (!previous || entry.count > previous.count) countsByFingerprint.set(fingerprint, entry);
    }
  }
  const feesByPool = new Map();
  for (const entry of countsByFingerprint.values()) {
    feesByPool.set(
      entry.asset,
      (feesByPool.get(entry.asset) || 0n) + (BigInt(entry.feeE8) * BigInt(entry.count))
    );
  }

  return {
    observed: true,
    rewardE8: reward,
    systemIncomeE8: systemIncome,
    deployments,
    poolFees: [...feesByPool.entries()].map(([asset, feeE8]) => ({
      asset,
      feeE8: feeE8.toString()
    }))
  };
}

export function parseSystemIncomePolBlock(data = {}) {
  const collected = collectSystemIncomePolEvents(data);
  return parseSystemIncomePolEvents(collected.finalizeEvents, {
    feeEventGroups: [collected.finalizeEvents, collected.txEvents]
  });
}

export function parseSystemIncomePolRpcBlock(payload = {}) {
  return parseSystemIncomePolBlock(payload);
}
