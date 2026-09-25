const LIVE_STATUS_TTL_MS = 45_000;

function networkObservation(snapshot) {
  if (snapshot?.network_observation) return snapshot.network_observation;
  const source = snapshot?.sources?.network;
  return {
    // A dashboard can be republished for unrelated votes/transactions without
    // having observed the network again. Live payloads have their own proof
    // timestamp; their source.as_of only dates the underlying REST state.
    as_of: source ? source.as_of : snapshot?.as_of,
    stale: Boolean(source?.stale ?? snapshot?.stale)
  };
}

export function mergeLiveStatus(snapshot, live) {
  if (!snapshot && !live) return null;
  const dashboardObservation = networkObservation(snapshot);
  const liveObservation = networkObservation(live);
  const dashboardTime = Date.parse(dashboardObservation.as_of || '');
  const liveTime = Date.parse(liveObservation.as_of || '');
  if (!live || (snapshot && Number.isFinite(dashboardTime)
    && (!Number.isFinite(liveTime) || liveTime < dashboardTime))) {
    return { ...snapshot, network_observation: dashboardObservation };
  }
  return {
    ...(snapshot || { schema_version: 1, as_of: live.as_of }),
    network: live.network,
    chains: live.chains,
    churn: live.churn,
    sources: { ...snapshot?.sources, network: live.source },
    // Frontend-only metadata follows the exact network/chains/churn selected
    // above, independently of the aggregate dashboard publication and health.
    network_observation: liveObservation,
    partial: Boolean(!snapshot || snapshot.partial || live.partial),
    stale: Boolean(snapshot?.stale || live.stale),
    warnings: [...new Set([...(snapshot?.warnings || []), ...(live.warnings || [])])]
  };
}

export function statusPresentation(snapshot, nowMs = Date.now()) {
  const observation = networkObservation(snapshot);
  const generatedAt = Date.parse(observation.as_of || '');
  const expired = !Number.isFinite(generatedAt)
    || generatedAt > nowMs + 5_000
    || nowMs - generatedAt > LIVE_STATUS_TTL_MS
    || observation.stale;
  const consensusState = expired ? 'unknown' : snapshot?.network?.consensus?.state || 'unknown';
  const sourceLabel = consensusState === 'unknown' ? 'DATA DELAYED'
    : consensusState === 'stalled' ? 'NO NEW BLOCKS'
      : consensusState === 'delayed' ? 'BLOCKS DELAYED'
        : snapshot?.partial ? 'PARTIAL DATA' : 'LIVE';
  return { consensusState, sourceLabel };
}

export function summarizeStatusWarnings(...inputs) {
  const messages = inputs.flat(Infinity).filter(Boolean).map(String);
  const notices = new Set();
  for (const message of messages) {
    if (/bifrost|vanaheimex|scanner/i.test(message)) notices.add('Scanner statistics are delayed.');
    if (/liquify|midgard|thornode|churns|network state/i.test(message)) notices.add('Some network data is delayed.');
    if (/consensus|chain head|block production|RPC|header/i.test(message)) notices.add('Block production could not be verified.');
    if (!/bifrost|vanaheimex|scanner|liquify|midgard|thornode|churns|network state|consensus|chain head|block production|RPC|header/i.test(message)) {
      notices.add('Some status data is temporarily unavailable.');
    }
  }
  return [...notices].join(' ');
}
