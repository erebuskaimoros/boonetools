import {
  buildAffiliateTransactionRows,
  buildAffiliateLegVolumeSeries,
  EXECUTED_LEG_VOLUME_BASIS,
  midgardActionTimestampSeconds
} from '../../../shared/dynamic-fees/affiliate-volume.js';
import { fetchMidgardActions } from './midgard.js';

const PAGE_LIMIT = 50;
const MAX_PAGES = 500;

export async function fetchDynamicFeeAffiliateActions({
  affiliate,
  fromTimestamp,
  toTimestamp,
  fetchActions = fetchMidgardActions
}) {
  const actions = [];
  const normalizedAffiliate = String(affiliate || '').trim().toLowerCase();
  const seenPageTokens = new Set();
  const seenActions = new Set();
  let prevPageToken = '';

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await fetchActions({
      type: 'swap',
      affiliate: normalizedAffiliate,
      limit: String(PAGE_LIMIT),
      ...(prevPageToken
        ? { prevPageToken }
        : {
            fromTimestamp: String(fromTimestamp),
            timestamp: String(toTimestamp)
          })
    });
    const pageActions = Array.isArray(payload?.actions) ? payload.actions : [];
    let reachedUpperBound = false;
    for (const action of pageActions) {
      const timestamp = midgardActionTimestampSeconds(action?.date);
      if (timestamp >= toTimestamp) {
        reachedUpperBound = true;
        continue;
      }
      if (timestamp < fromTimestamp) continue;
      const identity = [
        action?.in?.[0]?.txID || '',
        action?.date || '',
        action?.height || ''
      ].join(':');
      if (seenActions.has(identity)) continue;
      seenActions.add(identity);
      actions.push(action);
    }
    if (reachedUpperBound || pageActions.length === 0) return actions;

    prevPageToken = String(payload?.meta?.prevPageToken || '');
    if (!prevPageToken) return actions;
    if (seenPageTokens.has(prevPageToken)) {
      throw new Error('Midgard repeated an affiliate-volume page token');
    }
    seenPageTokens.add(prevPageToken);
  }

  throw new Error(`Affiliate volume exceeded ${MAX_PAGES * PAGE_LIMIT} actions`);
}

export async function getDynamicFeeAffiliateVolume({
  affiliate,
  fromTimestamp,
  toTimestamp,
  includeTransactions = false,
  fetchActions
}) {
  const actions = await fetchDynamicFeeAffiliateActions({
    affiliate,
    fromTimestamp,
    toTimestamp,
    fetchActions
  });
  const points = buildAffiliateLegVolumeSeries(actions, {
    fromTimestamp,
    toTimestamp
  });

  return {
    affiliate,
    fromTimestamp,
    toTimestamp,
    volumeBasis: EXECUTED_LEG_VOLUME_BASIS,
    points,
    routeCount: points.reduce((sum, row) => sum + row.routeCount, 0),
    executedLegCount: points.reduce((sum, row) => sum + row.executedLegCount, 0),
    legVolumeUsd: points.reduce((sum, row) => sum + row.legVolumeUsd, 0),
    routeVolumeUsd: points.reduce((sum, row) => sum + row.routeVolumeUsd, 0),
    ...(includeTransactions
      ? {
          transactions: buildAffiliateTransactionRows(actions, {
            fromTimestamp,
            toTimestamp
          })
        }
      : {}),
    source: 'midgard-actions'
  };
}
