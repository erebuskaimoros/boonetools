import { loadAcquisition, saveAcquisition } from './acquisition-cache.js';

const NAMESPACE = 'thorchain-mainnet:vote-scan:v1';

export async function loadVoteScan(client, lane) {
  const payload = (await loadAcquisition(client, NAMESPACE, lane, { allowStale: true }))?.payload;
  return payload?.complete === true && Number.isSafeInteger(Number(payload.endHeight)) && Number(payload.endHeight) > 0 ? payload : null;
}

export function mergeVoteScanCoverage(previous, range) {
  if (range.complete === false) throw new Error('Cannot advance an incomplete vote scan');
  const current = {
    startHeight: Number(range.coverageStartHeight || range.startHeight),
    endHeight: Number(range.endHeight),
    startTime: new Date(range.coverageStartTime || range.startTime).toISOString(),
    endTime: new Date(range.endTime).toISOString()
  };
  if (!Number.isSafeInteger(current.startHeight) || current.startHeight <= 0
    || !Number.isSafeInteger(current.endHeight) || current.endHeight < current.startHeight) {
    throw new Error('Invalid verified vote scan');
  }
  const oldIntervals = previous?.coverageIntervals || (previous ? [{
    startHeight: Number(previous.coverageStartHeight || previous.startHeight), endHeight: Number(previous.endHeight),
    startTime: previous.coverageStartTime || previous.startTime, endTime: previous.endTime
  }] : []);
  const intervals = [...oldIntervals, current].sort((a, b) => a.startHeight - b.startHeight);
  const merged = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval.startHeight <= last.endHeight + 1) {
      if (interval.endHeight > last.endHeight) {
        last.endHeight = interval.endHeight; last.endTime = interval.endTime;
      }
      if (Date.parse(interval.startTime) < Date.parse(last.startTime)) last.startTime = interval.startTime;
    } else merged.push({ ...interval, startTime: new Date(interval.startTime).toISOString(), endTime: new Date(interval.endTime).toISOString() });
  }
  const requestedStartTime = new Date(Math.min(...[
    previous?.requestedStartTime, range.requestedStartTime || range.startTime
  ].map((time) => Date.parse(time || '')).filter(Number.isFinite))).toISOString();
  const gaps = [];
  if (Date.parse(requestedStartTime) < Date.parse(merged[0].startTime)) gaps.push({
    startTime: requestedStartTime, endTime: merged[0].startTime, endHeight: merged[0].startHeight - 1,
    reason: 'provider-retention'
  });
  for (let index = 1; index < merged.length; index++) gaps.push({
    startTime: merged[index - 1].endTime, endTime: merged[index].startTime,
    startHeight: merged[index - 1].endHeight + 1, endHeight: merged[index].startHeight - 1,
    reason: 'provider-retention'
  });
  return { ...range, complete: true, requestedStartTime,
    startHeight: current.startHeight, startTime: current.startTime,
    endHeight: merged.at(-1).endHeight, endTime: merged.at(-1).endTime,
    coverageStartHeight: merged[0].startHeight, coverageStartTime: merged[0].startTime,
    coverageIntervals: merged, historyGaps: gaps, historyComplete: gaps.length === 0 };
}

export async function saveVoteScan(client, lane, range) {
  const merged = mergeVoteScanCoverage(await loadVoteScan(client, lane), range);
  await saveAcquisition(client, { namespace: NAMESPACE, identity: lane,
    source: range.source || lane, payload: merged });
  return merged;
}

const QUERY_NAMESPACE = 'node-votes:dune-query-progress:v1';
export async function loadVoteQueryProgress(client) {
  return (await loadAcquisition(client, QUERY_NAMESPACE, 'mimir', { allowStale: true }))?.payload || null;
}
export async function saveVoteQueryProgress(client, progress) {
  const previous = await loadVoteQueryProgress(client);
  if (previous && Date.parse(previous.queriedThrough) > Date.parse(progress.queriedThrough)) return previous;
  const payload = { ...progress, coverageVerified: false, kind: 'successful-query' };
  await saveAcquisition(client, { namespace: QUERY_NAMESPACE, identity: 'mimir', source: 'dune', payload });
  return payload;
}

// The cursor describes the entire successfully scanned range, including empty
// ranges. Matches, display retention, and the other acquisition lanes cannot
// advance it. Replay a short overlap for archive indexing delay.
export function voteScanWindow({ previous, fullStartTime, endTime, startTime, overlapMs = 3_600_000, overlapBlocks = 600 }) {
  const previousTime = Date.parse(previous?.endTime);
  const explicit = Boolean(startTime);
  const start = explicit ? Date.parse(startTime) : Number.isFinite(previousTime)
    ? Math.max(Date.parse(fullStartTime), previousTime - overlapMs) : Date.parse(fullStartTime);
  return { startTime: new Date(start).toISOString(), endTime,
    startHeight: !explicit && Number(previous?.endHeight) > 0
      ? Math.max(Number(previous.coverageStartHeight) || 1, Number(previous.endHeight) - overlapBlocks) : 0,
    mode: explicit ? 'explicit' : previous ? 'incremental' : 'full' };
}
