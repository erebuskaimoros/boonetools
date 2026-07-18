import { getRapidSwapComparableVolumeUsd } from './volume.js';

const AFFILIATE_NAMES = {
  t: 'THORSwap',
  '-t': 'THORSwap',
  t1: 'Trust Wallet',
  '-_': 'SwapKit',
  ll: 'Live Ledger',
  ej: 'Edge Wallet',
  wr: 'THORWallet',
  dx: 'ASGARDEX',
  bgw: 'BitGet Wallet',
  v0: 'Vultisig',
  rj: 'Rujira',
  ss: 'Shapeshift',
  g1: 'GemWallet',
  ns: 'Native Swap',
  ahi: 'Ctrl',
  xdf: 'Ctrl',
  hvl: 'SafePal',
  zengo: 'Zengo',
  ro: 'Rango Exchange',
  tps: 'Token Pocket',
  leo: 'LEO Dex',
  is: 'InstaSwap',
  cbx: 'Coolwallet',
  c1: 'Clypto',
  sto: 'THORChain',
  moca: 'Moca'
};

const AFFILIATE_URLS = {
  t: 'https://app.thorswap.finance/swap',
  '-t': 'https://app.thorswap.finance/swap',
  '-_': 'https://app.swapkit.network/swap',
  sto: 'https://swap.thorchain.org',
  dx: 'https://www.asgardex.com/',
  ss: 'https://app.shapeshift.com/',
  rj: 'https://rujira.network/swap/',
  ro: 'https://rango.exchange/',
  leo: 'https://thorchain.leodex.io/',
  is: 'https://instaswap.com/',
  v0: 'https://launch.vultisig.com/',
  wr: 'https://www.thorwallet.org/',
  ll: 'https://liveledger.io/',
  ns: 'https://nativeswap.io/',
  c1: 'https://clypto.com/'
};

export function shortenAsset(asset) {
  if (!asset) return '-';
  const match = asset.match(/^(.+?)[-](?:0[Xx][A-Fa-f0-9]{8,}|[A-Za-z0-9]{20,})$/);
  return match ? match[1] : asset;
}

export function formatAsset(asset) {
  return asset ? shortenAsset(asset) : '-';
}

export function formatPair(row) {
  return `${formatAsset(row?.source_asset)} → ${formatAsset(row?.target_asset)}`;
}

export function shortPair(row) {
  return formatPair(row);
}

export function formatTimeSaved(seconds) {
  const value = Number(seconds) || 0;
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${value % 60}s`;
  if (value >= 86400) {
    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function swapPctFaster(row) {
  const subs = Number(row?.streaming_count) || 0;
  const blocks = Number(row?.blocks_used) || 0;
  if (subs <= 0 || blocks <= 0) return 0;
  return Math.round((1 - blocks / subs) * 100);
}

export function swapTimeSaved(row) {
  const subs = Number(row?.streaming_count) || 0;
  const blocks = Number(row?.blocks_used) || 0;
  return Math.max(0, subs - blocks) * 6;
}

export function getTxUrl(txId) {
  return `https://thorchain.net/tx/${txId}`;
}

export function swapVolumeUsd(row) {
  return getRapidSwapComparableVolumeUsd(row);
}

export function filterSwaps(swaps, pathFilter, minUsd, minSubs) {
  let result = swaps;
  if (pathFilter) {
    const lower = pathFilter.toLowerCase();
    result = result.filter((row) => shortPair(row).toLowerCase().includes(lower));
  }
  if (minUsd && Number(minUsd) > 0) {
    const minimum = Number(minUsd);
    result = result.filter((row) => swapVolumeUsd(row) >= minimum);
  }
  if (minSubs && Number(minSubs) > 0) {
    const minimum = Number(minSubs);
    result = result.filter((row) => (Number(row.streaming_count) || 0) >= minimum);
  }
  return result;
}

export function sortSwaps(swaps, column, ascending) {
  const sorted = [...swaps];
  const direction = ascending ? 1 : -1;
  sorted.sort((left, right) => {
    let leftValue;
    let rightValue;
    switch (column) {
      case 'date':
        leftValue = new Date(left.action_date).getTime() || 0;
        rightValue = new Date(right.action_date).getTime() || 0;
        break;
      case 'pair':
        return direction * shortPair(left).localeCompare(shortPair(right));
      case 'usd':
        leftValue = swapVolumeUsd(left);
        rightValue = swapVolumeUsd(right);
        break;
      case 'subs':
        leftValue = Number(left.streaming_count) || 0;
        rightValue = Number(right.streaming_count) || 0;
        break;
      case 'blocks':
        leftValue = Number(left.blocks_used) || 0;
        rightValue = Number(right.blocks_used) || 0;
        break;
      case 'timeSaved':
        leftValue = swapTimeSaved(left);
        rightValue = swapTimeSaved(right);
        break;
      case 'pctFaster':
        leftValue = swapPctFaster(left);
        rightValue = swapPctFaster(right);
        break;
      default:
        return 0;
    }
    return direction * (leftValue - rightValue);
  });
  return sorted;
}

