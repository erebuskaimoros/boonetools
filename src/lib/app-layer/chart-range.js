const DAY_MS = 86_400_000;

// Keep full datasets (including cumulative baselines) and bound only the viewport.
export function appLayerChartRange(rows = [], rangeDays = 30, grain = 'daily') {
  if (!rows.length || rangeDays === null) return {};
  const latest = Date.parse(`${rows.at(-1).bucket_start}T00:00:00Z`);
  if (!Number.isFinite(latest)) return {};
  const bucketSpan = grain === 'weekly' ? 7 : 1;
  const cutoff = latest + (bucketSpan - rangeDays) * DAY_MS;
  const first = rows.findIndex((row) => {
    const start = Date.parse(`${row.bucket_start}T00:00:00Z`);
    return start + (bucketSpan - 1) * DAY_MS >= cutoff;
  });
  return { min: Math.max(0, first), max: rows.length - 1 };
}
