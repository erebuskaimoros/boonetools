function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function hasBondHistoryValue(row) {
  return toNumber(row?.rune_stack) > 0 || toNumber(row?.user_bond) > 0;
}

export function isPoisonedBondHistoryRow(row) {
  return !hasBondHistoryValue(row);
}

export function calculateBondHistoryRow({
  bondAddress,
  nodePayloads,
  networkData,
  churnHeight,
  churnTimestamp,
  ratesJson = null
}) {
  let totalUserBond = 0;
  let totalUserBondOnly = 0;

  for (const nodeData of nodePayloads || []) {
    if (!nodeData) {
      continue;
    }

    const providers = nodeData?.bond_providers?.providers || [];
    const operatorFee = toNumber(nodeData?.bond_providers?.node_operator_fee) / 10000;
    const nodeCurrentAward = toNumber(nodeData?.current_award) * (1 - operatorFee);

    let userBond = 0;
    let nodeTotalBond = 0;
    for (const provider of providers) {
      const providerBond = toNumber(provider?.bond);
      if (provider?.bond_address === bondAddress) {
        userBond = providerBond;
      }
      nodeTotalBond += providerBond;
    }

    if (userBond > 0 && nodeTotalBond > 0) {
      totalUserBondOnly += userBond;
      totalUserBond += userBond + (userBond / nodeTotalBond) * nodeCurrentAward;
    }
  }

  return {
    churn_height: churnHeight,
    churn_timestamp: churnTimestamp,
    rune_stack: Math.round(totalUserBond),
    user_bond: Math.round(totalUserBondOnly),
    rune_price: toNumber(networkData?.rune_price_in_tor) / 1e8,
    rates_json: ratesJson
  };
}

export function isTransientHistoricalFetchError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes('(429)') ||
    message.includes('challenge response') ||
    message.includes('fetch failed') ||
    message.includes('timed out') ||
    message.includes('aborted') ||
    message.includes('econn') ||
    message.includes('socket hang up')
  );
}