export function affiliateDisplayName(code) {
  return AFFILIATE_NAMES[code] || code;
}

export function affiliateUrl(code) {
  return AFFILIATE_URLS[code] || `https://thorchain.net/charts/affiliates?affiliate=${encodeURIComponent(code)}`;
}

export function computeDistributions(swaps) {
  const subBuckets = [
    { label: '2-10', min: 2, max: 10 },
    { label: '11-20', min: 11, max: 20 },
    { label: '21-30', min: 21, max: 30 },
    { label: '31-40', min: 31, max: 40 },
    { label: '41-50', min: 41, max: 50 },
    { label: '51+', min: 51, max: Infinity }
  ];
  const timeBuckets = [
    { label: '1-30s', min: 1, max: 30 },
    { label: '31-60s', min: 31, max: 60 },
    { label: '61-120s', min: 61, max: 120 },
    { label: '121-300s', min: 121, max: 300 },
    { label: '301s+', min: 301, max: Infinity }
  ];

  const subsByVolume = subBuckets.map(() => 0);
  const subsByCount = subBuckets.map(() => 0);
  const timeSavedDist = timeBuckets.map(() => 0);
  const affiliateCount = {};
  const affiliateVolume = {};

  for (const row of swaps) {
    const subs = Number(row.streaming_count) || 0;
    const usd = swapVolumeUsd(row);
    const saved = swapTimeSaved(row);

    const subIndex = subBuckets.findIndex((bucket) => subs >= bucket.min && subs <= bucket.max);
    if (subIndex >= 0) {
      subsByVolume[subIndex] += usd;
      subsByCount[subIndex] += 1;
    }

    if (saved > 0) {
      const timeIndex = timeBuckets.findIndex((bucket) => saved >= bucket.min && saved <= bucket.max);
      if (timeIndex >= 0) timeSavedDist[timeIndex] += 1;
    }

    const affiliate = row.affiliate || '';
    if (affiliate) {
      affiliateCount[affiliate] = (affiliateCount[affiliate] || 0) + 1;
      affiliateVolume[affiliate] = (affiliateVolume[affiliate] || 0) + usd;
    }
  }

  const affiliatesByCount = Object.entries(affiliateCount).sort((left, right) => right[1] - left[1]);
  const affiliatesByVolume = Object.entries(affiliateVolume).sort((left, right) => right[1] - left[1]);

  return {
    subLabels: subBuckets.map((bucket) => bucket.label),
    subsByVolume,
    subsByCount,
    timeLabels: timeBuckets.map((bucket) => bucket.label),
    timeSavedDist,
    affCountCodes: affiliatesByCount.map(([code]) => code),
    affCountLabels: affiliatesByCount.map(([code]) => affiliateDisplayName(code)),
    affCountValues: affiliatesByCount.map(([, value]) => value),
    affVolumeCodes: affiliatesByVolume.map(([code]) => code),
    affVolumeLabels: affiliatesByVolume.map(([code]) => affiliateDisplayName(code)),
    affVolumeValues: affiliatesByVolume.map(([, value]) => value)
  };
}

export function computeSwapPathData(swaps) {
  const pathMap = {};
  const flowMap = {};
  for (const row of swaps) {
    const pair = shortPair(row);
    const usd = swapVolumeUsd(row);
    if (!pathMap[pair]) pathMap[pair] = { volume: 0, count: 0, totalTimeSaved: 0 };
    pathMap[pair].volume += usd;
    pathMap[pair].count += 1;
    pathMap[pair].totalTimeSaved += swapTimeSaved(row);

    const source = formatAsset(row?.source_asset).split('.').pop() || '?';
    const target = formatAsset(row?.target_asset).split('.').pop() || '?';
    const flowKey = `${source}→${target}`;
    flowMap[flowKey] = (flowMap[flowKey] || 0) + usd;
  }

  const byVolume = Object.entries(pathMap)
    .sort((left, right) => right[1].volume - left[1].volume)
    .slice(0, 10);
  const byTimeSaved = Object.entries(pathMap)
    .filter(([, value]) => value.totalTimeSaved > 0)
    .sort(
      (left, right) =>
        right[1].totalTimeSaved / right[1].count - left[1].totalTimeSaved / left[1].count
    )
    .slice(0, 10);

  const sortedFlows = Object.entries(flowMap).sort((left, right) => right[1] - left[1]);
  const sankeyFlows = sortedFlows.slice(0, 10).map(([key, volume]) => {
    const [from, to] = key.split('→');
    return { from, to, flow: Math.round(volume) };
  });
  const otherVolume = sortedFlows.slice(10).reduce((sum, [, volume]) => sum + volume, 0);
  if (otherVolume > 0) sankeyFlows.push({ from: 'Others', to: 'Others ', flow: Math.round(otherVolume) });

  return {
    volumeLabels: byVolume.map(([pair]) => pair),
    volumeValues: byVolume.map(([, value]) => value.volume),
    timeSavedLabels: byTimeSaved.map(([pair]) => pair),
    timeSavedValues: byTimeSaved.map(([, value]) => Math.round(value.totalTimeSaved / value.count)),
    sankeyFlows
  };
}
