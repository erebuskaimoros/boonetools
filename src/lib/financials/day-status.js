import { formatLocalDateTime } from '../utils/datetime.js';

function localTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? formatLocalDateTime(timestamp) : '';
}

/** Keep acquisition coverage, saved exclusions, and pending-ID settlement passes
 * distinct. A pass timestamp does not describe every incremental saved count. */
export function financialDayStatus(detail) {
  const pending = detail?.pendingSwaps || 0;
  const unpriced = detail?.unpricedSwaps || 0;
  const settlement = detail?.settlement;
  const warnings = [];
  if (pending || unpriced || detail?.exclusionsIncomplete) {
    warnings.push(`Provisional snapshot · ${unpriced} unpriced and ${pending} swaps last seen pending are excluded.`);
    if (pending) warnings.push('Pending reflects saved Midgard status, not a live on-chain count.');
    if (unpriced) warnings.push('Unpriced swaps are not automatically retried.');
    if (detail?.exclusionsIncomplete) {
      warnings.push('Some excluded transaction IDs were not retained; those exclusions cannot be rechecked automatically.');
    } else if (pending && settlement?.status === 'unavailable') {
      warnings.push('No retained pending IDs are available for automatic rechecks.');
    }
    if (pending && !settlement) warnings.push('No settlement-check status is available for this saved snapshot.');
  }

  const notes = [];
  const checkedAt = localTimestamp(settlement?.checkedAt);
  if (settlement?.status === 'pending') {
    notes.push('Only saved pending IDs are rechecked; the day is not rescanned.');
    if (!checkedAt) notes.push('First complete pending-ID check has not finished.');
  } else if (settlement?.status === 'complete') {
    notes.push('Saved pending-ID checks complete.');
  } else if (settlement?.status === 'unavailable') {
    notes.push('Automatic pending-ID checks unavailable.');
  }
  if (notes.length && checkedAt) notes.push(`Last complete pending-ID check: ${checkedAt}.`);
  const nextCheckAt = localTimestamp(settlement?.nextCheckAt);
  if (settlement?.status === 'pending' && nextCheckAt) notes.push(`Next pending-ID check scheduled for ${nextCheckAt}.`);

  return {
    warning: warnings.join(' '),
    settlement: notes.join(' '),
    pauseLabel: settlement?.status === 'pending' || detail?.progress?.phase === 'settlement'
      ? 'Settlement checks paused' : 'Acquisition paused'
  };
}
