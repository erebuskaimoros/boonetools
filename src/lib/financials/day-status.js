import { formatLocalDateTime } from '../utils/datetime.js';

function localTimestamp(value, timeZone) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? formatLocalDateTime(timestamp, { timeZone }) : '';
}

/** Keep acquisition coverage, saved exclusions, and pending-ID settlement passes
 * distinct. A pass timestamp does not describe every incremental saved count. */
export function financialDayStatus(detail, { timeZone = undefined } = {}) {
  const pending = detail?.pendingSwaps || 0;
  const unpriced = detail?.unpricedSwaps || 0;
  const settlement = detail?.settlement;
  const ledger = detail?.swapSource === 'finalized-block-ledger';
  const feeRanking = ['liquidity-fees-usd', 'pool-liquidity-fees-usd'].includes(detail?.swapRankingBasis);
  const warnings = [];
  if (pending || unpriced || detail?.exclusionsIncomplete) {
    warnings.push(`Provisional snapshot · ${unpriced} unpriced and ${pending} swaps ${ledger ? 'awaiting completion or verification' : 'last seen pending'} are excluded.`);
    if (pending) warnings.push(ledger ? 'These counts reflect saved observations, not a live on-chain count.'
      : 'Pending reflects saved Midgard status, not a live on-chain count.');
    if (unpriced) warnings.push(feeRanking ? 'Swaps with missing fee or price data are excluded, never treated as zero.'
      : 'Unpriced swaps are not automatically retried.');
    if (detail?.exclusionsIncomplete) {
      warnings.push('Some excluded transaction IDs were not retained; those exclusions cannot be rechecked automatically.');
    } else if (pending && settlement?.status === 'unavailable') {
      warnings.push('No retained pending IDs are available for automatic rechecks.');
    }
    if (pending && !settlement) warnings.push('No settlement-check status is available for this saved snapshot.');
  }

  const notes = [];
  const checkedAt = localTimestamp(settlement?.checkedAt, timeZone);
  const deferred = settlement?.status === 'pending' && settlement?.deferred === true;
  if (settlement?.status === 'pending') {
    if (deferred) {
      notes.push(settlement.deferredReason === 'request-budget'
        ? 'Verification checks paused by the shared request budget.'
        : settlement.deferredReason === 'provider-cooldown'
          ? 'Verification checks paused while the data provider is cooling down.'
          : 'Verification checks are paused.');
    }
    notes.push(ledger ? 'Saved swap candidates are checked after completion; the day is not rescanned.'
      : 'Only saved pending IDs are rechecked; the day is not rescanned.');
    if (!checkedAt) notes.push(ledger ? 'No completed candidate checks yet.' : 'First complete pending-ID check has not finished.');
  } else if (settlement?.status === 'complete') {
    notes.push(ledger ? 'Saved swap candidate checks complete.' : 'Saved pending-ID checks complete.');
  } else if (settlement?.status === 'unavailable') {
    notes.push('Automatic pending-ID checks unavailable.');
  }
  if (notes.length && checkedAt) notes.push(`${ledger ? 'Latest candidate check' : 'Last complete pending-ID check'}: ${checkedAt}.`);
  const nextCheckAt = localTimestamp(settlement?.nextCheckAt, timeZone);
  if (settlement?.status === 'pending' && nextCheckAt) {
    notes.push(deferred ? `Earliest retry: ${nextCheckAt}.`
      : `Next ${ledger ? 'candidate' : 'pending-ID'} check scheduled for ${nextCheckAt}.`);
  }

  const swapThrough = localTimestamp(detail?.through, timeZone);
  const ranking = detail?.poolRanking;
  const poolThrough = localTimestamp(ranking?.through, timeZone);
  const poolWarnings = [];
  if (ranking?.fallback) poolWarnings.push('Showing a saved ranking; newer pool totals are unavailable.');
  if (ranking?.stale) poolWarnings.push('Pool data is delayed.');
  if (ranking && ranking.complete !== true) {
    const missing = Array.isArray(ranking.missingPools) ? ranking.missingPools.length : 0;
    poolWarnings.push(missing
      ? `Incomplete coverage · ${missing} ${missing === 1 ? 'pool is' : 'pools are'} unavailable. The ranking may omit larger pools.`
      : 'Pool coverage is incomplete. The ranking may omit larger pools.');
  }

  return {
    ...(swapThrough ? { swapThrough: `Through ${swapThrough}` } : {}),
    ...(ranking ? {
      poolThrough: poolThrough ? `Through ${poolThrough}` : 'Pool coverage unavailable',
      poolWarning: poolWarnings.join(' '),
      poolEmpty: ranking.complete === true && poolThrough ? 'No pool volume in this window.' : 'Pool ranking unavailable for this window.'
    } : {}),
    warning: warnings.join(' '),
    settlement: notes.join(' '),
    pauseLabel: settlement?.status === 'pending' || detail?.progress?.phase === 'settlement'
      ? 'Settlement checks paused' : ranking ? 'Swap acquisition paused' : 'Acquisition paused'
  };
}
