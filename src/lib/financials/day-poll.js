/** Polls only our database-backed endpoint. Keep an actively viewed queue
 * lease alive without spinning on a provider/budget deferral. Hidden panels
 * do not call this endpoint; only untracked historical scans pause when their
 * lease expires. Collector-owned daily rosters continue in the background. */
export function financialDayPollDelay(detail, error, now = Date.now()) {
  if (detail?.availability === 'before-tracking') return null;
  if (detail?.swapRankingBasis === 'pool-liquidity-fees-usd' && detail?.refreshing) return 60_000;
  if (detail?.deferred) {
    const retryAt = Date.parse(detail.retryAt || '');
    return Number.isFinite(retryAt) ? Math.max(5000, Math.min(60_000, retryAt - now)) : 60_000;
  }
  if (error || detail?.error) return 30_000;
  if (detail?.loading || detail?.refreshing) return 5000;
  if (detail?.settlement?.status === 'pending') return 60_000;
  if (detail?.partial) return 60_000;
  const ranking = detail?.poolRanking;
  if (ranking) {
    const through = Date.parse(ranking.through || '');
    const windowTo = Date.parse(detail.windowTo || '');
    if (ranking.complete !== true || ranking.stale || !Number.isFinite(through)
      || (Number.isFinite(windowTo) && through < Math.min(windowTo, now))) return 60_000;
  }
  return null;
}
