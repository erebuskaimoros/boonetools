import { applySystemIncomePolHead, reconcileSystemIncomePolSnapshot } from './model.js';

const MAX_RECENT_HEADS = 512;

function mergeHeadObservations(recentHeads, head) {
  const existing = recentHeads.find(candidate => candidate.height === head.height);
  // A reconnect can replay a header-only observation after its complete event.
  // Never replace the complete observation with the less informative copy.
  if (existing?.system_income_e8 != null && head.system_income_e8 == null) return recentHeads;
  return [...recentHeads.filter(candidate => candidate.height !== head.height), head]
    .sort((left, right) => left.height - right.height);
}

export function mergeSystemIncomePolHeads(recentHeads, head) {
  const merged = mergeHeadObservations(recentHeads, head);
  return merged.length > MAX_RECENT_HEADS ? merged.slice(-MAX_RECENT_HEADS) : merged;
}

function throughHeight(snapshot) {
  const height = Number(snapshot?.live?.through_height);
  return Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
}

export function acceptSystemIncomePolSnapshot(current, incoming) {
  // A delayed/lagging response must not rewind past a compacted prefix whose
  // individual observations are no longer buffered. Equal-height snapshots
  // remain authoritative and can repair a previously incomplete prefix.
  return current && throughHeight(incoming) < throughHeight(current) ? current : incoming;
}

export function bufferSystemIncomePolHead(snapshot, recentHeads, head) {
  if (!snapshot) return { snapshot, recentHeads: mergeSystemIncomePolHeads(recentHeads, head) };

  const baselineHeight = throughHeight(snapshot);
  const uncovered = recentHeads.filter(candidate => candidate.height > baselineHeight);
  const merged = head.height <= baselineHeight ? uncovered : mergeHeadObservations(uncovered, head);
  const overflow = Math.max(0, merged.length - MAX_RECENT_HEADS);
  // Fold observations into the immutable replay baseline before evicting
  // them. Merely dropping the prefix would erase already-counted cash flows
  // on the next replay. Gaps/missing income stay pending during compaction.
  let nextSnapshot = snapshot;
  for (const evicted of merged.slice(0, overflow)) {
    nextSnapshot = applySystemIncomePolHead(nextSnapshot, evicted);
  }
  return { snapshot: nextSnapshot, recentHeads: overflow ? merged.slice(overflow) : merged };
}

export function replaySystemIncomePolHeads(snapshot, recentHeads, previous = null) {
  let next = snapshot;
  // Always replay from the snapshot plus its compacted prefix, not the
  // already-mutated display. Buffered corrections fill gaps exactly once.
  for (const head of recentHeads) next = applySystemIncomePolHead(next, head);
  return reconcileSystemIncomePolSnapshot(next, previous);
}
